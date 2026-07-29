import type {
  OrganizationMemberRole,
  OrganizationMemberStatus,
  OrganizationStatus,
  OrganizationType,
  OrganizationVerificationStatus,
} from '@/domain/organizations/types';
import type { SqlExecutor } from '@/infrastructure/identity/unit-of-work';

/**
 * Accès aux tables `organizations` et `organization_members`.
 *
 * Toutes les requêtes sont ici, aucune ailleurs, et la raison n'est pas l'esthétique en
 * couches : trois de ces énoncés portent une garantie qui tient à leur rédaction exacte.
 *
 * - `updateOrganizationIdentity` porte le verrouillage optimiste dans son `WHERE` et
 *   l'incrément dans son `SET`. Recopié ailleurs et « simplifié », il perdrait la
 *   détection de l'écriture concurrente sans qu'aucun test unitaire ne s'en aperçoive ;
 * - `insertOrganization` ne fait AUCUNE lecture préalable du numéro d'immatriculation.
 *   L'unicité est tranchée par l'index, jamais par un contrôle applicatif : deux
 *   transactions simultanées liraient toutes deux « libre » avant que l'une n'écrive ;
 * - le prédicat d'adhésion effective est écrit UNE FOIS, dans la constante ci-dessous, et
 *   toutes les lectures s'y réfèrent. Trois conditions recopiées à la main dans quatre
 *   requêtes finiraient par différer d'une, et la différence serait un accès resté ouvert.
 */

/**
 * CE QUI REND UN RÔLE EFFECTIF (0016_organization-members.sql, supabase/README.md).
 *
 * Trois conditions, toutes nécessaires, relues à chaque requête :
 *   - `status = 'ACTIVE'`, ÉNUMÉRÉ et non « différent de SUSPENDED ». Une valeur ajoutée
 *     plus tard au type énuméré serait alors refusée par défaut, ce qui est le sens sûr ;
 *   - `valid_from <= now()` : une adhésion datée du futur n'ouvre rien. Sans cette borne,
 *     préparer une adhésion à l'avance l'activerait aussitôt ;
 *   - `valid_until > now()`, comparaison STRICTE : à la seconde exacte de l'échéance,
 *     l'adhésion est déjà close. Même choix que `sessions_revoked_at` — dans le doute, on
 *     coupe.
 *
 * `now()` est l'instant de DÉBUT DE TRANSACTION, pas l'horloge murale. Deux lectures faites
 * dans la même transaction décident donc sur le même instant : une adhésion ne peut pas
 * être valide au moment de la garde et expirée au moment de l'écriture.
 *
 * L'expiration est portée par les DONNÉES, pas par une tâche de fond : une adhésion cesse
 * d'ouvrir l'accès à l'instant dit, même si aucun traitement ne tourne.
 */
const EFFECTIVE_MEMBERSHIP_PREDICATE = `
  m.status = 'ACTIVE'
  AND m.valid_from <= now()
  AND (m.valid_until IS NULL OR m.valid_until > now())
`;

const ORGANIZATION_COLUMNS = `
  id, name, type, registration_number, territory_code,
  verification_status, status, version, created_at, updated_at
`;

const MEMBER_COLUMNS = `
  m.organization_id, m.user_id, m.role, m.status,
  m.valid_from, m.valid_until, m.created_at, m.updated_at
`;

export interface OrganizationRow {
  readonly id: string;
  readonly name: string;
  readonly type: OrganizationType;
  readonly registration_number: string;
  readonly territory_code: string | null;
  readonly verification_status: OrganizationVerificationStatus;
  readonly status: OrganizationStatus;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface OrganizationMemberRow {
  readonly organization_id: string;
  readonly user_id: string;
  readonly role: OrganizationMemberRole;
  readonly status: OrganizationMemberStatus;
  readonly valid_from: Date;
  readonly valid_until: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  /**
   * Résultat du prédicat ci-dessus, calculé PAR LE SERVEUR au même instant que la lecture.
   * Le recalculer côté application supposerait de comparer l'horloge du processus à des
   * horodatages venus de la base : deux horloges, donc un désaccord possible, exactement
   * sur la frontière où l'accès bascule.
   */
  readonly is_effective: boolean;
}

/**
 * Crée une organisation.
 *
 * `verification_status`, `status` et `version` ne sont PAS écrits : les valeurs par défaut
 * du schéma (`PENDING`, `ACTIVE`, `1`) font foi. Les poser depuis le code ouvrirait la
 * porte à ce qu'un appelant les choisisse un jour, et une organisation qui naîtrait
 * `VERIFIED` rendrait la validation décorative.
 *
 * `registration_number_normalized` n'est pas écrit non plus : la colonne est générée et
 * PostgreSQL refuse toute écriture directe.
 *
 * AUCUNE VÉRIFICATION PRÉALABLE DU DOUBLON. L'unicité est tranchée par
 * `uq_organizations_registration_number` ; l'appelant traite le `23505`.
 */
export async function insertOrganization(
  executor: SqlExecutor,
  input: {
    readonly name: string;
    readonly type: OrganizationType;
    readonly registrationNumber: string;
    readonly territoryCode: string | null;
  },
): Promise<OrganizationRow> {
  const result = await executor.query<OrganizationRow>(
    `
      INSERT INTO public.organizations (name, type, registration_number, territory_code)
      VALUES ($1, $2::public.organization_type, $3, $4)
      RETURNING ${ORGANIZATION_COLUMNS}
    `,
    [input.name, input.type, input.registrationNumber, input.territoryCode],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Insertion d'organisation sans ligne retournee : ecriture inattendue.");
  }
  return row;
}

export async function findOrganizationById(
  executor: SqlExecutor,
  organizationId: string,
): Promise<OrganizationRow | undefined> {
  const result = await executor.query<OrganizationRow>(
    `
      SELECT ${ORGANIZATION_COLUMNS}
        FROM public.organizations
       WHERE id = $1
       LIMIT 1
    `,
    [organizationId],
  );
  return result.rows[0];
}

/**
 * MODIFICATION SOUS VERROU OPTIMISTE. C'est l'énoncé le plus important du module.
 *
 * Trois propriétés portées par l'énoncé lui-même, et perdues dès qu'on les déplace :
 *
 * 1. `WHERE version = $2` — le perdant d'une écriture concurrente ne met à jour AUCUNE
 *    ligne, et l'appelant lève `VERSION_CONFLICT`. Sans cette condition, le dernier
 *    écrivain gagne et la modification de l'autre disparaît sans message ni trace.
 * 2. `version = version + 1` dans le même `SET` — l'incrément appartient à l'`UPDATE`.
 *    Un déclencheur incrémenterait aussi bien, mais alors les deux transactions
 *    concurrentes réussiraient toutes deux et le conflit ne serait jamais détecté.
 * 3. La retombée de vérification est décidée PAR LE SERVEUR, sur la valeur courante lue
 *    sous le verrou de ligne. La décider en amont, d'après une lecture antérieure,
 *    laisserait passer le cas où l'organisation est validée entre la lecture et
 *    l'écriture : elle resterait `VERIFIED` sous un nom qui n'a pas été vérifié, ce qui
 *    est exactement l'usurpation que la règle existe pour empêcher.
 *
 * `updated_at` n'est pas écrit : le déclencheur partagé de 0003 l'impose côté serveur.
 */
export async function updateOrganizationIdentity(
  executor: SqlExecutor,
  input: {
    readonly organizationId: string;
    readonly expectedVersion: number;
    readonly name: string | null;
    readonly type: OrganizationType | null;
    readonly registrationNumber: string | null;
    readonly territoryCodeProvided: boolean;
    readonly territoryCode: string | null;
    /** Vrai lorsque `name`, `type` ou `registrationNumber` change. */
    readonly touchesIdentity: boolean;
  },
): Promise<OrganizationRow | undefined> {
  const result = await executor.query<OrganizationRow>(
    `
      UPDATE public.organizations
         SET name = COALESCE($3::text, name),
             type = COALESCE($4::public.organization_type, type),
             registration_number = COALESCE($5::text, registration_number),
             territory_code = CASE WHEN $6::boolean THEN $7::text ELSE territory_code END,
             verification_status = CASE
               WHEN $8::boolean AND verification_status = 'VERIFIED'
                 THEN 'PENDING'::public.organization_verification_status
               ELSE verification_status
             END,
             version = version + 1
       WHERE id = $1
         AND version = $2
      RETURNING ${ORGANIZATION_COLUMNS}
    `,
    [
      input.organizationId,
      input.expectedVersion,
      input.name,
      input.type,
      input.registrationNumber,
      input.territoryCodeProvided,
      input.territoryCode,
      input.touchesIdentity,
    ],
  );
  return result.rows[0];
}

/**
 * Crée une adhésion.
 *
 * `valid_from` n'est pas écrit : le défaut du schéma pose `now()`, l'instant de début de
 * transaction. Le poser depuis l'application ferait dépendre la validité d'une adhésion
 * de l'horloge du processus applicatif, qui peut avancer sur celle de la base — une
 * adhésion créée « dans le futur » n'ouvrirait alors aucun accès à celui qui vient de
 * créer son organisation.
 */
export async function insertOrganizationMember(
  executor: SqlExecutor,
  input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly role: OrganizationMemberRole;
    readonly status: OrganizationMemberStatus;
  },
): Promise<OrganizationMemberRow> {
  const result = await executor.query<OrganizationMemberRow>(
    `
      WITH inserted AS (
        INSERT INTO public.organization_members (organization_id, user_id, role, status)
        VALUES ($1, $2, $3::public.organization_member_role, $4::public.organization_member_status)
        RETURNING organization_id, user_id, role, status,
                  valid_from, valid_until, created_at, updated_at
      )
      SELECT ${MEMBER_COLUMNS},
             (${EFFECTIVE_MEMBERSHIP_PREDICATE}) AS is_effective
        FROM inserted m
    `,
    [input.organizationId, input.userId, input.role, input.status],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Insertion d'adhesion sans ligne retournee : ecriture inattendue.");
  }
  return row;
}

/**
 * Adhésion d'une personne dans une organisation, effective ou non.
 *
 * La ligne est renvoyée MÊME lorsqu'elle n'ouvre aucun accès, et c'est délibéré : le
 * contrat distingue « l'appelant n'est pas membre » — `NOT_FOUND`, aucune existence
 * confirmée — de « l'appelant est membre mais son adhésion n'est pas active » —
 * `FORBIDDEN`, l'appelant sachant déjà que l'organisation existe. Une fonction qui ne
 * renverrait que les adhésions effectives rendrait cette distinction impossible.
 */
export async function findMembership(
  executor: SqlExecutor,
  input: { readonly organizationId: string; readonly userId: string },
): Promise<OrganizationMemberRow | undefined> {
  const result = await executor.query<OrganizationMemberRow>(
    `
      SELECT ${MEMBER_COLUMNS},
             (${EFFECTIVE_MEMBERSHIP_PREDICATE}) AS is_effective
        FROM public.organization_members m
       WHERE m.organization_id = $1
         AND m.user_id = $2
       LIMIT 1
    `,
    [input.organizationId, input.userId],
  );
  return result.rows[0];
}

/**
 * Adhésions EFFECTIVES d'une personne, toutes organisations confondues.
 *
 * Servie par `idx_organization_members_user_status`. Le filtre de statut est dans
 * l'index ; les deux bornes de la fenêtre de validité sont évaluées sur les lignes
 * retenues.
 */
export async function listEffectiveMemberships(
  executor: SqlExecutor,
  userId: string,
): Promise<readonly OrganizationMemberRow[]> {
  const result = await executor.query<OrganizationMemberRow>(
    `
      SELECT ${MEMBER_COLUMNS}, true AS is_effective
        FROM public.organization_members m
       WHERE m.user_id = $1
         AND ${EFFECTIVE_MEMBERSHIP_PREDICATE}
       ORDER BY m.organization_id
    `,
    [userId],
  );
  return result.rows;
}

/**
 * Ligne de la file d'administration (`docs/screens.md`, écran 10).
 *
 * ELLE NE PORTE QUE CE SUR QUOI LA DÉCISION SE FONDE. Ni courriel, ni téléphone, ni pièce
 * jointe : vérifier un numéro d'immatriculation ne suppose pas de joindre le demandeur, et
 * `docs/privacy-rgpd.md` vaut pour un écran d'administration comme pour les autres. Du
 * demandeur, seul le NOM D'AFFICHAGE sort d'ici.
 */
export interface PendingOrganizationRow {
  readonly id: string;
  readonly name: string;
  readonly type: OrganizationType;
  readonly registration_number: string;
  readonly territory_code: string | null;
  /**
   * Instant de dépôt tel que l'AFFICHAGE en a besoin, à la milliseconde près.
   *
   * `pg` rend tout `timestamptz` sous forme de `Date` JavaScript, dont la résolution s'arrête
   * à la milliseconde : les microsecondes de PostgreSQL sont perdues ici, définitivement, et
   * avant que le moindre code applicatif ne voie la valeur. C'est sans conséquence pour une
   * date affichée à la minute ; c'en aurait une pour une position de pagination, d'où la
   * colonne suivante.
   */
  readonly created_at: Date;
  /**
   * POSITION EXACTE DE LA LIGNE DANS L'ORDRE DE LA FILE, rendue PAR POSTGRESQL en texte.
   *
   * Elle existe parce que `created_at` ci-dessus ne peut pas la porter. Le curseur de
   * pagination se compare à `o.created_at`, un `timestamptz` dont la résolution est la
   * MICROSECONDE ; un curseur reconstruit depuis une `Date` JavaScript est tronqué à la
   * milliseconde, donc STRICTEMENT INFÉRIEUR à la ligne dont il est issu, et la comparaison
   * stricte du `WHERE` resert cette ligne en tête de la page suivante.
   *
   * LE MONTAGE QUI CONSERVE LA PRÉCISION DE BOUT EN BOUT. La valeur est formatée par le
   * serveur, transportée en texte jusqu'au client, et renvoyée telle quelle en paramètre d'un
   * `::timestamptz` : elle ne traverse jamais un type dont la résolution est plus grossière
   * que celle de la colonne. Le format est ISO 8601 en UTC avec SIX chiffres de fraction,
   * c'est-à-dire exactement la résolution de `timestamptz`, ni plus ni moins.
   *
   * POURQUOI PAS UN ANALYSEUR DE TYPE `pg` (`setTypeParser` sur l'OID 1184). Il rendrait TOUS
   * les horodatages du produit sous forme de chaînes — `updated_at`, `valid_from`,
   * `valid_until`, `occurred_at`, `recorded_at` —, changerait le type de dizaines de lectures
   * qui n'ont rien demandé, et ferait dépendre une propriété de pagination d'un réglage global
   * du pilote qu'un second pool, un script ou une montée de version peut ne pas partager. La
   * précision est ici une propriété de LA REQUÊTE qui la produit, visible à côté du tri
   * qu'elle sert.
   */
  readonly created_at_cursor: string;
  /** `null` lorsque aucune adhésion `ORG_ADMIN` ne subsiste : l'absence se dit, elle ne s'invente pas. */
  readonly requested_by_display_name: string | null;
}

/**
 * File des organisations en attente de validation.
 *
 * ORDRE : DU PLUS ANCIEN AU PLUS RÉCENT. Une file de validation triée par nouveauté laisse au
 * fond celles que personne n'a traitées, c'est-à-dire précisément celles qui attendent depuis
 * le plus longtemps. `id` complète `created_at` pour que l'ordre soit TOTAL : deux
 * organisations créées à la même microseconde s'ordonneraient sinon au gré du plan
 * d'exécution, et la pagination par curseur en sauterait une ou la rendrait deux fois.
 *
 * Le filtre `verification_status = 'PENDING'` est servi par l'index partiel
 * `idx_organizations_verification_status` de `0015`, dont la première colonne est le statut et
 * la seconde `created_at`.
 *
 * LE DEMANDEUR EST L'ADHÉSION `ORG_ADMIN` LA PLUS ANCIENNE, jointe latéralement. C'est
 * l'adhésion créée dans la même transaction que l'organisation (`createOrganization`), donc
 * son créateur. LIMITE À CONNAÎTRE : si cette adhésion est un jour transférée à quelqu'un
 * d'autre (US-014), la file nommera le titulaire du moment et non le déposant d'origine. Le
 * déposant réel reste dans `audit_logs`, où il est daté et inaltérable ; la file ne le lit pas,
 * parce qu'un écran de consultation n'a pas à ouvrir le journal de preuve pour afficher un nom.
 *
 * LE CURSEUR ENTRE ET SORT EN TEXTE, JAMAIS EN `Date`. `after.createdAt` est la valeur rendue
 * par `created_at_cursor` lors de la page précédente, réinjectée telle quelle : PostgreSQL la
 * relit avec la même résolution que celle avec laquelle il l'a écrite. Le convertir en `Date`
 * en chemin — dans cette fonction, dans le domaine ou dans un test — le tronquerait à la
 * milliseconde et rouvrirait le doublon de frontière de page que cette rédaction ferme.
 *
 * NI `date_trunc` DANS LA COMPARAISON, NI `>=` : ce n'est pas une préférence de style, les
 * deux variantes ont été mesurées contre le jeu de référence de
 * `tests/integration/organizations-admin-queue.test.ts`.
 *  - `date_trunc('milliseconds', o.created_at)` DANS LE SEUL `WHERE`, le tri restant exact :
 *    la frontière n'est plus resservie, mais tout dépôt de la MÊME milliseconde dont
 *    l'identifiant précède celui de la frontière passe sous le curseur et n'est JAMAIS rendu.
 *    Mesuré : la seconde page tombe de deux lignes à une. C'est pire que le défaut d'origine —
 *    une ligne rendue deux fois se remarque, une ligne jamais rendue ne se remarque pas, et
 *    c'est une organisation qui attend d'être validée ;
 *  - `date_trunc` DES DEUX CÔTÉS, tri compris : plus de doublon ni d'oubli, mais l'ORDRE
 *    change. Deux dépôts de la même milliseconde deviennent ex aequo et se départagent par
 *    leur identifiant, donc dans un ordre qui n'est plus chronologique alors que l'en-tête
 *    ci-dessus en fait la raison d'être de la file. Mesuré : la première page ne se termine
 *    plus sur le même dépôt. L'index partiel `idx_organizations_verification_status` cesse en
 *    outre de servir ce tri, une expression n'étant pas la colonne qu'il indexe ;
 *  - `>=` ne corrige rien : le curseur tronqué est DÉJÀ inférieur à sa ligne, l'inégalité
 *    large la resservirait donc pareillement, et le jour où le curseur serait exact elle
 *    resservirait la frontière SYSTÉMATIQUEMENT. C'est l'inverse d'un correctif.
 *  Aucune arithmétique sur une valeur déjà tronquée ne restitue ce qu'elle a perdu : elle
 *  déplace le défaut du doublon vers l'oubli, ou vers le désordre. La seule correction est de
 *  ne rien perdre.
 */
export async function listPendingOrganizations(
  executor: SqlExecutor,
  input: {
    readonly after: { readonly createdAt: string; readonly id: string } | null;
    readonly limit: number;
  },
): Promise<readonly PendingOrganizationRow[]> {
  const result = await executor.query<PendingOrganizationRow>(
    `
      SELECT o.id, o.name, o.type, o.registration_number, o.territory_code, o.created_at,
             to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
               AS created_at_cursor,
             requester.display_name AS requested_by_display_name
        FROM public.organizations o
        LEFT JOIN LATERAL (
          SELECT p.display_name
            FROM public.organization_members m
            JOIN public.user_profiles p ON p.id = m.user_id
           WHERE m.organization_id = o.id
             AND m.role = 'ORG_ADMIN'
           ORDER BY m.created_at, m.user_id
           LIMIT 1
        ) AS requester ON true
       WHERE o.verification_status = 'PENDING'
         AND (
           $1::timestamptz IS NULL
           OR (o.created_at, o.id) > ($1::timestamptz, $2::uuid)
         )
       ORDER BY o.created_at, o.id
       LIMIT $3
    `,
    [input.after?.createdAt ?? null, input.after?.id ?? null, input.limit],
  );
  return result.rows;
}

/**
 * Nombre RÉEL d'organisations en attente, sans plafonnement.
 *
 * `docs/screens.md` l'exige explicitement : « un compteur qui s'arrête à 99+ cache exactement
 * la situation qu'il devrait signaler ». Le compte est donc séparé de la page, et non déduit
 * du nombre d'éléments renvoyés, qui est borné par la pagination.
 */
export async function countPendingOrganizations(executor: SqlExecutor): Promise<number> {
  const result = await executor.query<{ readonly total: number }>(
    `
      SELECT count(*)::int AS total
        FROM public.organizations
       WHERE verification_status = 'PENDING'
    `,
  );
  return result.rows[0]?.total ?? 0;
}

/**
 * Vrai lorsque la personne détient une adhésion EFFECTIVE de rôle `PLATFORM_ADMIN`.
 *
 * POINT OUVERT, HÉRITÉ ET NON TRANCHÉ ICI. `docs/permissions.md` range `PLATFORM_ADMIN`
 * parmi les rôles et `0014` le reprend, si bien qu'un rôle dont la portée est la
 * plateforme se trouve rattaché à une organisation ; le jeu de démonstration le signale
 * déjà (`supabase/seed/003_organization-members.sql`). Tant que l'arbitrage n'a pas eu
 * lieu, la fonction d'administrateur plateforme est reconnue QUELLE QUE SOIT
 * l'organisation qui la porte, et elle ne vaut pas appartenance à cette organisation :
 * le contrat tient les deux chemins pour distincts.
 *
 * La condition d'effectivité s'applique sans exception : un administrateur plateforme
 * dont l'adhésion est suspendue perd sa fonction à la requête suivante, comme n'importe
 * quel autre rôle. C'est le rôle le plus puissant du produit, ce serait le pire endroit
 * où faire une exception.
 *
 * L'ORGANISATION QUI PORTE LE RÔLE DOIT ÊTRE ACTIVE, et c'est la seule lecture du module
 * qui joigne `organizations`. La raison tient au « deux gardes, pas une » de
 * supabase/README.md : partout ailleurs, la seconde garde porte sur l'organisation VISÉE
 * par l'action. Ici, la fonction sert justement à accéder à d'AUTRES organisations, il n'y
 * a donc pas d'organisation visée à contrôler — et sans cette condition, suspendre une
 * organisation ne retirerait pas les pouvoirs de plateforme qu'elle a accordés. `0014`
 * l'écrit sans réserve : « Aucune adhésion à une organisation suspendue ne doit ouvrir
 * d'accès. »
 *
 * La règle des trois conditions de supabase/README.md reste intacte pour les rôles
 * ordinaires : elle qualifie l'ADHÉSION, et l'état de l'organisation est vérifié
 * séparément par `assertOrganizationActive`. Le cas traité ici est le seul où les deux ne
 * peuvent pas être séparés, la fonction n'ayant pas de cible propre.
 */
export async function hasPlatformAdminRole(
  executor: SqlExecutor,
  userId: string,
): Promise<boolean> {
  const result = await executor.query<{ readonly is_platform_admin: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
          FROM public.organization_members m
          JOIN public.organizations o ON o.id = m.organization_id
         WHERE m.user_id = $1
           AND m.role = 'PLATFORM_ADMIN'
           AND o.status = 'ACTIVE'
           AND ${EFFECTIVE_MEMBERSHIP_PREDICATE}
      ) AS is_platform_admin
    `,
    [userId],
  );
  return result.rows[0]?.is_platform_admin ?? false;
}

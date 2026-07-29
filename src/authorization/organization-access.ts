import { AppError, type ErrorCode } from '@/application/errors';
import type {
  MembershipView,
  OrganizationMemberRole,
  OrganizationMemberStatus,
  OrganizationStatus,
  OrganizationVerificationStatus,
} from '@/domain/organizations/types';
import type { SqlExecutor } from '@/infrastructure/identity/unit-of-work';
import type { OrganizationMemberRow } from '@/infrastructure/organizations/repository';
import { findMembership, hasPlatformAdminRole } from '@/infrastructure/organizations/repository';
import { getRequestLogger } from '@/observability/logger';

/**
 * Résolution de l'appartenance et du rôle.
 *
 * CE MODULE SOLDE LE CRITÈRE 12 DE US-010. `supabase/README.md` énumérait quatre
 * conditions de validité de session et signalait qu'une CINQUIÈME manquait : « une
 * adhésion suspendue doit couper l'accès », irréalisable au lot 1 parce que
 * `organization_members` n'existait pas. La table existe depuis `0016` ; la condition est
 * ici.
 *
 * ELLE NE PORTE PAS SUR LA SESSION, ET C'EST DÉLIBÉRÉ. L'ajouter aux quatre conditions de
 * `findValidSessionByTokenHash` reviendrait à refuser toute session dépourvue d'adhésion,
 * c'est-à-dire à empêcher un compte neuf de créer sa première organisation — la porte
 * d'entrée du produit. Ce que `docs/permissions.md` exige est plus précis, et c'est ce qui
 * est mis en œuvre : une adhésion suspendue ou expirée coupe l'accès AUX DONNÉES DE
 * L'ORGANISATION CONCERNÉE, dès la requête suivante, sans attendre l'expiration de la
 * session. La suspension du COMPTE, elle, reste portée par la validité de session.
 *
 * AUCUN CACHE, ET AUCUNE MÉMOÏSATION. `docs/architecture.md` interdit de cacher les
 * autorisations critiques (ADR-021). La raison est directe : un rôle mis en cache
 * survivrait à sa propre suspension pendant la durée du cache, c'est-à-dire pendant la
 * fenêtre exacte que la suspension existe pour fermer. Aucune structure de ce fichier ne
 * conserve un résultat d'une requête à l'autre, et aucune ne doit en conserver.
 *
 * L'EXÉCUTANT VIENT DE L'APPELANT, pour que la décision soit prise DANS la transaction qui
 * écrit. Résoudre le rôle hors transaction puis écrire ensuite laisserait une fenêtre où
 * l'adhésion est révoquée entre la garde et l'effet : la garde aurait dit oui, l'écriture
 * aurait eu lieu après le non.
 *
 * CHAQUE REFUS ÉCRIT SON MOTIF AU JOURNAL, et c'est la contrepartie de l'oracle fermé côté
 * client. `docs/api-contract.md` refuse par `NOT_FOUND` un appelant qui n'est pas membre,
 * pour qu'aucune réponse ne confirme l'existence d'une organisation ; il promet en échange
 * que le journal technique, lui, conserve la cause réelle. La promesse est tenue ici, par
 * `denyOrganizationAccess` : les gardes de ce module ne lèvent jamais une `AppError` de refus
 * sans avoir écrit la ligne qui la motive.
 */

/**
 * Ce que l'appelant est dans une organisation donnée, à cet instant.
 *
 * Deux champs pour l'adhésion, et la distinction est celle du contrat API :
 * - `membership` est la ligne telle qu'elle existe, quel que soit son statut. Elle sert à
 *   distinguer « n'est pas membre » de « est membre mais son adhésion ne vaut rien », donc
 *   `NOT_FOUND` de `FORBIDDEN` ;
 * - `effectiveMembership` est la même ligne, mais seulement si les trois conditions
 *   d'effectivité sont réunies. C'est elle, et elle seule, qui ouvre un accès.
 */
export interface OrganizationAccess {
  readonly organizationId: string;
  readonly userId: string;
  readonly membership: OrganizationMemberRow | null;
  readonly effectiveMembership: OrganizationMemberRow | null;
  /**
   * Fonction d'administrateur plateforme, relue à chaque appel.
   *
   * POINT OUVERT HÉRITÉ : `docs/permissions.md` range `PLATFORM_ADMIN` parmi les rôles
   * d'adhésion, si bien qu'un rôle dont la portée est la plateforme est rattaché à une
   * organisation. Tant que l'arbitrage n'a pas eu lieu, la fonction est reconnue quelle que
   * soit l'organisation qui la porte, et elle NE VAUT PAS appartenance à l'organisation
   * consultée : `membership` reste `null` pour un administrateur plateforme extérieur.
   */
  readonly isPlatformAdmin: boolean;
}

/**
 * Résout l'accès d'une personne à une organisation.
 *
 * DEUX LECTURES, VOLONTAIREMENT SÉPARÉES. Une requête unique économiserait un aller-retour
 * mais mêlerait deux questions distinctes — « qu'est cette personne ici ? » et « est-elle
 * administratrice de la plateforme ? » — dont l'arbitrage à venir sur `PLATFORM_ADMIN`
 * pourrait séparer les sources. Les deux lectures sont des accès indexés : la première sur
 * la clé primaire de `organization_members`, la seconde sur
 * `idx_organization_members_user_status`.
 *
 * Les deux doivent être exécutées avec le MÊME exécutant, dans la même transaction que la
 * décision : `now()` y est l'instant de début de transaction, donc identique pour les deux.
 */
export async function resolveOrganizationAccess(
  executor: SqlExecutor,
  input: { readonly userId: string; readonly organizationId: string },
): Promise<OrganizationAccess> {
  const membership = (await findMembership(executor, input)) ?? null;
  const isPlatformAdmin = await hasPlatformAdminRole(executor, input.userId);
  return {
    organizationId: input.organizationId,
    userId: input.userId,
    membership,
    // `is_effective` est calculé par le serveur, au même instant que la lecture : la
    // condition ne recopie donc pas les trois règles, elle lit leur résultat. Une seule
    // écriture du prédicat, dans `repository.ts`, et aucune chance qu'une copie dérive.
    effectiveMembership: membership?.is_effective === true ? membership : null,
    isPlatformAdmin,
  };
}

/**
 * Motif RÉEL d'un refus, tel qu'il part au journal technique — et nulle part ailleurs.
 *
 * POURQUOI CE VOCABULAIRE EXISTE. `docs/api-contract.md` ferme l'oracle d'existence côté
 * client : membre suspendu, tiers curieux et identifiant qui ne désigne rien reçoivent la
 * même réponse, octet pour octet. Le contrat promet en échange que « le journal technique
 * conserve le motif réel — un refus d'autorisation, compté parmi les métriques de
 * `docs/observability.md` ». Sans ce champ, les deux causes produisaient une ligne
 * rigoureusement identique : la métrique « refus d'autorisation » n'avait aucune source et
 * l'alerte « hausse d'accès refusés » restait inconstruisible.
 *
 * POURQUOI PLUSIEURS MOTIFS PLUTÔT QU'UN SEUL « REFUSÉ ». Ils ne se lisent pas de la même
 * façon en exploitation, et c'est toute leur utilité : `ORGANIZATION_ABSENT` en rafale est un
 * balayage d'identifiants ; `MEMBERSHIP_REVOKED` en rafale est un onglet resté ouvert après
 * une révocation ; `MEMBERSHIP_NOT_YET_OPEN` en rafale est une prise de fonction datée de
 * travers, c'est-à-dire un incident d'exploitation et non une attaque. Un motif unique
 * obligerait à relire les journaux applicatifs pour distinguer les trois, alors que
 * l'alerte doit pouvoir se construire sur un comptage.
 */
export type OrganizationAccessDenialReason =
  /** L'identifiant ne désigne aucune organisation. Levé par le domaine, pas par une garde. */
  | 'ORGANIZATION_ABSENT'
  /** L'organisation existe ; l'appelant n'y a aucune adhésion, quelle qu'elle soit. */
  | 'MEMBERSHIP_ABSENT'
  /** Adhésion préparée mais jamais acceptée. */
  | 'MEMBERSHIP_INVITED'
  /** Adhésion coupée après incident, réversible. */
  | 'MEMBERSHIP_SUSPENDED'
  /** Adhésion retirée définitivement ; c'est ainsi qu'on sort quelqu'un d'une organisation. */
  | 'MEMBERSHIP_REVOKED'
  /** Adhésion active dont la prise d'effet est encore devant nous. */
  | 'MEMBERSHIP_NOT_YET_OPEN'
  /** Adhésion active dont l'échéance est passée. */
  | 'MEMBERSHIP_EXPIRED'
  /** Fenêtre close, sans que l'horloge du processus puisse dire par quelle borne. */
  | 'MEMBERSHIP_OUT_OF_WINDOW'
  /** Adhésion parfaitement effective, mais son rôle n'ouvre pas cette action. */
  | 'ROLE_NOT_ALLOWED';

/**
 * Codes de refus que ce module produit. La restriction est volontaire : `denyOrganizationAccess`
 * ne doit pas devenir un point de sortie universel par lequel n'importe quel code d'erreur
 * s'écrirait « refus d'autorisation » dans les métriques.
 */
type OrganizationDenialCode = Extract<ErrorCode, 'NOT_FOUND' | 'FORBIDDEN'>;

/**
 * Motif d'un statut d'adhésion qui n'ouvre rien.
 *
 * ÉNUMÉRÉ, JAMAIS DÉDUIT. Un `MEMBERSHIP_${status}` construit à la volée produirait un motif
 * inconnu de l'exploitation le jour où une valeur s'ajoute au type énuméré, et les tableaux de
 * bord compteraient alors un motif que personne n'a défini. Ici, une valeur nouvelle fait
 * échouer la compilation, ce qui est le sens sûr.
 */
const MEMBERSHIP_STATUS_REASONS: Readonly<
  Record<Exclude<OrganizationMemberStatus, 'ACTIVE'>, OrganizationAccessDenialReason>
> = {
  INVITED: 'MEMBERSHIP_INVITED',
  SUSPENDED: 'MEMBERSHIP_SUSPENDED',
  REVOKED: 'MEMBERSHIP_REVOKED',
};

/**
 * Étiquette la fenêtre de validité d'une adhésion DÉJÀ jugée non effective.
 *
 * LA DÉCISION N'EST PAS RECALCULÉE ICI, ET NE DOIT JAMAIS L'ÊTRE. `is_effective` est évalué par
 * PostgreSQL, dans la transaction qui lit, sur son `now()`. Cette fonction ne s'exécute que
 * lorsqu'il vaut déjà `false` : elle nomme un refus acquis, elle n'en prononce aucun.
 *
 * L'HORLOGE DU PROCESSUS N'EST QU'UN TÉMOIN, ET ELLE EST RÉCUSABLE. Les deux bornes ne se
 * distinguent pas sans comparer à un instant, et le seul instant disponible ici est celui du
 * poste applicatif, qui peut avancer ou retarder sur celui de la base. Lorsque ce témoin ne
 * corrobore pas la décision du serveur — aucune borne franchie, ou les deux à la fois —, le
 * motif retombe sur `MEMBERSHIP_OUT_OF_WINDOW` au lieu de trancher au hasard : en exploitation,
 * un motif moins précis coûte une hésitation, un motif faux coûte une enquête entière.
 */
function validityWindowReason(membership: OrganizationMemberRow): OrganizationAccessDenialReason {
  const observedAt = Date.now();
  const notYetOpen = membership.valid_from.getTime() > observedAt;
  const expired = membership.valid_until !== null && membership.valid_until.getTime() <= observedAt;
  if (notYetOpen === expired) {
    return 'MEMBERSHIP_OUT_OF_WINDOW';
  }
  return notYetOpen ? 'MEMBERSHIP_NOT_YET_OPEN' : 'MEMBERSHIP_EXPIRED';
}

/** Motif d'une adhésion qui existe sans être effective : d'abord le statut, puis la fenêtre. */
function membershipDenialReason(membership: OrganizationMemberRow): OrganizationAccessDenialReason {
  if (membership.status !== 'ACTIVE') {
    return MEMBERSHIP_STATUS_REASONS[membership.status];
  }
  return validityWindowReason(membership);
}

/**
 * Écrit le motif réel au journal technique, puis rend l'erreur à lever.
 *
 * CE QUE LA LIGNE NE PORTE JAMAIS : ni le nom de l'organisation, ni son numéro
 * d'immatriculation, ni aucune coordonnée. Ce sont eux qui identifient une structure dans un
 * registre public ; un journal d'exploitation qui les recopierait rouvrirait par la fenêtre
 * l'oracle que la réponse ferme par la porte, et il serait lisible par des rôles auxquels
 * l'application refuse justement cette information. `organizationId` y figure en revanche :
 * `docs/observability.md` le range parmi les champs attendus, c'est un identifiant opaque que
 * l'appelant vient lui-même de fournir, et sans lui l'alerte ne saurait pas distinguer un
 * balayage de mille identifiants d'un lien mort rechargé mille fois.
 *
 * NIVEAU `warn`, ET LE CHOIX EST CONTRAINT. Un refus n'est pas une panne — `error` le ferait
 * remonter comme telle et le noierait au milieu des vraies. Mais `info` serait pire : la
 * ligne de sortie de requête est déjà émise en `warn` par `logOutcome` pour tout 4xx, si bien
 * qu'un déploiement réglé sur `warn` conserverait le refus et perdrait son motif — exactement
 * la situation que le contrat interdit, avec en plus l'apparence d'être outillé. Le motif se
 * journalise donc au niveau où le refus lui-même est visible, pas en dessous. Le coût est nul
 * en fonctionnement normal : aucune ligne n'est écrite quand l'accès est accordé.
 *
 * L'ERREUR EST RENDUE, PAS LEVÉE. L'appelant écrit `throw denyOrganizationAccess(...)` : le
 * point de sortie reste visible à l'endroit où la garde se rend, et non caché dans une
 * fonction dont rien, à la lecture, ne dirait qu'elle interrompt le flot.
 */
export function denyOrganizationAccess(
  organizationId: string,
  reason: OrganizationAccessDenialReason,
  errorCode: OrganizationDenialCode,
): AppError {
  getRequestLogger().warn(
    { module: 'organizations', organizationId, errorCode, reason },
    'acces a une organisation refuse',
  );
  return new AppError(errorCode);
}

/**
 * Garde de LECTURE : l'appelant peut-il voir cette organisation ?
 *
 * Refus par `NOT_FOUND`, et non par `FORBIDDEN`. Répondre `403` confirmerait que
 * l'identifiant désigne une organisation existante, ce qui ferait de la route un oracle
 * d'existence : il suffirait de parcourir des identifiants pour dresser la liste des
 * organisations. Le journal technique, lui, conserve le motif réel — un refus
 * d'autorisation, compté parmi les métriques de `docs/observability.md`.
 *
 * UNE ADHÉSION SUSPENDUE NE VOIT PLUS RIEN. C'est le critère 12 appliqué à la lecture :
 * `effectiveMembership` est `null` dès que le statut n'est plus `ACTIVE` ou que la fenêtre
 * de validité est close, et l'appelant reçoit alors la même réponse qu'un inconnu.
 *
 * LA RÉPONSE NE DISTINGUE RIEN, LE JOURNAL DISTINGUE TOUT. Les deux causes — aucune adhésion,
 * ou une adhésion qui ne vaut plus — lèvent la même erreur, donc le même corps au bit près ;
 * seul le motif journalisé les sépare.
 */
export function assertOrganizationVisible(access: OrganizationAccess): void {
  if (access.isPlatformAdmin) {
    return;
  }
  if (access.effectiveMembership === null) {
    throw denyOrganizationAccess(
      access.organizationId,
      access.membership === null ? 'MEMBERSHIP_ABSENT' : membershipDenialReason(access.membership),
      'NOT_FOUND',
    );
  }
}

/**
 * Garde de MUTATION : l'appelant détient-il l'un des rôles admis ?
 *
 * LES RÔLES SONT ÉNUMÉRÉS, JAMAIS COMPARÉS. L'ordre du type énuméré
 * `organization_member_role` suit `docs/permissions.md`, où `OBSERVER` figure en dernier
 * alors qu'il est le rôle le MOINS capable : une garde écrite `role >= 'ORG_ADMIN'`
 * accorderait à un observateur les droits d'un administrateur d'organisation.
 *
 * DEUX CODES DE REFUS, ET L'ASYMÉTRIE EST CELLE DU CONTRAT :
 * - `NOT_FOUND` lorsque l'appelant n'a AUCUNE adhésion et n'est pas administrateur
 *   plateforme. Même règle qu'en lecture : rien ne lui confirme l'existence de l'objet ;
 * - `FORBIDDEN` lorsqu'une adhésion existe mais ne convient pas — rôle insuffisant,
 *   statut non actif, fenêtre de validité close. La distinction est assumée : à ce stade
 *   l'appelant sait déjà que l'organisation existe, puisqu'il en est ou en a été membre.
 *
 * LES DEUX CAUSES DE `FORBIDDEN` SONT SÉPARÉES, alors qu'une seule condition suffirait à les
 * refuser toutes deux. Elles n'appellent pas la même conduite : un rôle insuffisant se corrige
 * en accordant le rôle, une adhésion éteinte se corrige en la rouvrant, et les confondre au
 * journal obligerait à rouvrir la base pour savoir laquelle des deux a joué.
 */
export function assertOrganizationRole(
  access: OrganizationAccess,
  allowedRoles: readonly OrganizationMemberRole[],
): void {
  if (access.isPlatformAdmin) {
    return;
  }
  if (access.membership === null) {
    throw denyOrganizationAccess(access.organizationId, 'MEMBERSHIP_ABSENT', 'NOT_FOUND');
  }
  const effective = access.effectiveMembership;
  if (effective === null) {
    throw denyOrganizationAccess(
      access.organizationId,
      membershipDenialReason(access.membership),
      'FORBIDDEN',
    );
  }
  if (!allowedRoles.includes(effective.role)) {
    throw denyOrganizationAccess(access.organizationId, 'ROLE_NOT_ALLOWED', 'FORBIDDEN');
  }
}

/**
 * Seconde garde : l'ORGANISATION a-t-elle le droit d'agir ?
 *
 * DEUX GARDES, PAS UNE. L'adhésion dit ce que la personne peut faire ; elle ne dit pas si
 * la structure est en état d'agir. Le jeu de démonstration porte précisément ce cas :
 * l'administrateur de « Travaux Publics Horizon » a une adhésion parfaitement valide dans
 * une organisation qui n'est pas encore vérifiée.
 *
 * La comparaison est une ÉGALITÉ à `VERIFIED`. `REJECTED` n'est pas « plus vérifié » que
 * `VERIFIED` : l'ordre du type énuméré ne signifie rien ici.
 */
export function assertOrganizationVerified(organization: {
  readonly verification_status: OrganizationVerificationStatus;
}): void {
  if (organization.verification_status !== 'VERIFIED') {
    throw new AppError('ORGANIZATION_NOT_VERIFIED');
  }
}

/**
 * Troisième garde : la fiche est-elle utilisable ?
 *
 * Axe INDÉPENDANT de la vérification (`0014_organization-enums.sql`). Une organisation peut
 * être `VERIFIED` et `SUSPENDED` — structure authentique dont l'accès a été coupé après
 * incident — ou `PENDING` et `ACTIVE`. Confondre les deux axes ferait dériver l'un des deux
 * au premier changement d'état, et rien ne dirait alors lequel fait foi.
 *
 * `FORBIDDEN` et non `NOT_FOUND` : l'appelant qui atteint cette garde est déjà passé par
 * les précédentes, il sait donc que l'organisation existe.
 */
export function assertOrganizationActive(organization: {
  readonly status: OrganizationStatus;
}): void {
  if (organization.status !== 'ACTIVE') {
    throw new AppError('FORBIDDEN');
  }
}

/**
 * Projection d'une adhésion vers le contrat API.
 *
 * La ligne brute n'est jamais renvoyée telle quelle : elle porte `organization_id` et
 * `user_id`, que le contrat ne fait pas figurer dans l'objet `membership` — l'appelant les
 * connaît déjà, l'un par le chemin, l'autre parce qu'il s'agit de lui-même.
 */
export function toMembershipView(row: OrganizationMemberRow): MembershipView {
  return {
    role: row.role,
    status: row.status,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
  };
}

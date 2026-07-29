import { AppError } from '@/application/errors';
import type { OrganizationType } from '@/domain/organizations/types';
import type { SqlExecutor } from '@/infrastructure/identity/unit-of-work';
import { getExecutor, withTransaction } from '@/infrastructure/identity/unit-of-work';
import {
  countPendingOrganizations,
  hasPlatformAdminRole,
  listPendingOrganizations as listPendingOrganizationRows,
} from '@/infrastructure/organizations/repository';
import { getRequestLogger } from '@/observability/logger';
import { pseudonymizeUserId } from '@/observability/request-context';
import { cursorSchema, uuidSchema } from '@/validation/common';

/**
 * File des organisations en attente de validation (US-012, `docs/screens.md` écran 10).
 *
 * CE QUE CETTE COMMANDE N'EST PAS. Elle ne valide rien et ne refuse rien : la décision
 * `POST /api/v1/admin/organizations/{id}/commands/verify` relève d'US-013. La file existe
 * donc avant la décision qu'elle prépare, et c'est délibéré — rendre visible une attente que
 * personne ne peut encore lever vaut mieux que la laisser invisible.
 *
 * `FORBIDDEN` ET NON `NOT_FOUND`, contrairement à la lecture d'une organisation. La
 * différence n'est pas une inconséquence : lire une organisation par son identifiant peut
 * confirmer son existence à qui n'a rien à y voir, donc ouvrir un oracle d'énumération. Ici
 * il n'y a aucune existence à dissimuler, seulement une FONCTION à refuser — l'adresse est
 * publiquement documentée par `docs/api-contract.md`, et un `404` ne cacherait rien que le
 * document ne dise déjà.
 *
 * LA FONCTION D'ADMINISTRATEUR PLATEFORME EST RELUE À CHAQUE APPEL (ADR-021), y compris ses
 * conditions d'effectivité : une adhésion suspendue, expirée ou portée par une organisation
 * elle-même suspendue ne l'ouvre plus dès la requête suivante.
 */

/** Ligne de la file, telle que le contrat l'expose. */
export interface PendingOrganizationView {
  readonly id: string;
  readonly name: string;
  readonly type: OrganizationType;
  /** Tel qu'il a été saisi, séparateurs compris : c'est sous cette forme qu'il se compare. */
  readonly registrationNumber: string;
  /** `null` signifie « aucun périmètre déclaré ». L'absence est une information. */
  readonly territoryCode: string | null;
  readonly createdAt: Date;
  readonly requestedByDisplayName: string | null;
}

export interface ListPendingOrganizationsInput {
  readonly actorUserId: string;
  /** Curseur opaque, fourni par l'appelant : validé comme n'importe quelle entrée externe. */
  readonly cursor?: unknown;
}

export interface ListPendingOrganizationsResult {
  readonly items: readonly PendingOrganizationView[];
  readonly nextCursor: string | null;
  /**
   * Nombre RÉEL d'organisations en attente, toutes pages confondues.
   *
   * Exigé par `docs/screens.md` : « le compteur affiché à côté du titre est le nombre réel
   * d'organisations en attente, sans plafonnement ». Il ne se déduit pas de `items.length`,
   * borné par la pagination — ce serait exactement le compteur qui s'arrête à « 99+ » que le
   * document interdit.
   */
  readonly totalCount: number;
}

/**
 * Taille de page.
 *
 * Volontairement modeste : la file se lit sur un téléphone, et une page qui charge deux cents
 * lignes pour en afficher trois consomme du réseau là où il est le plus rare.
 */
const PAGE_SIZE = 25;

/** Séparateur du curseur. Absent des deux valeurs encodées, donc sans ambiguïté de découpe. */
const CURSOR_SEPARATOR = '|';

interface CursorPosition {
  /**
   * Instant de dépôt EN TEXTE, tel que PostgreSQL l'a rendu, fraction à six chiffres comprise.
   *
   * PAS UNE `Date`, ET C'EST TOUT LE CORRECTIF. `created_at` est un `timestamptz`, dont la
   * résolution est la MICROSECONDE ; une `Date` JavaScript s'arrête à la MILLISECONDE. Un
   * curseur reconstruit depuis une `Date` — par `toISOString()` ou autrement — est donc
   * strictement INFÉRIEUR à la ligne dont il est issu, et la comparaison stricte du dépôt
   * (`(created_at, id) > (curseur)`) resert cette ligne en tête de la page suivante.
   * L'administrateur voit alors une organisation EN DOUBLE à chaque frontière de page, à côté
   * d'un compteur qui, lui, est juste : l'écran ment sur son propre contenu.
   *
   * La perte est ANTÉRIEURE à ce module : `pg` rend déjà `created_at` sous forme de `Date`, il
   * n'y a plus rien à récupérer une fois la ligne remontée. La position exacte est donc
   * demandée au serveur en même temps que la ligne (`created_at_cursor`), transportée en texte
   * et renvoyée en texte. Voir l'en-tête de `listPendingOrganizations` dans
   * `src/infrastructure/organizations/repository.ts` pour le détail du montage, et pour les
   * raisons qui écartent `date_trunc` des deux côtés, l'inégalité large, et un `setTypeParser`
   * global sur le pilote.
   */
  readonly createdAt: string;
  readonly id: string;
}

/**
 * Forme acceptée pour l'instant d'un curseur : ISO 8601, en UTC, fraction facultative d'au
 * plus six chiffres.
 *
 * ELLE EST STRICTE PARCE QUE LA VALEUR FINIT EN PARAMÈTRE D'UN `::timestamptz`. Rien n'est
 * concaténé — le paramétrage écarte l'injection —, mais PostgreSQL accepte des littéraux que
 * personne n'attend ici (`infinity`, `now`, `epoch`, un fuseau nommé) et refuse en erreur tout
 * le reste, ce qui rendrait un `500` là où l'appelant a simplement présenté un curseur abîmé.
 * La forme est donc tranchée AVANT la base, et le refus est un `400`.
 *
 * SIX CHIFFRES AU PLUS : c'est la résolution de `timestamptz`. En accepter davantage
 * laisserait croire à une précision que la colonne ne porte pas, et PostgreSQL arrondirait en
 * silence — le curseur ne désignerait alors plus la ligne dont il est issu.
 *
 * MOINS DE SIX RESTE ACCEPTÉ : les curseurs déjà remis à des clients portent trois chiffres.
 * Les refuser transformerait une correction en panne pour quiconque a une page ouverte.
 */
const CURSOR_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z$/;

/**
 * Vrai lorsque le texte désigne un instant réellement existant.
 *
 * LE MOTIF NE SUFFIT PAS. `2026-02-30T25:61:00Z` le satisfait, et `Date` le REPORTE au lieu de
 * le refuser : le 30 février devient le 2 mars, la 25ᵉ heure devient le lendemain. PostgreSQL,
 * lui, refuse ces valeurs par une erreur — donc un `500` sur une entrée que la route doit
 * refuser en `400`. Le contrôle est un aller-retour : on recompose l'instant, puis on vérifie
 * que ses composantes sont bien celles qui ont été lues. Tout report se voit là.
 */
function isRealInstant(match: RegExpExecArray): boolean {
  // `Number(undefined)` vaut `NaN`, qu'aucune des égalités ci-dessous ne satisfait : un groupe
  // manquant est donc refusé sans qu'il faille le tester séparément.
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = Number(match[6]);
  const probe = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
  if (Number.isNaN(probe.getTime())) {
    return false;
  }
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day &&
    probe.getUTCHours() === hours &&
    probe.getUTCMinutes() === minutes &&
    probe.getUTCSeconds() === seconds
  );
}

/**
 * Curseur opaque : instant de dépôt et identifiant, exactement les deux colonnes du tri.
 *
 * OPAQUE, PAS SECRET. Il n'est ni signé ni chiffré, et n'a pas à l'être : il ne porte qu'un
 * horodatage et un identifiant que l'appelant vient de recevoir dans la page précédente.
 * Le forger ne donne accès à rien — la garde d'autorisation est refaite à chaque requête, et
 * la seule chose qu'un curseur choisi permet est de sauter des lignes qu'on avait déjà le
 * droit de lire.
 *
 * L'ENCODAGE EXISTE POUR UNE AUTRE RAISON : dissuader un client d'en fabriquer un à partir de
 * champs métier. Un curseur qui serait un horodatage lisible finirait par être construit à la
 * main, et le jour où le tri changerait, la pagination casserait chez l'appelant sans
 * qu'aucun contrat n'ait bougé. La raison vaut doublement ici : l'instant encodé est PLUS
 * PRÉCIS que le `createdAt` rendu dans la même réponse, qui est arrondi à la milliseconde par
 * la sérialisation ISO du contrat. Un client qui reconstruirait le curseur depuis le champ
 * affiché rebâtirait exactement le défaut que ce module vient de fermer.
 */
function encodeCursor(position: CursorPosition): string {
  const raw = `${position.createdAt}${CURSOR_SEPARATOR}${position.id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

function decodeCursor(raw: unknown): CursorPosition | null {
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  const parsed = cursorSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', { details: { fields: ['cursor'] } });
  }

  const decoded = Buffer.from(parsed.data, 'base64url').toString('utf8');
  const separatorIndex = decoded.indexOf(CURSOR_SEPARATOR);
  if (separatorIndex <= 0) {
    throw new AppError('VALIDATION_ERROR', { details: { fields: ['cursor'] } });
  }
  const instant = CURSOR_INSTANT_PATTERN.exec(decoded.slice(0, separatorIndex));
  const id = uuidSchema.safeParse(decoded.slice(separatorIndex + 1));
  if (instant === null || !isRealInstant(instant) || !id.success) {
    // Un curseur illisible est une entrée invalide, jamais une page vide : répondre « plus
    // rien à traiter » à un administrateur dont le curseur a été tronqué lui ferait croire
    // que la file est épuisée.
    throw new AppError('VALIDATION_ERROR', { details: { fields: ['cursor'] } });
  }
  // Le texte est réinjecté TEL QUEL dans la requête : le retranscrire, même à l'identique en
  // apparence, réintroduirait une conversion, donc une occasion de perdre la fraction.
  return { createdAt: instant[0], id: id.data };
}

/**
 * Fonction d'administrateur plateforme de l'appelant.
 *
 * Exposée pour que l'ÉCRAN d'administration puisse être refusé en entier, et pas seulement sa
 * file : `docs/screens.md` l'exige — « masquer la file en laissant l'écran ouvert poserait la
 * question de ce que l'appelant peut encore y faire ». Ce n'est PAS le contrôle d'accès :
 * celui-ci est refait par la commande ci-dessous, dans la transaction qui lit. Une page qui
 * n'appellerait pas cette fonction n'ouvrirait donc aucune donnée.
 */
export async function isPlatformAdministrator(actorUserId: string): Promise<boolean> {
  return hasPlatformAdminRole(getExecutor(), actorUserId);
}

async function assertPlatformAdministrator(
  executor: SqlExecutor,
  actorUserId: string,
): Promise<void> {
  if (!(await hasPlatformAdminRole(executor, actorUserId))) {
    throw new AppError('FORBIDDEN');
  }
}

/**
 * Trace d'une consultation SERVIE de la file d'administration.
 *
 * POURQUOI ELLE EXISTE. `docs/permissions.md` pose la « journalisation des consultations
 * sensibles » parmi ses principes, et range les « journaux de consultation » parmi les données
 * sensibles. La file est la consultation la plus sensible du lot : elle est le seul écran qui
 * rende des données d'organisations dont l'appelant n'est PAS membre, et elle agrège le NOM
 * des demandeurs de toutes les organisations en attente. Sans cette ligne, personne ne peut
 * dire qui a ouvert cette liste, ni combien de fois — c'est-à-dire ni instruire un soupçon, ni
 * en écarter un.
 *
 * CE QU'ELLE PORTE, ET RIEN D'AUTRE (`docs/observability.md`, section « Logs ») : le module,
 * l'acteur PSEUDONYMISÉ, le volume servi et la profondeur de file. AUCUNE COORDONNÉE, et pas
 * davantage de donnée d'organisation : ni nom, ni numéro d'immatriculation sous aucune
 * graphie, ni code territorial, ni identifiant d'organisation, ni nom de demandeur. La liste
 * d'exclusion de `docs/observability.md` est explicite sur les trois premiers, et un journal
 * qui recopierait la file rouvrirait côté exploitation exactement ce que l'écran réserve à
 * `PLATFORM_ADMIN`. Le journal dit QUI a regardé et COMBIEN il a vu, jamais QUOI.
 *
 * L'ACTEUR EST PSEUDONYMISÉ SUR PLACE. `buildRequestBindings` sait poser `userId` depuis le
 * contexte de requête, mais `userIdHash` n'y est renseigné nulle part aujourd'hui : s'y fier
 * produirait une ligne sans acteur, donc une trace qui ne répond pas à la question qu'elle
 * pose. `pseudonymizeUserId` est appliqué ici, à la source, ce qui rend la ligne exacte quel
 * que soit l'état de ce chantier voisin.
 *
 * `info` ET NON `warn`. Une consultation servie est un fait NOMINAL. `docs/observability.md`
 * réserve `warn` aux refus et fonde sur eux la métrique « refus d'autorisation » et l'alerte
 * « hausse d'accès refusés » : y verser un événement normal, émis à chaque ouverture d'écran
 * et à chaque page suivante, fausserait l'alerte au lieu de l'outiller. CONTREPARTIE ASSUMÉE,
 * à ne pas se cacher : un déploiement réglé sur `warn` perd cette trace. La trace DURABLE, qui
 * ne dépend d'aucun réglage, est une ligne d'`audit_logs` ; elle suppose d'ouvrir le
 * vocabulaire fermé de `src/infrastructure/audit/audit-log.ts` à une action de consultation,
 * ce qui déborde de cette correction et reste à faire.
 *
 * SEULES LES CONSULTATIONS SERVIES SONT TRACÉES. Un refus n'est pas une consultation, et il a
 * déjà sa ligne : `logOutcome` écrit un `warn` pour tout 4xx. Doubler le refus ici mêlerait
 * deux populations dans un même message.
 */
function traceQueueConsultation(input: {
  readonly actorUserId: string;
  readonly servedCount: number;
  readonly totalCount: number;
  readonly paginated: boolean;
}): void {
  getRequestLogger().info(
    {
      module: 'organizations',
      userId: pseudonymizeUserId(input.actorUserId),
      servedCount: input.servedCount,
      totalCount: input.totalCount,
      // Distingue l'ouverture de l'écran du déroulement de la file : dix pages lues d'affilée
      // ne se lisent pas comme dix ouvertures. Le curseur lui-même n'est PAS journalisé — il
      // porte l'identifiant d'une organisation tierce.
      paginated: input.paginated,
    },
    'consultation de la file des organisations en attente',
  );
}

/**
 * Lit une page de la file.
 *
 * UNE TRANSACTION POUR TROIS LECTURES, et le coût est nul — aucune écriture, aucun verrou.
 * Elle sert à ce que la garde, le compte et la page voient le MÊME instantané : sans elle, le
 * compteur pourrait annoncer douze organisations à côté d'une liste qui en montre onze, et
 * l'administrateur chercherait la douzième.
 */
export async function listPendingOrganizations(
  input: ListPendingOrganizationsInput,
): Promise<ListPendingOrganizationsResult> {
  const after = decodeCursor(input.cursor);

  const result = await withTransaction(async (tx) => {
    await assertPlatformAdministrator(tx, input.actorUserId);

    // Une ligne de plus que la page : sa présence dit qu'il reste quelque chose après, sans
    // second comptage et sans promettre une page suivante qui serait vide.
    const rows = await listPendingOrganizationRows(tx, { after, limit: PAGE_SIZE + 1 });
    const totalCount = await countPendingOrganizations(tx);

    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const last = page.at(-1);

    return {
      items: page.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        registrationNumber: row.registration_number,
        territoryCode: row.territory_code,
        createdAt: row.created_at,
        requestedByDisplayName: row.requested_by_display_name,
      })),
      // LA POSITION VIENT DE LA BASE, PAS DE `created_at`. `last.created_at` est une `Date`,
      // donc tronquée à la milliseconde par le pilote ; `last.created_at_cursor` est la même
      // position rendue en texte par PostgreSQL, microsecondes comprises. Reconstruire le
      // curseur depuis la première rouvrirait le doublon de frontière de page.
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor({ createdAt: last.created_at_cursor, id: last.id })
          : null,
      totalCount,
    };
  });

  // APRÈS la transaction, et non dedans : la trace dit une consultation SERVIE. Écrite à
  // l'intérieur, elle affirmerait une consultation qu'une validation en échec — connexion
  // perdue au `COMMIT` — n'aurait jamais rendue. Une ligne de journal n'a de toute façon
  // aucune portée transactionnelle : elle part quoi qu'il advienne de la transaction.
  traceQueueConsultation({
    actorUserId: input.actorUserId,
    servedCount: result.items.length,
    totalCount: result.totalCount,
    paginated: after !== null,
  });

  return result;
}

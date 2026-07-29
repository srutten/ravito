/**
 * Lecture prudente des erreurs du pilote PostgreSQL.
 *
 * POURQUOI CE MODULE EXISTE. Une erreur `pg` porte, dans `detail`, la VALEUR qui a violé la
 * contrainte : « Key (registration_number_normalized)=(FICTIFORG0001) already exists. »
 * Laisser une telle erreur remonter jusqu'à l'enveloppe de route la donne à journaliser
 * telle quelle — `toErrorBody` journalise la cause réelle de toute exception non
 * identifiée — et le numéro d'immatriculation d'une organisation tierce se retrouverait
 * dans les journaux d'exploitation. `docs/observability.md` l'interdit, et l'énumération
 * des immatriculations par lecture des journaux serait un contournement exact de la
 * neutralité que la réponse d'erreur cherche à préserver.
 *
 * Une violation dont l'application sait tirer une réponse juste est RECONNUE ICI et
 * convertie en `AppError` au plus près de l'écriture, sans jamais attacher l'erreur
 * d'origine en `cause`.
 *
 * DEUX LIGNES DE DÉFENSE, ET ELLES NE SE REMPLACENT PAS. Ce module est la première, mais il
 * ne couvre que ce qu'il a prévu. La seconde est `src/observability/logger.ts`, qui n'accepte
 * d'une erreur du pilote que des champs de diagnostic explicitement autorisés — `detail`,
 * `where`, `internalQuery`, `hint` et tout champ inconnu sont écartés avant écriture. C'est
 * elle qui tient pour les SQLSTATE que personne n'a prévus, sur toutes les tables, y compris
 * celles qu'une migration ajoutera. Compter sur la seule reconnaissance nominative ci-dessous
 * reviendrait à parier qu'aucune erreur imprévue n'atteindra jamais un journal.
 *
 * Le typage est structurel et n'utilise aucun `any` : les champs sont lus un par un et
 * vérifiés, ce qui reste vrai même si le pilote change de forme.
 */

/** Violation d'unicité (`unique_violation`). */
export const UNIQUE_VIOLATION = '23505';

/**
 * Violation d'une contrainte `CHECK` (`check_violation`).
 *
 * DÉLIBÉRÉMENT NON CONVERTIE EN REFUS DE SAISIE, et ce n'est pas un chantier inachevé.
 *
 * 1. UN `23514` QUI ARRIVE ICI N'EST PAS UNE FAUTE DE L'APPELANT, c'est un écart entre
 *    `src/domain/organizations/validation.ts` et les contraintes de
 *    `0015_organizations.sql` — donc un défaut du serveur. Le convertir en `400` accuserait
 *    l'appelant d'une faute qui n'est pas la sienne, et surtout absorberait l'écart en
 *    silence : plus de 5xx, donc plus rien dans le « taux d'erreur » de
 *    `docs/observability.md` pour signaler que les deux bords ont divergé. Le `500` est
 *    bruyant, et c'est sa raison d'être.
 * 2. CONVERTIR EXIGERAIT UNE TABLE nom de contrainte vers nom de champ. Toute contrainte
 *    posée par une migration ultérieure et absente de cette table dégénérerait en un `400`
 *    désignant le mauvais champ : un refus qui ment est pire qu'une erreur interne qui
 *    avoue.
 * 3. CE QUI RENDAIT LA CONVERSION URGENTE ÉTAIT LA FUITE, pas le code de statut : le champ
 *    `detail` d'un `23514` porte « Failing row contains (...) », donc la ligne entière. Cette
 *    fuite est désormais fermée à la source, pour tout SQLSTATE et toute table, par
 *    l'épuration du journaliseur ; et le chemin qui la rendait atteignable — un nom d'une
 *    seule lettre hors du plan multilingue de base, accepté par Zod qui compte en unités
 *    UTF-16 et refusé par `char_length` qui compte des caractères — est fermé par la
 *    validation, qui compte désormais dans la même unité que la base.
 *
 * La constante reste exportée : elle nomme la classe d'erreur que ces deux défenses visent,
 * et le jour où un `CHECK` deviendra une décision métier légitime — une transition d'état
 * refusée par le schéma, par exemple — c'est ici que sa reconnaissance devra être écrite.
 */
export const CHECK_VIOLATION = '23514';

function readStringField(error: unknown, field: string): string | undefined {
  if (typeof error !== 'object' || error === null || !(field in error)) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

/** Code SQLSTATE de l'erreur, ou `undefined` si l'exception n'en porte pas. */
export function readSqlState(error: unknown): string | undefined {
  return readStringField(error, 'code');
}

/**
 * Nom de la contrainte ou de l'index en cause.
 *
 * Sûr à journaliser : c'est un identifiant du schéma, présent en clair dans le dépôt, et
 * il ne dépend d'aucune donnée saisie. C'est la seule information de l'erreur d'origine
 * que ce module laisse ressortir.
 */
export function readConstraintName(error: unknown): string | undefined {
  return readStringField(error, 'constraint');
}

/** Vrai lorsque l'erreur est la violation de l'index unique désigné. */
export function isUniqueViolationOn(error: unknown, constraint: string): boolean {
  return readSqlState(error) === UNIQUE_VIOLATION && readConstraintName(error) === constraint;
}

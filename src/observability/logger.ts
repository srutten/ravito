import type { DestinationStream, LogFn, Logger, LoggerOptions } from 'pino';
import pino from 'pino';
import type { LogLevel } from '@/config/env';
import { getServerConfig } from '@/config/env';
import type { RequestContext } from '@/observability/request-context';
import { getRequestContext } from '@/observability/request-context';

/** Champs libres joints à une ligne de journal. */
export type LogFields = Record<string, unknown>;

const SERVICE_NAME = 'fire-support-platform';
const FALLBACK_LOG_LEVEL: LogLevel = 'info';
const FALLBACK_ENVIRONMENT = 'unknown';
const REDACTED = '[REDACTED]';
/** Profondeur maximale explorée par la rédaction récursive, garde-fou anti-structure pathologique. */
const MAX_REDACTION_DEPTH = 12;

/**
 * Liste d'exclusion des journaux (docs/observability.md, critère 11 de US-001).
 *
 * Les clés sont normalisées avant comparaison : casse ignorée, tirets et soulignés retirés.
 * `set-cookie`, `setCookie` et `SET_COOKIE` désignent donc la même clé.
 */
const SENSITIVE_KEYS = [
  // Authentification et secrets.
  'password',
  'motDePasse',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'sessionToken',
  'authorization',
  'cookie',
  'setCookie',
  'secret',
  'authSecret',
  'apiKey',
  'emailProviderKey',
  'smsProviderKey',
  'storageAccessKey',
  'storageSecretKey',
  'databaseUrl',
  'connectionString',
  // Positions protégées.
  'preciseLocation',
  'preciseLocationEncrypted',
  'exactLocation',
  // Coordonnées personnelles.
  'phone',
  'phoneNumber',
  'contactPhone',
  // Documents et contenus sensibles.
  'document',
  'documents',
  'storageKey',
  'incidentDescription',
  // Immatriculation d'organisation. Aucune ligne de journal ne la porte aujourd'hui : le refus
  // de doublon ne journalise que le nom de l'index. L'entrée est une ceinture, pour qu'un champ
  // ajouté demain ne la fasse pas fuiter. Le numéro identifie une structure dans un registre
  // public ; dans un journal d'exploitation, il permettrait de recouper qui s'est enregistré,
  // ce que l'API refuse précisément de confirmer (`docs/api-contract.md`, neutralité du doublon).
  'registrationNumber',
] as const;

/**
 * Chemins confiés à la rédaction native de pino. Elle couvre les cas courants avant même la
 * sérialisation ; la rédaction récursive ci-dessous prend le relais en profondeur arbitraire.
 */
const REDACTED_PATHS: string[] = [
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((key) => `*.${key}`),
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll('-', '').replaceAll('_', '');
}

/** Formes normalisées de la liste d'exclusion, comparées à la volée aux clés journalisées. */
const SENSITIVE_KEY_SET = new Set<string>(SENSITIVE_KEYS.map(normalizeKey));

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_SET.has(normalizeKey(key));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * ÉPURATION DES ERREURS DU PILOTE POSTGRESQL.
 *
 * POURQUOI CE TRAITEMENT EXISTE. Une erreur `pg` porte ses diagnostics dans des champs
 * propres ÉNUMÉRABLES, que tout sérialiseur recopie tels quels. Or `detail` vaut, sur une
 * violation de contrainte à l'écriture, « Failing row contains (uuid, nom, TYPE, numéro
 * brut, numéro normalisé, ...) » : la LIGNE ENTIÈRE part au niveau `error` dès qu'un
 * SQLSTATE n'est pas reconnu au plus près de l'écriture. La rédaction par nom de clé de ce
 * module ne peut rien contre cela — la fuite n'est pas dans le NOM d'un champ, elle est
 * dans le CONTENU d'une chaîne libre — et le numéro d'immatriculation, que `docs/security.md`
 * et la règle de journalisation d'US-012 interdisent d'écrire, y figure en clair.
 *
 * LISTE D'AUTORISATION, JAMAIS LISTE D'EXCLUSION. Nommer `detail`, `where`, `internalQuery`
 * et `hint` fermerait les quatre fuites connues et laisserait passer le champ que la
 * prochaine version du pilote ajoutera, ou celui qu'un pooler place devant. Ici, tout champ
 * non listé est écarté par défaut : le pire qu'une évolution du pilote puisse produire est
 * une ligne de journal plus pauvre, jamais une fuite. La règle vaut pour tout SQLSTATE et
 * pour toutes les tables, y compris celles qu'une migration ajoutera.
 */
const POSTGRES_DIAGNOSTIC_FIELDS = [
  // SQLSTATE et gravité : de quoi classer la panne sans rien savoir de la ligne.
  'code',
  'severity',
  // Identifiants du SCHÉMA. Ils sont en clair dans le dépôt, ne dépendent d'aucune saisie,
  // et c'est par eux qu'on retrouve la contrainte violée.
  'schema',
  'table',
  'column',
  'dataType',
  'constraint',
  // Emplacement dans le code source de PostgreSQL, utile pour les erreurs sans contrainte.
  'file',
  'line',
  'routine',
] as const;

/**
 * CE QUI NE FIGURE PAS DANS LA LISTE CI-DESSUS, pour mémoire seulement — ce sont bien son
 * omission, et non cette énumération, qui les écartent : `detail`, `where`, `hint`,
 * `internalQuery`, `query`, `parameters`, `position`, `internalPosition`, `message` et
 * `stack`. Les quatre premiers portent des valeurs de ligne ; `position` ne dit rien sans le
 * texte de la requête ; `message` est du texte libre du serveur, qui recopie la valeur reçue
 * pour toute une famille d'erreurs (« invalid input syntax for type uuid: "..." »), et la
 * première ligne de `stack` est ce message.
 *
 * Un message FIXE le remplace, pour qu'un exploitant sache que la ligne a été épurée plutôt
 * que de chercher un champ absent. Il est constant : aucune chaîne venue du serveur n'entre
 * dans sa composition, même par interpolation.
 */
const POSTGRES_ERROR_TYPE = 'PostgresError';
const POSTGRES_ERROR_MESSAGE =
  'erreur du pilote PostgreSQL : diagnostics conservés, champs porteurs de valeurs écartés';

/** Forme d'un SQLSTATE : cinq caractères alphanumériques (PostgreSQL, annexe A). */
const SQLSTATE_PATTERN = /^[0-9A-Za-z]{5}$/;

/**
 * Vocabulaire de gravité de PostgreSQL : ce que le moteur place dans le champ `S` d'une
 * réponse d'erreur ou d'avis, et que `pg-protocol` recopie tel quel dans `severity`.
 *
 * Le champ est LOCALISÉ par le serveur — sur une installation francophone, `severity` vaut
 * « ERREUR ». Cet ensemble ne peut donc pas être l'unique critère supplémentaire, sous peine
 * de laisser passer sans épuration l'erreur d'un serveur qui ne parle pas anglais.
 */
const POSTGRES_SEVERITIES = new Set<string>([
  'ERROR',
  'FATAL',
  'PANIC',
  'WARNING',
  'NOTICE',
  'DEBUG',
  'INFO',
  'LOG',
]);

/**
 * Champs que SEUL le protocole du moteur renseigne (`pg-protocol`, `parseErrorMessage` :
 * champs `R`, `F`, `d`, `n`, `s`). Ils nomment le code source de PostgreSQL ou le schéma de
 * la base ; aucune entité du domaine n'en porte. Leur présence suffit donc à trancher quand
 * la gravité, localisée, n'est pas reconnaissable.
 *
 * Tous figurent dans la liste d'autorisation ci-dessus, et c'est une condition : le
 * discriminant doit survivre à l'épuration, faute de quoi repasser sur un objet déjà épuré ne
 * le reconnaîtrait plus. `internalQuery` et `where` seraient d'aussi bons indices, mais ils
 * sont écartés par l'épuration — les retenir ici casserait cette idempotence.
 */
const POSTGRES_ONLY_FIELDS = ['routine', 'file', 'dataType', 'constraint', 'schema'] as const;

function readStringProperty(value: object, field: string): string | undefined {
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'string' ? candidate : undefined;
}

function hasPostgresOnlyField(value: object): boolean {
  return POSTGRES_ONLY_FIELDS.some((field) => readStringProperty(value, field) !== undefined);
}

/**
 * Rend la forme épurée d'une erreur du pilote, ou `undefined` si la valeur n'en est pas une.
 *
 * LA RECONNAISSANCE NE DÉPEND PAS DE LA CLASSE `DatabaseError` : l'importer ici ferait
 * dépendre le journal du pilote, et une erreur relayée par un pooler ou recopiée dans un
 * objet simple échapperait au filet.
 *
 * ELLE NE PEUT PAS POUR AUTANT SE CONTENTER D'UN SQLSTATE ET D'UNE GRAVITÉ. Le modèle du
 * domaine porte `Incident.severity` (`docs/domain-model.md`) et `docs/api-contract.md` en
 * donne un exemple : `{ code: 'FEU01', severity: 'HIGH' }` a exactement cette forme. Le
 * remplacer par un objet qui AFFIRME être une erreur du pilote ne rendrait pas la ligne plus
 * pauvre, il la rendrait FAUSSE — un exploitant lirait une panne de base là où un incident a
 * été journalisé. Un troisième critère est donc exigé, dans un sens OU dans l'autre :
 *
 * - une gravité prise dans le vocabulaire du moteur, qui couvre le cas courant ;
 * - ou un champ que seul le protocole produit, qui couvre le serveur localisé comme l'erreur
 *   recopiée par un intermédiaire.
 *
 * L'alternative est délibérée : exiger les deux rejetterait l'erreur d'un serveur francophone
 * dépourvue de `routine`, et la rejeter publierait une ligne de la base. Le coût des deux
 * méprises reste asymétrique — un faux négatif publie des données, un faux positif falsifie
 * une ligne — mais aucune n'est acceptable, et c'est bien un critère de plus, non un
 * assouplissement, qui les sépare.
 */
function sanitizePostgresError(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const code = readStringProperty(value, 'code');
  if (code === undefined || !SQLSTATE_PATTERN.test(code)) {
    return undefined;
  }
  const severity = readStringProperty(value, 'severity');
  if (severity === undefined) {
    return undefined;
  }
  if (!POSTGRES_SEVERITIES.has(severity) && !hasPostgresOnlyField(value)) {
    return undefined;
  }
  // Reconstruit champ par champ depuis une liste fermée : aucune chaîne libre de l'erreur
  // d'origine ne traverse, et l'opération est idempotente — repasser sur son propre résultat
  // rend le même objet, ce dont dépend l'enchaînement rédaction puis sérialisation.
  const purged: Record<string, string> = {
    type: POSTGRES_ERROR_TYPE,
    message: POSTGRES_ERROR_MESSAGE,
  };
  for (const field of POSTGRES_DIAGNOSTIC_FIELDS) {
    const kept = readStringProperty(value, field);
    if (kept !== undefined) {
      purged[field] = kept;
    }
  }
  return purged;
}

/**
 * Rédaction récursive appliquée à tout objet journalisé, quelle que soit la profondeur du champ
 * sensible. Les instances d'`Error` sont laissées au sérialiseur dédié, lui-même rédigé.
 */
function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_REDACTION_DEPTH) {
    return '[TRUNCATED]';
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  // Avant tout autre traitement, et à toute profondeur : une erreur du pilote atteint aussi
  // le journal sous une clé quelconque, où aucun sérialiseur d'erreur ne la verrait passer.
  const postgres = sanitizePostgresError(value);
  if (postgres !== undefined) {
    return postgres;
  }
  if (value instanceof Error || value instanceof Date) {
    return value;
  }
  if (seen.has(value)) {
    return '[CIRCULAR]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }
  if (!isPlainRecord(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, depth + 1, seen);
  }
  return result;
}

function redactLogObject(object: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactValue(object, 0, new WeakSet<object>());
  return isPlainRecord(redacted) ? redacted : object;
}

/** Profondeur maximale explorée dans une chaîne de causes ou d'erreurs agrégées. */
const MAX_ERROR_CHAIN_DEPTH = 8;

/** Clés par lesquelles une exception en imbrique une autre, et que pino fond en texte. */
const NESTED_ERROR_KEYS = ['cause', 'errors'] as const;

/**
 * Copie de surface d'une exception, privée de ses erreurs imbriquées.
 *
 * POURQUOI UNE COPIE. `pino.stdSerializers.err` ne se contente pas de recopier les champs
 * propres : il APLATIT la chaîne de causes en TEXTE, dans `message` (« a: b: c ») et dans
 * `stack` (« ... caused by: ... »), puis il écarte la clé `cause` de la recopie structurée
 * (`pino-std-serializers/lib/err.js`). Une erreur du pilote posée en `cause` — la façon
 * standard d'en imbriquer une — n'atteint donc jamais la rédaction récursive : quand celle-ci
 * regarde le résultat, la ligne du serveur est déjà fondue dans deux chaînes libres. Le même
 * aplatissement s'applique aux membres d'une `AggregateError`.
 *
 * La copie laisse l'exception d'origine INTACTE : elle continue de circuler dans le code
 * appelant, et un second journaliseur la verra entière.
 *
 * `enumerable: false` plutôt qu'un `delete` : la propriété propre masque aussi celle qu'un
 * prototype porterait, et elle reste invisible de la boucle de recopie du sérialiseur.
 *
 * `stack` est REPORTÉ EN VALEUR, et ce n'est pas un détail : V8 l'expose par un accesseur lié
 * à l'objet qui le porte. Recopier son descripteur sur une autre instance rend un accesseur
 * qui ne trouve plus sa pile et répond `undefined` ; la copie perdrait alors la pile de
 * l'exception, c'est-à-dire l'essentiel du diagnostic.
 */
function detachNestedErrors(error: Error): Error {
  const bare: Error = Object.create(
    Object.getPrototypeOf(error) as object | null,
    Object.getOwnPropertyDescriptors(error),
  );
  Object.defineProperty(bare, 'stack', {
    value: error.stack,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  for (const key of NESTED_ERROR_KEYS) {
    Object.defineProperty(bare, key, {
      value: undefined,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
  return bare;
}

/**
 * Sérialise une exception et, séparément, chacune des exceptions qu'elle imbrique.
 *
 * C'est le MÉCANISME qui remplace la convention de
 * `src/infrastructure/organizations/postgres-errors.ts` (« sans jamais attacher l'erreur
 * d'origine en `cause` ») : la discipline d'un module n'engage que lui, et `AppError`
 * (`src/application/errors.ts`) accepte une cause que `auth-route.ts` lui passe déjà. Ici,
 * aucune valeur imbriquée n'est remise au sérialiseur de pino : chacune redescend dans cette
 * fonction, donc dans l'épuration, à toute profondeur et quelle que soit sa classe.
 *
 * `seen` interdit la boucle infinie d'une chaîne circulaire, `depth` celle d'une chaîne
 * pathologiquement longue.
 */
function serializeErrorTree(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  // L'épuration passe AVANT `pino.stdSerializers.err` : ce sérialiseur recopie les champs
  // propres de l'erreur, et une erreur du pilote les a tous énumérables.
  const postgres = sanitizePostgresError(value);
  if (postgres !== undefined) {
    return postgres;
  }
  // Une cause n'est pas forcément une `Error` : `pino-std-serializers` fond dans le texte
  // tout objet portant un `message` de type chaîne. La rédaction par nom de clé reprend donc
  // la main sur ces valeurs-là, au lieu de les laisser filer dans `message` et `stack`.
  if (!(value instanceof Error)) {
    return redactValue(value, 0, new WeakSet<object>());
  }
  if (depth > MAX_ERROR_CHAIN_DEPTH) {
    return '[TRUNCATED]';
  }
  if (seen.has(value)) {
    return '[CIRCULAR]';
  }
  seen.add(value);
  const nested = value as Error & { cause?: unknown; errors?: unknown };
  const serialized = redactValue(
    { ...pino.stdSerializers.err(detachNestedErrors(nested)) },
    0,
    new WeakSet<object>(),
  );
  const line: Record<string, unknown> = isPlainRecord(serialized) ? serialized : {};
  if (nested.cause !== undefined) {
    line.cause = serializeErrorTree(nested.cause, depth + 1, seen);
  }
  if (Array.isArray(nested.errors)) {
    // Même clé que pino pour une `AggregateError`, afin que l'exploitation ne change pas.
    line.aggregateErrors = nested.errors.map((item) => serializeErrorTree(item, depth + 1, seen));
  } else if (nested.errors !== undefined) {
    // `errors` n'est pas toujours une agrégation : détaché pour la même raison, il est rendu
    // sous son nom d'origine plutôt que perdu.
    line.errors = serializeErrorTree(nested.errors, depth + 1, seen);
  }
  return line;
}

function serializeError(value: unknown): unknown {
  return serializeErrorTree(value, 0, new WeakSet<object>());
}

/**
 * Normalise les arguments d'un appel de journalisation AVANT que pino ne calcule le `msg` de
 * la ligne.
 *
 * LE CANAL QUE CE CROCHET FERME. `msg` est calculé dans `pino/lib/proto.js` (`write`), donc
 * avant les sérialiseurs ET avant les formateurs : un appel sans message explicite recopie le
 * `message` de l'erreur reçue, texte libre du serveur que l'en-tête de ce module désigne
 * lui-même comme dangereux (« invalid input syntax for type uuid: "..." » recopie la valeur
 * reçue). Ni `serializeError` ni `redactLogObject` ne voient jamais cette chaîne : elle est
 * déjà écrite à côté d'eux.
 *
 * Deux formes d'appel la produisent, et aucune autre : `log(erreur)` et `log({ err: erreur })`
 * sans message — le message manquant OU valant `undefined`. Aucun site d'appel de la
 * plateforme ne les emploie aujourd'hui — la fuite est une mine, pas un écoulement — mais rien
 * ne le gardait : un second argument oublié, ou une variable optionnelle, suffisait.
 *
 * Un message explicite, lui, n'est jamais remplacé : le crochet ne se déclenche que là où pino
 * s'apprêtait à en fabriquer un depuis l'erreur.
 */
function guardLogMethod(this: Logger, args: Parameters<LogFn>, method: LogFn): void {
  // Un second argument `undefined` n'est PAS un message : `quick-format-unescaped` le rend
  // tel quel, et pino retombe alors sur la dérivation depuis l'erreur. Vérifié.
  const hasExplicitMessage = args.length >= 2 && args[1] !== undefined;
  if (!hasExplicitMessage) {
    const [first] = args;
    if (sanitizePostgresError(first) !== undefined) {
      // `log(erreur)` : pino en ferait `{ err: erreur }` et prendrait son message.
      method.call(this, { err: first }, POSTGRES_ERROR_MESSAGE);
      return;
    }
    if (
      isPlainRecord(first) &&
      first.msg === undefined &&
      sanitizePostgresError(first.err) !== undefined
    ) {
      // `log({ err: erreur })` : pino prend le message de la valeur sous la clé d'erreur.
      method.call(this, first, POSTGRES_ERROR_MESSAGE);
      return;
    }
  }
  method.apply(this, args);
}

/**
 * Configuration lue sans jamais faire échouer l'import : le journal doit rester disponible pour
 * signaler qu'une configuration est invalide.
 */
function readLoggerDefaults(): { level: LogLevel; environment: string; version: string } {
  try {
    const config = getServerConfig();
    return {
      level: config.logLevel,
      environment: config.appEnvironment,
      version: config.appVersion,
    };
  } catch {
    return {
      level: FALLBACK_LOG_LEVEL,
      environment: process.env.APP_ENV ?? FALLBACK_ENVIRONMENT,
      version: process.env.APP_VERSION ?? FALLBACK_ENVIRONMENT,
    };
  }
}

function buildLoggerOptions(options?: {
  level?: LogLevel;
  environment?: string;
  version?: string;
}): LoggerOptions {
  const defaults = readLoggerDefaults();
  return {
    level: options?.level ?? defaults.level,
    base: {
      service: SERVICE_NAME,
      environment: options?.environment ?? defaults.environment,
      version: options?.version ?? defaults.version,
    },
    // Horodatage ISO 8601 UTC, cohérent avec le contrat API.
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      // Niveau lisible plutôt que numérique, pour une exploitation directe des journaux.
      level: (label) => ({ level: label }),
      log: redactLogObject,
    },
    serializers: {
      err: serializeError,
      error: serializeError,
    },
    // Les journaux enfants héritent du crochet (`pino/lib/levels.js`, `setLevelState`), donc
    // `getRequestLogger()` en bénéficie sans traitement particulier.
    hooks: { logMethod: guardLogMethod },
    redact: { paths: REDACTED_PATHS, censor: REDACTED },
  };
}

/**
 * Construit une instance de journal indépendante. Utile aux tâches hors requête, et aux tests
 * qui vérifient la rédaction en fournissant une destination mémoire plutôt que la sortie
 * standard.
 */
export function createLogger(options?: {
  level?: LogLevel;
  environment?: string;
  destination?: DestinationStream;
}): Logger {
  const loggerOptions = buildLoggerOptions(options);
  if (options?.destination !== undefined) {
    return pino(loggerOptions, options.destination);
  }
  return pino(loggerOptions);
}

/** Instance racine du processus. */
export const logger: Logger = createLogger();

const requestLoggers = new WeakMap<RequestContext, Logger>();

function buildRequestBindings(context: RequestContext): LogFields {
  return {
    requestId: context.requestId,
    route: context.route,
    method: context.method,
    // `userId` porte toujours la valeur pseudonymisée, jamais l'identifiant réel.
    ...(context.userIdHash !== undefined ? { userId: context.userIdHash } : {}),
    ...(context.organizationId !== undefined ? { organizationId: context.organizationId } : {}),
  };
}

/**
 * Journal enrichi du contexte de la requête courante. Hors requête, renvoie le journal racine
 * plutôt que de perdre la ligne.
 */
export function getRequestLogger(): Logger {
  const context = getRequestContext();
  if (context === undefined) {
    return logger;
  }
  const existing = requestLoggers.get(context);
  if (existing !== undefined) {
    return existing;
  }
  const child = logger.child(buildRequestBindings(context));
  requestLoggers.set(context, child);
  return child;
}

import type { DestinationStream, Logger, LoggerOptions } from 'pino';
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

function serializeError(value: unknown): unknown {
  if (!(value instanceof Error)) {
    return redactValue(value, 0, new WeakSet<object>());
  }
  const serialized = pino.stdSerializers.err(value);
  return redactValue({ ...serialized }, 0, new WeakSet<object>());
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

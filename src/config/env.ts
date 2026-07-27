/**
 * Configuration serveur validée au démarrage.
 *
 * Principes appliqués (docs/security.md, critères 8 et 15 de US-001) :
 * - une configuration invalide empêche le démarrage, elle n'est jamais corrigée silencieusement ;
 * - le message d'erreur nomme la variable fautive et la correction attendue ;
 * - le message ne contient jamais la valeur lue, afin de ne pas recopier un secret dans un
 *   journal, une trace de build ou une capture d'écran.
 */

export type AppEnvironment = 'local' | 'staging' | 'production';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface StorageConfig {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
}

export interface ServerConfig {
  readonly appEnvironment: AppEnvironment;
  readonly appVersion: string;
  readonly logLevel: LogLevel;
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly databaseStatementTimeoutMs: number;
  readonly databaseSsl: boolean;
  readonly featureFlagsSource: 'env';
  readonly authSecret?: string;
  readonly mapStyleUrl?: string;
  readonly observabilityDsn?: string;
  readonly storage?: StorageConfig;
}

/** Description d'une variable rejetée. Ne contient jamais la valeur lue. */
export interface ConfigurationProblem {
  readonly variable: string;
  readonly reason: string;
}

export class ConfigurationError extends Error {
  readonly invalidVariables: readonly string[];
  readonly problems: readonly ConfigurationProblem[];

  constructor(problems: readonly ConfigurationProblem[]) {
    super(formatConfigurationMessage(problems));
    this.name = 'ConfigurationError';
    this.problems = problems;
    this.invalidVariables = problems.map((problem) => problem.variable);
  }
}

const APP_ENVIRONMENTS: readonly AppEnvironment[] = ['local', 'staging', 'production'];

const LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

const STORAGE_VARIABLES = [
  'STORAGE_ENDPOINT',
  'STORAGE_BUCKET',
  'STORAGE_ACCESS_KEY',
  'STORAGE_SECRET_KEY',
] as const;

const DEFAULT_APP_VERSION = '0.0.0-dev';
const DEFAULT_DATABASE_POOL_MAX = 10;
const MAX_DATABASE_POOL_MAX = 100;
const DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS = 10_000;
const MIN_DATABASE_STATEMENT_TIMEOUT_MS = 100;
const MAX_DATABASE_STATEMENT_TIMEOUT_MS = 300_000;
const MIN_AUTH_SECRET_LENGTH = 32;
const POSTGRES_PROTOCOLS = ['postgres:', 'postgresql:'];
const TRUE_VALUES = ['true', '1', 'on', 'yes', 'require', 'enable'];
const FALSE_VALUES = ['false', '0', 'off', 'no', 'disable'];

function formatConfigurationMessage(problems: readonly ConfigurationProblem[]): string {
  const names = problems.map((problem) => problem.variable).join(', ');
  const details = problems.map((problem) => `- ${problem.variable} : ${problem.reason}`);
  return [
    `Configuration invalide, ${problems.length} variable(s) en cause : ${names}.`,
    ...details,
    "Corriger le fichier d'environnement puis relancer. Aucune valeur n'est reproduite ici.",
  ].join('\n');
}

/**
 * Une variable vide est traitée comme absente : `.env.example` déclare les variables des lots
 * suivants sans valeur, et une chaîne vide n'est jamais une configuration utilisable.
 */
function readOptional(
  source: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const raw = source[name];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readBoolean(value: string): boolean | undefined {
  const normalized = value.toLowerCase();
  if (TRUE_VALUES.includes(normalized)) {
    return true;
  }
  if (FALSE_VALUES.includes(normalized)) {
    return false;
  }
  return undefined;
}

function readInteger(value: string): number | undefined {
  if (!/^-?\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Renvoie `undefined` si `APP_ENV` est absente ou non reconnue. Les vérifications qui dépendent
 * de l'environnement sont alors suspendues : une seule cause produit un seul message.
 */
function parseAppEnvironment(
  source: Record<string, string | undefined>,
  problems: ConfigurationProblem[],
): AppEnvironment | undefined {
  const raw = readOptional(source, 'APP_ENV');
  if (raw === undefined) {
    problems.push({
      variable: 'APP_ENV',
      reason: `variable obligatoire absente ou vide, valeurs attendues : ${APP_ENVIRONMENTS.join(', ')}`,
    });
    return undefined;
  }
  const found = APP_ENVIRONMENTS.find((candidate) => candidate === raw.toLowerCase());
  if (found === undefined) {
    problems.push({
      variable: 'APP_ENV',
      reason: `valeur non reconnue, valeurs attendues : ${APP_ENVIRONMENTS.join(', ')}`,
    });
    return undefined;
  }
  return found;
}

function parseLogLevel(
  source: Record<string, string | undefined>,
  appEnvironment: AppEnvironment,
  problems: ConfigurationProblem[],
): LogLevel {
  const fallback: LogLevel = appEnvironment === 'local' ? 'debug' : 'info';
  const raw = readOptional(source, 'LOG_LEVEL');
  if (raw === undefined) {
    return fallback;
  }
  const found = LOG_LEVELS.find((candidate) => candidate === raw.toLowerCase());
  if (found === undefined) {
    problems.push({
      variable: 'LOG_LEVEL',
      reason: `valeur non reconnue, valeurs attendues : ${LOG_LEVELS.join(', ')}`,
    });
    return fallback;
  }
  return found;
}

function parseDatabaseUrl(
  source: Record<string, string | undefined>,
  problems: ConfigurationProblem[],
): string {
  const raw = readOptional(source, 'DATABASE_URL');
  if (raw === undefined) {
    problems.push({
      variable: 'DATABASE_URL',
      reason:
        'variable obligatoire absente ou vide, chaîne de connexion PostgreSQL attendue sous la forme postgresql://utilisateur:motdepasse@hote:port/base',
    });
    return '';
  }
  let protocol: string;
  try {
    protocol = new URL(raw).protocol;
  } catch {
    problems.push({
      variable: 'DATABASE_URL',
      reason: 'chaîne de connexion illisible, une URL absolue est attendue',
    });
    return '';
  }
  if (!POSTGRES_PROTOCOLS.includes(protocol)) {
    problems.push({
      variable: 'DATABASE_URL',
      reason: `protocole non pris en charge, ${POSTGRES_PROTOCOLS.join(' ou ')} attendu`,
    });
    return '';
  }
  return raw;
}

function parseBoundedInteger(
  source: Record<string, string | undefined>,
  variable: string,
  bounds: { readonly fallback: number; readonly min: number; readonly max: number },
  problems: ConfigurationProblem[],
): number {
  const raw = readOptional(source, variable);
  if (raw === undefined) {
    return bounds.fallback;
  }
  const parsed = readInteger(raw);
  if (parsed === undefined) {
    problems.push({ variable, reason: 'nombre entier attendu' });
    return bounds.fallback;
  }
  if (parsed < bounds.min || parsed > bounds.max) {
    problems.push({
      variable,
      reason: `valeur hors bornes, entier attendu entre ${bounds.min} et ${bounds.max}`,
    });
    return bounds.fallback;
  }
  return parsed;
}

function parseDatabaseSsl(
  source: Record<string, string | undefined>,
  appEnvironment: AppEnvironment,
  problems: ConfigurationProblem[],
): boolean {
  // TLS exigé hors poste local (docs/security.md, protection des données).
  const fallback = appEnvironment !== 'local';
  const raw = readOptional(source, 'DATABASE_SSL');
  if (raw === undefined) {
    return fallback;
  }
  const parsed = readBoolean(raw);
  if (parsed === undefined) {
    problems.push({
      variable: 'DATABASE_SSL',
      reason: 'valeur non reconnue, valeurs attendues : require, disable, true, false',
    });
    return fallback;
  }
  return parsed;
}

function parseFeatureFlagsSource(
  source: Record<string, string | undefined>,
  problems: ConfigurationProblem[],
): 'env' {
  const raw = readOptional(source, 'FEATURE_FLAGS_SOURCE');
  if (raw !== undefined && raw.toLowerCase() !== 'env') {
    problems.push({
      variable: 'FEATURE_FLAGS_SOURCE',
      reason: "valeur non reconnue, seule la source 'env' est prise en charge au lot 0",
    });
  }
  return 'env';
}

function parseAuthSecret(
  source: Record<string, string | undefined>,
  appEnvironment: AppEnvironment | undefined,
  problems: ConfigurationProblem[],
): string | undefined {
  const raw = readOptional(source, 'AUTH_SECRET');
  if (raw === undefined) {
    // Facultatif au lot 0 en local, obligatoire dès que l'environnement est déployé.
    if (appEnvironment === 'staging' || appEnvironment === 'production') {
      problems.push({
        variable: 'AUTH_SECRET',
        reason: `variable obligatoire absente ou vide en environnement ${appEnvironment}, secret d'au moins ${MIN_AUTH_SECRET_LENGTH} caractères attendu depuis le gestionnaire de secrets`,
      });
    }
    return undefined;
  }
  if (raw.length < MIN_AUTH_SECRET_LENGTH) {
    problems.push({
      variable: 'AUTH_SECRET',
      reason: `longueur insuffisante, ${MIN_AUTH_SECRET_LENGTH} caractères minimum attendus`,
    });
    return undefined;
  }
  return raw;
}

function parseAbsoluteUrl(
  source: Record<string, string | undefined>,
  variable: string,
  problems: ConfigurationProblem[],
): string | undefined {
  const raw = readOptional(source, variable);
  if (raw === undefined) {
    return undefined;
  }
  try {
    new URL(raw);
  } catch {
    problems.push({ variable, reason: 'URL absolue attendue' });
    return undefined;
  }
  return raw;
}

function parseStorage(
  source: Record<string, string | undefined>,
  problems: ConfigurationProblem[],
): StorageConfig | undefined {
  const values = STORAGE_VARIABLES.map((variable) => readOptional(source, variable));
  const provided = values.filter((value) => value !== undefined);
  if (provided.length === 0) {
    return undefined;
  }
  if (provided.length !== STORAGE_VARIABLES.length) {
    const missing = STORAGE_VARIABLES.filter((_, index) => values[index] === undefined);
    for (const variable of missing) {
      problems.push({
        variable,
        reason: `configuration de stockage incomplète, les quatre variables ${STORAGE_VARIABLES.join(', ')} vont ensemble`,
      });
    }
    return undefined;
  }
  const [endpoint, bucket, accessKey, secretKey] = values;
  if (
    endpoint === undefined ||
    bucket === undefined ||
    accessKey === undefined ||
    secretKey === undefined
  ) {
    return undefined;
  }
  try {
    new URL(endpoint);
  } catch {
    problems.push({ variable: 'STORAGE_ENDPOINT', reason: 'URL absolue attendue' });
    return undefined;
  }
  return { endpoint, bucket, accessKey, secretKey };
}

/**
 * Construit la configuration à partir d'une source explicite. Toutes les anomalies sont
 * collectées avant d'échouer, afin qu'un opérateur corrige l'ensemble en une seule passe.
 */
export function parseServerConfig(source: Record<string, string | undefined>): ServerConfig {
  const problems: ConfigurationProblem[] = [];

  const declaredEnvironment = parseAppEnvironment(source, problems);
  // Repli le plus strict tant que l'environnement déclaré est douteux : moins de permissivité.
  const appEnvironment: AppEnvironment = declaredEnvironment ?? 'production';
  const appVersion = readOptional(source, 'APP_VERSION') ?? DEFAULT_APP_VERSION;
  const logLevel = parseLogLevel(source, appEnvironment, problems);
  const databaseUrl = parseDatabaseUrl(source, problems);
  const databasePoolMax = parseBoundedInteger(
    source,
    'DATABASE_POOL_MAX',
    { fallback: DEFAULT_DATABASE_POOL_MAX, min: 1, max: MAX_DATABASE_POOL_MAX },
    problems,
  );
  const databaseStatementTimeoutMs = parseBoundedInteger(
    source,
    'DATABASE_STATEMENT_TIMEOUT_MS',
    {
      fallback: DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS,
      min: MIN_DATABASE_STATEMENT_TIMEOUT_MS,
      max: MAX_DATABASE_STATEMENT_TIMEOUT_MS,
    },
    problems,
  );
  const databaseSsl = parseDatabaseSsl(source, appEnvironment, problems);
  const featureFlagsSource = parseFeatureFlagsSource(source, problems);
  const authSecret = parseAuthSecret(source, declaredEnvironment, problems);
  const mapStyleUrl = parseAbsoluteUrl(source, 'MAP_STYLE_URL', problems);
  const observabilityDsn = readOptional(source, 'OBSERVABILITY_DSN');
  const storage = parseStorage(source, problems);

  if (problems.length > 0) {
    throw new ConfigurationError(problems);
  }

  // `exactOptionalPropertyTypes` : une propriété facultative est omise, jamais mise à undefined.
  return {
    appEnvironment,
    appVersion,
    logLevel,
    databaseUrl,
    databasePoolMax,
    databaseStatementTimeoutMs,
    databaseSsl,
    featureFlagsSource,
    ...(authSecret !== undefined ? { authSecret } : {}),
    ...(mapStyleUrl !== undefined ? { mapStyleUrl } : {}),
    ...(observabilityDsn !== undefined ? { observabilityDsn } : {}),
    ...(storage !== undefined ? { storage } : {}),
  };
}

let cachedConfig: ServerConfig | undefined;

/**
 * Configuration mémoïsée du processus. Le premier appel valide `process.env` et lève
 * `ConfigurationError` si la configuration est inutilisable : c'est le refus de démarrer.
 */
export function getServerConfig(): ServerConfig {
  if (cachedConfig === undefined) {
    cachedConfig = parseServerConfig(process.env);
  }
  return cachedConfig;
}

/** Réservée aux tests : vide le cache pour rejouer une configuration différente. */
export function resetServerConfigCache(): void {
  cachedConfig = undefined;
}

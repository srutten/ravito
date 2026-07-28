/**
 * Journal des scripts de base de données.
 *
 * Pourquoi ne pas réutiliser `src/observability/logger.ts` : ce module résout ses dépendances par
 * l'alias `@/`, connu du bundler Next.js et de TypeScript, mais pas de l'exécution TypeScript
 * native de Node. Un `node scripts/db/migrate.ts` échouerait à l'import avec ERR_MODULE_NOT_FOUND.
 * Ce journal reprend donc la même intention — pino, sortie structurée, liste d'exclusion des
 * champs sensibles (docs/observability.md) — sans dépendre du graphe de modules applicatif.
 *
 * Séparation des flux, volontaire :
 * - le compte rendu destiné à l'opérateur est écrit sur la sortie standard par `writeLine` ;
 * - les journaux structurés partent sur la sortie d'erreur, afin que la sortie standard reste
 *   lisible et analysable par un pipeline.
 *
 * Aucun de ces deux flux ne reçoit jamais de chaîne de connexion, d'identifiant ni de mot de
 * passe : les messages sont construits à partir de noms de variables et de valeurs masquées.
 *
 * Convention d'import des scripts, même cause racine. Node résout lui-même les modules et exige
 * le chemin réel du fichier, extension comprise : les imports relatifs de `scripts/db` portent
 * donc le suffixe `.ts`. TypeScript le refuse tant que `allowImportingTsExtensions` n'est pas
 * activé dans `tsconfig.json`, fichier hors du périmètre de cette story ; chaque import relatif
 * porte donc un `@ts-expect-error` ciblé, placé juste avant le spécificateur pour survivre au
 * formatage de Biome. Les types restent entièrement vérifiés : seule la règle d'extension est
 * neutralisée. Le jour où `allowImportingTsExtensions` est activé, TypeScript signale ces
 * directives comme inutiles, ce qui en impose le retrait.
 */

import type { Logger } from 'pino';
import pino from 'pino';

const SERVICE_NAME = 'fire-support-db-scripts';
const REDACTED = '[REDACTED]';
const FALLBACK_LOG_LEVEL = 'info';
const FALLBACK_ENVIRONMENT = 'unknown';

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

type ScriptLogLevel = (typeof LOG_LEVELS)[number];

/**
 * Liste d'exclusion alignée sur `src/observability/logger.ts`, restreinte à ce que manipulent les
 * scripts de base de données. `url` et `connectionString` en font partie : une cible de connexion
 * n'est jamais journalisée telle quelle, seulement son étiquette ou sa forme masquée.
 */
const SENSITIVE_KEYS = [
  'password',
  'motDePasse',
  'databasePassword',
  'appPassword',
  'url',
  'databaseUrl',
  'migrationUrl',
  'connectionString',
  'dsn',
  'secret',
  'token',
  'apiKey',
  'authorization',
] as const;

const REDACTED_PATHS: string[] = [...SENSITIVE_KEYS, ...SENSITIVE_KEYS.map((key) => `*.${key}`)];

function readLogLevel(source: Record<string, string | undefined>): ScriptLogLevel {
  const raw = source.LOG_LEVEL;
  if (raw === undefined) {
    return FALLBACK_LOG_LEVEL;
  }
  const normalized = raw.trim().toLowerCase();
  const found = LOG_LEVELS.find((candidate) => candidate === normalized);
  return found ?? FALLBACK_LOG_LEVEL;
}

/**
 * Construit un journal indépendant. La destination est la sortie d'erreur, en écriture
 * synchrone : un script court doit avoir vidé ses tampons avant de rendre la main.
 */
export function createScriptLogger(
  source: Record<string, string | undefined> = process.env,
): Logger {
  return pino(
    {
      level: readLogLevel(source),
      base: {
        service: SERVICE_NAME,
        environment: source.APP_ENV?.trim() ?? FALLBACK_ENVIRONMENT,
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
      },
      redact: { paths: REDACTED_PATHS, censor: REDACTED },
    },
    pino.destination({ fd: 2, sync: true }),
  );
}

/** Instance partagée par les scripts de base de données. */
export const scriptLogger: Logger = createScriptLogger();

/**
 * Écrit une ligne de compte rendu sur la sortie standard. `console` est proscrit
 * (docs/coding-standards.md) ; un script de ligne de commande écrit directement sur son flux.
 */
export function writeLine(text = ''): void {
  process.stdout.write(`${text}\n`);
}

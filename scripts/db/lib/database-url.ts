/**
 * Résolution, masquage et ouverture de la cible de connexion des scripts de base de données.
 *
 * Règle non négociable (critère 15) : la chaîne de connexion, l'identifiant et le mot de passe
 * n'apparaissent jamais dans un message d'erreur, un journal ou une sortie de script. Deux
 * mécanismes s'en chargent ici :
 * - `redactUrl` ne restitue que le protocole, l'hôte et le port ;
 * - `redactEnvironmentSecrets` repasse sur tout texte destiné à l'affichage et y remplace les
 *   valeurs sensibles lues dans l'environnement, y compris quand elles proviennent d'un message
 *   produit par le pilote PostgreSQL.
 *
 * Les règles de validation reprennent celles de `src/config/env.ts` (protocole PostgreSQL, URL
 * absolue). Ce module ne peut pas importer ce fichier : l'alias `@/` n'est pas résolu par
 * l'exécution TypeScript native de Node.
 */

import type { Client, ClientConfig } from 'pg';
import pg from 'pg';
import { scriptLogger } from './script-logger.ts';

export interface DatabaseTarget {
  /** Chaîne de connexion complète. Ne doit jamais être affichée ni journalisée. */
  readonly url: string;
  /** Nom de la variable d'environnement qui a fourni la cible. Sûr à afficher. */
  readonly label: string;
}

export class DatabaseConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseConfigurationError';
  }
}

export class DatabaseConnectionError extends Error {
  constructor(message: string, options?: { readonly cause: unknown }) {
    super(message, options);
    this.name = 'DatabaseConnectionError';
  }
}

const MASK = '[masqué]';
const POSTGRES_PROTOCOLS = ['postgres:', 'postgresql:'];
const MIGRATION_URL_VARIABLE = 'DATABASE_MIGRATION_URL';
const APPLICATION_URL_VARIABLE = 'DATABASE_URL';
const APPLICATION_NAME = 'fire-support-db-scripts';
const CONNECTION_TIMEOUT_MS = 10_000;
/** En deçà, un remplacement à l'aveugle rendrait les messages illisibles sans rien protéger. */
const MIN_REDACTABLE_LENGTH = 3;

/** Variables dont la valeur ne doit jamais ressortir dans une sortie de script. */
const SECRET_VARIABLES = [
  APPLICATION_URL_VARIABLE,
  MIGRATION_URL_VARIABLE,
  'DATABASE_APP_PASSWORD',
] as const;

const TRUE_VALUES = ['true', '1', 'on', 'yes', 'require', 'enable'];
const FALSE_VALUES = ['false', '0', 'off', 'no', 'disable'];

/**
 * Forme affichable d'une cible : protocole, hôte et port, rien d'autre.
 *
 * Le mot de passe et l'identifiant sont remplacés par une constante, et le nom de la base est
 * retiré : sur un poste de développement, le rôle et la base portent couramment le même nom, si
 * bien qu'afficher la base reviendrait à afficher l'identifiant. Hôte et port suffisent à
 * distinguer une base locale d'une base partagée, ce qui est le seul besoin réel.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return MASK;
  }
  const port = parsed.port === '' ? '' : `:${parsed.port}`;
  const host = parsed.hostname === '' ? MASK : parsed.hostname;
  return `${parsed.protocol}//${MASK}@${host}${port}`;
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function collectSecretFragments(url: string, into: Set<string>): void {
  if (url.trim() === '') {
    return;
  }
  into.add(url);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  for (const raw of [parsed.password, parsed.username]) {
    if (raw === '') {
      continue;
    }
    into.add(raw);
    const decoded = safeDecode(raw);
    if (decoded !== undefined) {
      into.add(decoded);
    }
  }
  if (parsed.username !== '' && parsed.password !== '') {
    into.add(`${parsed.username}:${parsed.password}`);
  }
}

/**
 * Remplace dans `text` toute occurrence des fragments sensibles issus de `urls` : chaîne complète,
 * couple identifiant/mot de passe, mot de passe seul, identifiant seul. Les fragments les plus
 * longs sont traités d'abord pour que le masquage reste stable.
 */
export function redactSecrets(text: string, urls: readonly string[]): string {
  const fragments = new Set<string>();
  for (const url of urls) {
    collectSecretFragments(url, fragments);
  }
  const ordered = [...fragments]
    .filter((fragment) => fragment.length >= MIN_REDACTABLE_LENGTH)
    .sort((left, right) => right.length - left.length);
  let result = text;
  for (const fragment of ordered) {
    result = result.replaceAll(fragment, MASK);
  }
  return result;
}

/**
 * Masquage systématique appliqué avant tout affichage : les valeurs sensibles sont relues depuis
 * l'environnement, ce qui protège aussi les messages produits avant qu'une cible ait pu être
 * résolue, ou par une bibliothèque tierce.
 */
export function redactEnvironmentSecrets(
  text: string,
  env: Record<string, string | undefined>,
): string {
  const values: string[] = [];
  for (const variable of SECRET_VARIABLES) {
    const raw = env[variable];
    if (raw !== undefined && raw.trim() !== '') {
      values.push(raw.trim());
    }
  }
  return redactSecrets(text, values);
}

/** Message d'échec prêt à être affiché : jamais de trace d'appel, jamais de valeur sensible. */
export function describeFailure(error: unknown, env: Record<string, string | undefined>): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactEnvironmentSecrets(raw, env);
}

function readVariable(env: Record<string, string | undefined>, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

const EXPECTED_FORM = 'postgresql://utilisateur:motdepasse@hôte:port/base';
const NO_VALUE_NOTICE = "Aucune valeur n'est reproduite ici.";

function assertUsableUrl(value: string, variable: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DatabaseConfigurationError(
      `${variable} ne contient pas une URL exploitable. Forme attendue : ${EXPECTED_FORM}. ${NO_VALUE_NOTICE}`,
    );
  }
  if (!POSTGRES_PROTOCOLS.includes(parsed.protocol)) {
    throw new DatabaseConfigurationError(
      `${variable} n'utilise pas un protocole PostgreSQL. Protocoles acceptés : postgres:// ou postgresql://. ${NO_VALUE_NOTICE}`,
    );
  }
  if (parsed.hostname === '') {
    throw new DatabaseConfigurationError(
      `${variable} ne désigne aucun hôte. Forme attendue : ${EXPECTED_FORM}. ${NO_VALUE_NOTICE}`,
    );
  }
  if (parsed.pathname === '' || parsed.pathname === '/') {
    throw new DatabaseConfigurationError(
      `${variable} ne désigne aucune base de données. Forme attendue : ${EXPECTED_FORM}. ${NO_VALUE_NOTICE}`,
    );
  }
}

/**
 * Cible des opérations de schéma. `DATABASE_MIGRATION_URL` est privilégiée ; à défaut
 * `DATABASE_URL` est acceptée avec un avertissement, car hors poste local le compte de migration
 * et le compte applicatif doivent être distincts (docs/security.md, critère 17).
 */
export function resolveMigrationTarget(env: Record<string, string | undefined>): DatabaseTarget {
  const migration = readVariable(env, MIGRATION_URL_VARIABLE);
  if (migration !== undefined) {
    assertUsableUrl(migration, MIGRATION_URL_VARIABLE);
    return { url: migration, label: MIGRATION_URL_VARIABLE };
  }
  const application = readVariable(env, APPLICATION_URL_VARIABLE);
  if (application === undefined) {
    throw new DatabaseConfigurationError(
      `Aucune cible de migration : renseigner ${MIGRATION_URL_VARIABLE} (compte de migration, disposant des droits de schéma) ou, à défaut, ${APPLICATION_URL_VARIABLE} dans .env.local. Forme attendue : ${EXPECTED_FORM}. ${NO_VALUE_NOTICE}`,
    );
  }
  assertUsableUrl(application, APPLICATION_URL_VARIABLE);
  scriptLogger.warn(
    { variable: MIGRATION_URL_VARIABLE, fallback: APPLICATION_URL_VARIABLE },
    `${MIGRATION_URL_VARIABLE} est absente : les migrations s'exécutent avec ${APPLICATION_URL_VARIABLE}. Acceptable sur un poste de développement uniquement. Hors développement, ces deux comptes doivent être distincts : le compte applicatif n'a ni droit de schéma ni privilège de superutilisateur.`,
  );
  return { url: application, label: APPLICATION_URL_VARIABLE };
}

/** Cible des opérations de données courantes, toujours le compte applicatif. */
export function resolveApplicationTarget(env: Record<string, string | undefined>): DatabaseTarget {
  const application = readVariable(env, APPLICATION_URL_VARIABLE);
  if (application === undefined) {
    throw new DatabaseConfigurationError(
      `${APPLICATION_URL_VARIABLE} est absente ou vide : renseigner la chaîne de connexion du compte applicatif dans .env.local. Forme attendue : ${EXPECTED_FORM}. ${NO_VALUE_NOTICE}`,
    );
  }
  assertUsableUrl(application, APPLICATION_URL_VARIABLE);
  return { url: application, label: APPLICATION_URL_VARIABLE };
}

function readSslOption(env: Record<string, string | undefined>): ClientConfig['ssl'] {
  const environment = readVariable(env, 'APP_ENV')?.toLowerCase();
  // TLS exigé dès que l'on sort du poste local (docs/security.md). Une valeur non reconnue
  // retombe sur ce repli plutôt que d'affaiblir la connexion silencieusement.
  const fallback = environment !== 'local' && environment !== 'test';
  const raw = readVariable(env, 'DATABASE_SSL')?.toLowerCase();
  let enabled = fallback;
  if (raw !== undefined && TRUE_VALUES.includes(raw)) {
    enabled = true;
  } else if (raw !== undefined && FALSE_VALUES.includes(raw)) {
    enabled = false;
  }
  return enabled ? { rejectUnauthorized: true } : false;
}

function extractErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Traduit un échec de connexion en consigne actionnable. Le message du pilote n'est jamais
 * recopié : il contient l'identifiant en clair sur un refus d'authentification.
 */
function describeConnectionFailure(error: unknown, target: DatabaseTarget): string {
  const location = `Cible : ${target.label}, ${redactUrl(target.url)}.`;
  const code = extractErrorCode(error);
  switch (code) {
    case 'ECONNREFUSED':
      return `Base injoignable : la connexion est refusée. Démarrer la base locale avec « npm run db:up », puis vérifier l'hôte et le port de ${target.label}. ${location}`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Base injoignable : le nom d'hôte de ${target.label} n'a pas pu être résolu. Vérifier l'hôte et la résolution DNS. ${location}`;
    case 'ETIMEDOUT':
    case 'ECONNRESET':
      return `Base injoignable : délai dépassé ou connexion interrompue. Vérifier que la base est démarrée, joignable et non filtrée par un pare-feu. ${location}`;
    case '28P01':
    case '28000':
      return `Authentification refusée par le serveur pour ${target.label}. Corriger l'identifiant ou le mot de passe dans .env.local. ${NO_VALUE_NOTICE} ${location}`;
    case '3D000':
      return `La base de données nommée dans ${target.label} n'existe pas sur ce serveur. La créer ou corriger le nom. ${location}`;
    case '08006':
    case '08001':
      return `Base injoignable : la négociation de connexion a échoué, TLS mal configuré est la cause la plus fréquente. Vérifier DATABASE_SSL. ${location}`;
    default:
      return `Connexion impossible (code ${code ?? 'non renseigné'}). Vérifier que la base est démarrée, que ${target.label} est correcte et que le serveur accepte la connexion. ${location}`;
  }
}

/**
 * Ouvre une connexion unique. Le pool n'a pas d'intérêt ici : les scripts sont séquentiels et le
 * verrou consultatif des migrations est attaché à une session précise.
 */
export async function openClient(
  target: DatabaseTarget,
  env: Record<string, string | undefined>,
): Promise<Client> {
  const client = new pg.Client({
    connectionString: target.url,
    application_name: APPLICATION_NAME,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    ssl: readSslOption(env),
  });
  try {
    await client.connect();
  } catch (error) {
    try {
      await client.end();
    } catch {
      // La fermeture d'une connexion jamais établie n'apporte aucune information exploitable.
    }
    throw new DatabaseConnectionError(describeConnectionFailure(error, target), { cause: error });
  }
  return client;
}

/** Ferme une connexion sans jamais masquer l'erreur d'origine du script appelant. */
export async function closeClient(client: Client): Promise<void> {
  try {
    await client.end();
  } catch (error) {
    scriptLogger.warn(
      { reason: error instanceof Error ? error.name : 'inconnue' },
      'La fermeture de la connexion a échoué. Le script se termine tout de même.',
    );
  }
}

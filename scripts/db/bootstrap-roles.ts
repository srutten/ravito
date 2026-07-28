/**
 * `npm run db:bootstrap-roles` — attribue un mot de passe de connexion au rôle applicatif.
 *
 * Pourquoi une commande séparée (critère 17) : le rôle applicatif est créé par une migration,
 * sans droit de connexion et sans droit de schéma. Une migration ne peut pas contenir de mot de
 * passe — elle est versionnée, et « les secrets ne doivent jamais être commités » (CLAUDE.md).
 * L'attribution du mot de passe est donc une étape d'exploitation : ce script la réalise sur un
 * poste de développement à partir d'une variable d'environnement, et la même opération est
 * conduite par le gestionnaire de secrets sur les environnements distants.
 *
 * Le script vérifie avant d'agir que le rôle est bien un compte applicatif contraint : ni
 * superutilisateur, ni créateur de rôle ou de base, ni contournement des politiques de ligne, et
 * sans droit de création dans le schéma `public`. Si l'une de ces conditions n'est pas remplie,
 * aucun mot de passe n'est attribué : ouvrir la connexion d'un compte trop privilégié serait
 * exactement la faute que le critère cherche à éviter.
 *
 * Le mot de passe n'est jamais affiché, ni journalisé, ni écrit dans le dépôt. Il n'est pas non
 * plus transmis au serveur : le script calcule localement le vérificateur SCRAM-SHA-256 et
 * n'envoie que celui-ci. Un `ALTER ROLE ... PASSWORD 'motdepasse'` ferait au contraire transiter
 * le secret en clair, où `log_statement` et `pg_stat_statements` peuvent le retenir.
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type { Client } from 'pg';
import {
  closeClient,
  DatabaseConfigurationError,
  describeFailure,
  openClient,
  redactUrl,
  resolveMigrationTarget,
} from './lib/database-url.ts';
import { scriptLogger, writeLine } from './lib/script-logger.ts';

const COMMAND = 'db:bootstrap-roles';
const ROLE_VARIABLE = 'DATABASE_APP_ROLE';
const PASSWORD_VARIABLE = 'DATABASE_APP_PASSWORD';
const MIN_PASSWORD_LENGTH = 16;
const ROLE_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
/**
 * Caractères ASCII imprimables hors espace. SASLprep, la normalisation Unicode qu'impose SCRAM,
 * est l'identité sur cet ensemble : le vérificateur calculé ici est donc exactement celui qu'un
 * client PostgreSQL calculerait. Refuser le reste évite un mot de passe accepté par le script
 * mais rejeté à la connexion.
 */
const PASSWORD_PATTERN = /^[\x21-\x7e]+$/;
const NO_VALUE_NOTICE = "Aucune valeur n'est reproduite ici.";

/** Paramètres SCRAM-SHA-256 alignés sur ceux que PostgreSQL applique par défaut. */
const SCRAM_ITERATIONS = 4096;
const SCRAM_SALT_BYTES = 16;
const SCRAM_KEY_BYTES = 32;

interface RolePrivilegesRow {
  readonly rolsuper: boolean;
  readonly rolcreatedb: boolean;
  readonly rolcreaterole: boolean;
  readonly rolbypassrls: boolean;
  readonly rolreplication: boolean;
  readonly rolcanlogin: boolean;
}

function readRequired(env: Record<string, string | undefined>, name: string): string {
  const raw = env[name];
  const trimmed = raw === undefined ? '' : raw.trim();
  if (trimmed === '') {
    throw new DatabaseConfigurationError(
      `${name} est absente ou vide : renseigner cette variable dans .env.local, ou l'injecter depuis le gestionnaire de secrets. ${NO_VALUE_NOTICE}`,
    );
  }
  return trimmed;
}

function readRoleName(env: Record<string, string | undefined>): string {
  const role = readRequired(env, ROLE_VARIABLE);
  if (!ROLE_PATTERN.test(role)) {
    throw new DatabaseConfigurationError(
      `${ROLE_VARIABLE} n'est pas un nom de rôle exploitable : minuscules, chiffres et soulignés attendus, en commençant par une lettre ou un souligné, 63 caractères au plus. ${NO_VALUE_NOTICE}`,
    );
  }
  return role;
}

function readPassword(env: Record<string, string | undefined>): string {
  const password = readRequired(env, PASSWORD_VARIABLE);
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new DatabaseConfigurationError(
      `${PASSWORD_VARIABLE} n'atteint pas la longueur minimale de ${MIN_PASSWORD_LENGTH} caractères, produits par le gestionnaire de secrets et distincts par environnement. ${NO_VALUE_NOTICE}`,
    );
  }
  if (!PASSWORD_PATTERN.test(password)) {
    throw new DatabaseConfigurationError(
      `${PASSWORD_VARIABLE} contient des caractères hors ASCII imprimable. Le vérificateur SCRAM ne pourrait pas être calculé de façon fiable : produire un secret en ASCII imprimable, ou suivre la procédure « \\password » décrite dans supabase/README.md. ${NO_VALUE_NOTICE}`,
    );
  }
  return password;
}

/**
 * Vérificateur SCRAM-SHA-256 tel que PostgreSQL le stocke (RFC 5802). Calculé sur le poste : le
 * serveur ne reçoit que le vérificateur, jamais le mot de passe. Un attaquant qui lirait ce
 * vérificateur ne pourrait pas s'authentifier à la place du compte, faute de `ClientKey`.
 */
function buildScramVerifier(password: string): string {
  const salt = randomBytes(SCRAM_SALT_BYTES);
  const saltedPassword = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, SCRAM_KEY_BYTES, 'sha256');
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

async function readRolePrivileges(
  client: Client,
  role: string,
): Promise<RolePrivilegesRow | undefined> {
  const { rows } = await client.query<RolePrivilegesRow>(
    `select rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication, rolcanlogin
     from pg_roles where rolname = $1`,
    [role],
  );
  return rows[0];
}

function listExcessivePrivileges(privileges: RolePrivilegesRow): string[] {
  const excessive: string[] = [];
  if (privileges.rolsuper) {
    excessive.push('SUPERUSER');
  }
  if (privileges.rolcreatedb) {
    excessive.push('CREATEDB');
  }
  if (privileges.rolcreaterole) {
    excessive.push('CREATEROLE');
  }
  if (privileges.rolbypassrls) {
    excessive.push('BYPASSRLS');
  }
  if (privileges.rolreplication) {
    excessive.push('REPLICATION');
  }
  return excessive;
}

async function assertNoSchemaRights(client: Client, role: string): Promise<void> {
  const { rows } = await client.query<{ readonly can_create: boolean }>(
    "select has_schema_privilege($1, 'public', 'CREATE') as can_create",
    [role],
  );
  const row = rows[0];
  if (row?.can_create) {
    throw new DatabaseConfigurationError(
      `Le rôle « ${role} » dispose du droit CREATE sur le schéma public. Le compte applicatif ne doit avoir aucun droit de schéma : corriger la migration qui attribue ses droits, puis relancer. Aucun mot de passe n'a été attribué.`,
    );
  }
}

/**
 * `ALTER ROLE` n'accepte ni identifiant ni secret paramétrés : la commande doit être un texte.
 * Elle est donc assemblée par `format()` côté serveur, à partir de paramètres liés, de sorte que
 * l'échappement soit celui de PostgreSQL et non une concaténation maison. La valeur transmise est
 * le vérificateur SCRAM, pas le mot de passe, et le texte produit n'est ni affiché ni journalisé.
 */
async function grantLogin(client: Client, role: string, verifier: string): Promise<void> {
  const { rows } = await client.query<{ readonly statement: string }>(
    "select format('alter role %I with login password %L', $1::text, $2::text) as statement",
    [role, verifier],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new DatabaseConfigurationError(
      "La construction de la commande d'attribution a échoué côté serveur. Aucun mot de passe n'a été attribué.",
    );
  }
  await client.query(row.statement);
}

async function main(): Promise<number> {
  const env = process.env;
  const role = readRoleName(env);
  const password = readPassword(env);

  const environment = env.APP_ENV?.trim().toLowerCase();
  if (environment !== 'local' && environment !== 'test') {
    scriptLogger.warn(
      { command: COMMAND, environment: environment ?? 'non renseigné' },
      "Attribution d'un mot de passe applicatif hors poste de développement. L'opération doit être conduite depuis le gestionnaire de secrets, tracée, et suivie d'une rotation planifiée (docs/security.md).",
    );
  }

  // Opération de schéma : elle exige le compte de migration, pas le compte applicatif.
  const target = resolveMigrationTarget(env);
  writeLine(`Cible : ${target.label}, ${redactUrl(target.url)}.`);

  const client = await openClient(target, env);
  try {
    const privileges = await readRolePrivileges(client, role);
    if (privileges === undefined) {
      throw new DatabaseConfigurationError(
        `Le rôle « ${role} » n'existe pas sur cette base. Il est créé par les migrations : appliquer « npm run db:migrate » puis relancer.`,
      );
    }

    const excessive = listExcessivePrivileges(privileges);
    if (excessive.length > 0) {
      throw new DatabaseConfigurationError(
        `Le rôle « ${role} » détient des privilèges incompatibles avec un compte applicatif : ${excessive.join(', ')}. Retirer ces attributs avant d'ouvrir sa connexion. Aucun mot de passe n'a été attribué.`,
      );
    }
    await assertNoSchemaRights(client, role);

    await grantLogin(client, role, buildScramVerifier(password));

    const updated = await readRolePrivileges(client, role);
    if (updated === undefined || !updated.rolcanlogin) {
      throw new DatabaseConfigurationError(
        `Le rôle « ${role} » n'a pas obtenu le droit de connexion. Vérifier les privilèges du compte de migration.`,
      );
    }

    writeLine(
      `Rôle applicatif « ${role} » : mot de passe de connexion attribué, droit de connexion actif.`,
    );
    writeLine(
      "Reporter la même valeur dans DATABASE_URL de .env.local. Le mot de passe n'a été ni affiché, ni journalisé, ni transmis en clair au serveur : seul son vérificateur SCRAM-SHA-256 a circulé.",
    );
    scriptLogger.info({ command: COMMAND, role }, 'Connexion du rôle applicatif activée.');
    return 0;
  } finally {
    await closeClient(client);
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  scriptLogger.error({ command: COMMAND }, describeFailure(error, process.env));
  process.exitCode = 1;
}

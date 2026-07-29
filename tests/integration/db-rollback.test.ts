import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Voir l'en-tête de `organization-access.test.ts` : l'environnement précède les imports, plusieurs
 * modules du domaine lisant la configuration au chargement. La cible de `DATABASE_URL` n'est jamais
 * ouverte ici — les gardes d'autorisation sont appelées avec la connexion de la base jetable, qui
 * satisfait `SqlExecutor` — mais la valeur doit exister pour que la configuration se valide.
 */
vi.hoisted(() => {
  process.env.APP_ENV = 'local';
  process.env.APP_VERSION = '0.0.0-test';
  process.env.LOG_LEVEL = 'error';
  process.env.AUTH_SECRET = 'secret-de-test-fictif-retour-arriere-de-plus-de-32-caracteres';
  process.env.DATABASE_URL = 'postgresql://attente:attente@localhost:5432/attente';
  process.env.DATABASE_SSL = 'disable';
});

import { isAppError } from '@/application/errors';
import {
  assertOrganizationVisible,
  resolveOrganizationAccess,
} from '@/authorization/organization-access';
import {
  applyPending,
  assertMigrationIntegrity,
  defaultMigrationsDirectory,
  listMigrationFiles,
  readStatus,
} from '../../scripts/db/lib/migration-runner';
import type { DisposableDatabaseSetup } from './setup/database';
import { createDisposableDatabase, databaseOrSkip, NOT_PREPARED } from './setup/database';

/**
 * Le retour arrière du lot organisations, éprouvé comme un ALLER-RETOUR et non comme une descente.
 *
 * CE QUE CE FICHIER GARDE. Un `.down.sql` qui supprime ses objets sans retirer sa ligne de
 * `public.schema_migrations` transforme le retour arrière en PORTE À SENS UNIQUE : les tables ont
 * disparu, mais le moteur croit toujours la migration appliquée. `db:status` annonce « La base est
 * à jour », `db:migrate` ne fait rien, et l'outil de diagnostic officiel affirme le contraire de la
 * réalité. Aucune commande du dépôt ne remet alors la base d'aplomb.
 *
 * ET LE DÉFAUT SYMÉTRIQUE, QUI EST CELUI QU'ON S'EST FABRIQUÉ EN CORRIGEANT LE PREMIER. Retirer la
 * ligne sans condition démonte l'autre versant : un retour arrière REFUSÉ — ordre inverse non
 * respecté, dépendance encore en place — laisse les objets intacts et perd quand même sa ligne. Le
 * moteur annonce alors « en attente » une migration dont le schéma est complet, et la réparation ne
 * tient plus qu'à l'idempotence du fichier, que rien ne garantit. Les deux versants sont gardés
 * ici, et le second est signalé en toutes lettres plus bas.
 *
 * POURQUOI PAR LE MOTEUR DU DÉPÔT, ET NON PAR DU SQL ÉCRIT ICI. Recopier les `DROP` dans le test
 * éprouverait le test et non les fichiers livrés. Chaque retour arrière est donc lu sur le disque
 * et envoyé au serveur tel quel. La remontée passe par `applyPending`, c'est-à-dire par le code que
 * `npm run db:migrate` exécute.
 *
 * DEUX FORMES D'INVOCATION, PARCE QU'ELLES N'OFFRENT PAS LES MÊMES GARANTIES.
 *
 * - `sendAsSingleRequest` envoie le fichier d'un seul tenant. PostgreSQL exécute alors la suite
 *   d'énoncés d'un même message de requête simple dans une transaction implicite : si l'un échoue,
 *   aucun ne subsiste. C'est le régime de `psql --single-transaction`, celui que documente
 *   `supabase/README.md`.
 * - `sendLikePsql` découpe le fichier et envoie chaque énoncé séparément, en autocommit, en
 *   POURSUIVANT après un refus. C'est le comportement de `psql -f` par défaut, c'est-à-dire sans
 *   `--single-transaction` ni `-v ON_ERROR_STOP=1`. C'est la forme la plus dure, et la seule où
 *   l'on voit si la propriété tient du FICHIER ou seulement de la commande. Un test qui n'emploie
 *   que la première forme éprouve la propriété là où elle est vraie d'office : c'est exactement
 *   l'angle mort qui a laissé passer le défaut symétrique.
 *
 * L'ORDRE DES TESTS EST LA MATIÈRE MÊME DU FICHIER : sens interdit sur une base intacte, puis le
 * refus PARTIEL d'un fichier multi-objets — qui monte son propre décor et le remet en place —, puis
 * descente, puis constat, puis remontée, puis le garde-fou d'`outbox`, qui détruit sa table et doit
 * donc passer en dernier. Chaque test qui dépend d'un précédent commence par une assertion de
 * précondition portant un message explicite — sans elle, une descente ratée produirait plus bas des
 * échecs incompréhensibles.
 */

/** `dependent_objects_still_exist` : le refus recherché quand l'ordre inverse n'est pas respecté. */
const DEPENDENT_OBJECTS_STILL_EXIST = '2BP01';
/** `undefined_table` : ce que rencontre une garde d'autorisation privée de sa table. */
const UNDEFINED_TABLE = '42P01';
/** `object_not_in_prerequisite_state` : le refus que lèvent les blocs de garde des `.down.sql`. */
const OBJECT_NOT_IN_PREREQUISITE_STATE = '55000';

/** Ordre documenté du retour arrière du lot organisations. */
const ROLLBACK_ORDER: readonly string[] = [
  '0017_idempotency-keys.down.sql',
  '0016_organization-members.down.sql',
  '0015_organizations.down.sql',
  '0014_organization-enums.down.sql',
];

const ROLLED_BACK_VERSIONS: readonly string[] = ['0014', '0015', '0016', '0017'];

/**
 * Montage du refus PARTIEL : dérouler `0017` puis `0016` libère les deux types d'adhésion — plus
 * aucune colonne ne les porte — alors que `0015` reste en place et porte encore les trois autres.
 * C'est l'état exact, et le seul, où `0014` se voit refuser un `DROP` AU MILIEU de sa liste.
 */
const PARTIAL_REFUSAL_SETUP: readonly string[] = [
  '0017_idempotency-keys.down.sql',
  '0016_organization-members.down.sql',
];
/** Ce que le montage laisse en attente, et que la remontée doit savoir réappliquer. */
const PARTIAL_REFUSAL_PENDING: readonly string[] = ['0016', '0017'];
/** Triées comme PostgreSQL les rend : les comparaisons portent sur des listes ordonnées. */
const ORGANIZATION_TABLES: readonly string[] = [
  'idempotency_keys',
  'organization_members',
  'organizations',
];
/**
 * Les quatre types de `0004`, triés comme PostgreSQL les rend. `mission_status` est le PREMIER de
 * la liste que déroule `0004_shared-enums.down.sql` et le seul qu'une colonne porte encore au lot 0
 * — `idempotency_witness.status` (`0007`). Les trois autres n'attendent que le lot 5 : ils sont donc
 * libres, et c'est ce qui rend ce fichier atteignable sans le moindre montage.
 */
const SHARED_ENUM_TYPES: readonly string[] = [
  'mission_status',
  'offer_status',
  'operational_request_status',
  'resource_status',
];
const ORGANIZATION_ENUM_TYPES: readonly string[] = [
  'organization_member_role',
  'organization_member_status',
  'organization_status',
  'organization_type',
  'organization_verification_status',
];
/** Objets d'autres lots : ils doivent survivre intacts, sinon le retour arrière déborde. */
const UNTOUCHED_TABLES: readonly string[] = ['audit_logs', 'outbox', 'sessions', 'user_profiles'];

let setup: DisposableDatabaseSetup = NOT_PREPARED;
let schemaBeforeRollback: SchemaSnapshot | null = null;
let organizationId = '';
let userId = '';
let verdictBeforeRollback: AccessVerdict | null = null;

/**
 * Photographie STRUCTURELLE du schéma `public`, en textes comparables.
 *
 * Aucune donnée, aucun identifiant interne : uniquement ce qu'une migration décrit. Les OID
 * changent à chaque recréation et rendraient la comparaison toujours fausse ; les définitions
 * rendues par `pg_get_constraintdef` et consorts, elles, sont stables et lisibles dans un message
 * d'échec.
 */
interface SchemaSnapshot {
  readonly columns: readonly string[];
  readonly enums: readonly string[];
  readonly constraints: readonly string[];
  readonly indexes: readonly string[];
  readonly triggers: readonly string[];
  readonly grants: readonly string[];
}

async function lines(client: Client, sql: string): Promise<string[]> {
  const { rows } = await client.query<{ readonly ligne: string }>(sql);
  return rows.map((row) => row.ligne);
}

async function captureSchema(client: Client): Promise<SchemaSnapshot> {
  return {
    columns: await lines(
      client,
      `select c.relname || ' | ' || a.attname || ' | ' || format_type(a.atttypid, a.atttypmod)
              || ' | notnull=' || a.attnotnull::text
              || ' | defaut=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
              || ' | genere=' || a.attgenerated::text as ligne
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
         left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
        where n.nspname = 'public' and c.relkind = 'r'
        order by c.relname, a.attnum`,
    ),
    enums: await lines(
      client,
      `select t.typname || ' | ' || e.enumlabel as ligne
         from pg_type t
         join pg_enum e on e.enumtypid = t.oid
         join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public'
        order by t.typname, e.enumsortorder`,
    ),
    constraints: await lines(
      client,
      `select rel.relname || ' | ' || con.conname || ' | ' || pg_get_constraintdef(con.oid) as ligne
         from pg_constraint con
         join pg_class rel on rel.oid = con.conrelid
         join pg_namespace n on n.oid = con.connamespace
        where n.nspname = 'public'
        order by rel.relname, con.conname`,
    ),
    indexes: await lines(
      client,
      `select tablename || ' | ' || indexname || ' | ' || indexdef as ligne
         from pg_indexes
        where schemaname = 'public'
        order by tablename, indexname`,
    ),
    triggers: await lines(
      client,
      `select c.relname || ' | ' || t.tgname || ' | ' || pg_get_triggerdef(t.oid) as ligne
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and not t.tgisinternal
        order by c.relname, t.tgname`,
    ),
    grants: await lines(
      client,
      `select grantee || ' | ' || table_name::text || ' | ' || privilege_type::text as ligne
         from information_schema.role_table_grants
        where table_schema = 'public' and grantee = 'fire_support_app'
        order by table_name, privilege_type`,
    ),
  };
}

interface PostgresFailure {
  readonly code: string | undefined;
  readonly message: string;
}

function describePostgresFailure(error: unknown): PostgresFailure {
  if (typeof error !== 'object' || error === null) {
    return { code: undefined, message: String(error) };
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const message =
    'message' in error && typeof error.message === 'string' ? error.message : String(error);
  return { code, message };
}

/** Lit un retour arrière du dépôt, tel qu'il est livré. */
async function readRollback(fileName: string): Promise<string> {
  return readFile(path.join(defaultMigrationsDirectory(), fileName), 'utf8');
}

/**
 * Reconnaissance d'une ouverture de chaîne entre signes dollar, `$$` ou `$balise$`. Le `y` impose
 * la reconnaissance À la position demandée : sans lui, un `$` situé plus loin serait pris pour une
 * ouverture ici même.
 */
const DOLLAR_QUOTE_TAG = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;

/**
 * Découpe un fichier SQL en énoncés COMME LE FAIT `psql`.
 *
 * Pourquoi ce découpage est écrit à la main plutôt qu'emprunté : c'est précisément la partie que
 * l'on veut voir se comporter comme l'outil qu'un exploitant a sous la main. `psql` ne coupe pas
 * naïvement sur les points-virgules — il traverse les commentaires de ligne et de bloc, les chaînes
 * entre apostrophes, les identifiants entre guillemets et les chaînes entre signes dollar, sans
 * quoi le point-virgule intérieur d'un bloc `DO $$ ... $$` couperait au mauvais endroit. Les quatre
 * cas sont donc traités, et les fichiers de retour arrière du dépôt les emploient tous.
 */
function splitStatementsLikePsql(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  // Un fragment qui ne porte que des commentaires et des espaces n'est pas un énoncé : `psql` ne
  // l'envoie pas, et le compter fausserait le décompte sur lequel ce fichier s'appuie.
  let hasCode = false;
  let index = 0;

  const flush = (): void => {
    if (hasCode) {
      statements.push(current.trim());
    }
    current = '';
    hasCode = false;
  };

  while (index < sql.length) {
    const character = sql.charAt(index);

    if (sql.startsWith('--', index)) {
      const newline = sql.indexOf('\n', index);
      const stop = newline === -1 ? sql.length : newline;
      current += sql.slice(index, stop);
      index = stop;
      continue;
    }

    if (sql.startsWith('/*', index)) {
      // Les commentaires de bloc s'imbriquent en PostgreSQL, contrairement au SQL standard.
      let depth = 0;
      let cursor = index;
      while (cursor < sql.length) {
        if (sql.startsWith('/*', cursor)) {
          depth += 1;
          cursor += 2;
          continue;
        }
        if (sql.startsWith('*/', cursor)) {
          depth -= 1;
          cursor += 2;
          if (depth === 0) {
            break;
          }
          continue;
        }
        cursor += 1;
      }
      current += sql.slice(index, cursor);
      index = cursor;
      continue;
    }

    if (character === "'" || character === '"') {
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql.charAt(cursor) !== character) {
          cursor += 1;
          continue;
        }
        // Un délimiteur doublé est un délimiteur littéral, il ne ferme pas la chaîne.
        if (sql.charAt(cursor + 1) === character) {
          cursor += 2;
          continue;
        }
        cursor += 1;
        break;
      }
      current += sql.slice(index, cursor);
      hasCode = true;
      index = cursor;
      continue;
    }

    DOLLAR_QUOTE_TAG.lastIndex = index;
    const opening = DOLLAR_QUOTE_TAG.exec(sql);
    if (opening !== null) {
      const tag = opening[0];
      const closing = sql.indexOf(tag, index + tag.length);
      const stop = closing === -1 ? sql.length : closing + tag.length;
      current += sql.slice(index, stop);
      hasCode = true;
      index = stop;
      continue;
    }

    // Le seul point-virgule qui sépare deux énoncés : tous les autres ont été traversés plus haut,
    // à l'intérieur d'un commentaire, d'une chaîne ou d'un bloc entre signes dollar.
    if (character === ';') {
      current += character;
      flush();
      index += 1;
      continue;
    }

    current += character;
    if (character.trim() !== '') {
      hasCode = true;
    }
    index += 1;
  }

  flush();
  return statements;
}

/** Un énoncé envoyé au serveur, et ce que le serveur en a fait. */
interface StatementOutcome {
  /** Début du code de l'énoncé, commentaires retirés : de quoi lire un message d'échec. */
  readonly label: string;
  readonly failure: PostgresFailure | null;
}

const LABEL_LENGTH = 70;

/** Réduit un énoncé à sa première ligne de code, pour que les messages d'échec restent lisibles. */
function summarize(statement: string): string {
  const code = statement
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join(' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  return code.length > LABEL_LENGTH ? `${code.slice(0, LABEL_LENGTH)}…` : code;
}

/**
 * Envoie le fichier d'un seul tenant : PostgreSQL exécute alors tous ses énoncés dans une
 * transaction implicite. C'est le régime de `psql --single-transaction`, celui de la procédure
 * documentée.
 */
async function sendAsSingleRequest(client: Client, fileName: string): Promise<void> {
  await client.query(await readRollback(fileName));
}

/**
 * Envoie le fichier COMME `psql -f` PAR DÉFAUT : un énoncé par requête, en autocommit, sans
 * s'arrêter au premier refus. C'est la forme d'invocation la plus dure, et celle qui distingue une
 * propriété portée par le fichier d'une propriété portée par la ligne de commande.
 */
async function sendLikePsql(client: Client, fileName: string): Promise<StatementOutcome[]> {
  const statements = splitStatementsLikePsql(await readRollback(fileName));
  const outcomes: StatementOutcome[] = [];
  for (const statement of statements) {
    try {
      await client.query(statement);
      outcomes.push({ label: summarize(statement), failure: null });
    } catch (error) {
      outcomes.push({ label: summarize(statement), failure: describePostgresFailure(error) });
    }
  }
  return outcomes;
}

/** Échecs d'une exécution, sous une forme comparable à `[]` et lisible quand elle ne l'est pas. */
function failuresOf(outcomes: readonly StatementOutcome[]): string[] {
  return outcomes
    .filter((outcome) => outcome.failure !== null)
    .map((outcome) => `${outcome.label} → ${outcome.failure?.code} ${outcome.failure?.message}`);
}

/**
 * Joue un retour arrière attendu EN ÉCHEC, fichier envoyé d'un seul tenant. Rendre `null` signifie
 * qu'il a réussi, ce qui fait échouer le test appelant : un sens interdit qui s'ouvre est
 * exactement ce que l'on cherche.
 */
async function attemptRollback(client: Client, fileName: string): Promise<PostgresFailure | null> {
  try {
    await sendAsSingleRequest(client, fileName);
    return null;
  } catch (error) {
    return describePostgresFailure(error);
  }
}

async function appliedVersions(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ readonly version: string }>(
    'select version from public.schema_migrations order by version',
  );
  return rows.map((row) => row.version);
}

async function existingTables(client: Client, names: readonly string[]): Promise<string[]> {
  const { rows } = await client.query<{ readonly relname: string }>(
    `select c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname = any($1::text[])
      order by c.relname`,
    [[...names]],
  );
  return rows.map((row) => row.relname);
}

async function existingEnumTypes(client: Client, names: readonly string[]): Promise<string[]> {
  const { rows } = await client.query<{ readonly typname: string }>(
    `select t.typname
       from pg_type t
       join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public' and t.typtype = 'e' and t.typname = any($1::text[])
      order by t.typname`,
    [[...names]],
  );
  return rows.map((row) => row.typname);
}

async function grantedTables(client: Client, names: readonly string[]): Promise<string[]> {
  const { rows } = await client.query<{ readonly table_name: string }>(
    `select distinct table_name::text as table_name
       from information_schema.role_table_grants
      where table_schema = 'public'
        and grantee = 'fire_support_app'
        and table_name::text = any($1::text[])
      order by table_name`,
    [[...names]],
  );
  return rows.map((row) => row.table_name);
}

/** Droits du compte applicatif sur une table, triés : la comparaison porte sur une liste ordonnée. */
async function privilegesOf(client: Client, table: string): Promise<string[]> {
  const { rows } = await client.query<{ readonly privilege: string }>(
    `select distinct privilege_type::text as privilege
       from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'fire_support_app' and table_name::text = $1
      order by privilege`,
    [table],
  );
  return rows.map((row) => row.privilege);
}

async function countOf(
  client: Client,
  sql: string,
  values: readonly unknown[] = [],
): Promise<number> {
  const { rows } = await client.query<{ readonly compte: string }>(sql, [...values]);
  return Number(rows[0]?.compte ?? '-1');
}

async function unprocessedOutboxCount(client: Client): Promise<number> {
  return countOf(
    client,
    'select count(*)::text as compte from public.outbox where processed_at is null',
  );
}

/**
 * Verdict d'une garde de LECTURE, sous la forme exacte qu'une route produirait : résoudre l'accès,
 * puis appliquer la garde. Trois issues distinctes, parce qu'un `catch` nu confondrait « refusé
 * parce que la règle refuse » avec « refusé parce que la connexion est tombée ».
 */
type AccessVerdict =
  | { readonly outcome: 'visible' }
  | { readonly outcome: 'refuse'; readonly kind: 'application'; readonly code: string }
  | {
      readonly outcome: 'refuse';
      readonly kind: 'base';
      readonly code: string | undefined;
      readonly message: string;
    };

async function seeOrganization(client: Client): Promise<AccessVerdict> {
  try {
    const access = await resolveOrganizationAccess(client, { userId, organizationId });
    assertOrganizationVisible(access);
    return { outcome: 'visible' };
  } catch (error) {
    if (isAppError(error)) {
      return { outcome: 'refuse', kind: 'application', code: error.code };
    }
    const failure = describePostgresFailure(error);
    return { outcome: 'refuse', kind: 'base', code: failure.code, message: failure.message };
  }
}

beforeAll(async () => {
  // `loadIntegrationEnvironment` fait primer `process.env` sur `.env.local` : la valeur d'attente
  // posée plus haut doit céder la place avant que la cible réelle soit résolue. Aucun pool n'est
  // ouvert par ce fichier, la variable n'a donc pas à être rétablie ensuite.
  delete process.env.DATABASE_URL;
  setup = await createDisposableDatabase({ withMigrations: true });
  if (!setup.available) {
    return;
  }
  const client = setup.database.owner;

  // Un acteur, son organisation et une adhésion pleinement effective : le montage minimal qui
  // rend la garde de lecture OUVRANTE avant le retour arrière. Sans ce témoin positif, constater
  // un refus après la descente ne prouverait rien — un refus peut venir d'une préparation ratée.
  const profile = await client.query<{ readonly id: string }>(
    `insert into public.user_profiles (display_name, email, preferred_language, verification_level, status)
     values ('Camille D.', 'sentinelle-retour-arriere@exemple.test', 'fr', 'CONTACT_VERIFIED', 'ACTIVE')
     returning id`,
  );
  userId = profile.rows[0]?.id ?? '';
  const organization = await client.query<{ readonly id: string }>(
    `insert into public.organizations
       (name, type, registration_number, territory_code, verification_status, status)
     values ('Structure fictive de retour arriere', 'COMPANY', 'FICTIF-ROLLBACK-0001', 'ZZ-DEMO-01',
             'PENDING', 'ACTIVE')
     returning id`,
  );
  organizationId = organization.rows[0]?.id ?? '';
  await client.query(
    `insert into public.organization_members (organization_id, user_id, role, status)
     values ($1, $2, 'ORG_ADMIN', 'ACTIVE')`,
    [organizationId, userId],
  );

  verdictBeforeRollback = await seeOrganization(client);
  schemaBeforeRollback = await captureSchema(client);
});

afterAll(async () => {
  if (setup.available) {
    await setup.database.dispose();
  }
});

describe('sens interdit — dérouler dans le mauvais ordre est refusé', () => {
  it('envoyé d’un seul tenant, un ordre inverse non respecté ne retire aucune ligne de suivi', async (context) => {
    const database = databaseOrSkip(setup, context);
    const files = await listMigrationFiles(defaultMigrationsDirectory());

    // 0014 d'abord : les cinq types énumérés sont encore portés par des colonnes de 0015 et 0016.
    const surTypes = await attemptRollback(database.owner, '0014_organization-enums.down.sql');
    expect(surTypes, 'dérouler 0014 avant 0015 et 0016 aurait dû être refusé').not.toBeNull();
    expect(surTypes?.code).toBe(DEPENDENT_OBJECTS_STILL_EXIST);
    expect(surTypes?.message).toContain('organization_member_status');

    // 0015 ensuite : `organization_members` référence encore `organizations`.
    const surTable = await attemptRollback(database.owner, '0015_organizations.down.sql');
    expect(surTable, 'dérouler 0015 avant 0016 aurait dû être refusé').not.toBeNull();
    expect(surTable?.code).toBe(DEPENDENT_OBJECTS_STILL_EXIST);
    expect(surTable?.message).toContain('organizations');

    // Sous cette forme d'invocation, la transaction implicite suffit : le refus annule tout, y
    // compris le retrait de la ligne. La forme SANS transaction est éprouvée par le test suivant,
    // et c'est celle qui compte.
    expect(await appliedVersions(database.owner)).toEqual(files.map((file) => file.version));
    expect(await existingTables(database.owner, ORGANIZATION_TABLES)).toEqual([
      ...ORGANIZATION_TABLES,
    ]);
    expect(await existingEnumTypes(database.owner, ORGANIZATION_ENUM_TYPES)).toEqual([
      ...ORGANIZATION_ENUM_TYPES,
    ]);
  });

  it('RÉVÉLATEUR : envoyé énoncé par énoncé et sans transaction, un refus ne retire toujours rien', async (context) => {
    const database = databaseOrSkip(setup, context);
    const files = await listMigrationFiles(defaultMigrationsDirectory());

    // C'EST L'ASSERTION QUI ÉCHOUAIT AVANT LA CORRECTION. Tant que le retrait de la ligne n'était
    // conditionné que par sa POSITION dans le fichier, cette invocation — le défaut de `psql`, ni
    // `--single-transaction` ni `-v ON_ERROR_STOP=1` — retirait la ligne d'un retour arrière que
    // PostgreSQL venait de refuser : la table restait, ses données aussi, et le moteur annonçait
    // 0015 « en attente ». Le retrait est désormais conditionné à la disparition RÉELLE de la
    // table, vérifiée dans le même bloc, donc le fichier se refuse lui-même.
    const outcomes = await sendLikePsql(database.owner, '0015_organizations.down.sql');

    // Garde-fou du test contre lui-même : si le découpage rendait un seul énoncé, on retomberait
    // dans la forme d'invocation où la propriété est vraie d'office, et ce test ne prouverait rien.
    expect(
      outcomes.length,
      'le fichier doit être envoyé en plusieurs requêtes, comme le fait psql',
    ).toBeGreaterThanOrEqual(2);

    const suppression = outcomes[0];
    expect(suppression?.failure?.code, `premier énoncé : ${suppression?.label}`).toBe(
      DEPENDENT_OBJECTS_STILL_EXIST,
    );

    // Le dernier énoncé a bien été ENVOYÉ — psql ne s'arrête pas — et c'est le fichier qui refuse
    // d'aller plus loin, en nommant l'objet resté en place et la ligne qu'il conserve.
    const retrait = outcomes[outcomes.length - 1];
    expect(retrait?.failure?.code, `dernier énoncé : ${retrait?.label}`).toBe(
      OBJECT_NOT_IN_PREREQUISITE_STATE,
    );
    expect(retrait?.failure?.message).toContain('public.organizations');
    expect(retrait?.failure?.message).toContain('public.schema_migrations');

    // La propriété, en trois constats : la ligne de suivi est intacte, la table aussi, et elle
    // porte toujours ses données. Le moteur et le schéma disent donc la même chose.
    expect(await appliedVersions(database.owner)).toEqual(files.map((file) => file.version));
    expect(await existingTables(database.owner, ORGANIZATION_TABLES)).toEqual([
      ...ORGANIZATION_TABLES,
    ]);
    expect(
      await countOf(
        database.owner,
        'select count(*)::text as compte from public.organizations where id = $1',
        [organizationId],
      ),
      'un retour arrière refusé ne doit toucher à aucune donnée',
    ).toBe(1);
  });
});

/**
 * LE REFUS PARTIEL — le seul cas que les huit autres tests de ce fichier n'atteignent pas.
 *
 * Trois retours arrière défont PLUSIEURS objets d'un coup : `0004` (quatre types), `0009` (deux) et
 * `0014` (cinq). Tous les révélateurs voisins portent sur des fichiers à UN SEUL objet — `0015`,
 * `0005` — où la question ne se pose même pas : le `DROP` unique passe ou ne passe pas, et le
 * contrôle qui suit ne peut pas se tromper. C'est cet angle mort qui a laissé passer le défaut
 * ci-dessous.
 *
 * CE QUI ARRIVE QUAND LA LISTE EST DÉCOUPÉE. Si les `DROP` sont des énoncés distincts, `psql -f` par
 * défaut les envoie un par un et POURSUIT après un refus. Les types encore libres partent
 * RÉELLEMENT, ceux qu'une colonne porte encore restent, et le contrôle final constate le reliquat,
 * refuse, et CONSERVE la ligne de suivi. La ligne ment alors dans l'autre sens : elle affirme `0014`
 * appliquée sur un schéma amputé de deux types. Mesuré, dans cet ordre : `db:status` annonce
 * « Aucune anomalie » sur une base cassée, puis `db:migrate` échoue en `42704` — `type
 * "public.organization_member_role" does not exist` — sans pouvoir réparer. Seule la destruction
 * totale de la base lève cet état, alors qu'un retrait INCONDITIONNEL de la ligne, lui, laissait
 * `db:migrate` tout remonter : la correction de la condition avait donc échangé un état incohérent
 * transitoire et auto-réparable contre un état incohérent permanent.
 *
 * CE QUI LE FERME, ET CE QUE CE BLOC GARDE. Les suppressions sont dans le MÊME bloc `DO` que le
 * contrôle et le retrait, exactement comme `0005` le fait pour sa table. Un `DROP` refusé annule le
 * bloc entier : aucun type ne disparaît, la ligne reste, et elle dit enfin vrai. La propriété se
 * mesure en trois constats — aucun objet détruit, ligne conservée, base ENCORE RÉPARABLE par
 * `db:migrate` — et seul le troisième distingue une base cohérente d'une base coincée.
 *
 * DEUX RÉVÉLATEURS, PARCE QUE LES DEUX FICHIERS NE COÛTENT PAS LE MÊME EFFORT À ATTEINDRE. `0004`
 * mord sans le moindre montage, sur une base à jour, et c'est le pire des deux : rien ne signale
 * jamais le dommage, `db:migrate` n'ayant aucune migration à reprendre. `0014` demande un ordre
 * partiellement déroulé, mais il est le seul à faire ensuite ÉCHOUER `db:migrate`, ce qui rend la
 * base visiblement coincée. Le premier éprouve la discrétion du défaut, le second son irréparabilité.
 *
 * Le second test monte son décor et le remet en place : il rend la base telle qu'il l'a trouvée,
 * pour que l'aller-retour complet qui suit parte du même état que sans lui.
 */
describe('refus partiel d’un fichier multi-objets — rien n’est détruit, la base reste réparable', () => {
  it('RÉVÉLATEUR : 0004 joué seul sur une base à jour n’emporte aucun des quatre types', async (context) => {
    const database = databaseOrSkip(setup, context);
    const files = await listMigrationFiles(defaultMigrationsDirectory());

    // AUCUN MONTAGE, et c'est tout l'intérêt : le geste le plus banal qui soit, un seul fichier
    // joué sur une base à jour. `mission_status` est refusé — `idempotency_witness` le porte — et
    // les trois types suivants sont libres. Sous la forme découpée, ils partaient tous les trois.
    const outcomes = await sendLikePsql(database.owner, '0004_shared-enums.down.sql');

    expect(
      await existingEnumTypes(database.owner, SHARED_ENUM_TYPES),
      'un refus sur le premier type ne doit pas emporter les trois suivants',
    ).toEqual([...SHARED_ENUM_TYPES]);
    expect(await appliedVersions(database.owner)).toContain('0004');

    // `db:status` ne signale rien, et ici c'est juste : la base est intacte. Sous l'ancienne forme
    // il rendait EXACTEMENT la même chose sur un schéma amputé de trois types, sans que rien ne
    // vienne jamais le contredire — le dommage était permanent et muet.
    const status = await readStatus(database.owner, files);
    expect(status.pending).toEqual([]);
    expect(status.drifted).toEqual([]);
    expect(status.missing).toEqual([]);

    expect(
      outcomes.length,
      'les suppressions, le contrôle et le retrait doivent tenir en un seul bloc indissociable',
    ).toBe(1);
    const refus = outcomes[0];
    expect(refus?.failure?.code, `énoncé refusé : ${refus?.label}`).toBe(
      DEPENDENT_OBJECTS_STILL_EXIST,
    );
    expect(refus?.failure?.message).toContain('mission_status');
  });

  it('RÉVÉLATEUR : 0014 joué hors ordre ne détruit aucun type et laisse db:migrate remonter', async (context) => {
    const database = databaseOrSkip(setup, context);
    const files = await listMigrationFiles(defaultMigrationsDirectory());

    // Ces deux descentes-là sont légitimes et doivent réussir : elles ne servent qu'à libérer les
    // deux types d'adhésion. Une préparation en échec rendrait tout ce qui suit muet.
    for (const fileName of PARTIAL_REFUSAL_SETUP) {
      const preparation = await sendLikePsql(database.owner, fileName);
      expect(failuresOf(preparation), `préparation du refus partiel : ${fileName}`).toEqual([]);
    }
    expect(
      await existingEnumTypes(database.owner, ORGANIZATION_ENUM_TYPES),
      'la préparation ne touche à aucun type : les cinq doivent être encore là',
    ).toEqual([...ORGANIZATION_ENUM_TYPES]);

    // Le geste fautif, dans la forme d'invocation la plus dure : `0014` sans avoir déroulé `0015`.
    const outcomes = await sendLikePsql(database.owner, '0014_organization-enums.down.sql');

    // Les trois constats viennent AVANT toute lecture du montage : c'est l'état de la base qui dit
    // si la propriété tient, et un message d'échec doit nommer le dommage avant la forme du fichier.

    // PREMIER CONSTAT : aucun type n'a disparu, y compris les deux que plus aucune colonne ne
    // portait et dont le `DROP` aurait donc réussi s'il avait été envoyé seul.
    expect(
      await existingEnumTypes(database.owner, ORGANIZATION_ENUM_TYPES),
      'un refus au milieu de la liste ne doit détruire aucun type',
    ).toEqual([...ORGANIZATION_ENUM_TYPES]);

    // DEUXIÈME CONSTAT : la ligne de suivi est conservée — et cette fois elle dit vrai.
    expect(await appliedVersions(database.owner)).toContain('0014');

    // Ce que `db:status` affiche. L'assertion passe AUSSI sur le défaut, et c'est précisément le
    // symptôme : une base amputée que le diagnostic officiel déclare sans anomalie. Elle est écrite
    // pour que le lecteur sache qu'elle ne garde rien à elle seule.
    const status = await readStatus(database.owner, files);
    expect(status.pending.map((file) => file.version)).toEqual([...PARTIAL_REFUSAL_PENDING]);
    expect(status.drifted).toEqual([]);
    expect(status.missing).toEqual([]);

    // TROISIÈME CONSTAT, LE SEUL QUI TRANCHE : la base reste réparable par `npm run db:migrate`.
    // Sur le défaut, `0016` échoue ici en 42704 — le type de sa colonne `role` a disparu — et plus
    // aucune commande du dépôt ne remet la base d'aplomb.
    let remontees: string[] = [];
    try {
      remontees = (await applyPending(database.owner, status)).map((record) => record.version);
    } catch (error) {
      throw new Error(
        `db:migrate ne peut plus réparer la base : ${describePostgresFailure(error).message}`,
        { cause: error },
      );
    }
    expect(remontees).toEqual([...PARTIAL_REFUSAL_PENDING]);

    // Le décor est rendu : base complète, table de suivi complète, rien à réparer.
    const after = await readStatus(database.owner, files);
    expect(after.pending).toEqual([]);
    expect(await existingTables(database.owner, ORGANIZATION_TABLES)).toEqual([
      ...ORGANIZATION_TABLES,
    ]);

    // LE MONTAGE QUI PRODUIT LES TROIS CONSTATS, éprouvé pour lui-même. Le fichier ne s'expose qu'en
    // UN SEUL énoncé : c'est ce qui rend la destruction indissociable du contrôle et du retrait, et
    // c'est la seule assertion qui voie une liste redécoupée sans rien devoir à l'état de la base.
    // Le refus vient alors de PostgreSQL, sur le troisième type — les deux premiers étaient libres,
    // le bloc était donc déjà allé les supprimer quand il s'est vu refuser celui-ci, et c'est bien
    // leur suppression qui vient d'être annulée avec le reste.
    expect(
      outcomes.length,
      'les suppressions, le contrôle et le retrait doivent tenir en un seul bloc indissociable',
    ).toBe(1);
    const refus = outcomes[0];
    expect(refus?.failure?.code, `énoncé refusé : ${refus?.label}`).toBe(
      DEPENDENT_OBJECTS_STILL_EXIST,
    );
    expect(refus?.failure?.message).toContain('organization_status');
  });
});

describe('aller-retour complet du lot organisations', () => {
  it('déroulé dans l’ordre, ne laisse ni table, ni type énuméré, ni droit', async (context) => {
    const database = databaseOrSkip(setup, context);
    expect(
      schemaBeforeRollback,
      'la préparation n’a pas photographié le schéma : voir l’erreur du hook beforeAll',
    ).not.toBeNull();

    // La descente réussie est jouée sous la forme la plus dure — énoncé par énoncé, sans
    // transaction — pour que le chemin nominal soit éprouvé dans le même régime que les refus.
    for (const fileName of ROLLBACK_ORDER) {
      const outcomes = await sendLikePsql(database.owner, fileName);
      expect(failuresOf(outcomes), `retour arrière ${fileName}`).toEqual([]);
    }

    expect(await existingTables(database.owner, ORGANIZATION_TABLES)).toEqual([]);
    expect(await existingEnumTypes(database.owner, ORGANIZATION_ENUM_TYPES)).toEqual([]);
    // Aucun droit résiduel. L'assertion est un COROLLAIRE de la ligne précédente — PostgreSQL
    // emporte les droits avec la table — et elle est écrite quand même parce que c'est la propriété
    // que l'exploitant vérifie. Celle qui mord vraiment est plus bas : à la remontée, la liste des
    // droits est comparée à une valeur ABSOLUE, et non à ce qu'elle était avant.
    expect(await grantedTables(database.owner, ORGANIZATION_TABLES)).toEqual([]);

    // Le retour arrière ne déborde pas sur les lots précédents : la preuve d'audit, la file
    // d'envoi, les comptes et les sessions sont intacts.
    expect(await existingTables(database.owner, UNTOUCHED_TABLES)).toEqual([...UNTOUCHED_TABLES]);
  });

  it('RÉVÉLATEUR : le moteur signale de nouveau les quatre migrations en attente', async (context) => {
    const database = databaseOrSkip(setup, context);
    expect(
      await existingTables(database.owner, ORGANIZATION_TABLES),
      'ce test suppose le retour arrière déroulé ; exécuter le fichier entier',
    ).toEqual([]);

    const files = await listMigrationFiles(defaultMigrationsDirectory());
    const status = await readStatus(database.owner, files);

    // C'EST L'ASSERTION QUI ÉCHOUAIT AVANT L'AJOUT DU RETRAIT DE LA LIGNE. Tant qu'un retour
    // arrière laissait sa ligne dans `public.schema_migrations`, `pending` restait vide : la base
    // était démontée et le moteur la déclarait à jour, c'est-à-dire non réparable par le dépôt.
    // C'est aussi le témoin positif du retrait CONDITIONNEL : les objets ayant réellement disparu,
    // la ligne part. Un fichier qui refuserait toujours ne passerait pas ici.
    expect(status.pending.map((file) => file.version)).toEqual([...ROLLED_BACK_VERSIONS]);
    expect(await appliedVersions(database.owner)).toEqual(
      files
        .map((file) => file.version)
        .filter((version) => !ROLLED_BACK_VERSIONS.includes(version)),
    );

    // Ni dérive ni migration fantôme : la base reste réparable par `npm run db:migrate`, sans
    // qu'aucun garde-fou d'immuabilité ne s'y oppose.
    expect(status.drifted).toEqual([]);
    expect(status.missing).toEqual([]);
    expect(() => assertMigrationIntegrity(status)).not.toThrow();
  });

  it('prive de sa table, la garde d’autorisation REFUSE au lieu d’ouvrir', async (context) => {
    const database = databaseOrSkip(setup, context);
    expect(
      await existingTables(database.owner, ['organization_members']),
      'ce test suppose le retour arrière déroulé ; exécuter le fichier entier',
    ).toEqual([]);

    // Le témoin positif, pris avant la descente sur le MÊME code et le MÊME acteur : la garde
    // ouvrait. C'est lui qui interdit de conclure d'un refus qu'il vient d'un montage raté.
    expect(verdictBeforeRollback).toEqual({ outcome: 'visible' });

    // `0016_organization-members.down.sql` réclame ce cas dans son en-tête : « une couche
    // d'autorisation qui, faute de table, laisserait passer au lieu de refuser transformerait ce
    // retour arrière en ouverture générale ». La garde ne rend jamais « visible » : elle propage
    // l'échec de lecture, donc la requête échoue, donc l'accès est fermé.
    const verdict = await seeOrganization(database.owner);
    expect(verdict.outcome).toBe('refuse');
    expect(verdict).toMatchObject({ kind: 'base', code: UNDEFINED_TABLE });
    expect(
      verdict.outcome === 'refuse' && verdict.kind === 'base' ? verdict.message : '',
    ).toContain('organization_members');
  });

  it('réapplique les quatre migrations et rend une base structurellement identique', async (context) => {
    const database = databaseOrSkip(setup, context);
    const before = schemaBeforeRollback;
    expect(before, 'la photographie d’avant retour arrière manque').not.toBeNull();

    const files = await listMigrationFiles(defaultMigrationsDirectory());
    const status = await readStatus(database.owner, files);
    const applied = await applyPending(database.owner, status);
    expect(applied.map((record) => record.version)).toEqual([...ROLLED_BACK_VERSIONS]);

    const after = await readStatus(database.owner, files);
    expect(after.pending).toEqual([]);
    expect(after.applied.map((record) => record.version)).toEqual(
      files.map((file) => file.version),
    );
    // L'empreinte réenregistrée est celle du fichier : la remontée passe par le contrôle
    // d'immuabilité comme n'importe quelle application.
    expect(after.applied.map((record) => record.checksum)).toEqual(
      files.map((file) => file.checksum),
    );

    expect(await captureSchema(database.owner)).toEqual(before);

    // La photographie ci-dessus est une comparaison RELATIVE : elle constate que rien n'a bougé,
    // elle ne dit pas ce qui est juste. Un `GRANT DELETE` présent avant ET après lui échapperait
    // entièrement. Les droits des trois tables sont donc fixés en valeur absolue, conformément à
    // « Droits en vigueur à la fin du lot organisations » de `supabase/README.md`.
    for (const table of ORGANIZATION_TABLES) {
      expect(await privilegesOf(database.owner, table), `droits de ${table}`).toEqual([
        'INSERT',
        'SELECT',
        'UPDATE',
      ]);
    }

    // Ce que l'aller-retour ne rend pas, et que `supabase/README.md` annonce : les données. Les
    // organisations et les adhésions ont bien été détruites, la structure seule revient.
    expect(
      await countOf(database.owner, 'select count(*)::text as compte from public.organizations'),
    ).toBe(0);
  });
});

/**
 * Le garde-fou d'`outbox`, éprouvé en DERNIER parce que son témoin positif détruit la table : rien
 * ne doit dépendre d'elle après ce bloc. Les deux tests forment un couple indissociable — sans le
 * second, un fichier qui refuserait TOUJOURS passerait le premier.
 */
describe('garde-fou d’outbox — refuser et supprimer sont indissociables', () => {
  it('RÉVÉLATEUR : un message non traité fait refuser, et la table comme sa ligne restent', async (context) => {
    const database = databaseOrSkip(setup, context);
    await database.owner.query(
      `insert into public.outbox (aggregate_type, aggregate_id, event_type, payload)
       values ('ORGANIZATION', gen_random_uuid(), 'SENTINELLE_RETOUR_ARRIERE', '{}'::jsonb)`,
    );
    const enAttente = await unprocessedOutboxCount(database.owner);
    expect(enAttente, 'le montage exige au moins un message non traité').toBeGreaterThan(0);

    // Forme d'invocation par défaut de `psql`. Tant que le contrôle et le `DROP TABLE` étaient deux
    // énoncés distincts, psql les dissociait : le refus était affiché, PUIS la table partait avec
    // ses messages non envoyés. Le garde-fou ne gardait rien. Réunis dans un seul bloc, le refus
    // annule la suppression, et le retrait de la ligne — conditionné à la disparition de la table —
    // refuse à son tour.
    const outcomes = await sendLikePsql(database.owner, '0005_outbox.down.sql');
    expect(
      outcomes.length,
      'le fichier doit être envoyé en plusieurs requêtes, comme le fait psql',
    ).toBeGreaterThanOrEqual(2);

    const garde = outcomes[0];
    expect(garde?.failure?.code, `premier énoncé : ${garde?.label}`).toBe(
      OBJECT_NOT_IN_PREREQUISITE_STATE,
    );
    expect(garde?.failure?.message).toContain('Retour arrière refusé');

    const retrait = outcomes[outcomes.length - 1];
    expect(retrait?.failure?.code, `dernier énoncé : ${retrait?.label}`).toBe(
      OBJECT_NOT_IN_PREREQUISITE_STATE,
    );
    expect(retrait?.failure?.message).toContain('public.outbox');

    // CE QUE LE GARDE-FOU PROMET : la table est là, ses messages non traités aussi, et la ligne de
    // suivi n'a pas bougé.
    expect(await existingTables(database.owner, ['outbox'])).toEqual(['outbox']);
    expect(await unprocessedOutboxCount(database.owner)).toBe(enAttente);
    expect(await appliedVersions(database.owner)).toContain('0005');
  });

  it('TÉMOIN POSITIF : file drainée, la table part et sa ligne de suivi avec elle', async (context) => {
    const database = databaseOrSkip(setup, context);
    expect(
      await existingTables(database.owner, ['outbox']),
      'ce test suppose le garde-fou éprouvé juste avant ; exécuter le fichier entier',
    ).toEqual(['outbox']);

    // Le drainage est la procédure documentée pour forcer (`supabase/README.md`) : le garde-fou ne
    // s'écarte pas, il cesse d'avoir lieu d'être.
    await database.owner.query(
      'update public.outbox set processed_at = now() where processed_at is null',
    );
    expect(await unprocessedOutboxCount(database.owner)).toBe(0);

    const outcomes = await sendLikePsql(database.owner, '0005_outbox.down.sql');
    expect(failuresOf(outcomes), 'retour arrière 0005 sur une file drainée').toEqual([]);

    expect(await existingTables(database.owner, ['outbox'])).toEqual([]);

    // Le moteur suit : 0005 redevient « en attente », et elle est la seule.
    const files = await listMigrationFiles(defaultMigrationsDirectory());
    const status = await readStatus(database.owner, files);
    expect(status.pending.map((file) => file.version)).toEqual(['0005']);
  });
});

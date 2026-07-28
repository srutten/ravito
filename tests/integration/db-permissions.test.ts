import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DisposableDatabaseSetup } from './setup/database';
import { createDisposableDatabase, databaseOrSkip, NOT_PREPARED } from './setup/database';

/**
 * Droits SQL du compte applicatif (US-002, critères 11 et 17).
 *
 * C'est le fichier le plus important de la story, et il est presque entièrement NÉGATIF : il
 * énumère ce que le compte applicatif ne peut pas faire. Un contrôle d'accès ne se démontre pas en
 * observant que l'application fonctionne — elle fonctionnerait tout aussi bien avec un compte
 * superutilisateur. Il se démontre en constatant que les opérations interdites échouent réellement,
 * contre le vrai moteur, avec le vrai rôle.
 *
 * Méthode : `SET LOCAL ROLE fire_support_app` dans une transaction. PostgreSQL bascule alors
 * `current_user`, et les contrôles de droits s'appliquent à ce rôle — y compris quand la session a
 * été ouverte par un superutilisateur, qui perd ses privilèges le temps du `SET ROLE` (vérifié :
 * `current_setting('is_superuser')` vaut `off`). Chaque tentative interdite est isolée par un point
 * de reprise, et la transaction est annulée à la fin : aucun test ne laisse de ligne derrière lui.
 *
 * Deux verrous indépendants sont éprouvés séparément, parce qu'ils échouent séparément :
 * - les DROITS SQL, qui arrêtent le compte applicatif ;
 * - le DÉCLENCHEUR d'immuabilité, qui arrête même le propriétaire des tables.
 */

const APPLICATION_ROLE = 'fire_support_app';
/** `insufficient_privilege`, code attendu de tout refus de droit. */
const INSUFFICIENT_PRIVILEGE = '42501';

let setup: DisposableDatabaseSetup = NOT_PREPARED;

beforeAll(async () => {
  setup = await createDisposableDatabase({ withMigrations: true });
});

afterAll(async () => {
  if (setup.available) {
    await setup.database.dispose();
  }
});

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

/**
 * Exécute une instruction attendue en échec, isolée par un point de reprise pour que la transaction
 * reste utilisable ensuite. Une instruction qui RÉUSSIT fait échouer le test : c'est le sens même
 * d'un test négatif d'autorisation.
 */
async function expectRefused(
  client: Client,
  sql: string,
  values: readonly string[] = [],
): Promise<PostgresFailure> {
  await client.query('savepoint tentative');
  try {
    await client.query(sql, [...values]);
  } catch (error) {
    await client.query('rollback to savepoint tentative');
    return describePostgresFailure(error);
  }
  await client.query('rollback to savepoint tentative');
  throw new Error(`Opération acceptée alors qu'elle devait être refusée : ${sql}`);
}

/** Ouvre une transaction, y prend l'identité du compte applicatif, et l'annule quoi qu'il arrive. */
async function withApplicationRole<T>(client: Client, body: () => Promise<T>): Promise<T> {
  await client.query('begin');
  try {
    await client.query(`set local role ${APPLICATION_ROLE}`);
    return await body();
  } finally {
    await client.query('rollback');
  }
}

const INSERT_AUDIT_LOG = `insert into public.audit_logs (action, target_type, target_id)
   values ('TEST_AUTORISATION', 'SONDE', gen_random_uuid())
   returning id`;

describe('attributs du rôle applicatif (critère 17)', () => {
  it('n’est ni superutilisateur, ni créateur de base, ni créateur de rôle', async (context) => {
    const database = databaseOrSkip(setup, context);
    const { rows } = await database.owner.query<{
      readonly rolsuper: boolean;
      readonly rolcreatedb: boolean;
      readonly rolcreaterole: boolean;
      readonly rolbypassrls: boolean;
      readonly rolreplication: boolean;
    }>(
      `select rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication
         from pg_roles where rolname = $1`,
      [APPLICATION_ROLE],
    );
    const role = rows[0];
    expect(role).toBeDefined();
    expect(role?.rolsuper).toBe(false);
    expect(role?.rolcreatedb).toBe(false);
    expect(role?.rolcreaterole).toBe(false);
    expect(role?.rolbypassrls).toBe(false);
    expect(role?.rolreplication).toBe(false);
  });

  it('traverse le schéma public sans pouvoir y créer quoi que ce soit', async (context) => {
    const database = databaseOrSkip(setup, context);
    const { rows } = await database.owner.query<{
      readonly peut_traverser: boolean;
      readonly peut_creer: boolean;
    }>(
      `select has_schema_privilege($1, 'public', 'USAGE') as peut_traverser,
              has_schema_privilege($1, 'public', 'CREATE') as peut_creer`,
      [APPLICATION_ROLE],
    );
    expect(rows[0]?.peut_traverser).toBe(true);
    expect(rows[0]?.peut_creer).toBe(false);
  });

  it('ne reçoit que les droits explicitement accordés, table par table', async (context) => {
    const database = databaseOrSkip(setup, context);
    const { rows } = await database.owner.query<{
      readonly table_name: string;
      readonly privileges: readonly string[];
    }>(
      // La conversion en `text[]` est nécessaire : `privilege_type` est un domaine du schéma
      // d'information, que le pilote ne sait pas décoder et rendrait sous forme de chaîne brute.
      `select table_name::text as table_name,
              array_agg(privilege_type::text order by privilege_type) as privileges
         from information_schema.role_table_grants
        where grantee = $1 and table_schema = 'public'
        group by table_name
        order by table_name`,
      [APPLICATION_ROLE],
    );
    const grants = new Map(rows.map((row) => [row.table_name, row.privileges]));

    expect(grants.get('audit_logs')).toEqual(['INSERT', 'SELECT']);
    expect(grants.get('outbox')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    // Refus par défaut : la table témoin n'a reçu aucun droit, donc elle n'apparaît pas du tout.
    expect(grants.has('idempotency_witness')).toBe(false);
    expect(grants.has('schema_migrations')).toBe(false);
  });
});

describe('journal d’audit vu du compte applicatif (critère 11)', () => {
  it('peut écrire et relire, mais ni modifier, ni supprimer, ni vider', async (context) => {
    const database = databaseOrSkip(setup, context);
    const client = database.owner;

    const refusals = await withApplicationRole(client, async () => {
      const identity = await client.query<{ readonly current_user: string }>('select current_user');
      expect(identity.rows[0]?.current_user).toBe(APPLICATION_ROLE);

      // INSERT : autorisé. C'est la seule écriture dont l'application a besoin.
      const inserted = await client.query<{ readonly id: string }>(INSERT_AUDIT_LOG);
      const id = inserted.rows[0]?.id;
      expect(id).toBeDefined();

      // SELECT : autorisé, l'application doit pouvoir restituer l'historique.
      const read = await client.query<{ readonly action: string }>(
        'select action from public.audit_logs where id = $1',
        [id],
      );
      expect(read.rows[0]?.action).toBe('TEST_AUTORISATION');

      const identifier = id === undefined ? [] : [id];
      return {
        update: await expectRefused(
          client,
          "update public.audit_logs set action = 'TEST_FALSIFICATION' where id = $1",
          identifier,
        ),
        remove: await expectRefused(
          client,
          'delete from public.audit_logs where id = $1',
          identifier,
        ),
        truncate: await expectRefused(client, 'truncate public.audit_logs'),
      };
    });

    expect(refusals.update.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(refusals.remove.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(refusals.truncate.code).toBe(INSUFFICIENT_PRIVILEGE);
    for (const refusal of Object.values(refusals)) {
      expect(refusal.message).toContain('audit_logs');
    }
  });

  it('reste bloqué même en déclarant une purge de rétention', async (context) => {
    // L'échappatoire du déclencheur (`appui_feux.audit_purge`) ne contourne pas les droits : poser
    // le paramètre est à la portée de tout le monde, obtenir le droit DELETE ne l'est pas.
    const database = databaseOrSkip(setup, context);
    const client = database.owner;

    const refusal = await withApplicationRole(client, async () => {
      await client.query("set local appui_feux.audit_purge = 'on'");
      return expectRefused(client, 'delete from public.audit_logs');
    });

    expect(refusal.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('arrête aussi le propriétaire des tables, par le déclencheur d’immuabilité', async (context) => {
    // Les droits ne protègent que du rôle auquel on a pensé. Le second verrou est le déclencheur :
    // il refuse la modification même à la session privilégiée qui vient d'écrire la ligne.
    const database = databaseOrSkip(setup, context);
    const client = database.owner;

    await client.query('begin');
    try {
      const inserted = await client.query<{ readonly id: string }>(INSERT_AUDIT_LOG);
      const id = inserted.rows[0]?.id;
      expect(id).toBeDefined();

      const identifier = id === undefined ? [] : [id];
      const update = await expectRefused(
        client,
        "update public.audit_logs set action = 'TEST_FALSIFICATION' where id = $1",
        identifier,
      );
      const removal = await expectRefused(
        client,
        'delete from public.audit_logs where id = $1',
        identifier,
      );
      const truncate = await expectRefused(client, 'truncate public.audit_logs');

      for (const refusal of [update, removal, truncate]) {
        expect(refusal.code).toBe(INSUFFICIENT_PRIVILEGE);
        expect(refusal.message).toContain('immuable');
      }
    } finally {
      await client.query('rollback');
    }
  });

  it('ne laisse aucune ligne derrière lui', async (context) => {
    const database = databaseOrSkip(setup, context);
    const { rows } = await database.owner.query<{ readonly count: string }>(
      "select count(*)::text as count from public.audit_logs where action = 'TEST_AUTORISATION'",
    );
    expect(rows[0]?.count).toBe('0');
  });
});

describe('schéma vu du compte applicatif (critère 17)', () => {
  it('ne peut ni créer, ni modifier, ni supprimer une table', async (context) => {
    const database = databaseOrSkip(setup, context);
    const client = database.owner;

    const refusals = await withApplicationRole(client, async () => ({
      create: await expectRefused(
        client,
        'create table public.porte_derobee (id uuid primary key)',
      ),
      drop: await expectRefused(client, 'drop table public.outbox'),
      alter: await expectRefused(client, 'alter table public.outbox add column sonde text'),
      index: await expectRefused(client, 'create index sonde_idx on public.outbox (event_type)'),
    }));

    for (const refusal of Object.values(refusals)) {
      expect(refusal.code).toBe(INSUFFICIENT_PRIVILEGE);
    }
    // Une injection SQL réussie ne peut donc pas installer d'objet durable : le message nomme le
    // schéma pour la création, la table pour les altérations.
    expect(refusals.create.message).toContain('public');
    expect(refusals.drop.message).toContain('outbox');
  });

  it('ne peut pas s’accorder à lui-même un droit qu’il n’a pas', async (context) => {
    // Piège documenté de PostgreSQL : un GRANT émis par un non-propriétaire n'échoue PAS, il
    // n'accorde simplement rien et se contente d'un avertissement. Un test qui attendrait une
    // erreur passerait donc à côté ; ce qui compte est l'ABSENCE D'EFFET, mesurée après coup.
    const database = databaseOrSkip(setup, context);
    const client = database.owner;

    const outcome = await withApplicationRole(client, async () => {
      await client.query(`grant delete on public.audit_logs to ${APPLICATION_ROLE}`);
      const granted = await client.query<{ readonly peut_supprimer: boolean }>(
        "select has_table_privilege($1, 'public.audit_logs', 'DELETE') as peut_supprimer",
        [APPLICATION_ROLE],
      );
      return {
        peutSupprimer: granted.rows[0]?.peut_supprimer,
        refus: await expectRefused(client, 'delete from public.audit_logs'),
      };
    });

    expect(outcome.peutSupprimer).toBe(false);
    expect(outcome.refus.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("n'atteint pas une table qui ne lui a jamais été ouverte", async (context) => {
    const database = databaseOrSkip(setup, context);
    const client = database.owner;

    const refusal = await withApplicationRole(client, () =>
      expectRefused(client, 'select count(*) from public.idempotency_witness'),
    );

    expect(refusal.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(refusal.message).toContain('idempotency_witness');
  });

  it('n’a même pas accès à la table de suivi des migrations', async (context) => {
    const database = databaseOrSkip(setup, context);
    const client = database.owner;

    const refusal = await withApplicationRole(client, () =>
      expectRefused(client, 'select count(*) from public.schema_migrations'),
    );

    expect(refusal.code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

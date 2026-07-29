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

/**
 * Tables créées par le lot 1 (migrations 0015 à 0017), toutes trois ouvertes en lecture et en
 * écriture au compte applicatif, aucune en suppression.
 */
const ORGANIZATION_TABLES = ['idempotency_keys', 'organization_members', 'organizations'] as const;

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
    // Lot 1 (US-012). Les trois tables reçoivent `SELECT, INSERT, UPDATE` puis un
    // `REVOKE DELETE, TRUNCATE` explicite (0015:217, 0016:155, 0017:234). Rien ne figeait ce
    // régime : une migration ultérieure pouvait l'élargir sans qu'aucun test ne rougisse.
    for (const table of ORGANIZATION_TABLES) {
      expect(grants.get(table), table).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    }
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

/**
 * Tables d'organisation (US-012, rubrique « Données » de la Definition of Done).
 *
 * Les migrations 0015 à 0017 posent le même régime sur les trois tables : lire, écrire, corriger,
 * jamais effacer. Ce n'est pas une précaution de style. Retirer quelqu'un d'une organisation est un
 * changement de statut (`REVOKED`), fermer une organisation en est un autre (`CLOSED`), et une
 * suppression physique ferait perdre le lien des lignes d'audit déjà écrites — c'est-à-dire la
 * preuve de ce qui a été publié au nom de cette organisation, et à quel titre.
 *
 * DEUX FORMES D'ASSERTION, PARCE QU'ELLES NE COUVRENT PAS LA MÊME FAUTE. Les droits déclarés se
 * lisent dans `role_table_grants` ; c'est là que se voit une migration qui rouvre. L'exécution
 * réelle sous `SET LOCAL ROLE`, elle, est la seule preuve que le refus a bien lieu contre le vrai
 * moteur : un `REVOKE` peut être annulé par un `GRANT` postérieur, par une appartenance de rôle, ou
 * par un droit `PUBLIC` que personne n'avait vu passer.
 */
describe('tables d’organisation vues du compte applicatif (US-012)', () => {
  it('n’a DELETE ni TRUNCATE sur AUCUNE table du schéma, présente ou future', async (context) => {
    const database = databaseOrSkip(setup, context);
    const { rows } = await database.owner.query<{
      readonly table_name: string;
      readonly privilege_type: string;
    }>(
      `select table_name::text as table_name, privilege_type::text as privilege_type
         from information_schema.role_table_grants
        where grantee = $1 and table_schema = 'public'
        order by table_name, privilege_type`,
      [APPLICATION_ROLE],
    );

    // LA PARTITION EST FAITE ICI, PAS EN SQL, et c'est délibéré. Un filtre
    // `privilege_type in ('DELETE', 'TRUNCATE')` mal orthographié — ou un nom de rôle fautif —
    // rendrait zéro ligne, et l'assertion « liste vide » passerait sans avoir rien mesuré. La même
    // liste sert donc de preuve ET de témoin : elle ne peut pas être vide sans que le témoin
    // ci-dessous échoue.
    const removals = rows.filter(
      (row) => row.privilege_type === 'DELETE' || row.privilege_type === 'TRUNCATE',
    );

    // FORME EXHAUSTIVE, ET C'EST TOUT SON INTÉRÊT. Énumérer les tables une à une ne protège que de
    // celles auxquelles on a pensé : `GRANT ALL ON ALL TABLES IN SCHEMA public TO fire_support_app`
    // — le raccourci que l'on écrit en ajoutant une table et en oubliant son GRANT — ouvrirait
    // `organizations` et `organization_members` sans faire rougir une seule assertion nominative.
    // Ici la liste attendue est VIDE : toute ouverture, sur n'importe quelle table, rougit. Si une
    // table à venir a réellement besoin d'être purgée par l'application, ce test doit être relu EN
    // MÊME TEMPS que sa migration, ce qui est exactement le point.
    expect(removals).toStrictEqual([]);

    // TÉMOIN : la vue a bien répondu, et pour les trois tables du lot.
    const covered = [...new Set(rows.map((row) => row.table_name))].filter((name) =>
      (ORGANIZATION_TABLES as readonly string[]).includes(name),
    );
    expect(covered).toStrictEqual([...ORGANIZATION_TABLES]);
  });

  it('ferme et révoque par un STATUT, et ne peut effacer ni l’organisation ni l’adhésion', async (context) => {
    const database = databaseOrSkip(setup, context);
    const client = database.owner;

    const outcome = await withApplicationRole(client, async () => {
      // Le montage est écrit SOUS LE RÔLE APPLICATIF, jamais par le propriétaire : c'est ce qui
      // fait de la suite un test de droits et non un test de contraintes. Données fictives, préfixe
      // `FICTIF-` et territoire `ZZ`, comme le jeu de démonstration.
      const organization = await client.query<{ readonly id: string }>(
        `insert into public.organizations (name, type, registration_number, territory_code)
              values ('Structure sonde des droits', 'COMPANY', 'FICTIF-DROITS-0001', 'ZZ-DEMO-09')
           returning id`,
      );
      const organizationId = organization.rows[0]?.id ?? '';
      const profile = await client.query<{ readonly id: string }>(
        `insert into public.user_profiles (display_name, email)
              values ('Sonde D.', 'sonde-droits-sql@exemple.test')
           returning id`,
      );
      const userId = profile.rows[0]?.id ?? '';
      await client.query(
        `insert into public.organization_members (organization_id, user_id, role)
              values ($1, $2, 'ORG_ADMIN')`,
        [organizationId, userId],
      );

      // Les deux écritures que la conception PRÉVOIT à la place d'une suppression. Elles doivent
      // réussir : sans ce témoin positif, les refus qui suivent seraient tout aussi vrais si
      // l'application n'avait aucun droit du tout sur ces tables, et le test ne distinguerait pas
      // « suppression fermée » de « table murée ».
      const closed = await client.query<{ readonly status: string }>(
        `update public.organizations set status = 'CLOSED', version = version + 1
          where id = $1 returning status::text as status`,
        [organizationId],
      );
      const revoked = await client.query<{ readonly status: string }>(
        `update public.organization_members set status = 'REVOKED'
          where organization_id = $1 and user_id = $2 returning status::text as status`,
        [organizationId, userId],
      );

      // Les six effacements que la conception interdit : ciblé, en masse et vidage, sur chacune
      // des deux tables. Le vidage est énuméré à part parce qu'il relève d'un droit distinct, que
      // `REVOKE DELETE` seul ne retirerait pas.
      const attempts = [
        ['organizations', 'delete from public.organizations where id = $1', [organizationId]],
        ['organizations', 'delete from public.organizations', []],
        ['organizations', 'truncate public.organizations', []],
        [
          'organization_members',
          'delete from public.organization_members where organization_id = $1',
          [organizationId],
        ],
        ['organization_members', 'delete from public.organization_members', []],
        ['organization_members', 'truncate public.organization_members', []],
      ] as const;
      const refusals: { readonly table: string; readonly failure: PostgresFailure }[] = [];
      for (const [table, sql, values] of attempts) {
        refusals.push({ table, failure: await expectRefused(client, sql, values) });
      }

      return {
        closedStatus: closed.rows[0]?.status,
        revokedStatus: revoked.rows[0]?.status,
        refusals,
      };
    });

    expect(outcome.closedStatus).toBe('CLOSED');
    expect(outcome.revokedStatus).toBe('REVOKED');
    expect(outcome.refusals).toHaveLength(6);
    for (const { table, failure } of outcome.refusals) {
      expect(failure.code, table).toBe(INSUFFICIENT_PRIVILEGE);
      // Le message nomme la table : un refus venu d'ailleurs — transaction déjà avortée, objet
      // absent — ne satisferait pas cette assertion, alors qu'il satisferait un simple `catch`.
      expect(failure.message, table).toContain(table);
    }
  });

  it('inscrit le résultat d’une clé d’idempotence, et ne peut pas la retirer', async (context) => {
    const database = databaseOrSkip(setup, context);
    const client = database.owner;

    const outcome = await withApplicationRole(client, async () => {
      const reserved = await client.query<{ readonly id: string }>(
        `insert into public.idempotency_keys (client_event_id, operation, request_fingerprint)
              values (gen_random_uuid(), 'SONDE_DROITS', repeat('a', 64))
           returning id`,
      );
      const keyId = reserved.rows[0]?.id ?? '';

      // Réservation puis inscription du résultat : les deux temps de la vie d'une clé, tous deux
      // dans les droits de l'application.
      const completed = await client.query<{ readonly target_type: string }>(
        `update public.idempotency_keys
            set target_type = 'ORGANIZATION', target_id = gen_random_uuid()
          where id = $1 returning target_type`,
        [keyId],
      );

      return {
        targetType: completed.rows[0]?.target_type,
        refusals: {
          'suppression ciblée': await expectRefused(
            client,
            'delete from public.idempotency_keys where id = $1',
            [keyId],
          ),
          'suppression en masse': await expectRefused(
            client,
            'delete from public.idempotency_keys',
          ),
          vidage: await expectRefused(client, 'truncate public.idempotency_keys'),
        },
      };
    });

    expect(outcome.targetType).toBe('ORGANIZATION');
    for (const [label, refusal] of Object.entries(outcome.refusals)) {
      // EFFACER UNE CLÉ REND SA COMMANDE REJOUABLE. Un compte applicatif compromis obtiendrait
      // ainsi le moyen de faire produire deux fois le même effet à une commande interceptée : le
      // refus est ici une garantie d'idempotence autant qu'une garantie de droits.
      expect(refusal.code, label).toBe(INSUFFICIENT_PRIVILEGE);
      expect(refusal.message, label).toContain('idempotency_keys');
    }
  });
});

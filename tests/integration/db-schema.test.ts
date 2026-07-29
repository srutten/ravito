import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DisposableDatabaseSetup } from './setup/database';
import { createDisposableDatabase, databaseOrSkip, NOT_PREPARED } from './setup/database';

/**
 * Socle géospatial et convention `updated_at` (US-002, critères 2 et 7).
 *
 * Deux garanties sont éprouvées contre une base réelle, dans une base jetable :
 *
 * - PostGIS répond ET calcule. Vérifier la seule présence de l'extension ne prouverait rien : une
 *   extension installée sans GEOS ni PROJ se déclare présente et échoue au premier calcul de
 *   distance, c'est-à-dire au premier appariement de ressource (docs/matching-engine.md).
 *
 * - `updated_at` vient de l'horloge du SERVEUR et n'est pas falsifiable. Le test écrit
 *   volontairement une valeur passée dans la colonne pendant la mise à jour : si le déclencheur
 *   n'écrasait pas cette valeur, l'application pourrait antidater une modification, et le journal
 *   d'exploitation cesserait d'être une preuve.
 */

const NORTH_POLE_DIRECTION_METERS = 110_574;
const EAST_DIRECTION_METERS = 111_319;
/** Tolérance : le calcul est géodésique, la valeur de référence est arrondie. */
const DISTANCE_TOLERANCE_METERS = 100;

const PAST_TIMESTAMP = '2000-01-01T00:00:00.000Z';
const FALSIFIED_TIMESTAMP = '2001-01-01T00:00:00.000Z';

/** Le déclencheur partagé de 0003 impose ce nom à toute table qui l'attache : `<table>_set_updated_at`. */
const TRIGGER_SUFFIX = '_set_updated_at';

let setup: DisposableDatabaseSetup = NOT_PREPARED;

beforeAll(async () => {
  setup = await createDisposableDatabase({ withMigrations: true });
});

afterAll(async () => {
  if (setup.available) {
    await setup.database.dispose();
  }
});

describe('PostGIS (critère 2)', () => {
  it('expose postgis_version() avec un numéro de version exploitable', async (context) => {
    const database = databaseOrSkip(setup, context);
    const { rows } = await database.owner.query<{ readonly version: string }>(
      'select postgis_version() as version',
    );
    expect(rows[0]?.version).toMatch(/^\d+\.\d+/);
  });

  it('calcule une distance géodésique conforme entre deux points', async (context) => {
    const database = databaseOrSkip(setup, context);
    // Points fictifs, choisis pour que la distance attendue soit vérifiable sans table de
    // référence : un degré de latitude, puis un degré de longitude à l'équateur.
    const { rows } = await database.owner.query<{
      readonly nord: number;
      readonly est: number;
      readonly nulle: number;
    }>(
      `select st_distance(st_makepoint(0, 0)::geography, st_makepoint(0, 1)::geography) as nord,
              st_distance(st_makepoint(0, 0)::geography, st_makepoint(1, 0)::geography) as est,
              st_distance(st_makepoint(0, 0)::geography, st_makepoint(0, 0)::geography) as nulle`,
    );
    const row = rows[0];
    expect(row).toBeDefined();
    expect(Math.abs(Number(row?.nord) - NORTH_POLE_DIRECTION_METERS)).toBeLessThan(
      DISTANCE_TOLERANCE_METERS,
    );
    expect(Math.abs(Number(row?.est) - EAST_DIRECTION_METERS)).toBeLessThan(
      DISTANCE_TOLERANCE_METERS,
    );
    expect(Number(row?.nulle)).toBe(0);
  });

  it('sait filtrer par rayon, ce dont dépend la recherche de ressources proches', async (context) => {
    const database = databaseOrSkip(setup, context);
    const { rows } = await database.owner.query<{
      readonly dedans: boolean;
      readonly dehors: boolean;
    }>(
      `select st_dwithin(st_makepoint(0, 0)::geography, st_makepoint(0, 0.1)::geography, 20000) as dedans,
              st_dwithin(st_makepoint(0, 0)::geography, st_makepoint(0, 1)::geography, 20000) as dehors`,
    );
    expect(rows[0]?.dedans).toBe(true);
    expect(rows[0]?.dehors).toBe(false);
  });
});

describe('déclencheur updated_at (critère 7)', () => {
  it('impose l’horloge du serveur et écrase une valeur fournie par le client', async (context) => {
    const database = databaseOrSkip(setup, context);
    const client = database.owner;

    // Tout se joue dans une transaction annulée à la fin : aucune ligne ne survit au test.
    await client.query('begin');
    try {
      const inserted = await client.query<{
        readonly id: string;
        readonly created_at: Date;
        readonly updated_at: Date;
      }>(
        `insert into public.outbox (event_type, aggregate_type, aggregate_id, updated_at)
         values ('TEST_DECLENCHEUR', 'SONDE', gen_random_uuid(), $1::timestamptz)
         returning id, created_at, updated_at`,
        [PAST_TIMESTAMP],
      );
      const before = inserted.rows[0];
      expect(before).toBeDefined();
      // L'insertion ne déclenche rien : le déclencheur est posé BEFORE UPDATE uniquement.
      expect(before?.updated_at.toISOString()).toBe(PAST_TIMESTAMP);

      const updated = await client.query<{
        readonly created_at: Date;
        readonly updated_at: Date;
        readonly horloge_serveur: boolean;
      }>(
        `update public.outbox
            set attempt_count = attempt_count + 1,
                updated_at = $2::timestamptz
          where id = $1
        returning created_at, updated_at, updated_at = transaction_timestamp() as horloge_serveur`,
        [before?.id, FALSIFIED_TIMESTAMP],
      );
      const after = updated.rows[0];
      expect(after).toBeDefined();
      expect(after?.horloge_serveur).toBe(true);
      expect(after?.updated_at.toISOString()).not.toBe(FALSIFIED_TIMESTAMP);
      expect(after?.updated_at.toISOString()).not.toBe(PAST_TIMESTAMP);
      expect((after?.updated_at.getTime() ?? 0) > (before?.updated_at.getTime() ?? 0)).toBe(true);
      // `created_at` n'est pas touché : seule la date de modification bouge.
      expect(after?.created_at.toISOString()).toBe(before?.created_at.toISOString());
    } finally {
      await client.query('rollback');
    }

    const remaining = await client.query<{ readonly count: string }>(
      "select count(*)::text as count from public.outbox where event_type = 'TEST_DECLENCHEUR'",
    );
    expect(remaining.rows[0]?.count).toBe('0');
  });

  it('est attaché à toutes les tables mutables du socle', async (context) => {
    const database = databaseOrSkip(setup, context);
    const { rows } = await database.owner.query<{ readonly tgrelid: string }>(
      `select c.relname as tgrelid
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_proc p on p.oid = t.tgfoid
        where p.proname = 'set_updated_at' and not t.tgisinternal
        order by c.relname`,
    );
    const tables = rows.map((row) => row.tgrelid);
    expect(tables).toContain('outbox');
    expect(tables).toContain('idempotency_witness');
    // `audit_logs` en est volontairement absente : la table est append-only, et une colonne
    // `updated_at` y laisserait croire qu'une modification est prévue.
    expect(tables).not.toContain('audit_logs');
  });
});

/**
 * `updated_at` sur les tables du lot 1 (US-012, rubrique « Données » de la Definition of Done).
 *
 * Les trois tables créées par 0015 à 0017 attachent le déclencheur partagé de 0003, et aucun test
 * ne le vérifiait. L'omission n'aurait rien cassé de visible : une écriture réussit tout aussi bien
 * sans déclencheur, `updated_at` gardant simplement la valeur que l'appelant a fournie — ou, s'il
 * n'en fournit aucune, celle posée à l'insertion.
 *
 * CE QUE CELA COÛTERAIT. Une suspension de mandat laisserait `updated_at` figé sur la date de
 * création de l'adhésion : la question « depuis quand cette personne n'a-t-elle plus ce rôle ? »
 * n'aurait plus de réponse en base, et la traçabilité du changement de mandat serait fausse — non
 * pas absente, ce qui se verrait, mais fausse, ce qui ne se voit pas. Sur `idempotency_keys`,
 * l'écart entre `created_at` et `updated_at` mesure la durée de la mutation réservée ; figé, il
 * indiquerait zéro pour toutes.
 *
 * Les deux formes d'assertion sont nécessaires : la structurelle voit un déclencheur oublié ou
 * désactivé sur les trois tables, la comportementale prouve qu'il écrase réellement une valeur
 * fournie. Un déclencheur présent mais attaché en `BEFORE INSERT` passerait la première et échouerait
 * la seconde.
 */
describe('déclencheur updated_at sur les tables d’organisation (US-012)', () => {
  it('est attaché, actif, et nommé selon la convention, sur les trois tables du lot', async (context) => {
    const database = databaseOrSkip(setup, context);
    const { rows } = await database.owner.query<{
      readonly table_name: string;
      readonly trigger_name: string;
      readonly enabled: string;
    }>(
      `select c.relname::text as table_name,
              t.tgname::text as trigger_name,
              t.tgenabled::text as enabled
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_proc p on p.oid = t.tgfoid
        where p.proname = 'set_updated_at'
          and not t.tgisinternal
          and c.relname = any($1::text[])
        order by c.relname`,
      [['idempotency_keys', 'organization_members', 'organizations']],
    );

    // `tgenabled` vaut `O` pour un déclencheur actif. Un `ALTER TABLE … DISABLE TRIGGER` — le geste
    // que l'on fait pour une reprise de données et que l'on oublie de défaire — laisse la ligne
    // dans `pg_trigger` : une assertion de simple présence ne le verrait pas.
    expect(rows).toStrictEqual([
      {
        table_name: 'idempotency_keys',
        trigger_name: `idempotency_keys${TRIGGER_SUFFIX}`,
        enabled: 'O',
      },
      {
        table_name: 'organization_members',
        trigger_name: `organization_members${TRIGGER_SUFFIX}`,
        enabled: 'O',
      },
      { table_name: 'organizations', trigger_name: `organizations${TRIGGER_SUFFIX}`, enabled: 'O' },
    ]);
  });

  it('horodate une suspension de mandat à l’horloge du serveur, malgré la valeur fournie', async (context) => {
    const database = databaseOrSkip(setup, context);
    const client = database.owner;

    await client.query('begin');
    try {
      const organization = await client.query<{ readonly id: string }>(
        `insert into public.organizations (name, type, registration_number, territory_code)
              values ('Structure sonde du declencheur', 'COMPANY', 'FICTIF-TRIG-0001', 'ZZ-DEMO-08')
           returning id`,
      );
      const profile = await client.query<{ readonly id: string }>(
        `insert into public.user_profiles (display_name, email)
              values ('Sonde T.', 'sonde-declencheur@exemple.test')
           returning id`,
      );
      const organizationId = organization.rows[0]?.id;
      const userId = profile.rows[0]?.id;

      // `updated_at` est posé dans le passé À L'INSERTION, et c'est indispensable : l'insertion et
      // la mise à jour ont lieu dans la MÊME transaction, donc au même `now()`. Laisser la valeur
      // par défaut rendrait l'horodatage identique avant et après, et le test ne distinguerait plus
      // un déclencheur qui a travaillé d'un déclencheur absent.
      const inserted = await client.query<{
        readonly created_at: Date;
        readonly updated_at: Date;
      }>(
        `insert into public.organization_members
                (organization_id, user_id, role, status, updated_at)
              values ($1, $2, 'ORG_ADMIN', 'ACTIVE', $3::timestamptz)
           returning created_at, updated_at`,
        [organizationId, userId, PAST_TIMESTAMP],
      );
      const before = inserted.rows[0];
      expect(before).toBeDefined();
      expect(before?.updated_at.toISOString()).toBe(PAST_TIMESTAMP);

      // LE GESTE MÉTIER : retirer un mandat est un changement de STATUT, jamais une suppression
      // (0016, « Droits »). C'est donc cet UPDATE, et lui seul, qui porte la trace du retrait.
      const suspended = await client.query<{
        readonly status: string;
        readonly created_at: Date;
        readonly updated_at: Date;
        readonly horloge_serveur: boolean;
      }>(
        `update public.organization_members
            set status = 'SUSPENDED', updated_at = $3::timestamptz
          where organization_id = $1 and user_id = $2
        returning status::text as status, created_at, updated_at,
                  updated_at = transaction_timestamp() as horloge_serveur`,
        [organizationId, userId, FALSIFIED_TIMESTAMP],
      );
      const after = suspended.rows[0];
      expect(after).toBeDefined();
      expect(after?.status).toBe('SUSPENDED');
      expect(after?.horloge_serveur).toBe(true);
      expect(after?.updated_at.toISOString()).not.toBe(FALSIFIED_TIMESTAMP);
      expect(after?.updated_at.toISOString()).not.toBe(PAST_TIMESTAMP);
      expect((after?.updated_at.getTime() ?? 0) > (before?.updated_at.getTime() ?? 0)).toBe(true);
      // `created_at` ne bouge pas : l'adhésion garde la date à laquelle le mandat a été ouvert.
      expect(after?.created_at.toISOString()).toBe(before?.created_at.toISOString());
    } finally {
      await client.query('rollback');
    }

    const remaining = await client.query<{ readonly count: string }>(
      `select count(*)::text as count from public.organizations
        where registration_number = 'FICTIF-TRIG-0001'`,
    );
    expect(remaining.rows[0]?.count).toBe('0');
  });

  it('date l’inscription du résultat d’une clé d’idempotence, et non sa réservation', async (context) => {
    const database = databaseOrSkip(setup, context);
    const client = database.owner;

    await client.query('begin');
    try {
      const reserved = await client.query<{
        readonly id: string;
        readonly created_at: Date;
        readonly updated_at: Date;
      }>(
        `insert into public.idempotency_keys
                (client_event_id, operation, request_fingerprint, updated_at)
              values (gen_random_uuid(), 'SONDE_DECLENCHEUR', repeat('b', 64), $1::timestamptz)
           returning id, created_at, updated_at`,
        [PAST_TIMESTAMP],
      );
      const before = reserved.rows[0];
      expect(before?.updated_at.toISOString()).toBe(PAST_TIMESTAMP);

      // Second temps de la vie d'une clé : la réservation reçoit le résultat à rejouer. C'est cet
      // instant que `updated_at` doit porter, et il vient du serveur, pas de l'appelant.
      const completed = await client.query<{
        readonly updated_at: Date;
        readonly horloge_serveur: boolean;
      }>(
        `update public.idempotency_keys
            set target_type = 'ORGANIZATION', target_id = gen_random_uuid(),
                updated_at = $2::timestamptz
          where id = $1
        returning updated_at, updated_at = transaction_timestamp() as horloge_serveur`,
        [before?.id, FALSIFIED_TIMESTAMP],
      );
      const after = completed.rows[0];
      expect(after?.horloge_serveur).toBe(true);
      expect(after?.updated_at.toISOString()).not.toBe(FALSIFIED_TIMESTAMP);
      expect((after?.updated_at.getTime() ?? 0) > (before?.updated_at.getTime() ?? 0)).toBe(true);
    } finally {
      await client.query('rollback');
    }

    const remaining = await client.query<{ readonly count: string }>(
      `select count(*)::text as count from public.idempotency_keys
        where operation = 'SONDE_DECLENCHEUR'`,
    );
    expect(remaining.rows[0]?.count).toBe('0');
  });
});

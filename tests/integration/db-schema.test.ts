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

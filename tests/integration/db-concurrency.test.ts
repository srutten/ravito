import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DisposableDatabaseSetup } from './setup/database';
import { createDisposableDatabase, databaseOrSkip, NOT_PREPARED } from './setup/database';

/**
 * Course à l'affectation et rejeu (US-002, docs/test-plan.md « double affectation » et « rejeu »).
 *
 * Ces deux garanties ne peuvent pas être obtenues applicativement. Deux transactions simultanées
 * liront toutes les deux « aucune mission en cours pour cette ressource » avant que l'une n'écrive :
 * la vérification préalable ne tranche rien, seule une contrainte d'unicité le fait. C'est la règle
 * critique de docs/state-machines.md — une seule mission non terminale par ressource — et c'est
 * pourquoi elle est éprouvée dès le socle, sur la table témoin `idempotency_witness`, et non au
 * lot 5 quand `missions` existera.
 *
 * Le test de concurrence est écrit comme une VRAIE course : deux connexions distinctes, deux
 * transactions qui se chevauchent réellement, et la preuve que la seconde a été BLOQUÉE par le
 * moteur avant d'être rejetée. Deux appels séquentiels ne démontreraient rien : ils passeraient
 * même sans contrainte, à condition que le code applicatif relise entre les deux.
 */

const UNIQUE_VIOLATION = '23505';
/** Délai d'observation du blocage. Court, mais très supérieur à une insertion non bloquée. */
const BLOCKING_OBSERVATION_MS = 300;

const ACTIVE_RESOURCE_INDEX = 'uq_idempotency_witness_active_resource';
const CLIENT_EVENT_INDEX = 'uq_idempotency_witness_client_event_id';

const INSERT_WITNESS = `insert into public.idempotency_witness
    (client_event_id, actor_user_id, resource_id, status)
  values ($1::uuid, $2::uuid, $3::uuid, $4::public.mission_status)
  returning id`;

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
  readonly constraint: string | undefined;
  readonly message: string;
}

function describePostgresFailure(error: unknown): PostgresFailure {
  if (typeof error !== 'object' || error === null) {
    return { code: undefined, constraint: undefined, message: String(error) };
  }
  const read = (key: string): string | undefined => {
    if (!(key in error)) {
      return undefined;
    }
    const value = Reflect.get(error, key);
    return typeof value === 'string' ? value : undefined;
  };
  return {
    code: read('code'),
    constraint: read('constraint'),
    message: read('message') ?? String(error),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function countRows(client: Client, resourceId: string): Promise<number> {
  const { rows } = await client.query<{ readonly count: string }>(
    'select count(*)::text as count from public.idempotency_witness where resource_id = $1',
    [resourceId],
  );
  return Number(rows[0]?.count ?? '-1');
}

describe('anti-double affectation', () => {
  it('ne laisse qu’une seule ligne quand deux transactions courent sur la même ressource', async (context) => {
    const database = databaseOrSkip(setup, context);
    const resourceId = randomUUID();
    const first = await database.connect();
    const second = await database.connect();

    try {
      await first.query('begin');
      await second.query('begin');

      await first.query(INSERT_WITNESS, [randomUUID(), randomUUID(), resourceId, 'ACCEPTED']);

      // La seconde transaction est lancée SANS être attendue : elle chevauche réellement la
      // première. PostgreSQL la met en attente sur l'index unique partiel, sans encore trancher.
      let settled = false;
      const racing = second
        .query(INSERT_WITNESS, [randomUUID(), randomUUID(), resourceId, 'IN_TRANSIT'])
        .then(() => {
          settled = true;
        })
        .catch((error: unknown) => {
          settled = true;
          throw error;
        });
      // La promesse rejetée est déjà surveillée ci-dessous ; ce garde-fou évite un rejet non traité
      // si l'attente échoue avant le `await` final.
      racing.catch(() => undefined);

      await delay(BLOCKING_OBSERVATION_MS);
      // Preuve que c'est bien une course : la seconde insertion n'a ni réussi ni échoué, elle
      // attend le sort de la première. Sans contrainte d'unicité, elle serait déjà passée.
      expect(settled).toBe(false);

      await first.query('commit');

      // Le verdict tombe seulement maintenant, à la validation de la première.
      let failure: PostgresFailure | undefined;
      try {
        await racing;
      } catch (error) {
        failure = describePostgresFailure(error);
      }
      expect(failure?.code).toBe(UNIQUE_VIOLATION);
      expect(failure?.constraint).toBe(ACTIVE_RESOURCE_INDEX);

      await second.query('rollback');
      expect(await countRows(database.owner, resourceId)).toBe(1);
    } finally {
      // La première d'abord : elle détient le verrou, et le libérer débloque la seconde.
      await first.query('rollback').catch(() => undefined);
      await second.query('rollback').catch(() => undefined);
      // Nettoyage : la première transaction a été validée, sa ligne doit disparaître.
      await database.owner.query('delete from public.idempotency_witness where resource_id = $1', [
        resourceId,
      ]);
    }

    expect(await countRows(database.owner, resourceId)).toBe(0);
  });

  it('accepte une seconde ligne dès que la première est terminale', async (context) => {
    // L'index est PARTIEL : COMPLETED et CANCELLED sont hors de son prédicat. Une ressource dont la
    // mission est close doit pouvoir en recevoir une autre, sans quoi elle serait immobilisée à vie.
    const database = databaseOrSkip(setup, context);
    const client = database.owner;
    const resourceId = randomUUID();

    await client.query('begin');
    try {
      await client.query(INSERT_WITNESS, [randomUUID(), randomUUID(), resourceId, 'COMPLETED']);
      await client.query(INSERT_WITNESS, [randomUUID(), randomUUID(), resourceId, 'CANCELLED']);
      await client.query(INSERT_WITNESS, [randomUUID(), randomUUID(), resourceId, 'ACCEPTED']);
      expect(await countRows(client, resourceId)).toBe(3);

      // En revanche, une seconde ligne non terminale reste refusée.
      await client.query('savepoint tentative');
      let failure: PostgresFailure | undefined;
      try {
        await client.query(INSERT_WITNESS, [randomUUID(), randomUUID(), resourceId, 'INCIDENT']);
      } catch (error) {
        failure = describePostgresFailure(error);
      }
      await client.query('rollback to savepoint tentative');

      expect(failure?.code).toBe(UNIQUE_VIOLATION);
      expect(failure?.constraint).toBe(ACTIVE_RESOURCE_INDEX);
    } finally {
      await client.query('rollback');
    }

    expect(await countRows(client, resourceId)).toBe(0);
  });
});

describe('rejeu d’une commande', () => {
  it('rejette une seconde écriture portant le même client_event_id', async (context) => {
    const database = databaseOrSkip(setup, context);
    const client = database.owner;
    const clientEventId = randomUUID();

    await client.query('begin');
    try {
      await client.query(INSERT_WITNESS, [clientEventId, randomUUID(), randomUUID(), 'PROPOSED']);

      await client.query('savepoint rejeu');
      let failure: PostgresFailure | undefined;
      try {
        // Ressource différente, acteur différent : seule l'identité de la commande est rejouée.
        await client.query(INSERT_WITNESS, [clientEventId, randomUUID(), randomUUID(), 'PROPOSED']);
      } catch (error) {
        failure = describePostgresFailure(error);
      }
      await client.query('rollback to savepoint rejeu');

      expect(failure?.code).toBe(UNIQUE_VIOLATION);
      // Portée globale, retenue par 0007 : le rejeu est absorbé même s'il vient d'un autre acteur.
      expect(failure?.constraint).toBe(CLIENT_EVENT_INDEX);
    } finally {
      await client.query('rollback');
    }

    const { rows } = await client.query<{ readonly count: string }>(
      'select count(*)::text as count from public.idempotency_witness where client_event_id = $1',
      [clientEventId],
    );
    expect(rows[0]?.count).toBe('0');
  });
});

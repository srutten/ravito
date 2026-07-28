import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DisposableDatabaseSetup } from './setup/database';
import { createDisposableDatabase, databaseOrSkip, NOT_PREPARED } from './setup/database';
import { repositoryRoot } from './setup/environment';

/**
 * Jeu de démonstration (US-002, critères 5, 15 et 16).
 *
 * Le script est lancé comme une VRAIE commande, dans un sous-processus, avec un environnement
 * construit pour l'occasion. C'est la seule façon d'observer ce que le critère 16 demande — un code
 * de sortie non nul et aucune écriture quand `APP_ENV` vaut `production` — et ce que le critère 15
 * interdit : la moindre trace du mot de passe dans la sortie.
 *
 * La rejouabilité (critère 5) n'est pas vérifiée en relisant le SQL ni en comptant des lignes, mais
 * en comparant deux photographies COMPLÈTES de l'état après chaque passe. Un compteur identique
 * masquerait une ligne réécrite ; la comparaison intégrale inclut `updated_at`, donc un déclencheur
 * réveillé pour rien se verrait immédiatement.
 */

const SEED_SCRIPT = path.join('scripts', 'db', 'seed.ts');
/** Tables du socle que le jeu peut alimenter aujourd'hui : les autres arrivent aux lots 1 à 6. */
const SEEDED_TABLES = ['outbox', 'audit_logs'] as const;

let setup: DisposableDatabaseSetup = NOT_PREPARED;

beforeAll(async () => {
  setup = await createDisposableDatabase({ withMigrations: true });
});

afterAll(async () => {
  if (setup.available) {
    await setup.database.dispose();
  }
});

interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Lance `scripts/db/seed.ts` comme le ferait `npm run db:seed`, mais avec un environnement explicite
 * : la cible est la base jetable, jamais celle de `.env.local`.
 */
function runSeed(overrides: Record<string, string>): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SEED_SCRIPT], {
      cwd: repositoryRoot(),
      env: { ...process.env, ...overrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/** Photographie intégrale des tables alimentées, ordonnée pour être comparable. */
async function snapshot(client: Client): Promise<Record<string, readonly unknown[]>> {
  const state: Record<string, readonly unknown[]> = {};
  for (const table of SEEDED_TABLES) {
    const { rows } = await client.query<{ readonly data: readonly unknown[] }>(
      `select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) as data
         from public.${table} t`,
    );
    state[table] = rows[0]?.data ?? [];
  }
  return state;
}

async function countRows(client: Client, table: string): Promise<number> {
  const { rows } = await client.query<{ readonly count: string }>(
    `select count(*)::text as count from public.${table}`,
  );
  return Number(rows[0]?.count ?? '-1');
}

describe('refus hors environnement local ou de test (critère 16)', () => {
  it('refuse APP_ENV=production sans écrire la moindre ligne', async (context) => {
    const database = databaseOrSkip(setup, context);
    const before = await countRows(database.owner, 'audit_logs');

    const result = await runSeed({
      APP_ENV: 'production',
      DATABASE_URL: database.url,
      DATABASE_MIGRATION_URL: '',
      DATABASE_SSL: 'disable',
    });

    expect(result.code).toBe(1);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('db:seed');
    expect(output).toContain('production');
    // Le garde-fou s'exécute avant la résolution de la cible : aucune connexion n'est même ouverte.
    expect(result.stdout).not.toContain('Cible :');
    expect(await countRows(database.owner, 'audit_logs')).toBe(before);
  });

  it('refuse une variable APP_ENV absente : le refus est la règle par défaut', async (context) => {
    const database = databaseOrSkip(setup, context);
    const before = await countRows(database.owner, 'audit_logs');

    const result = await runSeed({
      APP_ENV: '',
      DATABASE_URL: database.url,
      DATABASE_MIGRATION_URL: '',
      DATABASE_SSL: 'disable',
    });

    expect(result.code).toBe(1);
    expect(await countRows(database.owner, 'audit_logs')).toBe(before);
  });
});

describe('chargement du jeu de démonstration (critère 5)', () => {
  it('laisse exactement le même état après deux exécutions consécutives', async (context) => {
    const database = databaseOrSkip(setup, context);
    const environment = {
      APP_ENV: 'test',
      DATABASE_URL: database.url,
      DATABASE_MIGRATION_URL: '',
      DATABASE_SSL: 'disable',
    };

    const first = await runSeed(environment);
    expect(first.code).toBe(0);
    const afterFirst = await snapshot(database.owner);
    for (const table of SEEDED_TABLES) {
      // Un jeu vide passerait trivialement le test de rejouabilité : on vérifie d'abord qu'il a
      // réellement chargé quelque chose.
      expect(afterFirst[table]?.length ?? 0).toBeGreaterThan(0);
    }

    const second = await runSeed(environment);
    expect(second.code).toBe(0);
    const afterSecond = await snapshot(database.owner);

    // Comparaison intégrale, `updated_at` compris : aucune ligne réécrite, aucun déclencheur
    // réveillé, aucune ligne ajoutée en double.
    expect(afterSecond).toEqual(afterFirst);
  });

  it('ne reproduit jamais le mot de passe ni la chaîne de connexion (critère 15)', async (context) => {
    const database = databaseOrSkip(setup, context);
    const parsed = new URL(database.url);
    const realPassword = decodeURIComponent(parsed.password);

    // Cas nominal : la vraie chaîne de connexion, dont rien ne doit ressortir.
    const nominal = await runSeed({
      APP_ENV: 'test',
      DATABASE_URL: database.url,
      DATABASE_SSL: 'disable',
    });
    expect(nominal.code).toBe(0);
    const nominalOutput = `${nominal.stdout}${nominal.stderr}`;
    expect(nominalOutput).not.toContain(realPassword);
    expect(nominalOutput).not.toContain(database.url);

    // Modes d'échec : chacun emprunte un chemin de message différent. Les identifiants sont
    // remplacés par des sentinelles, ce qui permet de les chercher sans ambiguïté dans la sortie.
    const sentinelUser = 'sentinelle-utilisateur-J8H7G6';
    const sentinelPassword = 'sentinelle-motdepasse-F5D4S3';
    const credentials = `${sentinelUser}:${sentinelPassword}`;
    const failures = [
      await runSeed({ APP_ENV: 'test', DATABASE_URL: '', DATABASE_SSL: 'disable' }),
      await runSeed({
        APP_ENV: 'test',
        DATABASE_URL: `pas-une-url-${sentinelPassword}`,
        DATABASE_SSL: 'disable',
      }),
      await runSeed({
        APP_ENV: 'test',
        DATABASE_URL: `mysql://${credentials}@localhost:1/base`,
        DATABASE_SSL: 'disable',
      }),
      await runSeed({
        APP_ENV: 'test',
        DATABASE_URL: `postgresql://${credentials}@localhost:5999/base_absente`,
        DATABASE_SSL: 'disable',
      }),
    ];

    for (const failure of failures) {
      const output = `${failure.stdout}${failure.stderr}`;
      expect(output).not.toContain(sentinelPassword);
      expect(output).not.toContain(sentinelUser);
      expect(output).not.toContain(credentials);
    }
    // Ces cas sont bien des échecs : sans cela, l'absence de secret ne prouverait rien, puisqu'un
    // script qui n'affiche rien n'affiche pas de secret non plus.
    expect(failures.map((failure) => failure.code)).toEqual([1, 1, 1, 1]);
    for (const failure of failures) {
      expect(`${failure.stdout}${failure.stderr}`.trim()).not.toBe('');
    }
  });
});

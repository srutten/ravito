import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resetServerConfigCache } from '@/config/env';
import { checkDatabase } from '@/infrastructure/database/health-check';
import { closePool, getPool } from '@/infrastructure/database/pool';
import {
  createDisposableDatabase,
  type DisposableDatabaseSetup,
  databaseOrSkip,
  NOT_PREPARED,
} from './setup/database';

/**
 * US-006 — accès applicatif à la base et sonde de santé.
 *
 * Ces tests portent sur le pool utilisé par l'APPLICATION, distinct du client utilisé par les
 * commandes `db:*`. Ils vérifient trois choses que la story rend obligatoires : la sonde reflète
 * l'état réel, elle ne divulgue rien quand la base tombe, et elle reste bornée dans le temps.
 */

let setup: DisposableDatabaseSetup = NOT_PREPARED;

/** Sauvegarde des variables que ces tests détournent, pour ne rien laisser derrière eux. */
const savedEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  APP_ENV: process.env.APP_ENV,
};

/**
 * Pointe le pool applicatif vers une cible donnée. Le cache de configuration et le pool existant
 * doivent être vidés ensemble : le pool est construit à partir de la configuration mémoïsée, donc
 * changer l'une sans l'autre laisserait une connexion vers l'ancienne cible.
 */
async function retargetPool(url: string): Promise<void> {
  await closePool();
  process.env.DATABASE_URL = url;
  // `local` et non `test` : le schéma de configuration n'accepte que local, staging ou production,
  // conformément aux trois environnements de docs/deployment.md. Une valeur non reconnue ferait
  // échouer la construction du pool, et la sonde répondrait « hors service » pour une raison qui
  // n'a rien à voir avec la base — un faux vert sur les tests négatifs ci-dessous.
  process.env.APP_ENV = 'local';
  resetServerConfigCache();
}

beforeAll(async () => {
  setup = await createDisposableDatabase({ withMigrations: true });
});

afterEach(async () => {
  await closePool();
});

afterAll(async () => {
  await closePool();
  process.env.DATABASE_URL = savedEnv.DATABASE_URL;
  process.env.APP_ENV = savedEnv.APP_ENV;
  resetServerConfigCache();
  if (setup.available) {
    await setup.database.dispose();
  }
});

describe('pool applicatif', () => {
  it('réutilise la même instance plutôt que d en ouvrir une par appel', async (context) => {
    const database = databaseOrSkip(setup, context);
    await retargetPool(database.url);

    const first = getPool();
    const second = getPool();

    // Une instance par appel épuiserait les connexions du serveur en développement, où le module
    // est réévalué à chaque recompilation.
    expect(second).toBe(first);
  });

  it('ouvre une seule connexion pour plusieurs requêtes successives', async (context) => {
    const database = databaseOrSkip(setup, context);
    await retargetPool(database.url);

    const pool = getPool();
    await pool.query('select 1');
    await pool.query('select 1');
    await pool.query('select 1');

    // Le pool réutilise sa connexion inactive : trois requêtes séquentielles n'en ouvrent qu'une.
    expect(pool.totalCount).toBe(1);
  });
});

describe('sonde de base de données', () => {
  it('rend un état sain et une latence mesurée quand la base répond', async (context) => {
    const database = databaseOrSkip(setup, context);
    await retargetPool(database.url);

    const health = await checkDatabase();

    expect(health.status).toBe('ok');
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(health.latencyMs)).toBe(true);
  });

  it('rend un état hors service sans rien divulguer quand la base est injoignable', async () => {
    // Port fermé sur la boucle locale : la connexion est refusée immédiatement. Le mot de passe
    // est une sentinelle reconnaissable, dont on vérifie ensuite l'absence totale.
    const sentinelle = 'sentinelle-motdepasse-fictif';
    await retargetPool(`postgresql://compte_sentinelle:${sentinelle}@127.0.0.1:1/base_sentinelle`);

    const health = await checkDatabase();

    expect(health.status).toBe('down');

    // Test négatif central de la story : le résultat ne porte QUE le statut et la latence.
    // Ni le mot de passe, ni l'utilisateur, ni l'hôte, ni le message brut du pilote ne doivent
    // pouvoir franchir cette frontière, puisque la sonde est une route publique.
    const serialise = JSON.stringify(health);
    expect(serialise).not.toContain(sentinelle);
    expect(serialise).not.toContain('compte_sentinelle');
    expect(serialise).not.toContain('base_sentinelle');
    expect(serialise).not.toContain('127.0.0.1');
    expect(Object.keys(health).sort()).toEqual(['latencyMs', 'status']);
  });

  it('reste bornée dans le temps face à une adresse qui ne répond pas', async () => {
    // Adresse non routable : la connexion n'est ni acceptée ni refusée, elle reste pendante.
    // C'est le cas qui ferait pendre indéfiniment une sonde non bornée, et qu'un ordonnanceur
    // interpréterait comme « en cours de démarrage » plutôt que « hors service ».
    await retargetPool('postgresql://compte:motdepasse@203.0.113.1:5432/base');

    const startedAt = Date.now();
    const health = await checkDatabase();
    const elapsed = Date.now() - startedAt;

    expect(health.status).toBe('down');
    // La borne applicative est de deux secondes ; la marge couvre la variabilité d'un runner.
    expect(elapsed).toBeLessThan(8_000);
  }, 20_000);
});

import { Pool, type PoolConfig } from 'pg';
import { getServerConfig } from '@/config/env';
import { logger } from '@/observability/logger';

/**
 * Accès applicatif à PostgreSQL.
 *
 * Le pool s'ouvre avec le compte APPLICATIF de US-002, celui qui ne peut ni créer ni supprimer de
 * table. Le compte de migration, qui dispose des droits de schéma, n'est jamais utilisé par
 * l'application : il n'est mobilisé que par les commandes `db:*`.
 *
 * Aucun message produit ici ne doit contenir la chaîne de connexion, l'utilisateur ou le mot de
 * passe. C'est une exigence de `docs/observability.md`, et elle vaut aussi pour les erreurs du
 * pilote, dont le texte peut citer l'hôte et le rôle.
 */

/** Un seul pool par processus, y compris à travers les recompilations du mode développement. */
const POOL_SINGLETON_KEY = Symbol.for('appui-feux.database.pool');

interface PoolRegistry {
  [POOL_SINGLETON_KEY]?: Pool;
}

/**
 * Le rechargement à chaud de Next réévalue les modules à chaque modification. Une variable de
 * module créerait alors un pool par recompilation, et la base finirait par refuser les connexions
 * après quelques dizaines d'enregistrements. Le registre global survit à ces réévaluations.
 */
const registry = globalThis as unknown as PoolRegistry;

function buildPoolConfig(): PoolConfig {
  const config = getServerConfig();
  return {
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    // Une requête qui dépasse ce délai est interrompue côté serveur : une requête pendante
    // immobiliserait une connexion du pool et finirait par assécher l'application entière.
    statement_timeout: config.databaseStatementTimeoutMs,
    // Même borne côté client, pour le cas où le serveur ne répond plus du tout.
    query_timeout: config.databaseStatementTimeoutMs,
    // Refuser d'attendre indéfiniment une connexion libre : mieux vaut une erreur nette.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    ...(config.databaseSsl ? { ssl: { rejectUnauthorized: true } } : {}),
  };
}

export function getPool(): Pool {
  const existing = registry[POOL_SINGLETON_KEY];
  if (existing) {
    return existing;
  }

  const pool = new Pool(buildPoolConfig());

  // Une erreur sur une connexion inactive du pool est émise ici. Sans écouteur, Node considère
  // l'événement `error` comme non géré et arrête le processus : une coupure réseau passagère
  // suffirait à tuer l'application.
  pool.on('error', (error) => {
    logger.error(
      { err: error, errorCode: 'SERVICE_UNAVAILABLE', module: 'database' },
      'erreur sur une connexion inactive du pool',
    );
  });

  registry[POOL_SINGLETON_KEY] = pool;
  return pool;
}

/**
 * Fermeture ordonnée. Idempotente : appelée deux fois, la seconde ne fait rien.
 */
export async function closePool(): Promise<void> {
  const existing = registry[POOL_SINGLETON_KEY];
  if (!existing) {
    return;
  }
  delete registry[POOL_SINGLETON_KEY];
  await existing.end();
}

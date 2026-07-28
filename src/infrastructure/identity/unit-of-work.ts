import type { QueryResult, QueryResultRow } from 'pg';
import { getPool } from '@/infrastructure/database/pool';

/**
 * Unité de travail transactionnelle.
 *
 * CLAUDE.md exige que toute mutation critique soit transactionnelle. Ouvrir la
 * transaction à la main dans chaque commande finit toujours par produire le même défaut :
 * une connexion non relâchée sur un chemin d'erreur, qui assèche le pool applicatif au
 * bout de quelques dizaines d'occurrences. Le `finally` est ici, une fois.
 *
 * Emplacement : ce module est GÉNÉRIQUE et n'a rien d'identitaire. Il vit sous
 * `infrastructure/identity/` parce que `infrastructure/database/` appartient à un autre
 * périmètre de livraison. Il a vocation à devenir
 * `src/infrastructure/database/transaction.ts` sans changement de signature.
 */

/**
 * Exécutant de requêtes. Un `Pool` et un `PoolClient` le satisfont tous les deux : une
 * fonction qui accepte un `SqlExecutor` peut donc être appelée dans une transaction ou
 * hors transaction, sans surcharge ni variante.
 */
export interface SqlExecutor {
  query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

/**
 * Exécute `run` dans une transaction. Validation au retour normal, annulation sur
 * exception, connexion relâchée dans tous les cas.
 *
 * L'annulation est elle-même protégée : si la connexion est déjà tombée, `ROLLBACK`
 * échoue à son tour et masquerait l'erreur d'origine, qui est la seule intéressante.
 */
export async function withTransaction<T>(run: (executor: SqlExecutor) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // La connexion est perdue : l'erreur d'origine reste la seule à propager.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Exécutant hors transaction, pour les lectures et les mises à jour à un seul énoncé. */
export function getExecutor(): SqlExecutor {
  return getPool();
}

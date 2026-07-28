import { logger } from '@/observability/logger';
import { getPool } from './pool';

/**
 * Sonde de vivacité de la base, destinée à `GET /api/v1/health`.
 *
 * Deux règles gouvernent ce module.
 *
 * La première : la sonde est BORNÉE dans le temps. Une base qui accepte la connexion TCP mais ne
 * répond plus ferait autrement pendre la requête de santé, et un ordonnanceur qui interroge une
 * sonde pendante conclut « en cours de démarrage » au lieu de « hors service ».
 *
 * La seconde : le résultat ne divulgue RIEN. Le message d'une erreur du pilote cite volontiers
 * l'hôte, le port et le rôle ; le relayer dans une réponse publique renseignerait un attaquant sur
 * la topologie interne. Le détail part dans les journaux, où la rédaction du logger s'applique.
 */

export type DatabaseHealthStatus = 'ok' | 'down';

export interface DatabaseHealth {
  readonly status: DatabaseHealthStatus;
  readonly latencyMs: number;
}

/** Au-delà, une base est considérée comme hors service pour les besoins de la sonde. */
const HEALTH_CHECK_TIMEOUT_MS = 2_000;

class HealthCheckTimeout extends Error {
  constructor() {
    super('délai de sonde dépassé');
    this.name = 'HealthCheckTimeout';
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new HealthCheckTimeout());
    }, timeoutMs);

    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('échec de la sonde'));
      },
    );
  });
}

export async function checkDatabase(): Promise<DatabaseHealth> {
  const startedAt = Date.now();
  try {
    // Requête volontairement triviale : la sonde mesure la disponibilité, pas la performance
    // d'une table. Elle ne doit lire aucune donnée métier.
    await withTimeout(getPool().query('select 1'), HEALTH_CHECK_TIMEOUT_MS);
    return { status: 'ok', latencyMs: Date.now() - startedAt };
  } catch (error) {
    logger.error(
      { err: error, errorCode: 'SERVICE_UNAVAILABLE', module: 'database' },
      'sonde de base de données en échec',
    );
    // Ni le message du pilote, ni la cause, ni l'hôte ne franchissent cette frontière.
    return { status: 'down', latencyMs: Date.now() - startedAt };
  }
}

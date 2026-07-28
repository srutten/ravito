import { defineRoute } from '@/application/api-route';
import { getServerConfig } from '@/config/env';
import { checkDatabase } from '@/infrastructure/database/health-check';
import { getRequestLogger } from '@/observability/logger';

/**
 * Sonde de santé, seule route publique du lot 0.
 *
 * Elle répond un statut, la version applicative et l'horodatage du contrôle au format ISO 8601
 * UTC (docs/api-contract.md, horodatages). Rien d'autre : ni version de dépendance, ni nom
 * d'hôte, ni chaîne de connexion, ni trace.
 *
 * L'objet `checks` porte le détail par dépendance. Il contient aujourd'hui `database` (US-006) et
 * accueillera les suivantes sans changer la forme de la réponse.
 *
 * Le statut global est le plus dégradé des contrôles : une instance dont la base est injoignable
 * n'est pas apte à servir, même si le processus applicatif répond. Se déclarer sain dans ce cas
 * serait un faux positif d'exploitation.
 *
 * Cette route statique a priorité sur la route attrape-tout `/api/v1/[...segments]` : dans le
 * routeur de Next, un segment littéral l'emporte sur un segment dynamique.
 */

// Jamais de réponse figée à la construction : une sonde doit mesurer l'instant présent.
export const dynamic = 'force-dynamic';

type HealthStatus = 'ok' | 'degraded' | 'down';

interface HealthCheck {
  readonly status: HealthStatus;
  readonly latencyMs?: number;
}

interface HealthBody {
  readonly status: HealthStatus;
  readonly version: string;
  readonly checkedAt: string;
  readonly checks: Readonly<Record<string, HealthCheck>>;
}

const UNKNOWN_VERSION = 'unknown';
const HTTP_STATUS_BY_HEALTH: Readonly<Record<HealthStatus, number>> = {
  ok: 200,
  degraded: 200,
  down: 503,
};

/**
 * Une configuration illisible rend l'instance inapte à servir. Le statut le dit, sans nommer la
 * variable fautive : le détail part dans les journaux, jamais dans la réponse.
 */
async function buildHealthBody(): Promise<HealthBody> {
  const checkedAt = new Date().toISOString();
  try {
    // La version est lue avant la sonde : une configuration illisible rend l'instance inapte
    // quoi qu'il arrive, inutile d'ouvrir une connexion pour le découvrir.
    const version = getServerConfig().appVersion;
    const database = await checkDatabase();
    return {
      status: database.status === 'ok' ? 'ok' : 'down',
      version,
      checkedAt,
      checks: { database: { status: database.status, latencyMs: database.latencyMs } },
    };
  } catch (error) {
    getRequestLogger().error(
      { err: error, errorCode: 'SERVICE_UNAVAILABLE' },
      'configuration serveur inutilisable, sonde de santé en échec',
    );
    return { status: 'down', version: UNKNOWN_VERSION, checkedAt, checks: {} };
  }
}

export const GET = defineRoute(
  async () => {
    const body = await buildHealthBody();
    return new Response(JSON.stringify(body), {
      status: HTTP_STATUS_BY_HEALTH[body.status],
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  },
  { isPublic: true },
);

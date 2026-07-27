import { defineRoute } from '@/application/api-route';
import { getServerConfig } from '@/config/env';
import { getRequestLogger } from '@/observability/logger';

/**
 * Sonde de santé, seule route publique du lot 0.
 *
 * Elle répond un statut, la version applicative et l'horodatage du contrôle au format ISO 8601
 * UTC (docs/api-contract.md, horodatages). Rien d'autre : ni version de dépendance, ni nom
 * d'hôte, ni chaîne de connexion, ni trace.
 *
 * L'objet `checks` est vide au lot 0 et sert de point d'extension : la sonde de base de données
 * relève de la story US-002 et viendra s'y ajouter sans changer la forme de la réponse.
 *
 * Cette route statique a priorité sur la route attrape-tout `/api/v1/[...segments]` : dans le
 * routeur de Next, un segment littéral l'emporte sur un segment dynamique.
 */

// Jamais de réponse figée à la construction : une sonde doit mesurer l'instant présent.
export const dynamic = 'force-dynamic';

type HealthStatus = 'ok' | 'degraded' | 'down';

interface HealthCheck {
  readonly status: HealthStatus;
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
function buildHealthBody(): HealthBody {
  const checkedAt = new Date().toISOString();
  try {
    return {
      status: 'ok',
      version: getServerConfig().appVersion,
      checkedAt,
      checks: {},
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
  () => {
    const body = buildHealthBody();
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

import type { ErrorCode } from '@/application/errors';
import { AppError, toErrorCode, toErrorResponse } from '@/application/errors';
import type { LogFields } from '@/observability/logger';
import { getRequestLogger } from '@/observability/logger';
import type { RequestContext } from '@/observability/request-context';
import { createRequestId, runWithRequestContext } from '@/observability/request-context';

/**
 * Enveloppe unique des routes d'API.
 *
 * Elle garantit, pour toute route, sans que l'auteur ait à y penser :
 * identifiant de requête, contexte de journalisation, refus par défaut (ADR-014),
 * limite de taille du corps, conversion normalisée des erreurs et trace de sortie.
 */

export interface RouteContext {
  readonly requestId: string;
  readonly request: Request;
}

export interface RouteOptions {
  /** Une route n'est ouverte que si elle le déclare explicitement. Défaut : `false`. */
  readonly isPublic?: boolean;
  /** Taille maximale acceptée pour le corps de la requête. Défaut : 64 kio. */
  readonly maxBodyBytes?: number;
}

export type RouteHandler = (context: RouteContext) => Promise<Response> | Response;

const DEFAULT_MAX_BODY_BYTES = 65_536;
const REQUEST_ID_HEADER = 'x-request-id';
const CONTENT_LENGTH_HEADER = 'content-length';

/**
 * Un identifiant fourni par l'appelant n'est repris que s'il respecte exactement le format émis
 * par la plateforme : sinon un client pourrait injecter du texte arbitraire dans les journaux.
 */
const REQUEST_ID_PATTERN = /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const UUID_SEGMENT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveRequestId(request: Request): string {
  const provided = request.headers.get(REQUEST_ID_HEADER);
  if (provided !== null && REQUEST_ID_PATTERN.test(provided)) {
    return provided;
  }
  return createRequestId();
}

/**
 * Remplace les segments variables du chemin par `:id`. Le journal porte ainsi le gabarit de la
 * route, exploitable en métrique, et non les identifiants techniques des objets consultés.
 */
function normalizeRoute(pathname: string): string {
  const segments = pathname.split('/').map((segment) => {
    if (UUID_SEGMENT_PATTERN.test(segment) || /^\d+$/.test(segment)) {
      return ':id';
    }
    return segment;
  });
  return segments.join('/');
}

function readRoute(request: Request): string {
  try {
    return normalizeRoute(new URL(request.url).pathname);
  } catch {
    return 'inconnue';
  }
}

/**
 * Mesure bornée d'un corps qui n'annonce pas sa taille, par exemple en
 * `Transfer-Encoding: chunked`. La lecture s'effectue sur un clone et s'arrête au premier octet
 * excédentaire : la mémoire consommée reste plafonnée par la limite elle-même.
 */
async function assertStreamWithinLimit(body: ReadableStream<Uint8Array>, max: number) {
  const reader = body.getReader();
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return;
      }
      total += chunk.value.byteLength;
      if (total > max) {
        throw new AppError('PAYLOAD_TOO_LARGE', { details: { maxBodyBytes: max } });
      }
    }
  } finally {
    // La lecture s'arrête ici : le flux restant est abandonné sans faire remonter d'erreur.
    void reader.cancel().catch(() => undefined);
  }
}

/**
 * Contrôle de taille du corps, annoncé ou non. Un en-tête `content-length` illisible est traité
 * comme une entrée invalide : la plateforme ne devine pas ce que l'appelant a voulu dire.
 */
async function assertBodyWithinLimit(request: Request, maxBodyBytes: number): Promise<void> {
  const declared = request.headers.get(CONTENT_LENGTH_HEADER);
  if (declared !== null) {
    const trimmed = declared.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new AppError('VALIDATION_ERROR', { details: { header: CONTENT_LENGTH_HEADER } });
    }
    const size = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(size) || size > maxBodyBytes) {
      throw new AppError('PAYLOAD_TOO_LARGE', { details: { maxBodyBytes } });
    }
    return;
  }
  if (request.body === null) {
    return;
  }
  // Le clone laisse le corps original intact pour le gestionnaire.
  const body = request.clone().body;
  if (body !== null) {
    await assertStreamWithinLimit(body, maxBodyBytes);
  }
}

/**
 * Recompose la réponse avec les en-têtes communs. La reconstruction évite d'échouer sur une
 * réponse dont les en-têtes seraient immuables.
 */
function withStandardHeaders(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  if (!headers.has('cache-control')) {
    // Défaut prudent pour une API authentifiée : une réponse ne doit pas être conservée.
    headers.set('cache-control', 'no-store');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function logOutcome(status: number, durationMs: number, errorCode: ErrorCode | undefined): void {
  const fields: LogFields = {
    status,
    durationMs,
    ...(errorCode !== undefined ? { errorCode } : {}),
  };
  const log = getRequestLogger();
  if (status >= 500) {
    log.error(fields, 'requête terminée en erreur');
    return;
  }
  if (status >= 400) {
    log.warn(fields, 'requête refusée');
    return;
  }
  log.info(fields, 'requête traitée');
}

/**
 * Déclare une route d'API. Le gestionnaire fourni n'est appelé que si la route est publique,
 * tant que l'authentification du lot 1 n'a pas remplacé ce refus systématique (ADR-014).
 */
export function defineRoute(
  handler: RouteHandler,
  options?: RouteOptions,
): (request: Request) => Promise<Response> {
  const isPublic = options?.isPublic ?? false;
  const maxBodyBytes = options?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async (request: Request): Promise<Response> => {
    const requestId = resolveRequestId(request);
    const context: RequestContext = {
      requestId,
      route: readRoute(request),
      method: request.method,
      startedAt: Date.now(),
    };

    return runWithRequestContext(context, async () => {
      let response: Response;
      let errorCode: ErrorCode | undefined;
      try {
        if (!isPublic) {
          // Refus par défaut : aucune route ne s'ouvre par omission.
          throw new AppError('UNAUTHENTICATED');
        }
        await assertBodyWithinLimit(request, maxBodyBytes);
        response = await handler({ requestId, request });
      } catch (error) {
        errorCode = toErrorCode(error);
        response = toErrorResponse(error, requestId);
      }
      logOutcome(response.status, Date.now() - context.startedAt, errorCode);
      return withStandardHeaders(response, requestId);
    });
  };
}

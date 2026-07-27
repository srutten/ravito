import { ZodError } from 'zod';
import { messages } from '@/i18n/fr';
import { getRequestLogger } from '@/observability/logger';

/**
 * Erreurs applicatives et format de réponse normalisé (docs/api-contract.md).
 *
 * Invariants :
 * - le message envoyé au client vient du catalogue français, jamais de `error.message` ;
 * - aucune pile d'appel, aucun chemin de fichier, aucune chaîne de connexion ne sort d'ici ;
 * - une erreur non identifiée devient `INTERNAL_ERROR` avec un message neutre et un statut 500.
 */

/** Codes stables exposés au client. Les treize premiers viennent de docs/api-contract.md. */
export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'ORGANIZATION_NOT_VERIFIED',
  'INVALID_TRANSITION',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'RESOURCE_UNAVAILABLE',
  'RESOURCE_ALREADY_ASSIGNED',
  'DOCUMENT_EXPIRED',
  'MEETING_POINT_REQUIRED',
  'REQUEST_EXPIRED',
  'RATE_LIMITED',
  'PLATFORM_READ_ONLY',
  // Codes de transport, nécessaires au routeur API et communs à toutes les routes.
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details: Record<string, unknown>;
  };
}

const DEFAULT_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  ORGANIZATION_NOT_VERIFIED: 403,
  INVALID_TRANSITION: 409,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  RESOURCE_UNAVAILABLE: 409,
  RESOURCE_ALREADY_ASSIGNED: 409,
  DOCUMENT_EXPIRED: 422,
  MEETING_POINT_REQUIRED: 422,
  REQUEST_EXPIRED: 409,
  RATE_LIMITED: 429,
  PLATFORM_READ_ONLY: 503,
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

/** Statut HTTP par défaut d'un code, utilisable par les couches qui n'instancient pas d'erreur. */
export function httpStatusForErrorCode(code: ErrorCode): number {
  return DEFAULT_HTTP_STATUS[code];
}

/** Libellé français neutre associé à un code. */
export function messageForErrorCode(code: ErrorCode): string {
  return messages.errors[code];
}

export interface AppErrorOptions {
  readonly httpStatus?: number;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, options?: AppErrorOptions) {
    // Le message porté par l'exception est déjà le libellé public : rien à traduire plus tard.
    super(messageForErrorCode(code), options?.cause !== undefined ? { cause: options.cause } : {});
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = options?.httpStatus ?? DEFAULT_HTTP_STATUS[code];
    this.details = options?.details ?? {};
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Détails de validation réduits aux chemins des champs fautifs. Les valeurs reçues ne sont
 * jamais renvoyées : un champ invalide peut contenir un mot de passe ou un numéro de téléphone.
 */
function toValidationDetails(error: ZodError): Record<string, unknown> {
  const fields = error.issues.map((issue) =>
    issue.path.length > 0 ? issue.path.map(String).join('.') : '(racine)',
  );
  return { fields: [...new Set(fields)] };
}

function buildBody(
  code: ErrorCode,
  requestId: string,
  details: Record<string, unknown>,
): ErrorBody {
  return { error: { code, message: messageForErrorCode(code), requestId, details } };
}

/** Code exposé pour une exception donnée. Tout ce qui n'est pas identifié devient interne. */
export function toErrorCode(error: unknown): ErrorCode {
  if (isAppError(error)) {
    return error.code;
  }
  if (error instanceof ZodError) {
    return 'VALIDATION_ERROR';
  }
  return 'INTERNAL_ERROR';
}

/**
 * Convertit n'importe quelle exception en corps d'erreur normalisé. Une exception inconnue est
 * journalisée avec sa cause réelle, puis remplacée par un message neutre côté client.
 */
export function toErrorBody(error: unknown, requestId: string): ErrorBody {
  const code = toErrorCode(error);
  if (isAppError(error)) {
    return buildBody(code, requestId, error.details);
  }
  if (error instanceof ZodError) {
    return buildBody(code, requestId, toValidationDetails(error));
  }
  getRequestLogger().error(
    { err: error, errorCode: code, requestId },
    'erreur non identifiée convertie en erreur interne',
  );
  return buildBody(code, requestId, {});
}

function httpStatusFor(error: unknown): number {
  return isAppError(error) ? error.httpStatus : DEFAULT_HTTP_STATUS[toErrorCode(error)];
}

/** Réponse HTTP normalisée. Jamais mise en cache : elle dépend de l'appelant et du moment. */
export function toErrorResponse(error: unknown, requestId: string): Response {
  const body = toErrorBody(error, requestId);
  return new Response(JSON.stringify(body), {
    status: httpStatusFor(error),
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-request-id': requestId,
    },
  });
}

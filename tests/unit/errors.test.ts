import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ErrorBody } from '@/application/errors';
import { AppError, ERROR_CODES, toErrorBody, toErrorResponse } from '@/application/errors';
import { messages } from '@/i18n/fr';
import { logger } from '@/observability/logger';

/**
 * Formateur d'erreur (docs/api-contract.md, US-001 critères 12 et 14).
 *
 * Le format est un contrat public : quatre champs, toujours les mêmes. Le test négatif vérifie
 * qu'aucune information interne ne franchit la frontière : ni pile d'appel, ni chemin de fichier,
 * ni chaîne de connexion, ni message d'exception d'origine.
 */

const REQUEST_ID = 'req_11111111-2222-4333-8444-555555555555';

/**
 * Empreintes internes qui ne doivent jamais sortir. Les valeurs sont fictives, mais leur forme
 * est exactement celle qu'une exception réelle ferait remonter.
 */
const INTERNAL_LEAKS = {
  connectionString: 'postgresql://utilisateur:motdepasse-fictif@base-interne.local:5432/appui_feux',
  filePath: 'C:\\Data\\ravito\\fire-support-platform\\src\\infrastructure\\database\\pool.ts',
  posixPath: '/var/app/src/infrastructure/database/pool.ts',
  hostname: 'base-interne.local',
  driverDetail: 'ECONNREFUSED 10.0.0.12:5432',
} as const;

function internalFailure(): Error {
  return new Error(
    `connexion refusée vers ${INTERNAL_LEAKS.connectionString} depuis ` +
      `${INTERNAL_LEAKS.filePath} (${INTERNAL_LEAKS.driverDetail})`,
  );
}

function bodyKeys(body: ErrorBody): string[] {
  return Object.keys(body.error).sort();
}

describe('catalogue de codes', () => {
  it('couvre les codes principaux de docs/api-contract.md', () => {
    const documented = [
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
    ];

    for (const code of documented) {
      expect(ERROR_CODES).toContain(code);
    }
  });

  it('associe à chaque code un libellé français non vide et sans détail technique', () => {
    for (const code of ERROR_CODES) {
      const message = messages.errors[code];
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain(code);
      expect(message).not.toMatch(/https?:\/\/|postgres|\.ts|Error:/i);
    }
  });
});

describe('toErrorBody', () => {
  it('produit exactement les quatre champs du contrat', () => {
    const body = toErrorBody(new AppError('RESOURCE_ALREADY_ASSIGNED'), REQUEST_ID);

    expect(bodyKeys(body)).toStrictEqual(['code', 'details', 'message', 'requestId']);
    expect(body.error.code).toBe('RESOURCE_ALREADY_ASSIGNED');
    expect(body.error.message).toBe(messages.errors.RESOURCE_ALREADY_ASSIGNED);
    expect(body.error.requestId).toBe(REQUEST_ID);
    expect(body.error.details).toStrictEqual({});
  });

  it('conserve le code et les détails d une erreur applicative connue', () => {
    const body = toErrorBody(
      new AppError('VERSION_CONFLICT', { details: { expectedVersion: 3, currentVersion: 4 } }),
      REQUEST_ID,
    );

    expect(body.error.code).toBe('VERSION_CONFLICT');
    expect(body.error.details).toStrictEqual({ expectedVersion: 3, currentVersion: 4 });
  });
});

describe('erreur inconnue', () => {
  const initialLevel = logger.level;

  beforeAll(() => {
    // La conversion d'une erreur inconnue journalise sa cause réelle : ce bruit n'apporte rien
    // à la lecture du rapport de test, l'assertion porte sur la réponse, pas sur le journal.
    logger.level = 'silent';
  });

  afterAll(() => {
    logger.level = initialLevel;
  });

  it('devient un code générique avec le statut 500 et un message neutre', async () => {
    const response = toErrorResponse(internalFailure(), REQUEST_ID);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe(messages.errors.INTERNAL_ERROR);
    expect(body.error.details).toStrictEqual({});
  });

  it('ne laisse sortir ni pile d appel, ni chemin de fichier, ni chaîne de connexion', async () => {
    const failure = internalFailure();
    const response = toErrorResponse(failure, REQUEST_ID);
    const payload = await response.text();

    for (const [name, leak] of Object.entries(INTERNAL_LEAKS)) {
      expect(payload, `la trace interne ${name} a fuité dans la réponse`).not.toContain(leak);
    }
    expect(payload).not.toContain(failure.message);
    expect(payload).not.toContain('at ');
    expect(payload).not.toContain('stack');
    expect(payload).not.toContain('Error');
  });

  it('traite de la même façon une valeur levée qui n est pas une exception', async () => {
    const response = toErrorResponse({ motDePasse: INTERNAL_LEAKS.connectionString }, REQUEST_ID);
    const payload = await response.text();

    expect(response.status).toBe(500);
    expect(payload).not.toContain(INTERNAL_LEAKS.connectionString);
    expect(JSON.parse(payload)).toStrictEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: messages.errors.INTERNAL_ERROR,
        requestId: REQUEST_ID,
        details: {},
      },
    });
  });
});

describe('toErrorResponse', () => {
  it('applique le statut HTTP du code et les en-têtes de transport', async () => {
    const response = toErrorResponse(new AppError('UNAUTHENTICATED'), REQUEST_ID);

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toBe(REQUEST_ID);
    expect(((await response.json()) as ErrorBody).error.requestId).toBe(REQUEST_ID);
  });

  it('respecte un statut HTTP explicitement demandé', () => {
    const response = toErrorResponse(new AppError('FORBIDDEN', { httpStatus: 404 }), REQUEST_ID);

    expect(response.status).toBe(404);
  });

  it('associe à chaque code un statut HTTP dans la plage des erreurs', async () => {
    for (const code of ERROR_CODES) {
      const response = toErrorResponse(new AppError(code), REQUEST_ID);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(600);
      expect(((await response.json()) as ErrorBody).error.code).toBe(code);
    }
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineRoute } from '@/application/api-route';
import type { ErrorBody } from '@/application/errors';
import { messages } from '@/i18n/fr';
import { logger } from '@/observability/logger';
import { DELETE, GET, PATCH, POST, PUT } from '../../app/api/v1/[...segments]/route';

/**
 * Refus par défaut du routeur d'API (US-001 critère 13, docs/permissions.md, docs/security.md).
 *
 * Ce fichier est le test négatif d'autorisation du lot 0 : il vérifie qu'un appel direct à une
 * adresse que l'interface n'expose pas est refusé côté serveur. Masquer un bouton n'est pas une
 * autorisation ; seule la réponse du serveur fait foi.
 */

const REQUEST_ID_PATTERN = /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE_URL = 'https://appui-feux.exemple.test';

type RouteHandlerExport = (request: Request) => Promise<Response>;

const HANDLERS: readonly (readonly [string, RouteHandlerExport])[] = [
  ['GET', GET],
  ['POST', POST],
  ['PATCH', PATCH],
  ['PUT', PUT],
  ['DELETE', DELETE],
];

/** Adresses volontairement variées : documentées, masquées par l'interface, ou inexistantes. */
const PATHS = [
  '/api/v1/resources',
  '/api/v1/requests',
  '/api/v1/missions/11111111-2222-4333-8444-555555555555',
  '/api/v1/admin/organizations/pending',
  '/api/v1/adresse-inexistante',
];

async function readBody(response: Response): Promise<ErrorBody> {
  return (await response.json()) as ErrorBody;
}

describe('routes non déclarées publiques', () => {
  const initialLevel = logger.level;

  beforeAll(() => {
    // Chaque refus produit une ligne d'avertissement : c'est le comportement voulu, mais il n'a
    // pas sa place dans le rapport de test.
    logger.level = 'silent';
  });

  afterAll(() => {
    logger.level = initialLevel;
  });

  for (const [method, handler] of HANDLERS) {
    it(`refuse ${method} avec UNAUTHENTICATED et le statut 401`, async () => {
      const response = await handler(new Request(`${BASE_URL}/api/v1/resources`, { method }));
      const body = await readBody(response);

      expect(response.status).toBe(401);
      expect(body.error.code).toBe('UNAUTHENTICATED');
      expect(body.error.message).toBe(messages.errors.UNAUTHENTICATED);
      expect(body.error.details).toStrictEqual({});
      expect(body.error.requestId).toMatch(REQUEST_ID_PATTERN);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-request-id')).toBe(body.error.requestId);
    });
  }

  for (const path of PATHS) {
    it(`refuse GET ${path} sans révéler si l adresse existe`, async () => {
      const response = await GET(new Request(`${BASE_URL}${path}`));
      const payload = await response.text();

      expect(response.status).toBe(401);
      expect(payload).toContain('UNAUTHENTICATED');
      // Répondre 404 sur les adresses inconnues permettrait d'énumérer l'API sans compte.
      expect(payload).not.toContain('NOT_FOUND');
      expect(payload).not.toContain('FORBIDDEN');
    });
  }

  it('refuse avant même de lire le corps de la requête', async () => {
    const sentinel = 'sentinelle-charge-utile-Z9X8C7';
    const request = new Request(`${BASE_URL}/api/v1/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commentaire: sentinel }),
    });

    const response = await POST(request);
    const payload = await response.text();

    expect(response.status).toBe(401);
    // Le corps n'a pas été consommé : le refus précède tout traitement de la charge utile.
    expect(request.bodyUsed).toBe(false);
    expect(payload).not.toContain(sentinel);
  });

  it('refuse même lorsque l appelant présente un jeton fabriqué', async () => {
    const response = await GET(
      new Request(`${BASE_URL}/api/v1/resources`, {
        headers: {
          authorization: 'Bearer sentinelle-jeton-fabrique-Q7W6',
          cookie: 'session=sentinelle-session-fabriquee-R4T3',
          'x-role': 'ADMIN',
          'x-organization-id': 'org-fictive-001',
        },
      }),
    );

    expect(response.status).toBe(401);
    expect((await readBody(response)).error.code).toBe('UNAUTHENTICATED');
  });

  it('produit un identifiant de requête distinct à chaque appel', async () => {
    const first = await readBody(await GET(new Request(`${BASE_URL}/api/v1/resources`)));
    const second = await readBody(await GET(new Request(`${BASE_URL}/api/v1/resources`)));

    expect(second.error.requestId).not.toBe(first.error.requestId);
  });
});

describe('defineRoute', () => {
  const initialLevel = logger.level;

  beforeAll(() => {
    logger.level = 'silent';
  });

  afterAll(() => {
    logger.level = initialLevel;
  });

  it('n appelle jamais le gestionnaire d une route non publique', async () => {
    const handler = vi.fn(() => new Response('ne doit jamais être atteint'));
    const route = defineRoute(handler);

    const response = await route(new Request(`${BASE_URL}/api/v1/secret`));

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuse par défaut lorsque l ouverture n est pas explicite', async () => {
    const handler = vi.fn(() => new Response('{}', { status: 200 }));

    const denied = await defineRoute(handler, { maxBodyBytes: 1024 })(
      new Request(`${BASE_URL}/api/v1/secret`),
    );
    const allowed = await defineRoute(handler, { isPublic: true })(
      new Request(`${BASE_URL}/api/v1/ouvert`),
    );

    expect(denied.status).toBe(401);
    expect(allowed.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

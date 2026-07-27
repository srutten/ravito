import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineRoute } from '@/application/api-route';
import type { ErrorBody } from '@/application/errors';
import { logger } from '@/observability/logger';

/**
 * Limite de taille du corps de requête (docs/security.md, sécurité API).
 *
 * Sans plafond, un appelant impose au serveur la mémoire qu'il veut : c'est un déni de service à
 * coût nul pour l'attaquant (docs/threat-model.md, menaces prioritaires).
 */

const BASE_URL = 'https://appui-feux.exemple.test';
const SMALL_LIMIT = 64;

function jsonRoute(maxBodyBytes?: number) {
  return defineRoute(
    async ({ request }) => {
      const received = await request.text();
      return new Response(JSON.stringify({ receivedBytes: received.length }), { status: 200 });
    },
    { isPublic: true, ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}) },
  );
}

function postRequest(body: string, headers?: Record<string, string>): Request {
  return new Request(`${BASE_URL}/api/v1/ouvert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('limite de taille du corps', () => {
  const initialLevel = logger.level;

  beforeAll(() => {
    logger.level = 'silent';
  });

  afterAll(() => {
    logger.level = initialLevel;
  });

  it('accepte un corps sous la limite et le laisse lisible par le gestionnaire', async () => {
    const body = JSON.stringify({ commentaire: 'court' });

    const response = await jsonRoute(SMALL_LIMIT)(postRequest(body));

    expect(response.status).toBe(200);
    expect(((await response.json()) as { receivedBytes: number }).receivedBytes).toBe(body.length);
  });

  it('refuse un corps annoncé au-delà de la limite, sans le lire', async () => {
    const request = postRequest('{}', { 'content-length': String(SMALL_LIMIT + 1) });

    const response = await jsonRoute(SMALL_LIMIT)(request);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(413);
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(request.bodyUsed).toBe(false);
  });

  it('refuse un corps qui dépasse la limite sans annoncer sa taille', async () => {
    const handler = vi.fn(() => new Response('{}', { status: 200 }));
    const route = defineRoute(handler, { isPublic: true, maxBodyBytes: SMALL_LIMIT });

    const response = await route(postRequest(JSON.stringify({ charge: 'x'.repeat(500) })));
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(413);
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuse une annonce de taille illisible plutôt que de la deviner', async () => {
    const response = await jsonRoute(SMALL_LIMIT)(
      postRequest('{}', { 'content-length': 'beaucoup' }),
    );
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('applique une limite par défaut lorsqu aucune n est déclarée', async () => {
    const oversized = JSON.stringify({ charge: 'x'.repeat(70_000) });

    const response = await jsonRoute()(postRequest(oversized));

    expect(response.status).toBe(413);
  });

  it('ne divulgue pas le contenu refusé', async () => {
    const sentinel = 'sentinelle-charge-utile-Z9X8C7';
    const payload = JSON.stringify({ commentaire: `${sentinel}${'x'.repeat(500)}` });

    const response = await jsonRoute(SMALL_LIMIT)(postRequest(payload));
    const text = await response.text();

    expect(text).not.toContain(sentinel);
  });
});

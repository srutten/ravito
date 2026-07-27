import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * En-têtes de sécurité et politique de sécurité du contenu (docs/security.md, sécurité API).
 *
 * `middleware.ts` lit `APP_ENV` et `NODE_ENV` au chargement du module : chaque scénario recharge
 * donc le module après avoir posé son environnement.
 *
 * Portée de ce fichier : le middleware lui-même. Que le serveur Next applique bien ces en-têtes
 * sur une réponse réelle, ressources statiques comprises, relève du test end-to-end
 * `tests/e2e/security-headers.spec.ts`, seul endroit où un vrai serveur répond.
 */

const BASE_URL = 'https://appui-feux.exemple.test';
const REQUEST_ID_PATTERN = /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VALID_REQUEST_ID = 'req_11111111-2222-4333-8444-555555555555';

type Middleware = (request: NextRequest) => { status: number; headers: Headers };

/** Recharge le middleware avec l'environnement voulu et construit une requête à lui soumettre. */
async function loadMiddleware(appEnvironment: string | undefined): Promise<Middleware> {
  vi.resetModules();
  if (appEnvironment === undefined) {
    delete process.env.APP_ENV;
  } else {
    process.env.APP_ENV = appEnvironment;
  }
  const module_ = await import('../../middleware');
  return module_.middleware as unknown as Middleware;
}

async function buildRequest(path: string, init?: RequestInit): Promise<NextRequest> {
  const { NextRequest: NextRequestClass } = await import('next/server');
  return new NextRequestClass(new Request(`${BASE_URL}${path}`, init));
}

function directives(headers: Headers): Map<string, string> {
  const policy = headers.get('content-security-policy') ?? '';
  const entries = policy
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const [name, ...values] = part.split(' ');
      return [name ?? '', values.join(' ')] as const;
    });
  return new Map(entries);
}

describe('en-têtes de sécurité', () => {
  const initialEnvironment = { ...process.env };

  beforeEach(() => {
    process.env.APP_ENV = 'production';
  });

  afterEach(() => {
    vi.resetModules();
    for (const key of Object.keys(process.env)) {
      if (!(key in initialEnvironment)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, initialEnvironment);
  });

  it('pose les en-têtes de durcissement sur une page', async () => {
    const middleware = await loadMiddleware('production');

    const { headers } = middleware(await buildRequest('/'));

    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(headers.get('permissions-policy')).toContain('geolocation=()');
    expect(headers.get('permissions-policy')).toContain('camera=()');
    expect(headers.get('permissions-policy')).toContain('microphone=()');
  });

  it('pose la même politique sur une route d API', async () => {
    const middleware = await loadMiddleware('production');

    const { headers } = middleware(await buildRequest('/api/v1/health'));

    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('content-security-policy')).not.toBeNull();
  });

  it('interdit le cadrage, l exécution de greffons et la réécriture de la base', async () => {
    const middleware = await loadMiddleware('production');

    const policy = directives(middleware(await buildRequest('/')).headers);

    expect(policy.get('default-src')).toBe("'self'");
    expect(policy.get('object-src')).toBe("'none'");
    expect(policy.get('frame-src')).toBe("'none'");
    expect(policy.get('frame-ancestors')).toBe("'none'");
    expect(policy.get('base-uri')).toBe("'self'");
    expect(policy.get('form-action')).toBe("'self'");
  });

  it('n autorise les scripts que par nonce, sans évaluation dynamique', async () => {
    const middleware = await loadMiddleware('production');

    const { headers } = middleware(await buildRequest('/'));
    const scriptSrc = directives(headers).get('script-src') ?? '';

    expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain('*');
    // Le nonce est transmis à l'application, seul moyen d'autoriser un script en ligne.
    expect(headers.get('x-middleware-request-x-nonce')).not.toBeNull();
  });

  it('renouvelle le nonce à chaque requête', async () => {
    const middleware = await loadMiddleware('production');

    const first = middleware(await buildRequest('/')).headers.get('x-middleware-request-x-nonce');
    const second = middleware(await buildRequest('/')).headers.get('x-middleware-request-x-nonce');

    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('exige le transport chiffré hors environnement local', async () => {
    const middleware = await loadMiddleware('production');

    const { headers } = middleware(await buildRequest('/'));

    expect(headers.get('strict-transport-security')).toContain('max-age=31536000');
    expect(headers.get('strict-transport-security')).toContain('includeSubDomains');
    expect(headers.get('content-security-policy')).toContain('upgrade-insecure-requests');
  });

  it('n impose pas le transport chiffré sur un poste local', async () => {
    const middleware = await loadMiddleware('local');

    const { headers } = middleware(await buildRequest('/'));

    expect(headers.get('strict-transport-security')).toBeNull();
    expect(headers.get('content-security-policy')).not.toContain('upgrade-insecure-requests');
  });

  it('retient le réglage le plus strict quand l environnement est inconnu', async () => {
    const middleware = await loadMiddleware(undefined);

    const { headers } = middleware(await buildRequest('/'));

    expect(headers.get('strict-transport-security')).toContain('max-age=');
    expect(headers.get('content-security-policy')).toContain('upgrade-insecure-requests');
  });

  it('pose un identifiant de requête et rejette un identifiant mal formé', async () => {
    const middleware = await loadMiddleware('production');

    const generated = middleware(await buildRequest('/api/v1/health')).headers.get('x-request-id');
    const reused = middleware(
      await buildRequest('/api/v1/health', { headers: { 'x-request-id': VALID_REQUEST_ID } }),
    ).headers.get('x-request-id');
    const rejected = middleware(
      await buildRequest('/api/v1/health', { headers: { 'x-request-id': 'valeur forgee' } }),
    ).headers.get('x-request-id');

    expect(generated).toMatch(REQUEST_ID_PATTERN);
    expect(reused).toBe(VALID_REQUEST_ID);
    expect(rejected).toMatch(REQUEST_ID_PATTERN);
    expect(rejected).not.toBe('valeur forgee');
  });
});

describe('politique de partage entre origines', () => {
  const initialEnvironment = { ...process.env };

  afterEach(() => {
    vi.resetModules();
    for (const key of Object.keys(process.env)) {
      if (!(key in initialEnvironment)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, initialEnvironment);
  });

  it('n autorise aucune origine tierce, et surtout aucun joker', async () => {
    const middleware = await loadMiddleware('production');

    const { headers } = middleware(
      await buildRequest('/api/v1/health', { headers: { origin: 'https://site-tiers.exemple' } }),
    );

    for (const [name, value] of headers.entries()) {
      expect(name.startsWith('access-control-allow-'), `en-tête inattendu : ${name}`).toBe(false);
      expect(value, `joker dans l en-tête ${name}`).not.toContain('*');
    }
    expect(headers.get('vary')).toContain('Origin');
  });

  it('répond au contrôle préalable sans rien autoriser', async () => {
    const middleware = await loadMiddleware('production');

    const response = middleware(
      await buildRequest('/api/v1/requests', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://site-tiers.exemple',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization',
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-methods')).toBeNull();
    expect(response.headers.get('access-control-allow-headers')).toBeNull();
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    // Le durcissement reste posé, y compris sur une réponse sans corps.
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-request-id')).toMatch(REQUEST_ID_PATTERN);
  });
});

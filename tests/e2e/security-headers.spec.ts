import { expect, test } from '@playwright/test';

/**
 * En-têtes de sécurité observés sur un serveur réel (docs/security.md, sécurité API).
 *
 * Complément indispensable à `tests/integration/security-headers.test.ts` : ce dernier vérifie ce
 * que `middleware.ts` produit, celui-ci vérifie ce que le serveur Next envoie effectivement, y
 * compris sur les fichiers statiques et sur les scripts qu'il injecte lui-même.
 *
 * Les directives dépendantes de l'environnement, comme `Strict-Transport-Security`, ne sont pas
 * affirmées ici : elles dépendent de `APP_ENV`, que le poste qui exécute la suite ne fixe pas
 * forcément. Elles sont couvertes par le test d'intégration, qui maîtrise cette variable.
 */

const REQUEST_ID_PATTERN = /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function policyDirectives(policy: string): Map<string, string> {
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

test.describe('en-têtes de sécurité du serveur', () => {
  test('durcit la réponse de l accueil public', async ({ request }) => {
    const response = await request.get('/');
    const headers = response.headers();

    expect(response.status()).toBe(200);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(headers['permissions-policy']).toContain('geolocation=()');
    expect(headers['x-request-id']).toMatch(REQUEST_ID_PATTERN);
  });

  test('applique une politique de sécurité du contenu stricte', async ({ request }) => {
    const response = await request.get('/');
    const policy = policyDirectives(response.headers()['content-security-policy'] ?? '');

    expect(policy.get('default-src')).toBe("'self'");
    expect(policy.get('object-src')).toBe("'none'");
    expect(policy.get('frame-ancestors')).toBe("'none'");
    expect(policy.get('base-uri')).toBe("'self'");
    expect(policy.get('form-action')).toBe("'self'");

    const scriptSrc = policy.get('script-src') ?? '';
    expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain('*');
  });

  test('donne un nonce à chacun de ses scripts', async ({ request }) => {
    const response = await request.get('/');
    const html = await response.text();
    const scriptSrc =
      policyDirectives(response.headers()['content-security-policy'] ?? '').get('script-src') ?? '';
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(scriptSrc)?.[1];

    expect(nonce).toBeDefined();
    const scriptTags = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scriptTags.length).toBeGreaterThan(0);
    const withoutNonce = scriptTags.filter((tag) => !tag.includes(`nonce="${nonce}"`));
    expect(
      withoutNonce,
      'un script sans nonce serait bloqué ou révélerait une faille',
    ).toStrictEqual([]);
  });

  test('durcit aussi les fichiers statiques', async ({ request, baseURL }) => {
    const html = await (await request.get('/')).text();
    const staticPath = /\/_next\/static\/[^"']+\.js/.exec(html)?.[0];
    expect(staticPath, 'aucun fichier statique trouvé dans la page').toBeDefined();

    const response = await request.get(`${baseURL ?? ''}${staticPath ?? ''}`);

    expect(response.status()).toBe(200);
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
    expect(response.headers()['content-security-policy']).toBeDefined();
  });

  test('n autorise aucune origine tierce', async ({ request }) => {
    const response = await request.get('/api/v1/health', {
      headers: { origin: 'https://site-tiers.exemple' },
    });

    for (const [name, value] of Object.entries(response.headers())) {
      expect(name.startsWith('access-control-allow-'), `en-tête inattendu : ${name}`).toBe(false);
      if (name === 'content-security-policy' || name.startsWith('vary')) {
        continue;
      }
      expect(value, `joker dans l en-tête ${name}`).not.toContain('*');
    }
  });

  test('répond au contrôle préalable sans rien autoriser', async ({ request }) => {
    const response = await request.fetch('/api/v1/requests', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://site-tiers.exemple',
        'access-control-request-method': 'POST',
      },
    });

    expect(response.status()).toBe(204);
    expect(response.headers()['access-control-allow-origin']).toBeUndefined();
    expect(response.headers()['access-control-allow-methods']).toBeUndefined();
    expect(response.headers().vary).toContain('Origin');
  });

  test('refuse une route non publique et renvoie le format d erreur normalisé', async ({
    request,
  }) => {
    for (const method of ['get', 'post', 'patch', 'put', 'delete'] as const) {
      const response = await request.fetch('/api/v1/resources', { method });
      const body = (await response.json()) as {
        error: { code: string; message: string; requestId: string; details: unknown };
      };

      expect(response.status(), method).toBe(401);
      expect(body.error.code).toBe('UNAUTHENTICATED');
      expect(body.error.requestId).toMatch(REQUEST_ID_PATTERN);
      expect(body.error.details).toStrictEqual({});
      expect(response.headers()['x-request-id']).toBe(body.error.requestId);
    }
  });
});

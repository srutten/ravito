import { afterEach, describe, expect, it } from 'vitest';
import type { RequestContext } from '@/observability/request-context';
import {
  createRequestId,
  getRequestContext,
  getRequestId,
  pseudonymizeUserId,
  runWithRequestContext,
} from '@/observability/request-context';

/**
 * Contexte de requête (US-001 critère 11).
 *
 * Deux propriétés comptent : un identifiant stable pendant toute la durée d'une requête, et une
 * étanchéité totale entre requêtes. Un mélange de contextes ferait porter une trace à la mauvaise
 * personne, ce qui est un défaut de sécurité autant qu'un défaut de diagnostic.
 */

const REQUEST_ID_PATTERN = /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USER_HASH_PATTERN = /^usr_[0-9a-f]{32}$/;

function contextFor(requestId: string, route: string): RequestContext {
  return { requestId, route, method: 'GET', startedAt: 0 };
}

describe('createRequestId', () => {
  it('produit un identifiant préfixé et non devinable', () => {
    expect(createRequestId()).toMatch(REQUEST_ID_PATTERN);
  });

  it('produit un identifiant différent à chaque appel', () => {
    const identifiers = new Set(Array.from({ length: 200 }, () => createRequestId()));

    expect(identifiers.size).toBe(200);
  });
});

describe('runWithRequestContext', () => {
  it('rend le contexte disponible sans le passer en paramètre', () => {
    const context = contextFor(createRequestId(), '/api/v1/health');

    runWithRequestContext(context, () => {
      expect(getRequestContext()).toBe(context);
      expect(getRequestId()).toBe(context.requestId);
    });
  });

  it('garde le même identifiant après une frontière asynchrone', async () => {
    const context = contextFor(createRequestId(), '/api/v1/requests');

    await runWithRequestContext(context, async () => {
      const before = getRequestId();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(getRequestId()).toBe(before);
      expect(getRequestId()).toBe(context.requestId);
    });
  });

  it('ne mélange pas deux contextes imbriqués', () => {
    const outer = contextFor(createRequestId(), '/api/v1/requests');
    const inner = contextFor(createRequestId(), '/api/v1/offers');

    runWithRequestContext(outer, () => {
      expect(getRequestId()).toBe(outer.requestId);
      runWithRequestContext(inner, () => {
        expect(getRequestId()).toBe(inner.requestId);
        expect(getRequestContext()?.route).toBe('/api/v1/offers');
      });
      // Le contexte externe est restauré à la sortie du contexte imbriqué.
      expect(getRequestId()).toBe(outer.requestId);
      expect(getRequestContext()?.route).toBe('/api/v1/requests');
    });
  });

  it('ne mélange pas deux contextes concurrents', async () => {
    const first = contextFor(createRequestId(), '/api/v1/requests');
    const second = contextFor(createRequestId(), '/api/v1/missions');

    const observe = async (context: RequestContext, delayMs: number): Promise<string[]> =>
      runWithRequestContext(context, async () => {
        const seen = [getRequestId() ?? 'absent'];
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        seen.push(getRequestId() ?? 'absent');
        return seen;
      });

    const [firstSeen, secondSeen] = await Promise.all([observe(first, 5), observe(second, 1)]);

    expect(firstSeen).toStrictEqual([first.requestId, first.requestId]);
    expect(secondSeen).toStrictEqual([second.requestId, second.requestId]);
  });

  it('ne laisse aucun contexte résiduel hors requête', () => {
    runWithRequestContext(contextFor(createRequestId(), '/api/v1/health'), () => undefined);

    expect(getRequestContext()).toBeUndefined();
    expect(getRequestId()).toBeUndefined();
  });

  it('restaure l absence de contexte même si la fonction lève', () => {
    expect(() =>
      runWithRequestContext(contextFor(createRequestId(), '/api/v1/health'), () => {
        throw new Error('échec applicatif');
      }),
    ).toThrow('échec applicatif');
    expect(getRequestContext()).toBeUndefined();
  });
});

describe('pseudonymizeUserId', () => {
  const initialSecret = process.env.AUTH_SECRET;

  afterEach(() => {
    if (initialSecret === undefined) {
      delete process.env.AUTH_SECRET;
      return;
    }
    process.env.AUTH_SECRET = initialSecret;
  });

  it('produit un pseudonyme stable pour un même identifiant', () => {
    process.env.AUTH_SECRET = 'secret-de-test-fictif-de-plus-de-32-caracteres';

    const first = pseudonymizeUserId('utilisateur-fictif-001');
    const second = pseudonymizeUserId('utilisateur-fictif-001');

    expect(second).toBe(first);
    expect(first).toMatch(USER_HASH_PATTERN);
  });

  it('distingue deux identifiants différents', () => {
    process.env.AUTH_SECRET = 'secret-de-test-fictif-de-plus-de-32-caracteres';

    expect(pseudonymizeUserId('utilisateur-fictif-001')).not.toBe(
      pseudonymizeUserId('utilisateur-fictif-002'),
    );
  });

  it('ne restitue jamais l identifiant d origine', () => {
    process.env.AUTH_SECRET = 'secret-de-test-fictif-de-plus-de-32-caracteres';
    const userId = 'utilisateur-fictif-003@exemple.test';

    const pseudonym = pseudonymizeUserId(userId);

    expect(pseudonym).not.toContain(userId);
    expect(pseudonym).not.toContain('exemple.test');
    expect(pseudonym).not.toContain('utilisateur');
    // Rien d'exploitable ne se déduit de la longueur : elle est constante.
    expect(pseudonymizeUserId('a')).toHaveLength(pseudonym.length);
  });

  it('ne divulgue pas le secret qui sert de poivre', () => {
    const secret = 'sentinelle-poivre-fictif-de-plus-de-32-caracteres';
    process.env.AUTH_SECRET = secret;

    expect(pseudonymizeUserId('utilisateur-fictif-004')).not.toContain(secret);
  });

  it('change de pseudonyme lorsque le poivre change', () => {
    process.env.AUTH_SECRET = 'premier-secret-fictif-de-plus-de-32-caracteres';
    const withFirstSecret = pseudonymizeUserId('utilisateur-fictif-005');

    process.env.AUTH_SECRET = 'second-secret-fictif-de-plus-de-32-caracteres';
    const withSecondSecret = pseudonymizeUserId('utilisateur-fictif-005');

    expect(withSecondSecret).not.toBe(withFirstSecret);
  });
});

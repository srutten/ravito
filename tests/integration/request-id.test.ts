import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ErrorBody } from '@/application/errors';
import { resetServerConfigCache } from '@/config/env';
import { logger } from '@/observability/logger';
import { GET as CATCH_ALL_GET } from '../../app/api/v1/[...segments]/route';
import { GET as HEALTH_GET } from '../../app/api/v1/health/route';

/**
 * Identifiant de requête (docs/security.md, sécurité API ; docs/api-contract.md, format d'erreur).
 *
 * Sans identifiant corrélable, une personne qui signale une anomalie ne peut pas être aidée sans
 * fouiller les journaux d'autrui. L'identifiant doit donc être présent sur toute réponse, y
 * compris sur un refus.
 */

const REQUEST_ID_PATTERN = /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE_URL = 'https://appui-feux.exemple.test';
const VALID_REQUEST_ID = 'req_11111111-2222-4333-8444-555555555555';

describe('identifiant de requête sur la réponse', () => {
  const initialEnvironment = { ...process.env };
  const initialLevel = logger.level;

  beforeAll(() => {
    logger.level = 'silent';
  });

  afterAll(() => {
    logger.level = initialLevel;
  });

  beforeEach(() => {
    process.env.APP_ENV = 'local';
    process.env.APP_VERSION = '0.0.0-test';
    process.env.DATABASE_URL = 'postgresql://utilisateur:motdepasse-fictif@localhost:5432/appui';
    resetServerConfigCache();
  });

  afterEach(() => {
    resetServerConfigCache();
    for (const key of Object.keys(process.env)) {
      if (!(key in initialEnvironment)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, initialEnvironment);
  });

  it('pose un identifiant sur une réponse réussie', async () => {
    const response = await HEALTH_GET(new Request(`${BASE_URL}/api/v1/health`));

    expect(response.headers.get('x-request-id')).toMatch(REQUEST_ID_PATTERN);
  });

  it('pose le même identifiant dans l en-tête et dans le corps d erreur', async () => {
    const response = await CATCH_ALL_GET(new Request(`${BASE_URL}/api/v1/resources`));
    const body = (await response.json()) as ErrorBody;

    expect(response.headers.get('x-request-id')).toBe(body.error.requestId);
    expect(body.error.requestId).toMatch(REQUEST_ID_PATTERN);
  });

  it('reprend un identifiant fourni lorsqu il respecte le format de la plateforme', async () => {
    const response = await HEALTH_GET(
      new Request(`${BASE_URL}/api/v1/health`, { headers: { 'x-request-id': VALID_REQUEST_ID } }),
    );

    expect(response.headers.get('x-request-id')).toBe(VALID_REQUEST_ID);
  });

  it('ignore un identifiant fourni mal formé et en génère un propre', async () => {
    // Un identifiant repris tel quel serait recopié dans les journaux : une valeur libre y
    // insérerait du texte arbitraire, voire une fausse ligne de journal.
    const forged = [
      'req_injection ligne forgee status=200',
      'req_11111111-2222-4333-8444-555555555555 suffixe',
      '../../etc/passwd',
      'AAAA',
      '',
      'req_ZZZZZZZZ-2222-4333-8444-555555555555',
    ];

    for (const value of forged) {
      const response = await CATCH_ALL_GET(
        new Request(`${BASE_URL}/api/v1/resources`, {
          headers: new Headers({ 'x-request-id': value }),
        }),
      );
      const emitted = response.headers.get('x-request-id');

      expect(emitted).toMatch(REQUEST_ID_PATTERN);
      expect(emitted).not.toBe(value);
    }
  });
});

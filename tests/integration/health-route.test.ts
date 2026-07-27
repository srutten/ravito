import { hostname } from 'node:os';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfigCache } from '@/config/env';
import { logger } from '@/observability/logger';
import { GET } from '../../app/api/v1/health/route';

/**
 * Sonde de santé publique (US-001 critère 12, docs/observability.md).
 *
 * Une sonde est lue sans authentification : elle est donc lue par tout le monde, y compris par un
 * attaquant en phase de reconnaissance (docs/threat-model.md). Ce fichier vérifie autant ce
 * qu'elle expose que ce qu'elle tait.
 */

const BASE_URL = 'https://appui-feux.exemple.test';
const HEALTH_URL = `${BASE_URL}/api/v1/health`;
const FIXED_INSTANT = new Date('2026-07-27T10:20:30.000Z');
const DATABASE_PASSWORD = 'sentinelle-motdepasse-base-Z9X8C7';
const DATABASE_URL = `postgresql://utilisateur:${DATABASE_PASSWORD}@base-interne.local:5432/appui`;
const AUTH_SECRET = 'sentinelle-secret-authentification-de-plus-de-32-caracteres';

interface HealthBody {
  readonly status: string;
  readonly version: string;
  readonly checkedAt: string;
  readonly checks: Record<string, unknown>;
}

/**
 * Tout ce qui ne doit jamais figurer dans une réponse publique : secrets, topologie interne,
 * détail d'exécution, noms de variables d'environnement.
 */
const FORBIDDEN_IN_RESPONSE: readonly string[] = [
  DATABASE_PASSWORD,
  DATABASE_URL,
  AUTH_SECRET,
  'postgresql',
  'base-interne.local',
  'DATABASE_URL',
  'AUTH_SECRET',
  'APP_ENV',
  'STORAGE_',
  'staging',
  'stack',
  'Error',
  'node_modules',
  'C:\\',
  '/src/',
  hostname(),
  process.version,
];

function applyValidConfiguration(): void {
  process.env.APP_ENV = 'staging';
  process.env.APP_VERSION = '1.2.3-test';
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.AUTH_SECRET = AUTH_SECRET;
  resetServerConfigCache();
}

describe('GET /api/v1/health', () => {
  const initialEnvironment = { ...process.env };
  const initialLevel = logger.level;

  beforeAll(() => {
    // La sonde journalise la cause réelle d'une configuration illisible : c'est voulu, mais ce
    // bruit n'a pas sa place dans le rapport de test.
    logger.level = 'silent';
  });

  afterAll(() => {
    logger.level = initialLevel;
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_INSTANT);
    applyValidConfiguration();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetServerConfigCache();
    for (const key of Object.keys(process.env)) {
      if (!(key in initialEnvironment)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, initialEnvironment);
  });

  it('répond 200 sans authentification', async () => {
    const response = await GET(new Request(HEALTH_URL));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('expose un statut, une version et un horodatage ISO 8601 UTC', async () => {
    const body = (await (await GET(new Request(HEALTH_URL))).json()) as HealthBody;

    expect(body.status).toBe('ok');
    expect(body.version).toBe('1.2.3-test');
    expect(body.checkedAt).toBe(FIXED_INSTANT.toISOString());
    expect(body.checks).toStrictEqual({});
    expect(Object.keys(body).sort()).toStrictEqual(['checkedAt', 'checks', 'status', 'version']);
  });

  it('mesure l instant présent plutôt qu un instant figé à la construction', async () => {
    const first = (await (await GET(new Request(HEALTH_URL))).json()) as HealthBody;

    vi.setSystemTime(new Date('2026-07-27T11:00:00.000Z'));
    const second = (await (await GET(new Request(HEALTH_URL))).json()) as HealthBody;

    expect(second.checkedAt).not.toBe(first.checkedAt);
    expect(second.checkedAt).toBe('2026-07-27T11:00:00.000Z');
  });

  it('ne divulgue aucun détail interne', async () => {
    const payload = await (await GET(new Request(HEALTH_URL))).text();

    for (const forbidden of FORBIDDEN_IN_RESPONSE) {
      expect(payload, `la sonde a divulgué « ${forbidden} »`).not.toContain(forbidden);
    }
  });

  it('annonce une instance inapte sans nommer la variable fautive', async () => {
    delete process.env.DATABASE_URL;
    delete process.env.APP_VERSION;
    resetServerConfigCache();

    const response = await GET(new Request(HEALTH_URL));
    const payload = await response.text();
    const body = JSON.parse(payload) as HealthBody;

    expect(response.status).toBe(503);
    expect(body.status).toBe('down');
    expect(body.version).toBe('unknown');
    expect(body.checkedAt).toBe(FIXED_INSTANT.toISOString());
    for (const forbidden of FORBIDDEN_IN_RESPONSE) {
      expect(payload, `la sonde a divulgué « ${forbidden} »`).not.toContain(forbidden);
    }
    expect(payload).not.toContain('Configuration invalide');
    expect(payload).not.toContain('variable');
  });
});

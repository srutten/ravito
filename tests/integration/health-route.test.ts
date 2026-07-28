import { hostname } from 'node:os';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfigCache } from '@/config/env';
import { checkDatabase } from '@/infrastructure/database/health-check';
import { logger } from '@/observability/logger';
import { GET } from '../../app/api/v1/health/route';

/**
 * Sonde de santé publique (US-001 critère 12, docs/observability.md ; US-006 pour le contrôle de
 * base de données).
 *
 * Une sonde est lue sans authentification : elle est donc lue par tout le monde, y compris par un
 * attaquant en phase de reconnaissance (docs/threat-model.md). Ce fichier vérifie autant ce
 * qu'elle expose que ce qu'elle tait.
 *
 * Le contrôle de base de données est SIMULÉ ici, délibérément. Ce fichier porte sur le contrat de
 * la route : forme de la réponse, code HTTP, en-têtes, et surtout ce qui ne doit pas fuiter. Le
 * comportement réel du pool face à une base disponible, injoignable ou muette est couvert par
 * `database-application-pool.test.ts`, contre une vraie base. Mêler les deux rendrait ce fichier
 * dépendant d'une base pour vérifier des règles qui n'en dépendent pas.
 */

vi.mock('@/infrastructure/database/health-check', () => ({
  checkDatabase: vi.fn(),
}));

const checkDatabaseMock = vi.mocked(checkDatabase);

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
    // Base disponible par défaut : chaque test qui veut l'inverse le déclare explicitement.
    checkDatabaseMock.mockResolvedValue({ status: 'ok', latencyMs: 3 });
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
    expect(body.checks).toStrictEqual({ database: { status: 'ok', latencyMs: 3 } });
    expect(Object.keys(body).sort()).toStrictEqual(['checkedAt', 'checks', 'status', 'version']);
  });

  it('déclare l instance hors service quand la base est injoignable', async () => {
    // Une instance dont la base ne répond pas n'est pas apte à servir. Se déclarer saine serait un
    // faux positif d'exploitation : l'ordonnanceur laisserait le trafic arriver sur une instance
    // incapable de traiter la moindre requête métier.
    checkDatabaseMock.mockResolvedValue({ status: 'down', latencyMs: 2000 });

    const response = await GET(new Request(HEALTH_URL));
    const payload = await response.text();
    const body = JSON.parse(payload) as HealthBody;

    expect(response.status).toBe(503);
    expect(body.status).toBe('down');
    expect(body.checks).toStrictEqual({ database: { status: 'down', latencyMs: 2000 } });
    // Même en échec, la sonde reste muette sur la topologie interne.
    for (const forbidden of FORBIDDEN_IN_RESPONSE) {
      expect(payload, `la sonde a divulgué « ${forbidden} »`).not.toContain(forbidden);
    }
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

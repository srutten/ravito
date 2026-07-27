import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfigCache } from '@/config/env';
import { createLogger, getRequestLogger, logger } from '@/observability/logger';
import type { RequestContext } from '@/observability/request-context';
import { pseudonymizeUserId, runWithRequestContext } from '@/observability/request-context';

/**
 * Journalisation (docs/observability.md, US-001 critère 11).
 *
 * Deux exigences opposées cohabitent : la ligne de journal doit porter de quoi diagnostiquer une
 * panne, et ne jamais porter de quoi compromettre une personne. Le test négatif de rédaction est
 * le plus important de ce fichier.
 */

const VALID_DATABASE_URL = 'postgresql://utilisateur:motdepasse-fictif@localhost:5432/appui_feux';
const FIXED_INSTANT = new Date('2026-07-27T10:20:30.000Z');

/** Destination en mémoire : aucune écriture sur la sortie standard, aucune dépendance réseau. */
class MemoryDestination extends Writable {
  private readonly chunks: string[] = [];

  override _write(chunk: unknown, _encoding: string, callback: () => void): void {
    this.chunks.push(String(chunk));
    callback();
  }

  get raw(): string {
    return this.chunks.join('');
  }

  get lines(): Record<string, unknown>[] {
    return this.raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  /** Première ligne écrite. Échoue explicitement si rien n'a été journalisé. */
  get firstLine(): Record<string, unknown> {
    const [line] = this.lines;
    if (line === undefined) {
      throw new Error('aucune ligne de journal produite');
    }
    return line;
  }
}

/**
 * Valeurs sentinelles. Aucune n'est réelle : ce sont des marqueurs conçus pour être recherchés
 * dans la sortie du journal. Aucune ne doit y figurer.
 */
const SENTINELS = {
  password: 'sentinelle-mot-de-passe-Z9X8',
  motDePasse: 'sentinelle-mot-de-passe-francais-C7V6',
  token: 'sentinelle-jeton-B5N4',
  accessToken: 'sentinelle-jeton-acces-M3L2',
  authorization: 'sentinelle-autorisation-K1J0',
  cookie: 'sentinelle-cookie-H9G8',
  setCookie: 'sentinelle-cookie-pose-F7D6',
  preciseLocation: 'sentinelle-position-precise-S5A4',
  exactLocation: 'sentinelle-position-exacte-Q3W2',
  phone: 'sentinelle-telephone-E1R0',
  contactPhone: 'sentinelle-telephone-contact-T9Y8',
  storageKey: 'sentinelle-cle-stockage-U7I6',
  storageSecretKey: 'sentinelle-cle-secrete-stockage-O5P4',
  incidentDescription: 'sentinelle-description-incident-A3S2',
  documents: 'sentinelle-document-D1F0',
  secret: 'sentinelle-secret-G9H8',
} as const;

function sensitivePayload(): Record<string, unknown> {
  return {
    // Champs légitimes, qui doivent survivre.
    requestId: 'req_11111111-2222-4333-8444-555555555555',
    route: '/api/v1/missions/:id',
    // Champs interdits, à plat.
    password: SENTINELS.password,
    token: SENTINELS.token,
    authorization: `Bearer ${SENTINELS.authorization}`,
    cookie: `session=${SENTINELS.cookie}`,
    preciseLocation: { latitude: SENTINELS.preciseLocation, longitude: 'sentinelle-longitude' },
    phone: SENTINELS.phone,
    storageKey: SENTINELS.storageKey,
    // Champs interdits, imbriqués et sous des écritures différentes.
    req: {
      headers: {
        authorization: `Bearer ${SENTINELS.authorization}`,
        cookie: `session=${SENTINELS.cookie}`,
        'set-cookie': SENTINELS.setCookie,
      },
    },
    utilisateur: {
      motDePasse: SENTINELS.motDePasse,
      contactPhone: SENTINELS.contactPhone,
      profil: { exact_location: SENTINELS.exactLocation, ACCESS_TOKEN: SENTINELS.accessToken },
    },
    documents: [{ storageKey: SENTINELS.documents }],
    incident: { incidentDescription: SENTINELS.incidentDescription },
    configuration: { storageSecretKey: SENTINELS.storageSecretKey, secret: SENTINELS.secret },
  };
}

describe('createLogger', () => {
  const initialEnvironment = { ...process.env };
  let destination: MemoryDestination;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_INSTANT);
    resetServerConfigCache();
    process.env.APP_ENV = 'staging';
    process.env.APP_VERSION = '1.2.3-test';
    process.env.LOG_LEVEL = 'trace';
    process.env.DATABASE_URL = VALID_DATABASE_URL;
    process.env.AUTH_SECRET = 'secret-de-test-fictif-de-plus-de-32-caracteres';
    destination = new MemoryDestination();
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

  it('porte les champs obligatoires de docs/observability.md', () => {
    const testLogger = createLogger({ destination });

    testLogger.info(
      {
        requestId: 'req_11111111-2222-4333-8444-555555555555',
        route: '/api/v1/requests/:id',
        method: 'POST',
        userId: pseudonymizeUserId('utilisateur-fictif-001'),
        organizationId: 'org-fictive-001',
        errorCode: 'VERSION_CONFLICT',
        durationMs: 42,
        status: 409,
      },
      'requête refusée',
    );

    const line = destination.firstLine;
    expect(line.level).toBe('info');
    expect(line.time).toBe(FIXED_INSTANT.toISOString());
    expect(line.service).toBe('fire-support-platform');
    expect(line.environment).toBe('staging');
    expect(line.version).toBe('1.2.3-test');
    expect(line.route).toBe('/api/v1/requests/:id');
    expect(line.method).toBe('POST');
    expect(line.requestId).toBe('req_11111111-2222-4333-8444-555555555555');
    expect(line.organizationId).toBe('org-fictive-001');
    expect(line.errorCode).toBe('VERSION_CONFLICT');
    expect(line.durationMs).toBe(42);
    expect(line.msg).toBe('requête refusée');
  });

  it('journalise le niveau en toutes lettres et l horodatage en ISO 8601 UTC', () => {
    const testLogger = createLogger({ destination });

    testLogger.error({ errorCode: 'INTERNAL_ERROR' }, 'panne');

    const line = destination.firstLine;
    expect(line.level).toBe('error');
    expect(String(line.time)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('ne journalise aucune valeur sensible, à plat comme en profondeur', () => {
    const testLogger = createLogger({ destination });

    testLogger.info(sensitivePayload(), 'requête traitée');

    const output = destination.raw;
    for (const [name, sentinel] of Object.entries(SENTINELS)) {
      expect(output, `la valeur du champ ${name} a fuité dans le journal`).not.toContain(sentinel);
    }
    expect(output).toContain('[REDACTED]');
    // Les champs de diagnostic, eux, restent lisibles.
    expect(output).toContain('req_11111111-2222-4333-8444-555555555555');
    expect(output).toContain('/api/v1/missions/:id');
  });

  it('rédige aussi les champs sensibles portés par une exception', () => {
    const testLogger = createLogger({ destination });
    const failure: Error & { accessToken?: string; contactPhone?: string } = new Error(
      'échec de rafraîchissement de session',
    );
    failure.accessToken = SENTINELS.accessToken;
    failure.contactPhone = SENTINELS.contactPhone;

    testLogger.error({ err: failure, errorCode: 'INTERNAL_ERROR' }, 'erreur non identifiée');

    const output = destination.raw;
    expect(output).not.toContain(SENTINELS.accessToken);
    expect(output).not.toContain(SENTINELS.contactPhone);
    expect(output).toContain('échec de rafraîchissement de session');
  });

  it('rédige un champ sensible enfoui sous plusieurs niveaux et dans un tableau', () => {
    const testLogger = createLogger({ destination });

    testLogger.info(
      {
        niveau1: {
          niveau2: {
            niveau3: [{ niveau4: { password: SENTINELS.password, phone: SENTINELS.phone } }],
          },
        },
      },
      'structure profonde',
    );

    const output = destination.raw;
    expect(output).not.toContain(SENTINELS.password);
    expect(output).not.toContain(SENTINELS.phone);
    expect(output).toContain('[REDACTED]');
  });

  it('respecte le niveau demandé', () => {
    const testLogger = createLogger({ level: 'warn', destination });

    testLogger.debug('ligne de mise au point');
    testLogger.warn('ligne d avertissement');

    expect(destination.lines).toHaveLength(1);
    expect(destination.firstLine.level).toBe('warn');
  });
});

describe('getRequestLogger', () => {
  const context: RequestContext = {
    requestId: 'req_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    route: '/api/v1/missions/:id',
    method: 'PATCH',
    startedAt: 0,
    userIdHash: pseudonymizeUserId('utilisateur-fictif-002'),
    organizationId: 'org-fictive-002',
  };

  it('enrichit le journal des champs de la requête courante', () => {
    const bindings = runWithRequestContext(context, () => getRequestLogger().bindings());

    expect(bindings.requestId).toBe(context.requestId);
    expect(bindings.route).toBe(context.route);
    expect(bindings.method).toBe(context.method);
    expect(bindings.userId).toBe(context.userIdHash);
    expect(bindings.organizationId).toBe(context.organizationId);
  });

  it('ne journalise jamais l identifiant utilisateur en clair', () => {
    const bindings = runWithRequestContext(context, () => getRequestLogger().bindings());

    expect(JSON.stringify(bindings)).not.toContain('utilisateur-fictif-002');
    expect(String(bindings.userId)).toMatch(/^usr_[0-9a-f]{32}$/);
  });

  it('rend le journal racine hors de toute requête', () => {
    expect(getRequestLogger()).toBe(logger);
  });

  it('réutilise le même journal enfant pour un même contexte', () => {
    const [first, second] = runWithRequestContext(context, () => [
      getRequestLogger(),
      getRequestLogger(),
    ]);

    expect(second).toBe(first);
  });
});

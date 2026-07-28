import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** Voir l'en-tête de `auth-identity-flow.test.ts` : l'environnement précède les imports. */
vi.hoisted(() => {
  process.env.APP_ENV = 'local';
  process.env.APP_VERSION = '0.0.0-test';
  process.env.LOG_LEVEL = 'error';
  process.env.AUTH_SECRET = 'secret-de-test-fictif-journaux-de-plus-de-32-caracteres';
  process.env.DATABASE_URL = 'postgresql://attente:attente@localhost:5432/attente';
  process.env.DATABASE_SSL = 'disable';
  process.env.DATABASE_POOL_MAX = '20';
});

/**
 * Destination en mémoire, partagée avec la doublure du module de journalisation. Elle est créée
 * dans un bloc hoisté parce que la fabrique de `vi.mock` s'exécute avant le corps du fichier.
 */
const capture = vi.hoisted(() => {
  const chunks: string[] = [];
  return {
    chunks,
    clear(): void {
      chunks.length = 0;
    },
    get raw(): string {
      return chunks.join('');
    },
    get lines(): Record<string, unknown>[] {
      return chunks
        .join('')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
});

/**
 * TOUTE la journalisation du parcours est détournée vers la mémoire — l'instance racine comme le
 * journal de requête. C'est ce qui permet de chercher des sentinelles dans ce que le code écrit
 * RÉELLEMENT, plutôt que de raisonner sur ce qu'il est censé écrire.
 *
 * La doublure n'est pas un espion : c'est un vrai `pino` construit par la fabrique du dépôt, donc
 * avec la même rédaction, les mêmes sérialiseurs et le même formatage. Un espion qui se
 * contenterait d'enregistrer les arguments passerait à côté de la rédaction, c'est-à-dire de la
 * moitié du sujet.
 */
vi.mock('@/observability/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/observability/logger')>();
  const destination = new Writable({
    write(chunk: unknown, _encoding: string, callback: () => void): void {
      capture.chunks.push(String(chunk));
      callback();
    },
  });
  const instrumented = actual.createLogger({ level: 'trace', destination });
  return {
    ...actual,
    logger: instrumented,
    getRequestLogger: (): unknown => instrumented,
  };
});

import { resetServerConfigCache } from '@/config/env';
import type { CodeDelivery, SignInCodeMessage } from '@/domain/identity/code-delivery';
import { configureCodeDelivery, resetCodeDelivery } from '@/domain/identity/code-delivery';
import { REQUEST_CODE_BY_IDENTIFIER } from '@/domain/identity/policy';
import { closePool, getPool } from '@/infrastructure/database/pool';
import { LoggingCodeDelivery } from '@/infrastructure/identity/logging-code-delivery';
import { POST as requestCodeRoute } from '../../app/api/v1/auth/codes/route';
import { POST as revokeAllRoute } from '../../app/api/v1/auth/sessions/commands/revoke-all/route';
import {
  GET as currentSessionRoute,
  DELETE as signOutRoute,
} from '../../app/api/v1/auth/sessions/current/route';
import { POST as openSessionRoute } from '../../app/api/v1/auth/sessions/route';
import type { DisposableDatabaseSetup } from './setup/database';
import { createDisposableDatabase, databaseOrSkip, NOT_PREPARED } from './setup/database';

/**
 * « Aucun code, aucun jeton, aucun identifiant complet dans les journaux » (docs/observability.md,
 * docs/privacy-rgpd.md, docs/security.md).
 *
 * CE TEST NE RAISONNE PAS, IL CHERCHE. Un parcours complet est exécuté par les vraies routes,
 * toute la sortie du journal est capturée, et chaque valeur qui ne doit pas s'y trouver y est
 * cherchée littéralement. Le raisonnement — « ce champ n'est pas journalisé » — se périme au
 * premier ajout de trace ; la recherche de sentinelles, non.
 *
 * LES SENTINELLES SONT CHOISIES POUR ÊTRE TROUVABLES. Une adresse dont la partie locale est unique
 * ressortirait immédiatement d'une ligne de journal ; le masquage attendu ne laisse que la
 * première lettre et le domaine, donc la sentinelle ne peut pas survivre au masquage.
 *
 * DEUX RÉGIMES POUR L'ADAPTATEUR DE REPLI, et le second est le test négatif qui compte : en
 * environnement local le code EST journalisé, c'est le seul moyen de se connecter sur un poste
 * sans serveur d'envoi ; partout ailleurs il ne doit jamais l'être, un journal étant agrégé,
 * expédié à un tiers, conservé et consulté par des exploitants.
 */

const ORIGIN = 'https://appui-feux.exemple.test';
const HOST = 'appui-feux.exemple.test';
const SENTINEL_LOCAL_PART = 'sentinelle-adresse-k7m2x4';
const SENTINEL_ADDRESS = '198.51.100.242';
const SENTINEL_USER_AGENT_MARK = 'sentinelle-agent-Q4W3E2';
const SENTINEL_PASSWORD = 'sentinelle-mot-de-passe-Z9X8C7';

let setup: DisposableDatabaseSetup = NOT_PREPARED;
const deliveries: SignInCodeMessage[] = [];

const recordingDelivery: CodeDelivery = {
  send(message: SignInCodeMessage): Promise<void> {
    deliveries.push(message);
    return Promise.resolve();
  },
};

function buildRequest(options: {
  readonly path: string;
  readonly method: string;
  readonly body?: unknown;
  readonly cookie?: string;
  readonly address?: string;
}): Request {
  const headers = new Headers({
    host: HOST,
    origin: ORIGIN,
    'x-forwarded-for': options.address ?? SENTINEL_ADDRESS,
    'user-agent': `Mozilla/5.0 (Android 14; Mobile; rv:141.0) Gecko/141.0 Firefox/141.0.2 ${SENTINEL_USER_AGENT_MARK}`,
  });
  if (options.cookie !== undefined) {
    headers.set('cookie', `appui_feux_session=${options.cookie}`);
  }
  const serialized = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (serialized !== undefined) {
    headers.set('content-type', 'application/json');
  }
  return new Request(`${ORIGIN}${options.path}`, {
    method: options.method,
    headers,
    ...(serialized !== undefined ? { body: serialized } : {}),
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  return text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>);
}

async function waitForCode(challengeId: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const message = deliveries.find((candidate) => candidate.challengeId === challengeId);
    if (message !== undefined) {
      return message.code;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`aucun code remis pour le défi ${challengeId}`);
}

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  setup = await createDisposableDatabase({ withMigrations: true });
  process.env.DATABASE_URL = setup.available
    ? setup.database.url
    : 'postgresql://attente:attente@localhost:5432/attente';
  resetServerConfigCache();
  await closePool();
  if (setup.available) {
    configureCodeDelivery(recordingDelivery);
    await Promise.all(Array.from({ length: 12 }, () => getPool().query('select 1')));
  }
}, 120_000);

afterAll(async () => {
  resetCodeDelivery();
  await closePool();
  if (setup.available) {
    await setup.database.dispose();
  }
});

describe('journaux du parcours de connexion', () => {
  it('ne laisse fuir ni code, ni jeton, ni identifiant complet, ni adresse', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = `${SENTINEL_LOCAL_PART}@exemple.test`;
    await database.owner.query(
      `insert into public.user_profiles (display_name, email, preferred_language, verification_level, status)
       values ('Camille D.', $1, 'fr', 'CONTACT_VERIFIED', 'ACTIVE')`,
      [email],
    );
    capture.clear();

    // PARCOURS COMPLET, par les vraies routes : demande de code, essai erroné, connexion, lecture
    // de session, déconnexion, reconnexion, révocation globale, corps refusé, blocage.
    const requested = await readJson(
      await requestCodeRoute(
        buildRequest({
          path: '/api/v1/auth/codes',
          method: 'POST',
          body: { identifier: email.toUpperCase() },
        }),
      ),
    );
    const challengeId = String(requested.challengeId);
    const code = await waitForCode(challengeId);
    const wrongCode = code === '000000' ? '111111' : '000000';

    await openSessionRoute(
      buildRequest({
        path: '/api/v1/auth/sessions',
        method: 'POST',
        body: { challengeId, code: wrongCode },
      }),
    );
    const opened = await openSessionRoute(
      buildRequest({
        path: '/api/v1/auth/sessions',
        method: 'POST',
        body: { challengeId, code },
      }),
    );
    const setCookie = opened.headers.get('set-cookie') ?? '';
    const first = setCookie.split(';')[0] ?? '';
    const token = first.slice(first.indexOf('=') + 1);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await currentSessionRoute(
      buildRequest({ path: '/api/v1/auth/sessions/current', method: 'GET', cookie: token }),
    );
    await revokeAllRoute(
      buildRequest({
        path: '/api/v1/auth/sessions/commands/revoke-all',
        method: 'POST',
        body: { clientEventId: randomUUID() },
        cookie: token,
      }),
    );
    await signOutRoute(
      buildRequest({ path: '/api/v1/auth/sessions/current', method: 'DELETE', cookie: token }),
    );
    await requestCodeRoute(
      buildRequest({
        path: '/api/v1/auth/codes',
        method: 'POST',
        body: { identifier: email, password: SENTINEL_PASSWORD },
      }),
    );
    for (let attempt = 0; attempt < REQUEST_CODE_BY_IDENTIFIER.maxAttempts + 2; attempt += 1) {
      await requestCodeRoute(
        buildRequest({
          path: '/api/v1/auth/codes',
          method: 'POST',
          body: { identifier: email },
        }),
      );
    }

    const output = capture.raw;
    expect(output.length).toBeGreaterThan(0);

    const forbidden: readonly (readonly [string, string])[] = [
      ['le code à usage unique', code],
      ['le code erroné saisi', wrongCode],
      ['le jeton de session', token],
      ["la partie locale de l'adresse", SENTINEL_LOCAL_PART],
      ['la partie locale en majuscules', SENTINEL_LOCAL_PART.toUpperCase()],
      ["l'adresse d'appel", SENTINEL_ADDRESS],
      ["l'en-tête de navigateur complet", SENTINEL_USER_AGENT_MARK],
      ['le mot de passe envoyé par erreur', SENTINEL_PASSWORD],
      ['le secret de signature', process.env.AUTH_SECRET ?? 'AUTH_SECRET absent'],
    ];

    for (const [label, sentinel] of forbidden) {
      expect(output, `${label} a fuité dans les journaux`).not.toContain(sentinel);
    }
  }, 120_000);

  it('conserve de quoi diagnostiquer : identifiant de défi, statut, durée, code d erreur', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = `sentinelle-diagnostic-${randomUUID().slice(0, 8)}@exemple.test`;
    await database.owner.query(
      `insert into public.user_profiles (display_name, email, preferred_language, verification_level, status)
       values ('Camille D.', $1, 'fr', 'CONTACT_VERIFIED', 'ACTIVE')`,
      [email],
    );
    capture.clear();

    const requested = await readJson(
      await requestCodeRoute(
        buildRequest({
          path: '/api/v1/auth/codes',
          method: 'POST',
          body: { identifier: email },
          address: '198.51.100.7',
        }),
      ),
    );
    await openSessionRoute(
      buildRequest({
        path: '/api/v1/auth/sessions',
        method: 'POST',
        body: { challengeId: String(requested.challengeId), code: '000000' },
        address: '198.51.100.7',
      }),
    );

    const lines = capture.lines;
    const created = lines.find((line) => line.msg === 'defi de connexion cree');
    const refused = lines.find((line) => line.msg === 'verification de code refusee');
    const outcome = lines.find((line) => typeof line.status === 'number' && line.status === 401);

    // Une ligne de journal doit permettre de diagnostiquer une panne sans compromettre personne :
    // l'identifiant de défi est OPAQUE, il ne contient pas l'identifiant saisi.
    expect(created?.challengeId).toBe(requested.challengeId);
    expect(created?.module).toBe('identity');
    expect(refused?.errorCode).toBe('UNAUTHENTICATED');
    expect(refused?.challengeId).toBe(requested.challengeId);
    expect(typeof refused?.identifierAttempts).toBe('number');
    expect(outcome?.errorCode).toBe('UNAUTHENTICATED');
    expect(typeof outcome?.durationMs).toBe('number');
    for (const line of lines) {
      expect(line.service).toBe('fire-support-platform');
      expect(typeof line.time).toBe('string');
    }
  }, 120_000);
});

describe('adaptateur de repli', () => {
  const initialEnvironment = process.env.APP_ENV;

  afterAll(() => {
    process.env.APP_ENV = initialEnvironment;
    resetServerConfigCache();
  });

  function message(): SignInCodeMessage {
    return {
      channel: 'EMAIL',
      recipient: `${SENTINEL_LOCAL_PART}@exemple.test`,
      code: '004821',
      expiresAt: new Date(Date.now() + 600_000),
      preferredLanguage: 'fr',
      challengeId: randomUUID(),
    };
  }

  it('journalise le code SUR LE POSTE LOCAL, et masque le destinataire', async () => {
    process.env.APP_ENV = 'local';
    resetServerConfigCache();
    capture.clear();

    await new LoggingCodeDelivery().send(message());

    // Comportement voulu et documenté : sans serveur d'envoi, c'est le seul moyen de se connecter
    // sur un poste de développement. L'adresse, elle, reste masquée même là.
    expect(capture.raw).toContain('004821');
    expect(capture.raw).toContain('s***@exemple.test');
    expect(capture.raw).not.toContain(SENTINEL_LOCAL_PART);
  });

  it('N ÉCRIT JAMAIS le code hors du poste local', async () => {
    for (const environment of ['staging', 'production'] as const) {
      process.env.APP_ENV = environment;
      resetServerConfigCache();
      capture.clear();

      await new LoggingCodeDelivery().send(message());

      // Y écrire un code de connexion transformerait l'accès aux journaux en accès à tous les
      // comptes. La ligne dit qu'un envoi n'a pas eu lieu, et ne dit pas quoi.
      expect(capture.raw, `environnement ${environment}`).not.toContain('004821');
      expect(capture.raw, `environnement ${environment}`).not.toContain(SENTINEL_LOCAL_PART);
      expect(capture.raw).toContain('SERVICE_UNAVAILABLE');
      expect(capture.raw).toContain("le code n'a pas ete remis");
    }
  });

  it('ne journalise pas le code quand la configuration est illisible', async () => {
    delete process.env.APP_ENV;
    resetServerConfigCache();
    capture.clear();

    await new LoggingCodeDelivery().send(message());

    // Repli le plus strict : tout ce qui n'est pas explicitement `local` est traité comme déployé.
    expect(capture.raw).not.toContain('004821');
  });
});

describe('rédaction du journal — portée réelle', () => {
  it('rédige les clés déclarées sensibles, à plat comme en profondeur', async () => {
    const { logger } = await import('@/observability/logger');
    capture.clear();

    logger.info(
      {
        token: 'sentinelle-jeton-B5N4',
        sessionToken: 'sentinelle-jeton-session-M3L2',
        cookie: 'appui_feux_session=sentinelle-cookie-H9G8',
        authorization: 'Bearer sentinelle-autorisation-K1J0',
        phone: 'sentinelle-telephone-E1R0',
        imbrique: { profil: { password: 'sentinelle-mot-de-passe-Z9X8' } },
      },
      'controle de redaction',
    );

    const output = capture.raw;
    for (const sentinel of [
      'sentinelle-jeton-B5N4',
      'sentinelle-jeton-session-M3L2',
      'sentinelle-cookie-H9G8',
      'sentinelle-autorisation-K1J0',
      'sentinelle-telephone-E1R0',
      'sentinelle-mot-de-passe-Z9X8',
    ]) {
      expect(output, `valeur non rédigée : ${sentinel}`).not.toContain(sentinel);
    }
    expect(output).toContain('[REDACTED]');
  });

  it("ne rédige PAS les clés propres au lot 1, qu'aucun code n'écrit aujourd'hui", async () => {
    const { logger } = await import('@/observability/logger');
    capture.clear();

    logger.info(
      { signInCode: '004821', identifier: 'camille@exemple.test', codeHash: 'ab'.repeat(32) },
      'controle de portee',
    );

    // CONSTAT, PAS SOUHAIT. `SENSITIVE_KEYS` de `src/observability/logger.ts` — hors du périmètre
    // de US-010 — ne couvre ni `signInCode`, ni `identifier`, ni les empreintes. Ce test fige
    // l'état réel plutôt que d'exiger une correction qui casserait `LoggingCodeDelivery` : ce
    // dernier journalise DÉLIBÉRÉMENT `signInCode` sur le poste local, et la clé rédigée rendrait
    // toute connexion locale impossible. La protection effective est ailleurs — aucun code du lot 1
    // ne journalise ces valeurs, ce que le premier test de ce fichier vérifie par sentinelles. Si
    // la liste devait évoluer, ce test doit être relu EN MÊME TEMPS que l'adaptateur de repli.
    expect(capture.raw).toContain('004821');
    expect(capture.raw).toContain('camille@exemple.test');
  });
});

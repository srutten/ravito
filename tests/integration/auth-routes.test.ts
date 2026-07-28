import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** Voir l'en-tête de `auth-identity-flow.test.ts` : l'environnement précède les imports. */
vi.hoisted(() => {
  process.env.APP_ENV = 'local';
  process.env.APP_VERSION = '0.0.0-test';
  process.env.LOG_LEVEL = 'error';
  process.env.AUTH_SECRET = 'secret-de-test-fictif-routes-de-plus-de-32-caracteres';
  process.env.DATABASE_URL = 'postgresql://attente:attente@localhost:5432/attente';
  process.env.DATABASE_SSL = 'disable';
  process.env.DATABASE_POOL_MAX = '20';
});

import { resetServerConfigCache } from '@/config/env';
import type { CodeDelivery, SignInCodeMessage } from '@/domain/identity/code-delivery';
import { configureCodeDelivery, resetCodeDelivery } from '@/domain/identity/code-delivery';
import {
  REQUEST_CODE_BY_IDENTIFIER,
  SIGN_IN_CODE_LENGTH,
  SIGN_IN_CODE_RESEND_SECONDS,
  SIGN_IN_CODE_TTL_SECONDS,
} from '@/domain/identity/policy';
import { closePool, getPool } from '@/infrastructure/database/pool';
import { logger } from '@/observability/logger';
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
 * Les cinq routes d'authentification du contrat, appelées comme le réseau les appelle.
 *
 * CE QUI SE JOUE ICI ET NULLE PART AILLEURS. Le domaine peut être irréprochable et la route tout
 * défaire : un champ conditionnel dans le corps, un statut différent selon la branche, un jeton
 * recopié dans la réponse, une vérification d'origine oubliée. Ces tests s'adressent donc aux
 * gestionnaires exportés, avec de vrais objets `Request`, et regardent la réponse complète —
 * statut, en-têtes, octets du corps.
 *
 * LA NEUTRALITÉ SE VÉRIFIE SUR LES OCTETS. « Même code, même message, même statut, mêmes détails »
 * se teste en comparant les corps sérialisés, `requestId` mis à part : c'est le seul champ qui
 * diffère légitimement, et il est remplacé par une valeur figée avant comparaison. Une différence
 * d'un octet — une clé de plus, un ordre de champs différent — suffirait à distinguer deux causes
 * de refus, donc à rouvrir l'oracle que le critère 7 ferme.
 */

const ORIGIN = 'https://appui-feux.exemple.test';
const HOST = 'appui-feux.exemple.test';
const FIXED_REQUEST_ID = 'req_00000000-0000-4000-8000-000000000000';
const REQUEST_ID_PATTERN = /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COOKIE_NAME = 'appui_feux_session';

let setup: DisposableDatabaseSetup = NOT_PREPARED;
const deliveries: SignInCodeMessage[] = [];
let addressCounter = 0;

const recordingDelivery: CodeDelivery = {
  send(message: SignInCodeMessage): Promise<void> {
    deliveries.push(message);
    return Promise.resolve();
  },
};

function nextAddress(): string {
  addressCounter += 1;
  return `198.51.${Math.floor(addressCounter / 250)}.${(addressCounter % 250) + 1}`;
}

function nextEmail(label: string): string {
  return `sentinelle-${label}-${randomUUID().slice(0, 8)}@exemple.test`;
}

interface CallOptions {
  readonly path: string;
  readonly method: string;
  readonly body?: unknown;
  readonly cookie?: string | undefined;
  readonly address?: string | undefined;
  readonly headers?: Record<string, string>;
  /** `false` retire `content-type`, pour éprouver l'exigence de `application/json`. */
  readonly json?: boolean;
  /** Retire `Origin`, comme le ferait un navigateur ancien ou un client hors navigateur. */
  readonly noOrigin?: boolean;
}

function buildRequest(options: CallOptions): Request {
  const headers = new Headers({ host: HOST, origin: ORIGIN, ...options.headers });
  if (options.noOrigin === true) {
    headers.delete('origin');
  }
  headers.set('x-forwarded-for', options.address ?? nextAddress());
  headers.set(
    'user-agent',
    'Mozilla/5.0 (Android 14; Mobile; rv:141.0) Gecko/141.0 Firefox/141.0.2',
  );
  if (options.cookie !== undefined) {
    headers.set('cookie', `${COOKIE_NAME}=${options.cookie}`);
  }
  const serialized = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (serialized !== undefined && options.json !== false) {
    headers.set('content-type', 'application/json');
  }
  return new Request(`${ORIGIN}${options.path}`, {
    method: options.method,
    headers,
    ...(serialized !== undefined ? { body: serialized } : {}),
  });
}

interface Captured {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly text: string;
  readonly json: Record<string, unknown>;
  /** Corps exact, `requestId` figé. Sert aux comparaisons octet à octet. */
  readonly normalizedBytes: Buffer;
  readonly setCookie: string | null;
}

async function capture(response: Response): Promise<Captured> {
  const text = await response.text();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const parsed: unknown = text.length === 0 ? {} : JSON.parse(text);
  const requestId = response.headers.get('x-request-id') ?? '';
  return {
    status: response.status,
    headers,
    text,
    json: parsed as Record<string, unknown>,
    normalizedBytes: Buffer.from(
      requestId.length > 0 ? text.split(requestId).join(FIXED_REQUEST_ID) : text,
      'utf8',
    ),
    setCookie: response.headers.get('set-cookie'),
  };
}

function errorOf(captured: Captured): Record<string, unknown> {
  return (captured.json.error ?? {}) as Record<string, unknown>;
}

/** En-têtes comparables entre deux réponses : ceux qui varient légitimement sont retirés. */
function comparableHeaders(captured: Captured): Record<string, string> {
  const { 'x-request-id': _requestId, ...rest } = captured.headers;
  return rest;
}

async function warmPool(connections: number): Promise<void> {
  const pool = getPool();
  await Promise.all(Array.from({ length: connections }, () => pool.query('select 1')));
}

async function seedProfile(
  client: Client,
  input: { readonly email: string; readonly displayName?: string; readonly status?: string },
): Promise<string> {
  const { rows } = await client.query<{ readonly id: string }>(
    `insert into public.user_profiles (display_name, email, preferred_language, verification_level, status)
     values ($1, $2, 'fr', 'CONTACT_VERIFIED', $3::public.user_profile_status)
     returning id`,
    [input.displayName ?? 'Camille D.', input.email, input.status ?? 'ACTIVE'],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("le profil de test n'a pas été créé");
  }
  return row.id;
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

function readCookieValue(setCookie: string | null): string {
  const first = setCookie?.split(';')[0] ?? '';
  return first.slice(first.indexOf('=') + 1);
}

/** Parcours complet, tel qu'un navigateur l'exécute : demande, remise, échange contre session. */
async function signInThroughRoutes(
  email: string,
  address: string,
): Promise<{ readonly cookie: string; readonly userId: string }> {
  const requested = await capture(
    await requestCodeRoute(
      buildRequest({
        path: '/api/v1/auth/codes',
        method: 'POST',
        body: { identifier: email },
        address,
      }),
    ),
  );
  const challengeId = String(requested.json.challengeId);
  const code = await waitForCode(challengeId);
  const opened = await capture(
    await openSessionRoute(
      buildRequest({
        path: '/api/v1/auth/sessions',
        method: 'POST',
        body: { challengeId, code },
        address,
      }),
    ),
  );
  if (opened.status !== 201) {
    throw new Error(`ouverture de session refusée : ${opened.text}`);
  }
  const user = opened.json.user as { readonly id: string };
  return { cookie: readCookieValue(opened.setCookie), userId: user.id };
}

beforeAll(async () => {
  logger.level = 'silent';
  delete process.env.DATABASE_URL;
  setup = await createDisposableDatabase({ withMigrations: true });
  process.env.DATABASE_URL = setup.available
    ? setup.database.url
    : 'postgresql://attente:attente@localhost:5432/attente';
  resetServerConfigCache();
  await closePool();
  if (setup.available) {
    configureCodeDelivery(recordingDelivery);
    await warmPool(12);
  }
}, 120_000);

afterAll(async () => {
  resetCodeDelivery();
  await closePool();
  if (setup.available) {
    await setup.database.dispose();
  }
});

describe('POST /api/v1/auth/codes', () => {
  it('accepte la demande sans rien dire du compte visé', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('route-demande');
    await seedProfile(database.owner, { email });

    const response = await capture(
      await requestCodeRoute(
        buildRequest({
          path: '/api/v1/auth/codes',
          method: 'POST',
          body: { identifier: email },
        }),
      ),
    );

    // `202` et non `200` : le serveur accepte la demande, il ne garantit pas la remise.
    expect(response.status).toBe(202);
    expect(Object.keys(response.json).sort()).toStrictEqual([
      'challengeId',
      'codeLength',
      'expiresInSeconds',
      'resendAvailableInSeconds',
    ]);
    expect(response.json.codeLength).toBe(SIGN_IN_CODE_LENGTH);
    expect(response.json.expiresInSeconds).toBe(SIGN_IN_CODE_TTL_SECONDS);
    expect(response.json.resendAvailableInSeconds).toBe(SIGN_IN_CODE_RESEND_SECONDS);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['x-request-id']).toMatch(REQUEST_ID_PATTERN);
    expect(response.setCookie).toBeNull();
    expect(response.text).not.toContain(email);
  });

  it('répond OCTET À OCTET pareil pour un compte connu, inconnu, ou suspendu', async (context) => {
    const database = databaseOrSkip(setup, context);
    const known = nextEmail('route-connu');
    const suspended = nextEmail('route-suspendu');
    await seedProfile(database.owner, { email: known });
    await seedProfile(database.owner, { email: suspended, status: 'SUSPENDED' });

    const responses = await Promise.all(
      [known, nextEmail('route-inconnu'), suspended].map(async (identifier) =>
        capture(
          await requestCodeRoute(
            buildRequest({ path: '/api/v1/auth/codes', method: 'POST', body: { identifier } }),
          ),
        ),
      ),
    );

    const [reference, ...others] = responses;
    if (reference === undefined) {
      throw new Error('aucune réponse capturée');
    }
    // `challengeId` est opaque et forcément différent : il est neutralisé, tout le reste est
    // comparé littéralement.
    const mask = (captured: Captured): string =>
      captured.text.split(String(captured.json.challengeId)).join('DEFI');
    for (const other of others) {
      expect(other.status).toBe(reference.status);
      expect(mask(other)).toBe(mask(reference));
      expect(comparableHeaders(other)).toStrictEqual(comparableHeaders(reference));
    }
  }, 60_000);

  it('refuse tout champ que le contrat n accepte pas, à commencer par un mot de passe', async (context) => {
    databaseOrSkip(setup, context);
    const email = nextEmail('route-strict');

    const bodies = [
      { identifier: email, password: 'sentinelle-mot-de-passe-Z9X8' },
      { identifier: email, role: 'COORDINATOR' },
      { identifier: email, organizationId: randomUUID() },
      { identifier: email, channel: 'SMS' },
    ];

    for (const body of bodies) {
      const response = await capture(
        await requestCodeRoute(buildRequest({ path: '/api/v1/auth/codes', method: 'POST', body })),
      );

      // « Aucune de ces routes n'accepte de mot de passe, ni en entrée, ni en option. » Un champ
      // silencieusement ignoré laisserait croire qu'il a été pris en compte.
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(errorOf(response).code).toBe('VALIDATION_ERROR');
      expect(response.text).not.toContain('sentinelle-mot-de-passe-Z9X8');
    }
  }, 60_000);

  it('refuse un corps qui n est pas du JSON, et un corps démesuré', async (context) => {
    databaseOrSkip(setup, context);

    const wrongType = await capture(
      await requestCodeRoute(
        buildRequest({
          path: '/api/v1/auth/codes',
          method: 'POST',
          body: { identifier: nextEmail('type') },
          json: false,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        }),
      ),
    );
    const tooLarge = await capture(
      await requestCodeRoute(
        buildRequest({
          path: '/api/v1/auth/codes',
          method: 'POST',
          body: { identifier: `${'a'.repeat(4_000)}@exemple.test` },
        }),
      ),
    );

    // Effet de bord voulu du type exigé : un formulaire HTML inter-site ne sait produire aucun des
    // trois types acceptés, il ne peut donc pas atteindre cette route.
    expect(wrongType.status).toBe(415);
    expect(errorOf(wrongType).code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(tooLarge.status).toBe(413);
    expect(errorOf(tooLarge).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('refuse une origine étrangère, et une navigation inter-site', async (context) => {
    databaseOrSkip(setup, context);
    const body = { identifier: nextEmail('csrf') };

    const foreign = await capture(
      await requestCodeRoute(
        buildRequest({
          path: '/api/v1/auth/codes',
          method: 'POST',
          body,
          headers: { origin: 'https://site-attaquant.exemple' },
        }),
      ),
    );
    const nullOrigin = await capture(
      await requestCodeRoute(
        buildRequest({
          path: '/api/v1/auth/codes',
          method: 'POST',
          body,
          headers: { origin: 'null' },
        }),
      ),
    );
    // Sans `Origin` — navigateur ancien, soumission de formulaire — `Sec-Fetch-Site` prend le
    // relais : tout ce qui n'est ni `same-origin` ni `none` est refusé.
    const crossSite = await capture(
      await requestCodeRoute(
        buildRequest({
          path: '/api/v1/auth/codes',
          method: 'POST',
          body,
          noOrigin: true,
          headers: { 'sec-fetch-site': 'cross-site' },
        }),
      ),
    );
    const sameSiteNavigation = await capture(
      await requestCodeRoute(
        buildRequest({
          path: '/api/v1/auth/codes',
          method: 'POST',
          body: { identifier: nextEmail('csrf-ok') },
          noOrigin: true,
          headers: { 'sec-fetch-site': 'same-origin' },
        }),
      ),
    );

    // `SameSite=Lax` est une première ligne, pas une protection complète (docs/security.md).
    expect(foreign.status).toBe(403);
    expect(errorOf(foreign).code).toBe('FORBIDDEN');
    // `Origin: null` — cadre isolé, document `data:` — ne s'analyse pas en URL et tombe en refus.
    expect(nullOrigin.status).toBe(403);
    expect(crossSite.status).toBe(403);
    expect(sameSiteNavigation.status).toBe(202);
  });

  it('laisse passer un client hors navigateur, qui ne peut pas être victime de CSRF', async (context) => {
    databaseOrSkip(setup, context);

    const response = await capture(
      await requestCodeRoute(
        buildRequest({
          path: '/api/v1/auth/codes',
          method: 'POST',
          body: { identifier: nextEmail('hors-navigateur') },
          noOrigin: true,
        }),
      ),
    );

    // Ni `Origin` ni `Sec-Fetch-Site` : ce n'est pas un navigateur. La falsification de requête
    // inter-site suppose un navigateur qui joigne le cookie tout seul ; hors navigateur, l'appelant
    // doit déjà détenir le jeton, auquel cas il n'a rien à falsifier. Refuser ce cas fermerait
    // l'API aux sondes et aux tests sans rien fermer à l'attaquant.
    expect(response.status).toBe(202);
  });

  it('bloque au-delà du seuil avec Retry-After et la durée restante', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('route-limitation');
    await seedProfile(database.owner, { email });
    const address = nextAddress();

    let last: Captured | undefined;
    for (let attempt = 0; attempt < REQUEST_CODE_BY_IDENTIFIER.maxAttempts + 1; attempt += 1) {
      last = await capture(
        await requestCodeRoute(
          buildRequest({
            path: '/api/v1/auth/codes',
            method: 'POST',
            body: { identifier: email },
            address,
          }),
        ),
      );
    }

    expect(last?.status).toBe(429);
    expect(errorOf(last as Captured).code).toBe('RATE_LIMITED');
    const details = errorOf(last as Captured).details as Record<string, unknown>;
    expect(typeof details.retryAfterSeconds).toBe('number');
    // Un 429 sans `Retry-After` invite à réessayer immédiatement, donc à aggraver la situation qui
    // a déclenché le blocage.
    expect(Number(last?.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(last?.headers['retry-after'])).toBe(Math.ceil(Number(details.retryAfterSeconds)));
    expect(last?.headers['cache-control']).toBe('no-store');
  }, 60_000);
});

describe('POST /api/v1/auth/sessions', () => {
  it('ouvre la session par le cookie, et par lui seul', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('route-ouverture');
    const address = nextAddress();
    await seedProfile(database.owner, { email, displayName: 'Camille D.' });
    const requested = await capture(
      await requestCodeRoute(
        buildRequest({
          path: '/api/v1/auth/codes',
          method: 'POST',
          body: { identifier: email },
          address,
        }),
      ),
    );
    const challengeId = String(requested.json.challengeId);
    const code = await waitForCode(challengeId);

    const response = await capture(
      await openSessionRoute(
        buildRequest({
          path: '/api/v1/auth/sessions',
          method: 'POST',
          body: { challengeId, code },
          address,
        }),
      ),
    );

    expect(response.status).toBe(201);
    expect(response.setCookie).toContain(`${COOKIE_NAME}=`);
    expect(response.setCookie).toContain('HttpOnly');
    expect(response.setCookie).toContain('SameSite=Lax');
    expect(response.setCookie).toContain('Path=/');
    // LE JETON NE SORT QUE PAR LE COOKIE : dans le corps, il annulerait l'intérêt de `HttpOnly`.
    const token = readCookieValue(response.setCookie);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.text).not.toContain(token);
    expect(response.text).not.toContain(code);
    expect(response.json.nextStep).toBe('READY');
    expect(response.json.redirectPath).toBe('/apres-connexion');
    // Ni rôle ni organisation : `OrganizationMember` n'existe pas, un champ vide laisserait croire
    // qu'il est renseigné.
    expect(Object.keys(response.json).sort()).toStrictEqual([
      'nextStep',
      'redirectPath',
      'session',
      'user',
    ]);
    expect(Object.keys(response.json.user as object).sort()).toStrictEqual([
      'displayName',
      'id',
      'preferredLanguage',
    ]);
    expect(response.headers['cache-control']).toBe('no-store');
  }, 60_000);

  it('rend une réponse IDENTIQUE pour les quatre causes de refus', async (context) => {
    const database = databaseOrSkip(setup, context);

    // 1. Code erroné.
    const wrongEmail = nextEmail('route-errone');
    await seedProfile(database.owner, { email: wrongEmail });
    const wrongAddress = nextAddress();
    const wrongRequested = await capture(
      await requestCodeRoute(
        buildRequest({
          path: '/api/v1/auth/codes',
          method: 'POST',
          body: { identifier: wrongEmail },
          address: wrongAddress,
        }),
      ),
    );
    const wrongChallengeId = String(wrongRequested.json.challengeId);
    const trueCode = await waitForCode(wrongChallengeId);
    const wrong = await capture(
      await openSessionRoute(
        buildRequest({
          path: '/api/v1/auth/sessions',
          method: 'POST',
          body: {
            challengeId: wrongChallengeId,
            code: trueCode === '000000' ? '111111' : '000000',
          },
          address: wrongAddress,
        }),
      ),
    );

    // 2. Code expiré.
    const expiredEmail = nextEmail('route-expire');
    await seedProfile(database.owner, { email: expiredEmail });
    const expiredAddress = nextAddress();
    const expiredRequested = await capture(
      await requestCodeRoute(
        buildRequest({
          path: '/api/v1/auth/codes',
          method: 'POST',
          body: { identifier: expiredEmail },
          address: expiredAddress,
        }),
      ),
    );
    const expiredChallengeId = String(expiredRequested.json.challengeId);
    const expiredCode = await waitForCode(expiredChallengeId);
    await database.owner.query(
      `update public.auth_challenges
          set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
        where id = $1`,
      [expiredChallengeId],
    );
    const expired = await capture(
      await openSessionRoute(
        buildRequest({
          path: '/api/v1/auth/sessions',
          method: 'POST',
          body: { challengeId: expiredChallengeId, code: expiredCode },
          address: expiredAddress,
        }),
      ),
    );

    // 3. Code déjà consommé.
    const usedEmail = nextEmail('route-consomme');
    await seedProfile(database.owner, { email: usedEmail });
    const usedAddress = nextAddress();
    const usedRequested = await capture(
      await requestCodeRoute(
        buildRequest({
          path: '/api/v1/auth/codes',
          method: 'POST',
          body: { identifier: usedEmail },
          address: usedAddress,
        }),
      ),
    );
    const usedChallengeId = String(usedRequested.json.challengeId);
    const usedCode = await waitForCode(usedChallengeId);
    await openSessionRoute(
      buildRequest({
        path: '/api/v1/auth/sessions',
        method: 'POST',
        body: { challengeId: usedChallengeId, code: usedCode },
        address: usedAddress,
      }),
    );
    const used = await capture(
      await openSessionRoute(
        buildRequest({
          path: '/api/v1/auth/sessions',
          method: 'POST',
          body: { challengeId: usedChallengeId, code: usedCode },
          address: usedAddress,
        }),
      ),
    );

    // 4. Défi inexistant.
    const missing = await capture(
      await openSessionRoute(
        buildRequest({
          path: '/api/v1/auth/sessions',
          method: 'POST',
          body: { challengeId: randomUUID(), code: '004821' },
        }),
      ),
    );

    const cases: readonly (readonly [string, Captured])[] = [
      ['code expiré', expired],
      ['code déjà consommé', used],
      ['défi inexistant', missing],
    ];

    expect(wrong.status).toBe(401);
    expect(errorOf(wrong).code).toBe('UNAUTHENTICATED');
    expect(errorOf(wrong).details).toStrictEqual({});
    expect(wrong.setCookie).toBeNull();
    for (const [label, other] of cases) {
      expect(other.status, `même statut : ${label}`).toBe(wrong.status);
      expect(
        Buffer.compare(other.normalizedBytes, wrong.normalizedBytes),
        `même corps octet à octet : ${label}`,
      ).toBe(0);
      expect(comparableHeaders(other), `mêmes en-têtes : ${label}`).toStrictEqual(
        comparableHeaders(wrong),
      );
      expect(other.setCookie, `aucun cookie posé : ${label}`).toBeNull();
    }
  }, 90_000);

  it('refuse un compte suspendu APRÈS la vérification du code, avec un code distinct', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('route-suspension');
    const address = nextAddress();
    const userId = await seedProfile(database.owner, { email });
    const requested = await capture(
      await requestCodeRoute(
        buildRequest({
          path: '/api/v1/auth/codes',
          method: 'POST',
          body: { identifier: email },
          address,
        }),
      ),
    );
    const challengeId = String(requested.json.challengeId);
    const code = await waitForCode(challengeId);
    await database.owner.query(
      "update public.user_profiles set status = 'SUSPENDED' where id = $1",
      [userId],
    );

    const response = await capture(
      await openSessionRoute(
        buildRequest({
          path: '/api/v1/auth/sessions',
          method: 'POST',
          body: { challengeId, code },
          address,
        }),
      ),
    );

    // La distinction n'ouvre aucune énumération : elle exige d'avoir prouvé le contrôle du canal.
    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe('FORBIDDEN');
    expect(response.setCookie).toBeNull();
  }, 60_000);

  it('refuse un corps portant un mot de passe ou un identifiant de compte', async (context) => {
    databaseOrSkip(setup, context);

    for (const body of [
      { challengeId: randomUUID(), code: '004821', password: 'sentinelle-Z9X8' },
      { challengeId: randomUUID(), code: '004821', userId: randomUUID() },
      { challengeId: randomUUID(), code: '004821', role: 'PLATFORM_ADMIN' },
    ]) {
      const response = await capture(
        await openSessionRoute(
          buildRequest({ path: '/api/v1/auth/sessions', method: 'POST', body }),
        ),
      );

      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(errorOf(response).code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('GET /api/v1/auth/sessions/current', () => {
  it('refuse sans session, et refuse pareil quel que soit le cookie présenté', async (context) => {
    databaseOrSkip(setup, context);

    const noCookie = await capture(
      await currentSessionRoute(
        buildRequest({ path: '/api/v1/auth/sessions/current', method: 'GET' }),
      ),
    );
    const inventedCookie = await capture(
      await currentSessionRoute(
        buildRequest({
          path: '/api/v1/auth/sessions/current',
          method: 'GET',
          cookie: 'jeton-invente-sans-aucune-existence-AZ09',
        }),
      ),
    );

    // ROUTE PROTÉGÉE APPELÉE DIRECTEMENT : cas de test obligatoire de docs/permissions.md. La
    // validité d'un identifiant de session n'est pas une information que la plateforme confirme :
    // « absent » et « inconnu » partagent une réponse unique.
    expect(noCookie.status).toBe(401);
    expect(errorOf(noCookie).code).toBe('UNAUTHENTICATED');
    expect(errorOf(noCookie).details).toStrictEqual({});
    expect(Buffer.compare(inventedCookie.normalizedBytes, noCookie.normalizedBytes)).toBe(0);
    expect(inventedCookie.status).toBe(401);
  });

  it('rend le compte et les échéances de la session, sans jeton', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('route-lecture');
    await seedProfile(database.owner, { email, displayName: 'Camille D.' });
    const session = await signInThroughRoutes(email, nextAddress());

    const response = await capture(
      await currentSessionRoute(
        buildRequest({
          path: '/api/v1/auth/sessions/current',
          method: 'GET',
          cookie: session.cookie,
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(Object.keys(response.json).sort()).toStrictEqual(['session', 'user']);
    expect((response.json.user as { displayName: string }).displayName).toBe('Camille D.');
    expect(Object.keys(response.json.session as object).sort()).toStrictEqual([
      'absoluteExpiresAt',
      'expiresAt',
      'issuedAt',
    ]);
    expect(response.text).not.toContain(session.cookie);
    expect(response.headers['cache-control']).toBe('no-store');
  }, 60_000);
});

describe('DELETE /api/v1/auth/sessions/current', () => {
  it('efface le cookie et rend le précédent inutilisable', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('route-deconnexion');
    await seedProfile(database.owner, { email });
    const session = await signInThroughRoutes(email, nextAddress());

    const signedOut = await capture(
      await signOutRoute(
        buildRequest({
          path: '/api/v1/auth/sessions/current',
          method: 'DELETE',
          cookie: session.cookie,
        }),
      ),
    );
    const replay = await capture(
      await currentSessionRoute(
        buildRequest({
          path: '/api/v1/auth/sessions/current',
          method: 'GET',
          cookie: session.cookie,
        }),
      ),
    );

    expect(signedOut.status).toBe(204);
    expect(signedOut.text).toBe('');
    expect(signedOut.setCookie).toContain('Max-Age=0');
    expect(signedOut.setCookie).toContain('HttpOnly');
    // « Réutilisation d'une ancienne session », cas de test obligatoire de docs/permissions.md.
    expect(replay.status).toBe(401);
    expect(errorOf(replay).code).toBe('UNAUTHENTICATED');
  }, 60_000);

  it('réussit même sans session valide, et n écrit alors aucune preuve', async (context) => {
    const database = databaseOrSkip(setup, context);

    const before = await database.owner.query<{ readonly count: string }>(
      "select count(*)::text as count from public.audit_logs where action = 'USER_SIGNED_OUT'",
    );
    const withoutCookie = await capture(
      await signOutRoute(buildRequest({ path: '/api/v1/auth/sessions/current', method: 'DELETE' })),
    );
    const withInvented = await capture(
      await signOutRoute(
        buildRequest({
          path: '/api/v1/auth/sessions/current',
          method: 'DELETE',
          cookie: 'jeton-invente-sans-aucune-existence-AZ09',
        }),
      ),
    );
    const after = await database.owner.query<{ readonly count: string }>(
      "select count(*)::text as count from public.audit_logs where action = 'USER_SIGNED_OUT'",
    );

    // Une déconnexion ne doit jamais échouer : répondre 401 laisserait une session vivante sur un
    // poste partagé au motif que l'appelant n'a pas su prouver qu'elle lui appartenait.
    expect(withoutCookie.status).toBe(204);
    expect(withInvented.status).toBe(204);
    expect(withoutCookie.setCookie).toContain('Max-Age=0');
    // Une ligne d'audit par jeton inventé offrirait un moyen de faire grossir la table de preuve.
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  }, 60_000);

  it('reste soumise à la vérification d origine', async (context) => {
    databaseOrSkip(setup, context);

    const response = await capture(
      await signOutRoute(
        buildRequest({
          path: '/api/v1/auth/sessions/current',
          method: 'DELETE',
          headers: { origin: 'https://site-attaquant.exemple' },
        }),
      ),
    );

    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe('FORBIDDEN');
  });
});

describe('POST /api/v1/auth/sessions/commands/revoke-all', () => {
  it('refuse sans session', async (context) => {
    databaseOrSkip(setup, context);

    const response = await capture(
      await revokeAllRoute(
        buildRequest({
          path: '/api/v1/auth/sessions/commands/revoke-all',
          method: 'POST',
          body: { clientEventId: randomUUID() },
        }),
      ),
    );

    expect(response.status).toBe(401);
    expect(errorOf(response).code).toBe('UNAUTHENTICATED');
  });

  it('ferme toutes les sessions du compte, la courante comprise', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('route-revocation');
    await seedProfile(database.owner, { email });
    const first = await signInThroughRoutes(email, nextAddress());
    const second = await signInThroughRoutes(email, nextAddress());

    const response = await capture(
      await revokeAllRoute(
        buildRequest({
          path: '/api/v1/auth/sessions/commands/revoke-all',
          method: 'POST',
          body: { clientEventId: randomUUID() },
          cookie: first.cookie,
        }),
      ),
    );
    const currentAfter = await capture(
      await currentSessionRoute(
        buildRequest({
          path: '/api/v1/auth/sessions/current',
          method: 'GET',
          cookie: first.cookie,
        }),
      ),
    );
    const otherAfter = await capture(
      await currentSessionRoute(
        buildRequest({
          path: '/api/v1/auth/sessions/current',
          method: 'GET',
          cookie: second.cookie,
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(response.json).toStrictEqual({ revokedCount: 2 });
    // L'appelant se déconnecte par sa propre commande : la commande existe pour le cas où l'on
    // soupçonne qu'un tiers détient un accès, et on ne sait pas laquelle des sessions est la sienne.
    expect(response.setCookie).toContain('Max-Age=0');
    expect(currentAfter.status).toBe(401);
    expect(otherAfter.status).toBe(401);
  }, 90_000);

  it('ne laisse pas viser le compte d autrui', async (context) => {
    const database = databaseOrSkip(setup, context);
    const victimEmail = nextEmail('route-victime');
    const attackerEmail = nextEmail('route-attaquant');
    await seedProfile(database.owner, { email: victimEmail });
    await seedProfile(database.owner, { email: attackerEmail });
    const victim = await signInThroughRoutes(victimEmail, nextAddress());
    const attacker = await signInThroughRoutes(attackerEmail, nextAddress());

    const response = await capture(
      await revokeAllRoute(
        buildRequest({
          path: '/api/v1/auth/sessions/commands/revoke-all',
          method: 'POST',
          body: { clientEventId: randomUUID(), userId: victim.userId },
          cookie: attacker.cookie,
        }),
      ),
    );
    const victimAfter = await capture(
      await currentSessionRoute(
        buildRequest({
          path: '/api/v1/auth/sessions/current',
          method: 'GET',
          cookie: victim.cookie,
        }),
      ),
    );

    // Un identifiant de compte accepté en entrée transformerait cette route en déconnexion forcée
    // d'autrui, c'est-à-dire en déni de service ciblé sur un coordinateur en pleine opération.
    expect(response.status).toBe(400);
    expect(errorOf(response).code).toBe('VALIDATION_ERROR');
    expect(victimAfter.status).toBe(200);
  }, 90_000);

  it('absorbe le rejeu du même clientEventId', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('route-rejeu');
    await seedProfile(database.owner, { email });
    const session = await signInThroughRoutes(email, nextAddress());
    const clientEventId = randomUUID();
    const call = async (): Promise<Captured> =>
      capture(
        await revokeAllRoute(
          buildRequest({
            path: '/api/v1/auth/sessions/commands/revoke-all',
            method: 'POST',
            body: { clientEventId },
            cookie: session.cookie,
          }),
        ),
      );

    const first = await call();
    // La session courante étant révoquée, le rejeu passe par une session neuve : c'est le cas
    // réel d'un client qui rejoue sa commande depuis un autre appareil après une coupure réseau.
    const other = await signInThroughRoutes(email, nextAddress());
    const replay = await capture(
      await revokeAllRoute(
        buildRequest({
          path: '/api/v1/auth/sessions/commands/revoke-all',
          method: 'POST',
          body: { clientEventId },
          cookie: other.cookie,
        }),
      ),
    );

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.json).toStrictEqual(first.json);
    const { rows } = await database.owner.query<{ readonly count: string }>(
      "select count(*)::text as count from public.audit_logs where action = 'USER_SESSIONS_REVOKED' and target_id = $1",
      [session.userId],
    );
    // Le rejeu renvoie la réponse initiale SANS nouvel effet : une seule preuve écrite.
    expect(rows[0]?.count).toBe('1');
    // Et la session qui a servi au rejeu reste ouverte, la révocation n'ayant pas été rejouée.
    const otherAfter = await capture(
      await currentSessionRoute(
        buildRequest({
          path: '/api/v1/auth/sessions/current',
          method: 'GET',
          cookie: other.cookie,
        }),
      ),
    );
    expect(otherAfter.status).toBe(200);
  }, 90_000);
});

describe('neutralité de durée', () => {
  it('répond en un temps comparable pour un identifiant connu et pour un inconnu', async (context) => {
    const database = databaseOrSkip(setup, context);
    const samples = 6;
    const known: number[] = [];
    const unknown: number[] = [];

    // Chaque mesure utilise SON identifiant et SON adresse : les compteurs de limitation ne
    // s'appliquent qu'une fois par mesure, et n'introduisent donc aucun écart entre les deux séries.
    for (let index = 0; index < samples; index += 1) {
      const knownEmail = nextEmail(`duree-connu-${index}`);
      await seedProfile(database.owner, { email: knownEmail });

      const startedKnown = performance.now();
      await requestCodeRoute(
        buildRequest({
          path: '/api/v1/auth/codes',
          method: 'POST',
          body: { identifier: knownEmail },
        }),
      );
      known.push(performance.now() - startedKnown);

      const startedUnknown = performance.now();
      await requestCodeRoute(
        buildRequest({
          path: '/api/v1/auth/codes',
          method: 'POST',
          body: { identifier: nextEmail(`duree-inconnu-${index}`) },
        }),
      );
      unknown.push(performance.now() - startedUnknown);
    }

    const median = (values: number[]): number => {
      const sorted = [...values].sort((left, right) => left - right);
      return sorted[Math.floor(sorted.length / 2)] ?? 0;
    };
    const medianKnown = median(known);
    const medianUnknown = median(unknown);

    // La neutralité de durée se vérifie sur une DISTRIBUTION, jamais sur une exécution unique
    // (docs/api-contract.md). Les deux branches font le même travail et l'envoi n'est jamais
    // attendu ; le plancher commun absorbe le résidu.
    expect(medianKnown).toBeGreaterThanOrEqual(240);
    expect(medianUnknown).toBeGreaterThanOrEqual(240);
    expect(Math.abs(medianKnown - medianUnknown)).toBeLessThan(100);
  }, 120_000);
});

import { createHash, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * L'environnement doit être posé AVANT l'évaluation des imports : `verify-sign-in-code.ts` calcule
 * son empreinte leurre au chargement du module, ce qui appelle `getServerConfig()`. Sans cela,
 * l'import du module échoue sur une configuration absente. `vi.hoisted` est exécuté avant les
 * imports par la transformation de Vitest.
 *
 * `DATABASE_URL` reçoit ici une valeur d'attente valide : la vraie cible n'est connue qu'après la
 * création de la base jetable, et `beforeAll` la substitue avant que le moindre pool ne s'ouvre.
 */
vi.hoisted(() => {
  process.env.APP_ENV = 'local';
  process.env.APP_VERSION = '0.0.0-test';
  process.env.LOG_LEVEL = 'error';
  process.env.AUTH_SECRET = 'secret-de-test-fictif-identite-de-plus-de-32-caracteres';
  process.env.DATABASE_URL = 'postgresql://attente:attente@localhost:5432/attente';
  process.env.DATABASE_SSL = 'disable';
  process.env.DATABASE_POOL_MAX = '20';
});

import { type AppError, isAppError, toErrorBody } from '@/application/errors';
import { requireSessionFromRequest } from '@/authorization';
import { buildSessionCookie } from '@/authorization/session-cookie';
import { resetServerConfigCache } from '@/config/env';
import type { CodeDelivery, SignInCodeMessage } from '@/domain/identity/code-delivery';
import { configureCodeDelivery, resetCodeDelivery } from '@/domain/identity/code-delivery';
import {
  hashAttemptSubject,
  hashIdentifier,
  hashIpAddress,
  hashSessionToken,
} from '@/domain/identity/hashing';
import {
  REQUEST_CODE_BY_IDENTIFIER,
  SIGN_IN_CODE_LENGTH,
  SIGN_IN_CODE_MAX_ATTEMPTS,
  SIGN_IN_CODE_RESEND_SECONDS,
  SIGN_IN_CODE_TTL_SECONDS,
} from '@/domain/identity/policy';
import { requestSignInCode } from '@/domain/identity/request-sign-in-code';
import { revokeAllSessions, signOut } from '@/domain/identity/sign-out';
import type { RequestOrigin } from '@/domain/identity/types';
import { verifySignInCode } from '@/domain/identity/verify-sign-in-code';
import { closePool, getPool } from '@/infrastructure/database/pool';
import { logger } from '@/observability/logger';
import type { DisposableDatabaseSetup } from './setup/database';
import { createDisposableDatabase, databaseOrSkip, NOT_PREPARED } from './setup/database';

/**
 * Parcours d'identité de US-010, éprouvé contre une vraie base PostgreSQL.
 *
 * POURQUOI CE NIVEAU ET PAS DES DOUBLURES. Trois des garanties de cette story n'existent que dans
 * le SQL et disparaîtraient avec un dépôt simulé :
 *
 * - la consommation atomique du défi, qui tranche entre deux vérifications simultanées et n'est
 *   portée par aucune ligne de TypeScript ;
 * - le comptage exact des tentatives sous rafale, qui tient à `INSERT ... ON CONFLICT DO UPDATE`
 *   et au verrou de ligne ;
 * - le prédicat de validité de session à quatre conditions, dont la quatrième porte sur une autre
 *   table et coupe l'accès d'un compte suspendu.
 *
 * Un test qui doublerait le dépôt vérifierait la doublure. Chaque fichier travaille donc dans une
 * base jetable, migrée depuis le dépôt, supprimée à la fin.
 *
 * DISCIPLINE DES COMPTEURS. La limitation de tentatives est réelle et partagée : elle porte sur
 * l'identifiant normalisé ET sur l'adresse d'appel. Deux tests qui réutiliseraient la même adresse
 * s'empoisonneraient mutuellement, et le second échouerait pour une raison sans rapport avec ce
 * qu'il vérifie. Chaque cas reçoit donc son adresse (`nextOrigin`) et son identifiant.
 */

/** Identifiant de requête figé : le seul champ qui diffère légitimement entre deux erreurs. */
const FIXED_REQUEST_ID = 'req_11111111-2222-4333-8444-555555555555';

const USER_AGENT =
  'Mozilla/5.0 (Android 14; Mobile; rv:141.0) Gecko/141.0 Firefox/141.0.2 sentinelle-agent-Q4W3';

/** Le sujet « défi inconnu » est PARTAGÉ par tous les appels portant un défi inexistant. */
const VERIFY_MAX_ATTEMPTS_BY_IDENTIFIER = 10;

let setup: DisposableDatabaseSetup = NOT_PREPARED;
const deliveries: SignInCodeMessage[] = [];
let addressCounter = 0;

/**
 * Adaptateur d'envoi de test. Il rend le code disponible au test SANS passer par un journal :
 * l'adaptateur de journalisation n'écrit le code qu'en environnement local, et un test qui
 * dépendrait de cette exception vérifierait le repli au lieu du parcours.
 */
const recordingDelivery: CodeDelivery = {
  send(message: SignInCodeMessage): Promise<void> {
    deliveries.push(message);
    return Promise.resolve();
  },
};

/** Une adresse par cas de test : les compteurs de limitation ne se croisent jamais. */
function nextOrigin(): RequestOrigin {
  addressCounter += 1;
  const block = Math.floor(addressCounter / 250);
  const host = (addressCounter % 250) + 1;
  return { ipAddress: `203.0.${block}.${host}`, userAgent: USER_AGENT };
}

function nextEmail(label: string): string {
  return `sentinelle-${label}-${randomUUID().slice(0, 8)}@exemple.test`;
}

/**
 * Empreinte du sujet « demande de code, par identifiant », reconstruite comme le domaine la
 * calcule. Elle permet de désigner exactement une ligne de `auth_attempts` sans jamais écrire ni
 * lire l'identifiant en clair dans la table.
 */
function subjectHashOf(email: string): string {
  return hashAttemptSubject(
    REQUEST_CODE_BY_IDENTIFIER.dimension,
    REQUEST_CODE_BY_IDENTIFIER.purpose,
    email.toLowerCase(),
  );
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

/**
 * Attend la remise du code hors du chemin de réponse. `requestSignInCode` ne l'attend jamais —
 * c'est le seul travail réellement différent entre un compte connu et un compte inconnu — donc le
 * test doit l'attendre à sa place.
 */
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

/** Laisse à la remise détachée le temps de ne PAS avoir lieu, pour les cas où elle ne doit pas. */
async function settleDelivery(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 120));
}

async function captureAppError(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (error) {
    if (isAppError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error("l'appel aurait dû être refusé");
}

/**
 * Corps d'erreur sérialisé, `requestId` figé. C'est exactement ce qui part sur le réseau : la
 * comparaison octet à octet de deux instances de cette valeur est la définition testable de
 * « réponse strictement identique ».
 */
function errorBytes(error: AppError): Buffer {
  return Buffer.from(JSON.stringify(toErrorBody(error, FIXED_REQUEST_ID)), 'utf8');
}

/**
 * Ouvre à l'avance les connexions du pool applicatif.
 *
 * SANS CETTE PRÉPARATION, LES TESTS DE COURSE MESURERAIENT LA MAUVAISE CHOSE. Une douzaine de
 * connexions ouvertes simultanément vers une base conteneurisée coûte, sur un poste de
 * développement, plus que le délai d'obtention d'une connexion du pilote : les appels échouent
 * alors sur « timeout exceeded when trying to connect » au lieu d'être arbitrés par la base, et
 * le test ne dirait plus rien de la concurrence qu'il prétend éprouver.
 *
 * Constat opérationnel tiré de là, consigné au rapport : la limitation de tentatives s'applique
 * APRÈS l'obtention d'une connexion. Une rafale plus large que le pool ne produit donc pas des
 * réponses 429 mais des erreurs internes 500, la protection ne pouvant pas délester avant
 * d'atteindre la base.
 */
async function warmPool(connections: number): Promise<void> {
  const pool = getPool();
  await Promise.all(Array.from({ length: connections }, () => pool.query('select 1')));
}

async function countRows(client: Client, sql: string, values: unknown[]): Promise<number> {
  const { rows } = await client.query<{ readonly count: string }>(sql, values);
  return Number(rows[0]?.count ?? '-1');
}

function requestWithCookie(token: string): Request {
  return new Request('https://appui-feux.exemple.test/api/v1/auth/sessions/current', {
    headers: { cookie: buildSessionCookie(token).split(';')[0] ?? '' },
  });
}

/** Une session est valide si, et seulement si, la barrière d'autorisation la laisse passer. */
async function isSessionUsable(token: string): Promise<boolean> {
  try {
    await requireSessionFromRequest(requestWithCookie(token));
    return true;
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHENTICATED') {
      return false;
    }
    throw error;
  }
}

async function signIn(
  client: Client,
  email: string,
  origin: RequestOrigin,
): Promise<{ readonly token: string; readonly userId: string }> {
  const challenge = await requestSignInCode({ identifier: email, origin });
  const code = await waitForCode(challenge.challengeId);
  const result = await verifySignInCode({ challengeId: challenge.challengeId, code, origin });
  void client;
  return { token: result.sessionToken, userId: result.user.id };
}

beforeAll(async () => {
  // Chaque refus produit une ligne d'avertissement : comportement voulu, sans place dans le
  // rapport de test. La vérification du CONTENU des journaux a son propre fichier.
  logger.level = 'silent';
  // La valeur d'attente doit céder la place : `loadIntegrationEnvironment` fait primer
  // `process.env` sur `.env.local`, et la cible réelle des tests est celle du fichier.
  delete process.env.DATABASE_URL;
  setup = await createDisposableDatabase({ withMigrations: true });
  process.env.DATABASE_URL = setup.available
    ? setup.database.url
    : 'postgresql://attente:attente@localhost:5432/attente';
  resetServerConfigCache();
  await closePool();
  if (setup.available) {
    configureCodeDelivery(recordingDelivery);
    await warmPool(14);
  }
}, 120_000);

afterAll(async () => {
  resetCodeDelivery();
  await closePool();
  if (setup.available) {
    await setup.database.dispose();
  }
});

describe('demande de code — normalisation et neutralité', () => {
  it('retrouve le compte quelle que soit la casse et les espaces de la saisie', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('normalisation');
    const userId = await seedProfile(database.owner, { email });

    const first = await requestSignInCode({ identifier: email, origin: nextOrigin() });
    const second = await requestSignInCode({
      identifier: `  ${email.toUpperCase()}  `,
      origin: nextOrigin(),
    });

    const { rows } = await database.owner.query<{
      readonly identifier_hash: string;
      readonly user_profile_id: string | null;
    }>('select identifier_hash, user_profile_id from public.auth_challenges where id = any($1)', [
      [first.challengeId, second.challengeId],
    ]);

    expect(rows).toHaveLength(2);
    // La forme normalisée est la SEULE valeur hachée : sans elle, changer la casse produirait une
    // autre empreinte, donc une autre file de défis et un compteur de tentatives vierge.
    expect(new Set(rows.map((row) => row.identifier_hash)).size).toBe(1);
    expect(rows[0]?.identifier_hash).toBe(hashIdentifier(email.toLowerCase()));
    expect(new Set(rows.map((row) => row.user_profile_id))).toStrictEqual(new Set([userId]));
  });

  it('ne stocke jamais l identifiant en clair', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('jamais-en-clair');
    await seedProfile(database.owner, { email });

    const challenge = await requestSignInCode({ identifier: email, origin: nextOrigin() });

    const { rows } = await database.owner.query<{ readonly ligne: string }>(
      'select to_jsonb(c)::text as ligne from public.auth_challenges c where c.id = $1',
      [challenge.challengeId],
    );
    // Une fuite de cette table ne doit pas rendre la liste des courriels des utilisateurs.
    expect(rows[0]?.ligne).not.toContain(email);
    expect(rows[0]?.ligne).not.toContain(email.split('@')[0]);
  });

  it('répond exactement pareil pour un identifiant connu et pour un identifiant inconnu', async (context) => {
    const database = databaseOrSkip(setup, context);
    const known = nextEmail('connu');
    await seedProfile(database.owner, { email: known });
    const unknown = nextEmail('inconnu');

    const forKnown = await requestSignInCode({ identifier: known, origin: nextOrigin() });
    const forUnknown = await requestSignInCode({ identifier: unknown, origin: nextOrigin() });

    // Seul `challengeId` diffère, et il est opaque : il ne contient pas l'identifiant saisi.
    expect({ ...forKnown, challengeId: 'opaque' }).toStrictEqual({
      ...forUnknown,
      challengeId: 'opaque',
    });
    expect(forKnown.codeLength).toBe(SIGN_IN_CODE_LENGTH);
    expect(forKnown.expiresInSeconds).toBe(SIGN_IN_CODE_TTL_SECONDS);
    expect(forKnown.resendAvailableInSeconds).toBe(SIGN_IN_CODE_RESEND_SECONDS);
    expect(forUnknown.challengeId).not.toContain(unknown.split('@')[0]);
  });

  it('crée un défi AUSSI pour un identifiant inconnu, avec la même durée de vie', async (context) => {
    const database = databaseOrSkip(setup, context);
    const unknown = nextEmail('defi-inconnu');

    const challenge = await requestSignInCode({ identifier: unknown, origin: nextOrigin() });

    const { rows } = await database.owner.query<{
      readonly user_profile_id: string | null;
      readonly max_attempts: number;
      readonly ttl: string;
    }>(
      `select user_profile_id, max_attempts,
              round(extract(epoch from (expires_at - created_at)))::text as ttl
         from public.auth_challenges where id = $1`,
      [challenge.challengeId],
    );

    // `user_profile_id` est nullable exactement pour cela : le travail du serveur est le même dans
    // les deux cas, donc la durée aussi.
    expect(rows[0]?.user_profile_id).toBeNull();
    expect(rows[0]?.max_attempts).toBe(SIGN_IN_CODE_MAX_ATTEMPTS);
    expect(rows[0]?.ttl).toBe(String(SIGN_IN_CODE_TTL_SECONDS));
  });

  it('ne remet un code qu à un compte réellement actif', async (context) => {
    const database = databaseOrSkip(setup, context);
    const unknown = nextEmail('sans-remise');
    const suspended = nextEmail('suspendu-sans-remise');
    await seedProfile(database.owner, { email: suspended, status: 'SUSPENDED' });

    const forUnknown = await requestSignInCode({ identifier: unknown, origin: nextOrigin() });
    const forSuspended = await requestSignInCode({ identifier: suspended, origin: nextOrigin() });
    await settleDelivery();

    // Remettre un code à un compte suspendu laisserait croire que la connexion aboutira ; le refus
    // n'arriverait qu'après la saisie. La RÉPONSE, elle, reste identique dans les deux cas.
    expect(
      deliveries.filter((message) =>
        [forUnknown.challengeId, forSuspended.challengeId].includes(message.challengeId),
      ),
    ).toStrictEqual([]);
    expect({ ...forUnknown, challengeId: 'opaque' }).toStrictEqual({
      ...forSuspended,
      challengeId: 'opaque',
    });
  });

  it('remet un code de six chiffres au destinataire normalisé, avec son échéance', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('remise');
    await seedProfile(database.owner, { email });

    const challenge = await requestSignInCode({
      identifier: email.toUpperCase(),
      origin: nextOrigin(),
    });
    await waitForCode(challenge.challengeId);
    const message = deliveries.find((candidate) => candidate.challengeId === challenge.challengeId);

    expect(message?.channel).toBe('EMAIL');
    expect(message?.recipient).toBe(email.toLowerCase());
    expect(message?.code).toMatch(/^\d{6}$/);
    expect(message?.preferredLanguage).toBe('fr');
    expect((message?.expiresAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(
      (SIGN_IN_CODE_TTL_SECONDS - 60) * 1000,
    );
  });

  it('refuse un numéro de téléphone tant que le canal SMS n existe pas', async (context) => {
    databaseOrSkip(setup, context);

    const error = await captureAppError(() =>
      requestSignInCode({ identifier: '+33612345678', origin: nextOrigin() }),
    );

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details.reason).toBe('PHONE_CHANNEL_UNAVAILABLE');
  });
});

describe('normalisation du téléphone — portée par le schéma', () => {
  /**
   * Le canal SMS n'est pas livré : aucune connexion par téléphone n'existe côté domaine. La seule
   * normalisation de téléphone réellement en vigueur est celle de `user_profiles`, et elle mérite
   * d'être éprouvée, faute de quoi `0612345678` et `+33612345678` deviendraient deux comptes pour
   * un seul destinataire le jour où le canal s'ouvrira.
   */
  it('n accepte qu un numéro E.164 strict', async (context) => {
    const database = databaseOrSkip(setup, context);
    const refused = ['0612345678', '+33 6 12 34 56 78', '+33(0)612345678', '33612345678', '+0612'];

    for (const phone of refused) {
      await database.owner.query('begin');
      let failed = false;
      try {
        await database.owner.query(
          `insert into public.user_profiles (display_name, phone) values ('Camille D.', $1)`,
          [phone],
        );
      } catch {
        failed = true;
      }
      await database.owner.query('rollback');
      expect(failed, `numéro refusé : ${phone}`).toBe(true);
    }

    const { rows } = await database.owner.query<{ readonly phone: string }>(
      `insert into public.user_profiles (display_name, phone) values ('Camille D.', $1) returning phone`,
      [`+3361234${String(1_000 + addressCounter).slice(0, 4)}`],
    );
    expect(rows[0]?.phone).toMatch(/^\+[1-9][0-9]{7,14}$/);
  });

  it('refuse deux comptes portant le même numéro normalisé', async (context) => {
    const database = databaseOrSkip(setup, context);
    const phone = '+33600000042';

    await database.owner.query(
      `insert into public.user_profiles (display_name, phone) values ('Camille D.', $1)`,
      [phone],
    );

    await database.owner.query('begin');
    let failed = false;
    try {
      await database.owner.query(
        `insert into public.user_profiles (display_name, phone) values ('Dominique R.', $1)`,
        [phone],
      );
    } catch {
      failed = true;
    }
    await database.owner.query('rollback');

    expect(failed).toBe(true);
  });
});

describe('vérification du code — les quatre échecs sont indiscernables', () => {
  it('rend une réponse identique OCTET À OCTET pour cinq causes de refus différentes', async (context) => {
    const database = databaseOrSkip(setup, context);

    // 1. Code erroné.
    const wrongEmail = nextEmail('code-errone');
    await seedProfile(database.owner, { email: wrongEmail });
    const wrongChallenge = await requestSignInCode({
      identifier: wrongEmail,
      origin: nextOrigin(),
    });
    const trueCode = await waitForCode(wrongChallenge.challengeId);
    const wrongCode = trueCode === '000000' ? '111111' : '000000';
    const wrongError = await captureAppError(() =>
      verifySignInCode({
        challengeId: wrongChallenge.challengeId,
        code: wrongCode,
        origin: nextOrigin(),
      }),
    );

    // 2. Code expiré. `expires_at > created_at` est une contrainte de table : les deux dates
    // reculent ensemble, sans quoi la mise à jour serait refusée.
    const expiredEmail = nextEmail('code-expire');
    await seedProfile(database.owner, { email: expiredEmail });
    const expiredChallenge = await requestSignInCode({
      identifier: expiredEmail,
      origin: nextOrigin(),
    });
    const expiredCode = await waitForCode(expiredChallenge.challengeId);
    await database.owner.query(
      `update public.auth_challenges
          set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
        where id = $1`,
      [expiredChallenge.challengeId],
    );
    const expiredError = await captureAppError(() =>
      verifySignInCode({
        challengeId: expiredChallenge.challengeId,
        code: expiredCode,
        origin: nextOrigin(),
      }),
    );

    // 3. Code déjà consommé.
    const usedEmail = nextEmail('code-consomme');
    await seedProfile(database.owner, { email: usedEmail });
    const usedOrigin = nextOrigin();
    const usedChallenge = await requestSignInCode({ identifier: usedEmail, origin: usedOrigin });
    const usedCode = await waitForCode(usedChallenge.challengeId);
    await verifySignInCode({
      challengeId: usedChallenge.challengeId,
      code: usedCode,
      origin: usedOrigin,
    });
    const usedError = await captureAppError(() =>
      verifySignInCode({
        challengeId: usedChallenge.challengeId,
        code: usedCode,
        origin: usedOrigin,
      }),
    );

    // 4. Défi inexistant.
    const missingError = await captureAppError(() =>
      verifySignInCode({ challengeId: randomUUID(), code: '004821', origin: nextOrigin() }),
    );

    // 5. Essais épuisés, présentés avec le BON code.
    const burntEmail = nextEmail('essais-epuises');
    await seedProfile(database.owner, { email: burntEmail });
    const burntChallenge = await requestSignInCode({
      identifier: burntEmail,
      origin: nextOrigin(),
    });
    const burntCode = await waitForCode(burntChallenge.challengeId);
    await database.owner.query(
      'update public.auth_challenges set attempts = max_attempts where id = $1',
      [burntChallenge.challengeId],
    );
    const burntError = await captureAppError(() =>
      verifySignInCode({
        challengeId: burntChallenge.challengeId,
        code: burntCode,
        origin: nextOrigin(),
      }),
    );

    const reference = errorBytes(wrongError);
    const cases: readonly (readonly [string, AppError])[] = [
      ['code expiré', expiredError],
      ['code déjà consommé', usedError],
      ['défi inexistant', missingError],
      ['essais épuisés', burntError],
    ];

    expect(wrongError.code).toBe('UNAUTHENTICATED');
    expect(wrongError.httpStatus).toBe(401);
    expect(JSON.parse(reference.toString('utf8'))).toStrictEqual({
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Vous devez vous connecter pour effectuer cette action.',
        requestId: FIXED_REQUEST_ID,
        details: {},
      },
    });
    for (const [label, error] of cases) {
      expect(error.httpStatus, `statut identique : ${label}`).toBe(wrongError.httpStatus);
      // Comparaison littérale : une différence d'un seul octet suffirait à distinguer les cas.
      expect(
        Buffer.compare(errorBytes(error), reference),
        `réponse identique octet à octet : ${label}`,
      ).toBe(0);
    }
  }, 60_000);

  it('brûle le code même quand la vérification échoue pour une autre raison', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('code-brule');
    await seedProfile(database.owner, { email });
    const origin = nextOrigin();
    const challenge = await requestSignInCode({ identifier: email, origin });
    const code = await waitForCode(challenge.challengeId);

    await verifySignInCode({ challengeId: challenge.challengeId, code, origin });
    const replay = await captureAppError(() =>
      verifySignInCode({ challengeId: challenge.challengeId, code, origin }),
    );

    expect(replay.code).toBe('UNAUTHENTICATED');
    const { rows } = await database.owner.query<{ readonly consumed_at: Date | null }>(
      'select consumed_at from public.auth_challenges where id = $1',
      [challenge.challengeId],
    );
    expect(rows[0]?.consumed_at).not.toBeNull();
  });

  it('refuse le rejeu SANS effet de bord : ni session, ni preuve, ni consommation nouvelle', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('rejeu');
    const userId = await seedProfile(database.owner, { email });
    const origin = nextOrigin();
    const challenge = await requestSignInCode({ identifier: email, origin });
    const code = await waitForCode(challenge.challengeId);

    await verifySignInCode({ challengeId: challenge.challengeId, code, origin });

    const { rows: before } = await database.owner.query<{ readonly consumed_at: Date }>(
      'select consumed_at from public.auth_challenges where id = $1',
      [challenge.challengeId],
    );
    const sessionsBefore = await countRows(
      database.owner,
      'select count(*)::text as count from public.sessions where user_profile_id = $1',
      [userId],
    );
    const auditBefore = await countRows(
      database.owner,
      "select count(*)::text as count from public.audit_logs where target_id = $1 and action = 'USER_SIGNED_IN'",
      [userId],
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const replay = await captureAppError(() =>
        verifySignInCode({ challengeId: challenge.challengeId, code, origin }),
      );
      expect(replay.code).toBe('UNAUTHENTICATED');
    }

    const { rows: after } = await database.owner.query<{ readonly consumed_at: Date }>(
      'select consumed_at from public.auth_challenges where id = $1',
      [challenge.challengeId],
    );

    expect(after[0]?.consumed_at?.getTime()).toBe(before[0]?.consumed_at?.getTime());
    expect(
      await countRows(
        database.owner,
        'select count(*)::text as count from public.sessions where user_profile_id = $1',
        [userId],
      ),
    ).toBe(sessionsBefore);
    // Un appelant non authentifié ne doit pas pouvoir faire grossir la table de preuve à volonté.
    expect(
      await countRows(
        database.owner,
        "select count(*)::text as count from public.audit_logs where target_id = $1 and action = 'USER_SIGNED_IN'",
        [userId],
      ),
    ).toBe(auditBefore);
  });

  it('refuse au-delà du plafond d essais porté par le défi', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('plafond-defi');
    await seedProfile(database.owner, { email });
    const origin = nextOrigin();
    const challenge = await requestSignInCode({ identifier: email, origin });
    const code = await waitForCode(challenge.challengeId);
    const wrongCode = code === '000000' ? '111111' : '000000';

    // Cinq essais erronés sont tolérés : `attempts < max_attempts` porte sur la valeur d'AVANT
    // l'essai courant.
    for (let attempt = 0; attempt < SIGN_IN_CODE_MAX_ATTEMPTS; attempt += 1) {
      const failure = await captureAppError(() =>
        verifySignInCode({ challengeId: challenge.challengeId, code: wrongCode, origin }),
      );
      expect(failure.code).toBe('UNAUTHENTICATED');
    }

    // Le sixième, présenté avec le BON code, est refusé lui aussi.
    const exhausted = await captureAppError(() =>
      verifySignInCode({ challengeId: challenge.challengeId, code, origin }),
    );

    expect(exhausted.code).toBe('UNAUTHENTICATED');
    const { rows } = await database.owner.query<{
      readonly attempts: number;
      readonly consumed_at: Date | null;
    }>('select attempts, consumed_at from public.auth_challenges where id = $1', [
      challenge.challengeId,
    ]);
    expect(rows[0]?.consumed_at).toBeNull();
    expect(rows[0]?.attempts).toBeGreaterThanOrEqual(SIGN_IN_CODE_MAX_ATTEMPTS);
    expect(VERIFY_MAX_ATTEMPTS_BY_IDENTIFIER).toBeGreaterThan(SIGN_IN_CODE_MAX_ATTEMPTS);
  }, 60_000);

  it('refuse une forme de code ou de défi invalide sans toucher à l état stocké', async (context) => {
    databaseOrSkip(setup, context);

    const badChallenge = await captureAppError(() =>
      verifySignInCode({ challengeId: 'pas-un-uuid', code: '004821', origin: nextOrigin() }),
    );
    const badCode = await captureAppError(() =>
      verifySignInCode({ challengeId: randomUUID(), code: '12', origin: nextOrigin() }),
    );

    expect(badChallenge.code).toBe('VALIDATION_ERROR');
    expect(badChallenge.details.fields).toStrictEqual(['challengeId']);
    expect(badCode.code).toBe('VALIDATION_ERROR');
    expect(badCode.details.fields).toStrictEqual(['code']);
  });
});

describe('concurrence — deux vérifications simultanées du même code', () => {
  it("n'ouvre qu'UNE session, les autres sont refusées", async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('course');
    const userId = await seedProfile(database.owner, { email });
    const origin = nextOrigin();
    const challenge = await requestSignInCode({ identifier: email, origin });
    const code = await waitForCode(challenge.challengeId);
    await warmPool(10);

    // VRAIE COURSE : huit appels lancés SANS attente entre eux, sur le même défi et le même code.
    // Rien n'est sérialisé côté test ; c'est la mise à jour conditionnelle de `consumeChallenge`
    // qui tranche, sur le verrou de ligne de PostgreSQL.
    const attempts = Array.from({ length: 8 }, () =>
      verifySignInCode({ challengeId: challenge.challengeId, code, origin }),
    );
    const outcomes = await Promise.allSettled(attempts);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    for (const outcome of rejected) {
      const reason: unknown = outcome.status === 'rejected' ? outcome.reason : undefined;
      expect(isAppError(reason) ? reason.code : reason).toBe('UNAUTHENTICATED');
    }

    // La preuve la plus solide n'est pas le nombre de succès : c'est le nombre de lignes.
    expect(
      await countRows(
        database.owner,
        'select count(*)::text as count from public.sessions where user_profile_id = $1',
        [userId],
      ),
    ).toBe(1);
    expect(
      await countRows(
        database.owner,
        "select count(*)::text as count from public.audit_logs where target_id = $1 and action = 'USER_SIGNED_IN'",
        [userId],
      ),
    ).toBe(1);
    const { rows } = await database.owner.query<{ readonly consumed_at: Date | null }>(
      'select consumed_at from public.auth_challenges where id = $1',
      [challenge.challengeId],
    );
    expect(rows[0]?.consumed_at).not.toBeNull();
  }, 60_000);

  it('compte exactement les tentatives lancées en rafale', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('rafale');
    const origin = nextOrigin();
    const burst = 12;
    await warmPool(14);

    // Douze demandes simultanées pour le même identifiant : le plafond est de cinq. Une lecture
    // suivie d'une décision puis d'une écriture laisserait passer autant de tentatives que
    // l'attaquant en lance ; l'incrément atomique n'en laisse passer que cinq.
    const outcomes = await Promise.allSettled(
      Array.from({ length: burst }, () => requestSignInCode({ identifier: email, origin })),
    );

    const accepted = outcomes.filter((outcome) => outcome.status === 'fulfilled').length;
    expect(accepted).toBe(REQUEST_CODE_BY_IDENTIFIER.maxAttempts);

    const { rows } = await database.owner.query<{
      readonly attempt_count: number;
      readonly blocked_until: Date | null;
    }>('select attempt_count, blocked_until from public.auth_attempts where subject_hash = $1', [
      subjectHashOf(email),
    ]);
    // AUCUNE MISE À JOUR PERDUE : les douze tentatives sont comptées, y compris celles qui ont été
    // refusées. Le compteur mesure l'intensité de la campagne ; c'est aussi ce qui rend la
    // détection du franchissement de seuil unique.
    expect(rows[0]?.attempt_count).toBe(burst);
    expect(rows[0]?.blocked_until).not.toBeNull();
  }, 60_000);
});

describe('limitation de tentatives', () => {
  it('bloque au-delà du seuil, avec la durée restante', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('limitation');
    await seedProfile(database.owner, { email });
    const origin = nextOrigin();

    for (let attempt = 0; attempt < REQUEST_CODE_BY_IDENTIFIER.maxAttempts; attempt += 1) {
      await requestSignInCode({ identifier: email, origin });
    }

    const blocked = await captureAppError(() => requestSignInCode({ identifier: email, origin }));

    expect(blocked.code).toBe('RATE_LIMITED');
    expect(blocked.httpStatus).toBe(429);
    const retryAfterSeconds = blocked.details.retryAfterSeconds;
    expect(typeof retryAfterSeconds).toBe('number');
    expect(retryAfterSeconds).toBeGreaterThan(0);
    expect(retryAfterSeconds).toBeLessThanOrEqual(REQUEST_CODE_BY_IDENTIFIER.blockSeconds);
  }, 60_000);

  it("n'écrit qu'UNE ligne d'audit par blocage, quel que soit l'acharnement", async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('audit-blocage');
    const origin = nextOrigin();

    for (let attempt = 0; attempt < REQUEST_CODE_BY_IDENTIFIER.maxAttempts + 6; attempt += 1) {
      await requestSignInCode({ identifier: email, origin }).catch(() => undefined);
    }

    const { rows } = await database.owner.query<{
      readonly count: string;
      readonly attempt_count: string | null;
      readonly target_type: string | null;
      readonly actor_user_id: string | null;
    }>(
      `select count(*)::text as count,
              min(after ->> 'attemptCount') as attempt_count,
              min(target_type) as target_type,
              min(actor_user_id::text) as actor_user_id
         from public.audit_logs
        where action = 'SIGN_IN_BLOCKED'
          and after ->> 'subjectHash' = $1`,
      [subjectHashOf(email)],
    );

    // UNE SEULE LIGNE, malgré onze tentatives dont six après le blocage. Auditer chaque tentative
    // refusée offrirait à un appelant non authentifié un levier pour faire grossir indéfiniment la
    // table de preuve ; ne jamais auditer effacerait la trace d'une campagne.
    expect(rows[0]?.count).toBe('1');
    expect(rows[0]?.attempt_count).toBe(String(REQUEST_CODE_BY_IDENTIFIER.maxAttempts + 1));
    expect(rows[0]?.target_type).toBe('AUTH_CHALLENGE');
    // L'appelant n'est pas authentifié, et le compte éventuellement visé n'est pas l'auteur.
    expect(rows[0]?.actor_user_id).toBeNull();
  }, 60_000);

  it('applique le même seuil à un identifiant inconnu', async (context) => {
    databaseOrSkip(setup, context);
    const unknown = nextEmail('limitation-inconnu');
    const origin = nextOrigin();

    for (let attempt = 0; attempt < REQUEST_CODE_BY_IDENTIFIER.maxAttempts; attempt += 1) {
      await requestSignInCode({ identifier: unknown, origin });
    }
    const blocked = await captureAppError(() => requestSignInCode({ identifier: unknown, origin }));

    // Un compteur qui ne s'appliquerait qu'aux comptes existants serait lui-même un oracle
    // d'énumération : il suffirait de compter les requêtes avant blocage.
    expect(blocked.code).toBe('RATE_LIMITED');
    expect(blocked.httpStatus).toBe(429);
  }, 60_000);

  it('ne prolonge jamais un blocage en cours', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('blocage-non-prolonge');
    const origin = nextOrigin();

    const subjectHash = subjectHashOf(email);

    for (let attempt = 0; attempt < REQUEST_CODE_BY_IDENTIFIER.maxAttempts + 1; attempt += 1) {
      await requestSignInCode({ identifier: email, origin }).catch(() => undefined);
    }
    const { rows: blocked } = await database.owner.query<{ readonly blocked_until: Date }>(
      'select blocked_until from public.auth_attempts where subject_hash = $1',
      [subjectHash],
    );
    const firstDeadline = blocked[0]?.blocked_until?.getTime() ?? 0;
    expect(firstDeadline).toBeGreaterThan(Date.now());

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await requestSignInCode({ identifier: email, origin }).catch(() => undefined);
    }

    const { rows } = await database.owner.query<{ readonly blocked_until: Date }>(
      'select blocked_until from public.auth_attempts where subject_hash = $1',
      [subjectHash],
    );

    // Prolonger à chaque tentative rendrait le blocage indéfini pour qui insiste : ce serait une
    // arme de déni de service contre un coordinateur qu'il suffirait de marteler.
    expect(rows[0]?.blocked_until?.getTime()).toBe(firstDeadline);
  }, 60_000);
});

describe('compte suspendu', () => {
  it("refuse d'ouvrir une session malgré un code valide", async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('suspendu-apres-envoi');
    const userId = await seedProfile(database.owner, { email });
    const origin = nextOrigin();
    const challenge = await requestSignInCode({ identifier: email, origin });
    const code = await waitForCode(challenge.challengeId);

    // Suspension entre la demande et la vérification : le cas réel d'une réponse à incident.
    await database.owner.query(
      "update public.user_profiles set status = 'SUSPENDED' where id = $1",
      [userId],
    );

    const refusal = await captureAppError(() =>
      verifySignInCode({ challengeId: challenge.challengeId, code, origin }),
    );

    // `FORBIDDEN` et non `UNAUTHENTICATED` : la distinction n'est faite qu'APRÈS que l'appelant a
    // prouvé qu'il contrôle le canal, elle n'ouvre donc aucune énumération. Un compte suspendu
    // doit savoir qu'il l'est pour pouvoir demander sa réactivation.
    expect(refusal.code).toBe('FORBIDDEN');
    expect(refusal.httpStatus).toBe(403);
    expect(
      await countRows(
        database.owner,
        'select count(*)::text as count from public.sessions where user_profile_id = $1',
        [userId],
      ),
    ).toBe(0);
    // L'événement mérite une trace : quelqu'un contrôle le canal d'un compte suspendu.
    expect(
      await countRows(
        database.owner,
        "select count(*)::text as count from public.audit_logs where target_id = $1 and action = 'USER_SIGN_IN_REFUSED'",
        [userId],
      ),
    ).toBe(1);
  }, 60_000);

  it('coupe immédiatement une session déjà ouverte', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('suspension-en-cours');
    const origin = nextOrigin();
    await seedProfile(database.owner, { email });
    const { token, userId } = await signIn(database.owner, email, origin);

    expect(await isSessionUsable(token)).toBe(true);

    await database.owner.query(
      "update public.user_profiles set status = 'SUSPENDED' where id = $1",
      [userId],
    );

    // Quatrième condition du prédicat de validité, celle qui porte sur une AUTRE table. Sans elle,
    // la suspension d'un coordinateur compromis ne couperait rien tant que son onglet reste
    // ouvert, alors que c'est la première mesure de réponse à incident de docs/security.md.
    expect(await isSessionUsable(token)).toBe(false);
  }, 60_000);
});

describe('session, déconnexion et révocation globale', () => {
  it('ouvre une session utilisable et prononce une destination calculée par le serveur', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('ouverture');
    const origin = nextOrigin();
    await seedProfile(database.owner, { email, displayName: 'Camille D.' });
    const challenge = await requestSignInCode({ identifier: email, origin });
    const code = await waitForCode(challenge.challengeId);

    const result = await verifySignInCode({ challengeId: challenge.challengeId, code, origin });

    expect(result.nextStep).toBe('READY');
    expect(result.redirectPath).toBe('/apres-connexion');
    expect(result.user.displayName).toBe('Camille D.');
    expect(result.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.session.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(result.session.absoluteExpiresAt.getTime()).toBeGreaterThan(
      result.session.expiresAt.getTime(),
    );
    expect(await isSessionUsable(result.sessionToken)).toBe(true);

    const { rows } = await database.owner.query<{ readonly ligne: string }>(
      'select to_jsonb(s)::text as ligne from public.sessions s where s.id = $1',
      [result.session.id],
    );
    // Le jeton n'est jamais stocké, seule son empreinte l'est.
    expect(rows[0]?.ligne).not.toContain(result.sessionToken);
    expect(rows[0]?.ligne).toContain(hashSessionToken(result.sessionToken));
  }, 60_000);

  it('rend le cookie précédent inutilisable après déconnexion', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('deconnexion');
    const origin = nextOrigin();
    await seedProfile(database.owner, { email });
    const { token, userId } = await signIn(database.owner, email, origin);

    await signOut({ sessionToken: token, origin });

    // Cas de test obligatoire de docs/permissions.md : « réutilisation d'une ancienne session ».
    expect(await isSessionUsable(token)).toBe(false);
    expect(
      await countRows(
        database.owner,
        "select count(*)::text as count from public.audit_logs where actor_user_id = $1 and action = 'USER_SIGNED_OUT'",
        [userId],
      ),
    ).toBe(1);
  }, 60_000);

  it('ne touche pas les autres sessions du compte, et ne s audite qu une fois', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('deconnexion-partielle');
    await seedProfile(database.owner, { email });
    const first = await signIn(database.owner, email, nextOrigin());
    const second = await signIn(database.owner, email, nextOrigin());

    await signOut({ sessionToken: first.token, origin: nextOrigin() });
    await signOut({ sessionToken: first.token, origin: nextOrigin() });
    await signOut({ sessionToken: 'jeton-invente-sans-aucune-existence', origin: nextOrigin() });

    // Se déconnecter d'un poste emprunté ne doit pas fermer la session du téléphone d'astreinte.
    expect(await isSessionUsable(first.token)).toBe(false);
    expect(await isSessionUsable(second.token)).toBe(true);
    expect(
      await countRows(
        database.owner,
        "select count(*)::text as count from public.audit_logs where actor_user_id = $1 and action = 'USER_SIGNED_OUT'",
        [first.userId],
      ),
    ).toBe(1);
  }, 60_000);

  it('ne lève jamais, même sans jeton', async (context) => {
    databaseOrSkip(setup, context);

    // Répondre en erreur laisserait une session vivante sur un poste partagé au motif que
    // l'appelant n'a pas su prouver qu'elle lui appartenait.
    await expect(signOut({ origin: nextOrigin() })).resolves.toBeUndefined();
    await expect(signOut({ sessionToken: '', origin: nextOrigin() })).resolves.toBeUndefined();
  });

  it('invalide TOUTES les sessions immédiatement, la courante comprise', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('revocation');
    await seedProfile(database.owner, { email });
    const sessions = [
      await signIn(database.owner, email, nextOrigin()),
      await signIn(database.owner, email, nextOrigin()),
      await signIn(database.owner, email, nextOrigin()),
    ];
    const userId = sessions[0]?.userId ?? '';

    const clientEventId = randomUUID();
    const result = await revokeAllSessions({ userId, clientEventId, origin: nextOrigin() });

    expect(result.revokedCount).toBe(3);
    for (const session of sessions) {
      expect(await isSessionUsable(session.token)).toBe(false);
    }
    // UNE SEULE ÉCRITURE coupe tout : `sessions_revoked_at` sur le profil. Marquer les N lignes
    // laisserait une fenêtre ouverte tant que le balayage n'est pas terminé.
    const { rows } = await database.owner.query<{ readonly sessions_revoked_at: Date | null }>(
      'select sessions_revoked_at from public.user_profiles where id = $1',
      [userId],
    );
    expect(rows[0]?.sessions_revoked_at).not.toBeNull();
    expect(
      await countRows(
        database.owner,
        "select count(*)::text as count from public.audit_logs where target_id = $1 and action = 'USER_SESSIONS_REVOKED'",
        [userId],
      ),
    ).toBe(1);
  }, 60_000);

  it('laisse se reconnecter après une révocation globale', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('revocation-puis-reconnexion');
    await seedProfile(database.owner, { email });
    const before = await signIn(database.owner, email, nextOrigin());

    await revokeAllSessions({
      userId: before.userId,
      clientEventId: randomUUID(),
      origin: nextOrigin(),
    });
    const after = await signIn(database.owner, email, nextOrigin());

    // La comparaison est stricte : une session émise APRÈS la révocation reste valide, sans quoi
    // la commande couperait le compte définitivement.
    expect(await isSessionUsable(before.token)).toBe(false);
    expect(await isSessionUsable(after.token)).toBe(true);
  }, 60_000);

  it('absorbe le rejeu portant le même clientEventId', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('revocation-rejeu');
    await seedProfile(database.owner, { email });
    const session = await signIn(database.owner, email, nextOrigin());
    const clientEventId = randomUUID();

    const first = await revokeAllSessions({
      userId: session.userId,
      clientEventId,
      origin: nextOrigin(),
    });
    const replay = await revokeAllSessions({
      userId: session.userId,
      clientEventId,
      origin: nextOrigin(),
    });

    expect(first.revokedCount).toBe(1);
    expect(replay.revokedCount).toBe(first.revokedCount);
    expect(
      await countRows(
        database.owner,
        "select count(*)::text as count from public.audit_logs where target_id = $1 and action = 'USER_SESSIONS_REVOKED'",
        [session.userId],
      ),
    ).toBe(1);
  }, 60_000);

  it('ne compte pas deux fois des sessions déjà mortes', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('revocation-double');
    await seedProfile(database.owner, { email });
    const session = await signIn(database.owner, email, nextOrigin());

    await revokeAllSessions({
      userId: session.userId,
      clientEventId: randomUUID(),
      origin: nextOrigin(),
    });
    const second = await revokeAllSessions({
      userId: session.userId,
      clientEventId: randomUUID(),
      origin: nextOrigin(),
    });

    // La révocation globale n'écrit pas dans `sessions` : un comptage naïf recompterait, à chaque
    // appel suivant, des sessions que plus personne ne pouvait utiliser.
    expect(second.revokedCount).toBe(0);
  }, 60_000);

  it('refuse un clientEventId qui n est pas un UUID', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('revocation-invalide');
    await seedProfile(database.owner, { email });
    const session = await signIn(database.owner, email, nextOrigin());

    const error = await captureAppError(() =>
      revokeAllSessions({
        userId: session.userId,
        clientEventId: 'pas-un-uuid',
        origin: nextOrigin(),
      }),
    );

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details.fields).toStrictEqual(['clientEventId']);
    expect(await isSessionUsable(session.token)).toBe(true);
  }, 60_000);

  it('refuse un jeton inconnu, tronqué ou vide', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('jeton-invente');
    await seedProfile(database.owner, { email });
    const session = await signIn(database.owner, email, nextOrigin());

    expect(await isSessionUsable(`${session.token.slice(0, 42)}A`)).toBe(false);
    expect(await isSessionUsable(session.token.slice(0, 20))).toBe(false);
    expect(await isSessionUsable('a'.repeat(43))).toBe(false);
  }, 60_000);

  it('refuse une session expirée', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('session-expiree');
    await seedProfile(database.owner, { email });
    const session = await signIn(database.owner, email, nextOrigin());

    await database.owner.query(
      `update public.sessions
          set issued_at = now() - interval '2 days', expires_at = now() - interval '1 hour'
        where token_hash = $1`,
      [hashSessionToken(session.token)],
    );

    expect(await isSessionUsable(session.token)).toBe(false);
  }, 60_000);
});

describe('audit', () => {
  it('écrit la connexion avec une EMPREINTE d adresse, jamais l adresse', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('audit-connexion');
    const origin = nextOrigin();
    const ipAddress = origin.ipAddress ?? '';
    await seedProfile(database.owner, { email });

    const session = await signIn(database.owner, email, origin);

    const { rows } = await database.owner.query<{
      readonly action: string;
      readonly target_type: string;
      readonly target_id: string;
      readonly actor_user_id: string;
      readonly ip_hash: string;
      readonly user_agent_summary: string;
      readonly after: Record<string, unknown>;
    }>(
      `select action, target_type, target_id, actor_user_id, ip_hash, user_agent_summary, after
         from public.audit_logs
        where target_id = $1 and action = 'USER_SIGNED_IN'`,
      [session.userId],
    );
    const entry = rows[0];

    expect(rows).toHaveLength(1);
    expect(entry?.action).toBe('USER_SIGNED_IN');
    // Casse imposée par la contrainte SQL : « UserProfile » échouerait.
    expect(entry?.target_type).toBe('USER_PROFILE');
    expect(entry?.actor_user_id).toBe(session.userId);
    expect(entry?.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry?.ip_hash).toBe(hashIpAddress(ipAddress));
    // HMAC et non condensé nu : l'espace des adresses IPv4 s'énumère en entier.
    expect(entry?.ip_hash).not.toBe(createHash('sha256').update(ipAddress).digest('hex'));
    expect(entry?.user_agent_summary).toBe('Firefox 141 / Android');
    expect(entry?.user_agent_summary).not.toContain('sentinelle-agent-Q4W3');
  }, 60_000);

  it("ne recopie ni code, ni jeton, ni adresse dans le journal d'audit", async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('audit-sans-secret');
    const origin = nextOrigin();
    await seedProfile(database.owner, { email });
    const challenge = await requestSignInCode({ identifier: email, origin });
    const code = await waitForCode(challenge.challengeId);
    const result = await verifySignInCode({ challengeId: challenge.challengeId, code, origin });

    const { rows } = await database.owner.query<{ readonly ligne: string }>(
      'select to_jsonb(a)::text as ligne from public.audit_logs a where a.target_id = $1',
      [result.user.id],
    );
    const dump = rows.map((row) => row.ligne).join('\n');

    // Le journal d'audit est consultable par des rôles qui n'ont pas accès à ces données dans
    // l'application (0006_audit-logs.sql).
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(result.sessionToken);
    expect(dump).not.toContain(email);
    expect(dump).not.toContain(origin.ipAddress ?? 'adresse-absente');
  }, 60_000);

  it('reste immuable : ni modification, ni suppression', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('audit-immuable');
    await seedProfile(database.owner, { email });
    const session = await signIn(database.owner, email, nextOrigin());

    for (const statement of [
      "update public.audit_logs set action = 'FALSIFIE' where target_id = $1",
      'delete from public.audit_logs where target_id = $1',
    ]) {
      await database.owner.query('begin');
      let refused = false;
      try {
        await database.owner.query(statement, [session.userId]);
      } catch {
        refused = true;
      }
      await database.owner.query('rollback');
      expect(refused, `refus attendu : ${statement}`).toBe(true);
    }
  }, 60_000);
});

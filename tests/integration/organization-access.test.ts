import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Voir l'en-tête de `auth-identity-flow.test.ts` : l'environnement précède les imports, plusieurs
 * modules du domaine lisant la configuration au chargement. `DATABASE_URL` reçoit ici une valeur
 * d'attente ; `beforeAll` la remplace par celle de la base jetable avant qu'aucun pool ne s'ouvre.
 */
vi.hoisted(() => {
  process.env.APP_ENV = 'local';
  process.env.APP_VERSION = '0.0.0-test';
  process.env.LOG_LEVEL = 'error';
  process.env.AUTH_SECRET = 'secret-de-test-fictif-acces-organisations-de-plus-de-32-caracteres';
  process.env.DATABASE_URL = 'postgresql://attente:attente@localhost:5432/attente';
  process.env.DATABASE_SSL = 'disable';
  process.env.DATABASE_POOL_MAX = '20';
});

import { resetServerConfigCache } from '@/config/env';
import type { CodeDelivery, SignInCodeMessage } from '@/domain/identity/code-delivery';
import { configureCodeDelivery, resetCodeDelivery } from '@/domain/identity/code-delivery';
import { closePool, getPool } from '@/infrastructure/database/pool';
import { findMembership } from '@/infrastructure/organizations/repository';
import { logger } from '@/observability/logger';
import { GET as pendingOrganizationsRoute } from '../../app/api/v1/admin/organizations/pending/route';
import { POST as requestCodeRoute } from '../../app/api/v1/auth/codes/route';
import { GET as currentSessionRoute } from '../../app/api/v1/auth/sessions/current/route';
import { POST as openSessionRoute } from '../../app/api/v1/auth/sessions/route';
import {
  GET as readOrganizationRoute,
  PATCH as updateOrganizationRoute,
} from '../../app/api/v1/organizations/[organizationId]/route';
import type { DisposableDatabaseSetup } from './setup/database';
import { createDisposableDatabase, databaseOrSkip, NOT_PREPARED } from './setup/database';

/**
 * Critère 12 : ce qui rend un rôle EFFECTIF, éprouvé sur un accès réel.
 *
 * CE QUE CE FICHIER SOLDE. US-010 avait laissé une cinquième condition de validité ouverte, faute
 * de table `organization_members` : « une adhésion suspendue doit couper l'accès ». La condition
 * vit depuis lors dans `src/authorization/organization-access.ts` et dans le prédicat unique de
 * `src/infrastructure/organizations/repository.ts`. Elle n'est tenue que si TROIS clauses tiennent
 * ensemble — statut actif, `valid_from <= now()`, `valid_until > now()` — et si l'organisation qui
 * PORTE un rôle de plateforme est elle-même active.
 *
 * POURQUOI PAR LES ROUTES, ET NON PAR LA SEULE FONCTION. Appeler `resolveOrganizationAccess` et
 * constater qu'elle renvoie `effectiveMembership: null` ne prouve rien de ce qui compte : il
 * resterait à démontrer qu'aucun appelant ne contourne cette fonction, qu'aucune garde ne l'oublie,
 * et surtout qu'aucun résultat n'est conservé d'une requête à l'autre. Chaque cas passe donc par le
 * gestionnaire exporté de la route, avec un vrai objet `Request` et un vrai cookie de session.
 *
 * LA FORME DE CHAQUE CAS EST LA MÊME, ET ELLE EST LA PREUVE. Une requête qui RÉUSSIT, puis la
 * mutation de l'état d'adhésion en base, puis LA MÊME REQUÊTE AVEC LA MÊME SESSION. Un rôle mis en
 * cache — dans le module, dans le pool, dans la session — survivrait à la mutation et le second
 * appel réussirait encore : le test échouerait alors, ce qui est exactement ce qu'ADR-021 demande
 * de garantir. La première requête n'est pas décorative : sans elle, un refus final pourrait venir
 * d'une préparation ratée plutôt que de la règle éprouvée.
 *
 * LA RÉCIPROQUE COMPTE AUTANT. Une règle qui coupe et ne rouvre jamais serait indiscernable d'une
 * panne. Chaque cas rétablit l'état initial et vérifie que l'accès revient, immédiatement lui aussi.
 */

const ORIGIN = 'https://appui-feux.exemple.test';
const HOST = 'appui-feux.exemple.test';
const COOKIE_NAME = 'appui_feux_session';
const FIXED_REQUEST_ID = 'req_00000000-0000-4000-8000-000000000000';

let setup: DisposableDatabaseSetup = NOT_PREPARED;
const deliveries: SignInCodeMessage[] = [];
let addressCounter = 0;
let registrationCounter = 0;

const recordingDelivery: CodeDelivery = {
  send(message: SignInCodeMessage): Promise<void> {
    deliveries.push(message);
    return Promise.resolve();
  },
};

/** Une adresse par connexion : la limitation de tentatives porte aussi sur la source. */
function nextAddress(): string {
  addressCounter += 1;
  return `198.51.${Math.floor(addressCounter / 250)}.${(addressCounter % 250) + 1}`;
}

function nextEmail(label: string): string {
  return `sentinelle-${label}-${randomUUID().slice(0, 8)}@exemple.test`;
}

/** Numéro fictif, unique par appel : l'unicité porte sur la forme normalisée du numéro. */
function nextRegistrationNumber(): string {
  registrationCounter += 1;
  return `FICTIF-ORG-A${String(registrationCounter).padStart(4, '0')}`;
}

interface CallOptions {
  readonly path: string;
  readonly method: string;
  readonly body?: unknown;
  readonly cookie?: string | undefined;
  readonly address?: string | undefined;
}

function buildRequest(options: CallOptions): Request {
  const headers = new Headers({ host: HOST, origin: ORIGIN });
  headers.set('x-forwarded-for', options.address ?? nextAddress());
  headers.set(
    'user-agent',
    'Mozilla/5.0 (Android 14; Mobile; rv:141.0) Gecko/141.0 Firefox/141.0.2',
  );
  if (options.cookie !== undefined) {
    headers.set('cookie', `${COOKIE_NAME}=${options.cookie}`);
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

interface Captured {
  readonly status: number;
  readonly text: string;
  readonly json: Record<string, unknown>;
  /** Corps exact, `requestId` figé : c'est la forme comparable octet à octet. */
  readonly normalizedBytes: Buffer;
  readonly setCookie: string | null;
}

async function capture(response: Response): Promise<Captured> {
  const text = await response.text();
  const parsed: unknown = text.length === 0 ? {} : JSON.parse(text);
  const requestId = response.headers.get('x-request-id') ?? '';
  return {
    status: response.status,
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

/**
 * SANS CETTE PRÉPARATION, LES PREMIERS APPELS MESURERAIENT L'OUVERTURE DES CONNEXIONS. Le délai
 * d'obtention d'une connexion vers une base conteneurisée dépasse parfois celui du pilote, et
 * l'échec ressemble alors à un refus applicatif.
 */
async function warmPool(connections: number): Promise<void> {
  const pool = getPool();
  await Promise.all(Array.from({ length: connections }, () => pool.query('select 1')));
}

async function seedProfile(
  client: Client,
  input: { readonly email: string; readonly displayName?: string },
): Promise<string> {
  const { rows } = await client.query<{ readonly id: string }>(
    `insert into public.user_profiles (display_name, email, preferred_language, verification_level, status)
     values ($1, $2, 'fr', 'CONTACT_VERIFIED', 'ACTIVE')
     returning id`,
    [input.displayName ?? 'Camille D.', input.email],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("le profil de test n'a pas été créé");
  }
  return row.id;
}

/**
 * Organisation écrite EN SQL DIRECT, et non par la commande de création.
 *
 * `createOrganization` impose `PENDING`, `ACTIVE` et une adhésion `ORG_ADMIN` : aucun chemin
 * applicatif ne permet de fabriquer une organisation suspendue, ni une adhésion suspendue, expirée
 * ou datée du futur. Ces états existent pourtant, et ce sont précisément ceux que le critère 12
 * gouverne. La connexion propriétaire de la base jetable est le seul moyen de les poser.
 */
async function seedOrganization(
  client: Client,
  input: {
    readonly name?: string;
    readonly verificationStatus?: string;
    readonly status?: string;
  } = {},
): Promise<string> {
  const { rows } = await client.query<{ readonly id: string }>(
    `insert into public.organizations
       (name, type, registration_number, territory_code, verification_status, status)
     values ($1, 'COMPANY', $2, 'ZZ-DEMO-01',
             $3::public.organization_verification_status,
             $4::public.organization_status)
     returning id`,
    [
      input.name ?? 'Structure fictive de controle',
      nextRegistrationNumber(),
      input.verificationStatus ?? 'PENDING',
      input.status ?? 'ACTIVE',
    ],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("l'organisation de test n'a pas été créée");
  }
  return row.id;
}

async function seedMembership(
  client: Client,
  input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly role: string;
    readonly status?: string;
  },
): Promise<void> {
  await client.query(
    `insert into public.organization_members (organization_id, user_id, role, status)
     values ($1, $2, $3::public.organization_member_role, $4::public.organization_member_status)`,
    [input.organizationId, input.userId, input.role, input.status ?? 'ACTIVE'],
  );
}

/**
 * Mutation de l'adhésion, exprimée en SQL de la base et non en horodatage calculé par le test.
 *
 * `now()` du serveur est la seule horloge qui compte : le prédicat d'effectivité s'y réfère. Poser
 * une échéance calculée par le processus de test ferait dépendre le verdict de l'écart entre deux
 * horloges, exactement sur la frontière où l'accès bascule.
 */
async function setMembership(
  client: Client,
  input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly status?: string;
    readonly validFromSql?: string;
    readonly validUntilSql?: string;
  },
): Promise<void> {
  const assignments = [
    input.status === undefined
      ? undefined
      : `status = ${quoteMemberStatus(input.status)}::public.organization_member_status`,
    input.validFromSql === undefined ? undefined : `valid_from = ${input.validFromSql}`,
    input.validUntilSql === undefined ? undefined : `valid_until = ${input.validUntilSql}`,
  ].filter((assignment): assignment is string => assignment !== undefined);
  if (assignments.length === 0) {
    throw new Error('mutation d adhésion vide : le test ne changerait rien');
  }
  await client.query(
    `update public.organization_members
        set ${assignments.join(', ')}
      where organization_id = $1
        and user_id = $2`,
    [input.organizationId, input.userId],
  );
}

/**
 * Les statuts d'adhésion sont un vocabulaire FERMÉ, écrit par le test lui-même : les interpoler
 * après ce filtre reste sûr, et évite d'avoir à numéroter des paramètres dans une clause `SET`
 * construite au cas par cas.
 */
function quoteMemberStatus(status: string): string {
  const allowed = ['INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED'];
  if (!allowed.includes(status)) {
    throw new Error(`statut d adhésion inconnu : ${status}`);
  }
  return `'${status}'`;
}

async function setOrganizationStatus(
  client: Client,
  organizationId: string,
  status: string,
): Promise<void> {
  await client.query(
    'update public.organizations set status = $2::public.organization_status where id = $1',
    [organizationId, status],
  );
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

/** Parcours de connexion complet : la session obtenue est celle qu'un navigateur détiendrait. */
async function signInThroughRoutes(email: string): Promise<string> {
  const address = nextAddress();
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
  return readCookieValue(opened.setCookie);
}

async function readOrganization(organizationId: string, cookie: string): Promise<Captured> {
  return capture(
    await readOrganizationRoute(
      buildRequest({
        path: `/api/v1/organizations/${organizationId}`,
        method: 'GET',
        cookie,
      }),
    ),
  );
}

async function patchOrganization(
  organizationId: string,
  cookie: string,
  body: unknown,
): Promise<Captured> {
  return capture(
    await updateOrganizationRoute(
      buildRequest({
        path: `/api/v1/organizations/${organizationId}`,
        method: 'PATCH',
        cookie,
        body,
      }),
    ),
  );
}

async function readPendingQueue(cookie: string): Promise<Captured> {
  return capture(
    await pendingOrganizationsRoute(
      buildRequest({ path: '/api/v1/admin/organizations/pending', method: 'GET', cookie }),
    ),
  );
}

/**
 * LE REFUS DOIT VENIR DE L'ADHÉSION, PAS DE LA SESSION. Sans cette vérification, un test pourrait
 * passer au vert alors que la session a été fermée pour une raison sans rapport, et la garantie
 * annoncée — « dès la requête suivante, sans attendre l'expiration de la session » — ne serait pas
 * démontrée du tout.
 */
async function expectSessionStillOpen(cookie: string): Promise<void> {
  const current = await capture(
    await currentSessionRoute(
      buildRequest({ path: '/api/v1/auth/sessions/current', method: 'GET', cookie }),
    ),
  );
  expect(current.status, 'la session doit rester ouverte : seule l adhésion a changé').toBe(200);
}

function membershipOf(captured: Captured): Record<string, unknown> | null {
  return (captured.json.membership ?? null) as Record<string, unknown> | null;
}

beforeAll(async () => {
  logger.level = 'silent';
  // `loadIntegrationEnvironment` fait primer `process.env` sur `.env.local` : la valeur d'attente
  // doit céder la place avant que la cible réelle soit résolue.
  delete process.env.DATABASE_URL;
  setup = await createDisposableDatabase({ withMigrations: true });
  process.env.DATABASE_URL = setup.available
    ? setup.database.url
    : 'postgresql://attente:attente@localhost:5432/attente';
  resetServerConfigCache();
  await closePool();
  if (setup.available) {
    configureCodeDelivery(recordingDelivery);
    await warmPool(10);
  }
}, 120_000);

afterAll(async () => {
  resetCodeDelivery();
  await closePool();
  if (setup.available) {
    await setup.database.dispose();
  }
});

describe('critère 12 — statut de l adhésion', () => {
  it('une adhésion SUSPENDUE ferme la lecture dès la requête suivante, et sa réactivation la rouvre', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('adhesion-suspendue');
    const userId = await seedProfile(database.owner, { email });
    const organizationId = await seedOrganization(database.owner, {
      name: 'Cooperative fictive du plateau',
    });
    await seedMembership(database.owner, { organizationId, userId, role: 'CONTRIBUTOR' });
    const cookie = await signInThroughRoutes(email);

    const before = await readOrganization(organizationId, cookie);
    await setMembership(database.owner, { organizationId, userId, status: 'SUSPENDED' });
    const afterSuspension = await readOrganization(organizationId, cookie);
    await expectSessionStillOpen(cookie);
    await setMembership(database.owner, { organizationId, userId, status: 'ACTIVE' });
    const afterReactivation = await readOrganization(organizationId, cookie);

    expect(before.status).toBe(200);
    expect(membershipOf(before)).toStrictEqual({
      role: 'CONTRIBUTOR',
      status: 'ACTIVE',
      validFrom: expect.any(String),
      validUntil: null,
    });
    // LE MÊME COOKIE, LA MÊME ROUTE, LE MÊME IDENTIFIANT : seul l'état d'adhésion a changé. Un rôle
    // conservé d'une requête à l'autre rendrait ce second appel identique au premier.
    expect(afterSuspension.status).toBe(404);
    expect(errorOf(afterSuspension).code).toBe('NOT_FOUND');
    expect(errorOf(afterSuspension).details).toStrictEqual({});
    // Réciproque : une règle qui couperait sans jamais rouvrir serait indiscernable d'une panne.
    expect(afterReactivation.status).toBe(200);
    expect(membershipOf(afterReactivation)).toStrictEqual(membershipOf(before));
  }, 60_000);

  it('rend au membre suspendu la MÊME réponse octet pour octet qu à un identifiant inexistant', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('adhesion-oracle');
    const userId = await seedProfile(database.owner, { email });
    const organizationId = await seedOrganization(database.owner);
    await seedMembership(database.owner, { organizationId, userId, role: 'COORDINATOR' });
    const cookie = await signInThroughRoutes(email);
    await setMembership(database.owner, { organizationId, userId, status: 'REVOKED' });

    const revoked = await readOrganization(organizationId, cookie);
    const unknown = await readOrganization(randomUUID(), cookie);
    const foreign = await readOrganization(await seedOrganization(database.owner), cookie);

    // L'ORACLE D'EXISTENCE SE FERME SUR LES OCTETS. Une différence d'un seul octet entre « cette
    // organisation existe mais votre adhésion ne vaut plus rien » et « cet identifiant ne désigne
    // rien » suffirait à dresser la liste des structures enregistrées en parcourant des
    // identifiants, ce qui prépare l'usurpation d'organisation de docs/threat-model.md.
    expect(revoked.status).toBe(404);
    expect(Buffer.compare(unknown.normalizedBytes, revoked.normalizedBytes)).toBe(0);
    expect(Buffer.compare(foreign.normalizedBytes, revoked.normalizedBytes)).toBe(0);
    expect(revoked.text).not.toContain(organizationId);
  }, 60_000);

  it('refuse la modification par FORBIDDEN quand l adhésion existe mais ne vaut plus, sans rien écrire', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('adhesion-mutation');
    const userId = await seedProfile(database.owner, { email });
    const organizationId = await seedOrganization(database.owner, {
      name: 'Association fictive des chemins',
    });
    await seedMembership(database.owner, { organizationId, userId, role: 'ORG_ADMIN' });
    const cookie = await signInThroughRoutes(email);

    const accepted = await patchOrganization(organizationId, cookie, {
      name: 'Association fictive des chemins et sentiers',
      expectedVersion: 1,
    });
    await setMembership(database.owner, { organizationId, userId, status: 'SUSPENDED' });
    const refused = await patchOrganization(organizationId, cookie, {
      name: 'Service incendie fictif',
      expectedVersion: 2,
    });
    const stored = await database.owner.query<{ readonly name: string; readonly version: number }>(
      'select name, version from public.organizations where id = $1',
      [organizationId],
    );
    await setMembership(database.owner, { organizationId, userId, status: 'ACTIVE' });
    const acceptedAgain = await patchOrganization(organizationId, cookie, {
      name: 'Association fictive des chemins ruraux',
      expectedVersion: 2,
    });

    expect(accepted.status).toBe(200);
    // `FORBIDDEN` et non `NOT_FOUND` : la ligne d'adhésion existe encore, l'appelant sait donc déjà
    // que l'organisation existe. C'est l'asymétrie assumée par docs/api-contract.md.
    expect(refused.status).toBe(403);
    expect(errorOf(refused).code).toBe('FORBIDDEN');
    // LA DÉCISION EST PRISE DANS LA TRANSACTION QUI ÉCRIT : le refus ne laisse ni version
    // incrémentée, ni nom modifié. Une garde placée hors transaction laisserait passer l'écriture.
    expect(stored.rows[0]?.version).toBe(2);
    expect(stored.rows[0]?.name).toBe('Association fictive des chemins et sentiers');
    expect(acceptedAgain.status).toBe(200);
    expect((acceptedAgain.json.organization as { version: number }).version).toBe(3);
  }, 90_000);
});

describe('critère 12 — fenêtre de validité', () => {
  it('une adhésion EXPIRÉE par valid_until ferme la lecture, et repousser l échéance la rouvre', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('adhesion-expiree');
    const userId = await seedProfile(database.owner, { email });
    const organizationId = await seedOrganization(database.owner);
    await seedMembership(database.owner, { organizationId, userId, role: 'COORDINATOR' });
    const cookie = await signInThroughRoutes(email);

    const before = await readOrganization(organizationId, cookie);
    // L'EXPIRATION EST PORTÉE PAR LES DONNÉES, PAS PAR UNE TÂCHE DE FOND : aucun traitement n'est
    // déclenché ici, et pourtant l'accès doit être clos à la requête d'après. Les deux bornes sont
    // reculées ensemble parce que `organization_members_validity_window` exige une fenêtre non
    // vide : une échéance passée suppose un début plus ancien encore.
    await setMembership(database.owner, {
      organizationId,
      userId,
      validFromSql: "now() - interval '2 days'",
      validUntilSql: "now() - interval '1 second'",
    });
    const afterExpiry = await readOrganization(organizationId, cookie);
    await expectSessionStillOpen(cookie);
    await setMembership(database.owner, {
      organizationId,
      userId,
      validUntilSql: "now() + interval '1 hour'",
    });
    const afterExtension = await readOrganization(organizationId, cookie);

    expect(before.status).toBe(200);
    expect(afterExpiry.status).toBe(404);
    expect(errorOf(afterExpiry).code).toBe('NOT_FOUND');
    expect(afterExtension.status).toBe(200);
    expect(membershipOf(afterExtension)).toMatchObject({ role: 'COORDINATOR', status: 'ACTIVE' });
    // L'échéance sort telle quelle dans le contrat : elle décrit l'adhésion de l'appelant.
    expect(typeof membershipOf(afterExtension)?.validUntil).toBe('string');
  }, 60_000);

  it('une adhésion dont valid_from est dans le FUTUR n ouvre rien, même active', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('adhesion-future');
    const userId = await seedProfile(database.owner, { email });
    const organizationId = await seedOrganization(database.owner);
    await seedMembership(database.owner, { organizationId, userId, role: 'ORG_ADMIN' });
    const cookie = await signInThroughRoutes(email);

    const before = await readOrganization(organizationId, cookie);
    // PRÉPARER UNE ADHÉSION À L'AVANCE NE DOIT PAS L'ACTIVER. Sans la borne basse, une prise de
    // fonction datée du mois prochain ouvrirait l'accès à l'instant de sa saisie.
    await setMembership(database.owner, {
      organizationId,
      userId,
      validFromSql: "now() + interval '1 hour'",
    });
    const afterPostponement = await readOrganization(organizationId, cookie);
    await expectSessionStillOpen(cookie);
    await setMembership(database.owner, {
      organizationId,
      userId,
      validFromSql: "now() - interval '1 minute'",
    });
    const afterTakingOffice = await readOrganization(organizationId, cookie);

    expect(before.status).toBe(200);
    expect(afterPostponement.status).toBe(404);
    expect(errorOf(afterPostponement).code).toBe('NOT_FOUND');
    // La ligne d'adhésion n'a jamais cessé d'être `ACTIVE` : c'est bien la fenêtre, et elle seule,
    // qui a fermé puis rouvert l'accès.
    const stored = await database.owner.query<{ readonly status: string }>(
      'select status from public.organization_members where organization_id = $1 and user_id = $2',
      [organizationId, userId],
    );
    expect(stored.rows[0]?.status).toBe('ACTIVE');
    expect(afterTakingOffice.status).toBe(200);
  }, 60_000);

  it('tranche la frontière EXACTE : valid_from inclusive, valid_until exclusive, au même instant', async (context) => {
    const database = databaseOrSkip(setup, context);
    const organizationId = await seedOrganization(database.owner);
    const startingNow = await seedProfile(database.owner, {
      email: nextEmail('frontiere-debut'),
      displayName: 'Frontiere basse',
    });
    const endingNow = await seedProfile(database.owner, {
      email: nextEmail('frontiere-fin'),
      displayName: 'Frontiere haute',
    });

    /**
     * POURQUOI UNE TRANSACTION OUVERTE À LA MAIN. `now()` vaut l'instant de DÉBUT DE TRANSACTION :
     * il est donc identique pour l'insertion et pour la lecture qui suit. C'est la seule manière
     * d'évaluer le prédicat sur l'ÉGALITÉ exacte, celle qui distingue une comparaison stricte d'une
     * comparaison large. Deux requêtes séparées seraient toujours évaluées après coup, et les deux
     * rédactions rendraient alors le même verdict.
     *
     * CE QUE CHAQUE INÉGALITÉ COÛTE SI ELLE EST ÉCRITE DE TRAVERS :
     * - `valid_from < now()` au lieu de `<=` rendrait inopérante l'adhésion créée par
     *   `createOrganization`, dont `valid_from` reçoit le `now()` de la transaction créatrice.
     *   Le créateur serait exclu de sa propre organisation dans la transaction même qui la crée ;
     * - `valid_until >= now()` au lieu de `>` laisserait une adhésion valide à la seconde exacte
     *   de son échéance. Même choix que `sessions_revoked_at` : dans le doute, on coupe.
     */
    await database.owner.query('begin');
    try {
      await database.owner.query(
        `insert into public.organization_members (organization_id, user_id, role, status, valid_from)
         values ($1, $2, 'CONTRIBUTOR', 'ACTIVE', now())`,
        [organizationId, startingNow],
      );
      await database.owner.query(
        `insert into public.organization_members
           (organization_id, user_id, role, status, valid_from, valid_until)
         values ($1, $2, 'CONTRIBUTOR', 'ACTIVE', now() - interval '1 day', now())`,
        [organizationId, endingNow],
      );

      const opening = await findMembership(database.owner, {
        organizationId,
        userId: startingNow,
      });
      const closing = await findMembership(database.owner, { organizationId, userId: endingNow });

      expect(opening?.is_effective, 'valid_from = now() : l adhésion commence à cet instant').toBe(
        true,
      );
      expect(closing?.is_effective, 'valid_until = now() : l adhésion est déjà close').toBe(false);
    } finally {
      // Ces deux adhésions n'existent que le temps de l'instant qu'elles éprouvent.
      await database.owner.query('rollback');
    }
  }, 60_000);
});

describe('critère 12 — fonction d administrateur de plateforme', () => {
  it('perd sa fonction dès que l organisation PORTEUSE cesse d être ACTIVE, et la retrouve ensuite', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('admin-porteuse');
    const userId = await seedProfile(database.owner, { email, displayName: 'Dominique P.' });
    const carrierId = await seedOrganization(database.owner, {
      name: 'Autorite fictive de coordination',
      verificationStatus: 'VERIFIED',
    });
    await seedMembership(database.owner, {
      organizationId: carrierId,
      userId,
      role: 'PLATFORM_ADMIN',
    });
    const targetId = await seedOrganization(database.owner, { name: 'Entreprise fictive Horizon' });
    const cookie = await signInThroughRoutes(email);

    const readBefore = await readOrganization(targetId, cookie);
    const queueBefore = await readPendingQueue(cookie);

    for (const closedState of ['SUSPENDED', 'CLOSED']) {
      await setOrganizationStatus(database.owner, carrierId, closedState);
      const read = await readOrganization(targetId, cookie);
      const queue = await readPendingQueue(cookie);

      // SUSPENDRE UNE ORGANISATION DOIT RETIRER LES POUVOIRS DE PLATEFORME QU'ELLE A ACCORDÉS.
      // C'est le seul endroit où l'état de l'organisation et celui de l'adhésion ne peuvent pas
      // être contrôlés séparément : la fonction sert justement à atteindre d'AUTRES organisations,
      // il n'y a donc aucune organisation visée sur laquelle poser la seconde garde.
      expect(read.status, `organisation porteuse ${closedState}`).toBe(404);
      expect(errorOf(read).code).toBe('NOT_FOUND');
      // La file d'administration refuse par `FORBIDDEN` : ici, aucune existence n'est à dissimuler,
      // seulement une fonction à refuser. L'asymétrie avec la lecture est assumée par le contrat.
      expect(queue.status, `file avec porteuse ${closedState}`).toBe(403);
      expect(errorOf(queue).code).toBe('FORBIDDEN');
      await expectSessionStillOpen(cookie);
    }

    await setOrganizationStatus(database.owner, carrierId, 'ACTIVE');
    const readAfter = await readOrganization(targetId, cookie);
    const queueAfter = await readPendingQueue(cookie);

    expect(readBefore.status).toBe(200);
    // L'appelant accède au titre de sa fonction, pas d'une appartenance : `membership` reste `null`.
    expect(membershipOf(readBefore)).toBeNull();
    expect(queueBefore.status).toBe(200);
    expect(readAfter.status).toBe(200);
    expect(queueAfter.status).toBe(200);
  }, 90_000);

  it('perd sa fonction dès que sa propre adhésion cesse d être effective', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('admin-adhesion');
    const userId = await seedProfile(database.owner, { email, displayName: 'Sacha M.' });
    const carrierId = await seedOrganization(database.owner, {
      name: 'Autorite fictive de supervision',
      verificationStatus: 'VERIFIED',
    });
    await seedMembership(database.owner, {
      organizationId: carrierId,
      userId,
      role: 'PLATFORM_ADMIN',
    });
    const targetId = await seedOrganization(database.owner, { name: 'Commune fictive de Zeval' });
    const cookie = await signInThroughRoutes(email);

    const before = await readPendingQueue(cookie);
    await setMembership(database.owner, {
      organizationId: carrierId,
      userId,
      status: 'SUSPENDED',
    });
    const afterSuspension = await readPendingQueue(cookie);
    const readAfterSuspension = await readOrganization(targetId, cookie);
    await setMembership(database.owner, { organizationId: carrierId, userId, status: 'ACTIVE' });
    await setMembership(database.owner, {
      organizationId: carrierId,
      userId,
      validFromSql: "now() - interval '2 days'",
      validUntilSql: "now() - interval '1 second'",
    });
    const afterExpiry = await readPendingQueue(cookie);
    await setMembership(database.owner, {
      organizationId: carrierId,
      userId,
      validUntilSql: 'null',
    });
    const afterRestoration = await readPendingQueue(cookie);

    expect(before.status).toBe(200);
    // AUCUNE EXCEPTION POUR LE RÔLE LE PLUS PUISSANT. Les trois conditions d'effectivité valent
    // pour `PLATFORM_ADMIN` comme pour les autres : ce serait le pire endroit où en faire une.
    expect(afterSuspension.status).toBe(403);
    expect(errorOf(afterSuspension).code).toBe('FORBIDDEN');
    expect(readAfterSuspension.status).toBe(404);
    expect(afterExpiry.status).toBe(403);
    expect(afterRestoration.status).toBe(200);
    await expectSessionStillOpen(cookie);
  }, 90_000);
});

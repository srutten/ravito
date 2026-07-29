import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** Voir l'en-tête de `auth-routes.test.ts` : l'environnement précède les imports. */
vi.hoisted(() => {
  process.env.APP_ENV = 'local';
  process.env.APP_VERSION = '0.0.0-test';
  process.env.LOG_LEVEL = 'error';
  process.env.AUTH_SECRET = 'secret-de-test-fictif-organisations-de-plus-de-32-caracteres';
  process.env.DATABASE_URL = 'postgresql://attente:attente@localhost:5432/attente';
  process.env.DATABASE_SSL = 'disable';
  process.env.DATABASE_POOL_MAX = '20';
  // Aucun test de ce fichier ne doit hériter d'un mode lecture seule laissé par ailleurs :
  // `isFeatureEnabled` relit `process.env` à chaque appel, sans cache.
  delete process.env.PLATFORM_READ_ONLY;
});

import { resetServerConfigCache } from '@/config/env';
import type { CodeDelivery, SignInCodeMessage } from '@/domain/identity/code-delivery';
import { configureCodeDelivery, resetCodeDelivery } from '@/domain/identity/code-delivery';
import type {
  OrganizationMemberRole,
  OrganizationMemberStatus,
  OrganizationStatus,
  OrganizationType,
  OrganizationVerificationStatus,
} from '@/domain/organizations/types';
import { closePool, getPool } from '@/infrastructure/database/pool';
import { logger } from '@/observability/logger';
import { POST as requestCodeRoute } from '../../app/api/v1/auth/codes/route';
import { POST as openSessionRoute } from '../../app/api/v1/auth/sessions/route';
import {
  GET as readOrganizationRoute,
  PATCH as updateOrganizationRoute,
} from '../../app/api/v1/organizations/[organizationId]/route';
import type { DisposableDatabaseSetup } from './setup/database';
import { createDisposableDatabase, databaseOrSkip, NOT_PREPARED } from './setup/database';

/**
 * Lecture et modification d'une organisation, éprouvées par les gestionnaires exportés.
 *
 * POURQUOI CE NIVEAU ET PAS UN AUTRE. Trois des garanties de US-012 ne se démontrent qu'ici,
 * parce qu'elles portent sur ce que la base contient APRÈS l'appel, et non sur ce que la
 * réponse annonce.
 *
 * 1. « Rien n'a été écrit » est une affirmation sur des lignes, pas sur un statut. Un
 *    `VERSION_CONFLICT` renvoyé alors que la fiche a bougé serait indiscernable d'un refus
 *    correct sans relire `organizations`, `audit_logs` et `outbox`. Aucune doublure ne peut
 *    porter cette preuve : le verrouillage optimiste vit dans le `WHERE version = $2` d'un
 *    `UPDATE`, et une doublure de dépôt le remplacerait justement par ce qu'il faut prouver.
 * 2. La retombée de vérification est décidée PAR LE SERVEUR, dans l'`UPDATE`, sous verrou de
 *    ligne. La tester au-dessus du SQL ne testerait que la copie applicative de la règle.
 * 3. Le rôle effectif est relu à chaque requête. Le seul moyen honnête de l'éprouver est de
 *    modifier l'adhésion EN BASE entre deux appels portant le MÊME cookie, et de constater
 *    que le second verdict diffère du premier.
 *
 * LE REFUS SE VÉRIFIE SUR LES OCTETS. « `NOT_FOUND` et jamais `FORBIDDEN` » ne dit pas
 * seulement quel code sort : il dit qu'un tiers ne doit pas pouvoir distinguer une
 * organisation existante d'un identifiant qui ne désigne rien. Une clé de plus dans
 * `details`, un message différent, un en-tête supplémentaire suffiraient à rouvrir l'oracle
 * d'existence. Les corps sont donc comparés littéralement, `requestId` mis à part.
 *
 * Les organisations et les adhésions sont posées EN SQL DIRECT, avec la connexion
 * propriétaire de la base jetable, et non par `POST /api/v1/organizations`. Deux raisons :
 * la création ne sait pas produire une organisation `VERIFIED`, `SUSPENDED` ou `REJECTED`,
 * qui sont précisément les états que ces règles concernent ; et un test de lecture qui
 * dépendrait du chemin de création échouerait deux fois pour un seul défaut.
 */

const ORIGIN = 'https://appui-feux.exemple.test';
const HOST = 'appui-feux.exemple.test';
const COOKIE_NAME = 'appui_feux_session';
const FIXED_REQUEST_ID = 'req_00000000-0000-4000-8000-000000000000';
const REQUEST_ID_PATTERN = /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Les dix clés de l'objet `organization` du contrat, triées. Ni plus, ni moins. */
const ORGANIZATION_FIELDS = [
  'createdAt',
  'id',
  'name',
  'registrationNumber',
  'status',
  'territoryCode',
  'type',
  'updatedAt',
  'verificationStatus',
  'version',
];

/** `membership` décrit l'appelant : ni `organizationId`, ni `userId`. */
const MEMBERSHIP_FIELDS = ['role', 'status', 'validFrom', 'validUntil'];

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

/**
 * Une adresse neuve par ouverture de session.
 *
 * La limitation de tentatives porte sur l'identifiant normalisé ET sur l'adresse d'appel :
 * deux connexions qui partageraient les deux s'empoisonneraient l'une l'autre, et l'échec
 * ressemblerait à un défaut d'organisation alors qu'il viendrait de l'identité.
 */
function nextAddress(): string {
  addressCounter += 1;
  return `198.51.${Math.floor(addressCounter / 250)}.${(addressCounter % 250) + 1}`;
}

function nextEmail(label: string): string {
  return `sentinelle-${label}-${randomUUID().slice(0, 8)}@exemple.test`;
}

/**
 * Numéro d'immatriculation fictif et unique.
 *
 * L'unicité porte sur la forme NORMALISÉE — majuscules, séparateurs retirés — donc deux
 * numéros qui ne différeraient que par un tiret entreraient en collision. Le compteur et
 * l'aléa portent sur des caractères alphanumériques, jamais sur la ponctuation.
 */
function nextRegistrationNumber(): string {
  registrationCounter += 1;
  return `FICTIF-ORG-${registrationCounter}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

interface CallOptions {
  readonly path: string;
  readonly method: string;
  readonly body?: unknown;
  readonly cookie?: string | undefined;
  readonly address?: string | undefined;
  /**
   * En-têtes appliqués EN DERNIER, donc capables de remplacer ceux que la fabrique pose,
   * `origin` et `content-type` compris.
   *
   * L'ORDRE EST LA SEULE CHOSE QUI COMPTE ICI. Posés d'abord, ils seraient réécrits quelques
   * lignes plus bas par la fabrique elle-même : le cas d'origine étrangère partirait avec
   * l'origine légitime et le cas de type de contenu refusé avec `application/json`. Les deux
   * verraient un `200` et personne ne saurait qu'ils n'ont rien éprouvé.
   */
  readonly headers?: Record<string, string>;
  /** En-têtes RETIRÉS en tout dernier : le seul moyen d'éprouver leur ABSENCE. */
  readonly omitHeaders?: readonly string[];
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
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers.set(name, value);
  }
  for (const name of options.omitHeaders ?? []) {
    headers.delete(name);
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
  };
}

function errorOf(captured: Captured): Record<string, unknown> {
  return (captured.json.error ?? {}) as Record<string, unknown>;
}

function organizationOf(captured: Captured): Record<string, unknown> {
  return (captured.json.organization ?? {}) as Record<string, unknown>;
}

/** En-têtes comparables entre deux réponses : ceux qui varient légitimement sont retirés. */
function comparableHeaders(captured: Captured): Record<string, string> {
  const { 'x-request-id': _requestId, ...rest } = captured.headers;
  return rest;
}

/** Ce qu'un cas peut imposer à l'enveloppe HTTP, en plus du corps et du cookie. */
type EnvelopeOverrides = Pick<CallOptions, 'headers' | 'omitHeaders'>;

async function readOrganizationCall(
  organizationId: string,
  cookie?: string,
  envelope?: EnvelopeOverrides,
): Promise<Captured> {
  return capture(
    await readOrganizationRoute(
      buildRequest({
        path: `/api/v1/organizations/${organizationId}`,
        method: 'GET',
        ...(cookie !== undefined ? { cookie } : {}),
        ...envelope,
      }),
    ),
  );
}

async function patchOrganizationCall(
  organizationId: string,
  body: unknown,
  cookie?: string,
  envelope?: EnvelopeOverrides,
): Promise<Captured> {
  return capture(
    await updateOrganizationRoute(
      buildRequest({
        path: `/api/v1/organizations/${organizationId}`,
        method: 'PATCH',
        body,
        ...(cookie !== undefined ? { cookie } : {}),
        ...envelope,
      }),
    ),
  );
}

/**
 * SANS CETTE PRÉPARATION, LE TEST DE COURSE MESURERAIT LA MAUVAISE CHOSE. Plusieurs
 * connexions ouvertes d'un coup vers une base conteneurisée coûtent plus que le délai
 * d'obtention d'une connexion du pilote : les appels échoueraient sur un dépassement de
 * délai de connexion au lieu d'être arbitrés par le verrou de ligne.
 */
async function warmPool(connections: number): Promise<void> {
  const pool = getPool();
  await Promise.all(Array.from({ length: connections }, () => pool.query('select 1')));
}

async function seedProfile(
  client: Client,
  input: { readonly email: string; readonly displayName: string },
): Promise<string> {
  const { rows } = await client.query<{ readonly id: string }>(
    `insert into public.user_profiles (display_name, email, preferred_language, verification_level, status)
     values ($1, $2, 'fr', 'CONTACT_VERIFIED', 'ACTIVE')
     returning id`,
    [input.displayName, input.email],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("le profil de test n'a pas été créé");
  }
  return row.id;
}

interface OrganizationRecord {
  readonly id: string;
  readonly name: string;
  readonly type: OrganizationType;
  readonly registration_number: string;
  readonly territory_code: string | null;
  readonly verification_status: OrganizationVerificationStatus;
  readonly status: OrganizationStatus;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const ORGANIZATION_COLUMNS = `id, name, type, registration_number, territory_code,
  verification_status, status, version, created_at, updated_at`;

async function seedOrganization(
  client: Client,
  input: {
    readonly name?: string;
    readonly type?: OrganizationType;
    readonly registrationNumber?: string;
    readonly territoryCode?: string | null;
    readonly verificationStatus?: OrganizationVerificationStatus;
    readonly status?: OrganizationStatus;
  } = {},
): Promise<OrganizationRecord> {
  const { rows } = await client.query<OrganizationRecord>(
    `insert into public.organizations
       (name, type, registration_number, territory_code, verification_status, status)
     values ($1, $2::public.organization_type, $3, $4,
             $5::public.organization_verification_status, $6::public.organization_status)
     returning ${ORGANIZATION_COLUMNS}`,
    [
      input.name ?? 'Exploitation agricole fictive',
      input.type ?? 'FARM',
      input.registrationNumber ?? nextRegistrationNumber(),
      input.territoryCode ?? null,
      input.verificationStatus ?? 'PENDING',
      input.status ?? 'ACTIVE',
    ],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("l'organisation de test n'a pas été créée");
  }
  return row;
}

async function readOrganizationRow(
  client: Client,
  organizationId: string,
): Promise<OrganizationRecord> {
  const { rows } = await client.query<OrganizationRecord>(
    `select ${ORGANIZATION_COLUMNS} from public.organizations where id = $1`,
    [organizationId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`aucune organisation ${organizationId} en base`);
  }
  return row;
}

/**
 * Pose ou remplace une adhésion.
 *
 * Aucune commande du produit ne sait suspendre ni dater une adhésion : US-014 les livrera.
 * Les fenêtres de validité sont donc écrites directement, en secondes relatives à `now()`
 * évalué PAR LA BASE — comparer à l'horloge du processus de test introduirait une seconde
 * horloge, exactement sur la frontière où l'accès bascule.
 */
async function setMembership(
  client: Client,
  input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly role?: OrganizationMemberRole;
    readonly status?: OrganizationMemberStatus;
    readonly validFromSeconds?: number;
    readonly validUntilSeconds?: number | null;
  },
): Promise<void> {
  await client.query(
    `insert into public.organization_members
       (organization_id, user_id, role, status, valid_from, valid_until)
     values ($1, $2, $3::public.organization_member_role, $4::public.organization_member_status,
             now() + ($5::int * interval '1 second'),
             case when $6::int is null then null else now() + ($6::int * interval '1 second') end)
     on conflict (organization_id, user_id) do update
        set role = excluded.role,
            status = excluded.status,
            valid_from = excluded.valid_from,
            valid_until = excluded.valid_until`,
    [
      input.organizationId,
      input.userId,
      input.role ?? 'ORG_ADMIN',
      input.status ?? 'ACTIVE',
      input.validFromSeconds ?? 0,
      input.validUntilSeconds ?? null,
    ],
  );
}

interface AuditRecord {
  readonly action: string;
  readonly target_type: string;
  readonly target_id: string | null;
  readonly actor_user_id: string | null;
  readonly actor_organization_id: string | null;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly ip_hash: string | null;
}

async function auditLines(
  client: Client,
  criteria: { readonly targetId: string; readonly action?: string },
): Promise<readonly AuditRecord[]> {
  const { rows } = await client.query<AuditRecord>(
    `select action, target_type, target_id, actor_user_id, actor_organization_id,
            before, after, ip_hash
       from public.audit_logs
      where target_id = $1
        and ($2::text is null or action = $2::text)
      order by recorded_at, action`,
    [criteria.targetId, criteria.action ?? null],
  );
  return rows;
}

interface OutboxRecord {
  readonly event_type: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly payload: Record<string, unknown>;
}

async function outboxMessages(
  client: Client,
  aggregateId: string,
): Promise<readonly OutboxRecord[]> {
  const { rows } = await client.query<OutboxRecord>(
    `select event_type, aggregate_type, aggregate_id, payload
       from public.outbox
      where aggregate_id = $1
      order by created_at`,
    [aggregateId],
  );
  return rows;
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

interface Actor {
  readonly cookie: string;
  readonly userId: string;
}

/** Parcours complet, tel qu'un navigateur l'exécute : demande, remise, échange contre session. */
async function signInThroughRoutes(email: string, address: string): Promise<Actor> {
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
  const opened = await openSessionRoute(
    buildRequest({
      path: '/api/v1/auth/sessions',
      method: 'POST',
      body: { challengeId, code },
      address,
    }),
  );
  const setCookie = opened.headers.get('set-cookie');
  const body = await opened.json();
  if (opened.status !== 201) {
    throw new Error(`ouverture de session refusée : ${JSON.stringify(body)}`);
  }
  const user = (body as { readonly user: { readonly id: string } }).user;
  return { cookie: readCookieValue(setCookie), userId: user.id };
}

interface Actors {
  /** Administrateur des organisations que les tests créent. */
  readonly orgAdmin: Actor;
  /** Membre à rôle variable, jamais `ORG_ADMIN`. */
  readonly member: Actor;
  /** Aucune adhésion nulle part, et aucune fonction de plateforme. */
  readonly outsider: Actor;
  /** Administrateur de la plateforme, membre d'une SEULE organisation porteuse. */
  readonly platformAdmin: Actor;
}

let actors: Actors | undefined;

/**
 * Quatre sessions pour tout le fichier, ouvertes une fois.
 *
 * Une ouverture de session par cas de test coûterait plusieurs dizaines de connexions et
 * autant de plancher de neutralité de durée, sans rien prouver de plus : ce que ces tests
 * éprouvent est l'ADHÉSION, relue à chaque requête, pas la session, dont US-010 répond.
 * Les adhésions, elles, sont posées organisation par organisation.
 */
async function prepareActors(client: Client): Promise<Actors> {
  const build = async (label: string): Promise<Actor> => {
    const email = nextEmail(label);
    await seedProfile(client, { email, displayName: `Camille ${label}` });
    return signInThroughRoutes(email, nextAddress());
  };

  const orgAdmin = await build('admin-organisation');
  const member = await build('membre');
  const outsider = await build('tiers');
  const platformAdmin = await build('admin-plateforme');

  // `hasPlatformAdminRole` joint `organizations` : l'organisation PORTEUSE du rôle doit être
  // `ACTIVE`, sans quoi la fonction de plateforme s'éteint. Elle l'est ici, et elle n'est
  // jamais la cible d'un cas de test.
  const carrier = await seedOrganization(client, {
    name: 'Coordination plateforme (fictive)',
    type: 'OPERATIONAL_SERVICE',
  });
  await setMembership(client, {
    organizationId: carrier.id,
    userId: platformAdmin.userId,
    role: 'PLATFORM_ADMIN',
  });

  return { orgAdmin, member, outsider, platformAdmin };
}

/** Acteur préparé par `beforeAll`. Absent, c'est un défaut de préparation, pas un saut. */
function actor(name: keyof Actors): Actor {
  const found = actors?.[name];
  if (found === undefined) {
    throw new Error(`acteur ${name} non préparé : voir le hook beforeAll`);
  }
  return found;
}

/**
 * Exécute `run` avec le mode lecture seule activé.
 *
 * `isFeatureEnabled` relit `process.env` à chaque appel, sans cache : poser la variable
 * juste avant l'appel suffit, et le `finally` la retire même si l'assertion échoue — sans
 * quoi tous les cas suivants du fichier hériteraient d'un 503.
 */
async function withPlatformReadOnly<T>(run: () => Promise<T>): Promise<T> {
  process.env.PLATFORM_READ_ONLY = 'true';
  try {
    return await run();
  } finally {
    delete process.env.PLATFORM_READ_ONLY;
  }
}

/**
 * Exécute `run` avec l'interrupteur de révocation globale armé (ADR-017).
 *
 * Sans `FORCE_SESSION_REVOCATION_SINCE`, l'interrupteur ferme TOUTES les sessions, y compris
 * celles ouvertes après son activation : c'est le sens sûr documenté par
 * `src/authorization/session.ts`, et c'est l'état dans lequel l'exploitation le trouvera si
 * elle l'arme dans l'urgence. Le `finally` le désarme même si l'assertion échoue, sans quoi
 * tous les cas suivants du fichier recevraient un 401.
 */
async function withForcedSessionRevocation<T>(run: () => Promise<T>): Promise<T> {
  process.env.FORCE_SESSION_REVOCATION = 'true';
  try {
    return await run();
  } finally {
    delete process.env.FORCE_SESSION_REVOCATION;
  }
}

/**
 * Limite de corps héritée de l'enveloppe partagée (`AUTH_MAX_BODY_BYTES`).
 *
 * La valeur est recopiée ici À DESSEIN plutôt qu'importée : l'importer ferait dire au test
 * « la limite vaut la limite », et un jour où quelqu'un la porterait à 64 kio sur les routes
 * d'organisation, le test suivrait le glissement sans rien signaler.
 */
const PATCH_MAX_BODY_BYTES = 2_048;

/**
 * Corps de `PATCH` dont la sérialisation pèse EXACTEMENT `bytes` octets.
 *
 * Le remplissage est en `x` : un caractère ASCII vaut un octet en UTF-8 et n'exige aucun
 * échappement JSON, si bien qu'un caractère de plus est un octet de plus. C'est ce qui permet
 * d'éprouver la borne elle-même, et non « gros » contre « petit » — une limite posée à 64 kio
 * par mégarde resterait verte face à un corps simplement « gros ».
 */
function patchBodyOfExactSize(bytes: number): Record<string, unknown> {
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ name: '', expectedVersion: 1 }), 'utf8');
  const padding = bytes - envelopeBytes;
  if (padding < 0) {
    throw new Error(`corps de ${bytes} octets impossible : l'enveloppe en pèse ${envelopeBytes}`);
  }
  return { name: 'x'.repeat(padding), expectedVersion: 1 };
}

beforeAll(async () => {
  logger.level = 'silent';
  // `loadIntegrationEnvironment` fait primer `process.env` sur `.env.local` : la valeur
  // d'attente posée plus haut doit céder la place avant que la base jetable soit choisie.
  delete process.env.DATABASE_URL;
  setup = await createDisposableDatabase({ withMigrations: true });
  process.env.DATABASE_URL = setup.available
    ? setup.database.url
    : 'postgresql://attente:attente@localhost:5432/attente';
  resetServerConfigCache();
  await closePool();
  if (!setup.available) {
    return;
  }
  configureCodeDelivery(recordingDelivery);
  await warmPool(12);
  actors = await prepareActors(setup.database.owner);
}, 120_000);

afterAll(async () => {
  resetCodeDelivery();
  await closePool();
  if (setup.available) {
    await setup.database.dispose();
  }
});

describe('GET /api/v1/organizations/{organizationId}', () => {
  it('rend la fiche à son membre effectif, et rien que les champs du contrat', async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = actor('orgAdmin');
    const registrationNumber = nextRegistrationNumber();
    const organization = await seedOrganization(database.owner, {
      name: 'Exploitation agricole Martin',
      type: 'FARM',
      registrationNumber,
      territoryCode: 'ZZ-DEMO-01',
    });
    await setMembership(database.owner, {
      organizationId: organization.id,
      userId: admin.userId,
    });

    const response = await readOrganizationCall(organization.id, admin.cookie);

    expect(response.status).toBe(200);
    expect(Object.keys(response.json).sort()).toStrictEqual(['membership', 'organization']);
    expect(Object.keys(organizationOf(response)).sort()).toStrictEqual(ORGANIZATION_FIELDS);
    expect(Object.keys(response.json.membership as object).sort()).toStrictEqual(MEMBERSHIP_FIELDS);
    expect(organizationOf(response)).toMatchObject({
      id: organization.id,
      name: 'Exploitation agricole Martin',
      type: 'FARM',
      registrationNumber,
      territoryCode: 'ZZ-DEMO-01',
      verificationStatus: 'PENDING',
      status: 'ACTIVE',
      version: 1,
    });
    const membership = response.json.membership as Record<string, unknown>;
    expect(membership.role).toBe('ORG_ADMIN');
    expect(membership.status).toBe('ACTIVE');
    expect(membership.validUntil).toBeNull();
    // Les horodatages sortent en ISO 8601 explicite, et non par la sérialisation implicite
    // de `JSON.stringify` : le contrat les impose sous cette forme.
    expect(String(membership.validFrom)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(String(organizationOf(response).createdAt)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    // La forme NORMALISÉE porte l'unicité ; l'exposer inviterait un client à la recalculer,
    // donc à diverger de la colonne générée qui en décide seule.
    expect(response.text).toContain(registrationNumber);
    expect(response.text).not.toContain(registrationNumber.replaceAll('-', ''));
    expect(response.text).not.toContain('normalized');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['x-request-id']).toMatch(REQUEST_ID_PATTERN);
  });

  it("laisse un administrateur plateforme lire une fiche dont il n'est pas membre, avec une adhésion à null", async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = actor('platformAdmin');
    const organization = await seedOrganization(database.owner, {
      name: 'Travaux Publics Horizon (fictive)',
      type: 'COMPANY',
    });

    const response = await readOrganizationCall(organization.id, admin.cookie);

    expect(response.status).toBe(200);
    expect(organizationOf(response).id).toBe(organization.id);
    // `membership` dit ce que l'appelant EST dans cette organisation, pas ce qui lui donne
    // accès : un administrateur plateforme extérieur n'y est rien.
    expect(response.json.membership).toBeNull();
    const { rows } = await database.owner.query<{ readonly count: string }>(
      'select count(*)::text as count from public.organization_members where organization_id = $1',
      [organization.id],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('répond NOT_FOUND à un tiers, OCTET À OCTET comme pour un identifiant qui ne désigne rien', async (context) => {
    const database = databaseOrSkip(setup, context);
    const stranger = actor('outsider');
    const organization = await seedOrganization(database.owner, {
      name: 'Association Vigie Fictive',
      type: 'ASSOCIATION',
    });
    await setMembership(database.owner, {
      organizationId: organization.id,
      userId: actor('orgAdmin').userId,
    });

    const existing = await readOrganizationCall(organization.id, stranger.cookie);
    const unknown = await readOrganizationCall(randomUUID(), stranger.cookie);

    // C'EST LA FERMETURE DE L'ORACLE D'EXISTENCE. Répondre `403` sur l'un et `404` sur
    // l'autre suffirait à dresser la liste des structures enregistrées en parcourant des
    // identifiants, ce qui prépare l'usurpation d'organisation de docs/security.md.
    expect(existing.status).toBe(404);
    expect(errorOf(existing).code).toBe('NOT_FOUND');
    expect(errorOf(existing).details).toStrictEqual({});
    expect(Buffer.compare(existing.normalizedBytes, unknown.normalizedBytes)).toBe(0);
    expect(comparableHeaders(existing)).toStrictEqual(comparableHeaders(unknown));
    expect(existing.text).not.toContain(organization.name);
    expect(existing.text).not.toContain(organization.registration_number);
  });

  it("ferme l'accès dès que l'adhésion cesse d'être effective, sans nouvelle session", async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = actor('orgAdmin');
    const organization = await seedOrganization(database.owner);
    await setMembership(database.owner, {
      organizationId: organization.id,
      userId: admin.userId,
    });

    const granted = await readOrganizationCall(organization.id, admin.cookie);
    expect(granted.status).toBe(200);

    const closures: readonly (readonly [string, Parameters<typeof setMembership>[1]])[] = [
      [
        'adhésion invitée, jamais acceptée',
        { organizationId: organization.id, userId: admin.userId, status: 'INVITED' },
      ],
      [
        'adhésion suspendue',
        { organizationId: organization.id, userId: admin.userId, status: 'SUSPENDED' },
      ],
      [
        'adhésion révoquée',
        { organizationId: organization.id, userId: admin.userId, status: 'REVOKED' },
      ],
      [
        'adhésion datée du futur',
        { organizationId: organization.id, userId: admin.userId, validFromSeconds: 3_600 },
      ],
      [
        'fenêtre de validité close',
        {
          organizationId: organization.id,
          userId: admin.userId,
          validFromSeconds: -7_200,
          validUntilSeconds: -3_600,
        },
      ],
      // CE CAS N'ÉPROUVE PAS L'INÉGALITÉ STRICTE, ET SON LIBELLÉ NE LE PRÉTEND PLUS.
      // `setMembership` écrit `valid_until = now()` dans SA transaction ; la requête qui suit
      // s'exécute dans une transaction ULTÉRIEURE, dont le `now()` est strictement plus grand.
      // `valid_until > now()` et `valid_until >= now()` rendent donc le même verdict, et une
      // production régressée en comparaison large resterait verte ici. Ce qu'il éprouve
      // réellement : une échéance posée à l'instant de l'écriture ferme dès la requête
      // suivante, sans délai de grâce.
      // LA GARANTIE DE STRICTESSE EST PORTÉE AILLEURS, et elle ne peut l'être qu'ailleurs :
      // `tests/integration/organization-access.test.ts`, cas « tranche la frontière EXACTE :
      // valid_from inclusive, valid_until exclusive, au même instant », où l'écriture et la
      // lecture partagent une transaction ouverte à la main — le seul montage où
      // `valid_until = now()` est atteignable. Supprimer ce cas-là en croyant le doublon
      // couvert ici perdrait la seule preuve réelle.
      [
        'échéance posée à l instant de l écriture : la requête suivante est déjà hors fenêtre',
        {
          organizationId: organization.id,
          userId: admin.userId,
          validFromSeconds: -3_600,
          validUntilSeconds: 0,
        },
      ],
    ];

    for (const [label, membership] of closures) {
      await setMembership(database.owner, membership);
      const refused = await readOrganizationCall(organization.id, admin.cookie);
      // MÊME COOKIE, VERDICT DIFFÉRENT : c'est la preuve que le rôle est relu à chaque
      // requête et non porté par la session (ADR-021, critère 12 de US-010).
      expect(refused.status, label).toBe(404);
      expect(errorOf(refused).code, label).toBe('NOT_FOUND');
    }

    await setMembership(database.owner, {
      organizationId: organization.id,
      userId: admin.userId,
    });
    const restored = await readOrganizationCall(organization.id, admin.cookie);
    // Et la réciproque : rétablir l'adhésion rouvre l'accès à la requête suivante, sans
    // reconnexion. Sans ce dernier appel, un refus systématique passerait pour un succès.
    expect(restored.status).toBe(200);
  }, 60_000);

  it('refuse un identifiant de chemin mal formé par NOT_FOUND, jamais par une erreur interne', async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = actor('orgAdmin');
    const organization = await seedOrganization(database.owner);
    await setMembership(database.owner, {
      organizationId: organization.id,
      userId: admin.userId,
    });
    const reference = await readOrganizationCall(randomUUID(), admin.cookie);

    const malformed = [
      'pas-un-uuid',
      '',
      '%ZZ',
      'null',
      '123e4567-e89b-42d3-c456-426614174000',
      '00000000-0000-0000-0000-00000000000',
      // Espace encodé : après décodage, l'identifiant d'une organisation RÉELLE portant un
      // caractère de trop. Le domaine ne rogne pas un segment de chemin, il le refuse — sans
      // quoi deux URL distinctes désigneraient la même fiche.
      `${organization.id}%20`,
    ];

    for (const raw of malformed) {
      const response = await capture(
        await readOrganizationRoute(
          buildRequest({
            path: `/api/v1/organizations/${raw}`,
            method: 'GET',
            cookie: admin.cookie,
          }),
        ),
      );

      // Sans validation, la valeur atteindrait le pilote PostgreSQL et produirait un `22P02`
      // converti en 500 : une faute de frappe deviendrait une erreur serveur, et le journal
      // se remplirait de bruit à la demande de l'appelant.
      expect(response.status, `identifiant « ${raw} »`).toBe(404);
      expect(errorOf(response).code, `identifiant « ${raw} »`).toBe('NOT_FOUND');
      expect(errorOf(response).details, `identifiant « ${raw} »`).toStrictEqual({});
      expect(
        Buffer.compare(response.normalizedBytes, reference.normalizedBytes),
        `même corps qu'un identifiant inconnu : « ${raw} »`,
      ).toBe(0);
    }

    // La casse n'est pas altérée en chemin, et PostgreSQL compare les `uuid` sans en tenir
    // compte : un identifiant en majuscules désigne bien la même organisation.
    const uppercase = await readOrganizationCall(organization.id.toUpperCase(), admin.cookie);
    expect(uppercase.status).toBe(200);
    expect(organizationOf(uppercase).id).toBe(organization.id);
  }, 60_000);

  it('refuse sans session, et refuse pareil avec un cookie inventé', async (context) => {
    const database = databaseOrSkip(setup, context);
    const organization = await seedOrganization(database.owner);

    const anonymous = await readOrganizationCall(organization.id);
    const invented = await readOrganizationCall(
      organization.id,
      'jeton-invente-sans-aucune-existence-AZ09',
    );

    // « Appel direct d'une route masquée par l'interface » : cas de test obligatoire de
    // docs/permissions.md. La barrière de session est la seule protection, l'interface n'en
    // est pas une.
    expect(anonymous.status).toBe(401);
    expect(errorOf(anonymous).code).toBe('UNAUTHENTICATED');
    expect(errorOf(anonymous).details).toStrictEqual({});
    expect(invented.status).toBe(401);
    expect(Buffer.compare(invented.normalizedBytes, anonymous.normalizedBytes)).toBe(0);
  });
});

describe('PATCH /api/v1/organizations/{organizationId}', () => {
  it("applique la modification, incrémente la version et n'audite que les champs modifiés", async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = actor('orgAdmin');
    const organization = await seedOrganization(database.owner, {
      name: 'Exploitation agricole Martin',
      territoryCode: 'ZZ-DEMO-01',
    });
    await setMembership(database.owner, {
      organizationId: organization.id,
      userId: admin.userId,
    });

    const response = await patchOrganizationCall(
      organization.id,
      { name: 'Exploitation agricole Martin et Fils', expectedVersion: 1 },
      admin.cookie,
    );

    expect(response.status).toBe(200);
    expect(Object.keys(response.json).sort()).toStrictEqual([
      'membership',
      'organization',
      'verificationReset',
    ]);
    expect(Object.keys(organizationOf(response)).sort()).toStrictEqual(ORGANIZATION_FIELDS);
    expect(organizationOf(response)).toMatchObject({
      name: 'Exploitation agricole Martin et Fils',
      version: 2,
      // Le périmètre territorial n'était pas dans le corps : il n'a pas bougé.
      territoryCode: 'ZZ-DEMO-01',
    });
    expect(response.json.verificationReset).toBe(false);

    const persisted = await readOrganizationRow(database.owner, organization.id);
    expect(persisted.name).toBe('Exploitation agricole Martin et Fils');
    expect(persisted.version).toBe(2);
    expect(persisted.territory_code).toBe('ZZ-DEMO-01');
    // `updated_at` est posé par le déclencheur partagé de 0003, jamais par l'application.
    expect(persisted.updated_at.getTime()).toBeGreaterThan(persisted.created_at.getTime());

    const audit = await auditLines(database.owner, {
      targetId: organization.id,
      action: 'ORGANIZATION_UPDATED',
    });
    expect(audit).toHaveLength(1);
    const line = audit[0];
    // LE JOURNAL PORTE CE QUI A CHANGÉ, PAS UNE COPIE DE LA FICHE. Recopier l'objet entier
    // ferait du journal un second stockage de l'organisation, consultable par des rôles qui
    // n'y ont pas le même accès.
    expect(line?.before).toStrictEqual({ name: 'Exploitation agricole Martin' });
    expect(line?.after).toStrictEqual({
      name: 'Exploitation agricole Martin et Fils',
      version: 2,
    });
    expect(line?.target_type).toBe('ORGANIZATION');
    expect(line?.actor_user_id).toBe(admin.userId);
    expect(line?.actor_organization_id).toBe(organization.id);
    // L'empreinte de l'adresse, jamais l'adresse.
    expect(line?.ip_hash).toMatch(/^[0-9a-f]{64}$/);

    // Aucune retombée de vérification : rien ne part vers la file d'administration.
    expect(await outboxMessages(database.owner, organization.id)).toHaveLength(0);
  });

  it('refuse un corps sans expectedVersion, et un corps qui ne porte que lui', async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = actor('orgAdmin');
    const organization = await seedOrganization(database.owner, { name: 'Fiche intacte' });
    await setMembership(database.owner, {
      organizationId: organization.id,
      userId: admin.userId,
    });

    const missingVersion = await patchOrganizationCall(
      organization.id,
      { name: 'Nom qui ne doit jamais être écrit' },
      admin.cookie,
    );
    const versionOnly = await patchOrganizationCall(
      organization.id,
      { expectedVersion: 1 },
      admin.cookie,
    );

    // Sans version attendue, le dernier écrivain gagne et la modification de l'autre
    // disparaît sans message ni trace : le contrat la rend obligatoire.
    expect(missingVersion.status).toBe(400);
    expect(errorOf(missingVersion).code).toBe('VALIDATION_ERROR');
    expect(errorOf(missingVersion).details).toStrictEqual({ fields: ['expectedVersion'] });
    // Une requête sans effet qui répondrait `200` laisserait croire à une modification
    // appliquée : au moins un champ modifiable est exigé.
    expect(versionOnly.status).toBe(400);
    expect(errorOf(versionOnly).code).toBe('VALIDATION_ERROR');

    const persisted = await readOrganizationRow(database.owner, organization.id);
    expect(persisted.name).toBe('Fiche intacte');
    expect(persisted.version).toBe(1);
    expect(
      await auditLines(database.owner, {
        targetId: organization.id,
        action: 'ORGANIZATION_UPDATED',
      }),
    ).toHaveLength(0);
  });

  it("refuse une version périmée par VERSION_CONFLICT et n'écrit RIEN", async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = actor('orgAdmin');
    const organization = await seedOrganization(database.owner, { name: 'Fiche d origine' });
    await setMembership(database.owner, {
      organizationId: organization.id,
      userId: admin.userId,
    });
    const accepted = await patchOrganizationCall(
      organization.id,
      { name: 'Fiche corrigée une fois', expectedVersion: 1 },
      admin.cookie,
    );
    expect(accepted.status).toBe(200);
    const beforeConflict = await readOrganizationRow(database.owner, organization.id);

    const stale = await patchOrganizationCall(
      organization.id,
      { name: 'Modification fondée sur un affichage périmé', expectedVersion: 1 },
      admin.cookie,
    );

    expect(stale.status).toBe(409);
    expect(errorOf(stale).code).toBe('VERSION_CONFLICT');
    expect(errorOf(stale).details).toStrictEqual({});

    // « RIEN N'EST ÉCRIT » est une affirmation sur des lignes, pas sur un statut : la fiche
    // est relue, y compris son horodatage, que le déclencheur aurait touché si l'`UPDATE`
    // avait atteint la ligne.
    const afterConflict = await readOrganizationRow(database.owner, organization.id);
    expect(afterConflict.name).toBe(beforeConflict.name);
    expect(afterConflict.version).toBe(beforeConflict.version);
    expect(afterConflict.updated_at.getTime()).toBe(beforeConflict.updated_at.getTime());
    expect(
      await auditLines(database.owner, {
        targetId: organization.id,
        action: 'ORGANIZATION_UPDATED',
      }),
    ).toHaveLength(1);
    expect(stale.text).not.toContain('Modification fondée sur un affichage périmé');
  }, 60_000);

  it("ne laisse qu'un seul gagnant quand deux modifications courent sur la même version", async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = actor('orgAdmin');

    // Trois courses plutôt qu'une : « jamais deux succès » est une affirmation sur toutes
    // les interpositions possibles, et une exécution unique n'en observe qu'une.
    for (let round = 0; round < 3; round += 1) {
      const organization = await seedOrganization(database.owner, {
        name: `Fiche disputée ${round}`,
      });
      await setMembership(database.owner, {
        organizationId: organization.id,
        userId: admin.userId,
      });

      // Les deux appels partent SANS être attendus : ils se chevauchent réellement, et
      // c'est le verrou de ligne de PostgreSQL qui les départage, pas l'ordre du test.
      const [first, second] = await Promise.all([
        patchOrganizationCall(
          organization.id,
          { name: `Renommage par le premier poste ${round}`, expectedVersion: 1 },
          admin.cookie,
        ),
        patchOrganizationCall(
          organization.id,
          { name: `Renommage par le second poste ${round}`, expectedVersion: 1 },
          admin.cookie,
        ),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses, `tour ${round}`).toStrictEqual([200, 409]);
      const loser = first.status === 409 ? first : second;
      const winner = first.status === 200 ? first : second;
      expect(errorOf(loser).code, `tour ${round}`).toBe('VERSION_CONFLICT');

      const persisted = await readOrganizationRow(database.owner, organization.id);
      // L'incrément appartient à l'`UPDATE` : deux succès porteraient la version à 3, et une
      // mise à jour perdue laisserait le nom du perdant sur une version 2.
      expect(persisted.version, `tour ${round}`).toBe(2);
      expect(persisted.name, `tour ${round}`).toBe(organizationOf(winner).name);
      expect(
        await auditLines(database.owner, {
          targetId: organization.id,
          action: 'ORGANIZATION_UPDATED',
        }),
        `tour ${round}`,
      ).toHaveLength(1);
    }
  }, 90_000);

  it('refuse un rôle insuffisant par FORBIDDEN, quel que soit son rang dans le type énuméré', async (context) => {
    const database = databaseOrSkip(setup, context);
    const lesser = actor('member');

    // `OBSERVER` est DÉCLARÉ EN DERNIER et reste le rôle le moins capable : une garde écrite
    // `role >= 'ORG_ADMIN'` lui accorderait les droits d'un administrateur d'organisation.
    for (const role of ['CONTRIBUTOR', 'COORDINATOR', 'OBSERVER'] as const) {
      const organization = await seedOrganization(database.owner, { name: `Fiche ${role}` });
      await setMembership(database.owner, {
        organizationId: organization.id,
        userId: lesser.userId,
        role,
      });

      const response = await patchOrganizationCall(
        organization.id,
        { name: 'Renommage par un rôle sans droit', expectedVersion: 1 },
        lesser.cookie,
      );

      expect(response.status, role).toBe(403);
      expect(errorOf(response).code, role).toBe('FORBIDDEN');
      const persisted = await readOrganizationRow(database.owner, organization.id);
      expect(persisted.name, role).toBe(`Fiche ${role}`);
      expect(persisted.version, role).toBe(1);
    }
  }, 60_000);

  it('répond NOT_FOUND à un non-membre, jamais FORBIDDEN', async (context) => {
    const database = databaseOrSkip(setup, context);
    const stranger = actor('outsider');
    const organization = await seedOrganization(database.owner, { name: 'Fiche étrangère' });
    await setMembership(database.owner, {
      organizationId: organization.id,
      userId: actor('orgAdmin').userId,
    });

    const existing = await patchOrganizationCall(
      organization.id,
      { name: 'Renommage par un tiers', expectedVersion: 1 },
      stranger.cookie,
    );
    const unknown = await patchOrganizationCall(
      randomUUID(),
      { name: 'Renommage par un tiers', expectedVersion: 1 },
      stranger.cookie,
    );

    // Même règle qu'en lecture : rien ne confirme à un tiers que l'identifiant désigne
    // quelque chose. « Accès à une autre organisation », cas obligatoire de
    // docs/permissions.md.
    expect(existing.status).toBe(404);
    expect(errorOf(existing).code).toBe('NOT_FOUND');
    expect(Buffer.compare(existing.normalizedBytes, unknown.normalizedBytes)).toBe(0);
    const persisted = await readOrganizationRow(database.owner, organization.id);
    expect(persisted.name).toBe('Fiche étrangère');
    expect(persisted.version).toBe(1);
  });

  it("tranche l'autorisation AVANT la version : un refus d'accès ne devient jamais un conflit", async (context) => {
    const database = databaseOrSkip(setup, context);
    const organization = await seedOrganization(database.owner);
    await setMembership(database.owner, {
      organizationId: organization.id,
      userId: actor('member').userId,
      role: 'CONTRIBUTOR',
    });

    const byStranger = await patchOrganizationCall(
      organization.id,
      { name: 'Renommage impossible', expectedVersion: 999 },
      actor('outsider').cookie,
    );
    const byContributor = await patchOrganizationCall(
      organization.id,
      { name: 'Renommage impossible', expectedVersion: 999 },
      actor('member').cookie,
    );

    // Si la version était éprouvée d'abord, les deux recevraient `VERSION_CONFLICT` et
    // l'appelant apprendrait par ce seul code que l'organisation existe.
    expect(byStranger.status).toBe(404);
    expect(errorOf(byStranger).code).toBe('NOT_FOUND');
    expect(byContributor.status).toBe(403);
    expect(errorOf(byContributor).code).toBe('FORBIDDEN');
  });

  it('refuse la modification d une fiche suspendue ou fermée, administrateur plateforme compris', async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = actor('orgAdmin');

    for (const status of ['SUSPENDED', 'CLOSED'] as const) {
      const organization = await seedOrganization(database.owner, {
        name: `Fiche ${status}`,
        status,
      });
      await setMembership(database.owner, {
        organizationId: organization.id,
        userId: admin.userId,
      });

      const byOrgAdmin = await patchOrganizationCall(
        organization.id,
        { name: 'Renommage sur fiche fermée', expectedVersion: 1 },
        admin.cookie,
      );
      const byPlatformAdmin = await patchOrganizationCall(
        organization.id,
        { name: 'Renommage sur fiche fermée', expectedVersion: 1 },
        actor('platformAdmin').cookie,
      );

      // DEUX GARDES, PAS UNE. L'adhésion dit ce que la personne peut faire ; elle ne dit pas
      // si la structure est en état d'agir. La seconde garde ne connaît aucune exception,
      // pas même pour le rôle le plus puissant du produit.
      expect(byOrgAdmin.status, status).toBe(403);
      expect(errorOf(byOrgAdmin).code, status).toBe('FORBIDDEN');
      expect(byPlatformAdmin.status, status).toBe(403);
      expect(errorOf(byPlatformAdmin).code, status).toBe('FORBIDDEN');
      const persisted = await readOrganizationRow(database.owner, organization.id);
      expect(persisted.name, status).toBe(`Fiche ${status}`);
      expect(persisted.version, status).toBe(1);
    }

    // La lecture, elle, reste ouverte : une fiche suspendue se consulte, elle ne se corrige
    // plus. Confondre les deux axes fermerait la seule vue dont dispose son administrateur.
    const suspended = await seedOrganization(database.owner, { status: 'SUSPENDED' });
    await setMembership(database.owner, {
      organizationId: suspended.id,
      userId: admin.userId,
    });
    const read = await readOrganizationCall(suspended.id, admin.cookie);
    expect(read.status).toBe(200);
    expect(organizationOf(read).status).toBe('SUSPENDED');
  }, 60_000);

  it("laisse un administrateur plateforme corriger une fiche dont il n'est pas membre", async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = actor('platformAdmin');
    const organization = await seedOrganization(database.owner, { name: 'Fiche à corriger' });

    const response = await patchOrganizationCall(
      organization.id,
      { name: 'Fiche corrigée par la plateforme', expectedVersion: 1 },
      admin.cookie,
    );

    expect(response.status).toBe(200);
    expect(organizationOf(response).name).toBe('Fiche corrigée par la plateforme');
    // Il agit au titre de sa fonction, pas d'une appartenance : la correction ne lui en crée
    // aucune, et le corps ne lui en invente pas.
    expect(response.json.membership).toBeNull();
    const { rows } = await database.owner.query<{ readonly count: string }>(
      'select count(*)::text as count from public.organization_members where organization_id = $1',
      [organization.id],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('refuse la modification en lecture seule, et sert quand même la lecture', async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = actor('orgAdmin');
    const organization = await seedOrganization(database.owner, { name: 'Fiche en incident' });
    await setMembership(database.owner, {
      organizationId: organization.id,
      userId: admin.userId,
    });

    const { refused, malformed, read } = await withPlatformReadOnly(async () => ({
      refused: await patchOrganizationCall(
        organization.id,
        { name: 'Renommage pendant un incident', expectedVersion: 1 },
        admin.cookie,
      ),
      // La garde est la PREMIÈRE instruction de la commande : en lecture seule, un
      // identifiant mal formé et un corps invalide n'ont même pas à être analysés.
      malformed: await patchOrganizationCall(
        'pas-un-uuid',
        { expectedVersion: 'pas un entier' },
        admin.cookie,
      ),
      read: await readOrganizationCall(organization.id, admin.cookie),
    }));

    expect(refused.status).toBe(503);
    expect(errorOf(refused).code).toBe('PLATFORM_READ_ONLY');
    expect(malformed.status).toBe(503);
    expect(errorOf(malformed).code).toBe('PLATFORM_READ_ONLY');
    // « Les mutations sont refusées avec un code explicite, les consultations restent
    // disponibles » (backlog/acceptance-scenarios.md). Fermer la lecture pendant un incident
    // aggraverait l'incident au lieu de le contenir.
    expect(read.status).toBe(200);

    const persisted = await readOrganizationRow(database.owner, organization.id);
    expect(persisted.name).toBe('Fiche en incident');
    expect(persisted.version).toBe(1);

    // L'interrupteur est bien retombé : le cas suivant ne doit pas hériter d'un 503.
    const afterwards = await patchOrganizationCall(
      organization.id,
      { name: 'Renommage une fois l incident clos', expectedVersion: 1 },
      admin.cookie,
    );
    expect(afterwards.status).toBe(200);
  }, 60_000);
});

describe('retombée de vérification', () => {
  it("ramène en attente une exploitation agricole validée qui se renomme service d'incendie", async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = actor('orgAdmin');
    // LE CONTOURNEMENT QUE CETTE RÈGLE FERME, joué tel quel : se faire valider sous un type
    // anodin, puis endosser une structure opérationnelle. Sans retombée, l'usurpation
    // d'organisation de docs/security.md tient en deux appels.
    const organization = await seedOrganization(database.owner, {
      name: 'Exploitation agricole Martin',
      type: 'FARM',
      verificationStatus: 'VERIFIED',
    });
    await setMembership(database.owner, {
      organizationId: organization.id,
      userId: admin.userId,
    });

    const response = await patchOrganizationCall(
      organization.id,
      {
        name: 'Service incendie territorial de la vallée',
        type: 'OPERATIONAL_SERVICE',
        expectedVersion: 1,
      },
      admin.cookie,
    );

    expect(response.status).toBe(200);
    expect(response.json.verificationReset).toBe(true);
    expect(organizationOf(response).verificationStatus).toBe('PENDING');
    expect(organizationOf(response).version).toBe(2);

    const persisted = await readOrganizationRow(database.owner, organization.id);
    expect(persisted.verification_status).toBe('PENDING');
    expect(persisted.name).toBe('Service incendie territorial de la vallée');
    expect(persisted.type).toBe('OPERATIONAL_SERVICE');

    // DEUX LIGNES D'AUDIT, DISTINCTES. La modification et la perte de confiance sont deux
    // faits : les confondre rendrait impossible de compter les secondes sans relire et
    // interpréter les premières, ce que cherche justement un administrateur plateforme.
    const updated = await auditLines(database.owner, {
      targetId: organization.id,
      action: 'ORGANIZATION_UPDATED',
    });
    const reset = await auditLines(database.owner, {
      targetId: organization.id,
      action: 'ORGANIZATION_VERIFICATION_RESET',
    });
    expect(updated).toHaveLength(1);
    expect(reset).toHaveLength(1);
    expect(reset[0]?.before).toStrictEqual({ verificationStatus: 'VERIFIED' });
    expect(reset[0]?.after).toStrictEqual({
      verificationStatus: 'PENDING',
      reason: 'IDENTITY_CHANGED',
      changedFields: ['name', 'type'],
    });

    // Et l'organisation repart dans la file de validation, par le même événement qu'à sa
    // création : deux noms d'événement obligeraient le drainage à router deux fois vers la
    // même destination.
    const messages = await outboxMessages(database.owner, organization.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.event_type).toBe('ORGANIZATION_SUBMITTED');
    expect(messages[0]?.aggregate_type).toBe('ORGANIZATION');
    expect(messages[0]?.payload).toStrictEqual({
      organizationId: organization.id,
      submittedByUserId: admin.userId,
      reason: 'IDENTITY_CHANGED',
    });
    // La charge est recopiée dans les journaux du fournisseur d'envoi : identifiants et rien
    // d'autre, ni nom ni numéro d'immatriculation.
    const dump = JSON.stringify(messages);
    expect(dump).not.toContain('Service incendie');
    expect(dump).not.toContain(persisted.registration_number);
  }, 60_000);

  it("fait retomber la validation pour chacun des trois champs d'identité", async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = actor('orgAdmin');

    const cases: readonly (readonly [string, Record<string, unknown>])[] = [
      ['name', { name: 'Nom entièrement différent' }],
      ['type', { type: 'LOCAL_AUTHORITY' }],
      ['registrationNumber', { registrationNumber: nextRegistrationNumber() }],
    ];

    for (const [field, changes] of cases) {
      const organization = await seedOrganization(database.owner, {
        name: `Fiche validée ${field}`,
        type: 'FARM',
        verificationStatus: 'VERIFIED',
      });
      await setMembership(database.owner, {
        organizationId: organization.id,
        userId: admin.userId,
      });

      const response = await patchOrganizationCall(
        organization.id,
        { ...changes, expectedVersion: 1 },
        admin.cookie,
      );

      expect(response.status, field).toBe(200);
      expect(response.json.verificationReset, field).toBe(true);
      expect(organizationOf(response).verificationStatus, field).toBe('PENDING');
      const reset = await auditLines(database.owner, {
        targetId: organization.id,
        action: 'ORGANIZATION_VERIFICATION_RESET',
      });
      expect(reset, field).toHaveLength(1);
      expect(reset[0]?.after, field).toMatchObject({ changedFields: [field] });
    }
  }, 60_000);

  it('laisse la validation acquise quand seul le périmètre territorial change', async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = actor('orgAdmin');
    const organization = await seedOrganization(database.owner, {
      name: 'Collectivité fictive validée',
      type: 'LOCAL_AUTHORITY',
      territoryCode: 'ZZ-DEMO-01',
      verificationStatus: 'VERIFIED',
    });
    await setMembership(database.owner, {
      organizationId: organization.id,
      userId: admin.userId,
    });

    const response = await patchOrganizationCall(
      organization.id,
      { territoryCode: 'ZZ-DEMO-02', expectedVersion: 1 },
      admin.cookie,
    );

    // LE CAS SYMÉTRIQUE COMPTE AUTANT QUE LE PREMIER. `territoryCode` décrit un périmètre
    // d'action, pas une identité : le soumettre à revalidation ferait de la règle une gêne,
    // et dissuaderait de corriger une donnée qu'on veut au contraire voir corrigée.
    expect(response.status).toBe(200);
    expect(response.json.verificationReset).toBe(false);
    expect(organizationOf(response).verificationStatus).toBe('VERIFIED');
    expect(organizationOf(response).territoryCode).toBe('ZZ-DEMO-02');

    const persisted = await readOrganizationRow(database.owner, organization.id);
    expect(persisted.verification_status).toBe('VERIFIED');
    expect(persisted.version).toBe(2);
    expect(
      await auditLines(database.owner, {
        targetId: organization.id,
        action: 'ORGANIZATION_VERIFICATION_RESET',
      }),
    ).toHaveLength(0);
    // Rien ne repart vers la file d'administration : elle ne doit pas se remplir de fiches
    // qui n'ont jamais cessé d'être validées.
    expect(await outboxMessages(database.owner, organization.id)).toHaveLength(0);
  });

  it("ne produit aucune retombée sur une organisation qui n'était pas validée", async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = actor('orgAdmin');

    for (const initial of ['PENDING', 'REJECTED'] as const) {
      const organization = await seedOrganization(database.owner, {
        name: `Fiche ${initial}`,
        verificationStatus: initial,
      });
      await setMembership(database.owner, {
        organizationId: organization.id,
        userId: admin.userId,
      });

      const response = await patchOrganizationCall(
        organization.id,
        { name: `Fiche ${initial} renommée`, expectedVersion: 1 },
        admin.cookie,
      );

      // La retombée est la transition `VERIFIED` → `PENDING`, et rien d'autre. Un refus
      // corrigé reste un refus tant qu'un administrateur plateforme ne l'a pas relu ;
      // repasser `REJECTED` en `PENDING` d'office effacerait sa décision.
      expect(response.status, initial).toBe(200);
      expect(response.json.verificationReset, initial).toBe(false);
      expect(organizationOf(response).verificationStatus, initial).toBe(initial);
      const persisted = await readOrganizationRow(database.owner, organization.id);
      expect(persisted.verification_status, initial).toBe(initial);
      expect(
        await auditLines(database.owner, {
          targetId: organization.id,
          action: 'ORGANIZATION_VERIFICATION_RESET',
        }),
        initial,
      ).toHaveLength(0);
      expect(await outboxMessages(database.owner, organization.id), initial).toHaveLength(0);
    }
  }, 60_000);
});

describe('périmètre territorial', () => {
  it('distingue le champ absent, qui conserve le périmètre, du champ à null, qui le retire', async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = actor('orgAdmin');
    const organization = await seedOrganization(database.owner, {
      name: 'Fiche avec périmètre',
      territoryCode: 'ZZ-DEMO-01',
    });
    await setMembership(database.owner, {
      organizationId: organization.id,
      userId: admin.userId,
    });

    const absent = await patchOrganizationCall(
      organization.id,
      { name: 'Fiche avec périmètre conservé', expectedVersion: 1 },
      admin.cookie,
    );
    const removed = await patchOrganizationCall(
      organization.id,
      { territoryCode: null, expectedVersion: 2 },
      admin.cookie,
    );

    // LA PRÉSENCE DE LA CLÉ VAUT DEMANDE, y compris à `null`. C'est la seule façon
    // d'exprimer un retrait : une fois passés par un type TypeScript, `undefined` et
    // « absent » se confondent, `null` et « absent » non.
    expect(absent.status).toBe(200);
    expect(organizationOf(absent).territoryCode).toBe('ZZ-DEMO-01');
    expect(removed.status).toBe(200);
    expect(organizationOf(removed).territoryCode).toBeNull();

    const persisted = await readOrganizationRow(database.owner, organization.id);
    expect(persisted.territory_code).toBeNull();
    expect(persisted.version).toBe(3);

    const audit = await auditLines(database.owner, {
      targetId: organization.id,
      action: 'ORGANIZATION_UPDATED',
    });
    expect(audit).toHaveLength(2);
    // Le premier audit ignore le périmètre, le second le porte : la distinction se lit
    // jusque dans la preuve, et pas seulement dans la réponse.
    expect(audit[0]?.before).toStrictEqual({ name: 'Fiche avec périmètre' });
    expect(audit[1]?.before).toStrictEqual({ territoryCode: 'ZZ-DEMO-01' });
    expect(audit[1]?.after).toStrictEqual({ territoryCode: null, version: 3 });
  }, 60_000);

  it('refuse une casse non conforme sans jamais la convertir en silence', async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = actor('orgAdmin');
    const organization = await seedOrganization(database.owner, {
      name: 'Fiche à périmètre strict',
      territoryCode: 'ZZ-DEMO-01',
    });
    await setMembership(database.owner, {
      organizationId: organization.id,
      userId: admin.userId,
    });

    for (const territoryCode of ['zz-01', 'Zz-01', '-ZZ01', '', 'ZZ-DEMO-0123456789']) {
      const response = await patchOrganizationCall(
        organization.id,
        { territoryCode, expectedVersion: 1 },
        admin.cookie,
      );

      expect(response.status, `« ${territoryCode} »`).toBe(400);
      expect(errorOf(response).code, `« ${territoryCode} »`).toBe('VALIDATION_ERROR');
      expect(errorOf(response).details, `« ${territoryCode} »`).toStrictEqual({
        fields: ['territoryCode'],
      });
      // La réponse ne renvoie jamais la valeur reçue, ni telle quelle ni corrigée : un
      // serveur qui mettrait « zz-01 » en majuscules à l'insu de l'appelant rendrait deux
      // saisies indiscernables dans `before`/`after` du journal d'audit.
      if (territoryCode.length > 0) {
        expect(response.text, `« ${territoryCode} »`).not.toContain(territoryCode);
        expect(response.text, `« ${territoryCode} »`).not.toContain(territoryCode.toUpperCase());
      }
    }

    const untouched = await readOrganizationRow(database.owner, organization.id);
    expect(untouched.territory_code).toBe('ZZ-DEMO-01');
    expect(untouched.version).toBe(1);

    // Les espaces de bordure, eux, sont rognés avant le contrôle de forme : la valeur
    // canonique est la valeur rognée, et c'est elle qui est écrite.
    const trimmed = await patchOrganizationCall(
      organization.id,
      { territoryCode: '  ZZ-DEMO-09  ', expectedVersion: 1 },
      admin.cookie,
    );
    expect(trimmed.status).toBe(200);
    expect(organizationOf(trimmed).territoryCode).toBe('ZZ-DEMO-09');
  }, 60_000);
});

describe('doublon d immatriculation en modification', () => {
  it("refuse le numéro d'une autre structure, sans rien écrire ni rien en dire", async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = actor('orgAdmin');
    const taken = nextRegistrationNumber();
    const holder = await seedOrganization(database.owner, {
      name: 'Service technique de Val-Fictif',
      type: 'OPERATIONAL_SERVICE',
      registrationNumber: taken,
      territoryCode: 'ZZ-DEMO-09',
    });
    // VALIDÉE À DESSEIN. Si la moindre part de la modification survivait au refus, la fiche
    // retomberait en attente et repartirait dans la file de validation : le refus doit la
    // laisser exactement où elle était, vérification comprise.
    const mine = await seedOrganization(database.owner, {
      name: 'Coopérative fictive à renuméroter',
      verificationStatus: 'VERIFIED',
    });
    await setMembership(database.owner, { organizationId: mine.id, userId: admin.userId });
    const before = await readOrganizationRow(database.owner, mine.id);

    const onTaken = await patchOrganizationCall(
      mine.id,
      { registrationNumber: taken, expectedVersion: 1 },
      admin.cookie,
    );
    // LE MÊME NUMÉRO SOUS UNE AUTRE GRAPHIE. L'unicité porte sur la forme NORMALISÉE, calculée
    // par la colonne générée : une garde qui comparerait les chaînes brutes laisserait passer
    // celle-ci, et deux fiches porteraient alors la même immatriculation.
    const onRewritten = await patchOrganizationCall(
      mine.id,
      { registrationNumber: taken.replaceAll('-', '.').toLowerCase(), expectedVersion: 1 },
      admin.cookie,
    );
    // Refus de FORME : « 12-3 » a quatre caractères bruts et trois normalisés, il passe la
    // borne visible et échoue sur l'invisible. C'est l'étalon de neutralité — ce qu'obtient un
    // appelant sur un numéro que le schéma refuse de toute façon.
    const onMalformed = await patchOrganizationCall(
      mine.id,
      { registrationNumber: '12-3', expectedVersion: 1 },
      admin.cookie,
    );

    // UN 500 ICI FERAIT BIEN PLUS QUE RENDRE LE MAUVAIS STATUT. La conversion du `23505`
    // oubliée, ou visant un nom d'index qui n'existe plus, laisserait remonter l'erreur du
    // pilote — dont le champ `detail` porte la ligne refusée, numéro d'immatriculation brut ET
    // normalisé — jusqu'au journal d'exploitation, au niveau `error`. C'est la règle 10 de la
    // story, sur le seul chemin d'écriture qui ne la vérifiait pas.
    expect(onTaken.status).toBe(400);
    expect(errorOf(onTaken).code).toBe('VALIDATION_ERROR');
    expect(errorOf(onTaken).details).toStrictEqual({ fields: ['registrationNumber'] });
    expect(onRewritten.status).toBe(400);
    expect(errorOf(onRewritten).code).toBe('VALIDATION_ERROR');
    expect(errorOf(onRewritten).details).toStrictEqual({ fields: ['registrationNumber'] });
    expect(onMalformed.status).toBe(400);
    expect(errorOf(onMalformed).code).toBe('VALIDATION_ERROR');

    // NEUTRALITÉ : le refus de doublon est indiscernable d'un refus de forme, corps et
    // en-têtes compris. Sans elle, un administrateur d'organisation énumérerait les numéros
    // déjà enregistrés par tentatives de renommage — l'oracle que la création ferme déjà, et
    // que la modification rouvrirait par la fenêtre.
    expect(Buffer.compare(onTaken.normalizedBytes, onMalformed.normalizedBytes)).toBe(0);
    expect(Buffer.compare(onRewritten.normalizedBytes, onMalformed.normalizedBytes)).toBe(0);
    expect(comparableHeaders(onTaken)).toStrictEqual(comparableHeaders(onMalformed));
    // ET C'EST TOUT : aucun balayage de sentinelles n'est ajouté ici, alors qu'il serait
    // tentant d'en écrire un. Il ne pourrait pas échouer. Le refus de forme n'a jamais reçu le
    // numéro du détenteur, donc l'égalité d'octets ci-dessus IMPLIQUE déjà que le refus de
    // doublon ne le porte pas — pas plus que le nom, l'identifiant ou le périmètre de la
    // structure d'en face. Une assertion qui suit d'une autre n'ajoute pas de garantie, elle
    // ajoute de la confiance sans preuve.

    // RIEN N'A ÉTÉ ÉCRIT, ni chez l'appelant ni chez le détenteur du numéro.
    const afterRefusals = await readOrganizationRow(database.owner, mine.id);
    expect(afterRefusals.registration_number).toBe(before.registration_number);
    expect(afterRefusals.name).toBe(before.name);
    expect(afterRefusals.version).toBe(1);
    expect(afterRefusals.verification_status).toBe('VERIFIED');
    expect(afterRefusals.updated_at.getTime()).toBe(before.updated_at.getTime());
    expect(await auditLines(database.owner, { targetId: mine.id })).toHaveLength(0);
    expect(await outboxMessages(database.owner, mine.id)).toHaveLength(0);
    const holderAfter = await readOrganizationRow(database.owner, holder.id);
    expect(holderAfter.registration_number).toBe(taken);
    expect(holderAfter.version).toBe(1);

    // LA RÉCIPROQUE, sans laquelle un refus systématique passerait pour un succès : le même
    // appel, vers un numéro libre, aboutit. Le refus venait donc du doublon, et non de la
    // forme du numéro, de la version attendue ou du rôle de l'appelant.
    const free = nextRegistrationNumber();
    const accepted = await patchOrganizationCall(
      mine.id,
      { registrationNumber: free, expectedVersion: 1 },
      admin.cookie,
    );
    expect(accepted.status).toBe(200);
    expect(organizationOf(accepted).registrationNumber).toBe(free);
    expect(accepted.json.verificationReset).toBe(true);
    const persisted = await readOrganizationRow(database.owner, mine.id);
    expect(persisted.registration_number).toBe(free);
    expect(persisted.version).toBe(2);
    expect(persisted.verification_status).toBe('PENDING');
  }, 90_000);
});

describe('enveloppe de PATCH : origine, type de contenu, taille du corps', () => {
  /**
   * POURQUOI CES TROIS CAS EXISTENT ICI, ALORS QUE L'ENVELOPPE EST PARTAGÉE.
   * `defineOrganizationRoute` n'est aujourd'hui qu'un autre nom de `defineAuthenticatedRoute`,
   * et trois rédacteurs successifs ont écarté ces cas en s'appuyant sur cette identité. Elle
   * n'est tenue par rien : le commentaire du module annonce lui-même le déplacement du fichier
   * partagé vers `app/api/v1/_shared/`. Le jour où quelqu'un le fera en récrivant l'enveloppe
   * — en gardant `requireSessionFromRequest` et en oubliant `assertTrustedOrigin` —, aucun des
   * tests d'organisation ne rougirait : tous envoient l'origine légitime. Ces cas éprouvent
   * donc le comportement OBSERVABLE de la route, pas la provenance de son code.
   */
  it('refuse une origine étrangère sur PATCH, sans rien écrire, et sert quand même la lecture', async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = actor('orgAdmin');
    const organization = await seedOrganization(database.owner, {
      name: 'Fiche visée depuis ailleurs',
    });
    await setMembership(database.owner, {
      organizationId: organization.id,
      userId: admin.userId,
    });
    const rename = { name: 'Renommage par une page hostile', expectedVersion: 1 };

    const foreignOrigins = [
      'https://site-malveillant.test',
      // Suffixe trompeur : une comparaison écrite `endsWith` l'accepterait, et il suffit
      // d'enregistrer un domaine pour le fabriquer.
      'https://appui-feux.exemple.test.site-malveillant.test',
      // Même hôte, autre port : ce n'est pas la même origine, et le port est ce qui distingue
      // un service de développement d'un autre sur la même machine.
      'https://appui-feux.exemple.test:8443',
      // `Origin: null`, émis par un cadre isolé ou un document `data:` : ne s'analyse pas en
      // URL, donc ne peut pas être reconnu.
      'null',
    ];
    const refusals: (readonly [string, Captured])[] = [];
    for (const origin of foreignOrigins) {
      refusals.push([
        origin,
        await patchOrganizationCall(organization.id, rename, admin.cookie, {
          headers: { origin },
        }),
      ]);
    }
    // Origine ABSENTE mais `Sec-Fetch-Site` qui déclare l'inter-site : c'est le navigateur
    // ancien qui ne pose pas `Origin`. Le second en-tête décide alors seul.
    refusals.push([
      'sec-fetch-site: cross-site',
      await patchOrganizationCall(organization.id, rename, admin.cookie, {
        headers: { 'sec-fetch-site': 'cross-site' },
        omitHeaders: ['origin'],
      }),
    ]);

    for (const [label, response] of refusals) {
      // Une page hostile qui obtiendrait ce `PATCH` renommerait l'organisation d'une victime
      // connectée depuis son propre navigateur : le cookie part tout seul, `SameSite` n'est
      // qu'une première ligne (ADR-017).
      expect(response.status, label).toBe(403);
      expect(errorOf(response).code, label).toBe('FORBIDDEN');
      expect(errorOf(response).details, label).toStrictEqual({});
    }

    const untouched = await readOrganizationRow(database.owner, organization.id);
    expect(untouched.name).toBe('Fiche visée depuis ailleurs');
    expect(untouched.version).toBe(1);
    expect(await auditLines(database.owner, { targetId: organization.id })).toHaveLength(0);

    // NI `Origin` NI `Sec-Fetch-Site` : ce n'est pas un navigateur — client en ligne de
    // commande, sonde, test. Refuser ce cas fermerait l'API aux clients légitimes sans rien
    // fermer à l'attaquant, qui a précisément besoin d'un navigateur joignant le cookie seul.
    const withoutBrowserHeaders = await patchOrganizationCall(
      organization.id,
      { name: 'Renommage par un client sans navigateur', expectedVersion: 1 },
      admin.cookie,
      { omitHeaders: ['origin'] },
    );
    expect(withoutBrowserHeaders.status).toBe(200);

    // La LECTURE reste servie sous une origine étrangère : le contrôle porte sur les méthodes
    // NON SÛRES. L'étendre au `GET` ne fermerait rien — la réponse n'est de toute façon pas
    // lisible par la page tierce — et casserait les clients légitimes.
    const read = await readOrganizationCall(organization.id, admin.cookie, {
      headers: { origin: 'https://site-malveillant.test' },
    });
    expect(read.status).toBe(200);
    expect(organizationOf(read).name).toBe('Renommage par un client sans navigateur');
  }, 90_000);

  it("n'accepte le corps qu'en application/json, et n'écrit rien sur un autre type", async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = actor('orgAdmin');
    const organization = await seedOrganization(database.owner, {
      name: 'Fiche à type de contenu',
    });
    await setMembership(database.owner, {
      organizationId: organization.id,
      userId: admin.userId,
    });
    const rename = { name: 'Renommage par un formulaire tiers', expectedVersion: 1 };

    for (const contentType of [
      // Les trois types qu'un formulaire HTML inter-site sait produire, et aucun n'est
      // `application/json` : c'est ce qui met ces routes hors de portée d'une soumission
      // croisée sans contrôle préalable.
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=frontiere',
      // Voisin trompeur : le type est comparé en entier, jamais par préfixe.
      'application/json-patch+json',
    ]) {
      const response = await patchOrganizationCall(organization.id, rename, admin.cookie, {
        headers: { 'content-type': contentType },
      });

      expect(response.status, contentType).toBe(415);
      expect(errorOf(response).code, contentType).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
    // AUCUN TYPE DÉCLARÉ PAR L'APPELANT. Il n'est jamais déduit du contenu : ce qui parvient à
    // la route est au mieux le `text/plain` que le moteur pose pour un corps texte, comme le
    // ferait un navigateur, et il est refusé comme les autres.
    const withoutType = await patchOrganizationCall(organization.id, rename, admin.cookie, {
      omitHeaders: ['content-type'],
    });
    expect(withoutType.status).toBe(415);
    expect(errorOf(withoutType).code).toBe('UNSUPPORTED_MEDIA_TYPE');

    const untouched = await readOrganizationRow(database.owner, organization.id);
    expect(untouched.name).toBe('Fiche à type de contenu');
    expect(untouched.version).toBe(1);
    expect(await auditLines(database.owner, { targetId: organization.id })).toHaveLength(0);

    // Le paramètre de jeu de caractères ne change pas le type : il est accepté. Sans ce cas,
    // une comparaison écrite sur la chaîne entière passerait pour juste alors qu'elle
    // refuserait tout navigateur qui annonce son encodage.
    const withCharset = await patchOrganizationCall(
      organization.id,
      { name: 'Renommage annoncé avec son encodage', expectedVersion: 1 },
      admin.cookie,
      { headers: { 'content-type': 'application/json; charset=utf-8' } },
    );
    expect(withCharset.status).toBe(200);
    expect(organizationOf(withCharset).name).toBe('Renommage annoncé avec son encodage');
  }, 90_000);

  it('plafonne le corps de PATCH à 2 048 octets, et pas un de moins', async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = actor('orgAdmin');
    const organization = await seedOrganization(database.owner, { name: 'Fiche à corps borné' });
    await setMembership(database.owner, {
      organizationId: organization.id,
      userId: admin.userId,
    });

    const atLimit = patchBodyOfExactSize(PATCH_MAX_BODY_BYTES);
    const overLimit = patchBodyOfExactSize(PATCH_MAX_BODY_BYTES + 1);
    // Sans cette mesure, les deux cas suivants pourraient éprouver deux corps de taille
    // quelconque et le nom de la borne ne voudrait rien dire.
    expect(Buffer.byteLength(JSON.stringify(atLimit), 'utf8')).toBe(PATCH_MAX_BODY_BYTES);
    expect(Buffer.byteLength(JSON.stringify(overLimit), 'utf8')).toBe(PATCH_MAX_BODY_BYTES + 1);

    const accepted = await patchOrganizationCall(organization.id, atLimit, admin.cookie);
    const refused = await patchOrganizationCall(organization.id, overLimit, admin.cookie);

    // À LA BORNE EXACTE, le corps est LU : il traverse l'enveloppe et se fait refuser par la
    // validation, sur le nom devenu trop long. C'est ce qui prouve que la limite n'est pas
    // plus basse qu'annoncé.
    expect(accepted.status).toBe(400);
    expect(errorOf(accepted).code).toBe('VALIDATION_ERROR');
    expect(errorOf(accepted).details).toStrictEqual({ fields: ['name'] });
    // UN OCTET AU-DESSUS, il est refusé sans être lu, et la réponse dit la limite pour que
    // l'écran puisse l'expliquer. Le piège à connaître est là : au-delà de 2 048 octets, une
    // saisie trop longue produit un 413 et non le 400 attaché au champ.
    expect(refused.status).toBe(413);
    expect(errorOf(refused).code).toBe('PAYLOAD_TOO_LARGE');
    expect(errorOf(refused).details).toStrictEqual({ maxBodyBytes: PATCH_MAX_BODY_BYTES });

    const untouched = await readOrganizationRow(database.owner, organization.id);
    expect(untouched.name).toBe('Fiche à corps borné');
    expect(untouched.version).toBe(1);
    expect(await auditLines(database.owner, { targetId: organization.id })).toHaveLength(0);

    /**
     * LE CHEMIN ANNONCÉ, ET IL N'EST PAS UNE REDONDANCE. `assertBodyWithinLimit` a deux
     * régimes : croire l'en-tête `content-length` quand il est là, MESURER le flux quand il ne
     * l'est pas. Les deux cas ci-dessus ne peuvent éprouver que le second — les corps
     * fabriqués par `new Request` n'annoncent pas leur taille — alors qu'un déploiement réel
     * emprunte le premier, l'en-tête étant posé par le serveur HTTP. Sans ces deux appels, la
     * borne ne serait pinnée que sur le régime que la production n'emprunte presque jamais.
     * Ils sont en outre DÉTERMINISTES : rien n'est lu, la décision tient à l'en-tête seul.
     */
    const declaredOver = await patchOrganizationCall(
      organization.id,
      { name: 'Renommage de taille annoncée', expectedVersion: 1 },
      admin.cookie,
      { headers: { 'content-length': String(PATCH_MAX_BODY_BYTES + 1) } },
    );
    expect(declaredOver.status).toBe(413);
    expect(errorOf(declaredOver).code).toBe('PAYLOAD_TOO_LARGE');
    expect(errorOf(declaredOver).details).toStrictEqual({ maxBodyBytes: PATCH_MAX_BODY_BYTES });
    // Annoncée À la borne, la requête passe : la limite est un maximum inclusif, et un corps
    // de 2 048 octets pile n'est pas trop gros.
    const declaredAtLimit = await patchOrganizationCall(
      organization.id,
      { name: 'Renommage de taille annoncée', expectedVersion: 1 },
      admin.cookie,
      { headers: { 'content-length': String(PATCH_MAX_BODY_BYTES) } },
    );
    expect(declaredAtLimit.status).toBe(200);
    expect(organizationOf(declaredAtLimit).name).toBe('Renommage de taille annoncée');
  }, 60_000);
});

describe('session révoquée sur une route d organisation', () => {
  it('refuse une ancienne session à ses trois échelles, et sert une session neuve', async (context) => {
    const database = databaseOrSkip(setup, context);
    // UN ACTEUR DÉDIÉ. Révoquer les sessions d'un acteur partagé emporterait tous les cas
    // suivants du fichier, et l'échec ressemblerait à un défaut d'organisation alors qu'il
    // viendrait de l'identité.
    const email = nextEmail('session-revoquee');
    await seedProfile(database.owner, { email, displayName: 'Camille session' });
    const first = await signInThroughRoutes(email, nextAddress());
    const organization = await seedOrganization(database.owner, {
      name: 'Fiche à session révoquée',
    });
    await setMembership(database.owner, {
      organizationId: organization.id,
      userId: first.userId,
    });
    const rename = { name: 'Renommage par une session morte', expectedVersion: 1 };

    // TÉMOIN POSITIF, pris avant toute révocation : sans lui, les refus qui suivent pourraient
    // venir d'un montage raté plutôt que de la révocation.
    const granted = await readOrganizationCall(organization.id, first.cookie);
    expect(granted.status).toBe(200);
    const anonymous = await readOrganizationCall(organization.id);

    // ÉCHELLE 3 — INTERRUPTEUR GLOBAL (ADR-017). Il n'écrit rien : la session reste valide en
    // tout point, c'est l'exploitation qui a décidé de fermer.
    const underSwitch = await withForcedSessionRevocation(async () => ({
      read: await readOrganizationCall(organization.id, first.cookie),
      write: await patchOrganizationCall(organization.id, rename, first.cookie),
    }));
    expect(underSwitch.read.status).toBe(401);
    expect(errorOf(underSwitch.read).code).toBe('UNAUTHENTICATED');
    expect(underSwitch.write.status).toBe(401);
    expect(errorOf(underSwitch.write).code).toBe('UNAUTHENTICATED');
    // La réponse ne dit pas si ce cookie a jamais valu quelque chose : même corps, au bit
    // près, qu'un appel sans cookie du tout.
    expect(Buffer.compare(underSwitch.read.normalizedBytes, anonymous.normalizedBytes)).toBe(0);
    // Réciproque : l'interrupteur désarmé, la MÊME session rouvre l'accès. Sans elle, un refus
    // permanent passerait pour la preuve de l'interrupteur.
    expect((await readOrganizationCall(organization.id, first.cookie)).status).toBe(200);

    // ÉCHELLE 2 — TOUTES LES SESSIONS DU COMPTE, par avancée de `sessions_revoked_at`. C'est
    // ce qu'écrit `POST /api/v1/auth/sessions/commands/revoke-all` : une seule écriture, sur
    // le profil, et le prédicat de validité fait le reste à la lecture.
    await database.owner.query(
      'update public.user_profiles set sessions_revoked_at = now() where id = $1',
      [first.userId],
    );
    const afterAccountRevocation = await readOrganizationCall(organization.id, first.cookie);
    const writeAfterAccountRevocation = await patchOrganizationCall(
      organization.id,
      rename,
      first.cookie,
    );
    expect(afterAccountRevocation.status).toBe(401);
    expect(writeAfterAccountRevocation.status).toBe(401);
    expect(Buffer.compare(afterAccountRevocation.normalizedBytes, anonymous.normalizedBytes)).toBe(
      0,
    );

    // C'EST L'ANCIENNE SESSION QUI EST REFUSÉE, PAS LE COMPTE. Une session émise APRÈS la
    // révocation, sur le même compte et la même adhésion, est servie ; l'ancienne reste morte.
    // « Réutilisation d'une ancienne session », cas obligatoire de docs/permissions.md.
    const second = await signInThroughRoutes(email, nextAddress());
    expect((await readOrganizationCall(organization.id, second.cookie)).status).toBe(200);
    expect((await readOrganizationCall(organization.id, first.cookie)).status).toBe(401);
    const acceptedWrite = await patchOrganizationCall(
      organization.id,
      { name: 'Renommage par une session vivante', expectedVersion: 1 },
      second.cookie,
    );
    expect(acceptedWrite.status).toBe(200);

    // ÉCHELLE 1 — DÉCONNEXION UNITAIRE, celle d'un appareil que l'on ferme.
    await database.owner.query(
      `update public.sessions set revoked_at = now()
        where user_profile_id = $1 and revoked_at is null`,
      [first.userId],
    );
    const afterUnitRevocation = await readOrganizationCall(organization.id, second.cookie);
    const writeAfterUnitRevocation = await patchOrganizationCall(
      organization.id,
      { name: 'Renommage après déconnexion', expectedVersion: 2 },
      second.cookie,
    );
    expect(afterUnitRevocation.status).toBe(401);
    expect(writeAfterUnitRevocation.status).toBe(401);

    // L'ADHÉSION N'A JAMAIS BOUGÉ : c'est la session qui ferme, pas l'autorisation. Seule
    // l'écriture faite par la session vivante subsiste, les trois autres n'ont rien laissé.
    const persisted = await readOrganizationRow(database.owner, organization.id);
    expect(persisted.name).toBe('Renommage par une session vivante');
    expect(persisted.version).toBe(2);
    expect(
      await auditLines(database.owner, {
        targetId: organization.id,
        action: 'ORGANIZATION_UPDATED',
      }),
    ).toHaveLength(1);
  }, 120_000);
});

describe('adhésion rendue : ce que l appelant EST, non ce qui lui donne accès', () => {
  it("rend l'adhésion RÉVOQUÉE d'un administrateur plateforme, en lecture comme en modification", async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = actor('platformAdmin');
    const organization = await seedOrganization(database.owner, { name: 'Fiche à double titre' });
    // LE SEUL MONTAGE OÙ `membership` ET `effectiveMembership` DIFFÈRENT SANS QUE L'ACCÈS SOIT
    // REFUSÉ : l'accès vient de la fonction de plateforme, l'adhésion, elle, ne vaut plus rien.
    // Partout ailleurs, l'adhésion qui ouvre l'accès est celle qui existe, et échanger les deux
    // champs en sortie resterait invisible.
    await setMembership(database.owner, {
      organizationId: organization.id,
      userId: admin.userId,
      role: 'COORDINATOR',
      status: 'REVOKED',
    });

    const read = await readOrganizationCall(organization.id, admin.cookie);
    const patched = await patchOrganizationCall(
      organization.id,
      { name: 'Fiche corrigée à double titre', expectedVersion: 1 },
      admin.cookie,
    );

    /**
     * TRANCHÉ : C'EST L'ADHÉSION BRUTE QUI SORT, JAMAIS L'ADHÉSION EFFECTIVE. Trois raisons,
     * dans l'ordre où elles pèsent.
     *
     * 1. `docs/api-contract.md` ferme le vocabulaire de `membership.status` sur QUATRE valeurs
     *    — `INVITED`, `ACTIVE`, `SUSPENDED`, `REVOKED` — et n'en fait ouvrir l'accès qu'à une.
     *    Rendre l'adhésion effective rendrait les trois autres inatteignables en réponse : le
     *    champ n'aurait plus qu'une valeur possible et le contrat mentirait sur trois quarts de
     *    son énumération.
     * 2. Le contrat dit du champ qu'il porte « ce que l'appelant est dans cette organisation,
     *    pas ce qui lui donne accès ». Un membre révoqué reste ce qu'il est ici ; `null` dirait
     *    « rien du tout », ce qui est faux et ce qui est déjà la réponse réservée à
     *    l'administrateur plateforme SANS adhésion — cas éprouvé plus haut dans ce fichier.
     * 3. L'écran a besoin de la distinction : `adhesion-appelant` et `adhesion-absente` sont
     *    deux états séparés de `docs/screens.md`, et seule l'adhésion brute les sépare.
     */
    expect(read.status).toBe(200);
    expect(read.json.membership, "l'adhésion révoquée doit sortir, et non null").not.toBeNull();
    const readMembership = read.json.membership as Record<string, unknown>;
    expect(Object.keys(readMembership).sort()).toStrictEqual(MEMBERSHIP_FIELDS);
    expect(readMembership.role).toBe('COORDINATOR');
    expect(readMembership.status).toBe('REVOKED');
    expect(patched.status).toBe(200);
    expect(patched.json.membership, 'la modification rend la même adhésion').not.toBeNull();
    const patchedMembership = patched.json.membership as Record<string, unknown>;
    expect(patchedMembership.role).toBe('COORDINATOR');
    expect(patchedMembership.status).toBe('REVOKED');
    expect(organizationOf(patched).name).toBe('Fiche corrigée à double titre');

    // CONTRE-ÉPREUVE, sans laquelle ce cas ressemblerait à une adhésion révoquée qui ouvre
    // l'accès : la même adhésion, chez quelqu'un qui n'est pas administrateur plateforme, ne
    // donne rien du tout. Ce qui a ouvert la porte est la fonction, jamais l'adhésion rendue.
    const lesser = actor('member');
    await setMembership(database.owner, {
      organizationId: organization.id,
      userId: lesser.userId,
      role: 'COORDINATOR',
      status: 'REVOKED',
    });
    const refusedRead = await readOrganizationCall(organization.id, lesser.cookie);
    expect(refusedRead.status).toBe(404);
    expect(errorOf(refusedRead).code).toBe('NOT_FOUND');
  }, 60_000);
});

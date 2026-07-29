import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Voir l'en-tête de `auth-identity-flow.test.ts` : l'environnement précède les imports.
 *
 * `AUTH_SECRET` est posée ici et non laissée au repli local, bien que le repli suffise dans un
 * fichier unique : l'empreinte d'idempotence en dépend, et tout ce fichier mesure des rejeux.
 * Une clé éphémère rendrait la cause d'un échec ambiguë entre « le rejeu est refusé » et « la
 * clé a changé ».
 */
vi.hoisted(() => {
  process.env.APP_ENV = 'local';
  process.env.APP_VERSION = '0.0.0-test';
  process.env.LOG_LEVEL = 'error';
  process.env.AUTH_SECRET = 'secret-de-test-fictif-organisations-de-plus-de-32-caracteres';
  process.env.DATABASE_URL = 'postgresql://attente:attente@localhost:5432/attente';
  process.env.DATABASE_SSL = 'disable';
  process.env.DATABASE_POOL_MAX = '20';
});

import { resetServerConfigCache } from '@/config/env';
import type { CodeDelivery, SignInCodeMessage } from '@/domain/identity/code-delivery';
import { configureCodeDelivery, resetCodeDelivery } from '@/domain/identity/code-delivery';
import { computeRequestFingerprint } from '@/domain/organizations/fingerprint';
import { ORGANIZATION_CREATE_OPERATION } from '@/domain/organizations/policy';
import { closePool, getPool } from '@/infrastructure/database/pool';
import { reserveIdempotencyKey } from '@/infrastructure/organizations/idempotency';
import { logger } from '@/observability/logger';
import { defineAuthenticatedRoute } from '../../app/api/v1/auth/_shared/auth-route';
import { POST as requestCodeRoute } from '../../app/api/v1/auth/codes/route';
import { POST as openSessionRoute } from '../../app/api/v1/auth/sessions/route';
import { defineOrganizationRoute } from '../../app/api/v1/organizations/_shared/organization-route';
import { POST as createOrganizationRoute } from '../../app/api/v1/organizations/route';
import type { DisposableDatabaseSetup } from './setup/database';
import { createDisposableDatabase, databaseOrSkip, NOT_PREPARED } from './setup/database';

/**
 * `POST /api/v1/organizations` — création d'une organisation (US-012), contre une vraie base.
 *
 * POURQUOI CE NIVEAU ET PAS DES DOUBLURES. Trois garanties de cette commande n'existent que
 * dans le SQL et disparaîtraient avec un dépôt simulé :
 *
 * - l'idempotence, portée par `INSERT ... ON CONFLICT DO NOTHING` sur `idempotency_keys`. Un
 *   dépôt simulé qui lirait avant d'écrire passerait le test et perdrait la garantie, puisque
 *   deux transactions simultanées liraient toutes deux « clé libre » ;
 * - l'unicité de l'immatriculation, tranchée par un index posé sur une colonne GÉNÉRÉE, donc
 *   par une normalisation que l'application ne calcule jamais elle-même ;
 * - l'atomicité des six écritures, qui ne se constate qu'en comptant des lignes après coup —
 *   la réponse, elle, est la même qu'une transaction ait tout écrit ou seulement la moitié.
 *
 * LES ROUTES SONT APPELÉES DIRECTEMENT, avec de vrais objets `Request`. C'est là que se joue ce
 * que le domaine ne peut pas garantir seul : statut, forme exacte du corps, en-têtes, ordre des
 * gardes. Aucun serveur n'est monté, donc aucun risque de rendre un verdict sur l'artefact
 * périmé que sert le conteneur du port 3000.
 *
 * LA NEUTRALITÉ SE VÉRIFIE SUR LES OCTETS. « Même code, même message, mêmes détails » se teste
 * en comparant les corps sérialisés, `requestId` mis à part. Une clé de plus dans `details`
 * suffirait à dire à un tiers que le numéro qu'il essaie appartient déjà à quelqu'un.
 */

const ORIGIN = 'https://appui-feux.exemple.test';
const HOST = 'appui-feux.exemple.test';
const FIXED_REQUEST_ID = 'req_00000000-0000-4000-8000-000000000000';
const REQUEST_ID_PATTERN = /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const COOKIE_NAME = 'appui_feux_session';
const ORGANIZATIONS_PATH = '/api/v1/organizations';

/** Les dix clés de l'objet `organization` du contrat, triées. Ni plus, ni moins. */
const ORGANIZATION_KEYS = [
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

/** Délai d'observation du blocage, repris de `db-concurrency.test.ts`. */
const BLOCKING_OBSERVATION_MS = 300;

/**
 * Limite de corps héritée de l'enveloppe d'authentification (`AUTH_MAX_BODY_BYTES`).
 *
 * La valeur est RECOPIÉE et non importée, à dessein : le module ne l'exporte pas, et l'importer
 * ferait dire au test « la route applique la constante qu'elle applique ». Recopiée, elle devient
 * ce que le test exige d'elle — un changement de plafond doit être un choix explicite, visible en
 * relecture, et non une dérive que la suite avaliserait en silence.
 */
const MAX_BODY_BYTES = 2_048;

let setup: DisposableDatabaseSetup = NOT_PREPARED;
const deliveries: SignInCodeMessage[] = [];
let addressCounter = 0;

const recordingDelivery: CodeDelivery = {
  send(message: SignInCodeMessage): Promise<void> {
    deliveries.push(message);
    return Promise.resolve();
  },
};

/**
 * Une adresse par ouverture de session. La limitation de tentatives porte sur l'identifiant ET
 * sur l'adresse : deux comptes qui la partageraient s'empoisonneraient, et le second échouerait
 * pour une raison sans rapport avec les organisations.
 */
function nextAddress(): string {
  addressCounter += 1;
  return `198.51.${Math.floor(addressCounter / 250)}.${(addressCounter % 250) + 1}`;
}

function nextEmail(label: string): string {
  return `sentinelle-${label}-${randomUUID().slice(0, 8)}@exemple.test`;
}

/** Fragment aléatoire majuscule : il sert de cœur commun aux écritures d'un même numéro. */
function nextRegistrationCore(): string {
  return randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
}

/**
 * Numéro d'immatriculation FICTIF, comme l'exigent `docs/test-plan.md` et
 * `docs/privacy-rgpd.md` : aucune donnée réelle en test. Le préfixe reste acceptable par
 * `organizations_registration_number_shape`, ce qui est précisément ce que le contrat promet.
 */
function nextRegistrationNumber(): string {
  return `FICTIF-ORG-${nextRegistrationCore()}`;
}

/**
 * Trois écritures d'un MÊME numéro : séparateurs différents, casse différente. La colonne
 * générée les normalise toutes en `FICTIFORG<core>`, donc elles entrent toutes en conflit.
 */
function registrationVariants(core: string): readonly [string, string, string] {
  return [`FICTIF-ORG-${core}`, `fictif org ${core}`, `FICTIF.ORG.${core}`];
}

interface CallOptions {
  readonly path: string;
  readonly method: string;
  readonly body?: unknown;
  /** Corps envoyé TEL QUEL, pour éprouver ce que `JSON.stringify` ne saurait produire. */
  readonly rawBody?: string;
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
  const serialized =
    options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
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

function detailsOf(captured: Captured): Record<string, unknown> {
  return (errorOf(captured).details ?? {}) as Record<string, unknown>;
}

function organizationOf(captured: Captured): Record<string, unknown> {
  return (captured.json.organization ?? {}) as Record<string, unknown>;
}

/** En-têtes comparables entre deux réponses : ceux qui varient légitimement sont retirés. */
function comparableHeaders(captured: Captured): Record<string, string> {
  const { 'x-request-id': _requestId, ...rest } = captured.headers;
  return rest;
}

/**
 * SANS CETTE PRÉPARATION, LES TESTS DE COURSE MESURERAIENT LA MAUVAISE CHOSE. Ouvrir plusieurs
 * connexions d'un coup vers une base conteneurisée coûte plus que le délai d'obtention d'une
 * connexion du pilote : les appels échoueraient sur l'attente du pool au lieu d'être arbitrés
 * par la base.
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
  readonly displayName: string;
  readonly email: string;
}

/**
 * Compte réel, session réelle, obtenue par les vraies routes.
 *
 * La session n'est PAS fabriquée en insérant une ligne dans `sessions` : le cookie et la
 * barrière qui le lit font partie de ce qui est éprouvé ici. Une session forgée testerait la
 * fabrication du test.
 */
async function createActor(client: Client, label: string): Promise<Actor> {
  const email = nextEmail(label);
  const displayName = `Sentinelle ${label}`;
  await seedProfile(client, { email, displayName });
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
  const user = opened.json.user as { readonly id: string };
  return { cookie: readCookieValue(opened.setCookie), userId: user.id, displayName, email };
}

interface PostOptions {
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly cookie?: string | undefined;
  readonly json?: boolean;
  readonly headers?: Record<string, string>;
  readonly noOrigin?: boolean;
}

async function postOrganization(options: PostOptions): Promise<Captured> {
  return capture(
    await createOrganizationRoute(
      buildRequest({ path: ORGANIZATIONS_PATH, method: 'POST', ...options }),
    ),
  );
}

/** Corps valide, chaque appel portant son numéro et sa clé : aucun conflit involontaire. */
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Exploitation agricole Martin',
    type: 'FARM',
    registrationNumber: nextRegistrationNumber(),
    clientEventId: randomUUID(),
    ...overrides,
  };
}

/**
 * Les valeurs textuelles qu'un corps envoie RÉELLEMENT, c'est-à-dire les seules qu'une réponse
 * bavarde pourrait recopier.
 *
 * POURQUOI DÉRIVER LES SENTINELLES DU CORPS PLUTÔT QUE DE LES ÉCRIRE À CÔTÉ. La relecture
 * adversariale a établi que chercher `zz-01` dans les onze réponses d'une boucle de validation
 * n'éprouve rien sur les neuf cas qui n'envoient pas cette valeur : l'absence y est acquise par
 * construction, et neuf assertions sur onze ne peuvent pas échouer. Une sentinelle lue dans le
 * corps envoyé est, elle, attachée à son cas par construction : elle a forcément été émise.
 *
 * Le seuil de quatre caractères écarte les valeurs trop courtes pour qu'une occurrence dans le
 * corps d'erreur veuille dire quelque chose — un nom d'un seul caractère se retrouverait par
 * hasard dans n'importe quel libellé français.
 */
function sentValues(body: Record<string, unknown>): readonly string[] {
  return Object.values(body).filter(
    (value): value is string => typeof value === 'string' && value.trim().length >= 4,
  );
}

/**
 * Corps JSON valide d'une taille EXACTE en octets, obtenue en allongeant le seul champ libre.
 *
 * Le remplissage est ASCII et la clé `name` existe déjà dans le corps de départ : l'allonger d'un
 * caractère allonge la sérialisation d'exactement un octet, sans échappement ni déplacement de
 * clé. Sans cette égalité, la borne mesurée ne serait pas celle qu'on croit mesurer, et un test
 * de frontière qui se trompe de frontière ne prouve rien.
 */
function padToExactSize(base: Record<string, unknown>, bytes: number): string {
  const skeleton = JSON.stringify({ ...base, name: '' });
  const padding = bytes - Buffer.byteLength(skeleton, 'utf8');
  if (padding < 0) {
    throw new Error(`corps déjà plus long que ${bytes} octets sans son nom`);
  }
  return JSON.stringify({ ...base, name: 'A'.repeat(padding) });
}

async function countRows(client: Client, sql: string, params: unknown[]): Promise<number> {
  const { rows } = await client.query<{ readonly count: string }>(sql, params);
  return Number(rows[0]?.count ?? '-1');
}

/** Nombre d'organisations dont la forme NORMALISÉE du numéro est celle de `written`. */
async function countOrganizationsByNumber(client: Client, written: string): Promise<number> {
  return countRows(
    client,
    `select count(*)::text as count
       from public.organizations
      where registration_number_normalized
            = upper(regexp_replace($1::text, '[^0-9A-Za-z]', '', 'g'))`,
    [written],
  );
}

async function countIdempotencyKeys(client: Client, clientEventId: string): Promise<number> {
  return countRows(
    client,
    'select count(*)::text as count from public.idempotency_keys where client_event_id = $1',
    [clientEventId],
  );
}

/**
 * Les effets d'une création, comptés en base. La réponse ne les expose pas : `replayed` ne sort
 * pas dans le corps, et un rejeu est indiscernable d'une création sur les seuls octets rendus.
 * Seul le nombre de lignes distingue les deux.
 */
interface Effects {
  readonly organizations: number;
  readonly members: number;
  readonly auditLines: number;
  readonly outboxMessages: number;
}

async function readEffects(client: Client, organizationId: string): Promise<Effects> {
  return {
    organizations: await countRows(
      client,
      'select count(*)::text as count from public.organizations where id = $1',
      [organizationId],
    ),
    members: await countRows(
      client,
      'select count(*)::text as count from public.organization_members where organization_id = $1',
      [organizationId],
    ),
    auditLines: await countRows(
      client,
      'select count(*)::text as count from public.audit_logs where actor_organization_id = $1',
      [organizationId],
    ),
    outboxMessages: await countRows(
      client,
      'select count(*)::text as count from public.outbox where aggregate_id = $1',
      [organizationId],
    ),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

beforeAll(async () => {
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
  delete process.env.PLATFORM_READ_ONLY;
  await closePool();
  if (setup.available) {
    await setup.database.dispose();
  }
});

describe('POST /api/v1/organizations — création', () => {
  it('crée une organisation EN ATTENTE de validation et rend les trois clés du contrat', async (context) => {
    const database = databaseOrSkip(setup, context);
    const actor = await createActor(database.owner, 'creation');
    const registrationNumber = nextRegistrationNumber();

    const response = await postOrganization({
      cookie: actor.cookie,
      body: {
        // Les espaces de bordure sont rognés par la validation : la valeur canonique est celle
        // qui est stockée, rendue et empreintée.
        name: '  Exploitation agricole Martin  ',
        type: 'FARM',
        registrationNumber: ` ${registrationNumber} `,
        territoryCode: 'ZZ-DEMO-02',
        clientEventId: randomUUID(),
      },
    });

    expect(response.status).toBe(201);
    // `replayed` est un drapeau de journal, pas un champ de réponse : le client qui a perdu la
    // première réponse n'a pas à distinguer une création d'un rejeu. Sa présence ici rouvrirait
    // exactement la distinction que le contrat ferme.
    expect(Object.keys(response.json).sort()).toStrictEqual([
      'membership',
      'nextStep',
      'organization',
    ]);
    const organization = organizationOf(response);
    expect(Object.keys(organization).sort()).toStrictEqual(ORGANIZATION_KEYS);
    expect(organization.name).toBe('Exploitation agricole Martin');
    expect(organization.type).toBe('FARM');
    // Le numéro ressort TEL QU'IL A ÉTÉ SAISI, séparateurs compris : c'est ce que le contrat
    // promet, et l'inverse inviterait le client à recalculer la forme normalisée lui-même.
    expect(organization.registrationNumber).toBe(registrationNumber);
    expect(organization.territoryCode).toBe('ZZ-DEMO-02');
    // UNE ORGANISATION NE NAÎT JAMAIS VALIDÉE. C'est la garantie qui rend la file de validation
    // autre chose qu'un ornement (`docs/api-contract.md`, ADR-016).
    expect(organization.verificationStatus).toBe('PENDING');
    expect(organization.status).toBe('ACTIVE');
    expect(organization.version).toBe(1);
    expect(organization.createdAt).toBe(organization.updatedAt);
    expect(new Date(String(organization.createdAt)).toISOString()).toBe(organization.createdAt);
    expect(response.json.nextStep).toBe('AWAITING_VERIFICATION');

    const membership = response.json.membership as Record<string, unknown>;
    expect(Object.keys(membership).sort()).toStrictEqual([
      'role',
      'status',
      'validFrom',
      'validUntil',
    ]);
    expect(membership.role).toBe('ORG_ADMIN');
    expect(membership.status).toBe('ACTIVE');
    expect(membership.validUntil).toBeNull();

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['x-request-id']).toMatch(REQUEST_ID_PATTERN);
    // La forme normalisée porte l'unicité ; elle est un détail de la contrainte et ne sort
    // d'aucune réponse.
    expect(response.text).not.toContain(registrationNumber.replaceAll('-', ''));

    const { rows } = await database.owner.query<{
      readonly verification_status: string;
      readonly status: string;
      readonly version: number;
      readonly registration_number_normalized: string;
    }>(
      `select verification_status, status, version, registration_number_normalized
         from public.organizations where id = $1`,
      [organization.id],
    );
    expect(rows[0]?.verification_status).toBe('PENDING');
    expect(rows[0]?.status).toBe('ACTIVE');
    expect(rows[0]?.version).toBe(1);
    expect(rows[0]?.registration_number_normalized).toBe(
      registrationNumber.replaceAll('-', '').toUpperCase(),
    );
  }, 60_000);

  it('fait du créateur un ORG_ADMIN actif par décision du serveur', async (context) => {
    const database = databaseOrSkip(setup, context);
    const actor = await createActor(database.owner, 'role');
    const body = validBody({ name: 'Coopérative de la Combe Noire' });

    const response = await postOrganization({ cookie: actor.cookie, body });

    expect(response.status).toBe(201);
    const organizationId = String(organizationOf(response).id);
    const { rows } = await database.owner.query<{
      readonly user_id: string;
      readonly role: string;
      readonly status: string;
      readonly valid_until: Date | null;
    }>(
      `select user_id, role, status, valid_until
         from public.organization_members where organization_id = $1`,
      [organizationId],
    );

    // Une organisation sans administrateur serait une fiche que personne ne peut corriger, donc
    // une entrée définitivement bloquée dans la file de validation.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(actor.userId);
    expect(rows[0]?.role).toBe('ORG_ADMIN');
    expect(rows[0]?.status).toBe('ACTIVE');
    expect(rows[0]?.valid_until).toBeNull();

    // Les six écritures de la transaction, comptées : l'organisation, l'adhésion, DEUX lignes
    // d'audit — `ORGANIZATION_CREATED` et `ORGANIZATION_MEMBER_ADDED` — et un message d'outbox,
    // la sixième étant l'inscription du résultat sur la ligne d'idempotence, vérifiée ailleurs.
    expect(await readEffects(database.owner, organizationId)).toStrictEqual({
      organizations: 1,
      members: 1,
      auditLines: 2,
      outboxMessages: 1,
    });

    const audit = await database.owner.query<{
      readonly action: string;
      readonly target_type: string;
      readonly target_id: string;
      readonly actor_user_id: string;
      readonly ip_hash: string | null;
    }>(
      `select action, target_type, target_id, actor_user_id, ip_hash
         from public.audit_logs
        where actor_organization_id = $1
        order by action`,
      [organizationId],
    );
    // La MUTATION EST AUDITÉE, et les deux faits sont distincts : l'organisation a été déclarée,
    // et quelqu'un y a reçu un rôle. Confondre les deux rendrait impossible de compter les
    // secondes sans relire les premières.
    expect(audit.rows.map((row) => row.action)).toStrictEqual([
      'ORGANIZATION_CREATED',
      'ORGANIZATION_MEMBER_ADDED',
    ]);
    expect(audit.rows[0]?.target_type).toBe('ORGANIZATION');
    expect(audit.rows[0]?.target_id).toBe(organizationId);
    // La cible de l'adhésion est L'UTILISATEUR : l'adhésion n'a pas d'identifiant propre, et
    // répéter l'organisation dans les deux colonnes perdrait la seule information restante.
    expect(audit.rows[1]?.target_type).toBe('ORGANIZATION_MEMBER');
    expect(audit.rows[1]?.target_id).toBe(actor.userId);
    for (const row of audit.rows) {
      expect(row.actor_user_id).toBe(actor.userId);
      // Une empreinte, jamais une adresse.
      expect(row.ip_hash).toMatch(HEX_DIGEST_PATTERN);
    }

    const outbox = await database.owner.query<{
      readonly event_type: string;
      readonly aggregate_type: string;
      readonly payload: Record<string, unknown>;
      readonly processed_at: Date | null;
    }>(
      `select event_type, aggregate_type, payload, processed_at
         from public.outbox where aggregate_id = $1`,
      [organizationId],
    );
    expect(outbox.rows[0]?.event_type).toBe('ORGANIZATION_SUBMITTED');
    expect(outbox.rows[0]?.aggregate_type).toBe('ORGANIZATION');
    expect(outbox.rows[0]?.processed_at).toBeNull();
    // IDENTIFIANTS ET RIEN D'AUTRE : la charge est recopiée dans les journaux du fournisseur
    // d'envoi. Ni nom, ni numéro d'immatriculation. Le service de notification relit
    // l'organisation s'il en a besoin, avec les droits qui vont avec.
    expect(outbox.rows[0]?.payload).toStrictEqual({
      organizationId,
      submittedByUserId: actor.userId,
      reason: 'CREATED',
    });
  }, 60_000);
});

describe('POST /api/v1/organizations — refus', () => {
  it('refuse sans session AVANT de regarder le corps, et refuse pareil quel que soit le cookie', async (context) => {
    const database = databaseOrSkip(setup, context);
    const clientEventId = randomUUID();

    const noCookie = await postOrganization({ body: validBody({ clientEventId }) });
    const inventedCookie = await postOrganization({
      body: validBody({ clientEventId }),
      cookie: 'jeton-invente-sans-aucune-existence-AZ09',
    });
    // Corps illisible ET absence de session : la barrière de session est franchie AVANT toute
    // analyse, donc le verdict reste 401 et non 415. L'ordre importe : un 415 ici dirait à un
    // appelant non authentifié comment la route lit son corps.
    const wrongMediaType = await postOrganization({
      body: validBody(),
      json: false,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    // APPEL DIRECT D'UNE ROUTE MASQUÉE PAR L'INTERFACE : cas de test obligatoire de
    // `docs/permissions.md`. Aucun écran n'est interposé, il ne reste que cette barrière.
    expect(noCookie.status).toBe(401);
    expect(errorOf(noCookie).code).toBe('UNAUTHENTICATED');
    expect(errorOf(noCookie).details).toStrictEqual({});
    expect(noCookie.setCookie).toBeNull();
    // La validité d'un jeton n'est pas une information que la plateforme confirme.
    expect(Buffer.compare(inventedCookie.normalizedBytes, noCookie.normalizedBytes)).toBe(0);
    expect(wrongMediaType.status).toBe(401);
    // Rien n'a été réservé : la clé reste libre pour l'appelant légitime.
    expect(await countIdempotencyKeys(database.owner, clientEventId)).toBe(0);
  }, 60_000);

  it('énumère TOUTES les fautes du corps en une seule réponse, sans renvoyer aucune valeur reçue', async (context) => {
    const database = databaseOrSkip(setup, context);
    const actor = await createActor(database.owner, 'validation');

    const empty = await postOrganization({ cookie: actor.cookie, body: {} });

    // Un formulaire qui ne signale qu'un champ à la fois se corrige en autant d'allers-retours
    // qu'il compte d'erreurs.
    expect(empty.status).toBe(400);
    expect(errorOf(empty).code).toBe('VALIDATION_ERROR');
    expect(detailsOf(empty).fields).toStrictEqual([
      'clientEventId',
      'name',
      'registrationNumber',
      'type',
    ]);

    const cases: readonly (readonly [string, Record<string, unknown>, readonly string[]])[] = [
      ['nom réduit à un caractère une fois rogné', validBody({ name: ' a ' }), ['name']],
      ['nom au-delà de 160 caractères', validBody({ name: 'a'.repeat(161) }), ['name']],
      ['nom qui n est pas une chaîne', validBody({ name: 42 }), ['name']],
      ['type en minuscules', validBody({ type: 'farm' }), ['type']],
      ['type hors référentiel', validBody({ type: 'OTHER' }), ['type']],
      // « 12-3 » a quatre caractères bruts et trois normalisés : il passe la borne visible et
      // échoue sur l'invisible, celle que la colonne générée porte.
      [
        'numéro trop court une fois les séparateurs retirés',
        validBody({ registrationNumber: '12-3' }),
        ['registrationNumber'],
      ],
      [
        'numéro portant un caractère hors classe',
        validBody({ registrationNumber: 'ABC_123' }),
        ['registrationNumber'],
      ],
      ['code territorial en minuscules', validBody({ territoryCode: 'zz-01' }), ['territoryCode']],
      [
        'code territorial commençant par un tiret',
        validBody({ territoryCode: '-ZZ01' }),
        ['territoryCode'],
      ],
      [
        'clé de commande qui n est pas un UUID',
        validBody({ clientEventId: 'pas-un-uuid' }),
        ['clientEventId'],
      ],
      [
        'deux fautes à la fois, rendues ensemble',
        validBody({ type: 'farm', territoryCode: 'zz-01' }),
        ['territoryCode', 'type'],
      ],
    ];

    for (const [label, body, fields] of cases) {
      const response = await postOrganization({ cookie: actor.cookie, body });
      expect(response.status, label).toBe(400);
      expect(errorOf(response).code, label).toBe('VALIDATION_ERROR');
      expect(detailsOf(response).fields, label).toStrictEqual(fields);

      // `details` ne porte que des noms de champs : renvoyer la valeur reçue ferait de la
      // réponse d'erreur un miroir de texte arbitraire. Les sentinelles sont celles que CE cas a
      // envoyées — la valeur fautive, mais aussi le nom, le numéro et la clé de commande qui
      // l'accompagnent —, jamais celles d'un autre cas de la boucle.
      const emitted = sentValues(body);
      // Garde-fou : si `validBody` cessait un jour de porter des valeurs textuelles, le balayage
      // deviendrait vide et passerait sans rien chercher. Trois est le plancher : deux cas ont un
      // nom inexploitable — un seul caractère, ou pas une chaîne — et n'envoient alors que le
      // type, le numéro et la clé de commande.
      expect(emitted.length, `${label} : sentinelles à chercher`).toBeGreaterThanOrEqual(3);
      // Le corps NORMALISÉ, `requestId` figé : l'identifiant de requête est un UUID aléatoire, et
      // une valeur courte comme « 12-3 » s'y retrouverait un jour par hasard. Un test qui rougit
      // une fois sur mille pour une coïncidence finit en quarantaine.
      const rendered = response.normalizedBytes.toString('utf8');
      for (const sentinel of emitted) {
        expect(rendered, `${label} : ${sentinel}`).not.toContain(sentinel);
      }
    }

    // Aucune de ces tentatives n'a rien écrit.
    expect(
      await countRows(
        database.owner,
        'select count(*)::text as count from public.organization_members where user_id = $1',
        [actor.userId],
      ),
    ).toBe(0);
  }, 90_000);

  it('REFUSE un champ inconnu plutôt que de l ignorer, et n écrit rien', async (context) => {
    const database = databaseOrSkip(setup, context);
    const actor = await createActor(database.owner, 'inconnu');

    const cases: readonly (readonly [string, Record<string, unknown>])[] = [
      ['verificationStatus', validBody({ verificationStatus: 'VERIFIED' })],
      ['status', validBody({ status: 'ACTIVE' })],
      ['version', validBody({ version: 9 })],
      ['role', validBody({ role: 'PLATFORM_ADMIN' })],
      ['id', validBody({ id: randomUUID() })],
      ['expectedVersion', validBody({ expectedVersion: 1 })],
    ];

    for (const [field, body] of cases) {
      const registrationNumber = String(body.registrationNumber);
      const clientEventId = String(body.clientEventId);
      const response = await postOrganization({ cookie: actor.cookie, body });

      // Un client qui enverrait « verificationStatus: VERIFIED » et recevrait 201 croirait avoir
      // été entendu : c'est l'usurpation d'organisation de `docs/threat-model.md` qui se
      // glisserait dans cette croyance. Le refus est la seule réponse honnête.
      expect(response.status, field).toBe(400);
      expect(errorOf(response).code, field).toBe('VALIDATION_ERROR');
      expect(detailsOf(response).fields, field).toStrictEqual([field]);
      expect(await countOrganizationsByNumber(database.owner, registrationNumber), field).toBe(0);
      expect(await countIdempotencyKeys(database.owner, clientEventId), field).toBe(0);
    }
  }, 90_000);

  it('refuse un corps qui n est pas du JSON, et un type de contenu qui n est pas le sien', async (context) => {
    const database = databaseOrSkip(setup, context);
    const actor = await createActor(database.owner, 'transport');

    const broken = await postOrganization({ cookie: actor.cookie, rawBody: '{"name":' });
    const scalar = await postOrganization({ cookie: actor.cookie, rawBody: '"une chaine"' });
    const array = await postOrganization({ cookie: actor.cookie, rawBody: '[]' });
    const wrongMediaType = await postOrganization({
      cookie: actor.cookie,
      body: validBody(),
      json: false,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    // Syntaxe JSON invalide : l'erreur est construite par `readJsonBody`, qui pose littéralement
    // « (racine) » sans passer par le collecteur de fautes.
    expect(broken.status).toBe(400);
    expect(errorOf(broken).code).toBe('VALIDATION_ERROR');
    expect(detailsOf(broken).fields).toStrictEqual(['(racine)']);

    // CONSTAT, PAS SOUHAIT. Un corps syntaxiquement valide mais qui n'est pas un objet passe par
    // `FieldCollector.reject`, dont le motif de nom sûr rejette l'étiquette « (racine) » et la
    // remplace par « (inconnu) ». Deux étiquettes coexistent donc pour des causes voisines.
    // Aucun texte du contrat n'impose l'une ou l'autre : ce test fige le comportement réel, et
    // l'écart est remonté plutôt que corrigé côté test.
    expect(scalar.status).toBe(400);
    expect(detailsOf(scalar).fields).toStrictEqual(['(inconnu)']);
    expect(array.status).toBe(400);
    expect(detailsOf(array).fields).toStrictEqual(['(inconnu)']);

    // Effet de bord voulu du type exigé : un formulaire HTML inter-site ne sait produire aucun
    // des trois types acceptés, il ne peut donc pas atteindre cette route.
    expect(wrongMediaType.status).toBe(415);
    expect(errorOf(wrongMediaType).code).toBe('UNSUPPORTED_MEDIA_TYPE');
  }, 60_000);

  it('refuse la création en mode lecture seule, SANS consommer la clé de commande', async (context) => {
    const database = databaseOrSkip(setup, context);
    const actor = await createActor(database.owner, 'lecture-seule');
    const body = validBody();
    const clientEventId = String(body.clientEventId);

    let refused: Captured;
    try {
      // `isFeatureEnabled` relit `process.env` à chaque appel, sans cache : l'interrupteur vaut
      // dès la requête suivante, ce qui est le sens d'un interrupteur d'exploitation.
      process.env.PLATFORM_READ_ONLY = 'true';
      refused = await postOrganization({ cookie: actor.cookie, body });
    } finally {
      delete process.env.PLATFORM_READ_ONLY;
    }

    expect(refused.status).toBe(503);
    expect(errorOf(refused).code).toBe('PLATFORM_READ_ONLY');
    expect(await countOrganizationsByNumber(database.owner, String(body.registrationNumber))).toBe(
      0,
    );
    // La garde est posée AVANT la réservation : la clé reste libre, et la reprise après incident
    // aboutit au lieu de tomber sur un conflit d'idempotence dû au refus lui-même.
    expect(await countIdempotencyKeys(database.owner, clientEventId)).toBe(0);

    const retried = await postOrganization({ cookie: actor.cookie, body });
    expect(retried.status).toBe(201);
  }, 60_000);
});

/**
 * ENVELOPPE DE TRANSPORT — pourquoi ces trois épreuves existent alors qu'elles semblent faire
 * double emploi avec `auth-routes.test.ts`.
 *
 * `defineOrganizationRoute` est aujourd'hui, littéralement, `defineAuthenticatedRoute` : une
 * affectation d'une ligne. Trois rédacteurs successifs ont écarté le contrôle d'origine et la
 * limite de corps sur cette route en s'appuyant sur cette identité. L'argument est exact et il
 * n'est tenu par rien : l'en-tête de `organization-route.ts` réclame lui-même le déplacement du
 * module partagé vers `app/api/v1/_shared/`, et l'auteur de ce déplacement peut réécrire
 * l'enveloppe en conservant `requireSessionFromRequest` — dont l'absence rougirait aussitôt —
 * et en perdant `assertTrustedOrigin`, dont l'absence, elle, ne rougissait nulle part. Une page
 * hostile pourrait alors, depuis le navigateur d'une victime connectée, déclarer une
 * organisation en son nom.
 *
 * Les deux niveaux sont donc éprouvés : l'identité des enveloppes, qui dit que la mutualisation
 * tient, et le COMPORTEMENT sur cette route précise, qui vaudra encore le jour où l'identité
 * cessera légitimement de tenir.
 */
describe('enveloppe de transport de la création', () => {
  it('pose LITTÉRALEMENT l enveloppe des routes authentifiées', () => {
    // Cette ligne n'a pas besoin de base : elle reste évaluée même quand PostgreSQL manque, là
    // où les autres tests de ce fichier sautent.
    expect(defineOrganizationRoute).toBe(defineAuthenticatedRoute);
  });

  it('refuse une origine étrangère, sans regarder la session ni rien écrire', async (context) => {
    const database = databaseOrSkip(setup, context);
    const actor = await createActor(database.owner, 'origine');
    const body = validBody({ name: 'Coopérative de la Serre Bleue' });
    const registrationNumber = String(body.registrationNumber);
    const clientEventId = String(body.clientEventId);

    const foreign = await postOrganization({
      cookie: actor.cookie,
      body,
      headers: { origin: 'https://site-attaquant.exemple' },
    });
    // `Origin: null` — cadre isolé, document `data:` — ne s'analyse pas en URL et tombe en refus.
    const nullOrigin = await postOrganization({
      cookie: actor.cookie,
      body,
      headers: { origin: 'null' },
    });
    // Sans `Origin` — navigateur ancien, soumission de formulaire — `Sec-Fetch-Site` prend le
    // relais : tout ce qui n'est ni `same-origin` ni `none` est refusé.
    const crossSite = await postOrganization({
      cookie: actor.cookie,
      body,
      noOrigin: true,
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    // MÊME REFUS SANS SESSION : le contrôle d'origine précède la barrière de session, donc une
    // page hostile n'apprend pas au passage si la victime est connectée. Un 401 ici serait un
    // oracle de session offert à n'importe quel site.
    const withoutSession = await postOrganization({
      body,
      headers: { origin: 'https://site-attaquant.exemple' },
    });

    for (const [label, refused] of [
      ['origine étrangère', foreign],
      ['origine opaque', nullOrigin],
      ['navigation inter-site', crossSite],
      ['origine étrangère sans session', withoutSession],
    ] as const) {
      expect(refused.status, label).toBe(403);
      expect(errorOf(refused).code, label).toBe('FORBIDDEN');
      expect(errorOf(refused).details, label).toStrictEqual({});
      expect(refused.setCookie, label).toBeNull();
    }

    // La falsification de requête inter-site n'est pas seulement refusée : elle n'écrit rien,
    // clé de commande comprise. Une réservation consommée par un tiers empêcherait l'appelant
    // légitime de rejouer sa propre intention.
    expect(await countOrganizationsByNumber(database.owner, registrationNumber)).toBe(0);
    expect(await countIdempotencyKeys(database.owner, clientEventId)).toBe(0);

    // TÉMOIN POSITIF, sans lequel les quatre refus ci-dessus pourraient venir d'ailleurs — un
    // corps mal formé, une session expirée : MÊME corps, MÊME session, seule l'origine change.
    const accepted = await postOrganization({ cookie: actor.cookie, body });
    expect(accepted.status).toBe(201);
    expect(await countOrganizationsByNumber(database.owner, registrationNumber)).toBe(1);

    // SECOND TÉMOIN, sur la branche `Sec-Fetch-Site` : une enveloppe qui refuserait dès que
    // l'en-tête est présent passerait le cas `cross-site` ci-dessus sans rien protéger de plus,
    // et fermerait la route aux navigations légitimes.
    const sameSite = await postOrganization({
      cookie: actor.cookie,
      body: validBody({ name: 'Coopérative de la Serre Verte' }),
      noOrigin: true,
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(sameSite.status).toBe(201);
  }, 90_000);

  it('refuse un corps au-delà de 2048 octets, sans le lire, et pas un octet en deçà', async (context) => {
    const database = databaseOrSkip(setup, context);
    const actor = await createActor(database.owner, 'gabarit');
    const measured = validBody();
    const oversized = validBody();
    const atLimit = padToExactSize(measured, MAX_BODY_BYTES);
    const overLimit = padToExactSize(oversized, MAX_BODY_BYTES + 1);

    // La mesure est vérifiée avant de servir d'oracle : un test de frontière qui se trompe d'un
    // octet éprouve une frontière voisine, et le dit quand même avec assurance.
    expect(Buffer.byteLength(atLimit, 'utf8')).toBe(MAX_BODY_BYTES);
    expect(Buffer.byteLength(overLimit, 'utf8')).toBe(MAX_BODY_BYTES + 1);

    // Taille ANNONCÉE : la requête est construite à la main pour que son corps reste observable
    // après l'appel.
    const declaring = buildRequest({
      path: ORGANIZATIONS_PATH,
      method: 'POST',
      cookie: actor.cookie,
      rawBody: overLimit,
      headers: { 'content-length': String(Buffer.byteLength(overLimit, 'utf8')) },
    });
    const declared = await capture(await createOrganizationRoute(declaring));
    // Taille NON annoncée : la mesure se fait alors sur le flux, borne comprise.
    const streamed = await postOrganization({ cookie: actor.cookie, rawBody: overLimit });
    // Et sans session : le plafond est posé AVANT toute barrière, sinon un appelant non
    // authentifié imposerait au serveur la mémoire qu'il veut — le déni de service à coût nul de
    // `docs/threat-model.md`.
    const anonymous = await postOrganization({ rawBody: overLimit });

    for (const [label, refused] of [
      ['taille annoncée', declared],
      ['taille non annoncée', streamed],
      ['sans session', anonymous],
    ] as const) {
      expect(refused.status, label).toBe(413);
      expect(errorOf(refused).code, label).toBe('PAYLOAD_TOO_LARGE');
      // La limite est DITE, et non laissée à deviner par dichotomie : c'est ce qui permet à un
      // client de savoir qu'il doit découper sa saisie plutôt que de réessayer à l'identique.
      expect(errorOf(refused).details, label).toStrictEqual({ maxBodyBytes: MAX_BODY_BYTES });
      // Le contenu refusé ne ressort pas, fût-ce en écho de diagnostic.
      expect(refused.text, label).not.toContain('AAAA');
    }
    // LE CORPS N'A MÊME PAS ÉTÉ LU : le refus précède l'analyse. C'est ce qui en fait une
    // protection contre l'épuisement de mémoire et non une simple règle de validation.
    expect(declaring.bodyUsed).toBe(false);

    // UN OCTET DE MOINS ET LA ROUTE REGARDE LE CORPS. Sans ce cas, la borne éprouvée ne serait
    // pas 2 048 mais « quelque part au-dessous ». Le nom fait alors près de deux mille
    // caractères, donc le verdict est un refus de validation — piège à connaître : une saisie de
    // nom démesurée rend 400 tant qu'elle tient dans le plafond, et 413 au-delà.
    const accepted = await postOrganization({ cookie: actor.cookie, rawBody: atLimit });
    expect(accepted.status).toBe(400);
    expect(errorOf(accepted).code).toBe('VALIDATION_ERROR');
    expect(detailsOf(accepted).fields).toStrictEqual(['name']);

    // Aucun des quatre appels n'a écrit quoi que ce soit.
    for (const [label, attempted] of [
      ['corps à la limite', measured],
      ['corps au-delà', oversized],
    ] as const) {
      expect(
        await countOrganizationsByNumber(database.owner, String(attempted.registrationNumber)),
        label,
      ).toBe(0);
      expect(
        await countIdempotencyKeys(database.owner, String(attempted.clientEventId)),
        label,
      ).toBe(0);
    }
  }, 90_000);
});

describe('idempotence de la création', () => {
  it('rejoue la réponse initiale À L IDENTIQUE et ne crée pas de seconde organisation', async (context) => {
    const database = databaseOrSkip(setup, context);
    const actor = await createActor(database.owner, 'rejeu');
    const body = validBody({ territoryCode: 'ZZ-DEMO-02' });
    const clientEventId = String(body.clientEventId);

    const first = await postOrganization({ cookie: actor.cookie, body });
    const replay = await postOrganization({ cookie: actor.cookie, body });

    // « Un rejeu portant le même clientEventId renvoie la réponse initiale à l'identique, statut
    // 201 compris. Le client qui a perdu la première réponse n'a pas à distinguer deux cas. »
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(Buffer.compare(replay.normalizedBytes, first.normalizedBytes)).toBe(0);
    expect(comparableHeaders(replay)).toStrictEqual(comparableHeaders(first));

    const organizationId = String(organizationOf(first).id);
    // LA PREUVE N'EST PAS LE NOMBRE DE SUCCÈS, C'EST LE NOMBRE DE LIGNES. Deux réponses 201
    // identiques seraient également rendues par une implémentation qui aurait créé deux
    // organisations jumelles et renvoyé la seconde.
    expect(await readEffects(database.owner, organizationId)).toStrictEqual({
      organizations: 1,
      members: 1,
      auditLines: 2,
      outboxMessages: 1,
    });
    expect(await countOrganizationsByNumber(database.owner, String(body.registrationNumber))).toBe(
      1,
    );
    expect(await countIdempotencyKeys(database.owner, clientEventId)).toBe(1);

    const { rows } = await database.owner.query<{
      readonly operation: string;
      readonly actor_user_id: string | null;
      readonly target_type: string | null;
      readonly target_id: string | null;
      readonly request_fingerprint: string;
      readonly result: Record<string, unknown>;
      readonly ligne: string;
    }>(
      `select operation, actor_user_id, target_type, target_id, request_fingerprint, result,
              to_jsonb(k)::text as ligne
         from public.idempotency_keys k where client_event_id = $1`,
      [clientEventId],
    );
    const record = rows[0];
    expect(record?.operation).toBe('ORGANIZATION_CREATE');
    expect(record?.actor_user_id).toBe(actor.userId);
    expect(record?.target_type).toBe('ORGANIZATION');
    expect(record?.target_id).toBe(organizationId);
    // L'empreinte reste un condensé : le corps n'est JAMAIS stocké, sans quoi le registre
    // deviendrait un second entrepôt du nom et du numéro, avec sa propre fuite possible.
    expect(record?.request_fingerprint).toMatch(HEX_DIGEST_PATTERN);
    expect(record?.result).toStrictEqual({ organizationId, version: 1 });
    expect(record?.ligne).not.toContain(String(body.name));
    expect(record?.ligne).not.toContain(String(body.registrationNumber));
    expect(record?.ligne).not.toContain('ZZ-DEMO-02');
  }, 90_000);

  it('rejoue malgré les espaces de bordure et les trois écritures du territoire absent', async (context) => {
    const database = databaseOrSkip(setup, context);
    const actor = await createActor(database.owner, 'canonique');
    const registrationNumber = nextRegistrationNumber();
    const clientEventId = randomUUID();

    const first = await postOrganization({
      cookie: actor.cookie,
      body: { name: 'Ferme Ducloux', type: 'FARM', registrationNumber, clientEventId },
    });
    // Mêmes valeurs CANONIQUES : la validation rogne, et l'empreinte porte sur ce qui sort de la
    // validation. Comparer avant normalisation produirait un conflit là où il n'y a qu'une
    // reprise — le cas exact du client qui recompose son corps après une coupure.
    const spaced = await postOrganization({
      cookie: actor.cookie,
      body: {
        name: '  Ferme Ducloux  ',
        type: 'FARM',
        registrationNumber: `  ${registrationNumber}  `,
        clientEventId,
      },
    });
    // Absent, `null` et chaîne vide disent tous trois « aucun périmètre déclaré ».
    const explicitNull = await postOrganization({
      cookie: actor.cookie,
      body: {
        name: 'Ferme Ducloux',
        type: 'FARM',
        registrationNumber,
        territoryCode: null,
        clientEventId,
      },
    });
    const emptyTerritory = await postOrganization({
      cookie: actor.cookie,
      body: {
        name: 'Ferme Ducloux',
        type: 'FARM',
        registrationNumber,
        territoryCode: '',
        clientEventId,
      },
    });

    for (const [label, replay] of [
      ['espaces de bordure', spaced],
      ['territoire à null', explicitNull],
      ['territoire vide', emptyTerritory],
    ] as const) {
      expect(replay.status, label).toBe(201);
      expect(Buffer.compare(replay.normalizedBytes, first.normalizedBytes), label).toBe(0);
    }
    expect(await countOrganizationsByNumber(database.owner, registrationNumber)).toBe(1);
    expect(await countIdempotencyKeys(database.owner, clientEventId)).toBe(1);
  }, 90_000);

  it('refuse la MÊME clé présentée avec un corps différent, sans nouvel effet', async (context) => {
    const database = databaseOrSkip(setup, context);
    const actor = await createActor(database.owner, 'conflit');
    const body = validBody({ territoryCode: 'ZZ-DEMO-02' });
    const clientEventId = String(body.clientEventId);

    const first = await postOrganization({ cookie: actor.cookie, body });
    expect(first.status).toBe(201);
    const organizationId = String(organizationOf(first).id);

    const cases: readonly (readonly [string, Record<string, unknown>])[] = [
      ['un autre nom', { ...body, name: 'Exploitation agricole Ducloux' }],
      ['un autre type', { ...body, type: 'ASSOCIATION' }],
      ['un autre numéro', { ...body, registrationNumber: nextRegistrationNumber() }],
      ['un autre territoire', { ...body, territoryCode: 'ZZ-DEMO-03' }],
      ['un territoire retiré', { ...body, territoryCode: null }],
    ];

    for (const [label, other] of cases) {
      const response = await postOrganization({ cookie: actor.cookie, body: other });

      // Rejouer la première réponse serait pire que refuser : l'appelant croirait sa seconde
      // demande satisfaite alors qu'elle n'a rien produit.
      expect(response.status, label).toBe(409);
      expect(errorOf(response).code, label).toBe('IDEMPOTENCY_CONFLICT');
      expect(errorOf(response).details, label).toStrictEqual({});
      // Le refus ne rend pas non plus la première organisation par la bande.
      expect(response.text, label).not.toContain(organizationId);
    }

    expect(await readEffects(database.owner, organizationId)).toStrictEqual({
      organizations: 1,
      members: 1,
      auditLines: 2,
      outboxMessages: 1,
    });
    expect(await countIdempotencyKeys(database.owner, clientEventId)).toBe(1);
  }, 90_000);

  it('refuse la même clé présentée par un AUTRE acteur, sans rien lui livrer d autrui', async (context) => {
    const database = databaseOrSkip(setup, context);
    const owner = await createActor(database.owner, 'proprietaire');
    const stranger = await createActor(database.owner, 'tiers');
    const body = validBody({ name: 'Coopérative des Trois Vallées', territoryCode: 'ZZ-DEMO-04' });
    const clientEventId = String(body.clientEventId);

    const created = await postOrganization({ cookie: owner.cookie, body });
    expect(created.status).toBe(201);
    const organizationId = String(organizationOf(created).id);

    const stolen = await postOrganization({ cookie: stranger.cookie, body });

    // La portée de `client_event_id` étant globale, un tiers peut présenter une clé déjà
    // employée. L'acteur entrant dans l'empreinte, il reçoit un conflit et non l'organisation du
    // premier : sans lui, cette route rendrait la fiche d'un tiers à qui devine son UUID.
    expect(stolen.status).toBe(409);
    expect(errorOf(stolen).code).toBe('IDEMPOTENCY_CONFLICT');
    expect(errorOf(stolen).details).toStrictEqual({});
    expect(stolen.text).not.toContain(organizationId);
    expect(stolen.text).not.toContain('Coopérative des Trois Vallées');
    expect(stolen.text).not.toContain(String(body.registrationNumber));
    expect(stolen.text).not.toContain('ZZ-DEMO-04');
    expect(stolen.text).not.toContain(owner.displayName);
    expect(stolen.text).not.toContain(owner.userId);

    // Et le tiers n'a acquis aucune adhésion au passage.
    expect(
      await countRows(
        database.owner,
        'select count(*)::text as count from public.organization_members where user_id = $1',
        [stranger.userId],
      ),
    ).toBe(0);
    expect(await countIdempotencyKeys(database.owner, clientEventId)).toBe(1);
  }, 90_000);

  it('LIBÈRE la clé quand la mutation échoue, de sorte qu une reprise corrigée aboutisse', async (context) => {
    const database = databaseOrSkip(setup, context);
    const actor = await createActor(database.owner, 'liberation');
    const taken = nextRegistrationNumber();

    const held = await postOrganization({
      cookie: actor.cookie,
      body: validBody({ registrationNumber: taken }),
    });
    expect(held.status).toBe(201);

    const clientEventId = randomUUID();
    const refused = await postOrganization({
      cookie: actor.cookie,
      body: validBody({ registrationNumber: taken, clientEventId }),
    });

    expect(refused.status).toBe(400);
    expect(errorOf(refused).code).toBe('VALIDATION_ERROR');
    expect(detailsOf(refused).fields).toStrictEqual(['registrationNumber']);
    // LA CLÉ EST LIBRE APRÈS UN ÉCHEC, et cela se lit dans la table : la commande n'a produit
    // aucun effet, elle n'a donc pas « déjà été exécutée ». La réservation est annulée avec la
    // transaction, sans quoi une faute de saisie condamnerait définitivement la clé du client.
    expect(await countIdempotencyKeys(database.owner, clientEventId)).toBe(0);

    const corrected = nextRegistrationNumber();
    const retried = await postOrganization({
      cookie: actor.cookie,
      body: validBody({ registrationNumber: corrected, clientEventId }),
    });

    expect(retried.status).toBe(201);
    expect(organizationOf(retried).registrationNumber).toBe(corrected);
    expect(await countOrganizationsByNumber(database.owner, corrected)).toBe(1);
    expect(await countIdempotencyKeys(database.owner, clientEventId)).toBe(1);
  }, 90_000);
});

describe('concurrence de la création', () => {
  it('sérialise DEUX transactions concurrentes sur la même clé de commande', async (context) => {
    const database = databaseOrSkip(setup, context);
    const first = await database.connect();
    const second = await database.connect();
    const clientEventId = randomUUID();
    const actorUserId = randomUUID();
    const requestFingerprint = computeRequestFingerprint({
      operation: ORGANIZATION_CREATE_OPERATION,
      actorUserId,
      fields: ['Ferme témoin', 'FARM', 'FICTIF-ORG-TEMOIN', null],
    });
    const reservation = {
      clientEventId,
      operation: ORGANIZATION_CREATE_OPERATION,
      actorUserId,
      requestFingerprint,
    } as const;

    try {
      await first.query('begin');
      await second.query('begin');

      const held = await reserveIdempotencyKey(first, reservation);
      expect(held.kind).toBe('RESERVED');

      // La seconde réservation est lancée SANS être attendue : elle chevauche réellement la
      // première. C'est la propriété qui fait toute la valeur de `ON CONFLICT DO NOTHING` — il
      // ATTEND la transaction concurrente au lieu de trancher à l'aveugle. Un `SELECT` suivi
      // d'un `INSERT` ne bloquerait pas ici, et produirait deux organisations jumelles.
      let settled = false;
      const racing = reserveIdempotencyKey(second, reservation)
        .then((outcome) => {
          settled = true;
          return outcome;
        })
        .catch((error: unknown) => {
          settled = true;
          throw error;
        });
      racing.catch(() => undefined);

      await delay(BLOCKING_OBSERVATION_MS);
      expect(settled).toBe(false);

      await first.query('commit');

      const outcome = await racing;
      // Le perdant relit et retrouve la ligne validée du gagnant, avec la même empreinte : c'est
      // le chemin du rejeu, pas celui d'un second effet.
      expect(outcome.kind).toBe('ALREADY_RESERVED');
      if (outcome.kind === 'ALREADY_RESERVED') {
        expect(outcome.existing.clientEventId).toBe(clientEventId);
        expect(outcome.existing.requestFingerprint).toBe(requestFingerprint);
      }
      await second.query('rollback');
    } finally {
      // La première d'abord : elle détient le verrou, et le libérer débloque la seconde.
      await first.query('rollback').catch(() => undefined);
      await second.query('rollback').catch(() => undefined);
    }

    expect(await countIdempotencyKeys(database.owner, clientEventId)).toBe(1);
  }, 60_000);

  it('ne crée QU UNE organisation pour quatre appels simultanés portant la même clé', async (context) => {
    const database = databaseOrSkip(setup, context);
    const actor = await createActor(database.owner, 'course-cle');
    const rounds = 4;
    const parallel = 4;

    for (let round = 0; round < rounds; round += 1) {
      const body = validBody({ name: `Ferme simultanée ${round}` });
      const clientEventId = String(body.clientEventId);

      // Les appels sont lancés sans être attendus l'un après l'autre : ils se chevauchent
      // réellement. Le tour est répété pour que le verdict ne tienne pas à un ordonnancement
      // heureux.
      const responses = await Promise.all(
        Array.from({ length: parallel }, () => postOrganization({ cookie: actor.cookie, body })),
      );

      const reference = responses[0];
      if (reference === undefined) {
        throw new Error('aucune réponse capturée');
      }
      for (const response of responses) {
        expect(response.status, `tour ${round}`).toBe(201);
        expect(
          Buffer.compare(response.normalizedBytes, reference.normalizedBytes),
          `tour ${round} : réponses cohérentes`,
        ).toBe(0);
      }

      const organizationId = String(organizationOf(reference).id);
      expect(await readEffects(database.owner, organizationId), `tour ${round}`).toStrictEqual({
        organizations: 1,
        members: 1,
        auditLines: 2,
        outboxMessages: 1,
      });
      expect(
        await countOrganizationsByNumber(database.owner, String(body.registrationNumber)),
        `tour ${round}`,
      ).toBe(1);
      expect(await countIdempotencyKeys(database.owner, clientEventId), `tour ${round}`).toBe(1);
    }
  }, 120_000);

  it('n en laisse passer QU UNE quand trois appels simultanés portent le même numéro', async (context) => {
    const database = databaseOrSkip(setup, context);
    const actor = await createActor(database.owner, 'course-numero');
    const rounds = 3;

    for (let round = 0; round < rounds; round += 1) {
      const core = nextRegistrationCore();
      const attempts = registrationVariants(core).map((registrationNumber) => ({
        registrationNumber,
        clientEventId: randomUUID(),
      }));

      // Clés de commande DISTINCTES : rien à voir avec un rejeu. Trois intentions différentes
      // revendiquent la même immatriculation au même instant, et c'est l'index unique — jamais
      // une lecture préalable — qui tranche.
      const responses = await Promise.all(
        attempts.map((attempt) =>
          postOrganization({
            cookie: actor.cookie,
            body: {
              name: `Ferme concurrente ${round}`,
              type: 'FARM',
              registrationNumber: attempt.registrationNumber,
              clientEventId: attempt.clientEventId,
            },
          }),
        ),
      );

      const accepted = responses.filter((response) => response.status === 201);
      const rejected = responses.filter((response) => response.status !== 201);
      expect(accepted, `tour ${round} : une seule création`).toHaveLength(1);
      for (const response of rejected) {
        expect(response.status, `tour ${round}`).toBe(400);
        expect(errorOf(response).code, `tour ${round}`).toBe('VALIDATION_ERROR');
        expect(detailsOf(response).fields, `tour ${round}`).toStrictEqual(['registrationNumber']);
      }
      expect(
        await countOrganizationsByNumber(database.owner, `FICTIF-ORG-${core}`),
        `tour ${round}`,
      ).toBe(1);

      // Le perdant n'a rien laissé derrière lui, réservation d'idempotence comprise.
      const survivor = accepted[0];
      if (survivor === undefined) {
        throw new Error(`aucune création acceptée au tour ${round}`);
      }
      const winner = String(organizationOf(survivor).id);
      let reserved = 0;
      for (const attempt of attempts) {
        reserved += await countIdempotencyKeys(database.owner, attempt.clientEventId);
      }
      expect(reserved, `tour ${round} : une seule réservation subsiste`).toBe(1);
      expect(await readEffects(database.owner, winner), `tour ${round}`).toStrictEqual({
        organizations: 1,
        members: 1,
        auditLines: 2,
        outboxMessages: 1,
      });
    }
  }, 120_000);
});

describe('doublon d immatriculation', () => {
  it('reconnaît comme doublon deux écritures différentes du même numéro', async (context) => {
    const database = databaseOrSkip(setup, context);
    const actor = await createActor(database.owner, 'doublon');
    const core = nextRegistrationCore();
    const [canonical, spaced, dotted] = registrationVariants(core);

    const created = await postOrganization({
      cookie: actor.cookie,
      body: validBody({ registrationNumber: canonical }),
    });
    expect(created.status).toBe(201);

    for (const [label, written] of [
      ['séparateurs et casse différents', spaced],
      ['points au lieu des tirets', dotted],
      ['sans aucun séparateur', `FICTIFORG${core}`],
    ] as const) {
      const response = await postOrganization({
        cookie: actor.cookie,
        body: validBody({ registrationNumber: written }),
      });

      // « 123 456 789 00012 », « 123-456-789 00012 » et « 12345678900012 » désignent la même
      // structure. La normalisation est faite par la colonne générée, jamais par l'appelant :
      // deux chemins d'écriture normaliseraient tôt ou tard différemment.
      expect(response.status, label).toBe(400);
      expect(errorOf(response).code, label).toBe('VALIDATION_ERROR');
      expect(detailsOf(response).fields, label).toStrictEqual(['registrationNumber']);
    }

    expect(await countOrganizationsByNumber(database.owner, canonical)).toBe(1);
  }, 90_000);

  it('ne laisse pas ENUMERER les immatriculations déjà enregistrées', async (context) => {
    const database = databaseOrSkip(setup, context);
    const holder = await createActor(database.owner, 'detenteur');
    const prospector = await createActor(database.owner, 'prospecteur');
    const taken = nextRegistrationNumber();

    const created = await postOrganization({
      cookie: holder.cookie,
      body: validBody({
        name: 'Service technique de Val-Fictif',
        type: 'OPERATIONAL_SERVICE',
        registrationNumber: taken,
        territoryCode: 'ZZ-DEMO-09',
      }),
    });
    expect(created.status).toBe(201);
    const organizationId = String(organizationOf(created).id);

    // Le scénario est celui d'un tiers qui cherche à dresser la liste des structures inscrites
    // en essayant des numéros. Ce qu'il obtient sur un numéro DÉJÀ PRIS doit être indiscernable
    // de ce qu'il obtient sur un numéro que le schéma refuse de toute façon : sinon la route
    // devient un oracle, et l'énumération prépare l'usurpation d'organisation de
    // `docs/threat-model.md`.
    const onTaken = await postOrganization({
      cookie: prospector.cookie,
      body: validBody({ registrationNumber: taken }),
    });
    const onMalformed = await postOrganization({
      cookie: prospector.cookie,
      body: validBody({ registrationNumber: '12-3' }),
    });
    // Et le détenteur lui-même n'apprend rien de plus : la réponse ne dit pas « ce numéro est à
    // vous », ce qui ferait de la route un moyen de tester l'appartenance d'un numéro.
    const onOwn = await postOrganization({
      cookie: holder.cookie,
      body: validBody({ registrationNumber: taken }),
    });

    // Les deux réponses sont d'abord constatées non vides et porteuses du même verdict : sans
    // cela, la comparaison d'octets qui suit pourrait être satisfaite par deux corps vides.
    expect(onTaken.status).toBe(400);
    expect(onMalformed.status).toBe(400);
    expect(errorOf(onTaken).code).toBe('VALIDATION_ERROR');
    expect(errorOf(onMalformed).code).toBe('VALIDATION_ERROR');
    expect(detailsOf(onTaken).fields).toStrictEqual(['registrationNumber']);
    expect(Buffer.compare(onTaken.normalizedBytes, onMalformed.normalizedBytes)).toBe(0);
    expect(comparableHeaders(onTaken)).toStrictEqual(comparableHeaders(onMalformed));
    expect(Buffer.compare(onOwn.normalizedBytes, onTaken.normalizedBytes)).toBe(0);

    // Rien de la structure en face ne transparaît : ni son existence nommée, ni son identifiant,
    // ni son périmètre, ni qui l'a déclarée.
    for (const sentinel of [
      organizationId,
      'Service technique de Val-Fictif',
      'ZZ-DEMO-09',
      holder.displayName,
      holder.userId,
      holder.email,
    ]) {
      expect(onTaken.text, sentinel).not.toContain(sentinel);
    }

    // Le prospecteur repart sans adhésion ni organisation.
    expect(
      await countRows(
        database.owner,
        'select count(*)::text as count from public.organization_members where user_id = $1',
        [prospector.userId],
      ),
    ).toBe(0);
  }, 90_000);

  it('oppose l unicité à une organisation REFUSÉE, CLOSE ou SUSPENDUE', async (context) => {
    const database = databaseOrSkip(setup, context);
    const actor = await createActor(database.owner, 'contournement');

    /**
     * Ces trois états ne sont atteignables par AUCUNE route de cette story : la décision de
     * vérification appartient à US-013 et la fermeture n'a pas encore d'écran. Ils sont donc
     * posés en SQL direct, seule façon d'éprouver dès maintenant une règle que le contrat pose
     * dès maintenant. Le scénario que cette règle ferme est écrit noir sur blanc dans
     * `docs/api-contract.md` : « la restreindre aux organisations actives permettrait de
     * redéclarer une immatriculation déjà refusée, donc de contourner la décision d'un
     * administrateur en une seconde déclaration ».
     */
    const hidden = [
      {
        label: 'refusée par un administrateur plateforme',
        verificationStatus: 'REJECTED',
        status: 'ACTIVE',
        core: nextRegistrationCore(),
      },
      {
        label: 'close',
        verificationStatus: 'PENDING',
        status: 'CLOSED',
        core: nextRegistrationCore(),
      },
      {
        label: 'suspendue',
        verificationStatus: 'VERIFIED',
        status: 'SUSPENDED',
        core: nextRegistrationCore(),
      },
    ] as const;

    for (const holder of hidden) {
      await database.owner.query(
        `insert into public.organizations
           (name, type, registration_number, verification_status, status)
         values ($1, 'ASSOCIATION', $2, $3, $4)`,
        [
          `Structure ${holder.label}`,
          `FICTIF-ORG-${holder.core}`,
          holder.verificationStatus,
          holder.status,
        ],
      );
    }

    // Refus de FORME, servant de référence de neutralité : « 12-3 » n'est détenu par personne et
    // ne le sera jamais, la contrainte de longueur normalisée l'interdit.
    const onMalformed = await postOrganization({
      cookie: actor.cookie,
      body: validBody({ registrationNumber: '12-3' }),
    });
    expect(onMalformed.status).toBe(400);

    for (const holder of hidden) {
      // Écriture DIFFÉRENTE du même numéro : la normalisation vaut aussi contre une organisation
      // qui n'apparaît dans aucune liste, sans quoi il suffirait de changer les séparateurs.
      const [, spaced, dotted] = registrationVariants(holder.core);
      for (const [form, written] of [
        ['espaces et minuscules', spaced],
        ['points', dotted],
      ] as const) {
        const response = await postOrganization({
          cookie: actor.cookie,
          body: validBody({ registrationNumber: written }),
        });
        const label = `${holder.label}, ${form}`;

        expect(response.status, label).toBe(400);
        expect(errorOf(response).code, label).toBe('VALIDATION_ERROR');
        expect(detailsOf(response).fields, label).toStrictEqual(['registrationNumber']);
        // Et le refus reste indiscernable d'un refus de forme : l'appelant n'apprend pas qu'une
        // organisation refusée porte ce numéro, ce qui reviendrait à publier la liste des
        // décisions défavorables à qui essaie des numéros.
        expect(Buffer.compare(response.normalizedBytes, onMalformed.normalizedBytes), label).toBe(
          0,
        );
      }

      // La ligne détenue n'a pas bougé, et aucune jumelle n'est apparue à côté d'elle.
      expect(
        await countOrganizationsByNumber(database.owner, `FICTIF-ORG-${holder.core}`),
        holder.label,
      ).toBe(1);
    }

    // Personne n'a rien obtenu au passage.
    expect(
      await countRows(
        database.owner,
        'select count(*)::text as count from public.organization_members where user_id = $1',
        [actor.userId],
      ),
    ).toBe(0);

    /**
     * DOUBLURE DE LA RÈGLE, LÀ OÙ ELLE EST RÉELLEMENT PORTÉE.
     *
     * Les six refus ci-dessus resteraient verts si quelqu'un « allégeait » l'index en le
     * restreignant aux lignes non refusées ET rattrapait le cas par un contrôle applicatif : le
     * contournement rouvrirait alors sur tout autre chemin d'écriture — reprise de données,
     * console d'exploitation, commande d'administration —, dont aucun ne passe par la route. Ce
     * qui doit être figé est donc la définition en base, et la propriété exacte est l'absence de
     * prédicat : un index partiel n'arbitre pas les lignes qu'il exclut.
     */
    const { rows } = await database.owner.query<{
      readonly name: string;
      readonly partial: boolean;
      readonly unique_index: boolean;
      readonly columns: readonly string[];
      readonly indexdef: string;
    }>(
      `select c.relname as name,
              x.indpred is not null as partial,
              x.indisunique as unique_index,
              -- La conversion en texte n'est pas cosmétique : attname est du type name, dont le
              -- pilote rend les tableaux sous leur forme littérale, « {a,b} », faute de savoir
              -- les analyser. La comparaison porterait alors sur une chaîne, pas sur des colonnes.
              (select array_agg(a.attname::text order by a.attnum)
                 from pg_attribute a
                where a.attrelid = x.indrelid and a.attnum = any(x.indkey)) as columns,
              pg_get_indexdef(x.indexrelid) as indexdef
         from pg_index x
         join pg_class c on c.oid = x.indexrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any($1::text[])
        order by c.relname`,
      [['idx_organizations_verification_status', 'uq_organizations_registration_number']],
    );
    // Les deux index existent : sans cette ligne, un index disparu se lirait comme un index sans
    // prédicat, et l'absence de la contrainte passerait pour son respect.
    expect(rows).toHaveLength(2);
    const indexes = new Map(rows.map((row) => [row.name, row]));

    const uniqueness = indexes.get('uq_organizations_registration_number');
    expect(uniqueness?.unique_index).toBe(true);
    expect(uniqueness?.columns).toStrictEqual(['registration_number_normalized']);
    expect(uniqueness?.partial).toBe(false);
    expect(uniqueness?.indexdef).not.toContain('WHERE');

    // TÉMOIN, sans lequel l'assertion précédente serait muette : la même requête voit bien un
    // prédicat là où il y en a un. Un `partial` toujours faux — colonne mal calculée, jointure
    // vide, index absent — passerait sinon pour une bonne nouvelle.
    const queue = indexes.get('idx_organizations_verification_status');
    expect(queue?.partial).toBe(true);
    expect(queue?.indexdef).toContain('WHERE');
  }, 120_000);
});

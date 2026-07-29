import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** Voir l'en-tête de `auth-identity-flow.test.ts` : l'environnement précède les imports. */
vi.hoisted(() => {
  process.env.APP_ENV = 'local';
  process.env.APP_VERSION = '0.0.0-test';
  process.env.LOG_LEVEL = 'error';
  process.env.AUTH_SECRET = 'secret-de-test-fictif-atomicite-de-plus-de-32-caracteres';
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
  };
});

/**
 * TOUTE la journalisation est détournée vers la mémoire, à `trace`, journal de requête compris.
 * C'est la seule façon de chercher une valeur dans ce que le code écrit RÉELLEMENT plutôt que
 * dans ce qu'il est censé écrire, et c'est le patron de `auth-logging.test.ts`.
 *
 * LA DOUBLURE N'EST PAS UN ESPION : c'est un vrai `pino` construit par la fabrique du dépôt,
 * donc avec la même rédaction, les mêmes sérialiseurs et le même formatage. Un espion qui
 * enregistrerait les arguments passerait à côté de la rédaction, c'est-à-dire de la moitié du
 * sujet — et surtout à côté du sérialiseur d'erreur, qui recopie les champs du pilote
 * PostgreSQL.
 *
 * CONSÉQUENCE À CONNAÎTRE : `logger.level = 'silent'` est volontairement ABSENT du `beforeAll`
 * de ce fichier, contrairement aux autres fichiers d'intégration. Le poser viderait la capture.
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

import { type AppError, isAppError } from '@/application/errors';
import { buildSessionCookie } from '@/authorization/session-cookie';
import { resetServerConfigCache } from '@/config/env';
import type { CodeDelivery, SignInCodeMessage } from '@/domain/identity/code-delivery';
import { configureCodeDelivery, resetCodeDelivery } from '@/domain/identity/code-delivery';
import { requestSignInCode } from '@/domain/identity/request-sign-in-code';
import type { RequestOrigin } from '@/domain/identity/types';
import { verifySignInCode } from '@/domain/identity/verify-sign-in-code';
import { createOrganization, updateOrganizationIdentity } from '@/domain/organizations';
import { closePool, getPool } from '@/infrastructure/database/pool';
import { PATCH as updateOrganizationRoute } from '../../app/api/v1/organizations/[organizationId]/route';
import { POST as createOrganizationRoute } from '../../app/api/v1/organizations/route';
import type { DisposableDatabaseSetup } from './setup/database';
import { createDisposableDatabase, databaseOrSkip, NOT_PREPARED } from './setup/database';

/**
 * Atomicité, audit, outbox et confidentialité des journaux de US-012, éprouvés contre une vraie
 * base PostgreSQL.
 *
 * POURQUOI CE NIVEAU ET PAS DES DOUBLURES. Ce que cette story promet ne vit ni dans une
 * signature ni dans un type : « une seule transaction, six écritures, tout échoue ensemble ou
 * rien n'aboutit ». Un dépôt simulé rendrait `true` à toutes les assertions de ce fichier sans
 * qu'aucune transaction n'existe. La preuve ne peut venir que de la base : ce sont ses lignes
 * qu'on compte, et c'est son `ROLLBACK` qu'on éprouve.
 *
 * COMMENT L'APPARTENANCE À UNE MÊME TRANSACTION SE PROUVE. `now()` de PostgreSQL est l'instant
 * de DÉBUT DE TRANSACTION, pas l'horloge murale : deux écritures faites dans deux transactions
 * successives portent nécessairement deux instants différents, deux écritures faites dans la
 * même transaction portent le même. Les six valeurs par défaut du schéma — `organizations`,
 * `organization_members`, `audit_logs`, `outbox`, `idempotency_keys` — deviennent donc un test
 * d'appartenance, et non une simple présence de lignes.
 *
 * CE QUE CE FICHIER NE COUVRE PAS, ET POURQUOI. Les gardes d'autorisation, la validation champ
 * par champ, la pagination de la file et le rejeu idempotent sont éprouvés ailleurs : ce
 * fichier ne regarde que ce qui est écrit, où, quand, et ce qui reste après un échec.
 */

const APP_ORIGIN = 'https://appui-feux.exemple.test';
const HOST = 'appui-feux.exemple.test';
const USER_AGENT = 'Mozilla/5.0 (Android 14; Mobile; rv:141.0) Gecko/141.0 Firefox/141.0.2';
/** Résumé attendu de l'en-tête ci-dessus, tel que `summarizeUserAgent` le produit. */
const EXPECTED_USER_AGENT_SUMMARY = 'Firefox 141 / Android';
/** Contrainte de forme commune à `audit_logs.action`, `target_type` et `outbox.event_type`. */
const UPPERCASE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const SHA_256_HEX_PATTERN = /^[0-9a-f]{64}$/;

let setup: DisposableDatabaseSetup = NOT_PREPARED;
let addressCounter = 0;
const deliveries: SignInCodeMessage[] = [];

/**
 * Adaptateur d'envoi de test. Il rend le code disponible SANS passer par un journal :
 * l'adaptateur de repli n'écrit le code qu'en environnement local, et un test qui en
 * dépendrait vérifierait le repli au lieu du parcours.
 */
const recordingDelivery: CodeDelivery = {
  send(message: SignInCodeMessage): Promise<void> {
    deliveries.push(message);
    return Promise.resolve();
  },
};

/** Une adresse par appel : les compteurs de limitation de tentatives ne se croisent jamais. */
function nextOrigin(): RequestOrigin {
  addressCounter += 1;
  const block = Math.floor(addressCounter / 250);
  const host = (addressCounter % 250) + 1;
  return { ipAddress: `203.0.${block}.${host}`, userAgent: USER_AGENT };
}

function nextEmail(label: string): string {
  return `sentinelle-${label}-${randomUUID().slice(0, 8)}@exemple.test`;
}

/** Suffixe unique : deux organisations de ce fichier ne partagent jamais un numéro. */
function uniqueSuffix(): string {
  return randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
}

type OrganizationRecord = {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly registration_number: string;
  readonly registration_number_normalized: string;
  readonly territory_code: string | null;
  readonly verification_status: string;
  readonly status: string;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
};

type MemberRecord = {
  readonly organization_id: string;
  readonly user_id: string;
  readonly role: string;
  readonly status: string;
  readonly valid_from: Date;
  readonly valid_until: Date | null;
  readonly created_at: Date;
};

type AuditRecord = {
  readonly id: string;
  readonly actor_user_id: string | null;
  readonly actor_organization_id: string | null;
  readonly action: string;
  readonly target_type: string;
  readonly target_id: string | null;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly ip_hash: string | null;
  readonly user_agent_summary: string | null;
  readonly occurred_at: Date;
  readonly recorded_at: Date;
};

type OutboxRecord = {
  readonly id: string;
  readonly event_type: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly payload: Record<string, unknown>;
  readonly processed_at: Date | null;
  readonly attempt_count: number;
  readonly created_at: Date;
};

type IdempotencyRecord = {
  readonly id: string;
  readonly client_event_id: string;
  readonly operation: string;
  readonly actor_user_id: string | null;
  readonly request_fingerprint: string;
  readonly target_type: string | null;
  readonly target_id: string | null;
  readonly result: Record<string, unknown>;
  readonly created_at: Date;
};

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

async function countRows(client: Client, sql: string, values: unknown[]): Promise<number> {
  const { rows } = await client.query<{ readonly count: string }>(sql, values);
  return Number(rows[0]?.count ?? '-1');
}

async function readOrganizationRow(client: Client, id: string): Promise<OrganizationRecord> {
  const { rows } = await client.query<OrganizationRecord>(
    `select id, name, type, registration_number, registration_number_normalized, territory_code,
            verification_status, status, version, created_at, updated_at
       from public.organizations
      where id = $1`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`organisation introuvable : ${id}`);
  }
  return row;
}

async function readAuditRows(
  client: Client,
  organizationId: string,
): Promise<readonly AuditRecord[]> {
  const { rows } = await client.query<AuditRecord>(
    `select id, actor_user_id, actor_organization_id, action, target_type, target_id,
            before, after, ip_hash, user_agent_summary, occurred_at, recorded_at
       from public.audit_logs
      where actor_organization_id = $1
      order by recorded_at, action`,
    [organizationId],
  );
  return rows;
}

async function readOutboxRows(
  client: Client,
  organizationId: string,
): Promise<readonly OutboxRecord[]> {
  const { rows } = await client.query<OutboxRecord>(
    `select id, event_type, aggregate_type, aggregate_id, payload, processed_at,
            attempt_count, created_at
       from public.outbox
      where aggregate_id = $1
      order by created_at, id`,
    [organizationId],
  );
  return rows;
}

/** Instant du serveur, seule horloge qui fasse foi ici : celle du poste n'écrit rien. */
async function databaseNow(client: Client): Promise<Date> {
  const { rows } = await client.query<{ readonly at: Date }>('select now() as at');
  const row = rows[0];
  if (row === undefined) {
    throw new Error("l'horloge du serveur n'a rien renvoyé");
  }
  return row.at;
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
 * Capture une exception QUELCONQUE. Séparée de `captureAppError` à dessein : les deux cas
 * d'échec injecté ci-dessous ne produisent pas d'`AppError` mais l'erreur nue du pilote, et
 * confondre les deux ferait passer un `AppError` inattendu pour l'échec recherché.
 */
async function captureFailure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("l'appel aurait dû échouer");
}

type PostgresFailure = {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
  readonly detail: string | undefined;
  readonly message: string;
};

/** Lecture prudente d'une erreur du pilote, sans `any` et sans supposer sa forme. */
function describePostgresFailure(error: unknown): PostgresFailure {
  if (typeof error !== 'object' || error === null) {
    return { code: undefined, constraint: undefined, detail: undefined, message: String(error) };
  }
  const read = (key: string): string | undefined => {
    if (!(key in error)) {
      return undefined;
    }
    const value = Reflect.get(error, key);
    return typeof value === 'string' ? value : undefined;
  };
  return {
    code: read('code'),
    constraint: read('constraint'),
    detail: read('detail'),
    message: read('message') ?? String(error),
  };
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

/** Session réelle, obtenue par le parcours de US-010 : la route n'en accepte pas d'autre. */
async function openSession(email: string): Promise<{ readonly cookie: string }> {
  const origin = nextOrigin();
  const challenge = await requestSignInCode({ identifier: email, origin });
  const code = await waitForCode(challenge.challengeId);
  const verified = await verifySignInCode({ challengeId: challenge.challengeId, code, origin });
  return { cookie: buildSessionCookie(verified.sessionToken).split(';')[0] ?? '' };
}

/** En-têtes communs aux appels de route : une adresse par appel, session portée, corps JSON. */
function buildRequestHeaders(cookie: string): Headers {
  addressCounter += 1;
  return new Headers({
    host: HOST,
    origin: APP_ORIGIN,
    'content-type': 'application/json',
    'x-forwarded-for': `198.51.100.${(addressCounter % 250) + 1}`,
    'user-agent': USER_AGENT,
    cookie,
  });
}

function buildCreateRequest(input: { readonly body: unknown; readonly cookie: string }): Request {
  return new Request(`${APP_ORIGIN}/api/v1/organizations`, {
    method: 'POST',
    headers: buildRequestHeaders(input.cookie),
    body: JSON.stringify(input.body),
  });
}

/**
 * Requête de MODIFICATION. L'identifiant voyage dans le chemin et nulle part ailleurs :
 * `readOrganizationIdFromPath` lit le dernier segment de l'URL, la route ne recevant pas les
 * segments dynamiques de Next. Une requête construite autrement éprouverait un autre code.
 */
function buildUpdateRequest(input: {
  readonly organizationId: string;
  readonly body: unknown;
  readonly cookie: string;
}): Request {
  return new Request(`${APP_ORIGIN}/api/v1/organizations/${input.organizationId}`, {
    method: 'PATCH',
    headers: buildRequestHeaders(input.cookie),
    body: JSON.stringify(input.body),
  });
}

beforeAll(async () => {
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
    // Ouvrir les connexions à l'avance : sur une base conteneurisée, leur coût dépasse le délai
    // d'obtention du pilote et transformerait un échec métier en « timeout when connecting ».
    await Promise.all(Array.from({ length: 8 }, () => getPool().query('select 1')));
  }
}, 120_000);

/**
 * Le tampon de capture repart vide À CHAQUE test, et pas seulement devant les deux tests qui
 * le lisent. Sans cela, les six premiers tests y accumulent tout le journal `trace` du
 * fichier — parcours de connexion compris — pour personne, et le jour où un septième test
 * viendrait lire `capture.raw` sans le vider d'abord, il trouverait les traces d'un voisin.
 * Les `capture.clear()` posés à l'intérieur des tests restent : ils resserrent la fenêtre
 * d'observation autour de l'appel mesuré, une fois la session ouverte.
 */
beforeEach(() => {
  capture.clear();
});

afterAll(async () => {
  resetCodeDelivery();
  await closePool();
  if (setup.available) {
    await setup.database.dispose();
  }
});

describe('création — les six écritures d une seule transaction', () => {
  it('écrit idempotence, organisation, adhésion, deux audits et un message d outbox, et rien d autre', async (context) => {
    const database = databaseOrSkip(setup, context);
    const userId = await seedProfile(database.owner, {
      email: nextEmail('six-ecritures'),
      displayName: 'Camille D.',
    });
    const clientEventId = randomUUID();
    const registrationNumber = `FICTIF-ORG-${uniqueSuffix()}`;
    const name = `Exploitation agricole ${uniqueSuffix()}`;

    const startedAt = await databaseNow(database.owner);
    const result = await createOrganization({
      actorUserId: userId,
      origin: { ipAddress: '198.51.100.11', userAgent: USER_AGENT },
      payload: {
        name,
        type: 'FARM',
        registrationNumber,
        territoryCode: 'ZZ-DEMO-01',
        clientEventId,
      },
    });
    const finishedAt = await databaseNow(database.owner);

    expect(result.nextStep).toBe('AWAITING_VERIFICATION');
    expect(result.replayed).toBe(false);
    const organizationId = result.organization.id;

    // --- 2. l'organisation, telle que le serveur la pose et non telle que le client la demande
    const organization = await readOrganizationRow(database.owner, organizationId);
    expect(organization.verification_status).toBe('PENDING');
    expect(organization.status).toBe('ACTIVE');
    expect(organization.version).toBe(1);
    expect(organization.registration_number).toBe(registrationNumber);
    // `created_at` et `updated_at` sortent du même `now()` : une fiche neuve n'a pas d'histoire.
    expect(organization.updated_at.getTime()).toBe(organization.created_at.getTime());

    // --- 3. l'adhésion du créateur, décidée par le serveur (ADR-016)
    const { rows: members } = await database.owner.query<MemberRecord>(
      `select organization_id, user_id, role, status, valid_from, valid_until, created_at
         from public.organization_members
        where organization_id = $1`,
      [organizationId],
    );
    expect(members).toHaveLength(1);
    const member = members[0];
    if (member === undefined) {
      throw new Error("l'adhésion initiale est introuvable");
    }
    expect(member.user_id).toBe(userId);
    expect(member.role).toBe('ORG_ADMIN');
    expect(member.status).toBe('ACTIVE');
    expect(member.valid_until).toBeNull();

    // --- 4 et 5. les deux lignes d'audit, avec leur vocabulaire exact
    const audits = await readAuditRows(database.owner, organizationId);
    expect(audits.map((row) => row.action).sort()).toEqual([
      'ORGANIZATION_CREATED',
      'ORGANIZATION_MEMBER_ADDED',
    ]);
    const created = audits.find((row) => row.action === 'ORGANIZATION_CREATED');
    const memberAdded = audits.find((row) => row.action === 'ORGANIZATION_MEMBER_ADDED');
    if (created === undefined || memberAdded === undefined) {
      throw new Error("les deux lignes d'audit attendues ne sont pas toutes écrites");
    }

    // La casse n'est pas cosmétique : `audit_logs_action_format` et
    // `audit_logs_target_type_format` refusent tout ce qui n'est pas en majuscules. Un
    // « Organization » écrit au naturel du modèle de domaine ferait échouer la mutation
    // ENTIÈRE, en production, sur un message qui ne dit pas pourquoi.
    for (const row of audits) {
      expect(row.action, `action hors format : ${row.action}`).toMatch(UPPERCASE_CODE_PATTERN);
      expect(row.target_type, `cible hors format : ${row.target_type}`).toMatch(
        UPPERCASE_CODE_PATTERN,
      );
      expect(row.actor_user_id).toBe(userId);
      expect(row.actor_organization_id).toBe(organizationId);
      expect(row.ip_hash).toMatch(SHA_256_HEX_PATTERN);
      expect(row.user_agent_summary).toBe(EXPECTED_USER_AGENT_SUMMARY);
      // L'instant métier est encadré par les deux lectures d'horloge du serveur.
      expect(row.occurred_at.getTime()).toBeGreaterThanOrEqual(startedAt.getTime());
      expect(row.occurred_at.getTime()).toBeLessThanOrEqual(finishedAt.getTime());
      expect(row.recorded_at.getTime()).toBeGreaterThanOrEqual(row.occurred_at.getTime());
    }

    expect(created.target_type).toBe('ORGANIZATION');
    expect(created.target_id).toBe(organizationId);
    expect(created.before).toBeNull();
    expect(created.after).toEqual({
      name,
      type: 'FARM',
      registrationNumber,
      territoryCode: 'ZZ-DEMO-01',
      verificationStatus: 'PENDING',
      status: 'ACTIVE',
      version: 1,
      clientEventId,
    });

    // `target_id` porte L'UTILISATEUR et non l'organisation : l'adhésion n'a pas d'identifiant
    // propre, sa clé est le couple, et `actor_organization_id` porte déjà l'organisation.
    // Répéter l'organisation dans les deux colonnes perdrait la seule information restante.
    expect(memberAdded.target_type).toBe('ORGANIZATION_MEMBER');
    expect(memberAdded.target_id).toBe(userId);
    expect(memberAdded.after).toEqual({
      organizationId,
      userId,
      role: 'ORG_ADMIN',
      status: 'ACTIVE',
      validFrom: member.valid_from.toISOString(),
      validUntil: null,
      reason: 'ORGANIZATION_CREATED',
    });

    // --- 6. le message d'outbox
    const outbox = await readOutboxRows(database.owner, organizationId);
    expect(outbox).toHaveLength(1);
    const message = outbox[0];
    if (message === undefined) {
      throw new Error("le message d'outbox est introuvable");
    }
    expect(message.event_type).toBe('ORGANIZATION_SUBMITTED');
    expect(message.event_type).toMatch(UPPERCASE_CODE_PATTERN);
    expect(message.aggregate_type).toBe('ORGANIZATION');
    expect(message.aggregate_type).toMatch(UPPERCASE_CODE_PATTERN);
    expect(message.processed_at).toBeNull();
    expect(message.attempt_count).toBe(0);
    // IDENTIFIANTS ET RIEN D'AUTRE : la charge est recopiée dans les journaux du fournisseur
    // d'envoi. Le service de notification relit l'organisation s'il en a besoin, avec les
    // droits qui vont avec.
    expect(message.payload).toEqual({
      organizationId,
      submittedByUserId: userId,
      reason: 'CREATED',
    });

    // --- 1. la réservation d'idempotence, complétée en fin de transaction
    const { rows: keys } = await database.owner.query<IdempotencyRecord>(
      `select id, client_event_id, operation, actor_user_id, request_fingerprint,
              target_type, target_id, result, created_at
         from public.idempotency_keys
        where client_event_id = $1`,
      [clientEventId],
    );
    expect(keys).toHaveLength(1);
    const key = keys[0];
    if (key === undefined) {
      throw new Error("la réservation d'idempotence est introuvable");
    }
    expect(key.operation).toBe('ORGANIZATION_CREATE');
    expect(key.operation).toMatch(UPPERCASE_CODE_PATTERN);
    expect(key.actor_user_id).toBe(userId);
    expect(key.target_type).toBe('ORGANIZATION');
    expect(key.target_id).toBe(organizationId);
    expect(key.result).toEqual({ organizationId, version: 1 });
    // Le corps n'est jamais stocké : seule une empreinte l'est, et elle n'est pas réversible.
    expect(key.request_fingerprint).toMatch(SHA_256_HEX_PATTERN);
    const { rows: keyDumps } = await database.owner.query<{ readonly ligne: string }>(
      'select to_jsonb(k)::text as ligne from public.idempotency_keys k where k.id = $1',
      [key.id],
    );
    const keyDump = keyDumps[0]?.ligne;
    if (keyDump === undefined) {
      throw new Error("la photographie de la réservation d'idempotence n'a rien rendu");
    }
    // LA PHOTOGRAPHIE DOIT PORTER LA LIGNE. Écrite `keyDumps[0]?.ligne ?? ''`, la recherche
    // porterait sur la chaîne vide dès que la requête ne rend rien, et deux assertions de
    // non-fuite passeraient sans jamais avoir regardé une ligne. Ces deux marqueurs sont les
    // seules valeurs de la ligne qu'on s'attend à y lire ; ils prouvent qu'on la lit bien.
    expect(keyDump, "la photographie ne porte pas la ligne d'idempotence").toContain(key.id);
    expect(keyDump).toContain(key.request_fingerprint);
    expect(keyDump, "le numéro d'immatriculation est recopié dans le registre").not.toContain(
      registrationNumber,
    );
    expect(keyDump, "le nom de l'organisation est recopié dans le registre").not.toContain(name);

    // --- L'APPARTENANCE À LA MÊME TRANSACTION, ET NON LA SEULE PRÉSENCE DES LIGNES.
    // `now()` est l'instant de DÉBUT DE TRANSACTION : cinq écritures faites dans la même
    // transaction portent le même instant, cinq écritures faites l'une après l'autre en
    // portent cinq différents. C'est ce qui distingue « les six effets ont eu lieu » de
    // « les six effets ont eu lieu ENSEMBLE », seule promesse qui vaille ici.
    const transactionInstant = organization.created_at.getTime();
    expect(member.created_at.getTime(), 'adhésion écrite hors de la transaction').toBe(
      transactionInstant,
    );
    expect(created.recorded_at.getTime(), 'audit de création hors de la transaction').toBe(
      transactionInstant,
    );
    expect(memberAdded.recorded_at.getTime(), "audit d'adhésion hors de la transaction").toBe(
      transactionInstant,
    );
    expect(message.created_at.getTime(), "message d'outbox hors de la transaction").toBe(
      transactionInstant,
    );
    expect(key.created_at.getTime(), "réservation d'idempotence hors de la transaction").toBe(
      transactionInstant,
    );

    // --- ET RIEN D'AUTRE. Le compte fait foi : une écriture supplémentaire, fût-elle
    // anodine, est une écriture que personne n'a décidée.
    expect(
      await countRows(
        database.owner,
        'select count(*)::text as count from public.audit_logs where actor_user_id = $1',
        [userId],
      ),
    ).toBe(2);
    expect(
      await countRows(
        database.owner,
        'select count(*)::text as count from public.idempotency_keys where actor_user_id = $1',
        [userId],
      ),
    ).toBe(1);
  }, 60_000);

  it('ne laisse RIEN derrière un conflit d unicité : ni organisation, ni adhésion, ni audit, ni outbox, ni clé', async (context) => {
    const database = databaseOrSkip(setup, context);
    const holderId = await seedProfile(database.owner, { email: nextEmail('detenteur') });
    const intruderId = await seedProfile(database.owner, { email: nextEmail('doublon') });
    const suffix = uniqueSuffix();
    const registrationNumber = `FICTIF-ORG-${suffix}`;

    const first = await createOrganization({
      actorUserId: holderId,
      origin: { ipAddress: '198.51.100.21', userAgent: USER_AGENT },
      payload: {
        name: `Structure detentrice ${suffix}`,
        type: 'ASSOCIATION',
        registrationNumber,
        clientEventId: randomUUID(),
      },
    });

    const doomedName = `Structure fantome ${suffix}`;
    const doomedClientEventId = randomUUID();
    // Même numéro une fois normalisé, forme différente : l'unicité porte sur la forme
    // normalisée, et c'est bien la contrainte qui tranche, pas une lecture préalable.
    const error = await captureAppError(() =>
      createOrganization({
        actorUserId: intruderId,
        origin: { ipAddress: '198.51.100.22', userAgent: USER_AGENT },
        payload: {
          name: doomedName,
          type: 'COMPANY',
          registrationNumber: `fictif.org/${suffix}`,
          clientEventId: doomedClientEventId,
        },
      }),
    );
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toEqual({ fields: ['registrationNumber'] });

    // La commande n'a produit AUCUN effet. Cinq comptages, un par table écrite par le chemin
    // nominal : c'est la définition testable de « tout échoue ensemble ».
    expect(
      await countRows(
        database.owner,
        'select count(*)::text as count from public.organizations where name = $1',
        [doomedName],
      ),
      'une organisation fantôme subsiste',
    ).toBe(0);
    expect(
      await countRows(
        database.owner,
        'select count(*)::text as count from public.organization_members where user_id = $1',
        [intruderId],
      ),
    ).toBe(0);
    expect(
      await countRows(
        database.owner,
        'select count(*)::text as count from public.audit_logs where actor_user_id = $1',
        [intruderId],
      ),
    ).toBe(0);
    expect(
      await countRows(
        database.owner,
        `select count(*)::text as count from public.outbox
          where payload ->> 'submittedByUserId' = $1`,
        [intruderId],
      ),
      "un message d'outbox annonce une organisation qui n'existe pas",
    ).toBe(0);
    // LA CLÉ EST LIBÉRÉE. La commande n'ayant produit aucun effet, elle n'a pas « déjà été
    // exécutée » : une reprise avec la même clé et un numéro corrigé doit pouvoir aboutir.
    expect(
      await countRows(
        database.owner,
        'select count(*)::text as count from public.idempotency_keys where client_event_id = $1',
        [doomedClientEventId],
      ),
    ).toBe(0);

    // L'organisation légitime, elle, est intacte : un échec voisin ne la touche pas.
    const holder = await readOrganizationRow(database.owner, first.organization.id);
    expect(holder.version).toBe(1);
    expect(holder.registration_number).toBe(registrationNumber);
  }, 60_000);

  it('annule aussi le message d outbox lorsque la transaction échoue APRÈS son écriture', async (context) => {
    const database = databaseOrSkip(setup, context);
    const userId = await seedProfile(database.owner, { email: nextEmail('rollback-tardif') });
    const clientEventId = randomUUID();
    const suffix = uniqueSuffix();
    const doomedName = `Structure interrompue ${suffix}`;

    /**
     * POURQUOI UN ÉCHEC INJECTÉ ICI, ET PAS SEULEMENT UN CONFLIT D'UNICITÉ. Le conflit
     * d'unicité échoue à la DEUXIÈME écriture : l'audit et l'outbox n'ont pas encore été
     * tentés, et leur absence ne prouve donc rien de leur transactionnalité. La contrainte
     * temporaire ci-dessous fait échouer la DERNIÈRE écriture — l'inscription du résultat sur
     * la ligne d'idempotence — c'est-à-dire APRÈS que le message d'outbox a réellement été
     * inséré. Ce qui reste ensuite en base est la seule mesure honnête.
     *
     * CE QUE L'ON CHERCHE À EXCLURE. Un message d'outbox écrit hors transaction — sur une
     * autre connexion, en validation automatique, ou après le `COMMIT` — survivrait à ce
     * retour arrière. Ce ne serait pas une imperfection : la file de validation annoncerait
     * à un administrateur plateforme une organisation qui n'existe pas, il ouvrirait une
     * fiche introuvable, et le drainage réessaierait indéfiniment un message sans agrégat.
     * L'inverse — écrire le message après le `COMMIT` — perdrait la notification d'une
     * organisation réellement créée, qui resterait invisible et bloquée sans que personne
     * ne le sache. Les deux issues fausses sont fermées par la même règle : l'écriture
     * appartient à la transaction.
     *
     * La contrainte est posée sur la base JETABLE, jamais sur une migration : le code de
     * production n'est pas touché, et la contrainte est retirée quoi qu'il arrive.
     */
    await database.owner.query(
      `alter table public.idempotency_keys
         add constraint tmp_atomicite_refus_completion check (target_id is null) not valid`,
    );

    try {
      const failure = describePostgresFailure(
        await captureFailure(() =>
          createOrganization({
            actorUserId: userId,
            origin: { ipAddress: '198.51.100.31', userAgent: USER_AGENT },
            payload: {
              name: doomedName,
              type: 'LOCAL_AUTHORITY',
              registrationNumber: `FICTIF-ORG-${suffix}`,
              clientEventId,
            },
          }),
        ),
      );
      // L'échec doit être CELUI QU'ON A INJECTÉ. Sans cette vérification, une erreur survenue
      // plus tôt — un profil manquant, une connexion perdue — ferait passer le test pour la
      // bonne raison sans que la dernière écriture ait jamais été atteinte.
      expect(failure.code, failure.message).toBe('23514');
      expect(failure.constraint).toBe('tmp_atomicite_refus_completion');
    } finally {
      await database.owner.query(
        'alter table public.idempotency_keys drop constraint if exists tmp_atomicite_refus_completion',
      );
    }

    expect(
      await countRows(
        database.owner,
        'select count(*)::text as count from public.organizations where name = $1',
        [doomedName],
      ),
    ).toBe(0);
    expect(
      await countRows(
        database.owner,
        'select count(*)::text as count from public.organization_members where user_id = $1',
        [userId],
      ),
    ).toBe(0);
    expect(
      await countRows(
        database.owner,
        'select count(*)::text as count from public.audit_logs where actor_user_id = $1',
        [userId],
      ),
      "une preuve subsiste pour une mutation qui n'a pas eu lieu",
    ).toBe(0);
    expect(
      await countRows(
        database.owner,
        `select count(*)::text as count from public.outbox
          where payload ->> 'submittedByUserId' = $1`,
        [userId],
      ),
      "le message d'outbox a survécu au retour arrière : il annonce un effet annulé",
    ).toBe(0);
    expect(
      await countRows(
        database.owner,
        'select count(*)::text as count from public.idempotency_keys where client_event_id = $1',
        [clientEventId],
      ),
    ).toBe(0);
  }, 60_000);
});

describe('audit de la modification d identité', () => {
  it('consigne la modification ET la retombée de vérification en deux lignes distinctes', async (context) => {
    const database = databaseOrSkip(setup, context);
    const userId = await seedProfile(database.owner, { email: nextEmail('retombee') });
    const suffix = uniqueSuffix();
    const initialName = `Service technique ${suffix}`;

    const creation = await createOrganization({
      actorUserId: userId,
      origin: { ipAddress: '198.51.100.41', userAgent: USER_AGENT },
      payload: {
        name: initialName,
        type: 'OPERATIONAL_SERVICE',
        registrationNumber: `FICTIF-ORG-${suffix}`,
        clientEventId: randomUUID(),
      },
    });
    const organizationId = creation.organization.id;

    // La validation par un administrateur plateforme relève d'US-013 : aucune commande ne
    // l'expose encore. L'état est donc posé en SQL, ce qui n'ôte rien à la mesure — c'est bien
    // le serveur qui décide ensuite de la retombée, sous verrou de ligne, dans son `UPDATE`.
    await database.owner.query(
      "update public.organizations set verification_status = 'VERIFIED' where id = $1",
      [organizationId],
    );

    const renamed = `Service incendie territorial ${suffix}`;
    const startedAt = await databaseNow(database.owner);
    const result = await updateOrganizationIdentity({
      actorUserId: userId,
      origin: { ipAddress: '198.51.100.42', userAgent: USER_AGENT },
      organizationId,
      payload: { name: renamed, expectedVersion: 1 },
    });
    const finishedAt = await databaseNow(database.owner);

    expect(result.verificationReset).toBe(true);
    expect(result.organization.verificationStatus).toBe('PENDING');
    expect(result.organization.version).toBe(2);

    const audits = await readAuditRows(database.owner, organizationId);
    const updated = audits.find((row) => row.action === 'ORGANIZATION_UPDATED');
    const reset = audits.find((row) => row.action === 'ORGANIZATION_VERIFICATION_RESET');
    if (updated === undefined || reset === undefined) {
      throw new Error("la modification n'a pas produit ses deux lignes d'audit");
    }
    // DEUX LIGNES, PAS UNE. La modification et la perte de confiance sont deux faits :
    // les confondre rendrait impossible de compter les secondes sans relire et interpréter
    // les premières, alors que c'est exactement ce qu'un administrateur plateforme cherche.
    expect(updated.id).not.toBe(reset.id);

    for (const row of [updated, reset]) {
      expect(row.action).toMatch(UPPERCASE_CODE_PATTERN);
      expect(row.target_type).toBe('ORGANIZATION');
      expect(row.target_id).toBe(organizationId);
      expect(row.actor_user_id).toBe(userId);
      expect(row.actor_organization_id).toBe(organizationId);
      expect(row.ip_hash).toMatch(SHA_256_HEX_PATTERN);
      expect(row.user_agent_summary).toBe(EXPECTED_USER_AGENT_SUMMARY);
      expect(row.occurred_at.getTime()).toBeGreaterThanOrEqual(startedAt.getTime());
      expect(row.occurred_at.getTime()).toBeLessThanOrEqual(finishedAt.getTime());
    }
    // Même instant de début de transaction pour les deux lignes ET pour le message d'outbox :
    // la preuve et la notification sont écrites avec la mutation, pas à côté.
    expect(reset.recorded_at.getTime()).toBe(updated.recorded_at.getTime());

    // `before` et `after` portent LES SEULS CHAMPS MODIFIÉS, jamais une copie de la fiche :
    // le journal dirait sinon ce que l'organisation est, et non ce qui a bougé, tout en
    // devenant un second stockage consultable par d'autres rôles.
    expect(updated.before).toEqual({ name: initialName });
    expect(updated.after).toEqual({ name: renamed, version: 2 });
    expect(reset.before).toEqual({ verificationStatus: 'VERIFIED' });
    expect(reset.after).toEqual({
      verificationStatus: 'PENDING',
      reason: 'IDENTITY_CHANGED',
      changedFields: ['name'],
    });

    // L'organisation retourne dans la file de validation : second message, même événement.
    const outbox = await readOutboxRows(database.owner, organizationId);
    expect(outbox.map((row) => row.event_type)).toEqual([
      'ORGANIZATION_SUBMITTED',
      'ORGANIZATION_SUBMITTED',
    ]);
    expect(outbox.map((row) => row.payload.reason)).toEqual(['CREATED', 'IDENTITY_CHANGED']);
    const second = outbox[1];
    if (second === undefined) {
      throw new Error("le second message d'outbox est introuvable");
    }
    expect(second.payload).toEqual({
      organizationId,
      submittedByUserId: userId,
      reason: 'IDENTITY_CHANGED',
    });
    expect(second.created_at.getTime()).toBe(updated.recorded_at.getTime());
  }, 60_000);

  it('ne consigne aucune retombée quand seul le périmètre territorial change', async (context) => {
    const database = databaseOrSkip(setup, context);
    const userId = await seedProfile(database.owner, { email: nextEmail('territoire') });
    const suffix = uniqueSuffix();

    const creation = await createOrganization({
      actorUserId: userId,
      origin: { ipAddress: '198.51.100.51', userAgent: USER_AGENT },
      payload: {
        name: `Collectivite ${suffix}`,
        type: 'LOCAL_AUTHORITY',
        registrationNumber: `FICTIF-ORG-${suffix}`,
        territoryCode: 'ZZ-DEMO-01',
        clientEventId: randomUUID(),
      },
    });
    const organizationId = creation.organization.id;
    await database.owner.query(
      "update public.organizations set verification_status = 'VERIFIED' where id = $1",
      [organizationId],
    );

    const result = await updateOrganizationIdentity({
      actorUserId: userId,
      origin: { ipAddress: '198.51.100.52', userAgent: USER_AGENT },
      organizationId,
      payload: { territoryCode: 'ZZ-DEMO-02', expectedVersion: 1 },
    });

    // LE PÉRIMÈTRE N'EST PAS UNE IDENTITÉ. Le soumettre à revalidation dissuaderait de le
    // corriger, et une file de validation encombrée de corrections de périmètre retarderait
    // les vérifications qui, elles, portent sur l'identité déclarée.
    expect(result.verificationReset).toBe(false);
    expect(result.organization.verificationStatus).toBe('VERIFIED');
    expect(result.organization.version).toBe(2);

    const audits = await readAuditRows(database.owner, organizationId);
    expect(audits.filter((row) => row.action === 'ORGANIZATION_VERIFICATION_RESET')).toHaveLength(
      0,
    );
    const updated = audits.find((row) => row.action === 'ORGANIZATION_UPDATED');
    if (updated === undefined) {
      throw new Error("la modification n'a pas été consignée");
    }
    expect(updated.before).toEqual({ territoryCode: 'ZZ-DEMO-01' });
    expect(updated.after).toEqual({ territoryCode: 'ZZ-DEMO-02', version: 2 });

    // Aucun second message : la file de validation ne voit passer que ce qui la concerne.
    const outbox = await readOutboxRows(database.owner, organizationId);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.payload.reason).toBe('CREATED');
  }, 60_000);
});

describe('immuabilité du journal d audit', () => {
  it('refuse UPDATE, DELETE et TRUNCATE, y compris au propriétaire de la base', async (context) => {
    const database = databaseOrSkip(setup, context);
    const userId = await seedProfile(database.owner, { email: nextEmail('immuabilite') });
    const suffix = uniqueSuffix();

    const creation = await createOrganization({
      actorUserId: userId,
      origin: { ipAddress: '198.51.100.61', userAgent: USER_AGENT },
      payload: {
        name: `Structure auditee ${suffix}`,
        type: 'COMPANY',
        registrationNumber: `FICTIF-ORG-${suffix}`,
        clientEventId: randomUUID(),
      },
    });
    const audits = await readAuditRows(database.owner, creation.organization.id);
    const target = audits[0];
    if (target === undefined) {
      throw new Error("aucune ligne d'audit à éprouver");
    }

    /**
     * LE PROPRIÉTAIRE DE LA BASE, ET PAS LE COMPTE APPLICATIF. Le second n'a de toute façon
     * ni `UPDATE` ni `DELETE` sur cette table : lui opposer un refus ne prouverait que le
     * `GRANT`. Le déclencheur de `0006` existe pour le cas que les droits ne couvrent pas —
     * un rôle ajouté plus tard, un compte de maintenance réutilisé par erreur, un `GRANT ALL`
     * accidentel. C'est donc au compte le plus puissant qu'il faut opposer le refus, sans
     * quoi la preuve resterait effaçable par quiconque obtient ce compte.
     *
     * LE REFUS EST NOMMÉ, PAS SEULEMENT CONSTATÉ. Un `catch` nu qui poserait un booléen se
     * contenterait de N'IMPORTE QUELLE erreur : une colonne renommée (`42703`), une table
     * disparue (`42P01`), un droit retiré (`42501` avec un tout autre message), une
     * transaction déjà avortée (`25P02`) rendraient le test vert en ayant prouvé le
     * contraire de ce qu'il annonce — la table serait devenue inaccessible, pas immuable.
     * Ce sont donc le SQLSTATE ET le message du déclencheur de `0006_audit-logs.sql` qui
     * sont exigés, l'opération refusée comprise : elle vient de `TG_OP`, et c'est elle qui
     * distingue les trois refus les uns des autres.
     */
    for (const [label, operation, statement, values] of [
      [
        "falsification d'une action",
        'UPDATE',
        "update public.audit_logs set action = 'FALSIFIE' where id = $1",
        [target.id],
      ],
      ['effacement ciblé', 'DELETE', 'delete from public.audit_logs where id = $1', [target.id]],
      ['vidage complet', 'TRUNCATE', 'truncate public.audit_logs', []],
    ] as readonly (readonly [string, string, string, unknown[]])[]) {
      await database.owner.query('begin');
      let raised: unknown;
      try {
        raised = await captureFailure(() => database.owner.query(statement, values));
      } finally {
        // Le retour arrière a lieu MÊME SI L'ÉCRITURE A RÉUSSI : sans lui, une falsification
        // acceptée resterait en base et la transaction restée ouverte ferait échouer tous
        // les tests suivants sur un message sans rapport avec leur objet.
        await database.owner.query('rollback');
      }
      const failure = describePostgresFailure(raised);
      expect(failure.code, `${label} : ${failure.message}`).toBe('42501');
      expect(failure.message, label).toContain("Le journal d'audit est immuable");
      expect(failure.message, label).toContain(`opération ${operation} refusée sur audit_logs`);
    }

    // ET L'EXCEPTION PRÉVUE FONCTIONNE, elle aussi. Les trois refus ci-dessus disent d'où
    // vient le verrou ; celui-ci dit qu'il s'ouvre là où la migration l'a prévu. Sans cette
    // mesure, un déclencheur qui refuserait TOUT — purge de rétention comprise — passerait
    // pour correct, et `docs/privacy-rgpd.md` deviendrait inapplicable sans que rien ne le
    // signale. Le tout dans une transaction annulée : la preuve reste en place.
    await database.owner.query('begin');
    await database.owner.query("select set_config('appui_feux.audit_purge', 'on', true)");
    const purged = await database.owner.query('delete from public.audit_logs where id = $1', [
      target.id,
    ]);
    expect(purged.rowCount, "l'échappement de rétention ne supprime rien").toBe(1);
    await database.owner.query('rollback');

    expect(
      await countRows(
        database.owner,
        'select count(*)::text as count from public.audit_logs where id = $1',
        [target.id],
      ),
      "la ligne d'audit a disparu",
    ).toBe(1);
  }, 60_000);
});

describe('confidentialité des journaux — le numéro d immatriculation', () => {
  it('ne le journalise ni au succès, ni au refus de doublon', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('journaux');
    await seedProfile(database.owner, { email });
    const session = await openSession(email);
    const suffix = uniqueSuffix();
    const registrationNumber = `SENTINELLE-IMMAT-${suffix}`;
    const normalized = `SENTINELLEIMMAT${suffix}`;

    capture.clear();
    const accepted = await createOrganizationRoute(
      buildCreateRequest({
        cookie: session.cookie,
        body: {
          name: `Structure journalisee ${suffix}`,
          type: 'FARM',
          registrationNumber,
          clientEventId: randomUUID(),
        },
      }),
    );
    expect(accepted.status).toBe(201);

    const refused = await createOrganizationRoute(
      buildCreateRequest({
        cookie: session.cookie,
        body: {
          name: `Structure homonyme ${suffix}`,
          type: 'COMPANY',
          registrationNumber: `sentinelle.immat/${suffix}`,
          clientEventId: randomUUID(),
        },
      }),
    );
    expect(refused.status).toBe(400);
    const refusedBody = await refused.text();
    expect(refusedBody).toContain('VALIDATION_ERROR');
    expect(refusedBody, 'la réponse de refus nomme le numéro en conflit').not.toContain(
      registrationNumber,
    );

    const output = capture.raw;
    // LE TEST DOIT VOIR CE QU'IL PRÉTEND SURVEILLER. Ces deux marqueurs prouvent que les deux
    // chemins ont bien traversé la capture : sans eux, un journal vide rendrait les recherches
    // de sentinelle vraies pour la mauvaise raison.
    expect(output, "le chemin nominal n'a pas été capturé").toContain(
      'organisation creee, en attente de validation',
    );
    expect(output, "le refus de doublon n'a pas été capturé").toContain(
      'immatriculation deja enregistree',
    );
    // Seul le NOM DE L'INDEX est journalisé : c'est un identifiant du schéma, présent en clair
    // dans le dépôt, et il suffit à diagnostiquer sans rien révéler d'une structure tierce.
    expect(output).toContain('uq_organizations_registration_number');

    /**
     * LA VALEUR ÉTAIT DISPONIBLE POUR FUIR, et c'est ce qui donne son poids à l'assertion
     * suivante. L'erreur que le pilote remonte sur ce conflit porte le numéro NORMALISÉ dans
     * son champ `detail` : « Key (registration_number_normalized)=(...) already exists ». Le
     * domaine la capture, en tire le seul nom de l'index, et ne la propage pas — sans quoi le
     * numéro d'une organisation tierce se retrouverait dans les journaux d'exploitation, où
     * il serait lisible par des rôles qui n'y ont pas accès dans l'application.
     */
    await database.owner.query('begin');
    const driverFailure = describePostgresFailure(
      await captureFailure(() =>
        database.owner.query(
          `insert into public.organizations (name, type, registration_number)
           values ($1, 'FARM', $2)`,
          [`Sonde ${suffix}`, `sentinelle immat ${suffix}`],
        ),
      ),
    );
    await database.owner.query('rollback');
    expect(driverFailure.code).toBe('23505');
    expect(driverFailure.detail, "l'erreur du pilote ne porte pas la valeur en conflit").toContain(
      normalized,
    );

    for (const [label, sentinel] of [
      ['le numéro tel que saisi', registrationNumber],
      ['sa forme normalisée', normalized],
      ['sa forme minuscule', registrationNumber.toLowerCase()],
      ['la forme séparée du doublon', `sentinelle.immat/${suffix}`],
    ] as readonly (readonly [string, string])[]) {
      expect(output, `${label} a fuité dans les journaux`).not.toContain(sentinel);
    }
  }, 90_000);

  it("n'en journalise AUCUNE trace quand un SQLSTATE non reconnu remonte de la création", async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('journaux-500');
    await seedProfile(database.owner, { email });
    const session = await openSession(email);
    const suffix = uniqueSuffix();
    const registrationNumber = `SENTINELLE-FUITE-${suffix}`;
    const name = `Structure sonde ${suffix}`;

    /**
     * POURQUOI UNE CONTRAINTE TEMPORAIRE, ET PLUS L'ÉCART D'UNITÉ DE MESURE.
     *
     * La première version de ce test atteignait le chemin d'erreur interne par un nom d'un
     * seul caractère hors du plan multilingue de base : deux unités UTF-16 pour Zod, un
     * caractère pour `char_length`. Cet écart-là est CORRIGÉ — `nameSchema` compte désormais
     * des points de code — et un tel nom est maintenant refusé en `400` par la validation,
     * bien avant d'atteindre le pilote. La porte d'entrée a disparu ; LE CHEMIN, LUI, EST
     * INTACT : n'importe quel SQLSTATE non reconnu levé pendant une écriture sur
     * `organizations` y mène, et c'est lui qu'il faut éprouver. Réécrire le test autour de
     * la porte disparue l'aurait rendu vert sans plus rien mesurer.
     *
     * La contrainte ci-dessous ouvre ce chemin sans rien devoir à un défaut de validation :
     * le corps envoyé est PARFAITEMENT VALIDE, il ne déclare simplement aucun périmètre
     * territorial. C'est le montage déjà employé plus haut dans ce fichier pour faire
     * échouer une écriture précise, posé sur la base JETABLE — aucune migration n'est
     * touchée — et retiré quoi qu'il arrive.
     */
    await database.owner.query(
      `alter table public.organizations
         add constraint tmp_fuite_journal_creation check (territory_code is not null) not valid`,
    );

    try {
      capture.clear();
      const response = await createOrganizationRoute(
        buildCreateRequest({
          cookie: session.cookie,
          body: {
            name,
            type: 'FARM',
            registrationNumber,
            clientEventId: randomUUID(),
          },
        }),
      );

      // Le 500 reste un CONSTAT et non un souhait : un SQLSTATE que le domaine ne reconnaît
      // pas est un écart entre la validation et le schéma, donc un défaut du serveur, et le
      // rendre bruyant est ce qui le fait remonter dans le taux d'erreur de
      // `docs/observability.md`. Ce que ce test surveille est ce que ce 500 ÉCRIT.
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).toContain('INTERNAL_ERROR');
      expect(body, 'la réponse elle-même porte le numéro').not.toContain(registrationNumber);

      const output = capture.raw;
      expect(output, "le chemin d'erreur interne n'a pas été capturé").toContain(
        'erreur non identifiée convertie en erreur interne',
      );

      /**
       * LA VALEUR ÉTAIT DISPONIBLE POUR FUIR, et c'est ce qui donne son poids à tout ce qui
       * suit. Un journal qui ne porte pas le numéro parce que la base ne l'a jamais mis à
       * disposition est un journal chanceux, pas un journal épuré. La même écriture, jouée
       * ici en direct contre le pilote, montre ce que l'enveloppe de route avait entre les
       * mains : `detail` vaut « Failing row contains (uuid, nom, TYPE, numéro brut, numéro
       * normalisé, ...) », c'est-à-dire la ligne entière.
       */
      await database.owner.query('begin');
      let raised: unknown;
      try {
        raised = await captureFailure(() =>
          database.owner.query(
            `insert into public.organizations (name, type, registration_number)
             values ($1, 'FARM', $2)`,
            [name, registrationNumber],
          ),
        );
      } finally {
        await database.owner.query('rollback');
      }
      const driverFailure = describePostgresFailure(raised);
      expect(driverFailure.code, driverFailure.message).toBe('23514');
      expect(driverFailure.constraint).toBe('tmp_fuite_journal_creation');
      expect(
        driverFailure.detail,
        "l'erreur du pilote ne porte plus la ligne refusée : la sonde ne prouve plus rien",
      ).toContain(registrationNumber);

      /**
       * L'ERREUR EST ÉPURÉE, PAS ESCAMOTÉE. Les diagnostics de SCHÉMA — SQLSTATE, table,
       * contrainte — sont en clair dans le dépôt, ne dépendent d'aucune saisie, et un
       * exploitant doit pouvoir nommer la panne. Les exiger PRÉSENTS est ce qui distingue
       * « la ligne a été épurée » de « la ligne a disparu » : une erreur avalée rendrait
       * toutes les recherches de sentinelle ci-dessous vraies pour la mauvaise raison.
       */
      expect(
        output,
        "le SQLSTATE ne figure plus au journal : la panne n'est plus nommable",
      ).toContain('"code":"23514"');
      expect(output).toContain('"constraint":"tmp_fuite_journal_creation"');
      expect(output).toContain('"table":"organizations"');

      /**
       * ET AUCUN TEXTE LIBRE DU SERVEUR NE PASSE. Ces deux marqueurs sont les enveloppes des
       * deux fuites connues : `detail` porte la ligne refusée, et le message primaire recopie
       * la valeur reçue pour toute une famille d'erreurs. Les chercher par leur partie FIXE
       * les détecte même quand la valeur qu'ils transportent n'est pas celle de ce test.
       */
      expect(output, 'le champ `detail` du pilote a traversé le journaliseur').not.toContain(
        'Failing row contains',
      );
      expect(output, 'le message primaire du serveur a traversé le journaliseur').not.toContain(
        'violates check constraint',
      );

      for (const [label, sentinel] of [
        ['le numéro tel que saisi', registrationNumber],
        ['sa forme normalisée', registrationNumber.replaceAll('-', '')],
        ['sa forme minuscule', registrationNumber.toLowerCase()],
        ['le nom de la structure', name],
      ] as readonly (readonly [string, string])[]) {
        expect(output, `${label} a fuité dans les journaux`).not.toContain(sentinel);
      }
    } finally {
      await database.owner.query(
        'alter table public.organizations drop constraint if exists tmp_fuite_journal_creation',
      );
    }
  }, 90_000);

  /**
   * LE CHEMIN DE MODIFICATION, SYMÉTRIQUE DE CELUI DE LA CRÉATION.
   *
   * Les deux tests ci-dessus n'éprouvent que `POST`. Or `PATCH` partage le même schéma, la
   * même contrainte d'unicité et le même `catch` unique, et il porte un risque de plus : le
   * numéro qui fuirait n'est pas celui de l'appelant mais celui d'une organisation TIERCE,
   * qu'il vient de deviner en essayant. Sans ces deux tests, la moitié écrivante de la story
   * n'a aucune assertion sur ce qu'elle journalise.
   */
  it('ne journalise pas le numéro d une organisation tierce au refus de doublon en MODIFICATION', async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('journaux-patch');
    const actorId = await seedProfile(database.owner, { email });
    const session = await openSession(email);
    const holderId = await seedProfile(database.owner, { email: nextEmail('detenteur-patch') });
    const suffix = uniqueSuffix();
    const heldNumber = `SENTINELLE-DETENU-${suffix}`;
    const heldNormalized = `SENTINELLEDETENU${suffix}`;

    // L'organisation TIERCE, celle dont le numéro ne doit jamais transparaître nulle part.
    await createOrganization({
      actorUserId: holderId,
      origin: { ipAddress: '198.51.100.71', userAgent: USER_AGENT },
      payload: {
        name: `Structure detentrice ${suffix}`,
        type: 'ASSOCIATION',
        registrationNumber: heldNumber,
        clientEventId: randomUUID(),
      },
    });

    const mine = await createOrganization({
      actorUserId: actorId,
      origin: { ipAddress: '198.51.100.72', userAgent: USER_AGENT },
      payload: {
        name: `Structure modifiee ${suffix}`,
        type: 'COMPANY',
        registrationNumber: `FICTIF-ORG-${suffix}`,
        clientEventId: randomUUID(),
      },
    });

    // Forme SÉPARÉE du même numéro : c'est la normalisation qui tranche, et c'est aussi la
    // valeur que l'appelant a tapée — la journaliser reviendrait au même que journaliser
    // celle du détenteur, puisque les deux se normalisent en la même chaîne.
    const submitted = `sentinelle.detenu/${suffix}`;

    capture.clear();
    const refused = await updateOrganizationRoute(
      buildUpdateRequest({
        organizationId: mine.organization.id,
        cookie: session.cookie,
        body: { registrationNumber: submitted, expectedVersion: 1 },
      }),
    );
    expect(refused.status).toBe(400);
    const refusedBody = await refused.text();
    expect(refusedBody).toContain('VALIDATION_ERROR');
    expect(refusedBody).toContain('registrationNumber');
    expect(refusedBody, 'la réponse de refus nomme le numéro en conflit').not.toContain(heldNumber);

    const output = capture.raw;
    expect(output, "le refus de doublon en modification n'a pas été capturé").toContain(
      'immatriculation deja enregistree : modification refusee',
    );
    // Seul le NOM DE L'INDEX est journalisé, comme à la création : identifiant de schéma,
    // présent en clair dans le dépôt, suffisant pour diagnostiquer sans rien révéler.
    expect(output).toContain('uq_organizations_registration_number');

    // La valeur était disponible pour fuir : l'erreur que le pilote remonte sur CE conflit
    // porte la forme normalisée du numéro détenu par le tiers.
    await database.owner.query('begin');
    let raised: unknown;
    try {
      raised = await captureFailure(() =>
        database.owner.query(
          'update public.organizations set registration_number = $1 where id = $2',
          [submitted, mine.organization.id],
        ),
      );
    } finally {
      await database.owner.query('rollback');
    }
    const driverFailure = describePostgresFailure(raised);
    expect(driverFailure.code, driverFailure.message).toBe('23505');
    expect(driverFailure.detail, "l'erreur du pilote ne porte pas la valeur en conflit").toContain(
      heldNormalized,
    );

    for (const [label, sentinel] of [
      ['le numéro du détenteur', heldNumber],
      ['sa forme normalisée', heldNormalized],
      ['sa forme minuscule', heldNumber.toLowerCase()],
      ['la forme séparée soumise par l appelant', submitted],
    ] as readonly (readonly [string, string])[]) {
      expect(output, `${label} a fuité dans les journaux`).not.toContain(sentinel);
    }

    // Le refus n'a rien écrit : la fiche garde son numéro et sa version.
    const unchanged = await readOrganizationRow(database.owner, mine.organization.id);
    expect(unchanged.registration_number).toBe(`FICTIF-ORG-${suffix}`);
    expect(unchanged.version).toBe(1);
  }, 90_000);

  it("n'en journalise AUCUNE trace quand un SQLSTATE non reconnu remonte de la MODIFICATION", async (context) => {
    const database = databaseOrSkip(setup, context);
    const email = nextEmail('journaux-patch-500');
    const actorId = await seedProfile(database.owner, { email });
    const session = await openSession(email);
    const suffix = uniqueSuffix();
    const registrationNumber = `SENTINELLE-FUITE-PATCH-${suffix}`;
    const initialName = `Structure a renommer ${suffix}`;

    const mine = await createOrganization({
      actorUserId: actorId,
      origin: { ipAddress: '198.51.100.81', userAgent: USER_AGENT },
      payload: {
        name: initialName,
        type: 'FARM',
        registrationNumber,
        clientEventId: randomUUID(),
      },
    });

    // Même montage qu'à la création, sur la même table : l'organisation n'ayant déclaré aucun
    // périmètre, toute réécriture de sa ligne — y compris un simple changement de nom — bute
    // sur la contrainte. `NOT VALID` laisse les lignes déjà écrites tranquilles.
    await database.owner.query(
      `alter table public.organizations
         add constraint tmp_fuite_journal_modification check (territory_code is not null) not valid`,
    );

    try {
      capture.clear();
      const response = await updateOrganizationRoute(
        buildUpdateRequest({
          organizationId: mine.organization.id,
          cookie: session.cookie,
          body: { name: `Structure renommee ${suffix}`, expectedVersion: 1 },
        }),
      );

      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).toContain('INTERNAL_ERROR');
      expect(body, 'la réponse elle-même porte le numéro').not.toContain(registrationNumber);

      const output = capture.raw;
      expect(output, "le chemin d'erreur interne n'a pas été capturé").toContain(
        'erreur non identifiée convertie en erreur interne',
      );

      await database.owner.query('begin');
      let raised: unknown;
      try {
        raised = await captureFailure(() =>
          database.owner.query('update public.organizations set name = $1 where id = $2', [
            `Sonde ${suffix}`,
            mine.organization.id,
          ]),
        );
      } finally {
        await database.owner.query('rollback');
      }
      const driverFailure = describePostgresFailure(raised);
      expect(driverFailure.code, driverFailure.message).toBe('23514');
      expect(driverFailure.constraint).toBe('tmp_fuite_journal_modification');
      // La ligne REFUSÉE est celle d'après modification : elle porte le numéro déjà
      // enregistré, que l'appelant n'a même pas eu à envoyer pour le faire fuir.
      expect(
        driverFailure.detail,
        "l'erreur du pilote ne porte plus la ligne refusée : la sonde ne prouve plus rien",
      ).toContain(registrationNumber);

      expect(output).toContain('"code":"23514"');
      expect(output).toContain('"constraint":"tmp_fuite_journal_modification"');
      expect(output).toContain('"table":"organizations"');
      expect(output, 'le champ `detail` du pilote a traversé le journaliseur').not.toContain(
        'Failing row contains',
      );
      expect(output, 'le message primaire du serveur a traversé le journaliseur').not.toContain(
        'violates check constraint',
      );

      for (const [label, sentinel] of [
        ['le numéro enregistré', registrationNumber],
        ['sa forme normalisée', registrationNumber.replaceAll('-', '')],
        ['sa forme minuscule', registrationNumber.toLowerCase()],
        ['le nom d origine', initialName],
      ] as readonly (readonly [string, string])[]) {
        expect(output, `${label} a fuité dans les journaux`).not.toContain(sentinel);
      }

      // Rien n'a été écrit : la version et le nom d'origine tiennent.
      const unchanged = await readOrganizationRow(database.owner, mine.organization.id);
      expect(unchanged.name).toBe(initialName);
      expect(unchanged.version).toBe(1);
    } finally {
      await database.owner.query(
        'alter table public.organizations drop constraint if exists tmp_fuite_journal_modification',
      );
    }
  }, 90_000);
});

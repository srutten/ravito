import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { Client } from 'pg';
import type { DestinationStream } from 'pino';
import pino from 'pino';
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
  process.env.AUTH_SECRET = 'secret-de-test-fictif-refus-journalises-de-plus-de-32-caracteres';
  process.env.DATABASE_URL = 'postgresql://attente:attente@localhost:5432/attente';
  process.env.DATABASE_SSL = 'disable';
  process.env.DATABASE_POOL_MAX = '20';
});

import { isAppError } from '@/application/errors';
import type { OrganizationAccess } from '@/authorization/organization-access';
import { assertOrganizationVisible } from '@/authorization/organization-access';
import { buildSessionCookie } from '@/authorization/session-cookie';
import { resetServerConfigCache } from '@/config/env';
import type { CodeDelivery, SignInCodeMessage } from '@/domain/identity/code-delivery';
import { configureCodeDelivery, resetCodeDelivery } from '@/domain/identity/code-delivery';
import { requestSignInCode } from '@/domain/identity/request-sign-in-code';
import type { RequestOrigin } from '@/domain/identity/types';
import { verifySignInCode } from '@/domain/identity/verify-sign-in-code';
import { closePool, getPool } from '@/infrastructure/database/pool';
import type { OrganizationMemberRow } from '@/infrastructure/organizations/repository';
import { logger } from '@/observability/logger';
import {
  GET as readOrganizationRoute,
  PATCH as updateOrganizationRoute,
} from '../../app/api/v1/organizations/[organizationId]/route';
import type { DisposableDatabaseSetup } from './setup/database';
import { createDisposableDatabase, databaseOrSkip, NOT_PREPARED } from './setup/database';

// --- Journal détourné vers la mémoire ---------------------------------------------------------

const journalChunks: string[] = [];

const journal = {
  clear(): void {
    journalChunks.length = 0;
  },
  get raw(): string {
    return journalChunks.join('');
  },
};

/**
 * SEULE LA DESTINATION EST DOUBLÉE, ET C'EST LA CONDITION DE VALIDITÉ DE L'ASSERTION DE LISTE
 * BLANCHE PLUS BAS.
 *
 * Les autres fichiers d'intégration qui capturent le journal — `auth-logging.test.ts`,
 * `organizations-atomicity.test.ts` — remplacent `getRequestLogger` par une instance dépourvue de
 * contexte de requête. Cela leur suffit : ils CHERCHENT des sentinelles, et une valeur absente
 * d'une ligne appauvrie est absente de la ligne complète. Ici l'assertion est l'INVERSE — elle
 * FIGE l'ensemble des clés — et une ligne appauvrie la rend aveugle à la couche qui lui manque.
 * Mesuré : avec cette doublure-là, un champ ajouté à `buildRequestBindings`, donc présent sur
 * TOUTES les lignes de refus de production, laissait les sept tests de ce fichier verts, alors que
 * le même champ ajouté au site d'appel les faisait rougir. L'assertion mordait sur ce qu'elle
 * voyait au lieu de ce qu'elle prétendait garder.
 *
 * Le VRAI `getRequestLogger` est donc conservé, avec ses liaisons de requête, sa mémoïsation par
 * contexte et l'héritage des crochets ; seul le flux de sortie de l'instance racine est dérouté
 * vers la mémoire. `pino.symbols` est la surface que la bibliothèque expose pour ce genre de
 * greffe, et la substitution porte sur l'instance racine : les journaux enfants lisent leur flux
 * par la chaîne de prototypes, donc tous ceux que les requêtes mesurées ici font naître.
 *
 * RIEN D'AUTRE N'EST DOUBLÉ : la rédaction, les sérialiseurs, le formatage et le crochet de
 * message sont ceux du dépôt. Ce fichier prouve ce que le code écrit RÉELLEMENT, pas ce qu'il a
 * voulu écrire — un espion posé sur `warn` prouverait l'inverse.
 *
 * CONSÉQUENCE À CONNAÎTRE : `logger.level = 'silent'` est volontairement ABSENT du `beforeAll`,
 * contrairement aux autres fichiers d'intégration. Le poser viderait la capture.
 */
const journalDestination = new Writable({
  write(chunk: unknown, _encoding: string, callback: () => void): void {
    journalChunks.push(String(chunk));
    callback();
  },
});

/** Emplacement du flux de sortie dans une instance pino, tel que la bibliothèque le publie. */
interface PinoStreamSlot {
  [pino.symbols.streamSym]: DestinationStream;
}

const streamSlot = logger as unknown as PinoStreamSlot;
const originalDestination = streamSlot[pino.symbols.streamSym];
const originalLevel = logger.level;
streamSlot[pino.symbols.streamSym] = journalDestination;
logger.level = 'trace';

/**
 * LE MOTIF RÉEL D'UN REFUS, ÉPROUVÉ SUR LE JOURNAL RÉELLEMENT ÉMIS.
 *
 * CE QUE CE FICHIER TIENT, ET POURQUOI IL EXISTE. `docs/api-contract.md` ferme délibérément
 * l'oracle d'existence : un tiers curieux, un membre révoqué et un identifiant qui ne désigne rien
 * reçoivent la même réponse, octet pour octet. Cette fermeture a un prix — l'exploitation perd la
 * distinction en même temps que l'attaquant — et le contrat la paie par une promesse : « le journal
 * technique conserve le motif réel ». Tant que rien ne l'éprouve, cette promesse peut être tenue un
 * jour et perdue le lendemain sans qu'aucune porte ne rougisse ; c'est exactement ce qui s'était
 * produit, la phrase existant au contrat et nulle part dans le code.
 *
 * LA PROPRIÉTÉ EN UNE LIGNE : distinguer en interne sans jamais distinguer en externe. Les deux
 * moitiés doivent être vérifiées ENSEMBLE, et sur la même paire d'appels. Vérifier seulement la
 * première laisserait passer un correctif qui distingue aussi la réponse — c'est-à-dire qui rouvre
 * l'oracle en croyant tenir le contrat. Vérifier seulement la seconde laisserait passer le défaut
 * d'origine, où les deux causes se confondent partout.
 *
 * TROISIÈME MOITIÉ, ET ELLE COMPTE AUTANT : un journal qui recopierait le nom ou le numéro
 * d'immatriculation rouvrirait côté exploitation ce que la réponse ferme côté client. Le balayage
 * de sentinelles n'est pas décoratif ici — la ligne de l'organisation a été LUE par la requête qui
 * refuse, avant la garde et à dessein (`read-organization.ts`), donc son nom, son numéro et son
 * code territorial étaient tous en mémoire au moment où la ligne de journal a été écrite.
 *
 * POURQUOI EN INTÉGRATION ET NON EN UNITAIRE. Les motifs `MEMBERSHIP_*` dépendent de `is_effective`,
 * calculé par PostgreSQL dans la transaction qui lit. Une doublure de dépôt rendrait ce que le test
 * lui aurait soufflé ; seule une vraie base tranche la fenêtre de validité sur sa propre horloge.
 */

const APP_ORIGIN = 'https://appui-feux.exemple.test';
const HOST = 'appui-feux.exemple.test';
const USER_AGENT = 'Mozilla/5.0 (Android 14; Mobile; rv:141.0) Gecko/141.0 Firefox/141.0.2';
const FIXED_REQUEST_ID = 'req_00000000-0000-4000-8000-000000000000';
/** Message exact émis par `denyOrganizationAccess` : le figer rend la recherche non ambiguë. */
const DENIAL_MESSAGE = 'acces a une organisation refuse';
/** Gabarit de route posé par `defineRoute` : l'identifiant y est remplacé, jamais recopié. */
const DENIAL_ROUTE = '/api/v1/organizations/:id';

let setup: DisposableDatabaseSetup = NOT_PREPARED;
let addressCounter = 0;
let registrationCounter = 0;
const deliveries: SignInCodeMessage[] = [];

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

function uniqueSuffix(): string {
  return randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
}

/** Numéro fictif, unique par appel : l'unicité porte sur la forme normalisée du numéro. */
function nextRegistrationNumber(): string {
  registrationCounter += 1;
  return `FICTIF-ORG-J${String(registrationCounter).padStart(4, '0')}`;
}

// --- Journal capturé ------------------------------------------------------------------------

type LogRecord = Record<string, unknown>;

function parseLines(output: string): readonly LogRecord[] {
  return output
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LogRecord);
}

/**
 * Valeur textuelle d'un champ, ou un marqueur d'absence.
 *
 * Le marqueur est délibérément une valeur qui ne peut satisfaire aucune assertion : un `?? ''`
 * ferait passer pour vraie une comparaison portant sur un champ disparu.
 */
function readField(record: LogRecord, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : `[champ absent : ${key}]`;
}

interface Measured {
  readonly status: number;
  readonly text: string;
  /** Identifiant réel de la requête mesurée, tel que la réponse le rend à l'appelant. */
  readonly requestId: string;
  /** Corps exact, `requestId` figé : c'est la forme comparable octet à octet. */
  readonly normalizedBytes: Buffer;
  /** En-têtes triés, `x-request-id` figé : deux refus ne doivent pas s'y distinguer non plus. */
  readonly normalizedHeaders: string;
  /** Tout ce que le code a écrit au journal pendant CET appel, et rien d'autre. */
  readonly output: string;
  readonly denials: readonly LogRecord[];
}

/**
 * Joue un appel, isolé dans le journal.
 *
 * La capture est vidée JUSTE AVANT l'appel : ce que ce fichier mesure est la ligne écrite par la
 * requête observée, jamais la traînée des connexions et des préparations qui précèdent.
 */
async function measure(run: () => Promise<Response>): Promise<Measured> {
  journal.clear();
  const response = await run();
  const text = await response.text();
  const output = journal.raw;
  const requestId = response.headers.get('x-request-id') ?? '';
  const freeze = (value: string): string =>
    requestId.length > 0 ? value.split(requestId).join(FIXED_REQUEST_ID) : value;
  const headers = [...response.headers.entries()]
    .map(([name, value]) => `${name}: ${freeze(value)}`)
    .sort()
    .join('\n');
  return {
    status: response.status,
    text,
    requestId,
    normalizedBytes: Buffer.from(freeze(text), 'utf8'),
    normalizedHeaders: headers,
    output,
    denials: parseLines(output).filter((record) => record.msg === DENIAL_MESSAGE),
  };
}

/**
 * La ligne de refus de l'appel mesuré, et il doit y en avoir exactement une.
 *
 * « Exactement une » n'est pas une coquetterie : zéro ligne est le défaut que ce fichier corrige,
 * et deux lignes fausseraient tout comptage de la métrique « refus d'autorisation ».
 */
function singleDenial(measured: Measured, label: string): LogRecord {
  expect(measured.denials, `${label} : une ligne de refus et une seule`).toHaveLength(1);
  const [first] = measured.denials;
  if (first === undefined) {
    throw new Error(`${label} : aucune ligne de refus capturée`);
  }
  return first;
}

function errorOf(measured: Measured): Record<string, unknown> {
  const parsed = JSON.parse(measured.text) as { readonly error?: Record<string, unknown> };
  return parsed.error ?? {};
}

// --- Préparation des données ----------------------------------------------------------------

async function seedProfile(client: Client, email: string): Promise<string> {
  const { rows } = await client.query<{ readonly id: string }>(
    `insert into public.user_profiles (display_name, email, preferred_language, verification_level, status)
     values ('Camille D.', $1, 'fr', 'CONTACT_VERIFIED', 'ACTIVE')
     returning id`,
    [email],
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
 * `createOrganization` impose une adhésion `ORG_ADMIN` effective au créateur : aucun chemin
 * applicatif ne produit une adhésion suspendue, expirée ou datée du futur. Ce sont pourtant
 * exactement les états dont ce fichier doit prouver qu'ils portent des motifs distincts.
 */
async function seedOrganization(
  client: Client,
  input: {
    readonly name?: string;
    readonly registrationNumber?: string;
    readonly territoryCode?: string | null;
  } = {},
): Promise<string> {
  const { rows } = await client.query<{ readonly id: string }>(
    `insert into public.organizations (name, type, registration_number, territory_code)
     values ($1, 'COMPANY', $2, $3)
     returning id`,
    [
      input.name ?? 'Structure fictive de controle',
      input.registrationNumber ?? nextRegistrationNumber(),
      input.territoryCode === undefined ? 'ZZ-DEMO-01' : input.territoryCode,
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
 * `now()` du serveur est la seule horloge qui décide : c'est elle qui évalue `is_effective`. Poser
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

/** Vocabulaire FERMÉ, écrit par le test lui-même : l'interpoler après ce filtre reste sûr. */
function quoteMemberStatus(status: string): string {
  const allowed = ['INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED'];
  if (!allowed.includes(status)) {
    throw new Error(`statut d adhésion inconnu : ${status}`);
  }
  return `'${status}'`;
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

interface Actor {
  readonly userId: string;
  readonly cookie: string;
}

/** Session réelle, obtenue par le parcours de US-010 : la route n'en accepte pas d'autre. */
async function createActor(client: Client, label: string): Promise<Actor> {
  const email = nextEmail(label);
  const userId = await seedProfile(client, email);
  const origin = nextOrigin();
  const challenge = await requestSignInCode({ identifier: email, origin });
  const code = await waitForCode(challenge.challengeId);
  const verified = await verifySignInCode({ challengeId: challenge.challengeId, code, origin });
  return { userId, cookie: buildSessionCookie(verified.sessionToken).split(';')[0] ?? '' };
}

function buildRequest(input: {
  readonly organizationId: string;
  readonly method: string;
  readonly cookie: string;
  readonly body?: unknown;
}): Request {
  addressCounter += 1;
  const headers = new Headers({
    host: HOST,
    origin: APP_ORIGIN,
    'x-forwarded-for': `198.51.100.${(addressCounter % 250) + 1}`,
    'user-agent': USER_AGENT,
    cookie: input.cookie,
  });
  const serialized = input.body === undefined ? undefined : JSON.stringify(input.body);
  if (serialized !== undefined) {
    headers.set('content-type', 'application/json');
  }
  return new Request(`${APP_ORIGIN}/api/v1/organizations/${input.organizationId}`, {
    method: input.method,
    headers,
    ...(serialized !== undefined ? { body: serialized } : {}),
  });
}

function readOrganization(organizationId: string, actor: Actor): Promise<Measured> {
  return measure(() =>
    readOrganizationRoute(buildRequest({ organizationId, method: 'GET', cookie: actor.cookie })),
  );
}

function patchOrganization(organizationId: string, actor: Actor, body: unknown): Promise<Measured> {
  return measure(() =>
    updateOrganizationRoute(
      buildRequest({ organizationId, method: 'PATCH', cookie: actor.cookie, body }),
    ),
  );
}

async function readVersion(client: Client, organizationId: string): Promise<number> {
  const { rows } = await client.query<{ readonly version: number }>(
    'select version from public.organizations where id = $1',
    [organizationId],
  );
  return rows[0]?.version ?? -1;
}

beforeAll(async () => {
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
    // Ouvrir les connexions à l'avance : sur une base conteneurisée, leur coût dépasse le délai
    // d'obtention du pilote et transformerait un échec métier en « timeout when connecting ».
    await Promise.all(Array.from({ length: 8 }, () => getPool().query('select 1')));
  }
}, 120_000);

afterAll(async () => {
  resetCodeDelivery();
  await closePool();
  if (setup.available) {
    await setup.database.dispose();
  }
  // Le flux d'origine est RENDU en dernier : ce fichier a modifié une instance partagée du
  // processus, et la fermeture du pool journalise encore. Restaurer plus tôt enverrait ces
  // lignes-là sur la sortie standard, au milieu du compte rendu de la suite.
  streamSlot[pino.symbols.streamSym] = originalDestination;
  logger.level = originalLevel;
});

describe('lecture refusée — deux causes, deux motifs, une seule réponse', () => {
  it('sépare « n existe pas » de « pas membre » au journal, sans les séparer d un octet dans la réponse', async (context) => {
    const database = databaseOrSkip(setup, context);
    const outsider = await createActor(database.owner, 'lecture-tiers');
    const organizationId = await seedOrganization(database.owner);
    const unknownId = randomUUID();

    const absent = await readOrganization(unknownId, outsider);
    const foreign = await readOrganization(organizationId, outsider);

    const absentDenial = singleDenial(absent, 'identifiant inconnu');
    const foreignDenial = singleDenial(foreign, 'organisation étrangère');

    // LES DEUX APPELS ONT BIEN ÉTÉ REFUSÉS, ET DE LA MÊME FAÇON. Sans ce préalable, l'égalité
    // d'octets qui suit pourrait être celle de deux réponses accordées, ou de deux corps vides.
    expect(absent.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(errorOf(absent).code).toBe('NOT_FOUND');
    expect(errorOf(foreign).code).toBe('NOT_FOUND');
    expect(errorOf(foreign).details).toStrictEqual({});

    // MOITIÉ INTERNE : le journal distingue.
    expect(readField(absentDenial, 'reason')).toBe('ORGANIZATION_ABSENT');
    expect(readField(foreignDenial, 'reason')).toBe('MEMBERSHIP_ABSENT');
    expect(
      readField(absentDenial, 'reason'),
      'les deux causes doivent porter deux motifs différents : c est toute la contrepartie',
    ).not.toBe(readField(foreignDenial, 'reason'));

    // MOITIÉ EXTERNE : la réponse ne distingue rien, corps ET en-têtes.
    expect(Buffer.compare(absent.normalizedBytes, foreign.normalizedBytes)).toBe(0);
    expect(absent.normalizedHeaders).toBe(foreign.normalizedHeaders);
    expect(absent.text).not.toContain(organizationId);

    // L'identifiant journalisé est celui que l'appelant a demandé : sans lui, mille identifiants
    // balayés seraient indiscernables d'un lien mort rechargé mille fois.
    expect(readField(absentDenial, 'organizationId')).toBe(unknownId);
    expect(readField(foreignDenial, 'organizationId')).toBe(organizationId);
    expect(readField(absentDenial, 'errorCode')).toBe('NOT_FOUND');
    expect(readField(foreignDenial, 'errorCode')).toBe('NOT_FOUND');
  }, 60_000);

  it('donne un motif propre à chaque état d adhésion, la réponse restant celle d un inconnu', async (context) => {
    const database = databaseOrSkip(setup, context);
    const member = await createActor(database.owner, 'lecture-etats');
    const organizationId = await seedOrganization(database.owner);
    await seedMembership(database.owner, {
      organizationId,
      userId: member.userId,
      role: 'OBSERVER',
    });

    // Référence : le même appelant, sur un identifiant qui ne désigne rien. Toutes les réponses
    // ci-dessous doivent lui être identiques au bit près.
    const reference = await readOrganization(randomUUID(), member);
    expect(reference.status).toBe(404);

    const cases: readonly (readonly [string, () => Promise<void>, string])[] = [
      [
        'adhésion préparée mais jamais acceptée',
        () =>
          setMembership(database.owner, {
            organizationId,
            userId: member.userId,
            status: 'INVITED',
          }),
        'MEMBERSHIP_INVITED',
      ],
      [
        'adhésion coupée après incident',
        () =>
          setMembership(database.owner, {
            organizationId,
            userId: member.userId,
            status: 'SUSPENDED',
          }),
        'MEMBERSHIP_SUSPENDED',
      ],
      [
        'adhésion retirée définitivement',
        () =>
          setMembership(database.owner, {
            organizationId,
            userId: member.userId,
            status: 'REVOKED',
          }),
        'MEMBERSHIP_REVOKED',
      ],
      [
        'prise de fonction datée du futur',
        () =>
          setMembership(database.owner, {
            organizationId,
            userId: member.userId,
            status: 'ACTIVE',
            validFromSql: "now() + interval '1 hour'",
            validUntilSql: 'null',
          }),
        'MEMBERSHIP_NOT_YET_OPEN',
      ],
      [
        'échéance dépassée',
        () =>
          setMembership(database.owner, {
            organizationId,
            userId: member.userId,
            status: 'ACTIVE',
            validFromSql: "now() - interval '2 days'",
            validUntilSql: "now() - interval '1 second'",
          }),
        'MEMBERSHIP_EXPIRED',
      ],
    ];

    const observed: string[] = [];
    for (const [label, mutate, expectedReason] of cases) {
      await mutate();
      const refused = await readOrganization(organizationId, member);
      const denial = singleDenial(refused, label);

      expect(refused.status, label).toBe(404);
      expect(readField(denial, 'reason'), label).toBe(expectedReason);
      expect(readField(denial, 'errorCode'), label).toBe('NOT_FOUND');
      // LA RÉPONSE NE BOUGE PAS D'UN OCTET pendant que le motif change cinq fois. C'est la
      // propriété entière du contrat, prise dans les deux sens à la fois.
      expect(Buffer.compare(refused.normalizedBytes, reference.normalizedBytes), label).toBe(0);
      expect(refused.normalizedHeaders, label).toBe(reference.normalizedHeaders);
      observed.push(readField(denial, 'reason'));
    }

    // ANTI-EFFONDREMENT : un correctif qui journaliserait un motif unique — « REFUSÉ » — passerait
    // toutes les assertions d'existence ci-dessus si elles étaient écrites plus mollement. Ici, cinq
    // états doivent donner cinq valeurs deux à deux distinctes.
    expect(new Set(observed).size, 'les cinq états doivent donner cinq motifs distincts').toBe(
      observed.length,
    );
  }, 90_000);
});

describe('modification refusée — le rôle et l adhésion ne se confondent pas', () => {
  it('journalise trois motifs pour trois causes, sans rien écrire ni rien distinguer côté appelant', async (context) => {
    const database = databaseOrSkip(setup, context);
    const outsider = await createActor(database.owner, 'patch-tiers');
    const contributor = await createActor(database.owner, 'patch-contributeur');
    const organizationId = await seedOrganization(database.owner);
    await seedMembership(database.owner, {
      organizationId,
      userId: contributor.userId,
      role: 'CONTRIBUTOR',
    });
    const body = { name: 'Structure fictive renommee', expectedVersion: 1 };

    const byOutsider = await patchOrganization(organizationId, outsider, body);
    const byContributor = await patchOrganization(organizationId, contributor, body);
    await setMembership(database.owner, {
      organizationId,
      userId: contributor.userId,
      status: 'SUSPENDED',
    });
    const bySuspended = await patchOrganization(organizationId, contributor, body);

    // Un non-membre n'apprend rien : `NOT_FOUND`, comme en lecture.
    expect(byOutsider.status).toBe(404);
    expect(readField(singleDenial(byOutsider, 'non-membre'), 'reason')).toBe('MEMBERSHIP_ABSENT');

    // Les deux autres reçoivent `FORBIDDEN` : ils savent déjà que l'organisation existe. La
    // réponse est la même pour tous les deux, alors que la conduite à tenir diffère — accorder un
    // rôle, ou réactiver une adhésion. C'est le journal, et lui seul, qui les sépare.
    const roleDenial = singleDenial(byContributor, 'rôle insuffisant');
    const suspendedDenial = singleDenial(bySuspended, 'adhésion suspendue');
    expect(byContributor.status).toBe(403);
    expect(bySuspended.status).toBe(403);
    expect(readField(roleDenial, 'reason')).toBe('ROLE_NOT_ALLOWED');
    expect(readField(suspendedDenial, 'reason')).toBe('MEMBERSHIP_SUSPENDED');
    expect(readField(roleDenial, 'errorCode')).toBe('FORBIDDEN');
    expect(readField(suspendedDenial, 'errorCode')).toBe('FORBIDDEN');
    expect(Buffer.compare(byContributor.normalizedBytes, bySuspended.normalizedBytes)).toBe(0);
    expect(byContributor.normalizedHeaders).toBe(bySuspended.normalizedHeaders);

    // Un refus ne laisse aucune trace en base : la version n'a pas bougé.
    expect(await readVersion(database.owner, organizationId)).toBe(1);
  }, 90_000);
});

describe('ce que la ligne de refus ne porte jamais', () => {
  it('ne recopie ni le nom, ni le numéro d immatriculation, ni le code territorial', async (context) => {
    const database = databaseOrSkip(setup, context);
    const outsider = await createActor(database.owner, 'sentinelles');
    const suffix = uniqueSuffix();
    const name = `Structure SENTINELLE-NOM-${suffix}`;
    const registrationNumber = `SENTINELLE-IMMAT-${suffix}`;
    const territoryCode = `ZZ-SENT-${suffix.slice(0, 6)}`;
    const organizationId = await seedOrganization(database.owner, {
      name,
      registrationNumber,
      territoryCode,
    });

    const refused = await readOrganization(organizationId, outsider);
    const denial = singleDenial(refused, 'organisation étrangère');

    /**
     * LES TROIS SENTINELLES ÉTAIENT EN MÉMOIRE AU MOMENT DE L'ÉCRITURE, et c'est ce qui donne son
     * poids à ce balayage. `readOrganization` lit la ligne complète de l'organisation AVANT de
     * consulter la garde — délibérément, pour que le travail effectué soit le même que l'appelant
     * ait le droit ou non. Nom, numéro et code territorial étaient donc tous disponibles pour
     * fuir ; aucun ne doit être sorti.
     */
    expect(refused.output, 'la ligne de refus doit avoir été capturée').toContain(DENIAL_MESSAGE);
    for (const [label, sentinel] of [
      ['le nom de la structure', name],
      ['le numéro d immatriculation', registrationNumber],
      ['le code territorial', territoryCode],
    ] as readonly (readonly [string, string])[]) {
      expect(refused.output, `${label} a fuité dans les journaux`).not.toContain(sentinel);
    }

    /**
     * LISTE BLANCHE PLUTÔT QUE LISTE NOIRE. Chercher trois sentinelles connues ne dit rien du
     * champ que quelqu'un ajoutera demain. Figer l'ENSEMBLE des clés de la ligne oblige à repasser
     * par ce test pour en ajouter une, quelle qu'elle soit — c'est la seule forme d'assertion qui
     * tienne sur une propriété de confidentialité, dont la violation prend toujours la forme d'un
     * champ que personne n'avait prévu.
     *
     * LES TREIZE CLÉS SONT CELLES DE LA PRODUCTION, ET C'EST TOUT LE SUJET. Elles viennent de
     * QUATRE couches, qu'il faut nommer parce que chacune est un endroit d'où un champ de trop
     * peut sortir : le socle du journaliseur (`service`, `environment`, `version`), son
     * horodatage et son niveau (`time`, `level`), les LIAISONS DE REQUÊTE posées par
     * `buildRequestBindings` (`requestId`, `route`, `method`), et enfin le site d'appel
     * `denyOrganizationAccess` (`module`, `organizationId`, `errorCode`, `reason`) avec son
     * message. Une version antérieure de ce fichier doublait `getRequestLogger` par une instance
     * sans contexte de requête : elle figeait dix clés, la troisième couche lui échappait
     * entièrement, et un champ ajouté à `buildRequestBindings` — donc à toutes les lignes de
     * refus de production — passait sans faire rougir quoi que ce soit. Ne doubler que la
     * destination est ce qui rend cette assertion vraie.
     */
    expect(Object.keys(denial).sort()).toStrictEqual(
      [
        'environment',
        'errorCode',
        'level',
        'method',
        'module',
        'msg',
        'organizationId',
        'reason',
        'requestId',
        'route',
        'service',
        'time',
        'version',
      ].sort(),
    );

    /**
     * LA VALEUR DES TROIS CLÉS DE REQUÊTE EST VÉRIFIÉE, PAS SEULEMENT LEUR PRÉSENCE.
     *
     * Compter les clés prouve qu'une couche existe ; le corréler à la réponse prouve que c'est
     * bien LE journaliseur de la requête mesurée qui a écrit la ligne, et non une instance de
     * confort qui porterait par hasard les mêmes noms. C'est la garde qui manquait : sans elle,
     * réintroduire une doublure de `getRequestLogger` qui recopierait trois champs plausibles
     * suffirait à rendre le compte juste et l'assertion creuse.
     *
     * `route` est en outre une propriété de confidentialité à part entière : le gabarit remplace
     * l'identifiant par `:id` (`normalizeRoute`), si bien que la ligne ne porte l'identifiant
     * consulté qu'une fois, sous la clé prévue pour cela.
     */
    expect(readField(denial, 'requestId')).toBe(refused.requestId);
    expect(readField(denial, 'route')).toBe(DENIAL_ROUTE);
    expect(readField(denial, 'method')).toBe('GET');
  }, 60_000);

  it('ne journalise RIEN quand l accès est accordé', async (context) => {
    const database = databaseOrSkip(setup, context);
    const member = await createActor(database.owner, 'acces-accorde');
    const organizationId = await seedOrganization(database.owner);
    await seedMembership(database.owner, {
      organizationId,
      userId: member.userId,
      role: 'ORG_ADMIN',
    });

    const accepted = await readOrganization(organizationId, member);

    expect(accepted.status).toBe(200);
    // LE NIVEAU N'A DE SENS QUE S'IL NE NOIE RIEN. Une ligne de refus émise sur un accès accordé
    // rendrait toute alerte de seuil inutilisable dès le premier jour de trafic normal.
    expect(accepted.denials, 'un accès accordé n écrit aucune ligne de refus').toHaveLength(0);
    expect(accepted.output).not.toContain(DENIAL_MESSAGE);
  }, 60_000);
});

describe('niveau de journalisation et étiquetage de la fenêtre', () => {
  it('émet le motif au niveau warn, celui où le refus lui-même est déjà visible', async (context) => {
    const database = databaseOrSkip(setup, context);
    const outsider = await createActor(database.owner, 'niveau');
    const organizationId = await seedOrganization(database.owner);

    const refused = await readOrganization(organizationId, outsider);
    const denial = singleDenial(refused, 'organisation étrangère');

    /**
     * POURQUOI CETTE ASSERTION EST UNE VRAIE ASSERTION. `logOutcome` écrit déjà la sortie de
     * requête en `warn` pour tout 4xx. Un motif journalisé en `info` ou en `debug` disparaîtrait de
     * tout déploiement réglé sur `warn`, qui conserverait alors les refus sans leur cause —
     * c'est-à-dire le défaut d'origine, avec en plus l'apparence d'être outillé. Le niveau fait
     * donc partie du contrat, au même titre que le champ.
     */
    expect(readField(denial, 'level')).toBe('warn');
    const outcome = parseLines(refused.output).find((record) => record.msg === 'requête refusée');
    if (outcome === undefined) {
      throw new Error(
        "la ligne de sortie de requête n'a pas été capturée : comparaison impossible",
      );
    }
    expect(
      readField(denial, 'level'),
      'le motif ne doit pas être moins visible que le refus lui-même',
    ).toBe(readField(outcome, 'level'));
  }, 60_000);

  it('retombe sur un motif neutre quand l horloge du processus ne corrobore pas le serveur', () => {
    /**
     * LE SEUL MONTAGE OÙ CE CAS EST ATTEIGNABLE. `is_effective` est calculé par PostgreSQL ; le
     * motif de fenêtre est étiqueté par l'horloge du processus. Les deux peuvent se contredire —
     * horloges désynchronisées, machine virtuelle réveillée d'une suspension. On construit ici
     * exactement cette contradiction : le serveur a dit « non effective », le processus voit une
     * fenêtre grande ouverte.
     *
     * CE QUE LE CODE JUSTE FAIT : il refuse d'inventer une borne et rend `MEMBERSHIP_OUT_OF_WINDOW`.
     * CE QUE LE CODE FAUX FERAIT : il trancherait quand même, et l'exploitation partirait chercher
     * une échéance mal saisie qui n'existe pas. Un motif moins précis coûte une hésitation ; un
     * motif faux coûte une enquête.
     *
     * Aucune base n'est nécessaire : ce test s'exécute même quand les autres sautent.
     */
    const organizationId = randomUUID();
    const membership: OrganizationMemberRow = {
      organization_id: organizationId,
      user_id: randomUUID(),
      role: 'CONTRIBUTOR',
      status: 'ACTIVE',
      valid_from: new Date(Date.now() - 3_600_000),
      valid_until: new Date(Date.now() + 3_600_000),
      created_at: new Date(),
      updated_at: new Date(),
      // Le verdict du SERVEUR, et il fait foi. L'horloge du processus dit l'inverse.
      is_effective: false,
    };
    const access: OrganizationAccess = {
      organizationId,
      userId: membership.user_id,
      membership,
      effectiveMembership: null,
      isPlatformAdmin: false,
    };

    journal.clear();
    let refused = false;
    try {
      assertOrganizationVisible(access);
    } catch (error) {
      refused = isAppError(error) && error.code === 'NOT_FOUND';
    }
    const denials = parseLines(journal.raw).filter((record) => record.msg === DENIAL_MESSAGE);

    expect(refused, 'la garde doit refuser : c est le serveur qui a tranché, pas l horloge').toBe(
      true,
    );
    expect(denials).toHaveLength(1);
    const [denial] = denials;
    if (denial === undefined) {
      throw new Error('aucune ligne de refus capturée : la garde n a rien journalisé');
    }
    expect(readField(denial, 'reason')).toBe('MEMBERSHIP_OUT_OF_WINDOW');
  });
});

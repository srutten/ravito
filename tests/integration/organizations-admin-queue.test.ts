import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Voir l'en-tête de `auth-identity-flow.test.ts` : l'environnement précède les imports, plusieurs
 * modules du domaine lisant la configuration au chargement. `DATABASE_URL` reçoit ici une valeur
 * d'attente ; `beforeAll` la remplace par celle de la base jetable avant qu'aucun pool ne s'ouvre.
 */
vi.hoisted(() => {
  process.env.APP_ENV = 'local';
  process.env.APP_VERSION = '0.0.0-test';
  process.env.LOG_LEVEL = 'error';
  process.env.AUTH_SECRET = 'secret-de-test-fictif-file-administration-de-plus-de-32-caracteres';
  process.env.DATABASE_URL = 'postgresql://attente:attente@localhost:5432/attente';
  process.env.DATABASE_SSL = 'disable';
  process.env.DATABASE_POOL_MAX = '20';
});

/**
 * Destination en mémoire du journal, partagée avec la doublure ci-dessous. Créée dans un bloc
 * hoisté : la fabrique de `vi.mock` s'exécute avant le corps du fichier.
 */
const journal = vi.hoisted(() => {
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
 * TOUTE la journalisation part en mémoire, à `trace`. Même montage que
 * `organizations-refus-journal.test.ts` et `organizations-atomicity.test.ts`.
 *
 * LA DOUBLURE N'EST PAS UN ESPION : c'est un vrai `pino` construit par la fabrique du dépôt, donc
 * avec la même rédaction, les mêmes sérialiseurs et le même formatage. Un espion sur `info`
 * prouverait ce que le code a VOULU écrire ; le balayage de sentinelles doit porter sur ce qui est
 * RÉELLEMENT sorti.
 *
 * CONSÉQUENCE ASSUMÉE, ET C'EST UNE LIMITE CONNUE DE CE MONTAGE : `getRequestLogger` est remplacé,
 * donc les liaisons de requête — `requestId`, `route`, `method` — n'apparaissent pas dans les
 * lignes capturées, alors que la production les porte. Aucune assertion de ce fichier n'énumère
 * donc les clés d'une ligne de journal : elle figerait un jeu de clés que la production n'a pas.
 * Ce qui est éprouvé ici est la PRÉSENCE et la VALEUR des champs écrits par le domaine, et
 * l'ABSENCE de toute donnée de la file — cette seconde moitié, elle, est insensible aux liaisons.
 *
 * `logger.level = 'silent'` est volontairement ABSENT du `beforeAll` : il viderait la capture. La
 * sortie du test reste silencieuse pour autant, puisque tout est écrit en mémoire.
 */
vi.mock('@/observability/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/observability/logger')>();
  const destination = new Writable({
    write(chunk: unknown, _encoding: string, callback: () => void): void {
      journal.chunks.push(String(chunk));
      callback();
    },
  });
  const instrumented = actual.createLogger({ level: 'trace', destination });
  return { ...actual, logger: instrumented, getRequestLogger: (): unknown => instrumented };
});

import { resetServerConfigCache } from '@/config/env';
import type { CodeDelivery, SignInCodeMessage } from '@/domain/identity/code-delivery';
import { configureCodeDelivery, resetCodeDelivery } from '@/domain/identity/code-delivery';
import { ORGANIZATION_MEMBER_ROLES } from '@/domain/organizations/types';
import { closePool, getPool } from '@/infrastructure/database/pool';
import { pseudonymizeUserId } from '@/observability/request-context';
import { GET as pendingOrganizationsRoute } from '../../app/api/v1/admin/organizations/pending/route';
import { POST as requestCodeRoute } from '../../app/api/v1/auth/codes/route';
import { POST as openSessionRoute } from '../../app/api/v1/auth/sessions/route';
import type { DisposableDatabaseSetup } from './setup/database';
import { createDisposableDatabase, databaseOrSkip, NOT_PREPARED } from './setup/database';

/**
 * `GET /api/v1/admin/organizations/pending` — la file de validation, éprouvée par sa route.
 *
 * POURQUOI CETTE ROUTE MÉRITE SON PROPRE FICHIER. Elle est le seul écran du lot qui rende des
 * données appartenant à des organisations dont l'appelant n'est pas membre, et le seul qui nomme
 * une personne — le déposant. Deux garanties s'y jouent donc en même temps : un contrôle d'accès
 * réservé à `PLATFORM_ADMIN` (`docs/permissions.md`, « Valider une organisation »), et la
 * minimisation de `docs/privacy-rgpd.md`.
 *
 * L'INTERFACE NE PROTÈGE RIEN. La coquille authentifiée masque le lien à qui n'est pas
 * administrateur et la page rend un écran de refus, mais l'un et l'autre relèvent de l'honnêteté
 * d'interface. « Appel direct d'une route masquée par l'interface » est un cas de test OBLIGATOIRE
 * de `docs/permissions.md` : c'est ici, et nulle part ailleurs, que le refus est décidé.
 *
 * LA MINIMISATION SE VÉRIFIE EN CHERCHANT, PAS EN RAISONNANT. Constater l'absence des clés
 * `email` et `phone` dans le corps ne prouverait rien de durable : un champ ajouté demain à la
 * ligne de file, ou un nom de clé différent, passerait sans être vu. Le test insère donc des
 * valeurs qu'il connaît, relit la LIGNE ENTIÈRE du profil du demandeur en base, et cherche chacune
 * de ses valeurs dans la réponse sérialisée. Seul le nom d'affichage a le droit d'y figurer.
 * Le balayage porte sur ce qui DÉSIGNE une personne — coordonnées et identifiants —, jamais sur
 * les colonnes d'état : voir `PROFILE_STATE_COLUMNS`, où le partage est justifié. L'ajout d'un
 * champ à la projection, lui, est gardé par l'énumération exacte des clés de la ligne.
 *
 * TOTALITÉ DE LA FILE. `totalCount` compte toutes les organisations en attente de la base, sans
 * plafonnement : les tests qui portent sur le contenu de la file remettent donc la base à zéro,
 * hors de l'organisation qui porte la fonction d'administrateur. Une comparaison relative
 * laisserait passer une ligne parasite comptée deux fois.
 */

const ORIGIN = 'https://appui-feux.exemple.test';
const HOST = 'appui-feux.exemple.test';
const COOKIE_NAME = 'appui_feux_session';
const FIXED_REQUEST_ID = 'req_00000000-0000-4000-8000-000000000000';

/** Taille de page du domaine (`list-pending-organizations.ts`). */
const PAGE_SIZE = 25;

/**
 * Longueur en deçà de laquelle une valeur du profil ne peut pas servir de sentinelle.
 *
 * L'étiquette de langue « fr » mesure deux caractères : la chercher dans une réponse produirait un
 * faux positif au premier identifiant ou horodatage qui la contiendrait par hasard. Elle est donc
 * écartée du balayage — et sa divulgation ne serait de toute façon pas celle d'une coordonnée.
 */
const MIN_SENTINEL_LENGTH = 4;

/**
 * Colonnes d'ÉTAT du profil, écartées du balayage de minimisation.
 *
 * CE QUE LA FILE DOIT TAIRE, ce sont les COORDONNÉES du déposant et ses identifiants de
 * rattachement — `email`, `phone`, `auth_user_id`, `id` —, catégories nommées comme telles par
 * docs/privacy-rgpd.md. `status`, `verification_level` et `preferred_language` ne désignent
 * personne : ce sont des états de compte, que la file pourrait un jour afficher légitimement,
 * puisqu'elle existe précisément pour qu'un administrateur apprécie le sérieux d'un dépôt. Les
 * deux horodatages sont du même ordre, et leur valeur risque de surcroît de se retrouver par
 * coïncidence dans une réponse qui date les dépôts.
 *
 * SANS CETTE RESTRICTION, LE BALAYAGE CRIERAIT « FUITE » SUR UNE ÉVOLUTION NORMALE. Le jour où la
 * ligne de file porterait le statut du demandeur, le test échouerait sur
 * « demandeur.status a fuité dans la file d administration: … 'ACTIVE' » — un faux positif rédigé
 * comme une violation de confidentialité, donc cru, donc coûteux. Un test qui se trompe sur la
 * NATURE de ce qu'il signale est plus nuisible qu'un test absent.
 *
 * CE QUI GARDE LA PROPRIÉTÉ N'EST PAS AFFAIBLI POUR AUTANT. L'énumération exacte des clés de la
 * ligne, plus bas, rougit AVANT ce balayage dès qu'un champ apparaît dans la projection, quel
 * qu'il soit. Tout ajout reste donc arbitré ; ce qui change est qu'il se lit comme un ajout de
 * champ et non comme une fuite de coordonnée. Une colonne AJOUTÉE demain à `user_profiles` reste,
 * elle, balayée : la liste ci-dessous est fermée, le balayage ne l'est pas.
 */
const PROFILE_STATE_COLUMNS: readonly string[] = [
  'status',
  'verification_level',
  'preferred_language',
  'created_at',
  'updated_at',
];

let setup: DisposableDatabaseSetup = NOT_PREPARED;
const deliveries: SignInCodeMessage[] = [];
let addressCounter = 0;
let registrationCounter = 0;
let sentinelCounter = 0;

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
  return `FICTIF-ORG-B${String(registrationCounter).padStart(4, '0')}`;
}

/** Téléphone fictif au format E.164, unique : la colonne porte un index unique. */
function nextPhone(): string {
  sentinelCounter += 1;
  return `+3360000${String(sentinelCounter).padStart(4, '0')}`;
}

interface CallOptions {
  readonly path: string;
  readonly cookie?: string | undefined;
}

function buildRequest(options: CallOptions): Request {
  const headers = new Headers({ host: HOST, origin: ORIGIN });
  headers.set('x-forwarded-for', nextAddress());
  headers.set(
    'user-agent',
    'Mozilla/5.0 (Android 14; Mobile; rv:141.0) Gecko/141.0 Firefox/141.0.2',
  );
  if (options.cookie !== undefined) {
    headers.set('cookie', `${COOKIE_NAME}=${options.cookie}`);
  }
  return new Request(`${ORIGIN}${options.path}`, { method: 'GET', headers });
}

interface Captured {
  readonly status: number;
  readonly text: string;
  readonly json: Record<string, unknown>;
  /** Corps exact, `requestId` figé : c'est la forme comparable octet à octet. */
  readonly normalizedBytes: Buffer;
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
  };
}

function errorOf(captured: Captured): Record<string, unknown> {
  return (captured.json.error ?? {}) as Record<string, unknown>;
}

interface QueueItem {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly registrationNumber: string;
  readonly territoryCode: string | null;
  readonly createdAt: string;
  readonly requestedBy: { readonly displayName: string | null };
}

function itemsOf(captured: Captured): readonly QueueItem[] {
  return (captured.json.items ?? []) as readonly QueueItem[];
}

async function warmPool(connections: number): Promise<void> {
  const pool = getPool();
  await Promise.all(Array.from({ length: connections }, () => pool.query('select 1')));
}

interface ProfileInput {
  readonly email: string;
  readonly displayName?: string;
  readonly phone?: string;
  readonly authUserId?: string;
}

async function seedProfile(client: Client, input: ProfileInput): Promise<string> {
  const { rows } = await client.query<{ readonly id: string }>(
    `insert into public.user_profiles
       (display_name, email, phone, auth_user_id, preferred_language, verification_level, status)
     values ($1, $2, $3, $4, 'fr', 'CONTACT_VERIFIED', 'ACTIVE')
     returning id`,
    [input.displayName ?? 'Camille D.', input.email, input.phone ?? null, input.authUserId ?? null],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("le profil de test n'a pas été créé");
  }
  return row.id;
}

/**
 * Organisation écrite EN SQL DIRECT.
 *
 * `createOrganization` impose `PENDING`, `ACTIVE` et l'instant courant : elle ne permet ni de
 * fabriquer une organisation déjà validée ou refusée, ni de dater son dépôt. Or c'est exactement ce
 * qu'un test d'ordre et de filtrage doit poser. La connexion propriétaire de la base jetable est le
 * seul moyen de le faire.
 */
async function seedOrganization(
  client: Client,
  input: {
    readonly name?: string;
    readonly type?: string;
    readonly registrationNumber?: string;
    readonly territoryCode?: string | null;
    readonly verificationStatus?: string;
    readonly status?: string;
    /** Horodatage de dépôt, en ISO 8601. `undefined` laisse le défaut `now()`. */
    readonly createdAt?: string;
    /**
     * Identifiant imposé. `undefined` laisse le défaut `gen_random_uuid()`.
     *
     * Le tri de la file est `(created_at, id)` : `id` est donc un CRITÈRE, et un identifiant
     * tiré au sort rend indécidable tout cas où deux lignes se départagent par lui. Un test
     * qui doit éprouver ce départage pose ses identifiants, sinon il passe une fois sur deux.
     */
    readonly id?: string;
  } = {},
): Promise<string> {
  const { rows } = await client.query<{ readonly id: string }>(
    `insert into public.organizations
       (id, name, type, registration_number, territory_code, verification_status, status, created_at)
     values (coalesce($8::uuid, gen_random_uuid()),
             $1, $2::public.organization_type, $3, $4,
             $5::public.organization_verification_status,
             $6::public.organization_status,
             coalesce($7::timestamptz, now()))
     returning id`,
    [
      input.name ?? 'Structure fictive en attente',
      input.type ?? 'COMPANY',
      input.registrationNumber ?? nextRegistrationNumber(),
      input.territoryCode === undefined ? 'ZZ-DEMO-01' : input.territoryCode,
      input.verificationStatus ?? 'PENDING',
      input.status ?? 'ACTIVE',
      input.createdAt ?? null,
      input.id ?? null,
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
 * Remet la base à l'état où seules les organisations conservées subsistent.
 *
 * `totalCount` est le compte RÉEL de toutes les organisations en attente : sans cette remise à
 * zéro, un test d'ordre ou de pagination compterait aussi celles des tests précédents. La clé
 * étrangère de `organization_members` est déclarée sans action en cascade, les adhésions partent
 * donc en premier.
 */
async function purgeOrganizationsExcept(client: Client, keep: readonly string[]): Promise<void> {
  await client.query(
    'delete from public.organization_members where organization_id <> all($1::uuid[])',
    [keep],
  );
  await client.query('delete from public.organizations where id <> all($1::uuid[])', [keep]);
}

/**
 * Nombre de dépôts posés pour éprouver la pagination : deux pages, la seconde incomplète.
 *
 * Une seconde page incomplète est la seule qui prouve les deux bouts à la fois — que le curseur
 * reprend au bon endroit, et qu'il dit « plus rien après » au lieu de promettre une page vide.
 */
const PAGINATION_FIXTURE_COUNT = PAGE_SIZE + 2;

/**
 * Instant de dépôt du nᵉ dépôt de référence, PORTEUR DE MICROSECONDES.
 *
 * CE QUE CES INSTANTS RÉPARENT. Ce test datait ses dépôts sur des minutes rondes
 * (`Date.UTC(2026, 1, 1, 6, index)`), c'est-à-dire sur les seuls instants où la troncature à la
 * milliseconde ne retire RIEN. Il déclarait donc la pagination correcte pendant que la
 * production la cassait, et il serait resté vert quoi qu'on corrige. `created_at` est un
 * `timestamptz`, dont la résolution est la MICROSECONDE : un jeu de référence qui n'en porte
 * aucune n'éprouve pas la colonne qu'il prétend paginer. Toute organisation réelle en porte une
 * — mesuré : les quatre organisations de la base de développement ont une fraction
 * sub-milliseconde non nulle.
 *
 * LE DÉPÔT QUI CLÔT LA PREMIÈRE PAGE (rang `PAGE_SIZE - 1`) EST LE PIVOT : c'est de lui que le
 * curseur est tiré. Sa fraction, `…137` microsecondes, n'est pas un multiple de mille ; un
 * curseur reconstruit depuis une `Date` JavaScript lui est donc STRICTEMENT INFÉRIEUR, et la
 * comparaison stricte du dépôt le resert en tête de la page suivante.
 *
 * LE DÉPÔT SUIVANT PARTAGE SA MILLISECONDE et ne s'en distingue que par la microseconde. Ce
 * second piège vise la correction PLAUSIBLE MAIS FAUSSE : arrondir des deux côtés. Les deux
 * dépôts deviennent alors ex aequo sur la première clé et se départagent par leur identifiant —
 * que `paginationId` place à dessein dans l'ordre INVERSE de l'ordre chronologique. Mesuré :
 * arrondir dans le seul `WHERE` fait DISPARAÎTRE le dépôt suivant, arrondir aussi dans le tri
 * rend les deux dépôts dans le DÉSORDRE. Les deux issues sont rouges, et la première est la
 * plus grave — une ligne rendue deux fois se remarque, une ligne jamais rendue ne se remarque
 * pas.
 */
function paginationInstant(index: number): string {
  const boundary = index === PAGE_SIZE;
  const minute = boundary ? PAGE_SIZE - 1 : index;
  const microseconds = boundary ? (PAGE_SIZE - 1) * 1000 + 783 : index * 1000 + 137;
  const paddedMinute = String(minute).padStart(2, '0');
  const paddedMicroseconds = String(microseconds).padStart(6, '0');
  return `2026-02-01T06:${paddedMinute}:00.${paddedMicroseconds}Z`;
}

/**
 * Identifiant du nᵉ dépôt de référence.
 *
 * IMPOSÉ, ET DANS UN ORDRE CHOISI. Les deux dépôts qui partagent une milliseconde reçoivent
 * leurs rangs ÉCHANGÉS : l'identifiant du second est INFÉRIEUR à celui du premier. Sans cette
 * inversion, une pagination tronquée à la milliseconde les départagerait par identifiant dans
 * le bon ordre une fois sur deux, et le test serait instable au lieu d'être discriminant.
 */
function paginationId(index: number): string {
  let rank = index;
  if (index === PAGE_SIZE - 1) {
    rank = PAGE_SIZE;
  } else if (index === PAGE_SIZE) {
    rank = PAGE_SIZE - 1;
  }
  return `a5f01200-0000-4000-8000-${String(rank).padStart(12, '0')}`;
}

/**
 * Ouvre le curseur rendu par la route.
 *
 * ASSERTION EN BOÎTE BLANCHE, ASSUMÉE. Le curseur est opaque pour un client, et il doit le
 * rester ; mais le défaut corrigé ici est une PERTE DE PRÉCISION dans ce que le curseur
 * transporte, et l'éprouver de l'extérieur seulement reviendrait à ne l'éprouver que là où il
 * produit un doublon — c'est-à-dire à dépendre du jeu de données pour voir la cause. Cette
 * lecture nomme la cause. Si l'encodage du curseur change — signature, autre séparateur — cette
 * fonction doit être relue EN MÊME TEMPS que `encodeCursor`, et non contournée.
 */
function openCursor(cursor: string): { readonly instant: string; readonly id: string } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = decoded.indexOf('|');
  if (separator <= 0) {
    throw new Error(`curseur illisible pour le test : ${decoded}`);
  }
  return { instant: decoded.slice(0, separator), id: decoded.slice(separator + 1) };
}

/**
 * Message exact émis par la trace de consultation (`list-pending-organizations.ts`).
 *
 * Le figer rend la recherche non ambiguë : c'est par lui que la ligne se retrouve dans un journal
 * qui en porte d'autres, et un message renommé sans être relu ici ferait rougir le fichier.
 */
const CONSULTATION_MESSAGE = 'consultation de la file des organisations en attente';

/**
 * Niveau attendu de la ligne, tel que le formateur du dépôt l'écrit — en toutes lettres et non
 * sous la forme numérique de pino, comme le montrent les exemples de `docs/observability.md`.
 *
 * `info` ET NON `warn` : une consultation servie est un fait NOMINAL, et `docs/observability.md`
 * fonde sur les lignes `warn` la métrique « refus d'autorisation » et l'alerte « hausse d'accès
 * refusés ». Y verser un événement normal, émis à chaque ouverture d'écran, fausserait l'alerte
 * au lieu de l'outiller.
 */
const CONSULTATION_LEVEL = 'info';

function journalLines(): readonly Record<string, unknown>[] {
  return journal.raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function consultationLines(): readonly Record<string, unknown>[] {
  return journalLines().filter((line) => line.msg === CONSULTATION_MESSAGE);
}

/** Ligne complète du profil, telle que la base la porte : la source du balayage de sentinelles. */
async function readProfileRow(client: Client, userId: string): Promise<Record<string, unknown>> {
  const { rows } = await client.query<{ readonly row: Record<string, unknown> }>(
    'select to_jsonb(p) as row from public.user_profiles p where p.id = $1',
    [userId],
  );
  const row = rows[0]?.row;
  if (row === undefined) {
    throw new Error('profil introuvable pour le balayage de sentinelles');
  }
  return row;
}

/**
 * Toutes les valeurs textuelles de la ligne, sauf celles explicitement admises.
 *
 * CETTE FORME RÉSISTE À L'AJOUT D'UNE COLONNE. Énumérer `email` et `phone` à la main figerait le
 * test sur l'état d'aujourd'hui de `user_profiles` : une colonne ajoutée demain — un contact de
 * secours, un identifiant de rattachement — échapperait au contrôle et pourrait fuiter sans qu'un
 * seul test rougisse. Le balayage part de la ligne réelle, donc de toutes ses colonnes, moins les
 * colonnes d'état énumérées par `PROFILE_STATE_COLUMNS` et pour la raison qui y est écrite.
 */
function sentinelsOf(
  row: Record<string, unknown>,
  allowed: readonly string[],
): readonly [string, string][] {
  return Object.entries(row)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .filter(([column]) => !PROFILE_STATE_COLUMNS.includes(column))
    .filter(([, value]) => value.length >= MIN_SENTINEL_LENGTH && !allowed.includes(value));
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
      new Request(`${ORIGIN}/api/v1/auth/codes`, {
        method: 'POST',
        headers: new Headers({
          host: HOST,
          origin: ORIGIN,
          'content-type': 'application/json',
          'x-forwarded-for': address,
        }),
        body: JSON.stringify({ identifier: email }),
      }),
    ),
  );
  const challengeId = String(requested.json.challengeId);
  const code = await waitForCode(challengeId);
  const response = await openSessionRoute(
    new Request(`${ORIGIN}/api/v1/auth/sessions`, {
      method: 'POST',
      headers: new Headers({
        host: HOST,
        origin: ORIGIN,
        'content-type': 'application/json',
        'x-forwarded-for': address,
      }),
      body: JSON.stringify({ challengeId, code }),
    }),
  );
  const cookie = readCookieValue(response.headers.get('set-cookie'));
  if (response.status !== 201 || cookie.length === 0) {
    throw new Error(`ouverture de session refusée : ${await response.text()}`);
  }
  return cookie;
}

async function readQueue(cookie: string | undefined, query = ''): Promise<Captured> {
  return capture(
    await pendingOrganizationsRoute(
      buildRequest({ path: `/api/v1/admin/organizations/pending${query}`, cookie }),
    ),
  );
}

interface PlatformAdmin {
  readonly cookie: string;
  readonly userId: string;
  /** Organisation qui PORTE la fonction. Validée, donc jamais présente dans la file elle-même. */
  readonly carrierId: string;
}

let platformAdmin: PlatformAdmin | undefined;

/**
 * Administrateur de plateforme du fichier, créé une seule fois.
 *
 * Son organisation porteuse est `VERIFIED` pour deux raisons. Elle ne doit pas apparaître dans la
 * file, sans quoi chaque assertion de contenu devrait l'exclure à la main ; et `hasPlatformAdminRole`
 * exige qu'elle soit `ACTIVE`, condition que les purges ne doivent jamais lui retirer.
 */
async function ensurePlatformAdmin(client: Client): Promise<PlatformAdmin> {
  if (platformAdmin !== undefined) {
    return platformAdmin;
  }
  const email = nextEmail('administrateur-plateforme');
  const userId = await seedProfile(client, { email, displayName: 'Alix R.' });
  const carrierId = await seedOrganization(client, {
    name: 'Autorite fictive de la plateforme',
    type: 'OPERATIONAL_SERVICE',
    verificationStatus: 'VERIFIED',
  });
  await seedMembership(client, { organizationId: carrierId, userId, role: 'PLATFORM_ADMIN' });
  const cookie = await signInThroughRoutes(email);
  platformAdmin = { cookie, userId, carrierId };
  return platformAdmin;
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
    await warmPool(10);
  }
}, 120_000);

/**
 * La capture repart à zéro AVANT chaque test, jamais après.
 *
 * Vider en `afterEach` laisserait le premier test d'un fichier lire les lignes de la préparation,
 * et un test qui échoue laisserait sa capture à son voisin. Le nettoyage appartient à celui qui
 * s'apprête à mesurer.
 */
beforeEach(() => {
  journal.clear();
});

afterAll(async () => {
  resetCodeDelivery();
  await closePool();
  if (setup.available) {
    await setup.database.dispose();
  }
});

describe('GET /api/v1/admin/organizations/pending — accès', () => {
  it('refuse sans session, et refuse pareil quel que soit le cookie présenté', async (context) => {
    databaseOrSkip(setup, context);

    const noCookie = await readQueue(undefined);
    const inventedCookie = await readQueue('jeton-invente-sans-aucune-existence-AZ09');

    // ROUTE PROTÉGÉE APPELÉE DIRECTEMENT : cas de test obligatoire de docs/permissions.md. La
    // barrière de session est résolue avant le gestionnaire, donc avant toute lecture de la file.
    expect(noCookie.status).toBe(401);
    expect(errorOf(noCookie).code).toBe('UNAUTHENTICATED');
    expect(errorOf(noCookie).details).toStrictEqual({});
    expect(inventedCookie.status).toBe(401);
    expect(Buffer.compare(inventedCookie.normalizedBytes, noCookie.normalizedBytes)).toBe(0);
  }, 60_000);

  it('réserve la file au rôle PLATFORM_ADMIN : tout autre rôle reçoit FORBIDDEN, jamais NOT_FOUND', async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = await ensurePlatformAdmin(database.owner);
    const organizationId = await seedOrganization(database.owner, {
      name: 'Structure fictive de controle des roles',
    });

    // LES QUATRE AUTRES RÔLES DU RÉFÉRENTIEL, énumérés depuis la source et non recopiés : un rôle
    // ajouté demain à `organization_member_role` ferait échouer ce test tant qu'il n'aurait pas été
    // arbitré, ce qui est le sens sûr. L'ordre de déclaration n'est pas une hiérarchie :
    // `OBSERVER` figure en dernier et reste le rôle le MOINS capable.
    const otherRoles = ORGANIZATION_MEMBER_ROLES.filter((role) => role !== 'PLATFORM_ADMIN');
    const refusals: Captured[] = [];
    for (const role of otherRoles) {
      const email = nextEmail(`role-${role.toLowerCase()}`);
      const userId = await seedProfile(database.owner, { email });
      await seedMembership(database.owner, { organizationId, userId, role });
      const cookie = await signInThroughRoutes(email);
      const response = await readQueue(cookie);

      expect(response.status, `rôle ${role}`).toBe(403);
      expect(errorOf(response).code, `rôle ${role}`).toBe('FORBIDDEN');
      refusals.push(response);
    }

    // Compte sans aucune adhésion : le refus doit être le même. Distinguer « membre au mauvais
    // rôle » de « membre de rien » dirait à un appelant refusé ce qu'il est par ailleurs.
    const strangerEmail = nextEmail('role-sans-adhesion');
    await seedProfile(database.owner, { email: strangerEmail });
    const stranger = await readQueue(await signInThroughRoutes(strangerEmail));
    const admitted = await readQueue(admin.cookie);

    expect(stranger.status).toBe(403);
    for (const refusal of refusals) {
      expect(Buffer.compare(refusal.normalizedBytes, stranger.normalizedBytes)).toBe(0);
    }
    expect(admitted.status).toBe(200);
  }, 180_000);
});

describe('GET /api/v1/admin/organizations/pending — contenu et ordre', () => {
  it('ne contient QUE les organisations en attente, quel que soit l état de leur fiche', async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = await ensurePlatformAdmin(database.owner);
    await purgeOrganizationsExcept(database.owner, [admin.carrierId]);

    const waitingActive = await seedOrganization(database.owner, { name: 'En attente et active' });
    const waitingSuspended = await seedOrganization(database.owner, {
      name: 'En attente et suspendue',
      status: 'SUSPENDED',
    });
    const waitingClosed = await seedOrganization(database.owner, {
      name: 'En attente et fermee',
      status: 'CLOSED',
    });
    const verified = await seedOrganization(database.owner, {
      name: 'Deja validee',
      verificationStatus: 'VERIFIED',
    });
    const rejected = await seedOrganization(database.owner, {
      name: 'Deja refusee',
      verificationStatus: 'REJECTED',
    });

    const queue = await readQueue(admin.cookie);
    const listed = itemsOf(queue).map((item) => item.id);

    expect(queue.status).toBe(200);
    // LES DEUX AXES SONT INDÉPENDANTS (docs/api-contract.md) : une fiche suspendue ou fermée reste
    // en attente de validation. La retirer de la file la rendrait invisible à l'administrateur qui
    // doit précisément décider de son sort.
    expect([...listed].sort()).toStrictEqual(
      [waitingActive, waitingSuspended, waitingClosed].sort(),
    );
    expect(listed).not.toContain(verified);
    expect(listed).not.toContain(rejected);
    expect(listed).not.toContain(admin.carrierId);
    // `totalCount` est le compte RÉEL, non plafonné : il porte la même sélection que la page.
    expect(queue.json.totalCount).toBe(3);
    expect(queue.json.nextCursor).toBeNull();
  }, 60_000);

  it('rend la file du plus ancien au plus récent, l identifiant départageant les ex aequo', async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = await ensurePlatformAdmin(database.owner);
    await purgeOrganizationsExcept(database.owner, [admin.carrierId]);

    // Horodatages fictifs et FIXES, posés dans le désordre d'insertion : l'ordre rendu ne peut donc
    // pas venir de l'ordre d'écriture, seul le tri déclaré peut le produire.
    const newest = await seedOrganization(database.owner, {
      name: 'Depot du 14 janvier',
      createdAt: '2026-01-14T08:00:00.000Z',
    });
    const tieFirst = await seedOrganization(database.owner, {
      name: 'Depot du 12 janvier, premier',
      createdAt: '2026-01-12T08:00:00.000Z',
    });
    const oldest = await seedOrganization(database.owner, {
      name: 'Depot du 9 janvier',
      createdAt: '2026-01-09T08:00:00.000Z',
    });
    const tieSecond = await seedOrganization(database.owner, {
      name: 'Depot du 12 janvier, second',
      createdAt: '2026-01-12T08:00:00.000Z',
    });
    const middle = await seedOrganization(database.owner, {
      name: 'Depot du 10 janvier',
      createdAt: '2026-01-10T08:00:00.000Z',
    });

    const queue = await readQueue(admin.cookie);

    // UNE FILE TRIÉE PAR NOUVEAUTÉ LAISSERAIT AU FOND CELLES QUE PERSONNE N'A TRAITÉES, donc
    // exactement celles qui attendent depuis le plus longtemps.
    //
    // PostgreSQL compare un `uuid` sur ses seize octets ; la forme canonique en hexadécimal
    // minuscule ordonne ses caractères dans le même sens, la comparaison de chaînes reproduit donc
    // fidèlement le départage attendu pour les deux dépôts du 12 janvier.
    const tieOrdered = [tieFirst, tieSecond].sort();
    expect(itemsOf(queue).map((item) => item.id)).toStrictEqual([
      oldest,
      middle,
      ...tieOrdered,
      newest,
    ]);
    // Sans le second critère, deux dépôts du même instant s'ordonneraient au gré du plan
    // d'exécution et la pagination en sauterait un ou le rendrait deux fois.
    expect(itemsOf(queue).map((item) => item.createdAt)).toStrictEqual([
      '2026-01-09T08:00:00.000Z',
      '2026-01-10T08:00:00.000Z',
      '2026-01-12T08:00:00.000Z',
      '2026-01-12T08:00:00.000Z',
      '2026-01-14T08:00:00.000Z',
    ]);
  }, 60_000);

  it('pagine par curseur sans sauter ni répéter une seule ligne, sur des dépôts datés à la microseconde', async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = await ensurePlatformAdmin(database.owner);
    await purgeOrganizationsExcept(database.owner, [admin.carrierId]);

    const total = PAGINATION_FIXTURE_COUNT;
    const expectedOrder: string[] = [];
    for (let index = 0; index < total; index += 1) {
      expectedOrder.push(
        await seedOrganization(database.owner, {
          name: `Depot fictif numero ${index + 1}`,
          createdAt: paginationInstant(index),
          id: paginationId(index),
        }),
      );
    }

    // TÉMOIN, AVANT TOUTE ASSERTION : la base porte bien la microseconde. Sans lui, un
    // arrondi survenu à l'écriture — pilote, format d'entrée, colonne de résolution moindre —
    // rendrait toutes les assertions qui suivent vraies pour la mauvaise raison, exactement le
    // défaut que ce test vient de refermer.
    const { rows: precision } = await database.owner.query<{ readonly sub_millisecond: number }>(
      `select (count(*) filter (where date_part('microsecond', created_at)::int % 1000 <> 0))::int
                as sub_millisecond
         from public.organizations
        where verification_status = 'PENDING'`,
    );
    expect(precision[0]?.sub_millisecond).toBe(total);

    const first = await readQueue(admin.cookie);
    const cursor = String(first.json.nextCursor);
    const second = await readQueue(admin.cookie, `?cursor=${encodeURIComponent(cursor)}`);

    expect(first.status).toBe(200);
    expect(itemsOf(first)).toHaveLength(PAGE_SIZE);
    expect(first.json.nextCursor).not.toBeNull();
    // LE COMPTEUR NE SE DÉDUIT PAS DE LA PAGE. Un compteur borné par la pagination serait
    // exactement le « 99+ » que docs/screens.md interdit : il cacherait la situation qu'il signale.
    expect(first.json.totalCount).toBe(total);

    // LE CURSEUR PORTE LA POSITION EXACTE DE LA LIGNE QUI CLÔT LA PAGE, microsecondes comprises.
    // C'est la cause du défaut, nommée : un curseur tiré d'une `Date` JavaScript s'arrêterait à
    // la milliseconde, serait donc STRICTEMENT INFÉRIEUR à sa propre ligne, et la comparaison
    // stricte du dépôt resservirait cette ligne en tête de la page suivante.
    const boundary = openCursor(cursor);
    expect(boundary.instant).toBe(paginationInstant(PAGE_SIZE - 1));
    expect(boundary.id).toBe(paginationId(PAGE_SIZE - 1));

    // ET IL N'EST PAS RECONSTRUCTIBLE DEPUIS LA RÉPONSE : `createdAt` est rendu en ISO 8601 à la
    // milliseconde par le contrat, donc arrondi. Les deux valeurs DIFFÈRENT, et c'est la preuve
    // que le curseur ne passe pas par le champ affiché.
    const lastOfFirst = itemsOf(first)[PAGE_SIZE - 1];
    expect(lastOfFirst?.id).toBe(paginationId(PAGE_SIZE - 1));
    expect(lastOfFirst?.createdAt).toBe(new Date(paginationInstant(PAGE_SIZE - 1)).toISOString());
    expect(boundary.instant).not.toBe(lastOfFirst?.createdAt);

    expect(second.status).toBe(200);
    expect(itemsOf(second)).toHaveLength(total - PAGE_SIZE);
    // LA LIGNE QUI A PRODUIT LE CURSEUR N'EST PAS RESSERVIE. Assertion nominative : compter les
    // lignes suffirait à voir le doublon, mais pas à dire laquelle, ni pourquoi.
    expect(itemsOf(second).map((item) => item.id)).toStrictEqual([
      paginationId(PAGE_SIZE),
      paginationId(PAGE_SIZE + 1),
    ]);
    expect(itemsOf(second).map((item) => item.id)).not.toContain(paginationId(PAGE_SIZE - 1));
    // Dernière page : plus rien après, et le curseur le dit au lieu de promettre une page vide.
    expect(second.json.nextCursor).toBeNull();
    expect(second.json.totalCount).toBe(total);

    const walked = [...itemsOf(first), ...itemsOf(second)].map((item) => item.id);
    // Les trois assertions ne font pas double emploi, et chacune répond à une correction
    // plausible mais fausse — les trois issues ont été mesurées sur ce jeu de référence :
    // la longueur voit le DOUBLON (curseur tronqué, comparaison exacte : trois lignes au lieu
    // de deux), l'ensemble voit l'OUBLI (troncature dans le seul `WHERE` : une seule ligne),
    // l'égalité stricte voit le DÉSORDRE (troncature dans le tri aussi : les deux dépôts de la
    // milliseconde partagée sont rendus dans l'ordre de leur identifiant).
    expect(walked).toHaveLength(total);
    expect(new Set(walked).size).toBe(total);
    expect(walked).toStrictEqual(expectedOrder);
  }, 120_000);

  it('refuse un curseur illisible plutôt que de rendre une page vide', async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = await ensurePlatformAdmin(database.owner);
    await purgeOrganizationsExcept(database.owner, [admin.carrierId]);
    const organizationId = await seedOrganization(database.owner, {
      name: 'Depot fictif de reference',
      createdAt: '2026-03-04T09:00:00.000Z',
    });

    const withoutSeparator = Buffer.from('sans-separateur', 'utf8').toString('base64url');
    const withoutUuid = Buffer.from('2026-03-04T09:00:00.000Z|pas-un-uuid', 'utf8').toString(
      'base64url',
    );
    const refusals = [
      ['hors alphabet du curseur', 'curseur inventé avec des espaces'],
      ['trop long', 'a'.repeat(513)],
      ['sans séparateur', withoutSeparator],
      ['identifiant non conforme', withoutUuid],
    ] as const;

    for (const [label, cursor] of refusals) {
      const response = await readQueue(admin.cookie, `?cursor=${encodeURIComponent(cursor)}`);

      // RÉPONDRE « PLUS RIEN À TRAITER » À UN ADMINISTRATEUR DONT LE CURSEUR A ÉTÉ TRONQUÉ lui
      // ferait croire la file épuisée : le refus est une erreur de saisie, jamais une page vide.
      expect(response.status, label).toBe(400);
      expect(errorOf(response).code, label).toBe('VALIDATION_ERROR');
      expect(errorOf(response).details, label).toStrictEqual({ fields: ['cursor'] });
    }

    // Un curseur BIEN FORMÉ mais forgé reste sans effet de droit : il ne fait que sauter des lignes
    // que l'appelant avait déjà le droit de lire. Opaque ne veut pas dire secret.
    const forged = Buffer.from(`2020-01-01T00:00:00.000Z|${randomUUID()}`, 'utf8').toString(
      'base64url',
    );
    const forgedResponse = await readQueue(admin.cookie, `?cursor=${encodeURIComponent(forged)}`);
    expect(forgedResponse.status).toBe(200);
    expect(itemsOf(forgedResponse).map((item) => item.id)).toStrictEqual([organizationId]);
  }, 60_000);

  it('CONSTAT : un curseur invalide est refusé AVANT le contrôle de rôle', async (context) => {
    const database = databaseOrSkip(setup, context);
    await ensurePlatformAdmin(database.owner);
    const email = nextEmail('curseur-sans-fonction');
    await seedProfile(database.owner, { email });
    const cookie = await signInThroughRoutes(email);

    const badCursor = await readQueue(cookie, '?cursor=curseur%20invalide');
    const goodCursor = await readQueue(cookie);

    // CONSTAT, PAS SOUHAIT. `decodeCursor` s'exécute dans `listPendingOrganizations` avant
    // `withTransaction`, donc avant `assertPlatformAdministrator` : un appelant sans fonction
    // d'administrateur obtient `VALIDATION_ERROR` là où il obtiendrait `FORBIDDEN` avec un curseur
    // correct. Rien de la file n'est divulgué — la forme du curseur est documentée par
    // `docs/api-contract.md` et l'adresse de la route aussi — mais l'ordre des deux contrôles est
    // l'inverse de celui qu'un refus par défaut suggérerait. Ce test fige l'état réel ; si l'ordre
    // devait être inversé, il doit être relu EN MÊME TEMPS que la commande.
    expect(badCursor.status).toBe(400);
    expect(errorOf(badCursor).code).toBe('VALIDATION_ERROR');
    expect(goodCursor.status).toBe(403);
    expect(errorOf(goodCursor).code).toBe('FORBIDDEN');
  }, 60_000);
});

describe('GET /api/v1/admin/organizations/pending — minimisation', () => {
  it('ne laisse sortir du demandeur QUE son nom d affichage, aucune autre valeur de son profil', async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = await ensurePlatformAdmin(database.owner);
    await purgeOrganizationsExcept(database.owner, [admin.carrierId]);

    const requesterDisplayName = 'Sentinelle Demandeur R7X2';
    const requesterId = await seedProfile(database.owner, {
      email: nextEmail('demandeur-file'),
      displayName: requesterDisplayName,
      phone: nextPhone(),
      authUserId: `sentinelle-fournisseur-K3M8-${randomUUID().slice(0, 8)}`,
    });
    // SECOND MEMBRE : rien de lui ne doit sortir, pas même son nom. La file nomme le déposant,
    // elle n'est pas la liste des membres, qui relève d'US-014.
    const colleagueId = await seedProfile(database.owner, {
      email: nextEmail('collegue-file'),
      displayName: 'Sentinelle Collegue W4T9',
      phone: nextPhone(),
      authUserId: `sentinelle-collegue-P2N6-${randomUUID().slice(0, 8)}`,
    });
    const organizationId = await seedOrganization(database.owner, {
      name: 'Exploitation fictive du Val',
      type: 'FARM',
      // Le numéro porte des séparateurs : sa forme NORMALISÉE, qui porte l'unicité, est donc une
      // chaîne distincte que la réponse ne doit jamais exposer.
      registrationNumber: 'FICTIF-ORG-9001/7',
      territoryCode: 'ZZ-DEMO-07',
      createdAt: '2026-02-20T07:30:00.000Z',
    });
    await seedMembership(database.owner, {
      organizationId,
      userId: requesterId,
      role: 'ORG_ADMIN',
    });
    await seedMembership(database.owner, {
      organizationId,
      userId: colleagueId,
      role: 'COORDINATOR',
    });

    const queue = await readQueue(admin.cookie);
    const item = itemsOf(queue)[0];

    expect(queue.status).toBe(200);
    expect(itemsOf(queue)).toHaveLength(1);
    // La ligne porte ce sur quoi la décision se fonde, et le nom du déposant. Rien d'autre : un
    // champ ajouté à la projection ferait échouer cette assertion avant d'atteindre le balayage.
    expect(Object.keys(item ?? {}).sort()).toStrictEqual([
      'createdAt',
      'id',
      'name',
      'registrationNumber',
      'requestedBy',
      'territoryCode',
      'type',
    ]);
    expect(Object.keys(item?.requestedBy ?? {})).toStrictEqual(['displayName']);
    expect(item?.requestedBy.displayName).toBe(requesterDisplayName);
    // Le balayage ne vaut que si la ligne est réellement là : sans cette preuve, une réponse vide
    // passerait toutes les assertions d'absence qui suivent.
    expect(queue.text).toContain(requesterDisplayName);
    expect(queue.text).toContain('FICTIF-ORG-9001/7');

    const requesterRow = await readProfileRow(database.owner, requesterId);
    const colleagueRow = await readProfileRow(database.owner, colleagueId);
    const forbidden = [
      ...sentinelsOf(requesterRow, [requesterDisplayName]).map(
        ([column, value]) => [`demandeur.${column}`, value] as const,
      ),
      ...sentinelsOf(colleagueRow, []).map(
        ([column, value]) => [`collegue.${column}`, value] as const,
      ),
      ['immatriculation normalisée', 'FICTIFORG90017'] as const,
      ["identifiant d'organisation porteuse", admin.carrierId] as const,
      ['jeton de session', admin.cookie] as const,
    ];

    // Le balayage doit être SUBSTANTIEL : courriel, téléphone, identifiant de fournisseur et
    // identifiant de compte, pour deux profils. Un balayage réduit à deux valeurs ne prouverait
    // presque rien.
    expect(forbidden.length).toBeGreaterThanOrEqual(10);
    // ET IL DOIT ENCORE PORTER LES COLONNES QUI COMPTENT. Écarter des colonnes d'état ne vaut que
    // si celles qui désignent une personne y sont toujours : sans cette vérification, une faute de
    // frappe dans `PROFILE_STATE_COLUMNS` — ou son élargissement distrait — viderait le balayage de
    // sa substance en silence, et les assertions d'absence ci-dessous deviendraient vraies par
    // construction. C'est la contrepartie explicite de la restriction.
    expect(forbidden.map(([label]) => label)).toEqual(
      expect.arrayContaining([
        'demandeur.id',
        'demandeur.auth_user_id',
        'demandeur.email',
        'demandeur.phone',
        'collegue.id',
        'collegue.auth_user_id',
        'collegue.display_name',
        'collegue.email',
        'collegue.phone',
      ]),
    );
    for (const [label, value] of forbidden) {
      expect(queue.text, `${label} a fuité dans la file d administration`).not.toContain(value);
    }
  }, 60_000);

  it('dit l absence de demandeur au lieu de l inventer, et nomme encore une adhésion révoquée', async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = await ensurePlatformAdmin(database.owner);
    await purgeOrganizationsExcept(database.owner, [admin.carrierId]);

    const orphan = await seedOrganization(database.owner, {
      name: 'Depot fictif sans administrateur',
      createdAt: '2026-04-01T06:00:00.000Z',
    });
    const coordinatorName = 'Sentinelle Coordinateur J8B3';
    const coordinatorId = await seedProfile(database.owner, {
      email: nextEmail('file-coordinateur'),
      displayName: coordinatorName,
    });
    await seedMembership(database.owner, {
      organizationId: orphan,
      userId: coordinatorId,
      role: 'COORDINATOR',
    });

    const revokedOrganization = await seedOrganization(database.owner, {
      name: 'Depot fictif au mandat revoque',
      createdAt: '2026-04-02T06:00:00.000Z',
    });
    const revokedName = 'Sentinelle Mandat Revoque L5Q1';
    const revokedId = await seedProfile(database.owner, {
      email: nextEmail('file-mandat-revoque'),
      displayName: revokedName,
    });
    await seedMembership(database.owner, {
      organizationId: revokedOrganization,
      userId: revokedId,
      role: 'ORG_ADMIN',
      status: 'REVOKED',
    });

    const queue = await readQueue(admin.cookie);
    const [first, second] = itemsOf(queue);

    expect(queue.status).toBe(200);
    // L'ABSENCE SE DIT, ELLE NE S'INVENTE PAS : `null` plutôt qu'un nom de repli, que
    // l'administrateur prendrait pour une personne réelle.
    expect(first?.id).toBe(orphan);
    expect(first?.requestedBy.displayName).toBeNull();
    // Un rôle qui n'est pas `ORG_ADMIN` ne fait pas de son titulaire le déposant, et son nom ne
    // sort donc pas de la base.
    expect(queue.text).not.toContain(coordinatorName);

    // CONSTAT, PAS SOUHAIT. La jointure latérale de `listPendingOrganizations` retient l'adhésion
    // `ORG_ADMIN` la plus ancienne SANS filtrer son statut ni sa fenêtre de validité : une personne
    // dont le mandat a été révoqué reste nommée dans la file d'administration. Le déposant réel est
    // par ailleurs daté et inaltérable dans `audit_logs`. À relire EN MÊME TEMPS que la gestion des
    // mandats (US-014), où le transfert d'une adhésion `ORG_ADMIN` deviendra possible.
    expect(second?.id).toBe(revokedOrganization);
    expect(second?.requestedBy.displayName).toBe(revokedName);
  }, 60_000);
});

/**
 * LA CONSULTATION DE LA FILE EST TRACÉE, ET LA TRACE NE DIT PAS CE QU'ELLE A VU.
 *
 * `docs/permissions.md` pose la « journalisation des consultations sensibles » parmi ses principes.
 * La file est la consultation la plus sensible du lot : seul écran qui rende des données
 * d'organisations dont l'appelant n'est pas membre, seul écran qui NOMME des personnes, et il les
 * nomme TOUTES à la fois. Sans trace, personne ne peut dire qui l'a ouverte ni combien de fois.
 *
 * LES DEUX MOITIÉS SE TIENNENT, ET DOIVENT ÊTRE ÉPROUVÉES ENSEMBLE. Une trace qui recopierait la
 * file serait pire que pas de trace : elle déposerait dans les journaux d'exploitation — lisibles
 * par des rôles qui n'ont pas accès à cet écran — exactement ce que l'écran réserve à
 * `PLATFORM_ADMIN`. Le journal doit dire QUI a regardé et COMBIEN il a vu, jamais QUOI.
 */
describe('GET /api/v1/admin/organizations/pending — journalisation de la consultation', () => {
  it('écrit une ligne par consultation servie, acteur pseudonymisé, sans aucune donnée de la file', async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = await ensurePlatformAdmin(database.owner);
    await purgeOrganizationsExcept(database.owner, [admin.carrierId]);

    const requesterName = 'Sentinelle Journal Demandeur T6K4';
    const requesterEmail = nextEmail('journal-demandeur');
    const requesterPhone = nextPhone();
    const requesterId = await seedProfile(database.owner, {
      email: requesterEmail,
      displayName: requesterName,
      phone: requesterPhone,
    });
    const organizationId = await seedOrganization(database.owner, {
      name: 'Sentinelle Structure Journal V3H8',
      // Le numéro porte des séparateurs : sa forme normalisée est une SECONDE graphie, que le
      // journal ne doit pas davantage laisser sortir.
      registrationNumber: 'FICTIF-ORG-9314/2',
      territoryCode: 'ZZ-DEMO-42',
      createdAt: '2026-05-06T05:04:03.020100Z',
    });
    await seedMembership(database.owner, {
      organizationId,
      userId: requesterId,
      role: 'ORG_ADMIN',
    });

    journal.clear();
    const queue = await readQueue(admin.cookie);
    const lines = consultationLines();
    const line = lines[0];

    expect(queue.status).toBe(200);
    // UNE LIGNE PAR CONSULTATION SERVIE : c'est ce qui rend le « combien de fois » comptable.
    expect(lines).toHaveLength(1);
    expect(line?.level).toBe(CONSULTATION_LEVEL);
    expect(line?.module).toBe('organizations');
    expect(line?.servedCount).toBe(1);
    expect(line?.totalCount).toBe(1);
    expect(line?.paginated).toBe(false);

    // L'ACTEUR EST DÉSIGNÉ, MAIS PSEUDONYMISÉ (`docs/observability.md` : « userId pseudonymisé »).
    // Sans lui, la trace ne répondrait pas à la question qu'elle pose ; en clair, elle ferait du
    // journal d'exploitation un registre nominatif de consultations.
    expect(line?.userId).toBe(pseudonymizeUserId(admin.userId));
    expect(line?.userId).not.toBe(admin.userId);
    expect(journal.raw).not.toContain(admin.userId);

    // TÉMOIN : la file a réellement été servie, donc toutes les valeurs cherchées ci-dessous
    // étaient en mémoire au moment où la ligne a été écrite. Sans lui, une réponse vide rendrait
    // vraies par construction toutes les assertions d'absence.
    expect(queue.text).toContain(requesterName);
    expect(queue.text).toContain('FICTIF-ORG-9314/2');

    const forbidden = [
      ["nom de l'organisation", 'Sentinelle Structure Journal V3H8'],
      ['numero saisi', 'FICTIF-ORG-9314/2'],
      ['numero normalise', 'FICTIFORG93142'],
      ['code territorial', 'ZZ-DEMO-42'],
      ['nom du demandeur', requesterName],
      ['courriel du demandeur', requesterEmail],
      ['telephone du demandeur', requesterPhone],
      ["identifiant de l'organisation", organizationId],
      ['identifiant du demandeur', requesterId],
      ['jeton de session', admin.cookie],
    ] as const;

    // Le balayage porte sur TOUT ce qui est sorti du journaliseur pendant la requête, pas sur la
    // seule ligne de consultation : une fuite qui passerait par la ligne de sortie de requête
    // serait la même fuite.
    for (const [label, value] of forbidden) {
      expect(journal.raw, `${label} a fuite dans le journal de consultation`).not.toContain(value);
    }
  }, 60_000);

  it('distingue le déroulement de la file de son ouverture, et ne journalise pas le curseur', async (context) => {
    const database = databaseOrSkip(setup, context);
    const admin = await ensurePlatformAdmin(database.owner);
    await purgeOrganizationsExcept(database.owner, [admin.carrierId]);
    const organizationId = await seedOrganization(database.owner, {
      name: 'Depot fictif du journal de consultation',
      createdAt: '2026-06-01T08:00:00.000000Z',
    });

    // Curseur bien formé, antérieur au dépôt, et portant l'identifiant d'une organisation RÉELLE :
    // c'est la valeur qu'une trace bavarde recopierait.
    const cursor = Buffer.from(`2026-05-01T00:00:00.000000Z|${organizationId}`, 'utf8').toString(
      'base64url',
    );

    journal.clear();
    const queue = await readQueue(admin.cookie, `?cursor=${encodeURIComponent(cursor)}`);
    const line = consultationLines()[0];

    expect(queue.status).toBe(200);
    expect(itemsOf(queue).map((item) => item.id)).toStrictEqual([organizationId]);
    // DIX PAGES LUES D'AFFILÉE NE SE LISENT PAS COMME DIX OUVERTURES : sans ce champ, la trace
    // compterait des consultations là où il n'y a qu'un déroulement.
    expect(consultationLines()).toHaveLength(1);
    expect(line?.paginated).toBe(true);
    expect(line?.servedCount).toBe(1);
    // LE CURSEUR LUI-MÊME RESTE HORS DU JOURNAL : il porte l'identifiant d'une organisation
    // tierce, sous une forme encodée qui ne le rend pas moins lisible.
    expect(journal.raw).not.toContain(organizationId);
    expect(journal.raw).not.toContain(cursor);
  }, 60_000);

  it("n'écrit aucune ligne de consultation quand la file est refusée", async (context) => {
    const database = databaseOrSkip(setup, context);
    await ensurePlatformAdmin(database.owner);
    const email = nextEmail('journal-sans-fonction');
    await seedProfile(database.owner, { email });
    const cookie = await signInThroughRoutes(email);

    journal.clear();
    const refused = await readQueue(cookie);

    expect(refused.status).toBe(403);
    // UN REFUS N'EST PAS UNE CONSULTATION, et il a déjà sa ligne : l'enveloppe de route écrit un
    // `warn` pour tout 4xx. L'inscrire aussi sous le message de consultation mêlerait deux
    // populations et fausserait le comptage que cette trace existe pour permettre.
    expect(consultationLines()).toHaveLength(0);
    // Témoin : le journal n'est pas vide pour autant. L'absence mesurée est celle de la ligne de
    // consultation, pas celle de toute journalisation — sans quoi une capture cassée passerait.
    expect(journalLines().length).toBeGreaterThan(0);
  }, 60_000);
});

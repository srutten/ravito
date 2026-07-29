import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  expect,
  type Request as InterceptedRequest,
  type Page,
  type Route,
  test,
} from '@playwright/test';
import pg from 'pg';
import { loadIntegrationEnvironment, repositoryRoot } from '../integration/setup/environment';

/**
 * Parcours de création puis de modification d'une organisation (US-012), sur l'ARTEFACT DE
 * PRODUCTION, en profil mobile et bureau.
 *
 * POURQUOI CE FICHIER LANCE SON PROPRE SERVEUR, ET NE SE FIE PAS À `baseURL`. Deux raisons se
 * cumulent, et la seconde suffirait à elle seule.
 *
 * 1. UN ARTEFACT PÉRIMÉ RENDRAIT UN VERDICT FAUX. Le serveur commun de `playwright.config.ts`
 *    écoute sur `http://localhost:3000`, port qu'un conteneur Docker de la pile locale occupe
 *    déjà en servant une image construite un jour antérieur. Un test qui s'y connecterait
 *    déclarerait vert un code qui n'est pas celui du dépôt. Le serveur monté ici écoute sur un
 *    port libre et sert le `.next` du dépôt. Ce fichier figure pour cette raison dans
 *    `SELF_HOSTED_SPECS` de `playwright.config.ts` : le serveur commun n'est PAS monté lorsqu'il
 *    est seul visé, faute de quoi l'exécution échouait, en intégration continue, sur un port
 *    occupé par un serveur dont ce fichier n'a que faire.
 * 2. LE CODE DE CONNEXION N'EST LISIBLE QUE DANS LA SORTIE DU SERVEUR. Il n'est pas stocké — seule
 *    son empreinte l'est — et ne figure dans aucune réponse d'API. Sans transport configuré,
 *    l'adaptateur de repli l'écrit dans le journal, et uniquement lorsque `APP_ENV` vaut `local`.
 *    Démarrer le serveur depuis le test est le seul moyen d'y accéder sans dépendre de Mailpit.
 *
 * L'ARTEFACT SERVI EST VÉRIFIÉ, PAS SUPPOSÉ. `npm run test:e2e` construit avant d'exécuter, mais
 * une commande n'est qu'une habitude d'opérateur : `assertRebuiltArtifact` compare l'horodatage de
 * `.next/BUILD_ID` à celui du fichier source le plus récemment modifié et refuse de démarrer sur un
 * artefact périmé. Sans cette garde, ce fichier déplacerait simplement le piège du conteneur vers
 * le répertoire local et rendrait un verdict vert sur le code d'hier.
 *
 * DUPLICATION ASSUMÉE AVEC `auth-sign-in.spec.ts`. Le montage du serveur, la lecture du code et
 * l'arrêt propre y sont écrits une première fois. Les factoriser demanderait un module partagé
 * sous `tests/e2e/`, hors du périmètre de ce fichier ; la reprise est signalée ici pour qu'elle
 * soit faite d'un seul geste le jour où ce périmètre s'ouvre.
 *
 * AUCUNE VALEUR ATTENDUE N'EST IMPORTÉE DE `src/i18n/fr.ts`. Les libellés vérifiés plus bas sont
 * recopiés à la main. Les comparer au catalogue que l'application utilise pour les produire
 * n'éprouverait rien : le test passerait quel que soit le texte affiché, y compris vide.
 *
 * BASE DE DÉVELOPPEMENT, PAS BASE JETABLE. Ce fichier écrit dans la base réelle. Il en retire tout
 * ce qu'il y a créé — profils, sessions, défis, adhésions, organisations, messages d'outbox, clés
 * d'idempotence et lignes d'audit — et, AVANT DE SEMER, les restes des exécutions qui n'ont pas
 * atteint leur fin. La suppression des lignes d'audit passe par l'échappement de rétention prévu
 * par `0006_audit-logs.sql` : le déclencheur d'immuabilité refuse tout le reste.
 */

/**
 * EXÉCUTION EN SÉRIE, DANS UN SEUL TRAVAILLEUR. Les tests de ce fichier partagent un serveur, deux
 * comptes, une organisation créée par le premier d'entre eux et un relevé de console couvrant tout
 * le parcours. En parallèle, Playwright rejouerait `beforeAll` par travailleur et chaque test
 * repartirait d'un état que le précédent n'a pas construit. Les tests dépendants le DISENT dans
 * leur message d'échec, plutôt que d'échouer sur un repère introuvable dont personne ne devine la
 * cause : voir `requireCreatedOrganization` et `restoreSession`.
 */
test.describe.configure({ mode: 'serial' });

const AUTH_SECRET = 'secret-e2e-fictif-de-plus-de-32-caracteres-pour-les-organisations';
const SERVER_READY_TIMEOUT_MS = 120_000;
const SESSION_COOKIE_NAME = 'appui_feux_session';
const LOOPBACK_HOST = '127.0.0.1';

const CREATE_PATH = '/api/v1/organizations';
const PENDING_PATH = '/api/v1/admin/organizations/pending';
const PENDING_SCREEN_PATH = '/administration/organisations-en-attente';
const NEW_ORGANIZATION_PATH = '/organisations/nouvelle';
const HEALTH_PATH = '/api/v1/health';

/** Repère du parcours : préfixe fictif, exigé par `docs/test-plan.md`, et pivot du nettoyage. */
const REGISTRATION_PREFIX = 'FICTIF-E2E';
const IDENTIFIER_PREFIX = 'sentinelle-org';
const TERRITORY_CODE = 'ZZ-E2E-01';

/**
 * Forme du suffixe d'exécution : nom de projet Playwright, puis huit chiffres hexadécimaux.
 *
 * ELLE N'EST PAS DÉCORATIVE. Le ramassage des restes lit ce suffixe DANS les numéros
 * d'immatriculation et les adresses laissés en base par une exécution interrompue, qui ne lui a
 * transmis aucune variable. Un projet dont le nom porterait un tiret rendrait le suffixe illisible
 * et le ramassage silencieusement inopérant : `beforeAll` vérifie donc le sien avant de semer.
 */
const RUN_KEY_SHAPE = /^[a-z]+-[0-9a-f]{8}$/;
const RUN_KEY_SQL_SHAPE = '[a-z]+-[0-9a-f]{8}';

/**
 * Espace de verrous consultatifs propre à ce fichier (US-012).
 *
 * Chaque exécution verrouille SON suffixe pour toute sa durée. Le ramassage ne purge que les
 * suffixes dont le verrou est libre, c'est-à-dire dont la connexion a disparu : une exécution
 * voisine, même démarrée à la seconde près, n'est jamais emportée. C'est la transposition exacte
 * du critère de `dropLeftovers` côté intégration, qui ne supprime une base jetable que si plus
 * aucune connexion ne la porte.
 */
const RUN_LOCK_NAMESPACE = 12;

/**
 * Organisations de remplissage posées en SQL direct avant le parcours, et purgées avec le reste.
 *
 * SANS ELLES, LA PAGINATION NE SERAIT JAMAIS EXERCÉE. `PAGE_SIZE` vaut 25 et la base de
 * développement porte une seule organisation en attente : la file tiendrait sur une page, la
 * boucle qui la déroule ne tournerait pas, et le parcours de toutes les pages resterait un code
 * que rien n'éprouve. Vingt-six suffisent à garantir une seconde page à elles seules, quel que
 * soit le contenu antérieur de la base.
 *
 * ELLES SONT DATÉES DANS LE PASSÉ, donc placées AVANT l'organisation du parcours dans l'ordre
 * chronologique de la file. Chercher cette dernière impose alors de tourner les pages : c'est
 * exactement la régression à garder — une pagination qui ne progresse pas rend les plus anciennes
 * inatteignables, ou la plus récente introuvable, sans que le compteur ne change.
 */
const QUEUE_FILLER_COUNT = 26;
const QUEUE_FILLER_LABEL = 'remplissage';

/** Bornes de sûreté : une file qui les dépasserait signale un problème, pas une grande file. */
const MAX_QUEUE_PAGES = 40;
const MAX_QUEUE_MEASUREMENTS = 3;

/**
 * Libellés attendus, recopiés caractère pour caractère de `src/i18n/fr.ts`. Les apostrophes y sont
 * droites (U+0027) et non typographiques : une substitution silencieuse ferait échouer les
 * comparaisons pour une raison étrangère à ce que ce fichier éprouve.
 */
const PENDING_TITLE = 'Organisation en attente de validation';
const PENDING_BODY =
  "Cette organisation existe et vous pouvez la corriger, mais elle n'est pas encore validée. Un administrateur de la plateforme doit confronter son numéro d'immatriculation à un registre public.";
const PENDING_ALLOWED_TITLE = 'Ce que vous pouvez déjà faire';
const PENDING_ALLOWED_ITEM = 'Compléter et corriger cette fiche.';
const PENDING_BLOCKED_TITLE = "Ce qui reste fermé tant que la validation n'a pas eu lieu";
const PENDING_BLOCKED_PUBLISH = 'Publier une demande de moyens au nom de cette organisation.';
const PENDING_BLOCKED_OFFER = 'Proposer une ressource au nom de cette organisation.';
const VERIFICATION_BADGE = 'Validation : En attente de validation';
const LIFECYCLE_BADGE = 'État de la fiche : Active';
const ROLE_ORG_ADMIN = "Administrateur de l'organisation";
const MEMBER_STATUS_ACTIVE = 'Active';
const TYPE_FARM = 'Exploitation agricole';
const SUBMIT_LABEL = "Créer l'organisation";
const SUBMIT_BUSY_LABEL = 'Création en cours...';
const NOT_ASKED_TITLE = 'Ce que ce formulaire ne demande pas';
const ERROR_NAME = 'Saisissez un nom de 2 à 160 caractères, sans espace au début ni à la fin.';
const ERROR_TYPE = 'Choisissez un type de structure dans la liste.';
const ERROR_REGISTRATION =
  "Ce numéro d'immatriculation est refusé : vérifiez sa forme, ou saisissez-en un autre s'il est déjà enregistré. Lettres, chiffres, espace, point, barre oblique et tiret, en commençant et en finissant par une lettre ou un chiffre.";
const ERROR_TERRITORY =
  'Code territorial invalide : majuscules, chiffres et tirets, 16 caractères au plus, en commençant par une lettre ou un chiffre.';
const PERMISSION_DENIED = "Vous n'avez pas les droits nécessaires pour consulter cette page.";
const REQUESTED_BY_LABEL = 'Demandée par';
const NO_TERRITORY = 'Aucun périmètre déclaré';
const PENDING_LINK_LABEL = 'Organisations en attente';
const NEW_ORGANIZATION_LINK_LABEL = 'Créer une organisation';

/** Écran de la fiche : formulaire de modification et notices qu'il rend. */
const EDIT_SUBMIT_LABEL = 'Enregistrer les modifications';
const EDIT_SUCCESS_TITLE = 'Modifications enregistrées';
const EDIT_SUCCESS_BODY = 'La fiche affiche désormais son état à jour.';
const EDIT_NO_CHANGE_TITLE = 'Modifier la fiche';
const EDIT_NO_CHANGE_BODY = "Modifiez au moins un champ avant d'enregistrer.";
const VERSION_CONFLICT_TITLE = 'Fiche modifiée entre-temps';
const VERSION_CONFLICT_BODY =
  "Une autre personne a modifié cette fiche depuis son affichage. L'état réel est rechargé ci-dessus : vérifiez-le, puis recommencez votre modification.";

/** File d'administration : compteur non plafonné et ancienneté écrite en toutes lettres. */
const QUEUE_COUNT_ONE = 'organisation en attente';
const QUEUE_COUNT_MANY = 'organisations en attente';
const AGE_LESS_THAN_HOUR = "moins d'une heure";

/** Sorties toujours redirigées, entrée jamais : c'est ce que `stdio` déclare plus bas. */
type ServerProcess = ChildProcessByStdio<null, Readable, Readable>;

interface ServerHandle {
  readonly baseUrl: string;
  readonly process: ServerProcess;
  readonly lines: string[];
}

interface ConsoleEntry {
  readonly test: string;
  readonly text: string;
}

let server: ServerHandle | undefined;
let client: pg.Client | undefined;
let startedAt = new Date();

let creatorEmail = '';
let creatorUserId = '';
let creatorCookie = '';
/**
 * Initiale et non patronyme : `docs/test-plan.md` interdit tout contact réel ou nominatif, et le
 * reste du dépôt s'y tient déjà (`Camille D.`, `Alix R.`, `Sacha M.`).
 */
const CREATOR_DISPLAY_NAME = 'Camille D.';
const ADMIN_DISPLAY_NAME = 'Emma A.';

let adminEmail = '';
let adminUserId = '';
let carrierOrganizationId = '';

/** Suffixe propre à l'exécution : mobile et bureau tournent en parallèle sur la même base. */
let runSuffix = '';
/**
 * Motif de nettoyage, PROPRE À L'EXÉCUTION et non au seul projet.
 *
 * Un motif partagé entre deux exécutions simultanées les faisait s'entre-détruire : le `afterAll`
 * de la première emportait en vol les organisations, adhésions et lignes d'audit de la seconde.
 */
let registrationPattern = '';

/**
 * Mesure de la file relevée par le test d'administration, relue par le dernier test du fichier.
 *
 * La relire plutôt que la refaire évite une seconde connexion d'administrateur : la limitation de
 * tentatives compte cinq demandes de code par identifiant, et ce fichier en consomme déjà deux.
 */
let queueMeasurement: QueueMeasurement | undefined;

let createdOrganizationId = '';
let createdRegistrationNumber = '';
let createdOrganizationName = '';
let replayedOrganizationName = '';

/**
 * Relevé de la console du navigateur, cumulé sur TOUT le parcours et vérifié par le dernier test.
 *
 * Deux paniers, et la distinction n'est pas un assouplissement. Chromium transcrit dans la console
 * le statut de toute requête refusée : les tests qui éprouvent un refus en produisent donc
 * mécaniquement, et les confondre avec une faute d'application rendrait l'assertion inexploitable.
 * Le premier panier ne contient QUE ce que l'application a écrit ou laissé échapper — erreur React,
 * exception non rattrapée, avertissement d'hydratation. Il doit rester vide. Le second est
 * confronté à la liste exacte des statuts que les tests provoquent : un 500 inattendu y serait
 * visible immédiatement, là où « aucune erreur d'application » ne dirait rien.
 */
const applicationErrors: ConsoleEntry[] = [];
const refusedRequestStatuses: string[] = [];
const NETWORK_STATUS_PATTERN =
  /^Failed to load resource: the server responded with a status of (\d{3})/;
/**
 * Statuts que les tests de refus de ce fichier provoquent volontairement, et eux seuls.
 *
 * LISTE MESURÉE PLUTÔT QUE SUPPOSÉE. Deux refus seulement passent par le `fetch` d'une page, donc
 * par la console : le `400` du formulaire de création et le `409` du conflit de version. Le `403`
 * de la file d'administration est obtenu par le contexte de requête de Playwright, hors page : il
 * n'y laisse aucune trace. L'inscrire ici tolérerait par avance un refus que le parcours ne
 * produit pas.
 */
const EXPECTED_REFUSAL_STATUSES = new Set(['400', '409']);

/**
 * Sources qui entrent dans l'artefact `.next`. `tests/`, `docs/` et `supabase/` en sont absents à
 * dessein : les modifier n'invalide pas le serveur que ce fichier démarre.
 */
const BUILD_SOURCES = ['app', 'src', 'middleware.ts', 'next.config.ts', 'package.json'] as const;

interface Change {
  readonly path: string;
  readonly at: number;
}

async function newestChange(target: string): Promise<Change | null> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(target);
  } catch {
    // Source facultative — `public/` n'existe pas dans ce dépôt : son absence n'est pas une faute.
    return null;
  }
  if (!info.isDirectory()) {
    return { path: target, at: info.mtimeMs };
  }
  let newest: Change = { path: target, at: info.mtimeMs };
  const entries = await readdir(target, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const full = path.join(entry.parentPath, entry.name);
    const fileInfo = await stat(full);
    if (fileInfo.mtimeMs > newest.at) {
      newest = { path: full, at: fileInfo.mtimeMs };
    }
  }
  return newest;
}

/**
 * Refuse de démarrer sur un artefact plus ancien que les sources.
 *
 * L'en-tête de ce fichier affirme servir le code du dépôt : sans cette vérification, l'affirmation
 * reposerait sur la discipline de qui lance la commande. Un `.next` d'hier rendrait un verdict vert
 * sur le code d'hier, exactement le piège que ce fichier prétend éviter.
 */
async function assertRebuiltArtifact(): Promise<void> {
  const root = repositoryRoot();
  const buildId = await newestChange(path.join(root, '.next', 'BUILD_ID'));
  if (buildId === null) {
    throw new Error(
      "aucun artefact `.next` : ce parcours s'exécute sur le code construit. Lancez `npm run test:e2e:organizations`, qui construit avant d'exécuter.",
    );
  }
  for (const source of BUILD_SOURCES) {
    const newest = await newestChange(path.join(root, source));
    if (newest !== null && newest.at > buildId.at) {
      throw new Error(
        `l'artefact \`.next\` est plus ancien que ${path.relative(root, newest.path)} : le verdict porterait sur du code qui n'est plus celui du dépôt. Lancez \`npm run test:e2e:organizations\`, qui construit avant d'exécuter.`,
      );
    }
  }
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, LOOPBACK_HOST, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

async function waitForServer(baseUrl: string, child: ServerProcess): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`le serveur s'est arrêté avec le code ${String(child.exitCode)}`);
    }
    try {
      const response = await fetch(`${baseUrl}${HEALTH_PATH}`);
      if (response.status === 200) {
        return;
      }
    } catch {
      // Le serveur n'écoute pas encore.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("le serveur de test n'a pas démarré à temps");
}

async function stopServer(handle: ServerHandle): Promise<void> {
  if (handle.process.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    const forced = setTimeout(() => {
      handle.process.kill('SIGKILL');
      resolve();
    }, 5_000);
    handle.process.once('exit', () => {
      // Sans cette annulation, le minuteur maintient la boucle d'événements du travailleur
      // éveillée cinq secondes de plus, à chaque fichier et pour rien.
      clearTimeout(forced);
      resolve();
    });
    handle.process.kill();
  });
}

/**
 * Démarre `next start` sur un port libre, avec une configuration explicite.
 *
 * Les variables passées ici l'emportent sur `.env.local` : `@next/env` n'écrase jamais une valeur
 * déjà présente dans l'environnement du processus. `PLATFORM_READ_ONLY` est posée à `false` bien
 * qu'absente du fichier local : ce fichier éprouve la création d'une organisation, et un
 * interrupteur d'exploitation activé un jour par inadvertance transformerait chacun de ses tests
 * en `503` sans que rien ne dise pourquoi.
 *
 * UN DÉMARRAGE QUI ÉCHOUE N'ABANDONNE PAS SON PROCESSUS. Le `next start` engendré survivait à
 * l'exception de `waitForServer` — port occupé, artefact absent, délai dépassé —, gardait son port
 * et son bassin de connexions PostgreSQL, et n'était tué par personne : `afterAll` ne connaissait
 * pas un serveur dont `startServer` n'avait jamais rendu la poignée.
 */
async function startServer(databaseUrl: string): Promise<ServerHandle> {
  const port = await findFreePort();
  const baseUrl = `http://${LOOPBACK_HOST}:${String(port)}`;
  const nextBin = path.join(repositoryRoot(), 'node_modules', 'next', 'dist', 'bin', 'next');
  const child = spawn(process.execPath, [nextBin, 'start', '--port', String(port)], {
    cwd: repositoryRoot(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      APP_ENV: 'local',
      APP_VERSION: '0.0.0-e2e',
      LOG_LEVEL: 'info',
      DATABASE_URL: databaseUrl,
      DATABASE_SSL: 'disable',
      AUTH_SECRET,
      FEATURE_FLAGS_SOURCE: 'env',
      PLATFORM_READ_ONLY: 'false',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const lines: string[] = [];
  const collect = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim() !== '') {
        lines.push(line);
      }
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const handle: ServerHandle = { baseUrl, process: child, lines };
  try {
    await waitForServer(baseUrl, child);
  } catch (error) {
    await stopServer(handle);
    throw error;
  }
  return handle;
}

/**
 * Lit le code remis par l'adaptateur de journalisation.
 *
 * La remise est détachée du chemin de réponse : elle n'a pas encore eu lieu quand la page affiche
 * l'étape suivante, d'où l'attente active plutôt qu'une lecture immédiate.
 */
async function readDeliveredCode(handle: ServerHandle, since: number): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (let index = handle.lines.length - 1; index >= since; index -= 1) {
      const line = handle.lines[index] ?? '';
      if (!line.includes('signInCode')) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as { signInCode?: unknown };
        if (typeof parsed.signInCode === 'string') {
          return parsed.signInCode;
        }
      } catch {
        // Ligne non JSON produite par Next : ignorée.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("aucun code de connexion n'a été journalisé par le serveur");
}

function requireServer(): ServerHandle {
  if (server === undefined) {
    throw new Error('serveur de test non démarré');
  }
  return server;
}

function requireClient(): pg.Client {
  if (client === undefined) {
    throw new Error('connexion de base de test non ouverte');
  }
  return client;
}

/**
 * Repère posé par le premier test, exigé par ceux qui s'appuient dessus.
 *
 * Sans cette garde, un test joué seul demandait `/organisations/` et butait sur « Page
 * introuvable » : le message d'échec citait un repère absent et ne disait rien de la cause.
 */
function requireCreatedOrganization(): string {
  expect(
    createdOrganizationId,
    "aucune organisation créée : ce fichier s'exécute EN SÉRIE et son premier test construit ce dont les suivants se servent. Exécutez le fichier entier, pas ce test seul.",
  ).not.toBe('');
  return createdOrganizationId;
}

async function selectRows<T extends pg.QueryResultRow>(
  sql: string,
  params: readonly unknown[],
): Promise<T[]> {
  const { rows } = await requireClient().query<T>(sql, [...params]);
  return rows;
}

async function countRows(sql: string, params: readonly unknown[]): Promise<number> {
  const rows = await selectRows<{ readonly count: string }>(sql, params);
  return Number(rows[0]?.count ?? '0');
}

async function countPendingOrganizations(): Promise<number> {
  return countRows(
    "select count(*)::text as count from public.organizations where verification_status = 'PENDING'",
    [],
  );
}

/**
 * Retire de la base tout ce qu'une exécution y a laissé, la sienne comme celle d'une autre.
 *
 * UN SEUL CHEMIN DE PURGE, appelé par `afterAll` ET par le ramassage des restes. Un ramassage
 * écrit à part serait exercé une fois sur cent — le jour d'une interruption — et pourrirait sans
 * que rien ne le signale ; ici, chaque exécution normale l'éprouve.
 *
 * LES COMPTES SONT RETROUVÉS PAR LEUR ADRESSE, jamais par des identifiants mémorisés : une
 * exécution interrompue n'en a transmis aucun, et ses profils, sessions et défis restaient sinon
 * en base pour toujours.
 *
 * L'ORDRE EST IMPOSÉ PAR LES CLÉS ÉTRANGÈRES. `organization_members` référence `organizations` et
 * `user_profiles` sans clause `ON DELETE` : ni l'une ni l'autre ne peut partir avant elle.
 */
async function purgeRun(run: string): Promise<void> {
  const registrations = `${REGISTRATION_PREFIX}-${run}-%`;
  const identifiers = `${IDENTIFIER_PREFIX}-%${run}@exemple.test`;
  const target = requireClient();

  await target.query(
    `delete from public.organization_members
      where organization_id in (select id from public.organizations where registration_number like $1)
         or user_id in (select id from public.user_profiles where email like $2)`,
    [registrations, identifiers],
  );
  await target.query(
    `delete from public.outbox
      where aggregate_id in (select id from public.organizations where registration_number like $1)`,
    [registrations],
  );
  await target.query(
    `delete from public.idempotency_keys
      where actor_user_id in (select id from public.user_profiles where email like $2)
         or target_id in (select id from public.organizations where registration_number like $1)`,
    [registrations, identifiers],
  );
  // Le journal d'audit est immuable : seul l'échappement de rétention prévu par la migration 0006
  // permet de retirer les lignes produites par ce test. Le filtre est NOMINATIF plutôt que
  // temporel, pour ne pas emporter les lignes d'une exécution voisine.
  await target.query("select set_config('appui_feux.audit_purge', 'on', false)");
  await target.query(
    `delete from public.audit_logs
      where actor_user_id in (select id from public.user_profiles where email like $2)
         or target_id in (select id from public.user_profiles where email like $2)
         or actor_organization_id in (select id from public.organizations where registration_number like $1)
         or target_id in (select id from public.organizations where registration_number like $1)`,
    [registrations, identifiers],
  );
  await target.query('delete from public.organizations where registration_number like $1', [
    registrations,
  ]);
  // La suppression du profil emporte ses sessions et ses défis (ON DELETE CASCADE).
  await target.query('delete from public.user_profiles where email like $1', [identifiers]);
}

/**
 * Ramasse les restes des exécutions qui n'ont pas atteint leur `afterAll`.
 *
 * POURQUOI CE RAMASSAGE EXISTE. Le nettoyage n'était écrit que pour les exécutions qui vont à leur
 * terme : un `Ctrl-C`, un délai de tâche dépassé ou un travailleur tué laissait trois organisations
 * en attente, deux profils, leurs sessions et leurs défis, pour toujours. L'exécution suivante
 * comptait alors six organisations là où elle en attendait trois, échouait, puis effaçait les deux
 * jeux — et la suivante repassait au vert. C'est le profil exact du test qu'une équipe finit par
 * mettre en quarantaine sans jamais en trouver la cause.
 *
 * SEULS LES SUFFIXES SANS VERROU SONT PURGÉS. Une exécution vivante tient le sien depuis sa
 * première requête, avant même d'avoir semé quoi que ce soit : elle ne peut donc pas être emportée
 * par une voisine démarrée une seconde plus tard.
 */
async function collectLeftovers(): Promise<readonly string[]> {
  const candidates = await selectRows<{ readonly run: string }>(
    `select distinct run from (
        select substring(registration_number from $1) as run
          from public.organizations
         where registration_number like $3
        union all
        select substring(email from $2) as run
          from public.user_profiles
         where email like $4
      ) as found
      where run is not null`,
    [
      `^${REGISTRATION_PREFIX}-(${RUN_KEY_SQL_SHAPE})-`,
      `^${IDENTIFIER_PREFIX}-(?:admin-)?(${RUN_KEY_SQL_SHAPE})@exemple\\.test$`,
      `${REGISTRATION_PREFIX}-%`,
      `${IDENTIFIER_PREFIX}-%@exemple.test`,
    ],
  );

  const purged: string[] = [];
  for (const candidate of candidates) {
    const acquired = await selectRows<{ readonly acquired: boolean }>(
      'select pg_try_advisory_lock($1::int, hashtext($2)) as acquired',
      [RUN_LOCK_NAMESPACE, candidate.run],
    );
    if (acquired[0]?.acquired !== true) {
      continue;
    }
    await purgeRun(candidate.run);
    await requireClient().query('select pg_advisory_unlock($1::int, hashtext($2))', [
      RUN_LOCK_NAMESPACE,
      candidate.run,
    ]);
    purged.push(candidate.run);
  }
  return purged;
}

async function seedProfile(displayName: string, email: string): Promise<string> {
  const rows = await selectRows<{ readonly id: string }>(
    `insert into public.user_profiles (display_name, email, preferred_language, verification_level, status)
     values ($1, $2, 'fr', 'CONTACT_VERIFIED', 'ACTIVE')
     returning id`,
    [displayName, email],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error("le profil de test n'a pas été créé");
  }
  return id;
}

/**
 * Fabrique un administrateur plateforme.
 *
 * `hasPlatformAdminRole` exige TROIS conditions et non une seule : le rôle `PLATFORM_ADMIN`, une
 * adhésion effective, et une organisation PORTEUSE dont le statut est `ACTIVE`. Elle est créée
 * `VERIFIED` afin de ne pas venir grossir la file d'attente que le dernier test inspecte : une
 * organisation porteuse en attente ferait passer un test qui aurait dû trouver la sienne.
 */
async function seedPlatformAdmin(userId: string, registrationNumber: string): Promise<string> {
  const rows = await selectRows<{ readonly id: string }>(
    `insert into public.organizations
       (name, type, registration_number, territory_code, verification_status, status)
     values ($1, 'OPERATIONAL_SERVICE', $2, null, 'VERIFIED', 'ACTIVE')
     returning id`,
    [`Service porteur ${runSuffix}`, registrationNumber],
  );
  const organizationId = rows[0]?.id;
  if (organizationId === undefined) {
    throw new Error("l'organisation porteuse du rôle n'a pas été créée");
  }
  await requireClient().query(
    `insert into public.organization_members (organization_id, user_id, role, status)
     values ($1, $2, 'PLATFORM_ADMIN', 'ACTIVE')`,
    [organizationId, userId],
  );
  return organizationId;
}

/**
 * Pose les organisations de remplissage de la file, en une seule instruction.
 *
 * Elles ne portent AUCUNE adhésion : la file affiche alors « Demandeur non renseigné », état prévu
 * par `docs/screens.md`, et le parcours n'a pas à fabriquer vingt-six comptes pour éprouver une
 * pagination.
 */
async function seedQueueFillers(): Promise<void> {
  await requireClient().query(
    `insert into public.organizations
       (name, type, registration_number, territory_code, verification_status, status, created_at)
     select
       'Structure de remplissage ' || lpad(position::text, 2, '0') || ' ' || $1,
       'ASSOCIATION',
       $2 || lpad(position::text, 2, '0'),
       null,
       'PENDING',
       'ACTIVE',
       now() - interval '2 hours' + (position * interval '1 second')
     from generate_series(1, $3::int) as position`,
    [runSuffix, `${REGISTRATION_PREFIX}-${runSuffix}-${QUEUE_FILLER_LABEL}-`, QUEUE_FILLER_COUNT],
  );
}

/** Parcours de connexion complet, tel qu'un navigateur l'exécute. Rend le jeton de session. */
async function signIn(page: Page, identifier: string): Promise<string> {
  const handle = requireServer();
  await page.goto(`${handle.baseUrl}/connexion`);
  const marker = handle.lines.length;
  await page.getByTestId('champ-identifiant').fill(identifier);
  await page.getByRole('button', { name: 'Recevoir un code' }).click();
  await expect(page.getByTestId('etape-code')).toBeVisible();
  await page.getByTestId('champ-code').fill(await readDeliveredCode(handle, marker));
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/apres-connexion$/, { timeout: 30_000 });

  const cookies = await page.context().cookies();
  const token = cookies.find((candidate) => candidate.name === SESSION_COOKIE_NAME)?.value ?? '';
  expect(token, 'aucun cookie de session posé par la connexion').not.toBe('');
  return token;
}

/**
 * Repose une session déjà ouverte dans un contexte neuf.
 *
 * POURQUOI PLUTÔT QUE DE SE RECONNECTER À CHAQUE TEST. La limitation de tentatives compte cinq
 * demandes de code par identifiant : une dizaine de tests qui se reconnecteraient déclencheraient un
 * `RATE_LIMITED` étranger à ce qu'ils éprouvent. La session, elle, vit côté serveur et n'est liée à
 * aucune empreinte de navigateur — c'est précisément ce que `auth-sign-in.spec.ts` démontre en
 * rejouant un cookie à la main.
 */
async function restoreSession(page: Page, token: string): Promise<void> {
  expect(
    token,
    "aucune session partagée : ce fichier s'exécute EN SÉRIE et son premier test ouvre la session dont les suivants se servent. Exécutez le fichier entier, pas ce test seul.",
  ).not.toBe('');
  await page
    .context()
    .addCookies([{ name: SESSION_COOKIE_NAME, value: token, domain: LOOPBACK_HOST, path: '/' }]);
}

function nextRegistrationNumber(label: string): string {
  return `${REGISTRATION_PREFIX}-${runSuffix}-${label}-${randomUUID().slice(0, 8)}`;
}

/**
 * Repère de synchronisation : une requête émise APRÈS le clic, dont l'aboutissement prouve que le
 * navigateur a eu le temps d'émettre celle du formulaire, s'il y en avait eu une.
 *
 * Il remplace une attente en millisecondes. `handleSubmit` déclenche son `fetch` de façon
 * synchrone : toute requête du formulaire est donc partie avant celle-ci, et l'événement `request`
 * a été relevé quand la réponse à celle-ci revient. Un compteur à zéro constaté après ce repère
 * prouve une absence, là où un compteur lu tout de suite ne prouverait qu'une lenteur.
 */
async function awaitNetworkMarker(page: Page): Promise<void> {
  const status = await page.evaluate(async (probe) => {
    const response = await fetch(probe, { cache: 'no-store' });
    return response.status;
  }, HEALTH_PATH);
  expect(status, 'le repère de synchronisation réseau n a pas abouti').toBe(200);
}

interface HeldRefresh {
  /** Vrai dès qu'un rechargement de la fiche a été intercepté. */
  observed(): boolean;
  /** Laisse repartir le rechargement retenu et retire l'interception. */
  release(): Promise<void>;
}

/**
 * Retient le rechargement que le formulaire déclenche après une réponse du serveur.
 *
 * POURQUOI LA NOTICE NE SURVIT PAS AU RECHARGEMENT, ET POURQUOI CE N'EST PAS UN DÉFAUT. La fiche
 * remonte le formulaire à chaque changement de version (`key={organization.version}` dans
 * `page.tsx`) : le composant est neuf, et l'état local qui portait la notice est perdu. Une
 * assertion posée après coup mesurerait donc la vitesse du serveur, pas le contenu de l'écran.
 * L'interception fige l'instant qui compte, puis rend la main.
 *
 * CE QUE L'INTERCEPTION PROUVE, ET CE QU'ELLE NE PROUVE PAS. Elle prouve que le formulaire a bien
 * DEMANDÉ le rechargement — `docs/screens.md` l'exige de l'état « conflit de version », et sans lui
 * la personne resterait devant une fiche périmée en croyant savoir ce qu'elle contient. Elle ne
 * prouve pas ce que ce rechargement affiche : l'état réel est relu ensuite par une navigation
 * neuve, qui ne dépend d'aucun détail d'implémentation du routeur.
 *
 * `isNavigationRequest` distingue le rechargement du composant serveur — une requête de données,
 * porteuse de l'en-tête `RSC` — d'une navigation ordinaire, qu'il ne faut surtout pas retenir.
 */
async function holdFicheRefresh(page: Page, organizationId: string): Promise<HeldRefresh> {
  const pathname = `/organisations/${organizationId}`;
  let unlock: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  let markSettled: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve;
  });
  let observed = false;

  const matcher = (url: URL): boolean => url.pathname === pathname;
  const handler = async (route: Route, request: InterceptedRequest): Promise<void> => {
    // UNE SEULE REQUÊTE EST RETENUE, la première. Une seconde arrivée entre-temps passerait son
    // chemin plutôt que d'attendre une porte déjà refermée, ce qui bloquerait la page.
    if (observed || request.isNavigationRequest()) {
      await route.continue();
      return;
    }
    observed = true;
    await gate;
    try {
      await route.continue();
    } catch {
      // La requête retenue a été abandonnée par la page entre-temps : il n'y a plus rien à
      // relancer, et ce n'est pas ce que le test éprouve.
    }
    markSettled();
  };

  await page.route(matcher, handler);
  return {
    observed: () => observed,
    release: async (): Promise<void> => {
      unlock();
      if (observed) {
        // L'interception n'est retirée qu'une fois la requête repartie : `unroute` reprend à son
        // compte les routes encore en vol, et le gestionnaire trouverait alors sa route déjà
        // traitée.
        await settled;
      }
      await page.unroute(matcher, handler);
    },
  };
}

/**
 * Déroule la file jusqu'à sa dernière page.
 *
 * `PAGE_SIZE` vaut 25 et le tri est chronologique, du plus ancien au plus récent : l'organisation
 * de cette exécution est la plus récente, donc en FIN de file. Chercher sur la seule première page
 * fonctionnait tant que la base portait moins de vingt-cinq organisations en attente, et cessait de
 * fonctionner ensuite, avec un message d'échec qui n'aurait rien dit de la cause.
 */
async function loadEveryQueuePage(page: Page): Promise<number> {
  const rows = page.getByTestId('ligne-organisation-en-attente');
  const nextPage = page.getByTestId('action-page-suivante').getByRole('button');
  for (let pages = 1; pages <= MAX_QUEUE_PAGES; pages += 1) {
    if ((await nextPage.count()) === 0) {
      return pages;
    }
    const before = await rows.count();
    await nextPage.click();
    // La page suivante S'AJOUTE à la liste : le nombre de lignes est le seul témoin fiable de la
    // fin du chargement, le bouton pouvant disparaître au lieu de redevenir actif.
    await expect(rows).not.toHaveCount(before);
  }
  throw new Error(
    `la file d'administration dépasse ${String(MAX_QUEUE_PAGES)} pages : la pagination ne progresse plus, ou la base porte un volume qu'un test ne doit pas parcourir.`,
  );
}

interface QueuePage {
  readonly items: readonly Record<string, unknown>[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

interface QueueReading {
  readonly totalCount: number;
  readonly collected: readonly Record<string, unknown>[];
  readonly raw: readonly string[];
  readonly apiPages: number;
}

/** Lit la file par l'API, page après page, jusqu'à ce qu'il n'y ait plus de curseur. */
async function readQueueThroughApi(page: Page, baseUrl: string): Promise<QueueReading> {
  const collected: Record<string, unknown>[] = [];
  const raw: string[] = [];
  let cursor: string | null = null;
  let totalCount = -1;

  for (let pages = 1; pages <= MAX_QUEUE_PAGES; pages += 1) {
    const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    const response = await page.request.get(`${baseUrl}${PENDING_PATH}${query}`);
    expect(response.status(), `lecture de la page ${String(pages)} de la file`).toBe(200);
    raw.push(await response.text());
    const payload = (await response.json()) as QueuePage;
    if (pages === 1) {
      totalCount = payload.totalCount;
    }
    collected.push(...payload.items);
    if (payload.nextCursor === null) {
      return { totalCount, collected, raw, apiPages: pages };
    }
    cursor = payload.nextCursor;
  }
  throw new Error(
    `la file d'administration dépasse ${String(MAX_QUEUE_PAGES)} pages : le curseur ne progresse plus.`,
  );
}

interface QueueMeasurement extends QueueReading {
  readonly databaseCount: number;
  readonly counterText: string;
  readonly renderedRows: number;
  readonly screenPages: number;
}

/**
 * Mesure la file sur un état STABLE, écran et API confondus.
 *
 * POURQUOI L'ÉGALITÉ EXIGE CE DÉTOUR. `totalCount` doit valoir le nombre réel d'organisations en
 * attente, sans plafonnement : la seule assertion qui distingue un compteur juste d'un compteur
 * borné à la page est l'ÉGALITÉ avec le compte de la base. Or l'autre projet Playwright écrit dans
 * la même base pendant ce temps. La mesure est donc encadrée par deux comptes : s'ils diffèrent,
 * elle n'a pas eu lieu sur un état stable et elle est reprise. Une inégalité `>=` aurait été
 * satisfaite par n'importe quel compteur, y compris plafonné.
 */
async function measurePendingQueue(page: Page, baseUrl: string): Promise<QueueMeasurement> {
  for (let attempt = 1; attempt <= MAX_QUEUE_MEASUREMENTS; attempt += 1) {
    const before = await countPendingOrganizations();

    await page.goto(`${baseUrl}${PENDING_SCREEN_PATH}`);
    await expect(page.getByTestId('file-organisations-en-attente')).toBeVisible();
    await expect(page.getByTestId('compteur-organisations-en-attente')).toBeVisible();
    const screenPages = await loadEveryQueuePage(page);
    const counterText =
      (await page.getByTestId('compteur-organisations-en-attente').textContent()) ?? '';
    const renderedRows = await page.getByTestId('ligne-organisation-en-attente').count();

    const reading = await readQueueThroughApi(page, baseUrl);
    const after = await countPendingOrganizations();

    if (before === after) {
      return { ...reading, databaseCount: before, counterText, renderedRows, screenPages };
    }
  }
  throw new Error(
    `la file n'a pas pu être mesurée sur un état stable en ${String(MAX_QUEUE_MEASUREMENTS)} tentatives : une écriture concurrente la modifie sans cesse.`,
  );
}

test.beforeAll(
  // biome-ignore lint/correctness/noEmptyPattern: Playwright impose un motif de destructuration en premier parametre, seul `info` est utilise ici.
  async ({}, info) => {
    test.setTimeout(180_000);
    const environment = loadIntegrationEnvironment();
    const databaseUrl = environment.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      throw new Error('DATABASE_URL est absente : ce parcours exige une base réelle.');
    }
    await assertRebuiltArtifact();

    startedAt = new Date();
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();

    // Comptes, noms et immatriculations propres à chaque EXÉCUTION : mobile et bureau tournent en
    // parallèle sur la même base, un développeur et l'intégration continue peuvent la viser
    // ensemble, et le numéro d'immatriculation porte une unicité GLOBALE. Deux exécutions qui
    // partageraient un motif feraient de surcroît correspondre deux lignes là où les assertions en
    // attendent une.
    runSuffix = `${info.project.name}-${randomUUID().slice(0, 8)}`;
    expect(
      runSuffix,
      'le suffixe d exécution n est plus lisible par le ramassage des restes : renommer un projet Playwright impose de revoir RUN_KEY_SHAPE',
    ).toMatch(RUN_KEY_SHAPE);
    registrationPattern = `${REGISTRATION_PREFIX}-${runSuffix}-%`;

    // Le verrou est pris AVANT toute écriture : rien de cette exécution n'existe en base pendant
    // qu'elle est encore ramassable.
    await client.query('select pg_advisory_lock($1::int, hashtext($2))', [
      RUN_LOCK_NAMESPACE,
      runSuffix,
    ]);
    await collectLeftovers();

    creatorEmail = `${IDENTIFIER_PREFIX}-${runSuffix}@exemple.test`;
    creatorUserId = await seedProfile(CREATOR_DISPLAY_NAME, creatorEmail);

    adminEmail = `${IDENTIFIER_PREFIX}-admin-${runSuffix}@exemple.test`;
    adminUserId = await seedProfile(ADMIN_DISPLAY_NAME, adminEmail);
    carrierOrganizationId = await seedPlatformAdmin(
      adminUserId,
      nextRegistrationNumber('porteuse'),
    );
    await seedQueueFillers();

    server = await startServer(databaseUrl);
  },
);

test.afterAll(async () => {
  if (server !== undefined) {
    await stopServer(server);
  }
  if (client === undefined) {
    return;
  }

  if (runSuffix !== '') {
    await purgeRun(runSuffix);
  }
  /*
   * Compteurs de tentatives : filtre sur `updated_at`, JAMAIS sur `created_at`.
   *
   * POURQUOI, ET CE QUE LE FILTRE PRÉCÉDENT LAISSAIT PASSER. La table porte une ligne UNIQUE par
   * sujet limité (`uq_auth_attempts_subject_hash`) : elle est réutilisée d'une exécution à
   * l'autre, jamais dupliquée. Son `created_at` est donc celui de la PREMIÈRE exécution de la
   * journée, et un filtre posé dessus ne retirait rien de ce que les suivantes avaient
   * incrémenté. Mesuré : un compteur de dimension « source » — l'adresse de bouclage, commune à
   * toutes les exécutions — atteignait 22 pour un plafond de 20, et la cinquième exécution en
   * quinze minutes recevait `RATE_LIMITED` sur la connexion de son administrateur, écran vide et
   * ligne `SIGN_IN_BLOCKED` au journal d'audit. `updated_at`, tenu par le déclencheur
   * `auth_attempts_set_updated_at`, désigne exactement les lignes que cette exécution a touchées.
   *
   * L'empreinte du sujet est un HMAC qu'un test ne sait pas recalculer : le filtre reste donc
   * temporel, et le ramassage des restes ne peut pas rattraper ces lignes. Effacer le compteur
   * d'une exécution voisine ne fait que le remettre à zéro, jamais l'inverse.
   */
  await client.query('delete from public.auth_attempts where updated_at >= $1', [startedAt]);
  await client.end();
});

test.beforeEach(({ page }, info) => {
  page.on('console', (message) => {
    if (message.type() !== 'error') {
      return;
    }
    const text = message.text();
    const matched = NETWORK_STATUS_PATTERN.exec(text);
    if (matched !== null) {
      refusedRequestStatuses.push(matched[1] ?? '');
      return;
    }
    applicationErrors.push({ test: info.title, text });
  });
  page.on('pageerror', (error) => {
    applicationErrors.push({ test: info.title, text: error.message });
  });
});

test.describe("création d'une organisation", () => {
  test('mène du formulaire à la fiche et écrit les six effets de la transaction', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { baseUrl } = requireServer();

    creatorCookie = await signIn(page, creatorEmail);

    await page.goto(`${baseUrl}${NEW_ORGANIZATION_PATH}`);
    await expect(page.getByTestId('formulaire-creation-organisation')).toBeVisible();

    // ADR-016 APPLIQUÉ AU-DELÀ DE LA CONNEXION : aucun champ d'état n'est proposé, et l'écran le
    // DIT au lieu de le laisser deviner. Un champ caché suffirait à rendre la validation
    // décorative, alors que l'usurpation d'organisation figure parmi les menaces prioritaires de
    // docs/security.md.
    await expect(
      page.locator(
        '[name="verificationStatus"], [name="status"], [name="version"], [name="role"], [name="clientEventId"]',
      ),
    ).toHaveCount(0);
    await expect(page.getByText(NOT_ASKED_TITLE)).toBeVisible();

    createdRegistrationNumber = nextRegistrationNumber('parcours');
    createdOrganizationName = `Exploitation agricole ${runSuffix}`;

    await page.getByTestId('champ-nom-organisation').fill(createdOrganizationName);
    await page.getByTestId('champ-type-organisation').selectOption('FARM');
    await page.getByTestId('champ-immatriculation').fill(createdRegistrationNumber);
    await page.getByTestId('champ-code-territorial').fill(TERRITORY_CODE);
    await page.getByRole('button', { name: SUBMIT_LABEL }).click();

    await expect(page).toHaveURL(/\/organisations\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    createdOrganizationId = page.url().split('/').at(-1) ?? '';
    expect(createdOrganizationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // LA RÉPONSE NE DIT PAS TOUT, LA BASE SI. Les six effets de `docs/api-contract.md` ne sont
    // observables qu'ici : la réponse ne porte ni l'adhésion telle qu'elle est écrite, ni l'audit,
    // ni le message d'outbox, ni la réservation d'idempotence.
    const organizations = await selectRows<{
      readonly id: string;
      readonly name: string;
      readonly registration_number: string;
      readonly territory_code: string | null;
      readonly verification_status: string;
      readonly status: string;
      readonly version: number;
    }>(
      `select id, name, registration_number, territory_code, verification_status, status, version
         from public.organizations where registration_number = $1`,
      [createdRegistrationNumber],
    );
    expect(organizations).toHaveLength(1);
    const organization = organizations[0];
    expect(organization?.id).toBe(createdOrganizationId);
    expect(organization?.name).toBe(createdOrganizationName);
    // Conservé TEL QU'IL A ÉTÉ SAISI, séparateurs compris : c'est sous cette forme qu'un
    // administrateur le confronte à un registre public.
    expect(organization?.registration_number).toBe(createdRegistrationNumber);
    expect(organization?.territory_code).toBe(TERRITORY_CODE);
    // POSÉS PAR LE SERVEUR, JAMAIS PAR LE FORMULAIRE.
    expect(organization?.verification_status).toBe('PENDING');
    expect(organization?.status).toBe('ACTIVE');
    expect(organization?.version).toBe(1);

    const memberships = await selectRows<{ readonly role: string; readonly status: string }>(
      'select role, status from public.organization_members where organization_id = $1',
      [createdOrganizationId],
    );
    expect(memberships).toStrictEqual([{ role: 'ORG_ADMIN', status: 'ACTIVE' }]);

    const actions = await selectRows<{ readonly action: string }>(
      `select action from public.audit_logs
        where actor_organization_id = $1::uuid and action like 'ORGANIZATION%'
        order by action`,
      [createdOrganizationId],
    );
    expect(actions.map((row) => row.action)).toStrictEqual([
      'ORGANIZATION_CREATED',
      'ORGANIZATION_MEMBER_ADDED',
    ]);

    const outbox = await selectRows<{
      readonly event_type: string;
      readonly aggregate_type: string;
      readonly payload: Record<string, unknown>;
    }>('select event_type, aggregate_type, payload from public.outbox where aggregate_id = $1', [
      createdOrganizationId,
    ]);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.event_type).toBe('ORGANIZATION_SUBMITTED');
    expect(outbox[0]?.aggregate_type).toBe('ORGANIZATION');
    // LE MESSAGE NE PORTE QUE DES IDENTIFIANTS. Un nom ou un numéro d'immatriculation recopié ici
    // se retrouverait dans les journaux du fournisseur d'envoi, hors de la table que protègent les
    // droits SQL de l'application.
    expect(outbox[0]?.payload).toStrictEqual({
      organizationId: createdOrganizationId,
      submittedByUserId: creatorUserId,
      reason: 'CREATED',
    });

    const keys = await selectRows<{
      readonly operation: string;
      readonly target_type: string | null;
      readonly request_fingerprint: string;
      readonly result: Record<string, unknown>;
    }>(
      `select operation, target_type, request_fingerprint, result
         from public.idempotency_keys where target_id = $1`,
      [createdOrganizationId],
    );
    expect(keys).toHaveLength(1);
    expect(keys[0]?.operation).toBe('ORGANIZATION_CREATE');
    expect(keys[0]?.target_type).toBe('ORGANIZATION');
    // LE CORPS N'EST JAMAIS STOCKÉ : seule une empreinte l'est, et le résultat rejouable se réduit
    // à deux valeurs. Un registre qui conserverait la requête deviendrait un second lieu de fuite
    // du numéro d'immatriculation, avec sa propre rétention.
    expect(keys[0]?.request_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(keys[0]?.result).toStrictEqual({ organizationId: createdOrganizationId, version: 1 });
    const registryDump = JSON.stringify(keys[0]);
    expect(registryDump).not.toContain(createdRegistrationNumber);
    expect(registryDump).not.toContain(createdOrganizationName);
  });

  test('affiche l état EN ATTENTE en toutes lettres et n ouvre AUCUNE action', async ({ page }) => {
    test.setTimeout(60_000);
    const { baseUrl } = requireServer();
    const organizationId = requireCreatedOrganization();
    await restoreSession(page, creatorCookie);
    await page.goto(`${baseUrl}/organisations/${organizationId}`);

    // CRITÈRE DE SÉCURITÉ, PAS DE CONFORT. Une personne qui vient de créer son organisation ne doit
    // pas croire que cette création lui a ouvert des droits : le bandeau nomme ce qui est déjà
    // possible ET ce qui reste fermé, avant la fiche et non après.
    const banner = page.getByTestId('bandeau-validation-en-attente');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(PENDING_TITLE);
    await expect(banner).toContainText(PENDING_BODY);
    await expect(banner).toContainText(PENDING_ALLOWED_TITLE);
    await expect(banner).toContainText(PENDING_ALLOWED_ITEM);
    await expect(banner).toContainText(PENDING_BLOCKED_TITLE);
    await expect(banner).toContainText(PENDING_BLOCKED_PUBLISH);
    await expect(banner).toContainText(PENDING_BLOCKED_OFFER);

    await expect(page.getByTestId('bandeau-validation-acquise')).toHaveCount(0);
    await expect(page.getByTestId('bandeau-validation-refusee')).toHaveCount(0);
    await expect(page.getByTestId('bandeau-fiche-suspendue')).toHaveCount(0);
    await expect(page.getByTestId('bandeau-fiche-fermee')).toHaveCount(0);

    // L'ÉTAT EST ÉCRIT DANS LA PASTILLE ELLE-MÊME. La section Accessibilité de docs/screens.md
    // interdit qu'une information soit portée par la seule couleur, et un état de validation est
    // une information, pas une décoration.
    await expect(page.getByText(VERIFICATION_BADGE)).toBeVisible();
    await expect(page.getByText(LIFECYCLE_BADGE)).toBeVisible();

    await expect(page.getByTestId('organisation-nom')).toHaveText(createdOrganizationName);
    await expect(page.getByTestId('organisation-type')).toHaveText(TYPE_FARM);
    await expect(page.getByTestId('organisation-immatriculation')).toHaveText(
      createdRegistrationNumber,
    );
    await expect(page.getByTestId('organisation-territoire')).toHaveText(TERRITORY_CODE);
    await expect(page.getByTestId('organisation-version')).toHaveText('1');
    await expect(page.getByTestId('adhesion-role')).toHaveText(ROLE_ORG_ADMIN);
    await expect(page.getByTestId('adhesion-statut')).toHaveText(MEMBER_STATUS_ACTIVE);

    // AUCUNE ACTION QUI LAISSERAIT CROIRE LE CONTRAIRE. Les deux verbes fermés par le bandeau sont
    // cherchés comme COMMANDES — bouton ou lien — et jamais comme texte : le bandeau les écrit
    // lui-même pour dire qu'ils sont fermés, et les chercher par leur libellé serait un faux
    // positif garanti.
    for (const verb of [/Publier/, /Proposer/, /Valider/, /Affecter/]) {
      await expect(page.getByRole('button', { name: verb })).toHaveCount(0);
      await expect(page.getByRole('link', { name: verb })).toHaveCount(0);
    }

    // Ce qui EST ouvert l'est vraiment : « compléter et corriger cette fiche » n'est pas une
    // promesse creuse, le formulaire de modification est là et le message de refus ne l'est pas.
    await expect(page.getByTestId('formulaire-modification-organisation')).toBeVisible();
    await expect(page.getByTestId('modification-refusee')).toHaveCount(0);
  });

  test('signale chaque faute de saisie sur SON champ, sans appeler le serveur', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const { baseUrl } = requireServer();
    await restoreSession(page, creatorCookie);
    await page.goto(`${baseUrl}${NEW_ORGANIZATION_PATH}`);

    let submissions = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith(CREATE_PATH)) {
        submissions += 1;
      }
    });

    // Quatre fautes en une passe. Un formulaire qui n'en signalerait qu'une à la fois se
    // corrigerait en autant d'allers-retours qu'il compte d'erreurs.
    await page.getByTestId('champ-nom-organisation').fill('a');
    await page.getByTestId('champ-immatriculation').fill('ab');
    await page.getByTestId('champ-code-territorial').fill('zz-01');
    await page.getByRole('button', { name: SUBMIT_LABEL }).click();

    await expect(page.locator('#organisation-nom-erreur')).toHaveText(ERROR_NAME);
    await expect(page.locator('#organisation-type-erreur')).toHaveText(ERROR_TYPE);
    await expect(page.locator('#organisation-immatriculation-erreur')).toHaveText(
      ERROR_REGISTRATION,
    );
    await expect(page.locator('#organisation-territoire-erreur')).toHaveText(ERROR_TERRITORY);

    // L'ERREUR EST ASSOCIÉE AU CHAMP, pas seulement posée à côté : sans `aria-invalid` ni
    // `aria-describedby`, un lecteur d'écran annonce un champ valide surmonté d'un texte rouge.
    for (const field of [
      'organisation-nom',
      'organisation-type',
      'organisation-immatriculation',
      'organisation-territoire',
    ]) {
      await expect(page.locator(`#${field}`)).toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator(`#${field}`)).toHaveAttribute(
        'aria-describedby',
        new RegExp(`${field}-erreur`),
      );
    }
    // Le focus revient sur la PREMIÈRE faute, dans l'ordre du formulaire.
    await expect(page.locator('#organisation-nom')).toBeFocused();

    // AUCUN APPEL N'EST PARTI. Le contrôle local est de confort, mais un formulaire qui enverrait
    // quand même une saisie manifestement fautive ferait payer un aller-retour réseau à quelqu'un
    // qui est, par construction, sur un téléphone en réseau dégradé.
    await awaitNetworkMarker(page);
    expect(submissions, 'une soumission est partie malgré des fautes locales').toBe(0);
    // `territoryCode` n'est PAS mis en majuscules à l'insu de l'appelant : la saisie est refusée
    // telle quelle, parce que le serveur inscrit cette valeur dans le journal d'audit et qu'une
    // majuscule posée en douce rendrait deux saisies indiscernables dans la preuve.
    await expect(page.getByTestId('champ-code-territorial')).toHaveValue('zz-01');
  });

  test('refuse un numéro déjà enregistré sans nommer la structure qui le détient', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const { baseUrl } = requireServer();
    requireCreatedOrganization();
    await restoreSession(page, creatorCookie);
    const decoyName = `Structure homonyme ${runSuffix}`;
    const errorMessage = page.locator('#organisation-immatriculation-erreur');

    async function submitRegistration(value: string): Promise<string> {
      await page.goto(`${baseUrl}${NEW_ORGANIZATION_PATH}`);
      await page.getByTestId('champ-nom-organisation').fill(decoyName);
      await page.getByTestId('champ-type-organisation').selectOption('COMPANY');
      await page.getByTestId('champ-immatriculation').fill(value);
      const answered = page.waitForResponse(
        (response) =>
          response.url().endsWith(CREATE_PATH) && response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: SUBMIT_LABEL }).click();
      const response = await answered;
      // LE VERDICT VIENT DU SERVEUR, pas du contrôle local : les deux saisies éprouvées ici
      // passent le contrôle de confort, et l'attente de la réponse le prouve.
      expect(response.status(), `statut pour ${value}`).toBe(400);
      const body = (await response.json()) as {
        readonly error?: { readonly code?: string; readonly details?: { fields?: unknown } };
      };
      expect(body.error?.code).toBe('VALIDATION_ERROR');
      expect(body.error?.details?.fields).toStrictEqual(['registrationNumber']);
      await expect(errorMessage).toBeVisible();
      return (await errorMessage.textContent()) ?? '';
    }

    // Un numéro DÉJÀ ENREGISTRÉ. L'unicité porte sur la forme normalisée et le refus doit rester
    // NEUTRE : il ne nomme pas la structure en face, faute de quoi il suffirait d'essayer des
    // numéros pour cartographier les organisations enregistrées.
    const duplicateMessage = await submitRegistration(createdRegistrationNumber);
    const shown = await page.content();
    expect(shown).not.toContain(createdOrganizationName);
    expect(shown).not.toContain(createdOrganizationId);
    expect(shown).not.toContain(creatorEmail);

    // Un numéro MAL FORMÉ : la forme brute passe le contrôle local, mais sa forme normalisée fait
    // trois caractères et le serveur la refuse. Le message doit être le MÊME que celui du doublon,
    // sinon l'écran rétablit l'oracle d'énumération que le serveur refuse d'ouvrir.
    const malformedMessage = await submitRegistration('12-3');
    expect(duplicateMessage).toBe(ERROR_REGISTRATION);
    expect(
      malformedMessage,
      'le refus de doublon se distingue du refus de forme, donc énumère',
    ).toBe(duplicateMessage);

    // AUCUN EFFET : ni seconde organisation portant ce numéro, ni fiche créée sous ce nom.
    expect(
      await countRows(
        'select count(*)::text as count from public.organizations where registration_number = $1',
        [createdRegistrationNumber],
      ),
    ).toBe(1);
    expect(
      await countRows('select count(*)::text as count from public.organizations where name = $1', [
        decoyName,
      ]),
    ).toBe(0);
  });

  test('verrouille le bouton pendant la mutation et refuse un second appui', async ({ page }) => {
    test.setTimeout(90_000);
    const { baseUrl } = requireServer();
    await restoreSession(page, creatorCookie);

    // La réponse est RETARDÉE, PAS FALSIFIÉE : le serveur exécute réellement la création, seul le
    // temps de transport est allongé. L'attente n'est pas une horloge mais une porte que le test
    // ouvre lui-même, une fois ses assertions posées : l'état « action en cours » dure donc
    // exactement le temps qu'il faut, sur une machine lente comme sur une machine rapide.
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    await page.route(`**${CREATE_PATH}`, async (route) => {
      await gate;
      await route.continue();
    });

    await page.goto(`${baseUrl}${NEW_ORGANIZATION_PATH}`);
    const lockedRegistration = nextRegistrationNumber('verrou');
    await page.getByTestId('champ-nom-organisation').fill(`Structure verrouillée ${runSuffix}`);
    await page.getByTestId('champ-type-organisation').selectOption('ASSOCIATION');
    await page.getByTestId('champ-immatriculation').fill(lockedRegistration);

    const submit = page.getByTestId('action-creer-organisation').getByRole('button');
    await submit.click();

    // LE DOUBLE APPUI EST IMPOSSIBLE AVANT MÊME QUE L'IDEMPOTENCE AIT À JOUER.
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveAttribute('aria-busy', 'true');
    await expect(submit).toContainText(SUBMIT_BUSY_LABEL);
    await expect(page.getByTestId('champ-nom-organisation')).toBeDisabled();
    await expect(page.getByTestId('champ-type-organisation')).toBeDisabled();
    await expect(page.getByTestId('champ-immatriculation')).toBeDisabled();
    await expect(page.getByTestId('champ-code-territorial')).toBeDisabled();

    // Second appui, contrôles d'actionnabilité contournés : un navigateur ne déclenche pas
    // d'événement de clic sur un bouton désactivé, et c'est exactement la garantie recherchée.
    await submit.click({ force: true });
    openGate();

    await expect(page).toHaveURL(/\/organisations\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    expect(
      await countRows(
        'select count(*)::text as count from public.organizations where registration_number = $1',
        [lockedRegistration],
      ),
      'le second appui a produit une seconde organisation',
    ).toBe(1);
  });

  test("un double envoi simultané de la même intention ne crée qu'une organisation", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const { baseUrl } = requireServer();
    await restoreSession(page, creatorCookie);
    await page.goto(`${baseUrl}/apres-connexion`);

    replayedOrganizationName = `Structure du double envoi ${runSuffix}`;
    const registrationNumber = nextRegistrationNumber('rejeu');
    const body = {
      name: replayedOrganizationName,
      type: 'COMPANY',
      registrationNumber,
      clientEventId: randomUUID(),
    };
    const send = async () =>
      page.request.post(`${baseUrl}${CREATE_PATH}`, {
        headers: { 'content-type': 'application/json', origin: baseUrl },
        data: body,
      });

    // DEUX APPELS QUI SE CHEVAUCHENT RÉELLEMENT, et c'est la réservation `ON CONFLICT DO NOTHING`
    // du registre d'idempotence qui les arbitre. Deux appels séquentiels n'éprouveraient que la
    // relecture d'une ligne déjà validée, jamais la course.
    const [first, second] = await Promise.all([send(), send()]);

    // 201 DANS LES DEUX CAS, REJEU COMPRIS : le client qui a perdu la première réponse n'a pas à
    // distinguer deux cas.
    expect(first.status()).toBe(201);
    expect(second.status()).toBe(201);
    const firstBody = (await first.json()) as Record<string, unknown>;
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(secondBody).toStrictEqual(firstBody);
    expect(firstBody.nextStep).toBe('AWAITING_VERIFICATION');
    // `replayed` ne sort pas dans le corps : la réponse rejouée est identique à l'initiale, et
    // c'est précisément ce qui dispense le client d'en tenir compte.
    expect(Object.keys(firstBody).sort()).toStrictEqual(['membership', 'nextStep', 'organization']);

    const rows = await selectRows<{ readonly id: string }>(
      'select id from public.organizations where registration_number = $1',
      [registrationNumber],
    );
    expect(rows, 'le double envoi a produit deux organisations').toHaveLength(1);
    const organizationId = rows[0]?.id ?? '';

    // UNE SEULE FOIS CHAQUE EFFET, et deux lignes d'audit au total, pas quatre.
    expect(
      await countRows(
        'select count(*)::text as count from public.organization_members where organization_id = $1',
        [organizationId],
      ),
    ).toBe(1);
    expect(
      await countRows('select count(*)::text as count from public.outbox where aggregate_id = $1', [
        organizationId,
      ]),
    ).toBe(1);
    expect(
      await countRows(
        'select count(*)::text as count from public.idempotency_keys where client_event_id = $1',
        [body.clientEventId],
      ),
    ).toBe(1);
    expect(
      await countRows(
        `select count(*)::text as count from public.audit_logs
          where actor_organization_id = $1::uuid and action like 'ORGANIZATION%'`,
        [organizationId],
      ),
    ).toBe(2);
  });

  test("refuse la file d'administration à un compte ordinaire, jusque dans l appel direct", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const { baseUrl } = requireServer();
    requireCreatedOrganization();
    await restoreSession(page, creatorCookie);

    // 1. LE LIEN EST ABSENT — honnêteté d'interface, et rien de plus : un lien qui mène à un refus
    //    fait croire à une panne et apprend au passage qu'un écran existe. L'assertion se pose sur
    //    un écran de la coquille connectée, et vérifie d'abord que la barre de navigation est bien
    //    rendue : chercher un repère absent sur une page qui n'en porte aucun ne prouverait rien.
    await page.goto(`${baseUrl}${NEW_ORGANIZATION_PATH}`);
    await expect(page.getByTestId('lien-nouvelle-organisation')).toBeVisible();
    await expect(page.getByTestId('lien-organisations-en-attente')).toHaveCount(0);
    await page.goto(`${baseUrl}/apres-connexion`);
    await expect(page.getByTestId('acces-organisations')).toBeVisible();
    await expect(
      page
        .getByTestId('acces-organisations')
        .getByRole('link', { name: NEW_ORGANIZATION_LINK_LABEL }),
    ).toBeVisible();
    await expect(
      page.getByTestId('acces-organisations').getByRole('link', { name: PENDING_LINK_LABEL }),
    ).toHaveCount(0);

    // 2. L'ÉCRAN SE REFUSE — ce n'est toujours pas un contrôle des données, et le refus remplace
    //    l'écran entier plutôt que de masquer la seule file.
    await page.goto(`${baseUrl}${PENDING_SCREEN_PATH}`);
    await expect(page.getByTestId('ecran-administration-refuse')).toBeVisible();
    await expect(page.getByTestId('ecran-administration-refuse')).toContainText(PERMISSION_DENIED);
    await expect(page.getByTestId('file-organisations-en-attente')).toHaveCount(0);
    await expect(page.getByTestId('ligne-organisation-en-attente')).toHaveCount(0);

    // 3. LA ROUTE REFUSE — c'est le SEUL contrôle qui protège. « Appel direct d'une route masquée
    //    par l'interface » est un cas de test obligatoire de docs/permissions.md.
    const response = await page.request.get(`${baseUrl}${PENDING_PATH}`);
    expect(response.status()).toBe(403);
    const refusal = (await response.json()) as { readonly error?: { readonly code?: string } };
    // FORBIDDEN et non NOT_FOUND : ici il n'y a aucune existence à dissimuler, seulement une
    // fonction à refuser. L'asymétrie avec la lecture d'une organisation est assumée par le
    // contrat.
    expect(refusal.error?.code).toBe('FORBIDDEN');
    const text = await response.text();
    expect(text).not.toContain(createdOrganizationName);
    expect(text).not.toContain(createdRegistrationNumber);
  });

  test('montre la file à un administrateur plateforme, sans coordonnée du demandeur', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { baseUrl } = requireServer();
    requireCreatedOrganization();
    await signIn(page, adminEmail);

    await page.goto(`${baseUrl}${PENDING_SCREEN_PATH}`);
    await expect(page.getByTestId('lien-organisations-en-attente')).toBeVisible();
    await expect(page.getByTestId('ecran-administration-refuse')).toHaveCount(0);

    // LA FILE EST LUE JUSQU'AU BOUT, écran et API. Le tri est chronologique, du plus ancien au plus
    // récent, et la page vaut vingt-cinq lignes : l'organisation de cette exécution est la plus
    // récente, donc la dernière. Chercher sur la seule première page marchait tant que la base
    // portait peu d'organisations en attente, et cessait de marcher ensuite.
    const measurement = await measurePendingQueue(page, baseUrl);
    queueMeasurement = measurement;

    const row = page
      .getByTestId('ligne-organisation-en-attente')
      .filter({ hasText: createdOrganizationName });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('ligne-type')).toHaveText(TYPE_FARM);
    await expect(row.getByTestId('ligne-immatriculation')).toHaveText(createdRegistrationNumber);
    await expect(row.getByTestId('ligne-territoire')).toHaveText(TERRITORY_CODE);
    await expect(row.getByTestId('ligne-demandeur')).toHaveText(CREATOR_DISPLAY_NAME);
    await expect(row).toContainText(REQUESTED_BY_LABEL);
    // L'ancienneté est écrite en toutes lettres, jamais portée par une couleur : l'organisation
    // vient d'être créée, la borne basse de `formatAge` est donc la seule qui puisse s'appliquer.
    await expect(row.getByTestId('ligne-anciennete')).toHaveText(AGE_LESS_THAN_HOUR);
    // L'absence de périmètre est une information, pas une case vide : la structure du double envoi
    // n'en déclare aucun.
    const withoutTerritory = page
      .getByTestId('ligne-organisation-en-attente')
      .filter({ hasText: replayedOrganizationName });
    await expect(withoutTerritory.getByTestId('ligne-territoire')).toHaveText(NO_TERRITORY);

    // MINIMISATION : vérifier un numéro d'immatriculation ne suppose pas de joindre le demandeur.
    // L'assertion porte sur le CORPS DE RÉPONSE de TOUTES les pages et pas seulement sur l'écran —
    // une donnée envoyée au navigateur est une donnée exposée, qu'elle soit affichée ou non.
    const raw = measurement.raw.join('');
    expect(raw, 'un courriel figure dans la file d administration').not.toContain(creatorEmail);
    expect(raw, 'un identifiant de compte figure dans la file').not.toContain(creatorUserId);

    const item = measurement.collected.find(
      (candidate) => candidate.name === createdOrganizationName,
    );
    expect(item, 'l organisation créée est absente de la file').toBeDefined();
    expect(Object.keys(item ?? {}).sort()).toStrictEqual([
      'createdAt',
      'id',
      'name',
      'registrationNumber',
      'requestedBy',
      'territoryCode',
      'type',
    ]);
    expect(Object.keys((item?.requestedBy ?? {}) as Record<string, unknown>)).toStrictEqual([
      'displayName',
    ]);

    // LA FILE NE PORTE QUE CE QUI ATTEND. L'organisation porteuse du rôle d'administration est
    // `VERIFIED` : la voir ici signalerait un filtre qui ne tient pas.
    expect(measurement.collected.some((candidate) => candidate.id === carrierOrganizationId)).toBe(
      false,
    );

    // `totalCount` est le nombre RÉEL d'organisations en attente, non plafonné à la page. Le compte
    // de la base est connu et la mesure a eu lieu sur un état stable : c'est donc une ÉGALITÉ qui
    // est exigée. Une inégalité serait satisfaite par un compteur borné à vingt-cinq.
    expect(
      measurement.totalCount,
      'le compteur de la file est plafonné ou décalé du compte réel',
    ).toBe(measurement.databaseCount);
    expect(measurement.counterText).toBe(
      `${String(measurement.databaseCount)} ${
        measurement.databaseCount <= 1 ? QUEUE_COUNT_ONE : QUEUE_COUNT_MANY
      }`,
    );
    // LA PAGINATION A RÉELLEMENT ÉTÉ EXERCÉE. Sans cette assertion, les boucles qui déroulent
    // l'écran et le curseur pourraient ne jamais tourner : elles passeraient pour éprouvées sans
    // l'être. Les organisations de remplissage posées au démarrage sont là pour cela.
    expect(
      measurement.screenPages,
      "la file tient sur une page : la pagination de l'écran n'a pas été éprouvée",
    ).toBeGreaterThan(1);
    expect(
      measurement.apiPages,
      "la file tient sur une page : le curseur de l'API n'a pas été éprouvé",
    ).toBeGreaterThan(1);

    // L'EXHAUSTIVITÉ ET L'ABSENCE DE DOUBLON SONT ÉPROUVÉES PAR LE DERNIER TEST DU FICHIER, qui
    // relit cette mesure. Elles y sont isolées parce qu'elles échouent aujourd'hui sur un défaut du
    // curseur : les laisser ici ferait sauter, en mode série, toute la couverture de la
    // modification de fiche, qui n'a rien à voir avec ce défaut.

    // Les trois organisations créées PAR LE PARCOURS sont là, et elles seules : le motif est propre
    // à l'exécution, et les restes d'une exécution interrompue ont été ramassés au démarrage. Les
    // organisations de remplissage, posées en SQL direct, sont écartées de ce compte.
    const fillerPattern = `${REGISTRATION_PREFIX}-${runSuffix}-${QUEUE_FILLER_LABEL}-%`;
    const own = await countRows(
      `select count(*)::text as count from public.organizations
        where registration_number like $1 and registration_number not like $2
          and verification_status = 'PENDING'`,
      [registrationPattern, fillerPattern],
    );
    expect(own).toBe(3);
    expect(
      await countRows(
        `select count(*)::text as count from public.organizations
          where registration_number like $1 and verification_status = 'PENDING'`,
        [fillerPattern],
      ),
      'les organisations de remplissage ne sont pas toutes en file : la pagination éprouvée ne serait plus celle que ce test croit mesurer',
    ).toBe(QUEUE_FILLER_COUNT);
  });
});

/**
 * MODIFICATION DE LA FICHE (`docs/screens.md`, état « conflit de version »).
 *
 * POURQUOI CES TESTS EXISTENT ALORS QUE L'API EST ABONDAMMENT ÉPROUVÉE. Le formulaire décide seul
 * de ce qu'il envoie, et c'est là que se joue une régression que nul test d'API ne verrait :
 * `buildChanges` n'envoie QUE les champs modifiés, et un jour où il les enverrait tous, chaque
 * correction du périmètre territorial d'une organisation validée la ferait retomber en attente —
 * `touchesIdentity` deviendrait vrai. La file de validation se remplirait de fausses retombées et
 * les administrateurs revalideraient en boucle des organisations que personne n'a renommées.
 */
test.describe('modification de la fiche', () => {
  test("n'envoie que le champ modifié, incrémente la version et le dit à l'écran", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const { baseUrl } = requireServer();
    const organizationId = requireCreatedOrganization();
    await restoreSession(page, creatorCookie);

    const bodies: string[] = [];
    page.on('request', (request) => {
      if (
        request.method() === 'PATCH' &&
        request.url().endsWith(`${CREATE_PATH}/${organizationId}`)
      ) {
        bodies.push(request.postData() ?? '');
      }
    });

    await page.goto(`${baseUrl}/organisations/${organizationId}`);
    await expect(page.getByTestId('organisation-version')).toHaveText('1');

    const renamed = `${createdOrganizationName} corrigee`;
    const submit = page.getByTestId('action-modifier-organisation').getByRole('button');
    await expect(submit).toHaveText(EDIT_SUBMIT_LABEL);

    const hold = await holdFicheRefresh(page, organizationId);
    await page.getByTestId('champ-modification-nom').fill(renamed);
    await submit.click();

    const notice = page.getByTestId('message-modification-organisation');
    await expect(notice).toContainText(EDIT_SUCCESS_TITLE);
    await expect(notice).toContainText(EDIT_SUCCESS_BODY);
    // La fiche est rendue par le SERVEUR après écriture, jamais reconstituée à partir de ce que le
    // navigateur croit avoir envoyé : sans ce rechargement, l'écran afficherait un état supposé.
    await expect
      .poll(() => hold.observed(), {
        message: "la fiche n'a pas été rechargée après l'enregistrement",
      })
      .toBe(true);
    await hold.release();

    // L'ÉTAT AFFICHÉ EST RELU DU SERVEUR, par une navigation neuve : ce que la fiche montre après
    // écriture ne doit rien devoir à ce que le navigateur croit avoir envoyé.
    await page.goto(`${baseUrl}/organisations/${organizationId}`);
    await expect(page.getByTestId('organisation-nom')).toHaveText(renamed);
    await expect(page.getByTestId('organisation-version')).toHaveText('2');

    // LE CORPS NE PORTE QUE CE QUI A CHANGÉ. C'est l'assertion qui garde la file de validation :
    // un corps complet ferait retomber en attente toute organisation validée dont on corrigerait
    // le seul périmètre territorial.
    expect(bodies, 'une seule requête de modification est partie').toHaveLength(1);
    expect(JSON.parse(bodies[0] ?? '{}')).toStrictEqual({ name: renamed, expectedVersion: 1 });

    const rows = await selectRows<{
      readonly name: string;
      readonly type: string;
      readonly registration_number: string;
      readonly territory_code: string | null;
      readonly verification_status: string;
      readonly version: number;
    }>(
      `select name, type, registration_number, territory_code, verification_status, version
         from public.organizations where id = $1`,
      [organizationId],
    );
    expect(rows[0]).toStrictEqual({
      name: renamed,
      type: 'FARM',
      registration_number: createdRegistrationNumber,
      territory_code: TERRITORY_CODE,
      verification_status: 'PENDING',
      version: 2,
    });

    const actions = await selectRows<{ readonly action: string }>(
      `select action from public.audit_logs
        where actor_organization_id = $1::uuid and action like 'ORGANIZATION%'
        order by action`,
      [organizationId],
    );
    expect(actions.map((entry) => entry.action)).toStrictEqual([
      'ORGANIZATION_CREATED',
      'ORGANIZATION_MEMBER_ADDED',
      'ORGANIZATION_UPDATED',
    ]);

    createdOrganizationName = renamed;
  });

  test('affiche « Fiche modifiée entre-temps » et recharge, sans rien écrire', async ({ page }) => {
    test.setTimeout(90_000);
    const { baseUrl } = requireServer();
    const organizationId = requireCreatedOrganization();
    await restoreSession(page, creatorCookie);

    await page.goto(`${baseUrl}/organisations/${organizationId}`);
    const displayed = Number(await page.getByTestId('organisation-version').textContent());
    expect(displayed).toBeGreaterThan(0);

    // UNE AUTRE PERSONNE ÉCRIT PENDANT QUE LE FORMULAIRE EST AFFICHÉ. Deux onglets du même
    // administrateur suffisent à le reproduire : la version ne dépend pas de qui écrit, et c'est
    // toute la raison d'être du contrôle — sans lui, le dernier écrivain gagne et la modification
    // de l'autre disparaît sans message ni trace.
    const concurrentName = `Structure doublee ${runSuffix}`;
    const concurrent = await page.request.patch(`${baseUrl}${CREATE_PATH}/${organizationId}`, {
      headers: { 'content-type': 'application/json', origin: baseUrl },
      data: { name: concurrentName, expectedVersion: displayed },
    });
    expect(concurrent.status(), "l'écriture concurrente n'a pas abouti").toBe(200);

    const auditBefore = await countRows(
      `select count(*)::text as count from public.audit_logs
        where actor_organization_id = $1::uuid and action = 'ORGANIZATION_UPDATED'`,
      [organizationId],
    );

    const hold = await holdFicheRefresh(page, organizationId);
    await page.getByTestId('champ-modification-nom').fill(`${concurrentName} perdue`);
    const answered = page.waitForResponse(
      (response) =>
        response.url().endsWith(`${CREATE_PATH}/${organizationId}`) &&
        response.request().method() === 'PATCH',
    );
    await page.getByTestId('action-modifier-organisation').getByRole('button').click();
    const response = await answered;
    expect(response.status()).toBe(409);
    expect(((await response.json()) as { error?: { code?: string } }).error?.code).toBe(
      'VERSION_CONFLICT',
    );

    const notice = page.getByTestId('message-modification-organisation');
    await expect(notice).toContainText(VERSION_CONFLICT_TITLE);
    await expect(notice).toContainText(VERSION_CONFLICT_BODY);
    // `docs/screens.md` n'exige pas seulement un message : l'écran doit RECHARGER et afficher
    // l'état réel. Un message seul laisserait la personne devant une fiche périmée en croyant
    // savoir ce qu'elle contient.
    await expect
      .poll(() => hold.observed(), { message: "la fiche n'a pas été rechargée après le conflit" })
      .toBe(true);
    await hold.release();

    // L'ÉTAT RÉEL, PAS CELUI QU'ON CROYAIT ENREGISTRER, relu du serveur.
    await page.goto(`${baseUrl}/organisations/${organizationId}`);
    await expect(page.getByTestId('organisation-nom')).toHaveText(concurrentName);
    await expect(page.getByTestId('organisation-version')).toHaveText(String(displayed + 1));

    const rows = await selectRows<{ readonly name: string; readonly version: number }>(
      'select name, version from public.organizations where id = $1',
      [organizationId],
    );
    expect(rows[0], 'la modification refusée a tout de même été écrite').toStrictEqual({
      name: concurrentName,
      version: displayed + 1,
    });
    expect(
      await countRows(
        `select count(*)::text as count from public.audit_logs
          where actor_organization_id = $1::uuid and action = 'ORGANIZATION_UPDATED'`,
        [organizationId],
      ),
      'le refus de version a laissé une trace d audit, donc quelque chose a été écrit',
    ).toBe(auditBefore);

    createdOrganizationName = concurrentName;
  });

  test('retire le périmètre territorial et la fiche dit alors qu il n y en a plus', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const { baseUrl } = requireServer();
    const organizationId = requireCreatedOrganization();
    await restoreSession(page, creatorCookie);

    const bodies: string[] = [];
    page.on('request', (request) => {
      if (
        request.method() === 'PATCH' &&
        request.url().endsWith(`${CREATE_PATH}/${organizationId}`)
      ) {
        bodies.push(request.postData() ?? '');
      }
    });

    await page.goto(`${baseUrl}/organisations/${organizationId}`);
    await expect(page.getByTestId('organisation-territoire')).toHaveText(TERRITORY_CODE);
    const displayed = Number(await page.getByTestId('organisation-version').textContent());

    // VIDER LE CHAMP VAUT DEMANDE DE RETRAIT. C'est le seul geste qui distingue « je ne touche pas
    // à ce champ » de « je retire ce périmètre » : sans clé envoyée, le serveur ne changerait rien.
    const hold = await holdFicheRefresh(page, organizationId);
    await page.getByTestId('champ-modification-code-territorial').fill('');
    await page.getByTestId('action-modifier-organisation').getByRole('button').click();

    const notice = page.getByTestId('message-modification-organisation');
    await expect(notice).toContainText(EDIT_SUCCESS_TITLE);
    await expect
      .poll(() => hold.observed(), { message: "la fiche n'a pas été rechargée après le retrait" })
      .toBe(true);
    await hold.release();

    await page.goto(`${baseUrl}/organisations/${organizationId}`);
    await expect(page.getByTestId('organisation-territoire')).toHaveText(NO_TERRITORY);
    await expect(page.getByTestId('organisation-version')).toHaveText(String(displayed + 1));

    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0] ?? '{}')).toStrictEqual({
      territoryCode: null,
      expectedVersion: displayed,
    });

    const rows = await selectRows<{
      readonly territory_code: string | null;
      readonly verification_status: string;
      readonly version: number;
    }>(
      'select territory_code, verification_status, version from public.organizations where id = $1',
      [organizationId],
    );
    // LE PÉRIMÈTRE N'EST PAS UN CHAMP D'IDENTITÉ : le corriger ne remet pas la validation en jeu.
    expect(rows[0]).toStrictEqual({
      territory_code: null,
      verification_status: 'PENDING',
      version: displayed + 1,
    });
  });

  test("refuse une soumission sans changement, et n'appelle pas le serveur pour le dire", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const { baseUrl } = requireServer();
    const organizationId = requireCreatedOrganization();
    await restoreSession(page, creatorCookie);

    let submissions = 0;
    page.on('request', (request) => {
      if (
        request.method() === 'PATCH' &&
        request.url().endsWith(`${CREATE_PATH}/${organizationId}`)
      ) {
        submissions += 1;
      }
    });

    await page.goto(`${baseUrl}/organisations/${organizationId}`);
    const displayed = Number(await page.getByTestId('organisation-version').textContent());

    await page.getByTestId('action-modifier-organisation').getByRole('button').click();

    const notice = page.getByTestId('message-modification-organisation');
    await expect(notice).toContainText(EDIT_NO_CHANGE_TITLE);
    await expect(notice).toContainText(EDIT_NO_CHANGE_BODY);

    // AUCUN APPEL N'EST PARTI. Une requête sans effet qui répondrait « enregistré » laisserait
    // croire à une modification appliquée ; une requête sans effet qui serait refusée par le
    // serveur ferait payer un aller-retour pour une information que l'écran détient déjà.
    await awaitNetworkMarker(page);
    expect(submissions, 'une modification vide est partie au serveur').toBe(0);

    // NI À L'ÉCRAN, NI EN BASE : la version n'a pas bougé.
    await expect(page.getByTestId('organisation-version')).toHaveText(String(displayed));
    expect(
      await countRows(
        'select count(*)::text as count from public.organizations where id = $1 and version = $2',
        [organizationId, displayed],
      ),
    ).toBe(1);
  });

  test('n a produit aucune erreur de console sur l ensemble du parcours', async () => {
    const rendered = applicationErrors.map((entry) => `${entry.test} :: ${entry.text}`).join(' | ');
    expect(applicationErrors, `erreurs de console : ${rendered}`).toStrictEqual([]);

    // Les seuls statuts transcrits par le navigateur doivent être ceux que les tests de refus ont
    // provoqués. Un 500 ou un 404 inattendu se signale ici, là où « aucune erreur d'application »
    // ne dirait rien.
    const unexpected = [...new Set(refusedRequestStatuses)].filter(
      (status) => !EXPECTED_REFUSAL_STATUSES.has(status),
    );
    expect(unexpected, `statuts refusés inattendus : ${unexpected.join(', ')}`).toStrictEqual([]);
  });
});

/**
 * DERNIER TEST DU FICHIER, ET C'EST VOULU.
 *
 * IL A ÉTÉ ÉCRIT ROUGE, IL EST VERT DEPUIS QUE LE CURSEUR NE TRONQUE PLUS. Sa place en fin de
 * fichier est un vestige de cette époque : en mode série, un test qui échoue fait sauter tous les
 * suivants, et le mettre en dernier évitait qu'un défaut de pagination prive le lot de la
 * couverture du parcours et de la modification de fiche. La place reste bonne pour la même raison
 * — c'est le seul test du fichier qui parcourt TOUTE la file, donc le plus long et le plus
 * dépendant de l'état de la base.
 */
test.describe('pagination de la file', () => {
  test('sert chaque organisation en attente une fois et une seule, sur tout le parcours des pages', async () => {
    const measurement = queueMeasurement;
    expect(
      measurement,
      "aucune mesure de la file : ce fichier s'exécute EN SÉRIE et le test d'administration relève la mesure que celui-ci relit. Exécutez le fichier entier, pas ce test seul.",
    ).toBeDefined();
    if (measurement === undefined) {
      return;
    }

    /*
     * CE QUE CE TEST GARDE : AUCUNE LIGNE SERVIE DEUX FOIS À LA FRONTIÈRE D'UNE PAGE.
     *
     * LE DÉFAUT QU'IL A RÉVÉLÉ, ET QUI EXPLIQUE POURQUOI IL EST ÉCRIT AINSI. `encodeCursor`
     * — `src/domain/organizations/list-pending-organizations.ts` — sérialisait l'instant du
     * curseur par `Date.prototype.toISOString()`, qui s'arrête à la MILLISECONDE, alors que
     * `created_at` est un `timestamptz` posé par `now()`, donc à la MICROSECONDE. La page suivante
     * filtre sur `(created_at, id) > (curseur, id)` : la dernière ligne de la page précédente
     * satisfaisait cette comparaison — son instant complet est strictement supérieur à sa propre
     * troncature — et elle était servie une seconde fois. Mesuré en base :
     * `(now(), id) > (date_trunc('milliseconds', now()), id)` vaut vrai. Un administrateur qui
     * tournait la page voyait la même structure deux fois, à côté d'un compteur juste qui ne
     * concordait donc plus, et cela une fois par frontière de page.
     *
     * POURQUOI AUCUN TEST NE LE VOYAIT, ET POURQUOI CELUI-CI LE VOIT.
     * `tests/integration/organizations-admin-queue.test.ts` paginait bien, mais datait ses
     * organisations par `new Date(Date.UTC(2026, 1, 1, 6, index))` : des minutes rondes, sans
     * microseconde, où la troncature ne retire rien. Il passait pour une raison qui n'existe pas
     * en production, où toute ligne naît d'un `now()`. Les organisations de remplissage de CE
     * fichier sont datées par `now()`, comme les vraies : c'est cette fixture-là, et non les
     * assertions ci-dessous, qui fait la différence. La déplacer vers des instants ronds
     * rendrait ce test complaisant sans changer une seule de ses lignes — c'est la première chose
     * à vérifier si quelqu'un le voit un jour verdir « tout seul ».
     *
     * LES TROIS ASSERTIONS SONT INDISSOCIABLES. L'unicité seule passerait sur une file tronquée
     * qui perdrait des lignes ; le total seul passerait sur une file qui servirait un doublon et
     * oublierait un voisin ; le compte des lignes RENDUES seul ne dirait rien de ce que l'API a
     * servi. Ensemble, elles disent que l'écran montre exactement la file, une fois chacune.
     */
    const identifiers = measurement.collected.map((candidate) => candidate.id);
    expect(
      new Set(identifiers).size,
      'une organisation est servie deux fois par la pagination',
    ).toBe(identifiers.length);
    expect(
      identifiers,
      'le parcours de toutes les pages ne rend pas le nombre annoncé par le compteur',
    ).toHaveLength(measurement.totalCount);
    expect(
      measurement.renderedRows,
      "l'écran n'affiche pas exactement les organisations que la file porte",
    ).toBe(measurement.totalCount);
  });
});

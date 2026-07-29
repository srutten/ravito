import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { expect, type Page, type Route, test } from '@playwright/test';
import pg from 'pg';
import { loadIntegrationEnvironment, repositoryRoot } from '../integration/setup/environment';

/**
 * ÉCRAN D'ADMINISTRATION DES ORGANISATIONS : pagination, six états, refus d'écran, rendu littéral
 * des noms hostiles (US-012, `docs/screens.md` écrans 10 et 11, `docs/test-plan.md` tests
 * sécurité).
 *
 * CE QUE CE FICHIER COUVRE, ET QUE PERSONNE NE COUVRAIT. La file d'administration n'avait jamais
 * été vue au-delà de sa première page, et aucun de ses six états — chargement, vide, erreur,
 * refus survenu APRÈS ouverture, liste datée, données obsolètes — n'avait jamais été rendu par un
 * test. Onze repères déclarés dans l'interface n'étaient atteints par rien. Un écran qui n'est
 * jamais rendu est un écran dont on ne sait pas s'il fonctionne : l'API peut être irréprochable,
 * c'est l'écran que l'administrateur regarde.
 *
 * POURQUOI CE FICHIER LANCE SON PROPRE SERVEUR. Les deux raisons de `tests/e2e/organizations.spec.
 * ts` valent ici mot pour mot : le port 3000 est occupé par un conteneur qui sert un artefact
 * construit un autre jour, et le code de connexion à usage unique n'est lisible que dans la sortie
 * du serveur. Ce fichier doit donc figurer dans `SELF_HOSTED_SPECS` de `playwright.config.ts`,
 * fichier qui n'est pas dans le périmètre de cet agent : tant qu'il n'y est pas, le serveur commun
 * est monté en plus du sien — sans conséquence en local, où il est réutilisé, mais fatal en
 * intégration continue sur un port déjà pris. Le point est signalé plutôt que contourné.
 *
 * DUPLICATION ASSUMÉE AVEC `organizations.spec.ts`. Le montage du serveur, la lecture du code, le
 * ramassage des restes et la purge y sont écrits une première fois. Les factoriser demanderait un
 * module partagé sous `tests/e2e/`, hors du périmètre de ce fichier ; la reprise est signalée pour
 * qu'elle soit faite d'un seul geste le jour où ce périmètre s'ouvre.
 *
 * BASE DE DÉVELOPPEMENT, PAS BASE JETABLE, ET CLOISONNEMENT PROPRE À L'EXÉCUTION. Chaque exécution
 * porte son suffixe, verrouille ce suffixe avant sa première écriture, ramasse au démarrage les
 * restes des exécutions dont le verrou est libre, et retire à la fin tout ce qu'elle a posé. Deux
 * exécutions simultanées — deux projets Playwright, un développeur et l'intégration continue — ne
 * peuvent donc pas s'entre-détruire. Les préfixes (`FICTIF-ADM`, `sentinelle-adm`) sont DISTINCTS
 * de ceux de `organizations.spec.ts` (`FICTIF-E2E`, `sentinelle-org`) : les deux fichiers écrivent
 * dans la même base sans jamais se voir, et le ramassage de l'un ne peut pas emporter l'autre.
 *
 * AUCUNE VALEUR ATTENDUE N'EST IMPORTÉE DE `src/i18n/fr.ts`. Les libellés sont recopiés à la main :
 * les comparer au catalogue qui les produit n'éprouverait rien, le test passerait quel que soit le
 * texte affiché, y compris vide.
 */

/**
 * EXÉCUTION EN SÉRIE, DANS UN SEUL TRAVAILLEUR. Les tests partagent un serveur, deux comptes, deux
 * organisations construites par les premiers d'entre eux et une mesure de la file relevée une
 * seule fois. Les tests dépendants le DISENT dans leur message d'échec plutôt que d'échouer sur un
 * repère introuvable dont personne ne devine la cause.
 */
test.describe.configure({ mode: 'serial' });

const AUTH_SECRET = 'secret-e2e-fictif-de-plus-de-32-caracteres-pour-l-administration';
const SERVER_READY_TIMEOUT_MS = 120_000;
const SESSION_COOKIE_NAME = 'appui_feux_session';
const LOOPBACK_HOST = '127.0.0.1';

const CREATE_PATH = '/api/v1/organizations';
const PENDING_PATH = '/api/v1/admin/organizations/pending';
const PENDING_SCREEN_PATH = '/administration/organisations-en-attente';
const NEW_ORGANIZATION_PATH = '/organisations/nouvelle';
const SIGN_IN_PATH = '/connexion';
const HEALTH_PATH = '/api/v1/health';

/** Repères du parcours : préfixes fictifs exigés par `docs/test-plan.md`, et pivots du nettoyage. */
const REGISTRATION_PREFIX = 'FICTIF-ADM';
const IDENTIFIER_PREFIX = 'sentinelle-adm';
const TERRITORY_CODE = 'ZZ-ADM-01';

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
 * Espace de verrous consultatifs PROPRE À CE FICHIER, distinct de celui de `organizations.spec.ts`.
 *
 * Chaque fichier ramasse les restes de ses propres préfixes et d'eux seuls ; leur donner deux
 * espaces de verrous évite qu'une collision d'empreinte `hashtext` entre deux suffixes étrangers
 * ne fasse croire à l'un que l'exécution de l'autre est encore vivante.
 */
const RUN_LOCK_NAMESPACE = 13;

/**
 * Organisations de remplissage, posées en SQL direct et purgées avec le reste.
 *
 * SANS ELLES, LA PAGINATION NE SERAIT JAMAIS EXERCÉE : `PAGE_SIZE` vaut 25 et la base de
 * développement porte une seule organisation en attente. Vingt-six suffisent à garantir une
 * seconde page à elles seules, quel que soit le contenu antérieur de la base.
 *
 * ELLES SONT DATÉES DANS LE PASSÉ, donc placées AVANT les organisations que le parcours crée. Les
 * plus anciennes passent devant — c'est l'ordre de service que `docs/screens.md` impose — et
 * atteindre les plus récentes impose alors de tourner les pages. C'est exactement la régression à
 * garder : une pagination qui ne progresse pas rend les plus anciennes inatteignables sans que le
 * compteur ne change d'un chiffre.
 *
 * ELLES SONT DATÉES PAR `now()`, à la microseconde, comme toute ligne née en production. Les dater
 * sur des secondes rondes ferait passer ce fichier pour une raison qui n'existe nulle part
 * ailleurs : c'est précisément ce qui a laissé le défaut de curseur du dernier test invisible aux
 * tests d'intégration.
 */
const QUEUE_FILLER_COUNT = 26;
const QUEUE_FILLER_LABEL = 'remplissage';
const QUEUE_FILLER_AGE = '3 hours';

/** Taille de page de `src/domain/organizations/list-pending-organizations.ts`. */
const PAGE_SIZE = 25;

/** Bornes de sûreté : une file qui les dépasserait signale un problème, pas une grande file. */
const MAX_QUEUE_PAGES = 40;
const MAX_QUEUE_MEASUREMENTS = 3;

/**
 * Libellés attendus, recopiés caractère pour caractère de `src/i18n/fr.ts`. Les apostrophes y sont
 * droites (U+0027) et non typographiques.
 */
const QUEUE_TITLE = 'Organisations en attente';
const QUEUE_COUNT_ONE = 'organisation en attente';
const QUEUE_COUNT_MANY = 'organisations en attente';
const QUEUE_REFRESH = 'Rafraîchir la file';
const QUEUE_LOAD_MORE = 'Afficher les organisations suivantes';
const QUEUE_LAST_LOADED_UNKNOWN = 'Aucun chargement abouti';
const QUEUE_LAST_LOADED_AT = 'Dernier chargement';
const QUEUE_EMPTY_TITLE = 'Aucune organisation en attente.';
const QUEUE_EMPTY_BODY =
  "Toutes les organisations déclarées ont été traitées. Cet écran ne signale rien d'anormal.";
const QUEUE_STALE_TITLE = 'Liste datée';
const QUEUE_STALE_BODY =
  "Cette liste date de son dernier chargement abouti et n'est peut-être plus à jour. Rafraîchissez-la dès que la connexion revient.";
const STALE_DATA_TITLE =
  'Ces informations datent de votre dernière connexion et ne sont peut-être plus à jour.';
const LOADING_LABEL = 'Chargement en cours...';
const ERROR_TITLE = 'Une erreur est survenue. Réessayez dans un instant.';
const RETRY_LABEL = 'Réessayer';
const PERMISSION_DENIED = "Vous n'avez pas les droits nécessaires pour consulter cette page.";
const NOT_FOUND_TITLE = 'Page introuvable';
const NOT_FOUND_BODY = "La page demandée n'existe pas ou n'est plus disponible.";
const NO_TERRITORY = 'Aucun périmètre déclaré';
const SUBMIT_LABEL = "Créer l'organisation";
const REQUESTED_BY_UNKNOWN = 'Demandeur non renseigné';

/**
 * Charges hostiles poussées dans le SEUL champ libre du formulaire.
 *
 * `nameSchema` (`src/domain/organizations/validation.ts`) ne porte AUCUNE expression régulière :
 * une balise est un nom d'organisation valide, et c'est un choix — une structure peut légitimement
 * s'appeler « Martin & Fils <SARL> ». La conséquence est que l'échappement du rendu est la seule
 * chose qui protège, et que personne ne l'éprouvait. `registrationNumber` et `territoryCode`, eux,
 * sont fermés par une classe de caractères : le test le vérifie plutôt que de le supposer.
 *
 * LA CIBLE N'EST PAS LE CRÉATEUR, C'EST L'ADMINISTRATEUR PLATEFORME. C'est le compte le plus
 * puissant de la plateforme, et celui qui lit par métier des noms saisis par des inconnus : une
 * charge qui s'exécuterait dans sa session s'exécuterait avec ses droits.
 */
const XSS_MARKER = 'charge-executee';
const XSS_NAME_SEED = `<img src=x onerror="document.title='${XSS_MARKER}'"><script>document.title='${XSS_MARKER}'</script>`;
const SQL_NAME_SEED = "'; drop table public.organizations; --";
const SQL_CURSOR = "' or 1=1 --";

/** Sorties toujours redirigées, entrée jamais : c'est ce que `stdio` déclare plus bas. */
type ServerProcess = ChildProcessByStdio<null, Readable, Readable>;

interface ServerHandle {
  readonly baseUrl: string;
  readonly process: ServerProcess;
  readonly lines: string[];
}

let server: ServerHandle | undefined;
let client: pg.Client | undefined;
let startedAt = new Date();

let runSuffix = '';

/**
 * Initiales et non patronymes : `docs/test-plan.md` interdit tout contact réel ou nominatif, et le
 * reste du dépôt s'y tient déjà.
 */
const ADMIN_DISPLAY_NAME = 'Noor B.';
const AUTHOR_DISPLAY_NAME = 'Théo L.';

let adminEmail = '';
let adminUserId = '';
let carrierOrganizationId = '';

let authorEmail = '';
let adminCookie = '';
let authorCookie = '';

/** Organisations créées par le parcours, et le nom exact qu'elles portent. */
let hostileOrganizationId = '';
let hostileName = '';
let hostileRegistration = '';
let injectedOrganizationId = '';
let injectedName = '';
let injectedRegistration = '';

/** Premier remplissage, repère du test « données obsolètes » : il est en première page. */
let firstFillerId = '';
let firstFillerName = '';

/** Mesure de la file relevée par le test de pagination, relue par le dernier test du fichier. */
let queueMeasurement: QueueMeasurement | undefined;

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
    // Source facultative : son absence n'est pas une faute.
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
 * Sans cette vérification, l'affirmation « ce fichier sert le code du dépôt » reposerait sur la
 * discipline de qui lance la commande, et un `.next` d'hier rendrait un verdict vert sur le code
 * d'hier.
 */
async function assertRebuiltArtifact(): Promise<void> {
  const root = repositoryRoot();
  const buildId = await newestChange(path.join(root, '.next', 'BUILD_ID'));
  if (buildId === null) {
    throw new Error(
      "aucun artefact `.next` : ce parcours s'exécute sur le code construit. Lancez `npm run build` avant `playwright test`.",
    );
  }
  for (const source of BUILD_SOURCES) {
    const newest = await newestChange(path.join(root, source));
    if (newest !== null && newest.at > buildId.at) {
      throw new Error(
        `l'artefact \`.next\` est plus ancien que ${path.relative(root, newest.path)} : le verdict porterait sur du code qui n'est plus celui du dépôt. Lancez \`npm run build\` avant \`playwright test\`.`,
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
      // éveillée cinq secondes de plus, pour rien.
      clearTimeout(forced);
      resolve();
    });
    handle.process.kill();
  });
}

/**
 * Démarre `next start` sur un port libre, avec une configuration explicite.
 *
 * UN DÉMARRAGE QUI ÉCHOUE N'ABANDONNE PAS SON PROCESSUS : le `next start` engendré survivrait
 * sinon à l'exception, garderait son port et son bassin de connexions PostgreSQL, et ne serait tué
 * par personne.
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

/** Lit le code remis par l'adaptateur de journalisation, seul endroit où il soit lisible. */
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

/** Repère posé par un test antérieur, exigé par ceux qui s'appuient dessus. */
function requireSeededOrganization(value: string, what: string): string {
  expect(
    value,
    `${what} n'existe pas : ce fichier s'exécute EN SÉRIE et ses premiers tests construisent ce dont les suivants se servent. Exécutez le fichier entier, pas ce test seul.`,
  ).not.toBe('');
  return value;
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
 * UN SEUL CHEMIN DE PURGE, appelé par `afterAll` ET par le ramassage des restes : le code du
 * ramassage est donc exercé à chaque exécution normale, il ne peut pas pourrir en silence.
 *
 * LES COMPTES SONT RETROUVÉS PAR LEUR ADRESSE, jamais par des identifiants mémorisés : une
 * exécution interrompue n'en a transmis aucun, et ses profils, sessions et défis resteraient
 * sinon en base pour toujours.
 *
 * L'ORDRE EST IMPOSÉ PAR LES CLÉS ÉTRANGÈRES : `organization_members` référence `organizations` et
 * `user_profiles` sans clause `ON DELETE`.
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
  // permet de retirer les lignes produites ici. Le filtre est NOMINATIF plutôt que temporel, pour
  // ne pas emporter les lignes d'une exécution voisine.
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
 * SEULS LES SUFFIXES SANS VERROU SONT PURGÉS. Une exécution vivante tient le sien depuis sa
 * première requête, avant même d'avoir semé quoi que ce soit : elle ne peut pas être emportée par
 * une voisine démarrée une seconde plus tard. C'est la transposition exacte du critère de
 * `tests/integration/setup/database.ts`, qui ne supprime une base jetable que si plus aucune
 * connexion ne la porte.
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
      `^${IDENTIFIER_PREFIX}-(?:auteur-)?(${RUN_KEY_SQL_SHAPE})@exemple\\.test$`,
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
 * `VERIFIED` afin de ne pas venir grossir la file que ce fichier mesure.
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
 * Pose les organisations de remplissage, en une seule instruction.
 *
 * Elles ne portent AUCUNE adhésion : la file affiche alors « Demandeur non renseigné », état prévu
 * par `docs/screens.md`, et ce fichier n'a pas à fabriquer vingt-six comptes pour éprouver une
 * pagination.
 */
async function seedQueueFillers(): Promise<void> {
  const prefix = `${REGISTRATION_PREFIX}-${runSuffix}-${QUEUE_FILLER_LABEL}-`;
  await requireClient().query(
    `insert into public.organizations
       (name, type, registration_number, territory_code, verification_status, status, created_at)
     select
       'Structure ADM ' || lpad(position::text, 2, '0') || ' ' || $1,
       'ASSOCIATION',
       $2 || lpad(position::text, 2, '0'),
       null,
       'PENDING',
       'ACTIVE',
       now() - interval '${QUEUE_FILLER_AGE}' + (position * interval '1 second')
     from generate_series(1, $3::int) as position`,
    [runSuffix, prefix, QUEUE_FILLER_COUNT],
  );
  // La PREMIÈRE est désignée par son numéro et non par l'ordre de retour de l'insertion : c'est
  // elle que le relevé des départs fait quitter la file, et elle doit être en première page.
  const rows = await selectRows<{ readonly id: string; readonly name: string }>(
    'select id, name from public.organizations where registration_number = $1',
    [`${prefix}01`],
  );
  const first = rows[0];
  if (first === undefined) {
    throw new Error("les organisations de remplissage n'ont pas été créées");
  }
  firstFillerId = first.id;
  firstFillerName = first.name;
}

/** Parcours de connexion complet, tel qu'un navigateur l'exécute. Rend le jeton de session. */
async function signIn(page: Page, identifier: string): Promise<string> {
  const handle = requireServer();
  await page.goto(`${handle.baseUrl}${SIGN_IN_PATH}`);
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
 * POURQUOI PLUTÔT QUE DE SE RECONNECTER. La limitation de tentatives compte cinq demandes de code
 * par identifiant et vingt par source : une dizaine de tests qui se reconnecteraient
 * déclencheraient un `RATE_LIMITED` étranger à ce qu'ils éprouvent — et la source, ici, est
 * l'adresse de bouclage, commune à TOUS les fichiers de bout en bout.
 */
async function restoreSession(page: Page, token: string): Promise<void> {
  expect(
    token,
    "aucune session partagée : ce fichier s'exécute EN SÉRIE et ses premiers tests ouvrent les sessions dont les suivants se servent. Exécutez le fichier entier, pas ce test seul.",
  ).not.toBe('');
  await page
    .context()
    .addCookies([{ name: SESSION_COOKIE_NAME, value: token, domain: LOOPBACK_HOST, path: '/' }]);
}

function nextRegistrationNumber(label: string): string {
  return `${REGISTRATION_PREFIX}-${runSuffix}-${label}-${randomUUID().slice(0, 8)}`;
}

/** Interception de la file, posée sur le chemin exact et non sur un motif approximatif. */
function queueRouteMatcher(url: URL): boolean {
  return url.pathname === PENDING_PATH;
}

interface QueuePagePayload {
  readonly items: readonly Record<string, unknown>[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

/**
 * Substitue une réponse à la file.
 *
 * POURQUOI UNE SUBSTITUTION ICI, ET NULLE PART AILLEURS DANS CE FICHIER. Deux états de
 * `docs/screens.md` — file vide, erreur du serveur — ne sont pas atteignables sur une base de
 * développement partagée : vider la file supposerait de retirer les organisations en attente des
 * autres, et provoquer une erreur interne supposerait de casser la base pour tout le monde. Ce qui
 * est éprouvé ici est l'ÉCRAN, pas la route : la forme des réponses substituées est celle que
 * `tests/integration/organizations-admin-queue.test.ts` fige sur la vraie route. Les quatre autres
 * états — chargement, refus après ouverture, liste datée, données obsolètes — sont obtenus SANS
 * substitution de contenu, par retenue de la vraie requête, par mutation réelle en base ou par
 * coupure réseau.
 */
async function stubQueue(page: Page, payload: QueuePagePayload): Promise<void> {
  await page.route(queueRouteMatcher, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });
}

async function failQueue(page: Page, status: number, code: string): Promise<void> {
  await page.route(queueRouteMatcher, async (route: Route) => {
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code, message: 'refus fabrique par le test' } }),
    });
  });
}

/** Coupe le réseau sur la seule route de la file : le reste de l'écran continue de vivre. */
async function cutQueueNetwork(page: Page): Promise<void> {
  await page.route(queueRouteMatcher, async (route: Route) => {
    await route.abort('failed');
  });
}

/** Déroule la file jusqu'à sa dernière page et rend le nombre de pages parcourues. */
async function loadEveryQueuePage(page: Page): Promise<number> {
  // LA FILE SE REMPLIT APRÈS LE RENDU, par une requête du navigateur. Dérouler avant ce moment
  // trouverait un écran encore vide, conclurait « une seule page » et rendrait vert un test qui
  // n'aurait rien parcouru : le compteur est le premier témoin d'un chargement abouti.
  await expect(page.getByTestId('compteur-organisations-en-attente')).toBeVisible();
  const rows = page.getByTestId('ligne-organisation-en-attente');
  const nextPage = page.getByTestId('action-page-suivante').getByRole('button');
  for (let pages = 1; pages <= MAX_QUEUE_PAGES; pages += 1) {
    if ((await nextPage.count()) === 0) {
      return pages;
    }
    // Le libellé du bouton est vérifié à chaque tour : c'est la seule commande qui donne accès aux
    // organisations au-delà de la page courante, et un libellé muet la rendrait introuvable.
    await expect(nextPage).toHaveText(QUEUE_LOAD_MORE);
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

/** Numéros d'immatriculation rendus, dans l'ordre du document. */
async function renderedRegistrations(page: Page): Promise<readonly string[]> {
  return page
    .getByTestId('ligne-immatriculation')
    .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ''));
}

/** Instants de dépôt rendus, dans l'ordre du document, lus sur l'attribut machine de `<time>`. */
async function renderedInstants(page: Page): Promise<readonly string[]> {
  return page
    .getByTestId('ligne-organisation-en-attente')
    .locator('time')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('datetime') ?? ''));
}

interface QueueMeasurement {
  readonly databaseCount: number;
  readonly counterText: string;
  readonly registrations: readonly string[];
  readonly instants: readonly string[];
  readonly firstPageRows: number;
  readonly screenPages: number;
}

/**
 * Mesure la file rendue, sur un état STABLE.
 *
 * POURQUOI CE DÉTOUR. Le compteur doit valoir le nombre RÉEL d'organisations en attente, sans
 * plafonnement : la seule assertion qui distingue un compteur juste d'un compteur borné à la page
 * est l'ÉGALITÉ avec le compte de la base. Or l'autre projet Playwright, et les autres fichiers de
 * bout en bout, écrivent dans la même base pendant ce temps. La mesure est donc encadrée par deux
 * comptes : s'ils diffèrent, elle n'a pas eu lieu sur un état stable et elle est reprise. Une
 * inégalité `>=` aurait été satisfaite par n'importe quel compteur, y compris plafonné.
 */
async function measureQueue(page: Page, baseUrl: string): Promise<QueueMeasurement> {
  for (let attempt = 1; attempt <= MAX_QUEUE_MEASUREMENTS; attempt += 1) {
    const before = await countPendingOrganizations();

    await page.goto(`${baseUrl}${PENDING_SCREEN_PATH}`);
    await expect(page.getByTestId('file-organisations-en-attente')).toBeVisible();
    await expect(page.getByTestId('compteur-organisations-en-attente')).toBeVisible();

    // PREMIÈRE PAGE, AVANT TOUT DÉROULEMENT : c'est là que se lit la taille de page.
    const firstPageRows = await page.getByTestId('ligne-organisation-en-attente').count();
    const screenPages = await loadEveryQueuePage(page);
    const counterText =
      (await page.getByTestId('compteur-organisations-en-attente').textContent()) ?? '';
    const registrations = await renderedRegistrations(page);
    const instants = await renderedInstants(page);

    const after = await countPendingOrganizations();
    if (before === after) {
      return {
        databaseCount: before,
        counterText,
        registrations,
        instants,
        firstPageRows,
        screenPages,
      };
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

    runSuffix = `${info.project.name}-${randomUUID().slice(0, 8)}`;
    expect(
      runSuffix,
      'le suffixe d exécution n est plus lisible par le ramassage des restes : renommer un projet Playwright impose de revoir RUN_KEY_SHAPE',
    ).toMatch(RUN_KEY_SHAPE);

    // Le verrou est pris AVANT toute écriture : rien de cette exécution n'existe en base pendant
    // qu'elle est encore ramassable.
    await client.query('select pg_advisory_lock($1::int, hashtext($2))', [
      RUN_LOCK_NAMESPACE,
      runSuffix,
    ]);
    await collectLeftovers();

    adminEmail = `${IDENTIFIER_PREFIX}-${runSuffix}@exemple.test`;
    adminUserId = await seedProfile(ADMIN_DISPLAY_NAME, adminEmail);
    carrierOrganizationId = await seedPlatformAdmin(
      adminUserId,
      nextRegistrationNumber('porteuse'),
    );

    authorEmail = `${IDENTIFIER_PREFIX}-auteur-${runSuffix}@exemple.test`;
    await seedProfile(AUTHOR_DISPLAY_NAME, authorEmail);

    await seedQueueFillers();

    hostileName = `${XSS_NAME_SEED} ${runSuffix}`;
    injectedName = `${SQL_NAME_SEED} ${runSuffix}`;

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
   * La table porte une ligne UNIQUE par sujet limité (`uq_auth_attempts_subject_hash`) : elle est
   * réutilisée d'une exécution à l'autre, jamais dupliquée. Son `created_at` est celui de la
   * PREMIÈRE exécution de la journée, et un filtre posé dessus ne retirerait rien de ce que les
   * suivantes ont incrémenté — le compteur de dimension « source », l'adresse de bouclage commune
   * à tous les fichiers, monterait alors sans jamais redescendre jusqu'au `RATE_LIMITED`.
   * `updated_at`, tenu par le déclencheur `auth_attempts_set_updated_at`, désigne exactement les
   * lignes que cette exécution a touchées.
   */
  await client.query('delete from public.auth_attempts where updated_at >= $1', [startedAt]);
  await client.end();
});

/**
 * RENDU LITTÉRAL D'UN NOM HOSTILE (trou « injection et XSS » de `docs/test-plan.md`).
 *
 * Aujourd'hui React échappe et le cookie de session est `HttpOnly` : rien ne se passe. Le jour où
 * un composant de la file ou de la fiche passera par `dangerouslySetInnerHTML`, par une
 * bibliothèque de mise en évidence de recherche ou par un export de la file, la charge s'exécutera
 * dans la session d'un administrateur plateforme. Ces tests figent l'échappement qui protège, et
 * ils le figent sur les DEUX écrans qui affichent un nom saisi par un inconnu.
 */
test.describe('noms hostiles, rendus littéralement', () => {
  test('crée une organisation dont le nom porte une charge, et la fiche la rend telle quelle', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { baseUrl } = requireServer();

    const pageErrors: string[] = [];
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });

    authorCookie = await signIn(page, authorEmail);

    await page.goto(`${baseUrl}${NEW_ORGANIZATION_PATH}`);
    await expect(page.getByTestId('formulaire-creation-organisation')).toBeVisible();

    hostileRegistration = nextRegistrationNumber('charge');
    await page.getByTestId('champ-nom-organisation').fill(hostileName);
    await page.getByTestId('champ-type-organisation').selectOption('ASSOCIATION');
    await page.getByTestId('champ-immatriculation').fill(hostileRegistration);
    await page.getByTestId('champ-code-territorial').fill(TERRITORY_CODE);
    await page.getByRole('button', { name: SUBMIT_LABEL }).click();

    await expect(page).toHaveURL(/\/organisations\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    hostileOrganizationId = page.url().split('/').at(-1) ?? '';
    expect(hostileOrganizationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // LE NOM EST ENREGISTRÉ TEL QUEL : aucun filtre silencieux ne l'a raccourci ni réécrit. Une
    // désinfection posée à l'écriture serait pire qu'un échappement au rendu — elle mutilerait un
    // nom légitime portant une esperluette ou un chevron, sans que personne ne le sache.
    const stored = await selectRows<{ readonly name: string }>(
      'select name from public.organizations where id = $1',
      [hostileOrganizationId],
    );
    expect(stored[0]?.name).toBe(hostileName);

    // LE TEXTE EST RENDU, PAS INTERPRÉTÉ. `toHaveText` compare le texte accessible : si la balise
    // avait été interprétée, le nœud ne porterait plus ce texte.
    await expect(page.getByTestId('organisation-nom')).toHaveText(hostileName);
    await expect(page.getByTestId('identite-organisation')).toContainText(hostileRegistration);
    // Le titre de la fiche est le nom de l'organisation : c'est le second endroit où il est rendu.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(hostileName);

    // AUCUN NŒUD N'A ÉTÉ CRÉÉ PAR LA CHARGE, et rien ne s'est exécuté.
    await expect(page.locator('img[onerror]')).toHaveCount(0);
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    expect(await page.title(), 'la charge a modifié le titre du document').not.toContain(
      XSS_MARKER,
    );
    expect(pageErrors, `la page a levé une exception : ${pageErrors.join(' | ')}`).toStrictEqual(
      [],
    );
  });

  test('une charge SQL dans un champ libre crée une organisation portant ce nom exact, sans rien casser', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const { baseUrl } = requireServer();
    await restoreSession(page, authorCookie);
    await page.goto(`${baseUrl}/apres-connexion`);

    const organizationsBefore = await countRows(
      'select count(*)::text as count from public.organizations',
      [],
    );

    injectedRegistration = nextRegistrationNumber('injection');
    const created = await page.request.post(`${baseUrl}${CREATE_PATH}`, {
      headers: { 'content-type': 'application/json', origin: baseUrl },
      data: {
        name: injectedName,
        type: 'COMPANY',
        registrationNumber: injectedRegistration,
        clientEventId: randomUUID(),
      },
    });
    expect(created.status()).toBe(201);
    const body = (await created.json()) as { readonly organization?: { readonly id?: string } };
    injectedOrganizationId = body.organization?.id ?? '';
    expect(injectedOrganizationId).not.toBe('');

    // LA TABLE EXISTE TOUJOURS, et le nom est stocké caractère pour caractère : les paramètres
    // liés ont fait leur travail, la charge est une donnée et non une instruction.
    const table = await selectRows<{ readonly present: string | null }>(
      "select to_regclass('public.organizations')::text as present",
      [],
    );
    expect(table[0]?.present, 'la table des organisations a disparu').toBe('organizations');
    const stored = await selectRows<{ readonly name: string }>(
      'select name from public.organizations where id = $1',
      [injectedOrganizationId],
    );
    expect(stored[0]?.name).toBe(injectedName);
    expect(
      await countRows('select count(*)::text as count from public.organizations', []),
      "la création a produit autre chose qu'une organisation",
    ).toBe(organizationsBefore + 1);

    // LES CHAMPS FERMÉS LE SONT VRAIMENT. `registrationNumber` et `territoryCode` portent une
    // classe de caractères ; la charge y est refusée AVANT toute écriture, et le refus nomme le
    // champ fautif plutôt que de rendre une erreur interne.
    for (const [field, payload] of [
      ['registrationNumber', SQL_NAME_SEED],
      ['territoryCode', SQL_NAME_SEED],
    ] as const) {
      const refused = await page.request.post(`${baseUrl}${CREATE_PATH}`, {
        headers: { 'content-type': 'application/json', origin: baseUrl },
        data: {
          name: `Structure ${field} ${runSuffix}`,
          type: 'COMPANY',
          registrationNumber:
            field === 'registrationNumber' ? payload : nextRegistrationNumber('r'),
          ...(field === 'territoryCode' ? { territoryCode: payload } : {}),
          clientEventId: randomUUID(),
        },
      });
      expect(refused.status(), `statut pour une charge dans ${field}`).toBe(400);
      const refusal = (await refused.json()) as {
        readonly error?: { readonly code?: string; readonly details?: { fields?: unknown } };
      };
      expect(refusal.error?.code).toBe('VALIDATION_ERROR');
      expect(refusal.error?.details?.fields).toStrictEqual([field]);
    }

    // LE CURSEUR EST UNE ENTRÉE EXTERNE COMME UNE AUTRE. Il est décodé puis validé, et une charge
    // n'y produit ni page vide — qui ferait croire la file épuisée — ni erreur interne.
    const cursor = await page.request.get(
      `${baseUrl}${PENDING_PATH}?cursor=${encodeURIComponent(SQL_CURSOR)}`,
    );
    expect(cursor.status()).toBe(400);
    const cursorRefusal = (await cursor.json()) as {
      readonly error?: { readonly code?: string; readonly details?: { fields?: unknown } };
    };
    expect(cursorRefusal.error?.code).toBe('VALIDATION_ERROR');
    expect(cursorRefusal.error?.details?.fields).toStrictEqual(['cursor']);
  });
});

/**
 * FILE D'ADMINISTRATION : pagination, ordre, compteur, et les six états de `docs/screens.md`.
 */
test.describe("file d'administration", () => {
  test('déroule la file au-delà de la première page, sans perdre les plus anciennes', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { baseUrl } = requireServer();
    requireSeededOrganization(hostileOrganizationId, "l'organisation au nom hostile");
    requireSeededOrganization(injectedOrganizationId, "l'organisation à la charge SQL");
    adminCookie = await signIn(page, adminEmail);

    const measurement = await measureQueue(page, baseUrl);
    queueMeasurement = measurement;

    // LE LIEN D'ADMINISTRATION EST OFFERT À QUI PEUT S'EN SERVIR. Ce n'est pas une mesure de
    // sécurité — la route et la page refusent d'elles-mêmes —, c'est de l'honnêteté d'interface :
    // son absence pour un compte ordinaire est éprouvée par `organizations.spec.ts`, sa présence
    // pour un administrateur ne l'était par personne.
    await expect(page.getByTestId('lien-organisations-en-attente')).toBeVisible();

    // L'ÉCRAN SE NOMME, ET SES DEUX COMMANDES AUSSI. Les libellés sont recopiés du catalogue : un
    // bouton « Suivant » à la place de « Afficher les organisations suivantes » ne dirait pas ce
    // qu'il fait à qui l'entend seul, hors de son contexte visuel.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(QUEUE_TITLE);
    await expect(page.getByTestId('action-rafraichir-file').getByRole('button')).toHaveText(
      QUEUE_REFRESH,
    );

    // LA PREMIÈRE PAGE EST PLEINE ET BORNÉE. Sans cette assertion, une pagination qui servirait
    // tout d'un coup — ou qui ne servirait rien — passerait pour correcte.
    expect(
      measurement.firstPageRows,
      "la première page ne porte pas la taille de page du domaine : la pagination de l'écran n'est plus celle que ce test croit mesurer",
    ).toBe(PAGE_SIZE);
    expect(
      measurement.screenPages,
      "la file tient sur une page : la pagination de l'écran n'a pas été éprouvée",
    ).toBeGreaterThan(1);

    // ORDRE DE SERVICE : DU PLUS ANCIEN AU PLUS RÉCENT. C'est la raison d'être de la file — une
    // file triée par nouveauté laisse au fond celles que personne n'a traitées. L'ordre est lu sur
    // l'attribut machine de `<time>`, pas sur le texte affiché, qui est localisé.
    const instants = measurement.instants;
    expect(instants).toHaveLength(measurement.registrations.length);
    for (let index = 1; index < instants.length; index += 1) {
      const previous = Date.parse(instants[index - 1] ?? '');
      const current = Date.parse(instants[index] ?? '');
      expect(Number.isNaN(previous) || Number.isNaN(current)).toBe(false);
      expect(
        current,
        `la ligne ${String(index + 1)} est plus ancienne que celle qui la précède : la file n'est plus triée du plus ancien au plus récent`,
      ).toBeGreaterThanOrEqual(previous);
    }

    // TOUTES LES PLUS ANCIENNES SONT ATTEIGNABLES. C'est la régression que ce test garde : un
    // bouton « page suivante » qui réutiliserait le curseur de la première page laisserait
    // l'écran afficher vingt-cinq lignes et un compteur rassurant, pendant que les vingt-six
    // organisations les plus anciennes deviendraient définitivement invisibles.
    const seen = new Set(measurement.registrations);
    for (let position = 1; position <= QUEUE_FILLER_COUNT; position += 1) {
      const registration = `${REGISTRATION_PREFIX}-${runSuffix}-${QUEUE_FILLER_LABEL}-${String(position).padStart(2, '0')}`;
      expect(
        seen.has(registration),
        `l'organisation de remplissage ${String(position)} n'est atteignable par aucune page`,
      ).toBe(true);
    }
    // Et les DEUX PLUS RÉCENTES, celles que le parcours vient de créer, le sont aussi : elles sont
    // en fin de file, donc au-delà de la première page.
    expect(seen.has(hostileRegistration), "l'organisation au nom hostile est introuvable").toBe(
      true,
    );
    expect(seen.has(injectedRegistration), "l'organisation à la charge SQL est introuvable").toBe(
      true,
    );

    // LE COMPTEUR EST LE NOMBRE RÉEL, NON PLAFONNÉ. La mesure a eu lieu sur un état stable : c'est
    // donc une ÉGALITÉ qui est exigée, une inégalité étant satisfaite par un compteur borné à 25.
    expect(measurement.databaseCount).toBeGreaterThan(PAGE_SIZE);
    expect(measurement.counterText).toBe(
      `${String(measurement.databaseCount)} ${
        measurement.databaseCount <= 1 ? QUEUE_COUNT_ONE : QUEUE_COUNT_MANY
      }`,
    );

    // LE BOUTON A DISPARU AU BOUT DE LA FILE, il ne promet pas une page suivante qui serait vide.
    await expect(page.getByTestId('action-page-suivante')).toHaveCount(0);

    // MINIMISATION : une organisation sans adhésion dit « Demandeur non renseigné » et n'invente
    // personne ; une organisation sans périmètre le dit aussi, l'absence étant une information.
    const filler = page
      .getByTestId('ligne-organisation-en-attente')
      .filter({ hasText: firstFillerName });
    await expect(filler).toHaveCount(1);
    await expect(filler.getByTestId('ligne-demandeur')).toHaveText(REQUESTED_BY_UNKNOWN);
    await expect(filler.getByTestId('ligne-territoire')).toHaveText(NO_TERRITORY);
    await expect(filler.getByTestId('ligne-anciennete')).toHaveText('3 heures');
  });

  test('rend les noms hostiles littéralement dans la file, sous les yeux de l administrateur', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { baseUrl } = requireServer();
    requireSeededOrganization(hostileRegistration, "l'organisation au nom hostile");
    await restoreSession(page, adminCookie);

    const pageErrors: string[] = [];
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });

    await page.goto(`${baseUrl}${PENDING_SCREEN_PATH}`);
    await expect(page.getByTestId('file-organisations-en-attente')).toBeVisible();
    await loadEveryQueuePage(page);

    // LA LIGNE EST RETROUVÉE PAR SON NUMÉRO, jamais par le nom : chercher par le nom ferait
    // dépendre le test de l'échappement qu'il éprouve.
    const row = page
      .getByTestId('ligne-organisation-en-attente')
      .filter({ hasText: hostileRegistration });
    await expect(row).toHaveCount(1);
    // Le nom est le titre de la carte : c'est là qu'il est rendu.
    await expect(row.getByRole('heading', { level: 3 })).toHaveText(hostileName);

    const injected = page
      .getByTestId('ligne-organisation-en-attente')
      .filter({ hasText: injectedRegistration });
    await expect(injected).toHaveCount(1);
    await expect(injected.getByRole('heading', { level: 3 })).toHaveText(injectedName);

    await expect(page.locator('img[onerror]')).toHaveCount(0);
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    expect(await page.title(), 'la charge a modifié le titre du document').not.toContain(
      XSS_MARKER,
    );
    expect(pageErrors, `la page a levé une exception : ${pageErrors.join(' | ')}`).toStrictEqual(
      [],
    );
  });

  test('affiche des silhouettes pendant le chargement, sans compteur et sans horodatage', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const { baseUrl } = requireServer();
    await restoreSession(page, adminCookie);

    // LA VRAIE REQUÊTE EST RETENUE, PAS FALSIFIÉE : le serveur répondra réellement, seul le temps
    // de transport est allongé, et la porte est ouverte par le test une fois ses assertions posées.
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    await page.route(queueRouteMatcher, async (route: Route) => {
      await gate;
      await route.continue();
    });

    await page.goto(`${baseUrl}${PENDING_SCREEN_PATH}`);

    const loading = page.getByTestId('etat-file-chargement');
    await expect(loading).toBeVisible();
    // Le squelette visuel est masqué aux technologies d'assistance ; seul un libellé textuel est
    // annoncé, dans une région de statut. Sans lui, l'attente serait silencieuse au lecteur d'écran.
    await expect(loading.getByRole('status')).toContainText(LOADING_LABEL);

    // AUCUN COMPTEUR : le nombre n'est pas encore connu, et en afficher un provisoire reviendrait
    // à annoncer une situation qu'on ne mesure pas (docs/screens.md).
    await expect(page.getByTestId('compteur-organisations-en-attente')).toHaveCount(0);
    await expect(page.getByTestId('horodatage-dernier-chargement')).toHaveText(
      QUEUE_LAST_LOADED_UNKNOWN,
    );
    await expect(page.getByTestId('ligne-organisation-en-attente')).toHaveCount(0);
    await expect(page.getByTestId('etat-file-vide')).toHaveCount(0);

    // La porte est ouverte par le test, une fois ses assertions posées : l'état de chargement dure
    // exactement le temps qu'il faut, sur une machine lente comme sur une machine rapide.
    open();

    await expect(loading).toHaveCount(0);
    await expect(page.getByTestId('compteur-organisations-en-attente')).toBeVisible();
    await expect(page.getByTestId('horodatage-dernier-chargement')).toContainText(
      QUEUE_LAST_LOADED_AT,
    );
    await expect(page.getByTestId('ligne-organisation-en-attente').first()).toBeVisible();
  });

  test('dit la file vide sans illustration d erreur, et accorde le compteur au singulier', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const { baseUrl } = requireServer();
    await restoreSession(page, adminCookie);

    await stubQueue(page, { items: [], nextCursor: null, totalCount: 0 });
    await page.goto(`${baseUrl}${PENDING_SCREEN_PATH}`);

    const empty = page.getByTestId('etat-file-vide');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText(QUEUE_EMPTY_TITLE);
    await expect(empty).toContainText(QUEUE_EMPTY_BODY);
    // C'EST UN ÉTAT NORMAL, ET IL SE DIT COMME TEL : ni état d'erreur, ni refus, ni liste datée.
    await expect(page.getByTestId('etat-file-erreur')).toHaveCount(0);
    await expect(page.getByTestId('etat-file-refusee')).toHaveCount(0);
    await expect(page.getByTestId('message-file-datee')).toHaveCount(0);
    await expect(page.getByTestId('action-page-suivante')).toHaveCount(0);
    // Zéro prend le singulier, comme un.
    await expect(page.getByTestId('compteur-organisations-en-attente')).toHaveText(
      `0 ${QUEUE_COUNT_ONE}`,
    );

    // UNE SEULE ORGANISATION : le compteur reste au singulier, et l'écran vide disparaît. Sans ce
    // second cas, un compteur toujours pluriel — « 1 organisations » — passerait inaperçu.
    await page.unroute(queueRouteMatcher);
    await stubQueue(page, {
      items: [
        {
          id: randomUUID(),
          name: `Structure unique ${runSuffix}`,
          type: 'ASSOCIATION',
          registrationNumber: `${REGISTRATION_PREFIX}-${runSuffix}-unique`,
          territoryCode: null,
          createdAt: new Date().toISOString(),
          requestedBy: { displayName: null },
        },
      ],
      nextCursor: null,
      totalCount: 1,
    });
    await page.getByTestId('action-rafraichir-file').getByRole('button').click();

    await expect(page.getByTestId('compteur-organisations-en-attente')).toHaveText(
      `1 ${QUEUE_COUNT_ONE}`,
    );
    await expect(page.getByTestId('etat-file-vide')).toHaveCount(0);
    await expect(page.getByTestId('ligne-organisation-en-attente')).toHaveCount(1);
    await page.unroute(queueRouteMatcher);
  });

  test('signale une erreur du serveur, propose « Réessayer », et la reprise aboutit', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const { baseUrl } = requireServer();
    await restoreSession(page, adminCookie);

    await failQueue(page, 500, 'INTERNAL_ERROR');
    await page.goto(`${baseUrl}${PENDING_SCREEN_PATH}`);

    const failure = page.getByTestId('etat-file-erreur');
    await expect(failure).toBeVisible();
    await expect(failure).toContainText(ERROR_TITLE);
    // L'ERREUR SURVIENT EN COURS D'UTILISATION : elle est annoncée immédiatement au lecteur
    // d'écran, plutôt que d'attendre que la personne repasse dessus.
    await expect(failure.getByRole('alert')).toBeVisible();
    // LA FILE RESTE VIDE PLUTÔT QU'AFFICHÉE À MOITIÉ (docs/screens.md), et le compteur disparaît :
    // un compteur survivant à l'erreur annoncerait un nombre que l'écran ne montre pas.
    await expect(page.getByTestId('ligne-organisation-en-attente')).toHaveCount(0);
    await expect(page.getByTestId('compteur-organisations-en-attente')).toHaveCount(0);
    await expect(page.getByTestId('etat-file-chargement')).toHaveCount(0);

    // LA REPRISE EST UNE ACTION, PAS UN CONSEIL. Le bouton relance la vraie requête, et l'écran
    // sort de son état d'erreur : sans cette seconde moitié, « Réessayer » pourrait n'être qu'un
    // libellé.
    await page.unroute(queueRouteMatcher);
    await failure.getByRole('button', { name: RETRY_LABEL }).click();

    await expect(page.getByTestId('etat-file-erreur')).toHaveCount(0);
    await expect(page.getByTestId('compteur-organisations-en-attente')).toBeVisible();
    await expect(page.getByTestId('ligne-organisation-en-attente').first()).toBeVisible();
  });

  test('garde la dernière liste à l écran, marquée comme datée, quand le réseau tombe', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { baseUrl } = requireServer();
    await restoreSession(page, adminCookie);

    await page.goto(`${baseUrl}${PENDING_SCREEN_PATH}`);
    await expect(page.getByTestId('compteur-organisations-en-attente')).toBeVisible();
    const rows = page.getByTestId('ligne-organisation-en-attente');
    const loadedRows = await rows.count();
    expect(loadedRows).toBeGreaterThan(0);
    const stamp = (await page.getByTestId('horodatage-dernier-chargement').textContent()) ?? '';
    expect(stamp).toContain(QUEUE_LAST_LOADED_AT);

    // LE RÉSEAU TOMBE POUR DE VRAI sur la seule route de la file : la requête est abandonnée, elle
    // n'est pas remplacée par une réponse fabriquée.
    await cutQueueNetwork(page);
    await page.getByTestId('action-rafraichir-file').getByRole('button').click();

    const stale = page.getByTestId('message-file-datee');
    await expect(stale).toBeVisible();
    await expect(stale).toContainText(QUEUE_STALE_TITLE);
    await expect(stale).toContainText(QUEUE_STALE_BODY);
    // LA VIDER FERAIT CROIRE QUE LA FILE EST VIDE, c'est-à-dire l'inverse exact de l'information
    // disponible. Et l'horodatage reste celui du dernier chargement ABOUTI : un horodatage rafraîchi
    // par un échec ferait passer une liste périmée pour fraîche.
    await expect(rows).toHaveCount(loadedRows);
    await expect(page.getByTestId('horodatage-dernier-chargement')).toHaveText(stamp);
    await expect(page.getByTestId('etat-file-erreur')).toHaveCount(0);
    await expect(page.getByTestId('etat-file-vide')).toHaveCount(0);

    // ET LE MESSAGE PART QUAND LA CONNEXION REVIENT : sans cette moitié, une liste marquée datée
    // pour toujours passerait le test.
    await page.unroute(queueRouteMatcher);
    await page.getByTestId('action-rafraichir-file').getByRole('button').click();
    await expect(page.getByTestId('message-file-datee')).toHaveCount(0);
    await expect(page.getByTestId('compteur-organisations-en-attente')).toBeVisible();
  });

  test('nomme les organisations qui ont quitté la file, plutôt que de les retirer en silence', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { baseUrl } = requireServer();
    const departing = requireSeededOrganization(
      firstFillerId,
      'la première organisation de la file',
    );
    await restoreSession(page, adminCookie);

    await page.goto(`${baseUrl}${PENDING_SCREEN_PATH}`);
    await expect(page.getByTestId('compteur-organisations-en-attente')).toBeVisible();
    const row = page
      .getByTestId('ligne-organisation-en-attente')
      .filter({ hasText: firstFillerName });
    await expect(
      row,
      "l'organisation choisie n'est pas sur la première page : le relevé des départs ne porterait sur rien",
    ).toHaveCount(1);
    await expect(page.getByTestId('message-file-obsolete')).toHaveCount(0);

    try {
      // UN AUTRE ADMINISTRATEUR TRAITE LA FICHE PENDANT QUE L'ÉCRAN EST OUVERT. C'est une mutation
      // RÉELLE, pas une réponse fabriquée : la file la voit au rafraîchissement suivant.
      await requireClient().query(
        "update public.organizations set verification_status = 'VERIFIED' where id = $1",
        [departing],
      );
      await page.getByTestId('action-rafraichir-file').getByRole('button').click();

      const departed = page.getByTestId('message-file-obsolete');
      await expect(departed).toBeVisible();
      await expect(departed).toContainText(STALE_DATA_TITLE);
      // LE NOM EST DIT. Sans lui, une ligne disparaîtrait entre deux rafraîchissements et personne
      // ne saurait si elle a été validée, refusée, ou perdue.
      await expect(departed).toContainText(firstFillerName);
      await expect(
        page.getByTestId('ligne-organisation-en-attente').filter({ hasText: firstFillerName }),
      ).toHaveCount(0);
    } finally {
      await requireClient().query(
        "update public.organizations set verification_status = 'PENDING' where id = $1",
        [departing],
      );
    }
  });

  test('ferme la file quand la fonction d administration est retirée pendant la consultation', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { baseUrl } = requireServer();
    const carrier = requireSeededOrganization(carrierOrganizationId, "l'organisation porteuse");
    await restoreSession(page, adminCookie);

    await page.goto(`${baseUrl}${PENDING_SCREEN_PATH}`);
    await expect(page.getByTestId('compteur-organisations-en-attente')).toBeVisible();
    const rowsBefore = await page.getByTestId('ligne-organisation-en-attente').count();
    expect(rowsBefore).toBeGreaterThan(0);
    await expect(page.getByTestId('etat-file-refusee')).toHaveCount(0);

    try {
      // LA FONCTION EST RELUE À CHAQUE REQUÊTE (ADR-021). Une adhésion suspendue ferme la file au
      // rafraîchissement suivant, sans attendre l'expiration de la session : c'est exactement la
      // fenêtre que la suspension existe pour fermer, et rien ne l'éprouvait à l'écran.
      await requireClient().query(
        `update public.organization_members set status = 'SUSPENDED'
          where organization_id = $1 and user_id = $2`,
        [carrier, adminUserId],
      );
      await page.getByTestId('action-rafraichir-file').getByRole('button').click();

      const refused = page.getByTestId('etat-file-refusee');
      await expect(refused).toBeVisible();
      await expect(refused).toContainText(PERMISSION_DENIED);
      /*
       * CONSTAT, ET NON SOUHAIT : la liste déjà chargée RESTE affichée sous le refus.
       *
       * `docs/screens.md` veut qu'une permission refusée refuse l'écran, pas seulement la file ;
       * ici la personne lit « vous n'avez pas les droits » au-dessus de vingt-cinq organisations
       * encore visibles. Ce n'est pas une fuite — ces lignes étaient déjà dans son navigateur, et
       * une navigation neuve refuse l'écran entier —, mais c'est une contradiction à l'écran. Le
       * point est signalé à l'orchestrateur plutôt que corrigé ici : `pending-organizations-list.
       * tsx` n'est pas dans le périmètre de cet agent. SI CE COMPTE DEVIENT ZÉRO, C'EST UNE
       * CORRECTION : réécrivez ce cas pour éprouver le nouveau comportement, ne le supprimez pas.
       */
      await expect(page.getByTestId('ligne-organisation-en-attente')).toHaveCount(rowsBefore);
    } finally {
      await requireClient().query(
        `update public.organization_members set status = 'ACTIVE'
          where organization_id = $1 and user_id = $2`,
        [carrier, adminUserId],
      );
    }

    // ET LA FILE ROUVRE DÈS QUE LA FONCTION EST RENDUE. Sans cette moitié, un écran qui refuserait
    // pour n'importe quelle raison — montage raté, session perdue — passerait ce test.
    await page.getByTestId('action-rafraichir-file').getByRole('button').click();
    await expect(page.getByTestId('etat-file-refusee')).toHaveCount(0);
    await expect(page.getByTestId('compteur-organisations-en-attente')).toBeVisible();
  });
});

/**
 * REFUS D'ÉCRAN : sans session, et pour une organisation qu'on n'a pas le droit de voir.
 *
 * L'API a fermé son oracle d'existence au prix de tout un travail — `NOT_FOUND` pour une
 * organisation étrangère comme pour un identifiant qui ne désigne rien. L'écran ne doit pas le
 * rouvrir : une page d'erreur distincte, un titre différent, un nom qui échappe, et parcourir des
 * identifiants suffirait de nouveau à dresser la liste des structures enregistrées.
 */
test.describe("refus d'écran", () => {
  test('renvoie les trois écrans vers la connexion quand aucune session ne les porte', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { baseUrl } = requireServer();
    const organizationId = requireSeededOrganization(
      hostileOrganizationId,
      "l'organisation au nom hostile",
    );

    // AUCUNE SESSION N'EST POSÉE dans ce contexte : c'est un navigateur qui arrive par un lien.
    const cookies = await page.context().cookies();
    expect(
      cookies.map((cookie) => cookie.name),
      'le contexte porte déjà une session : ce test n éprouverait alors rien',
    ).toStrictEqual([]);

    /** Repère du corps de chaque écran : sa présence prouverait que la page a été rendue. */
    const screens: readonly (readonly [string, string])[] = [
      [NEW_ORGANIZATION_PATH, 'formulaire-creation-organisation'],
      [`/organisations/${organizationId}`, 'identite-organisation'],
      [PENDING_SCREEN_PATH, 'file-organisations-en-attente'],
    ];

    for (const [screen, marker] of screens) {
      const direct = await page.request.get(`${baseUrl}${screen}`, { maxRedirects: 0 });
      const served = await direct.text();

      /*
       * LA DESTINATION EST DÉCIDÉE PAR LE SERVEUR, ET LE CORPS DE L'ÉCRAN N'EST JAMAIS RENDU.
       *
       * L'assertion ne porte PAS sur un code 307, et c'est mesuré, pas supposé : la coquille
       * `app/(app)/layout.tsx` appelle `redirect()` alors que le flux de rendu est déjà commencé —
       * la racine du document lit `headers()` pour son nonce —, si bien que Next 16 ne peut plus
       * poser d'en-tête et transporte la consigne DANS le document, que le client exécute. Le code
       * de réponse est donc 200. Exiger 307 aurait fait échouer ce test sur un détail de version,
       * là où ce qui compte ne dépend d'aucune version : la réponse dirige vers la connexion, et
       * elle ne porte pas une ligne de l'écran demandé.
       */
      const destination = direct.headers().location ?? served;
      expect(destination, `${screen} ne dirige pas vers la connexion sans session`).toContain(
        SIGN_IN_PATH,
      );
      expect(served, `${screen} a rendu son écran sans session`).not.toContain(marker);
      expect(served, `${screen} a servi le nom de l organisation sans session`).not.toContain(
        hostileName,
      );
      expect(served, `${screen} a servi le numéro d immatriculation sans session`).not.toContain(
        hostileRegistration,
      );

      // ET LE NAVIGATEUR ABOUTIT BIEN À LA CONNEXION, pas à une coquille vide.
      await page.goto(`${baseUrl}${screen}`);
      await expect(page).toHaveURL(new RegExp(`${SIGN_IN_PATH}$`));
      await expect(page.getByTestId('champ-identifiant')).toBeVisible();
      const shown = await page.content();
      expect(shown).not.toContain(hostileName);
      expect(shown).not.toContain(hostileRegistration);
    }
  });

  test('rend la MÊME page introuvable pour une organisation interdite et pour une inexistante', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { baseUrl } = requireServer();
    const forbidden = requireSeededOrganization(
      firstFillerId,
      'la première organisation de la file',
    );
    await restoreSession(page, authorCookie);

    /**
     * Trois refus qui doivent être indiscernables :
     * - une organisation qui EXISTE et dont l'auteur n'est pas membre — les organisations de
     *   remplissage ne portent aucune adhésion, et l'auteur n'est pas administrateur plateforme ;
     * - un identifiant bien formé qui ne désigne rien ;
     * - un identifiant qui n'est même pas un UUID, refusé plus tôt encore, par la validation.
     */
    const cases: readonly (readonly [string, string])[] = [
      ['organisation interdite', forbidden],
      ['organisation inexistante', randomUUID()],
      ['identifiant mal formé', 'ceci-n-est-pas-un-uuid'],
    ];

    const rendered: string[] = [];
    const statuses: number[] = [];
    for (const [label, identifier] of cases) {
      const response = await page.goto(`${baseUrl}/organisations/${identifier}`);
      statuses.push(response?.status() ?? 0);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(NOT_FOUND_TITLE);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.getByText(NOT_FOUND_BODY)).toBeVisible();
      // AUCUN DÉTAIL TECHNIQUE, aucun identifiant, aucun état d'erreur applicatif.
      await expect(page.getByTestId('identite-organisation')).toHaveCount(0);
      await expect(page.getByTestId('bandeau-validation-en-attente')).toHaveCount(0);

      /*
       * CE QUI EST COMPARÉ, ET POURQUOI PAS LE DOCUMENT ENTIER.
       *
       * Le document entier a été essayé, et il diffère pour une raison qui n'apprend rien à
       * personne : React laisse, ou non, la coquille de flux (`<div hidden id="S:0">`,
       * `<template id="P:1">`) selon que le rendu a été streamé en une ou deux fois — un écart de
       * MILLISECONDES, sans rapport avec ce qui est demandé. Comparer cela ferait rougir le test au
       * hasard, et un test qui rougit au hasard finit ignoré.
       *
       * La comparaison porte donc sur ce qu'un appelant peut EXPLOITER : le titre du document, le
       * texte visible, et le bloc rendu tel quel. Le reste — qu'aucune donnée de l'organisation
       * interdite ne figure nulle part dans la réponse, coquille de flux comprise — est vérifié
       * juste au-dessus sur le document ENTIER, qui est le seul endroit où une fuite pourrait se
       * cacher.
       */
      const markup = await page.content();
      expect(markup, `la page introuvable porte le nom de l organisation (${label})`).not.toContain(
        firstFillerName,
      );
      expect(
        markup,
        `la page introuvable porte le numéro d immatriculation (${label})`,
      ).not.toContain(`${REGISTRATION_PREFIX}-${runSuffix}-${QUEUE_FILLER_LABEL}-01`);

      const block = await page
        .getByRole('heading', { level: 1 })
        .evaluate((heading) => heading.closest('section')?.outerHTML ?? '');
      const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
      rendered.push(JSON.stringify({ title: await page.title(), block, text }));
    }

    /*
     * LE CODE DE RÉPONSE FAIT PARTIE DE L'INDISCERNABILITÉ, et c'est pour cela qu'il est comparé
     * aux autres plutôt qu'à une valeur écrite ici. Un `404` pour l'inexistante et un `200` pour
     * l'interdite rouvriraient l'oracle sans qu'aucun pixel ne change.
     *
     * CONSTAT MESURÉ, ET SIGNALÉ À L'ORCHESTRATEUR : la valeur commune est aujourd'hui 200, pas
     * 404. `notFound()` est appelé alors que le flux de rendu est déjà commencé — la racine du
     * document lit `headers()` pour son nonce —, et Next 16 ne peut plus poser le code une fois le
     * document parti. L'écran affiché est bien « Page introuvable », mais une supervision qui
     * compterait les 404 n'en verrait aucun. Le point est hors du périmètre de cet agent.
     */
    expect(
      new Set(statuses).size,
      `les trois refus ne rendent pas le même code de réponse : ${statuses.join(', ')}`,
    ).toBe(1);

    const [interdite, inexistante, malFormee] = rendered;
    expect(
      interdite,
      "l'écran distingue une organisation interdite d'une organisation inexistante : il rouvre l'oracle d'existence que l'API a fermé",
    ).toBe(inexistante);
    expect(
      malFormee,
      "l'écran distingue un identifiant mal formé d'un identifiant inexistant",
    ).toBe(inexistante);
  });
});

/**
 * DERNIER TEST DU FICHIER, ET C'EST VOULU.
 *
 * IL A ÉTÉ ÉCRIT ROUGE, SUR UN DÉFAUT DE PAGINATION DÉJÀ SIGNALÉ AILLEURS ; IL EST VERT DEPUIS QUE
 * LE CURSEUR NE TRONQUE PLUS. Sa place en fin de fichier vient de là : en mode série, un test qui
 * échoue fait sauter tous les suivants, et le mettre en dernier évitait de priver le lot de la
 * couverture des six états et de celle des refus d'écran. La place reste bonne pour la même
 * raison — c'est le seul test du fichier qui relit la file entière.
 */
test.describe('réunion des pages', () => {
  test('l administrateur voit chaque organisation en attente une fois, et autant que le compteur en annonce', async () => {
    const measurement = queueMeasurement;
    expect(
      measurement,
      "aucune mesure de la file : ce fichier s'exécute EN SÉRIE et le test de pagination relève la mesure que celui-ci relit. Exécutez le fichier entier, pas ce test seul.",
    ).toBeDefined();
    if (measurement === undefined) {
      return;
    }

    /*
     * CE QUE CE TEST GARDE : CE QUE L'ADMINISTRATEUR VOIT RÉELLEMENT, une fois la file parcourue
     * en entier — chaque structure une fois, et autant de lignes que le compteur en annonce.
     *
     * LE DÉFAUT QU'IL A RÉVÉLÉ, ET QUI EXPLIQUE POURQUOI IL PART DU RENDU ET NON DE L'API.
     * `encodeCursor` (`src/domain/organizations/list-pending-organizations.ts`) sérialisait
     * l'instant du curseur par `Date.prototype.toISOString()`, qui s'arrête à la MILLISECONDE,
     * alors que `created_at` est un `timestamptz` posé par `now()`, donc à la MICROSECONDE. Le
     * filtre `(created_at, id) > (curseur_tronqué, id)` était alors satisfait par la dernière
     * ligne de la page précédente, qui était servie une seconde fois. Ce défaut-là n'était pas
     * neuf : `tests/e2e/organizations.spec.ts` le tenait déjà rouge sur la RÉPONSE de l'API, et
     * ce test n'en déclarait pas un second.
     *
     * CE QU'IL AJOUTAIT, ET QUI N'AVAIT JAMAIS ÉTÉ MONTRÉ : la CONSÉQUENCE À L'ÉCRAN. Le test de
     * l'API échouait sur sa première assertion et n'atteignait jamais le rendu ; celui-ci part des
     * lignes réellement affichées par le navigateur, et dit ce que l'administrateur voit — la même
     * structure deux fois, une répétition par frontière de page, à côté d'un compteur qui, lui, est
     * juste et ne concorde donc plus avec ce qu'il compte.
     *
     * CE QU'IL GARDE MAINTENANT, ET POURQUOI CE N'EST PAS UN DOUBLON DE L'AUTRE FICHIER. Le
     * curseur ne tronque plus, les deux tests sont verts, et ils tiennent la même propriété par
     * ses deux bouts : celui de l'API dirait encore vrai si l'écran cessait d'afficher les lignes
     * qu'on lui sert, celui-ci dirait encore vrai si l'API changeait de format de curseur sans
     * changer de résultat. Ce test-ci part des lignes RÉELLEMENT RENDUES par le navigateur, et
     * c'est sa raison d'être.
     */
    const registrations = measurement.registrations;
    expect(
      new Set(registrations).size,
      'une organisation est rendue deux fois par la pagination de l écran',
    ).toBe(registrations.length);
    expect(
      registrations,
      "l'écran n'affiche pas exactement les organisations que le compteur annonce",
    ).toHaveLength(measurement.databaseCount);
  });
});

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { type Browser, expect, type Page, test } from '@playwright/test';
import pg from 'pg';
import { loadIntegrationEnvironment, repositoryRoot } from '../integration/setup/environment';

/**
 * Accessibilité de base de l'accueil public (US-001 critère 17, docs/screens.md).
 *
 * Une personne qui navigue au clavier ou avec un lecteur d'écran doit atteindre la connexion sans
 * souris et savoir en permanence où se trouve le focus. Ces vérifications tournent sur les deux
 * projets, mobile et bureau.
 *
 * LE SECOND GROUPE DE CE FICHIER ÉTEND LE MÊME PATRON AUX TROIS ÉCRANS D'ORGANISATION (US-012).
 * Ils n'y étaient pas : `docs/screens.md` range la navigation clavier, la taille des cibles
 * tactiles et les libellés explicites parmi les exigences du produit, et aucun test ne les
 * éprouvait ailleurs que sur l'accueil. Or ces écrans sont les premiers à porter des formulaires,
 * une liste dense et une barre de navigation : c'est là que le clavier et le petit écran se
 * cassent, pas sur une page d'accueil de trois liens.
 *
 * LES DEUX GROUPES PARTAGENT MAINTENANT UN SERVEUR MONTÉ PAR CE FICHIER, et le bloc suivant dit
 * pourquoi l'accueil public y a gagné autant que les écrans connectés.
 */

const MAX_TAB_PRESSES = 12;

/** Style de focus réellement calculé sur l'élément actif. */
async function activeElementFocusRing(page: import('@playwright/test').Page): Promise<{
  tagName: string;
  outlineStyle: string;
  outlineWidth: number;
}> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active === null) {
      return { tagName: 'aucun', outlineStyle: 'none', outlineWidth: 0 };
    }
    const style = window.getComputedStyle(active);
    return {
      tagName: active.tagName.toLowerCase(),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  });
}

/*
 * CE FICHIER MONTE SON PROPRE SERVEUR, ET NE SE FIE PLUS À `baseURL`.
 *
 * IL S'Y FIAIT, ET C'ÉTAIT UN VERDICT FAUX. Le serveur commun de `playwright.config.ts` écoute sur
 * `http://localhost:3000`, port qu'un conteneur de la pile locale occupe déjà en servant une image
 * construite un jour antérieur. Mesuré à l'instant : ce conteneur répond `404` sur `/connexion` et
 * `200` sur `/auth`, adresse que le dépôt n'expose plus. Le test « active la connexion à la touche
 * Entrée » échouait donc pour une raison étrangère à l'accessibilité, et les six autres rendaient
 * un verdict vert sur du code qui n'est pas celui du dépôt. Le serveur monté ici écoute sur un port
 * libre et sert le `.next` du dépôt, dont la fraîcheur est vérifiée avant tout démarrage.
 *
 * IL LUI FAUT AUSSI UNE SESSION. Les trois écrans d'organisation ajoutés plus bas n'existent que
 * pour un compte connecté, et le code à usage unique n'est lisible que dans la sortie du serveur :
 * il n'est pas stocké, seule son empreinte l'est, et il ne figure dans aucune réponse d'API.
 * Démarrer le serveur depuis le test est le seul moyen d'y accéder sans dépendre de Mailpit.
 *
 * CE FICHIER DOIT DONC FIGURER DANS `SELF_HOSTED_SPECS` de `playwright.config.ts`, qui n'est pas
 * dans le périmètre de cet agent : tant qu'il n'y est pas, le serveur commun est monté en plus du
 * sien — réutilisé sans dommage en local, fatal en intégration continue sur un port déjà pris. Le
 * point est signalé plutôt que contourné.
 *
 * DUPLICATION ASSUMÉE avec `organizations.spec.ts` et `organizations-administration.spec.ts` :
 * montage du serveur, lecture du code, ramassage des restes et purge y sont écrits une première
 * fois. Un module partagé sous `tests/e2e/` est hors du périmètre de cet agent ; la reprise est
 * signalée pour être faite d'un seul geste le jour où ce périmètre s'ouvre.
 *
 * UN SEUL COMPTE, UNE SEULE CONNEXION. La limitation de tentatives compte vingt demandes de code
 * par quart d'heure pour une même SOURCE, et l'adresse de bouclage est commune à tous les fichiers
 * de bout en bout. Le compte est donc à la fois administrateur de la plateforme et administrateur
 * de l'organisation qu'il consulte : les trois écrans s'ouvrent avec une seule demande de code.
 */

const A11Y_AUTH_SECRET = 'secret-e2e-fictif-de-plus-de-32-caracteres-pour-l-accessibilite';
const SERVER_READY_TIMEOUT_MS = 120_000;
const SESSION_COOKIE_NAME = 'appui_feux_session';
const LOOPBACK_HOST = '127.0.0.1';
const HEALTH_PATH = '/api/v1/health';
const MAIN_CONTENT_ID = 'contenu-principal';

const A11Y_REGISTRATION_PREFIX = 'FICTIF-A11Y';
const A11Y_IDENTIFIER_PREFIX = 'sentinelle-a11y';

/** Voir `organizations.spec.ts` : le ramassage lit ce suffixe DANS les valeurs laissées en base. */
const RUN_KEY_SHAPE = /^[a-z]+-[0-9a-f]{8}$/;
const RUN_KEY_SQL_SHAPE = '[a-z]+-[0-9a-f]{8}';
/** Espace de verrous propre à ce fichier : il ne ramasse que ses propres préfixes. */
const RUN_LOCK_NAMESPACE = 14;

/** Budget de tabulations sur un écran connecté : coquille, barre de navigation, puis formulaire. */
const MAX_TAB_PRESSES_CONNECTED = 30;

/** Minimum de `docs/screens.md`, en pixels indépendants du périphérique. */
const MINIMUM_TARGET_SIZE = 44;

const DISPLAY_NAME = 'Lou V.';
const SUBJECT_TERRITORY = 'ZZ-A11Y-01';

const NEW_ORGANIZATION_PATH = '/organisations/nouvelle';
const PENDING_SCREEN_PATH = '/administration/organisations-en-attente';

/** Libellés recopiés à la main de `src/i18n/fr.ts`, jamais importés : voir `organizations.spec.ts`. */
const NEW_ORGANIZATION_TITLE = 'Créer une organisation';
const QUEUE_TITLE = 'Organisations en attente';
const CREATE_SUBMIT = "Créer l'organisation";
const EDIT_SUBMIT = 'Enregistrer les modifications';
const QUEUE_REFRESH = 'Rafraîchir la file';
const SKIP_LINK_LABEL = 'Aller au contenu principal';

type ServerProcess = ChildProcessByStdio<null, Readable, Readable>;

interface ServerHandle {
  readonly baseUrl: string;
  readonly process: ServerProcess;
  readonly lines: string[];
}

const BUILD_SOURCES = ['app', 'src', 'middleware.ts', 'next.config.ts', 'package.json'] as const;

let a11yServer: ServerHandle | undefined;
let a11yClient: pg.Client | undefined;
let a11yStartedAt = new Date();
let a11yRunSuffix = '';
let a11yEmail = '';
let a11yCookie = '';
let subjectOrganizationId = '';
let subjectOrganizationName = '';

interface Change {
  readonly path: string;
  readonly at: number;
}

async function newestChange(target: string): Promise<Change | null> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(target);
  } catch {
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

/** Refuse de démarrer sur un artefact plus ancien que les sources : voir `organizations.spec.ts`. */
async function assertRebuiltArtifact(): Promise<void> {
  const root = repositoryRoot();
  const buildId = await newestChange(path.join(root, '.next', 'BUILD_ID'));
  if (buildId === null) {
    throw new Error(
      "aucun artefact `.next` : ces écrans s'éprouvent sur le code construit. Lancez `npm run build` avant `playwright test`.",
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
      clearTimeout(forced);
      resolve();
    });
    handle.process.kill();
  });
}

/** Voir `organizations.spec.ts` : un démarrage qui échoue n'abandonne pas son processus. */
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
      AUTH_SECRET: A11Y_AUTH_SECRET,
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

function requireA11yServer(): ServerHandle {
  if (a11yServer === undefined) {
    throw new Error('serveur de test non démarré');
  }
  return a11yServer;
}

function requireA11yClient(): pg.Client {
  if (a11yClient === undefined) {
    throw new Error('connexion de base de test non ouverte');
  }
  return a11yClient;
}

async function query<T extends pg.QueryResultRow>(
  sql: string,
  params: readonly unknown[],
): Promise<T[]> {
  const { rows } = await requireA11yClient().query<T>(sql, [...params]);
  return rows;
}

/** Voir `organizations.spec.ts` : un seul chemin de purge, appelé par le ramassage comme par la fin. */
async function purgeRun(run: string): Promise<void> {
  const registrations = `${A11Y_REGISTRATION_PREFIX}-${run}-%`;
  const identifiers = `${A11Y_IDENTIFIER_PREFIX}-${run}@exemple.test`;
  const target = requireA11yClient();

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
  await target.query('delete from public.user_profiles where email like $1', [identifiers]);
}

/** Ne purge que les suffixes dont le verrou consultatif est libre : une voisine vivante est intouchable. */
async function collectLeftovers(): Promise<void> {
  const candidates = await query<{ readonly run: string }>(
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
      `^${A11Y_REGISTRATION_PREFIX}-(${RUN_KEY_SQL_SHAPE})-`,
      `^${A11Y_IDENTIFIER_PREFIX}-(${RUN_KEY_SQL_SHAPE})@exemple\\.test$`,
      `${A11Y_REGISTRATION_PREFIX}-%`,
      `${A11Y_IDENTIFIER_PREFIX}-%@exemple.test`,
    ],
  );
  for (const candidate of candidates) {
    const acquired = await query<{ readonly acquired: boolean }>(
      'select pg_try_advisory_lock($1::int, hashtext($2)) as acquired',
      [RUN_LOCK_NAMESPACE, candidate.run],
    );
    if (acquired[0]?.acquired !== true) {
      continue;
    }
    await purgeRun(candidate.run);
    await requireA11yClient().query('select pg_advisory_unlock($1::int, hashtext($2))', [
      RUN_LOCK_NAMESPACE,
      candidate.run,
    ]);
  }
}

/**
 * Sème un compte qui ouvre les trois écrans avec une seule connexion.
 *
 * Il est administrateur PLATEFORME par une organisation porteuse `VERIFIED` — qui ne vient donc
 * pas grossir la file —, et administrateur de l'organisation SUJET, laissée `PENDING` pour que la
 * fiche rende son bandeau d'attente et son formulaire de modification, c'est-à-dire l'écran le
 * plus dense du lot.
 */
async function seedAccount(): Promise<void> {
  const profiles = await query<{ readonly id: string }>(
    `insert into public.user_profiles (display_name, email, preferred_language, verification_level, status)
     values ($1, $2, 'fr', 'CONTACT_VERIFIED', 'ACTIVE')
     returning id`,
    [DISPLAY_NAME, a11yEmail],
  );
  const userId = profiles[0]?.id;
  if (userId === undefined) {
    throw new Error("le profil de test n'a pas été créé");
  }

  const carriers = await query<{ readonly id: string }>(
    `insert into public.organizations
       (name, type, registration_number, territory_code, verification_status, status)
     values ($1, 'OPERATIONAL_SERVICE', $2, null, 'VERIFIED', 'ACTIVE')
     returning id`,
    [`Service porteur ${a11yRunSuffix}`, `${A11Y_REGISTRATION_PREFIX}-${a11yRunSuffix}-porteuse`],
  );
  const carrierId = carriers[0]?.id;
  if (carrierId === undefined) {
    throw new Error("l'organisation porteuse n'a pas été créée");
  }
  await requireA11yClient().query(
    `insert into public.organization_members (organization_id, user_id, role, status)
     values ($1, $2, 'PLATFORM_ADMIN', 'ACTIVE')`,
    [carrierId, userId],
  );

  subjectOrganizationName = `Structure A11Y ${a11yRunSuffix}`;
  const subjects = await query<{ readonly id: string }>(
    `insert into public.organizations
       (name, type, registration_number, territory_code, verification_status, status)
     values ($1, 'FARM', $2, $3, 'PENDING', 'ACTIVE')
     returning id`,
    [
      subjectOrganizationName,
      `${A11Y_REGISTRATION_PREFIX}-${a11yRunSuffix}-sujet`,
      SUBJECT_TERRITORY,
    ],
  );
  const subjectId = subjects[0]?.id;
  if (subjectId === undefined) {
    throw new Error("l'organisation sujet n'a pas été créée");
  }
  subjectOrganizationId = subjectId;
  await requireA11yClient().query(
    `insert into public.organization_members (organization_id, user_id, role, status)
     values ($1, $2, 'ORG_ADMIN', 'ACTIVE')`,
    [subjectId, userId],
  );
}

/** Parcours de connexion complet, joué une seule fois, dans un contexte jetable. */
async function signInOnce(browser: Browser): Promise<string> {
  const handle = requireA11yServer();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${handle.baseUrl}/connexion`);
    const marker = handle.lines.length;
    await page.getByTestId('champ-identifiant').fill(a11yEmail);
    await page.getByRole('button', { name: 'Recevoir un code' }).click();
    await expect(page.getByTestId('etape-code')).toBeVisible();
    await page.getByTestId('champ-code').fill(await readDeliveredCode(handle, marker));
    await page.getByRole('button', { name: 'Se connecter' }).click();
    await expect(page).toHaveURL(/\/apres-connexion$/, { timeout: 30_000 });

    const cookies = await context.cookies();
    const token = cookies.find((candidate) => candidate.name === SESSION_COOKIE_NAME)?.value ?? '';
    expect(token, 'aucun cookie de session posé par la connexion').not.toBe('');
    return token;
  } finally {
    await context.close();
  }
}

async function restoreSession(page: Page): Promise<void> {
  expect(
    a11yCookie,
    "aucune session : ce groupe s'exécute EN SÉRIE et son `beforeAll` ouvre la session dont les tests se servent.",
  ).not.toBe('');
  await page
    .context()
    .addCookies([
      { name: SESSION_COOKIE_NAME, value: a11yCookie, domain: LOOPBACK_HOST, path: '/' },
    ]);
}

interface ConnectedScreen {
  readonly label: string;
  readonly path: () => string;
  readonly heading: () => string;
  /** Action principale de l'écran, celle qu'un clavier doit atteindre. */
  readonly action: string;
}

const CONNECTED_SCREENS: readonly ConnectedScreen[] = [
  {
    label: 'création d une organisation',
    path: () => NEW_ORGANIZATION_PATH,
    heading: () => NEW_ORGANIZATION_TITLE,
    action: CREATE_SUBMIT,
  },
  {
    label: 'fiche d une organisation',
    path: () => `/organisations/${subjectOrganizationId}`,
    heading: () => subjectOrganizationName,
    action: EDIT_SUBMIT,
  },
  {
    label: 'file d administration',
    path: () => PENDING_SCREEN_PATH,
    heading: () => QUEUE_TITLE,
    action: QUEUE_REFRESH,
  },
];

/**
 * Ouvre un écran et attend qu'il ait fini de se construire.
 *
 * La file d'administration se remplit APRÈS le rendu, par une requête du navigateur : mesurer une
 * largeur ou parcourir le clavier avant ce moment mesurerait un écran vide, c'est-à-dire jamais
 * celui qui déborde.
 */
async function openScreen(page: Page, screen: ConnectedScreen): Promise<void> {
  const { baseUrl } = requireA11yServer();
  await page.goto(`${baseUrl}${screen.path()}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(screen.heading());
  if (screen.path() === PENDING_SCREEN_PATH) {
    await expect(page.getByTestId('compteur-organisations-en-attente')).toBeVisible();
  }
}

/*
 * EN SÉRIE, DANS UN SEUL TRAVAILLEUR. Sans cela, `fullyParallel` rejouerait `beforeAll` par
 * travailleur : autant de serveurs `next start`, autant de jeux de données, et autant de demandes
 * de code à la limitation de tentatives — dont le compteur de source est commun à tous les fichiers
 * de bout en bout.
 */
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  const environment = loadIntegrationEnvironment();
  const databaseUrl = environment.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    throw new Error('DATABASE_URL est absente : les écrans connectés exigent une session.');
  }
  await assertRebuiltArtifact();

  a11yStartedAt = new Date();
  a11yClient = new pg.Client({ connectionString: databaseUrl });
  await a11yClient.connect();

  a11yRunSuffix = `${test.info().project.name}-${randomUUID().slice(0, 8)}`;
  expect(
    a11yRunSuffix,
    'le suffixe d exécution n est plus lisible par le ramassage des restes : renommer un projet Playwright impose de revoir RUN_KEY_SHAPE',
  ).toMatch(RUN_KEY_SHAPE);

  // Le verrou est pris AVANT toute écriture : rien de cette exécution n'existe en base pendant
  // qu'elle est encore ramassable par une voisine.
  await a11yClient.query('select pg_advisory_lock($1::int, hashtext($2))', [
    RUN_LOCK_NAMESPACE,
    a11yRunSuffix,
  ]);
  await collectLeftovers();

  a11yEmail = `${A11Y_IDENTIFIER_PREFIX}-${a11yRunSuffix}@exemple.test`;
  await seedAccount();

  a11yServer = await startServer(databaseUrl);
  a11yCookie = await signInOnce(browser);
});

test.afterAll(async () => {
  if (a11yServer !== undefined) {
    await stopServer(a11yServer);
  }
  if (a11yClient === undefined) {
    return;
  }
  if (a11yRunSuffix !== '') {
    await purgeRun(a11yRunSuffix);
  }
  // `updated_at` et non `created_at` : la table porte une ligne UNIQUE par sujet limité, réutilisée
  // d'une exécution à l'autre. Voir le commentaire détaillé de `organizations.spec.ts`.
  await a11yClient.query('delete from public.auth_attempts where updated_at >= $1', [
    a11yStartedAt,
  ]);
  await a11yClient.end();
});

test.describe('accessibilité de l accueil public', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${requireA11yServer().baseUrl}/`);
  });

  test('déclare la langue du document en français', async ({ page }) => {
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  });

  test('porte un titre de niveau 1 unique', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Appui Feux');
  });

  test('expose un repère de contenu principal atteignable au clavier', async ({ page }) => {
    const skipLink = page.getByRole('link', { name: SKIP_LINK_LABEL });

    await page.keyboard.press('Tab');

    // Le lien d'évitement est le premier élément focalisable, et il devient visible au focus.
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeInViewport();
    await expect(skipLink).toHaveAttribute('href', `#${MAIN_CONTENT_ID}`);

    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toHaveAttribute('id', MAIN_CONTENT_ID);
  });

  test('atteint le bouton de connexion au clavier, avec un focus visible', async ({ page }) => {
    const signIn = page.getByRole('link', { name: 'Se connecter' });

    let reached = false;
    for (let press = 0; press < MAX_TAB_PRESSES; press += 1) {
      await page.keyboard.press('Tab');
      if (await signIn.evaluate((element) => element === document.activeElement)) {
        reached = true;
        break;
      }
    }

    expect(reached, `connexion non atteinte en ${MAX_TAB_PRESSES} tabulations`).toBe(true);
    await expect(signIn).toBeFocused();
    await expect(signIn).toBeInViewport();

    const focusRing = await activeElementFocusRing(page);
    expect(focusRing.outlineStyle).not.toBe('none');
    expect(focusRing.outlineWidth).toBeGreaterThanOrEqual(2);
  });

  test('active la connexion à la touche Entrée', async ({ page }) => {
    const signIn = page.getByRole('link', { name: 'Se connecter' });

    await signIn.focus();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/connexion$/);
  });

  test('nomme la région de consigne de sécurité pour un lecteur d écran', async ({ page }) => {
    const notice = page.getByRole('region', { name: 'Consigne de sécurité' });

    await expect(notice).toHaveCount(1);
    // La consigne est écrite en toutes lettres : rien n'est porté par la seule icône.
    await expect(notice).toContainText('Appeler le 18 ou le 112 en urgence.');
  });

  test('offre des cibles tactiles suffisantes sur le parcours principal', async ({ page }) => {
    const signIn = page.getByRole('link', { name: 'Se connecter' });

    const box = await signIn.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(MINIMUM_TARGET_SIZE);
  });
});

test.describe('accessibilité des écrans d organisation', () => {
  test.beforeEach(async ({ page }) => {
    await restoreSession(page);
  });

  test('porte un titre de niveau 1 unique sur chacun des trois écrans', async ({ page }) => {
    test.setTimeout(120_000);
    for (const screen of CONNECTED_SCREENS) {
      await openScreen(page, screen);
      // UN SEUL TITRE DE NIVEAU 1. Deux h1 sur un écran, et un lecteur d'écran ne sait plus lequel
      // nomme la page ; zéro, et il n'y a plus de point d'entrée dans le document.
      await expect(
        page.getByRole('heading', { level: 1 }),
        `titre de niveau 1 de la ${screen.label}`,
      ).toHaveCount(1);
      // La coquille connectée ne réintroduit pas de titre concurrent : le nom du produit est un
      // lien de marque, la consigne de sécurité une région nommée.
      await expect(page.getByRole('region', { name: 'Consigne de sécurité' })).toHaveCount(1);
    }
  });

  test('ouvre chacun des trois écrans par le lien d évitement, au clavier', async ({ page }) => {
    test.setTimeout(120_000);
    for (const screen of CONNECTED_SCREENS) {
      await openScreen(page, screen);
      const skipLink = page.getByRole('link', { name: SKIP_LINK_LABEL });

      await page.keyboard.press('Tab');
      // PREMIER ÉLÉMENT FOCALISABLE, sur un écran connecté comme sur l'accueil. Sans lui, atteindre
      // le contenu d'un écran d'administration demanderait de traverser toute la barre de
      // navigation à chaque page.
      await expect(skipLink, `lien d évitement de la ${screen.label}`).toBeFocused();
      await expect(skipLink).toBeInViewport();
      await expect(skipLink).toHaveAttribute('href', `#${MAIN_CONTENT_ID}`);

      await page.keyboard.press('Enter');
      await expect(page.getByRole('main')).toHaveAttribute('id', MAIN_CONTENT_ID);
    }
  });

  test('atteint l action principale de chaque écran au clavier, avec un focus visible', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    for (const screen of CONNECTED_SCREENS) {
      await openScreen(page, screen);
      const action = page.getByRole('button', { name: screen.action });
      await expect(action, `action principale de la ${screen.label}`).toHaveCount(1);

      let reached = false;
      for (let press = 0; press < MAX_TAB_PRESSES_CONNECTED; press += 1) {
        await page.keyboard.press('Tab');
        if (await action.evaluate((element) => element === document.activeElement)) {
          reached = true;
          break;
        }
      }
      expect(
        reached,
        `« ${screen.action} » non atteint en ${String(MAX_TAB_PRESSES_CONNECTED)} tabulations sur la ${screen.label}`,
      ).toBe(true);
      await expect(action).toBeInViewport();

      // L'ANNEAU DE FOCUS EST CALCULÉ, PAS DÉCLARÉ : une feuille de style qui poserait
      // `outline: none` sans remplacement rendrait l'écran inutilisable au clavier sans qu'aucune
      // assertion de visibilité ne bronche.
      const focusRing = await activeElementFocusRing(page);
      expect(focusRing.outlineStyle, `anneau de focus sur la ${screen.label}`).not.toBe('none');
      expect(focusRing.outlineWidth).toBeGreaterThanOrEqual(2);
    }
  });

  test('offre des cibles tactiles suffisantes sur les trois écrans', async ({ page }) => {
    test.setTimeout(120_000);
    for (const screen of CONNECTED_SCREENS) {
      await openScreen(page, screen);

      /*
       * TOUTES les commandes de l'écran sont mesurées, pas seulement la principale : c'est une
       * commande secondaire — « Afficher les organisations suivantes », « Rafraîchir la file » —
       * qui rétrécit en premier quand on la rend compacte, et c'est précisément celle dont un
       * administrateur a besoin sur un téléphone pendant un épisode de feux.
       *
       * Le lien d'évitement est écarté : il est hors flux tant qu'il n'a pas le focus, et sa boîte
       * ne dit alors rien de ce qu'un doigt peut viser.
       */
      const controls = page
        .locator('button:visible, header a:visible, main a:visible')
        .filter({ hasNotText: SKIP_LINK_LABEL });
      const count = await controls.count();
      expect(count, `aucune commande mesurée sur la ${screen.label}`).toBeGreaterThan(0);

      for (let index = 0; index < count; index += 1) {
        const control = controls.nth(index);
        const label = (await control.textContent())?.trim() ?? '(sans libellé)';
        const box = await control.boundingBox();
        expect(box, `commande « ${label} » sans boîte sur la ${screen.label}`).not.toBeNull();
        expect(
          box?.height ?? 0,
          `hauteur de « ${label} » sur la ${screen.label}`,
        ).toBeGreaterThanOrEqual(MINIMUM_TARGET_SIZE);
        expect(
          box?.width ?? 0,
          `largeur de « ${label} » sur la ${screen.label}`,
        ).toBeGreaterThanOrEqual(MINIMUM_TARGET_SIZE);
      }
    }
  });

  test('ne déborde jamais horizontalement, jusque sur le profil mobile', async ({ page }, info) => {
    test.setTimeout(120_000);
    for (const screen of CONNECTED_SCREENS) {
      await openScreen(page, screen);

      /*
       * L'ÉCART EST MESURÉ SUR LE DOCUMENT, pas sur un conteneur choisi. Un numéro
       * d'immatriculation long, une pastille d'état ou une barre de navigation qui dépasse font
       * défiler la page entière de côté : sur 412 pixels, l'administrateur perd alors le bouton de
       * pagination, seul accès aux organisations les plus anciennes. La barre de navigation, elle,
       * a le droit de défiler DANS SA PROPRE BOÎTE (`overflow-x: auto`), et c'est bien pour cela
       * que la mesure porte sur `documentElement` et non sur elle.
       */
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        overflow.scrollWidth,
        `la ${screen.label} déborde de ${String(overflow.scrollWidth - overflow.clientWidth)} pixels sur le profil ${info.project.name}`,
      ).toBeLessThanOrEqual(overflow.clientWidth);
    }
  });

  test('nomme chaque champ des deux formulaires pour un lecteur d écran', async ({ page }) => {
    test.setTimeout(120_000);
    for (const screen of CONNECTED_SCREENS.filter(
      (candidate) => candidate.action !== QUEUE_REFRESH,
    )) {
      await openScreen(page, screen);

      /*
       * UN CHAMP SANS NOM ACCESSIBLE EST UN CHAMP MUET. `docs/screens.md` exige des libellés
       * explicites : une personne qui parcourt le formulaire au lecteur d'écran doit entendre ce
       * qu'elle saisit, et un attribut `placeholder` ne le dit pas — il disparaît dès la première
       * frappe.
       */
      const fields = page.locator('main input:visible, main select:visible, main textarea:visible');
      const count = await fields.count();
      expect(count, `aucun champ mesuré sur la ${screen.label}`).toBeGreaterThan(0);

      for (let index = 0; index < count; index += 1) {
        const field = fields.nth(index);
        const identifier = (await field.getAttribute('id')) ?? '(sans identifiant)';
        const accessibleName = await field.evaluate((element) => {
          const labelled = element.getAttribute('aria-label');
          if (labelled !== null && labelled.trim() !== '') {
            return labelled.trim();
          }
          const id = element.getAttribute('id');
          if (id === null) {
            return '';
          }
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          return label?.textContent?.trim() ?? '';
        });
        expect(
          accessibleName,
          `le champ « ${identifier} » de la ${screen.label} n a pas de nom accessible`,
        ).not.toBe('');
      }
    }
  });
});

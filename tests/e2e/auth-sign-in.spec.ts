import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { expect, test } from '@playwright/test';
import pg from 'pg';
import { loadIntegrationEnvironment, repositoryRoot } from '../integration/setup/environment';

/**
 * Parcours de connexion complet, sur l'ARTEFACT DE PRODUCTION, en profil mobile et bureau.
 *
 * POURQUOI CE FICHIER LANCE SON PROPRE SERVEUR. Le code à usage unique n'existe nulle part où un
 * test puisse le lire : il n'est pas stocké — seule son empreinte l'est — et il ne figure dans
 * aucune réponse d'API, par construction (critère 7). Deux voies restent ouvertes.
 *
 * 1. L'INTERCEPTION DE COURRIELS (Mailpit, ports 1026 et 8026 de la pile Docker). Elle suppose que
 *    le serveur soit démarré avec `SMTP_HOST`, `SMTP_PORT` et `SMTP_FROM`, variables qui ne sont
 *    déclarées ni dans `.env.example` ni dans `.env.local`, et que le conteneur Mailpit tourne. Le
 *    test dépendrait alors de deux éléments d'infrastructure supplémentaires, et échouerait pour
 *    des raisons étrangères à l'authentification.
 * 2. L'ADAPTATEUR DE JOURNALISATION, retenu ici. C'est le repli documenté du poste local : sans
 *    transport configuré, le code est écrit dans le journal, et UNIQUEMENT lorsque `APP_ENV` vaut
 *    `local` (`src/infrastructure/identity/logging-code-delivery.ts`). Lancer le serveur depuis le
 *    test donne accès à sa sortie standard, donc au code — et, bénéfice second, permet de vérifier
 *    sur l'artefact de production que ni le jeton de session ni l'adresse complète n'y figurent.
 *
 * Le serveur de `playwright.config.ts` ne convient pas : sa sortie n'est pas accessible aux tests.
 * Celui-ci écoute sur un port libre, sert le MÊME artefact `.next`, et est arrêté à la fin.
 *
 * ÉTAT LAISSÉ EN L'ÉTAT. Le compte de test, ses sessions, ses défis, ses compteurs de tentatives et
 * ses lignes d'audit sont supprimés à la fin. La suppression des lignes d'audit passe par
 * l'échappement de rétention prévu par `0006_audit-logs.sql` — le déclencheur d'immuabilité refuse
 * tout le reste.
 */

/**
 * EXÉCUTION EN SÉRIE, DANS UN SEUL TRAVAILLEUR. Les tests de ce fichier partagent un serveur, un
 * compte et une sortie de journal, tous montés par `beforeAll`. En parallèle, Playwright
 * répartirait les tests sur plusieurs travailleurs, chacun rejouant `beforeAll` : autant de
 * serveurs, autant de comptes, et le dernier test — qui relit le journal du parcours entier — ne
 * verrait qu'un journal vide.
 */
test.describe.configure({ mode: 'serial' });

const AUTH_SECRET = 'secret-e2e-fictif-de-plus-de-32-caracteres-pour-les-essais';
const SERVER_READY_TIMEOUT_MS = 120_000;

/** Repère du parcours : la partie locale est unique et ne survit à aucun masquage. */
const IDENTIFIER_PREFIX = 'sentinelle-e2e';

/** Sorties toujours redirigées, entrée jamais : c'est ce que `stdio` déclare ci-dessous. */
type ServerProcess = ChildProcessByStdio<null, Readable, Readable>;

interface ServerHandle {
  readonly baseUrl: string;
  readonly process: ServerProcess;
  readonly lines: string[];
}

let server: ServerHandle | undefined;
let client: pg.Client | undefined;
let email = '';
let userId = '';
let startedAt = new Date();

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
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
      const response = await fetch(`${baseUrl}/api/v1/health`);
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

/**
 * Démarre `next start` sur un port libre, avec une configuration explicite.
 *
 * Les variables passées ici l'emportent sur `.env.local` : `@next/env` n'écrase jamais une valeur
 * déjà présente dans l'environnement du processus. `AUTH_SECRET` est fixé pour que les empreintes
 * restent stables — sans lui, le serveur engendrerait une clé éphémère et les défis émis avant un
 * redémarrage deviendraient invérifiables.
 */
async function startServer(databaseUrl: string): Promise<ServerHandle> {
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
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

  await waitForServer(baseUrl, child);
  return { baseUrl, process: child, lines };
}

async function stopServer(handle: ServerHandle): Promise<void> {
  if (handle.process.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    handle.process.once('exit', () => {
      resolve();
    });
    handle.process.kill();
    setTimeout(() => {
      handle.process.kill('SIGKILL');
      resolve();
    }, 5_000);
  });
}

/**
 * Lit le code remis par l'adaptateur de journalisation.
 *
 * La ligne recherchée est celle de `LoggingCodeDelivery`, qui porte `signInCode` et un
 * destinataire MASQUÉ. Le test attend son apparition : la remise est détachée du chemin de
 * réponse, elle n'a donc pas encore eu lieu quand la page affiche l'étape suivante.
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

test.beforeAll(
  // biome-ignore lint/correctness/noEmptyPattern: Playwright impose un motif de destructuration en premier parametre, seul `info` est utilise ici.
  async ({}, info) => {
    test.setTimeout(180_000);
    const environment = loadIntegrationEnvironment();
    const databaseUrl = environment.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      throw new Error('DATABASE_URL est absente : le parcours de connexion exige une base réelle.');
    }

    startedAt = new Date();
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();

    // Adresse unique par projet Playwright : les projets mobile et bureau tournent en parallèle et
    // ne doivent pas se disputer le même compte ni le même compteur de tentatives.
    email = `${IDENTIFIER_PREFIX}-${info.project.name}-${randomUUID().slice(0, 8)}@exemple.test`;
    const { rows } = await client.query<{ readonly id: string }>(
      `insert into public.user_profiles (display_name, email, preferred_language, verification_level, status)
     values ('Camille Dubois', $1, 'fr', 'CONTACT_VERIFIED', 'ACTIVE')
     returning id`,
      [email],
    );
    userId = rows[0]?.id ?? '';

    server = await startServer(databaseUrl);
  },
);

test.afterAll(async () => {
  if (server !== undefined) {
    await stopServer(server);
  }
  if (client !== undefined) {
    // La suppression du profil emporte ses sessions et ses défis (ON DELETE CASCADE).
    await client.query('delete from public.user_profiles where id = $1', [userId]);
    // Les défis créés pour les adresses SANS COMPTE ne sont rattachés à aucun profil — c'est
    // exactement ce que le critère 7 exige — donc aucune cascade ne les emporte. Sans cette
    // ligne, chaque exécution laisserait derrière elle les défis de neutralité.
    await client.query(
      'delete from public.auth_challenges where user_profile_id is null and created_at >= $1',
      [startedAt],
    );
    await client.query('delete from public.auth_attempts where created_at >= $1', [startedAt]);
    // Le journal d'audit est immuable : seul l'échappement de rétention prévu par la migration
    // 0006 permet de retirer les lignes produites par ce test.
    await client.query("select set_config('appui_feux.audit_purge', 'on', false)");
    await client.query(
      'delete from public.audit_logs where actor_user_id = $1 or target_id = $1 or recorded_at >= $2',
      [userId, startedAt],
    );
    await client.end();
  }
});

function requireServer(): ServerHandle {
  if (server === undefined) {
    throw new Error('serveur de test non démarré');
  }
  return server;
}

test.describe('parcours de connexion', () => {
  test("présente l'écran de connexion conforme aux arbitrages de US-010", async ({ page }) => {
    const { baseUrl } = requireServer();
    await page.goto(`${baseUrl}/connexion`);

    await expect(page.getByTestId('formulaire-connexion')).toBeVisible();
    await expect(page.getByLabel('Adresse de courriel')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Recevoir un code' })).toBeVisible();
    // ADR-015 : aucun mot de passe, donc aucun champ de mot de passe, aucun lien d'oubli, aucune
    // case « se souvenir de moi ». La phrase d'aide, elle, PARLE du mot de passe pour dire qu'il
    // n'y en a pas : ce n'est pas un champ, et la chercher par son texte serait un faux positif.
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.locator('input[autocomplete="current-password"]')).toHaveCount(0);
    await expect(page.getByLabel('Mot de passe', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Mot de passe oubli/ })).toHaveCount(0);
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByLabel('Adresse de courriel')).toHaveAttribute('autocomplete', 'email');
    // ADR-016 : aucun onglet de rôle, qui permettrait d'énumérer les comptes sensibles.
    for (const role of ['Contributeur', 'Coordinateur', 'Administration']) {
      await expect(page.getByRole('tab', { name: role })).toHaveCount(0);
    }
    // ENABLE_PUBLIC_REGISTRATION est faux : le lien serait un lien vers une page inexistante.
    await expect(page.getByRole('link', { name: 'Créer un compte' })).toHaveCount(0);
    // L'encart ANNONCE le second facteur ; il ne le fournit pas (US-011).
    await expect(
      page.getByText('Authentification renforcée pour les rôles sensibles'),
    ).toBeVisible();
    await expect(
      page.getByText('Ne pas utiliser cette application pour signaler un incendie', {
        exact: false,
      }),
    ).toBeVisible();
  });

  test('mène de la saisie de l adresse à la page connectée', async ({ page }) => {
    const handle = requireServer();
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });

    await page.goto(`${handle.baseUrl}/connexion`);
    const marker = handle.lines.length;

    await page.getByTestId('champ-identifiant').fill(email.toUpperCase());
    await page.getByRole('button', { name: 'Recevoir un code' }).click();

    // Message NEUTRE : « si un compte correspond ». Un texte affirmatif ferait mentir l'interface
    // là où le serveur, lui, ne dit rien.
    await expect(page.getByTestId('etape-code')).toBeVisible();
    await expect(page.getByTestId('message-code-envoye')).toContainText(
      'Si un compte correspond à cette adresse',
    );
    await expect(page.getByTestId('decompte-expiration')).toContainText('Ce code expire dans');

    const code = await readDeliveredCode(handle, marker);
    expect(code).toMatch(/^\d{6}$/);

    await page.getByTestId('champ-code').fill(code);
    await page.getByRole('button', { name: 'Se connecter' }).click();

    await expect(page).toHaveURL(/\/apres-connexion$/, { timeout: 30_000 });
    await expect(page.getByTestId('nom-affiche')).toHaveText('Camille Dubois');
    await expect(page.getByTestId('session-courante')).toBeVisible();

    // `HttpOnly` : le JavaScript de la page ne voit jamais le jeton. Une injection de script ne
    // suffit alors plus à voler la session.
    const readable = await page.evaluate(() => document.cookie);
    expect(readable).not.toContain('appui_feux_session');
    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((candidate) => candidate.name === 'appui_feux_session');
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(sessionCookie?.sameSite).toBe('Lax');
    expect(sessionCookie?.path).toBe('/');

    expect(consoleErrors, `erreurs console : ${consoleErrors.join(' | ')}`).toStrictEqual([]);
  });

  test('affiche le même écran pour une adresse sans compte', async ({ page }) => {
    const { baseUrl } = requireServer();
    await page.goto(`${baseUrl}/connexion`);

    await page
      .getByTestId('champ-identifiant')
      .fill(`${IDENTIFIER_PREFIX}-inconnu-${randomUUID().slice(0, 8)}@exemple.test`);
    await page.getByRole('button', { name: 'Recevoir un code' }).click();

    // Critère 7 vu depuis l'écran : rien ne distingue une adresse rattachée à un compte d'une
    // adresse qui n'existe pas. C'est ce qui empêche de cartographier les comptes coordinateurs.
    await expect(page.getByTestId('etape-code')).toBeVisible();
    await expect(page.getByTestId('message-code-envoye')).toContainText(
      'Si un compte correspond à cette adresse',
    );
    await expect(page.getByRole('button', { name: 'Se connecter' })).toBeVisible();
  });

  test('refuse un code erroné sans rien révéler', async ({ page }) => {
    const handle = requireServer();
    await page.goto(`${handle.baseUrl}/connexion`);

    await page
      .getByTestId('champ-identifiant')
      .fill(`${IDENTIFIER_PREFIX}-errone-${randomUUID().slice(0, 8)}@exemple.test`);
    await page.getByRole('button', { name: 'Recevoir un code' }).click();
    await expect(page.getByTestId('etape-code')).toBeVisible();

    await page.getByTestId('champ-code').fill('000000');
    await page.getByRole('button', { name: 'Se connecter' }).click();

    // UN SEUL MESSAGE pour les quatre échecs : l'écran ne rétablit pas la distinction que le
    // serveur refuse d'ouvrir.
    await expect(page.locator('#connexion-code-erreur')).toContainText(
      "Ce code est incorrect ou n'est plus valable",
    );
    await expect(page).toHaveURL(/\/connexion$/);
  });

  test("ne fait jamais apparaître l'adresse saisie dans l'URL", async ({ page }) => {
    const { baseUrl } = requireServer();
    await page.goto(`${baseUrl}/connexion`);

    await page.getByTestId('champ-identifiant').fill(email);
    await page.getByTestId('champ-identifiant').press('Enter');
    await page.waitForTimeout(1_000);

    // Une soumission native recopierait l'adresse dans l'URL, donc dans l'historique, dans les
    // journaux d'accès et dans l'en-tête `Referer` des requêtes suivantes.
    expect(page.url()).not.toContain('identifier');
    expect(page.url()).not.toContain(IDENTIFIER_PREFIX);
    expect(page.url()).toMatch(/\/connexion$/);
  });

  test('refuse la page connectée sans session', async ({ page }) => {
    const { baseUrl } = requireServer();
    await page.context().clearCookies();

    await page.goto(`${baseUrl}/apres-connexion`);

    // Masquer un bouton n'est jamais un contrôle d'accès : la protection est côté serveur.
    await expect(page).toHaveURL(/\/connexion$/, { timeout: 30_000 });
    await expect(page.getByTestId('formulaire-connexion')).toBeVisible();
    await expect(page.getByText('Camille Dubois')).toHaveCount(0);
  });

  test('déconnecte, puis refuse la session précédente', async ({ page }) => {
    const handle = requireServer();
    await page.context().clearCookies();
    await page.goto(`${handle.baseUrl}/connexion`);
    const marker = handle.lines.length;
    await page.getByTestId('champ-identifiant').fill(email);
    await page.getByRole('button', { name: 'Recevoir un code' }).click();
    await expect(page.getByTestId('etape-code')).toBeVisible();
    await page.getByTestId('champ-code').fill(await readDeliveredCode(handle, marker));
    await page.getByRole('button', { name: 'Se connecter' }).click();
    await expect(page).toHaveURL(/\/apres-connexion$/, { timeout: 30_000 });

    const before = await page.context().cookies();
    const previousToken = before.find(
      (candidate) => candidate.name === 'appui_feux_session',
    )?.value;
    expect(previousToken).toBeDefined();

    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await expect(page).toHaveURL(/\/connexion$/, { timeout: 30_000 });

    // REJEU DU COOKIE PRÉCÉDENT : cas de test obligatoire de docs/permissions.md. Le cookie est
    // reposé à la main, comme le ferait quelqu'un qui l'aurait recopié avant la déconnexion.
    await page.context().addCookies([
      {
        name: 'appui_feux_session',
        value: previousToken ?? '',
        domain: '127.0.0.1',
        path: '/',
      },
    ]);
    const replay = await page.request.get(`${handle.baseUrl}/api/v1/auth/sessions/current`);
    expect(replay.status()).toBe(401);
    expect(await replay.text()).toContain('UNAUTHENTICATED');

    await page.goto(`${handle.baseUrl}/apres-connexion`);
    await expect(page).toHaveURL(/\/connexion$/, { timeout: 30_000 });
  });

  test('ferme toutes les sessions par la révocation globale', async ({ page, browser }) => {
    const handle = requireServer();
    await page.context().clearCookies();

    // Deux sessions du même compte, sur deux contextes distincts : c'est la situation réelle d'un
    // téléphone d'astreinte et d'un poste partagé.
    const second = await browser.newContext();
    const secondPage = await second.newPage();
    try {
      for (const target of [page, secondPage]) {
        await target.goto(`${handle.baseUrl}/connexion`);
        const marker = handle.lines.length;
        await target.getByTestId('champ-identifiant').fill(email);
        await target.getByRole('button', { name: 'Recevoir un code' }).click();
        await expect(target.getByTestId('etape-code')).toBeVisible();
        await target.getByTestId('champ-code').fill(await readDeliveredCode(handle, marker));
        await target.getByRole('button', { name: 'Se connecter' }).click();
        await expect(target).toHaveURL(/\/apres-connexion$/, { timeout: 30_000 });
      }

      await page.getByRole('button', { name: 'Déconnecter tous mes appareils' }).click();
      await expect(page).toHaveURL(/\/connexion$/, { timeout: 30_000 });

      // L'autre appareil est coupé sans avoir rien fait : la révocation ne dépend d'aucun balayage
      // de la table des sessions, une seule écriture invalide tout.
      const stillOpen = await secondPage.request.get(
        `${handle.baseUrl}/api/v1/auth/sessions/current`,
      );
      expect(stillOpen.status()).toBe(401);
      await secondPage.goto(`${handle.baseUrl}/apres-connexion`);
      await expect(secondPage).toHaveURL(/\/connexion$/, { timeout: 30_000 });
    } finally {
      await second.close();
    }
  });

  test('bloque temporairement après trop de demandes, et le dit', async ({ page }) => {
    const { baseUrl } = requireServer();
    const blockedEmail = `${IDENTIFIER_PREFIX}-blocage-${randomUUID().slice(0, 8)}@exemple.test`;

    // Le seuil est atteint par l'API, pas par l'interface : cinq allers-retours dans le formulaire
    // testeraient l'enchaînement des étapes, pas le blocage, et rendraient le test tributaire de
    // l'état du bouton entre deux envois. L'appel passe par le contexte de la page, donc par la
    // même origine, et le sixième envoi est bien celui du formulaire.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await page.request.post(`${baseUrl}/api/v1/auth/codes`, {
        headers: { 'content-type': 'application/json', origin: baseUrl },
        data: { identifier: blockedEmail },
      });
      expect(response.status()).toBe(202);
    }

    await page.goto(`${baseUrl}/connexion`);
    await page.getByTestId('champ-identifiant').fill(blockedEmail);
    await page.getByRole('button', { name: 'Recevoir un code' }).click();

    // « Gestion des erreurs et blocage temporaire », docs/screens.md écran 2. Le décompte est en
    // dehors de l'encart d'alerte : une région assertive répéterait le message chaque seconde
    // pendant tout le blocage, soit un quart d'heure de parole continue au lecteur d'écran.
    await expect(page.getByTestId('message-connexion')).toContainText('Trop de tentatives');
    await expect(page.getByTestId('decompte-blocage')).toContainText(
      'Nouvelle tentative possible dans',
    );
    await expect(page.getByTestId('etape-code')).toHaveCount(0);
  });

  test("n'écrit ni jeton ni adresse complète dans les journaux du serveur", async () => {
    const handle = requireServer();
    const output = handle.lines.join('\n');

    // Le code, lui, EST journalisé : c'est le repli documenté du poste local, et c'est ce qui a
    // permis à ce fichier de se connecter. Hors environnement local, la même ligne n'existe pas
    // (vérifié dans `tests/integration/auth-logging.test.ts`).
    expect(output).toContain('signInCode');
    expect(output).toContain('poste local uniquement');
    // L'adresse complète, elle, ne doit apparaître nulle part : seul le masque le fait.
    expect(output).not.toContain(email);
    expect(output).toContain(`${IDENTIFIER_PREFIX.slice(0, 1)}***@exemple.test`);

    const tokens = output.match(/appui_feux_session=([A-Za-z0-9_-]{43})/g) ?? [];
    expect(tokens, `jeton de session journalisé : ${tokens.join(', ')}`).toStrictEqual([]);
  });
});

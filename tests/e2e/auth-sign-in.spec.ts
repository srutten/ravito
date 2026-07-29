import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { expect, test } from '@playwright/test';
import pg from 'pg';
import { E2E_DIRECTORY, SELF_HOSTED_SPECS } from '../../playwright.config';
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
 * Celui-ci écoute sur un port libre, sert le MÊME artefact `.next`, et est arrêté à la fin. Ce
 * fichier doit donc figurer dans `SELF_HOSTED_SPECS` — ce que le dernier groupe de tests vérifie,
 * pour lui-même comme pour ses voisins.
 *
 * ÉTAT LAISSÉ EN L'ÉTAT, ET UNIQUEMENT LE SIEN. Le compte de test, ses sessions, ses défis, ses
 * compteurs de tentatives et ses lignes d'audit sont supprimés à la fin. AUCUN PRÉDICAT DE PURGE
 * N'EST TEMPOREL : ils désignent tous les lignes de cette exécution, par identifiant ou par
 * empreinte de sujet. Ce qui a été mesuré avec un prédicat temporel est écrit devant `purgeRun`.
 */

/**
 * EXÉCUTION EN SÉRIE, DANS UN SEUL TRAVAILLEUR. Les tests du parcours partagent un serveur, un
 * compte et une sortie de journal, tous montés par `beforeAll`. En parallèle, Playwright
 * répartirait les tests sur plusieurs travailleurs, chacun rejouant `beforeAll` : autant de
 * serveurs, autant de comptes, et le dernier test — qui relit le journal du parcours entier — ne
 * verrait qu'un journal vide.
 *
 * La configuration est posée SUR LE GROUPE et non sur le fichier : le garde-fou de configuration,
 * en fin de fichier, ne dépend ni du serveur ni de la base, et n'a aucune raison d'être privé
 * d'exécution parce qu'un test du parcours a échoué avant lui.
 */

const AUTH_SECRET = 'secret-e2e-fictif-de-plus-de-32-caracteres-pour-les-essais';
const SERVER_READY_TIMEOUT_MS = 120_000;

/** Repère du parcours : la partie locale est unique et ne survit à aucun masquage. */
const IDENTIFIER_PREFIX = 'sentinelle-e2e';

/**
 * MIROIR DES EMPREINTES DE `src/domain/identity/hashing.ts`.
 *
 * POURQUOI CE MIROIR EXISTE. Les tables `auth_challenges` et `auth_attempts` ne portent aucune
 * valeur en clair : l'identifiant et le sujet limité y sont des HMAC, par construction. Un test
 * qui ne sait pas les recalculer ne peut désigner ses propres lignes que par le temps — et un
 * prédicat temporel emporte les lignes des voisins. Le serveur lancé plus bas reçoit `AUTH_SECRET`
 * de ce fichier : la clé est donc connue ici, et les empreintes sont reproductibles.
 *
 * CE MIROIR EST GARDÉ. Si les étiquettes de domaine ou le séparateur changeaient dans la
 * production, la purge cesserait silencieusement de désigner quoi que ce soit. Le test de blocage
 * relit la ligne de compteur ET la ligne d'audit PAR CETTE EMPREINTE : une dérive rend le test
 * rouge au lieu de laisser des restes en base.
 */
const HASH_FIELD_SEPARATOR = '\u0000';
const DOMAIN_IDENTIFIER = 'appui-feux:identity:identifier:v1';
const DOMAIN_ATTEMPT_SUBJECT = 'appui-feux:identity:attempt-subject:v1';

/** Chemins protégés par un compteur, au sens de `AttemptPolicy.purpose`. */
const ATTEMPT_PURPOSES = ['sign-in-request', 'sign-in-verify'] as const;

/**
 * Marqueur d'un fichier qui monte son propre serveur : le lancement effectif de `next start` par
 * un processus enfant. Le motif exige la COMMANDE et non une mention du sujet, pour qu'un fichier
 * qui se contente de parler du serveur commun dans son en-tête ne soit pas compté comme autonome.
 */
const SELF_HOSTED_SERVER_PATTERN = /spawn\(\s*process\.execPath\s*,\s*\[[^\]]*'start'/;

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

/**
 * Adresse d'appel DÉCLARÉE par ce fichier, unique à chaque exécution.
 *
 * POURQUOI CE FICHIER SE DONNE UNE SOURCE À LUI, ET CE QUE COÛTAIT LE CONTRAIRE. La limitation
 * `REQUEST_CODE_BY_SOURCE` (`src/domain/identity/policy.ts`) tolère 20 demandes de code par
 * quinze minutes sur la dimension « source ». Sans en-tête déclaré par l'appelant, `next start`
 * pose lui-même `X-Forwarded-For` avec l'adresse de la connexion : mesuré, le sujet compté vaut
 * alors `::ffff:127.0.0.1` — l'ADRESSE DE BOUCLAGE, la même pour les deux projets Playwright, qui
 * tournent en parallèle, et pour toutes les exécutions successives du quart d'heure. Ce fichier
 * demande à lui seul treize codes par projet, soit vingt-six sur un plafond de vingt. Le test de
 * blocage ci-dessous exige cinq réponses 202 CONSÉCUTIVES avant de provoquer le refus : il
 * échouait deux fois sur cinq, non parce que le blocage manquait, mais parce qu'un blocage
 * ÉTRANGER — celui de la source — arrivait trop tôt. Vérifié par inversion : compteur de bouclage
 * saturé et en-tête retiré, le premier appel de ce test reçoit 429 au lieu de 202 ; en-tête
 * rétabli, le fichier entier passe et le compteur saturé reste intact, à vingt et un.
 *
 * LA LIMITE DE PRODUCTION N'EST PAS DESSERRÉE, ET AUCUN COMPTEUR VOISIN N'EST REMIS À ZÉRO. Ce
 * fichier déclare une source qui n'appartient qu'à lui, dans le préfixe de documentation
 * `2001:db8::/32` (RFC 3849). La lecture de `X-Forwarded-For` est le comportement de production,
 * documenté comme tel dans `app/api/v1/auth/_shared/auth-route.ts` ; le test ne fait que s'en
 * servir pour s'isoler, au lieu d'effacer le compteur qu'un fichier voisin est peut-être en train
 * d'éprouver — ce qu'un nettoyage temporel, lui, fait sans le dire.
 *
 * La dimension réellement éprouvée par le test de blocage reste celle par IDENTIFIANT, qui, elle,
 * ne dépend d'aucun en-tête.
 */
let sourceAddress = '';

/** Empreintes d'identifiant à retirer de `auth_challenges`. */
const challengeIdentifierHashes: string[] = [];

/**
 * Empreintes de sujet à retirer de `auth_attempts`, et citées par les lignes d'audit
 * `SIGN_IN_BLOCKED` que ce fichier peut provoquer.
 */
const attemptSubjectHashes: string[] = [];

function hmacHex(domain: string, value: string): string {
  return createHmac('sha256', AUTH_SECRET)
    .update(`${domain}${HASH_FIELD_SEPARATOR}${value}`)
    .digest('hex');
}

function attemptSubjectHash(dimension: string, purpose: string, subject: string): string {
  return hmacHex(
    DOMAIN_ATTEMPT_SUBJECT,
    `${dimension}${HASH_FIELD_SEPARATOR}${purpose}${HASH_FIELD_SEPARATOR}${subject}`,
  );
}

/**
 * Enregistre un identifiant employé par ce fichier et rend sa forme normalisée.
 *
 * TOUT IDENTIFIANT PASSE PAR ICI, y compris ceux qui n'existent en base sous aucun compte : c'est
 * ce qui rend la purge finale EXHAUSTIVE par construction, plutôt que dépendante d'une liste tenue
 * à la main qu'un test ajouté demain oublierait de compléter.
 *
 * LES DEUX CHEMINS NE LIMITENT PAS LE MÊME SUJET, et l'écart se manque facilement.
 * `request-sign-in-code.ts` compte sur l'identifiant NORMALISÉ ; `verify-sign-in-code.ts` compte
 * sur son EMPREINTE, la valeur déjà hachée qui sert de clé au défi. Les deux formes sont donc
 * enregistrées. Mesuré avec la seule première : le refus de code du test « refuse un code erroné »
 * laissait derrière lui une ligne de compteur que la purge ne désignait pas.
 */
function trackIdentifier(normalized: string): string {
  const identifierHash = hmacHex(DOMAIN_IDENTIFIER, normalized);
  challengeIdentifierHashes.push(identifierHash);
  attemptSubjectHashes.push(
    attemptSubjectHash('identifier', 'sign-in-request', normalized),
    attemptSubjectHash('identifier', 'sign-in-verify', identifierHash),
  );
  return normalized;
}

/** Adresse jetable, propre à un test, déjà enregistrée pour la purge. */
function disposableIdentifier(label: string): string {
  return trackIdentifier(`${IDENTIFIER_PREFIX}-${label}-${randomUUID().slice(0, 8)}@exemple.test`);
}

/** En-tête qui rattache un appel à la source déclarée par ce fichier. */
function sourceHeaders(): Record<string, string> {
  return { 'x-forwarded-for': sourceAddress };
}

async function selectRows<Row extends pg.QueryResultRow>(
  sql: string,
  values: readonly unknown[],
): Promise<Row[]> {
  if (client === undefined) {
    throw new Error("client PostgreSQL non connecte : le montage du fichier n'a pas abouti");
  }
  const { rows } = await client.query<Row>(sql, [...values]);
  return rows;
}

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
 * redémarrage deviendraient invérifiables, et la purge nominative de ce fichier ne saurait plus
 * recalculer une seule empreinte.
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
 * Retire de la base tout ce que cette exécution y a laissé, et RIEN D'AUTRE.
 *
 * CE QUE LES PRÉDICATS TEMPORELS COÛTAIENT, MESURÉ. La purge d'audit portait
 * `or recorded_at >= $2` : au `afterAll` de ce fichier — qui finit tôt, vers vingt-cinq secondes —
 * elle effaçait TOUTES les lignes écrites depuis son `beforeAll`, y compris les
 * `ORGANIZATION_CREATED` et `ORGANIZATION_MEMBER_ADDED` que `organizations.spec.ts` venait
 * d'écrire. Deux tests voisins échouaient, et le mode série privait dix autres d'exécution. Le
 * nettoyage des compteurs, lui, filtrait sur `created_at` alors que `auth_attempts` porte une
 * LIGNE UNIQUE PAR SUJET, réutilisée d'une exécution à l'autre : son `created_at` est celui de la
 * première exécution de la journée, et le filtre ne retirait donc rien de ce que les suivantes
 * avaient incrémenté.
 *
 * TOUT EST DONC NOMINATIF ICI. Le compte par son identifiant, les défis et les compteurs par les
 * empreintes que ce fichier sait recalculer, les lignes d'audit par l'acteur, la cible, ou
 * l'empreinte de sujet qu'elles citent. Une exécution voisine peut se dérouler pendant celle-ci
 * sans qu'aucune de ses lignes ne soit désignée.
 *
 * L'ORDRE COMPTE. Le profil part en premier et emporte ses sessions et ses défis par cascade ;
 * `audit_logs` n'a AUCUNE clé étrangère vers `user_profiles` (0006, volontairement : le journal
 * doit survivre à l'effacement d'un compte), donc `actor_user_id` reste renseigné après la
 * suppression du profil et le prédicat nominatif désigne encore les lignes.
 */
async function purgeRun(): Promise<void> {
  if (client === undefined) {
    return;
  }
  if (userId !== '') {
    await client.query('delete from public.user_profiles where id = $1', [userId]);
  }
  // Les défis créés pour les adresses SANS COMPTE ne sont rattachés à aucun profil — c'est
  // exactement ce que le critère 7 exige — donc aucune cascade ne les emporte.
  await client.query('delete from public.auth_challenges where identifier_hash = any($1::text[])', [
    challengeIdentifierHashes,
  ]);
  await client.query('delete from public.auth_attempts where subject_hash = any($1::text[])', [
    attemptSubjectHashes,
  ]);
  // Le journal d'audit est immuable : seul l'échappement de rétention prévu par la migration
  // 0006 permet de retirer les lignes produites par ce test.
  await client.query("select set_config('appui_feux.audit_purge', 'on', false)");
  await client.query(
    `delete from public.audit_logs
      where actor_user_id = $1
         or target_id = $1
         or (after ->> 'subjectHash') = any($2::text[])`,
    [userId === '' ? null : userId, attemptSubjectHashes],
  );
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

function requireServer(): ServerHandle {
  if (server === undefined) {
    throw new Error('serveur de test non démarré');
  }
  return server;
}

test.describe('parcours de connexion', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(
    // biome-ignore lint/correctness/noEmptyPattern: Playwright impose un motif de destructuration en premier parametre, seul `info` est utilise ici.
    async ({}, info) => {
      test.setTimeout(180_000);
      const environment = loadIntegrationEnvironment();
      const databaseUrl = environment.DATABASE_URL;
      if (databaseUrl === undefined || databaseUrl.trim() === '') {
        throw new Error(
          'DATABASE_URL est absente : le parcours de connexion exige une base réelle.',
        );
      }

      client = new pg.Client({ connectionString: databaseUrl });
      await client.connect();

      // Source unique par exécution ET par projet : mobile et bureau tournent en parallèle et ne
      // doivent pas se partager un budget de vingt demandes. Deux groupes de quatre chiffres
      // hexadécimaux tirés au hasard, soit 2^32 possibilités : deux exécutions de la même minute
      // ne se rencontrent pas.
      const token = randomUUID().replaceAll('-', '');
      sourceAddress = `2001:db8:${token.slice(0, 4)}:${token.slice(4, 8)}::1`;
      for (const purpose of ATTEMPT_PURPOSES) {
        attemptSubjectHashes.push(attemptSubjectHash('source', purpose, sourceAddress));
      }

      // Adresse unique par projet Playwright : les projets mobile et bureau tournent en parallèle
      // et ne doivent pas se disputer le même compte ni le même compteur de tentatives.
      email = trackIdentifier(
        `${IDENTIFIER_PREFIX}-${info.project.name}-${randomUUID().slice(0, 8)}@exemple.test`,
      );
      const rows = await selectRows<{ readonly id: string }>(
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
      await purgeRun();
      await client.end();
    }
  });

  // La source déclarée vaut pour TOUTES les requêtes du navigateur, y compris la soumission du
  // formulaire : l'isolement serait vain si seuls les appels d'API la portaient.
  test.beforeEach(async ({ page }) => {
    await page.setExtraHTTPHeaders(sourceHeaders());
  });

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

    await page.getByTestId('champ-identifiant').fill(disposableIdentifier('inconnu'));
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

    await page.getByTestId('champ-identifiant').fill(disposableIdentifier('errone'));
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
    // téléphone d'astreinte et d'un poste partagé. Le second contexte déclare la MÊME source que
    // le premier : les deux appareils d'une même personne partagent son accès réseau.
    const second = await browser.newContext({ extraHTTPHeaders: sourceHeaders() });
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
    const blockedEmail = disposableIdentifier('blocage');

    // Le seuil est atteint par l'API, pas par l'interface : cinq allers-retours dans le formulaire
    // testeraient l'enchaînement des étapes, pas le blocage, et rendraient le test tributaire de
    // l'état du bouton entre deux envois. L'appel passe par le contexte de la page, donc par la
    // même origine, et le sixième envoi est bien celui du formulaire.
    //
    // CINQ RÉPONSES 202 EXIGÉES, DONC CINQ RÉELLEMENT DISPONIBLES. La source déclarée par ce
    // fichier n'appartient qu'à lui : les tests précédents lui ont coûté sept demandes, celles-ci
    // sont la huitième à la treizième, et `REQUEST_CODE_BY_SOURCE` en tolère vingt. Le seul
    // plafond que ces six appels puissent franchir est donc celui par identifiant — précisément
    // celui qu'on éprouve. `REQUEST_CODE_BY_IDENTIFIER.maxAttempts` vaut cinq et désigne le nombre
    // de tentatives TOLÉRÉES : les cinq premières passent, la sixième bloque.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await page.request.post(`${baseUrl}/api/v1/auth/codes`, {
        headers: { 'content-type': 'application/json', origin: baseUrl, ...sourceHeaders() },
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

    // L'ÉCRAN NE SUFFIT PAS À PROUVER LE BLOCAGE, ni à prouver que la purge saura retrouver ses
    // lignes. Les trois assertions suivantes lisent la base PAR L'EMPREINTE recalculée ici — la
    // même que celle dont `purgeRun` se sert. Vérifiées par inversion, en les jouant AVANT la
    // sixième demande : le compteur rend 5, `blocked_until` est nul, le journal ne porte aucune
    // ligne. Aucune des trois ne passe sans le blocage.
    //
    // Le compteur vaut SIX et non cinq, et l'écart n'est pas un détail : la sixième demande a été
    // REFUSÉE, et elle est pourtant comptée. C'est ce que `docs/observability.md` demande — le
    // compteur mesure l'intensité d'une campagne, pas seulement son déclenchement — et c'est aussi
    // ce qui rend `justBlocked` exact, donc ce qui garantit UNE SEULE ligne d'audit. Un compteur
    // gelé au seuil rendrait une rafale de mille tentatives indiscernable d'une de six.
    const subjectHash = attemptSubjectHash('identifier', 'sign-in-request', blockedEmail);
    const counters = await selectRows<{
      readonly attempt_count: number;
      readonly blocked: boolean;
    }>(
      `select attempt_count, blocked_until > now() as blocked
         from public.auth_attempts
        where subject_hash = $1`,
      [subjectHash],
    );
    expect(
      counters,
      'aucun compteur pour l empreinte recalculee : le miroir de hachage de ce fichier a derive de src/domain/identity/hashing.ts, et la purge nominative ne designe plus rien',
    ).toHaveLength(1);
    expect(counters[0]?.attempt_count).toBe(6);
    expect(counters[0]?.blocked).toBe(true);

    // UNE SEULE ligne d'audit par franchissement de seuil : `docs/api-contract.md` interdit qu'un
    // appelant non authentifié fasse grossir la table de preuve à volonté, et `docs/security.md`
    // exige que la campagne laisse une trace. Les deux moitiés tiennent ensemble.
    const audited = await selectRows<{ readonly count: string }>(
      `select count(*)::text as count
         from public.audit_logs
        where action = 'SIGN_IN_BLOCKED'
          and (after ->> 'subjectHash') = $1`,
      [subjectHash],
    );
    expect(audited[0]?.count).toBe('1');
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

/**
 * GARDE-FOU DE CONFIGURATION.
 *
 * POURQUOI CE GROUPE EXISTE, ET CE QUE SON ABSENCE A COÛTÉ. `SELF_HOSTED_SPECS` supprime le
 * serveur commun quand tous les fichiers visés montent le leur. La liste citait DEUX fichiers
 * alors que QUATRE le font : viser seuls `organizations-administration.spec.ts` ou
 * `accessibility.spec.ts` avec `CI=1` faisait monter le serveur commun sur un port déjà occupé —
 * « `http://localhost:3000` is already used », zéro test joué. Les en-têtes des deux fichiers
 * réclamaient eux-mêmes l'inscription ; personne ne l'avait faite, et rien ne le disait. Un
 * oubli qui ne rougit nulle part se découvre en intégration continue, sur le commit de
 * quelqu'un d'autre.
 *
 * POURQUOI L'ÉGALITÉ, ET NON L'INCLUSION. Une liste qui cite un fichier devenu dépendant du
 * serveur commun le priverait de serveur, donc le ferait échouer sans rien expliquer. Les deux
 * dérives se valent, l'assertion les couvre toutes les deux.
 *
 * POURQUOI ICI. Le garde-fou appartient à la porte qu'il protège : il est joué par
 * `npx playwright test`, sur les deux projets, et ce fichier est lui-même l'un des autonomes
 * qu'il énumère. Il ne prend aucune fixture — ni navigateur, ni serveur, ni base — et vit hors du
 * groupe en série : un échec du parcours de connexion ne peut pas le priver d'exécution.
 */
test.describe('configuration de la suite de bout en bout', () => {
  test('SELF_HOSTED_SPECS énumère exactement les fichiers qui montent leur propre serveur', () => {
    const specs = readdirSync(E2E_DIRECTORY)
      .filter((entry) => entry.endsWith('.spec.ts'))
      .sort();
    expect(
      specs.length,
      'aucun fichier de test lu : le répertoire e2e a changé de place',
    ).toBeGreaterThan(0);

    const autonomous = specs.filter((spec) =>
      SELF_HOSTED_SERVER_PATTERN.test(readFileSync(path.join(E2E_DIRECTORY, spec), 'utf8')),
    );
    expect(
      autonomous.length,
      'aucun fichier reconnu comme autonome : le motif de détection ne correspond plus au code qui démarre `next start`',
    ).toBeGreaterThan(0);

    expect(
      [...SELF_HOSTED_SPECS].sort(),
      'SELF_HOSTED_SPECS ne correspond plus aux fichiers qui montent leur propre serveur : un fichier autonome absent de la liste fait monter le serveur commun pour rien, et echoue en integration continue si le port 3000 est pris ; un fichier present a tort est prive du serveur dont il depend',
    ).toStrictEqual(autonomous);
  });
});

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * PORT DÉDIÉ À LA PORTE DE BOUT EN BOUT, et non le port applicatif habituel.
 *
 * POURQUOI 3210 ET NON 3000. Le serveur commun écoutait sur le port que prend par défaut la pile
 * Docker de ce dépôt, et avec elle tout autre projet Node du poste. Les deux issues étaient
 * mauvaises : hors intégration continue, Playwright RÉUTILISAIT ce qui s'y trouvait — mesuré sur le
 * poste de référence, un conteneur servant une autre base de code, donc un verdict rendu sur une
 * autre application ; en intégration continue, il refusait de démarrer et pas un test ne
 * s'exécutait. Un port qui n'est le défaut de personne retire la collision au lieu de la
 * documenter.
 *
 * `E2E_PORT` déplace ce port. `E2E_BASE_URL` vise une adresse entière, y compris distante : à
 * combiner alors avec `E2E_SHARED_SERVER=off`, puisque le serveur y est déjà monté par l'opérateur.
 */
const e2ePort = process.env.E2E_PORT ?? '3210';
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${e2ePort}`;
const isCI = Boolean(process.env.CI);

/**
 * Port réellement écouté par le serveur commun, LU SUR `baseURL` et non sur `E2E_PORT`.
 *
 * Les deux ne peuvent ainsi jamais diverger : donner `E2E_BASE_URL` sans `E2E_PORT` ferait sinon
 * écouter le serveur sur 3210 pendant que Playwright interrogerait une autre adresse, et la
 * commande expirerait au bout de deux minutes sur une erreur qui ne désigne pas sa cause.
 */
function sharedServerPort(): string {
  try {
    const declared = new URL(baseURL).port;
    return declared === '' ? e2ePort : declared;
  } catch {
    return e2ePort;
  }
}

/** Résolu depuis ce fichier et non depuis le dossier courant du lanceur. */
export const E2E_DIRECTORY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'tests',
  'e2e',
);

/**
 * Fichiers qui montent LEUR PROPRE serveur, sur un port libre, et n'emploient donc jamais
 * `baseURL` ni le serveur commun déclaré plus bas.
 *
 * POURQUOI CETTE LISTE EXISTE. Le serveur commun était monté à CHAQUE appel, quel que soit le
 * fichier visé. En intégration continue, `reuseExistingServer` vaut faux : si le port est déjà
 * pris — la pile Docker locale y sert un artefact antérieur —, Playwright abandonne avant qu'un
 * seul test ne démarre, y compris pour un fichier qui n'a que faire de ce serveur. En local,
 * l'inverse : la commande dépend d'un conteneur que le fichier n'emploie jamais, et l'arrêter
 * fait attendre deux minutes pour rien. Un fichier qui a pris la peine de servir l'artefact du
 * dépôt sur un port libre ne doit dépendre d'aucun serveur tiers, ni pour ses assertions, ni
 * pour son exécution.
 *
 * LA LISTE EST CELLE DES AUTONOMES, PAS CELLE DES DÉPENDANTS, et l'asymétrie est délibérée : un
 * fichier ajouté demain et oublié ici obtiendra le serveur commun, c'est-à-dire le comportement
 * antérieur. L'oubli coûte alors du temps, jamais un échec.
 *
 * CETTE PROMESSE ÉTAIT FAUSSE TANT QUE LA LISTE N'ÉTAIT GARDÉE PAR RIEN. Deux fichiers autonomes
 * — `organizations-administration` et `accessibility` — y manquaient : les viser seuls avec
 * `CI=1` faisait monter le serveur commun sur un port déjà occupé, donc « `http://localhost:3000`
 * is already used » et zéro test joué. L'oubli coûtait bien un échec. La liste est désormais
 * exportée et pinnée par `tests/e2e/auth-sign-in.spec.ts`, qui relit le répertoire et rougit dès
 * qu'un fichier démarre son propre serveur sans y figurer.
 */
export const SELF_HOSTED_SPECS = [
  'accessibility.spec.ts',
  'auth-sign-in.spec.ts',
  'organizations-administration.spec.ts',
  'organizations.spec.ts',
] as const;

/**
 * Options de `playwright test` qui ne consomment PAS l'argument suivant.
 *
 * POURQUOI L'INVENTAIRE PORTE SUR CELLES-LÀ ET NON SUR LES AUTRES. Le tri ci-dessous doit trancher
 * pour chaque jeton : filtre de fichier, ou valeur d'une option écrite en deux mots ? Se tromper
 * dans un sens fait monter le serveur commun pour rien — du temps perdu. Se tromper dans l'autre
 * le SUPPRIME alors que des fichiers en dépendent — un échec. Toute option inconnue est donc
 * réputée consommer une valeur, et seules les options sans valeur sont énumérées : une option
 * ajoutée demain par Playwright tombera du côté sûr.
 */
const VALUELESS_OPTIONS: ReadonlySet<string> = new Set([
  '--debug',
  '--fail-on-flaky-tests',
  '--forbid-only',
  '--fully-parallel',
  '--headed',
  '--help',
  '--ignore-snapshots',
  '--last-failed',
  '--list',
  '--no-deps',
  '--only-changed',
  '--pass-with-no-tests',
  '--quiet',
  '--ui',
  '--update-snapshots',
  '--version',
  '-h',
  '-u',
  '-V',
  '-x',
]);

/**
 * Arguments positionnels de `playwright test`, c'est-à-dire les filtres de fichiers.
 *
 * CE QUE LE TRI PRÉCÉDENT LAISSAIT PASSER, ET CE QUE ÇA COÛTAIT. Il ne retirait que les jetons
 * commençant par un tiret, si bien que la VALEUR d'une option écrite en deux mots restait dans la
 * liste. `playwright test -g "auth-sign-in"` — un motif de NOM DE TEST — était alors pris pour la
 * désignation du fichier `auth-sign-in.spec.ts`, fichier autonome, et le serveur commun était
 * supprimé ; or `-g` peut sélectionner des tests de `public-home`, `auth-entry-point` ou
 * `security-headers`, qui en dépendent réellement. L'en-tête promet que l'ignorance coûte du
 * temps et jamais un échec : ce chemin-là coûtait un échec.
 *
 * `--option=valeur` porte sa valeur avec elle et ne consomme rien ; `--` bascule tout le reste en
 * positionnel, conformément à l'usage.
 */
function commandLineFilters(): readonly string[] {
  const argv = process.argv.slice(2);
  const command = argv.indexOf('test');
  if (command === -1) {
    return [];
  }
  const filters: string[] = [];
  let expectsValue = false;
  let positionalOnly = false;
  for (const argument of argv.slice(command + 1)) {
    if (positionalOnly) {
      filters.push(argument);
      continue;
    }
    if (argument === '--') {
      positionalOnly = true;
      expectsValue = false;
      continue;
    }
    if (argument.startsWith('-')) {
      expectsValue = !argument.includes('=') && !VALUELESS_OPTIONS.has(argument);
      continue;
    }
    if (expectsValue) {
      expectsValue = false;
      continue;
    }
    filters.push(argument);
  }
  return filters;
}

function specFileNames(): readonly string[] {
  try {
    return readdirSync(E2E_DIRECTORY).filter((entry) => entry.endsWith('.spec.ts'));
  } catch {
    // Répertoire illisible : aucun fichier n'est désigné, donc le serveur commun est monté.
    return [];
  }
}

/** Fichiers que ce filtre peut désigner. Vide pour une valeur d'option ou un motif de test. */
function specsDesignatedBy(filter: string): readonly string[] {
  const normalized = filter.replaceAll('\\', '/');
  return specFileNames().filter(
    (spec) => normalized.includes(spec) || `tests/e2e/${spec}`.includes(normalized),
  );
}

/**
 * `E2E_SHARED_SERVER` tranche quand la déduction ne suffit pas : `off` pour une machine où le
 * port est occupé par autre chose, `on` pour un appel dont les filtres ne se laissent pas lire.
 *
 * SANS FICHIER DÉSIGNÉ, LE SERVEUR EST MONTÉ. C'est le cas de la suite entière comme celui d'un
 * appel qui ne filtre que par nom de test : on ignore alors quels fichiers vont s'exécuter, et
 * l'ignorance doit coûter du temps, jamais un échec.
 */
function sharedServerRequired(): boolean {
  const forced = process.env.E2E_SHARED_SERVER;
  if (forced === 'on' || forced === 'off') {
    return forced === 'on';
  }
  const designated = commandLineFilters().flatMap(specsDesignatedBy);
  if (designated.length === 0) {
    return true;
  }
  return designated.some((spec) => !SELF_HOSTED_SPECS.some((autonomous) => autonomous === spec));
}

const sharedWebServer = {
  command: 'npm run start',
  // `next start` lit `PORT` : sans cette ligne, le serveur écouterait sur son port par défaut
  // pendant que Playwright interrogerait le port dédié.
  env: { PORT: sharedServerPort() },
  url: baseURL,
  // AUCUNE RÉUTILISATION, MÊME EN LOCAL. Sur un port dédié, ce qui répond déjà ne peut être qu'un
  // serveur oublié par une exécution précédente, donc servant un artefact antérieur — précisément
  // le verdict faux que ce port dédié supprime. Un échec bruyant « port déjà utilisé » vaut mieux
  // qu'une suite verte rendue sur du code qui n'est plus le nôtre. Pour viser un serveur monté à la
  // main, `E2E_BASE_URL` avec `E2E_SHARED_SERVER=off`.
  reuseExistingServer: false,
  timeout: 120_000,
};

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  // `exactOptionalPropertyTypes` interdit d'affecter `undefined` a une propriete optionnelle :
  // en local on omet la cle pour laisser Playwright choisir son parallelisme par defaut.
  ...(isCI ? { workers: 1 } : {}),
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Les libelles utilisateur sont en francais.
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
  },
  projects: [
    // Le parcours mobile est le parcours de reference : cf. docs/functional-specification.md,
    // regles d'interface, mobile-first.
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
  ],
  ...(sharedServerRequired() ? { webServer: sharedWebServer } : {}),
});

/**
 * `npm run db:seed` — charge le jeu de démonstration décrit par docs/seed-data.md.
 *
 * Trois exigences structurent ce script.
 *
 * 1. REFUS PAR DÉFAUT. `assertSeedAllowed` est appelée avant la résolution de la cible, avant
 *    l'ouverture de la connexion et donc avant toute écriture. « Seed absent de production »
 *    (backlog/release-checklist.md) n'est pas une consigne d'exploitation mais un contrôle : une
 *    commande refusée ne touche même pas le serveur.
 *
 * 2. BLOCS DÉTECTÉS, JAMAIS SUPPOSÉS. Le jeu complet décrit par docs/seed-data.md porte sur des
 *    tables qui arrivent aux lots 1 à 6. Les blocs correspondants sont écrits dès maintenant, mais
 *    ne s'exécutent que si leurs tables existent RÉELLEMENT dans la base visée. L'existence est
 *    lue dans `pg_class`, elle n'est ni codée en dur ni déduite d'un numéro de lot : le jour où la
 *    migration du lot 1 crée `organizations`, le bloc correspondant s'exécute sans qu'une seule
 *    ligne de ce fichier change. Un bloc ignoré est ANNONCÉ, avec le lot et la story qui
 *    l'activeront — un seed qui échouerait faute de table serait inutilisable, un seed qui
 *    ignorerait la moitié du jeu en silence serait trompeur.
 *
 * 3. REJOUABILITÉ. Deux exécutions consécutives aboutissent au même état. Elle est obtenue par des
 *    identifiants fixes et des insertions idempotentes dans les fichiers SQL, jamais par un
 *    effacement préalable : `audit_logs` refuse `DELETE`, `UPDATE` et `TRUNCATE`, par les droits et
 *    par un déclencheur. Un seed qui se viderait avant de se remplir échouerait en `42501`, et
 *    devrait pour fonctionner obtenir le droit d'effacer un journal d'audit — exactement ce que
 *    `0006_audit-logs.sql` existe pour empêcher.
 *
 * Le compte utilisé est le compte APPLICATIF, pas le compte de migration. Charger des données avec
 * un compte disposant des droits de schéma masquerait un `GRANT` oublié dans une migration : le
 * jeu passerait en développement et l'application échouerait en recette. Ici, si le seed passe,
 * c'est que l'application a bien le droit d'écrire ce qu'elle devra écrire.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from 'pg';
import {
  closeClient,
  describeFailure,
  openClient,
  redactUrl,
  resolveApplicationTarget,
} from './lib/database-url.ts';
import { assertSeedAllowed } from './lib/environment-guard.ts';
import { scriptLogger, writeLine } from './lib/script-logger.ts';

const COMMAND = 'db:seed';

/** En-tête déclaratif d'un bloc, lu dans les commentaires de tête du fichier SQL. */
interface SeedBlockHeader {
  readonly title: string;
  /** Lot du plan d'implémentation qui crée les tables du bloc. */
  readonly lot: string;
  /** Stories du backlog qui l'activeront. */
  readonly story: string;
  /** Tables de `public` que le bloc alimente. Toutes doivent exister pour qu'il s'exécute. */
  readonly tables: readonly string[];
  /** Blocs dont les données doivent être présentes d'abord, pour respecter les clés étrangères. */
  readonly requiredBlocks: readonly string[];
  /** Ce que le fichier déclare de lui-même. Sert au contrôle de cohérence, jamais à décider. */
  readonly declaredActive: boolean;
}

interface SeedBlock {
  /** Préfixe `NNN` du nom de fichier. */
  readonly id: string;
  readonly name: string;
  readonly fileName: string;
  readonly path: string;
  readonly header: SeedBlockHeader;
}

interface SkippedBlock {
  readonly block: SeedBlock;
  readonly reason: string;
}

interface LoadedBlock {
  readonly block: SeedBlock;
  readonly writtenRows: number;
}

interface SeedPlan {
  readonly runnable: readonly SeedBlock[];
  readonly skipped: readonly SkippedBlock[];
  /** Blocs dont la déclaration `@etat` ne correspond plus à la réalité de la base. */
  readonly mismatched: readonly string[];
}

class SeedDirectoryError extends Error {
  constructor(message: string, options?: { readonly cause: unknown }) {
    super(message, options);
    this.name = 'SeedDirectoryError';
  }
}

class SeedHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedHeaderError';
  }
}

class SeedSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedSchemaError';
  }
}

class SeedExecutionError extends Error {
  readonly blockId: string;

  constructor(blockId: string, message: string, options?: { readonly cause: unknown }) {
    super(message, options);
    this.name = 'SeedExecutionError';
    this.blockId = blockId;
  }
}

const SEED_FILE_PATTERN = /^(\d{3})_([a-z0-9]+(?:-[a-z0-9]+)*)\.sql$/;
const HEADER_PATTERN = /^\s*--\s*@([a-z-]+)\s*:\s*(.*)$/;
const COMMENT_PREFIX = '--';
const SQL_SUFFIX = '.sql';
const MIGRATIONS_TABLE_NAME = 'schema_migrations';
/** Valeurs acceptées pour déclarer une liste vide, afin qu'un en-tête ne comporte jamais de trou. */
const EMPTY_LIST_MARKERS = ['aucun', 'aucune'];
const REQUIRED_HEADER_KEYS = ['titre', 'lot', 'story', 'tables', 'requiert-blocs', 'etat'] as const;
const ACTIVE_MARKER = 'actif';
const INACTIVE_MARKER = 'inactif';
/** Commandes dont le nombre de lignes traitées a un sens dans un compte rendu de chargement. */
const WRITE_COMMANDS: readonly string[] = ['INSERT', 'UPDATE', 'DELETE', 'MERGE'];
/** Rappel du jeu complet attendu, pour que le compte rendu dise ce qui manque encore. */
const FULL_DATASET =
  '4 organisations, 6 utilisateurs, 8 ressources, 3 demandes, 4 propositions, ' +
  '3 missions dans des états différents, 1 incident, des documents valides et expirés';

/** Répertoire canonique des blocs, résolu depuis ce module et non depuis le dossier courant. */
function defaultSeedDirectory(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'supabase', 'seed');
}

function parseList(raw: string): readonly string[] {
  if (EMPTY_LIST_MARKERS.includes(raw.toLowerCase())) {
    return [];
  }
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * Lit les clés `@…` des commentaires de TÊTE du fichier, et d'eux seuls. La lecture s'arrête à la
 * première ligne qui n'est ni vide ni un commentaire : une chaîne SQL contenant `@` plus bas dans
 * le fichier ne peut donc pas être prise pour une déclaration.
 */
function parseHeader(content: string, fileName: string): SeedBlockHeader {
  const values = new Map<string, string>();
  // Découpage insensible aux fins de ligne. Un fichier restitué en CRLF par git sur un poste
  // Windows laissait un `\r` en fin de ligne, que `HEADER_PATTERN` ne pouvait pas absorber : le
  // point ne correspond pas à un retour chariot, et `$` sans le drapeau multiligne n'accepte
  // aucun caractère résiduel. AUCUNE clé n'était alors reconnue, et le seed refusait de démarrer
  // en accusant le premier bloc d'avoir un en-tête incomplet.
  //
  // Un outil qui lit les fichiers du dépôt ne doit pas dépendre de la politique de fins de ligne
  // du poste : le moteur de migrations normalise déjà avant de calculer ses empreintes, pour la
  // même raison.
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    if (!trimmed.startsWith(COMMENT_PREFIX)) {
      break;
    }
    const matched = HEADER_PATTERN.exec(line);
    const key = matched?.[1];
    const value = matched?.[2];
    if (key === undefined || value === undefined) {
      continue;
    }
    if (values.has(key)) {
      throw new SeedHeaderError(
        `En-tête du bloc ${fileName} : la clé « @${key} » est déclarée deux fois. La déclaration doit être sans ambiguïté.`,
      );
    }
    values.set(key, value.trim());
  }

  const readKey = (key: (typeof REQUIRED_HEADER_KEYS)[number]): string => {
    const raw = values.get(key);
    if (raw === undefined || raw === '') {
      throw new SeedHeaderError(
        `En-tête du bloc ${fileName} : la clé « @${key} » est absente ou vide. Un bloc sans en-tête complet ne peut être ni activé ni expliqué à l'opérateur ; les clés attendues sont ${REQUIRED_HEADER_KEYS.map((item) => `@${item}`).join(', ')}.`,
      );
    }
    return raw;
  };

  const tables = parseList(readKey('tables'));
  if (tables.length === 0) {
    throw new SeedHeaderError(
      `En-tête du bloc ${fileName} : « @tables » ne nomme aucune table. C'est cette liste qui décide de l'exécution du bloc ; vide, elle rendrait la détection inopérante.`,
    );
  }

  const state = readKey('etat').toLowerCase();
  if (state !== ACTIVE_MARKER && state !== INACTIVE_MARKER) {
    throw new SeedHeaderError(
      `En-tête du bloc ${fileName} : « @etat » vaut « ${state} », or seules les valeurs ${ACTIVE_MARKER} et ${INACTIVE_MARKER} sont acceptées.`,
    );
  }

  return {
    title: readKey('titre'),
    lot: readKey('lot'),
    story: readKey('story'),
    tables,
    requiredBlocks: parseList(readKey('requiert-blocs')),
    declaredActive: state === ACTIVE_MARKER,
  };
}

/**
 * Recense les blocs du répertoire, triés par numéro.
 *
 * Un fichier `.sql` non conforme à la convention fait échouer le recensement plutôt que d'être
 * ignoré : un bloc qui ne serait jamais chargé, sans que personne ne le sache, produirait
 * exactement la démonstration trompeuse que ce script cherche à éviter.
 */
async function listSeedBlocks(directory: string): Promise<SeedBlock[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    throw new SeedDirectoryError(
      `Répertoire du jeu de démonstration introuvable ou illisible : ${directory}. Vérifier que le dépôt est complet.`,
      { cause: error },
    );
  }

  const blocks: SeedBlock[] = [];
  const seen = new Map<string, string>();

  for (const entry of entries.slice().sort()) {
    if (!entry.endsWith(SQL_SUFFIX)) {
      continue;
    }
    const matched = SEED_FILE_PATTERN.exec(entry);
    const id = matched?.[1];
    const name = matched?.[2];
    if (id === undefined || name === undefined) {
      throw new SeedDirectoryError(
        `Nom de bloc non conforme : ${entry}. Convention attendue : NNN_nom-en-kebab-case.sql, avec NNN sur trois chiffres.`,
      );
    }
    const previous = seen.get(id);
    if (previous !== undefined) {
      throw new SeedDirectoryError(
        `Deux blocs portent le numéro ${id} : ${previous} et ${entry}. L'ordre de chargement serait indéterminé, donc les clés étrangères aussi.`,
      );
    }
    seen.set(id, entry);
    const filePath = path.join(directory, entry);
    const content = await readFile(filePath, 'utf8');
    blocks.push({
      id,
      name,
      fileName: entry,
      path: filePath,
      header: parseHeader(content, entry),
    });
  }

  return blocks.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Tables réellement présentes dans `public`. La lecture passe par `pg_class`, visible de tout rôle
 * connecté : le compte applicatif n'a pas besoin de droit particulier pour que la détection
 * fonctionne. Les vues sont volontairement exclues — on n'insère pas dans une vue.
 */
async function readExistingTables(client: Client): Promise<Set<string>> {
  const { rows } = await client.query<{ readonly name: string }>(
    `select c.relname as name
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')`,
  );
  return new Set(rows.map((row) => row.name));
}

/**
 * Une base sans table de suivi n'est pas une base vide : c'est une base sur laquelle les migrations
 * n'ont jamais été jouées, ou une base qui n'est pas celle du projet. Charger des données dessus
 * n'aurait aucun sens, et le message doit dire quoi faire.
 */
function assertSchemaMigrated(existing: ReadonlySet<string>): void {
  if (!existing.has(MIGRATIONS_TABLE_NAME)) {
    throw new SeedSchemaError(
      "La base ne comporte pas la table de suivi des migrations : aucune migration n'y a jamais été appliquée, ou la commande ne vise pas la base du projet. Lancer « npm run db:migrate », puis relancer « npm run db:seed ».",
    );
  }
}

/**
 * Décide, bloc par bloc, ce qui peut être chargé.
 *
 * Deux motifs d'exclusion, et deux seulement :
 * - une table du bloc n'existe pas encore ;
 * - un bloc prérequis a lui-même été ignoré, auquel cas insérer produirait une violation de clé
 *   étrangère ou, pire, des lignes orphelines si la contrainte manquait.
 *
 * La déclaration `@etat` du fichier ne décide de rien. Elle est seulement confrontée à la réalité :
 * un écart signale un fichier dont l'en-tête n'a pas été mis à jour quand son lot a livré ses
 * tables, ce qui mérite d'être dit sans pour autant bloquer le chargement.
 */
function planExecution(blocks: readonly SeedBlock[], existing: ReadonlySet<string>): SeedPlan {
  const knownIds = new Set(blocks.map((block) => block.id));
  const runnable: SeedBlock[] = [];
  const skipped: SkippedBlock[] = [];
  const mismatched: string[] = [];
  const skippedIds = new Set<string>();

  for (const block of blocks) {
    for (const required of block.header.requiredBlocks) {
      if (!knownIds.has(required)) {
        throw new SeedHeaderError(
          `En-tête du bloc ${block.fileName} : « @requiert-blocs » désigne le bloc ${required}, qui n'existe pas dans supabase/seed.`,
        );
      }
    }

    const missingTables = block.header.tables.filter((table) => !existing.has(table));
    const tablesPresent = missingTables.length === 0;
    if (tablesPresent !== block.header.declaredActive) {
      mismatched.push(
        `${block.fileName} se déclare « @etat: ${block.header.declaredActive ? ACTIVE_MARKER : INACTIVE_MARKER} » alors que ses tables ${tablesPresent ? 'existent' : "n'existent pas"} : mettre l'en-tête à jour.`,
      );
    }

    if (missingTables.length > 0) {
      skippedIds.add(block.id);
      skipped.push({
        block,
        reason: `table${missingTables.length > 1 ? 's' : ''} absente${missingTables.length > 1 ? 's' : ''} : ${missingTables.join(', ')}`,
      });
      continue;
    }

    const missingBlocks = block.header.requiredBlocks.filter((required) =>
      skippedIds.has(required),
    );
    if (missingBlocks.length > 0) {
      skippedIds.add(block.id);
      skipped.push({
        block,
        reason: `bloc${missingBlocks.length > 1 ? 's' : ''} prérequis ignoré${missingBlocks.length > 1 ? 's' : ''} : ${missingBlocks.join(', ')}`,
      });
      continue;
    }

    runnable.push(block);
  }

  return { runnable, skipped, mismatched };
}

/** Retire les corps dollar-quotés et les commentaires avant toute analyse lexicale du fichier. */
function stripSqlNoise(sql: string): string {
  return sql
    .replaceAll(/\$\$[\s\S]*?\$\$/g, ' ')
    .replaceAll(/--[^\n]*/g, ' ')
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ');
}

const TRANSACTION_CONTROL_PATTERN =
  /(^|\n)\s*(begin|start\s+transaction|commit|rollback|savepoint)\b/i;

/**
 * Un bloc ne gère pas sa propre transaction : c'est ce script qui l'ouvre et la referme, afin qu'un
 * bloc en échec soit annulé en entier. Un `COMMIT` glissé dans un fichier romprait cette garantie
 * sans rien signaler, et laisserait une moitié de bloc en base.
 */
function assertNoTransactionControl(content: string, block: SeedBlock): void {
  if (TRANSACTION_CONTROL_PATTERN.test(stripSqlNoise(content))) {
    throw new SeedHeaderError(
      `Le bloc ${block.fileName} contient une instruction de contrôle de transaction. Chaque bloc est déjà exécuté dans sa propre transaction par « ${COMMAND} » ; en ouvrir une seconde romprait l'annulation en cas d'échec.`,
    );
  }
}

/**
 * Nombre de lignes réellement écrites par une instruction. Une seconde exécution du jeu doit
 * renvoyer zéro partout : c'est la preuve observable de la rejouabilité, et non une déclaration.
 */
function readWrittenRows(result: unknown): number {
  if (typeof result !== 'object' || result === null) {
    return 0;
  }
  if (!('command' in result) || !('rowCount' in result)) {
    return 0;
  }
  const { command, rowCount } = result;
  if (typeof command !== 'string' || !WRITE_COMMANDS.includes(command)) {
    return 0;
  }
  return typeof rowCount === 'number' ? rowCount : 0;
}

/** Les messages du serveur ne sont pas ponctués : on les termine pour garder un compte rendu lisible. */
function terminate(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function describeBlockFailure(error: unknown, block: SeedBlock): string {
  const parts = [
    `Le bloc ${block.fileName} a échoué. La transaction a été annulée : aucune de ses lignes n'a été écrite.`,
    `Fichier : ${block.path}.`,
  ];
  if (typeof error === 'object' && error !== null) {
    if ('code' in error && typeof error.code === 'string') {
      parts.push(`Code PostgreSQL : ${error.code}.`);
    }
    if ('message' in error && typeof error.message === 'string') {
      parts.push(`Détail : ${terminate(error.message)}`);
    }
  }
  if (!block.header.declaredActive) {
    parts.push(
      `Ce bloc se déclarait inactif : ses tables viennent d'apparaître, apportées par le lot ${block.header.lot} (${block.header.story}), et son contenu n'est plus aligné sur le schéma livré. C'est au lot ${block.header.lot} de le mettre à jour, pas au moteur de l'ignorer.`,
    );
  }
  return parts.join(' ');
}

/**
 * Exécute un bloc dans sa propre transaction. Le découpage bloc par bloc est délibéré : un bloc en
 * échec ne doit pas emporter ceux qui l'ont précédé, sans quoi la correction d'un fichier de lot 3
 * obligerait à recharger tout le jeu.
 */
async function runBlock(client: Client, block: SeedBlock): Promise<number> {
  const content = await readFile(block.path, 'utf8');
  assertNoTransactionControl(content, block);

  await client.query('begin');
  try {
    const raw: unknown = await client.query(content);
    const results = Array.isArray(raw) ? raw : [raw];
    let written = 0;
    for (const result of results) {
      written += readWrittenRows(result);
    }
    await client.query('commit');
    scriptLogger.info({ block: block.fileName, written }, 'Bloc de démonstration chargé.');
    return written;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // La transaction est déjà close côté serveur : rien à récupérer de plus.
    }
    throw new SeedExecutionError(block.id, describeBlockFailure(error, block), { cause: error });
  }
}

function reportPlan(
  blocks: readonly SeedBlock[],
  plan: SeedPlan,
  loaded: readonly LoadedBlock[],
): void {
  writeLine();
  writeLine(`Blocs chargés (${loaded.length}) :`);
  if (loaded.length === 0) {
    writeLine('  aucun');
  }
  for (const entry of loaded) {
    writeLine(
      `  ${entry.block.fileName} — ${entry.block.header.title} — ${entry.writtenRows} ligne(s) écrite(s)`,
    );
  }

  if (plan.skipped.length > 0) {
    writeLine();
    writeLine(`Blocs ignorés (${plan.skipped.length}) — leurs tables n'existent pas encore :`);
    for (const entry of plan.skipped) {
      writeLine(
        `  ${entry.block.fileName} — ${entry.block.header.title} — lot ${entry.block.header.lot}, ${entry.block.header.story} — ${entry.reason}`,
      );
    }
  }

  if (plan.mismatched.length > 0) {
    writeLine();
    writeLine("Écarts entre la déclaration d'un bloc et l'état réel de la base :");
    for (const message of plan.mismatched) {
      writeLine(`  ${message}`);
    }
  }

  writeLine();
  writeLine(`Jeu complet attendu par docs/seed-data.md : ${FULL_DATASET}.`);
  if (plan.skipped.length > 0) {
    writeLine(
      `Le jeu chargé est donc VOLONTAIREMENT PARTIEL : ${plan.skipped.length} bloc(s) sur ${blocks.length} restent inactifs tant que les lots concernés n'ont pas livré leurs tables. Les fichiers correspondants existent déjà dans supabase/seed et s'activeront d'eux-mêmes.`,
    );
  } else {
    writeLine('Tous les blocs du jeu ont été chargés.');
  }
  writeLine('Une seconde exécution doit écrire 0 ligne partout : le jeu est idempotent.');
}

async function main(): Promise<number> {
  const env = process.env;
  // Garde-fou avant tout le reste : ni cible résolue, ni connexion ouverte, ni ligne écrite tant
  // que l'environnement n'est pas explicitement local ou de test.
  assertSeedAllowed(env);

  const target = resolveApplicationTarget(env);
  writeLine(`Cible : ${target.label}, ${redactUrl(target.url)}.`);

  const directory = defaultSeedDirectory();
  const blocks = await listSeedBlocks(directory);
  writeLine(`${blocks.length} bloc(s) de démonstration recensé(s) dans supabase/seed.`);

  const client = await openClient(target, env);
  try {
    const existing = await readExistingTables(client);
    assertSchemaMigrated(existing);

    const plan = planExecution(blocks, existing);
    writeLine(
      `${plan.runnable.length} bloc(s) exécutable(s) après détection des tables présentes, ${plan.skipped.length} ignoré(s).`,
    );

    const loaded: LoadedBlock[] = [];
    for (const block of plan.runnable) {
      loaded.push({ block, writtenRows: await runBlock(client, block) });
    }

    reportPlan(blocks, plan, loaded);
    return 0;
  } finally {
    await closeClient(client);
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  scriptLogger.error({ command: COMMAND }, describeFailure(error, process.env));
  process.exitCode = 1;
}

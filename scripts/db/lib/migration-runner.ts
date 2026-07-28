/**
 * Moteur de migrations.
 *
 * Contraintes structurantes, toutes issues de CLAUDE.md et docs/database-design.md :
 *
 * - Immuabilité. « Les fichiers de migration sont immuables après fusion. » Le moteur enregistre
 *   l'empreinte SHA-256 de chaque migration appliquée ; si le fichier change ensuite, la dérive
 *   est détectée et l'exécution est refusée. Une migration enregistrée dont le fichier a disparu
 *   du dépôt est traitée de la même façon.
 * - Normalisation de l'empreinte. Le contenu est ramené en fins de ligne LF et débarrassé des
 *   espaces de fin avant hachage. Sans cela, un simple passage par un poste Windows ferait
 *   échouer la vérification alors que le SQL est identique.
 * - Transaction par migration. Chaque fichier est appliqué dans sa propre transaction, et
 *   l'enregistrement dans `schema_migrations` a lieu dans cette même transaction. Une migration
 *   appliquée mais non enregistrée laisserait une base irrattrapable.
 * - Verrou consultatif. Deux exécutions concurrentes ne doivent pas s'appliquer mutuellement les
 *   mêmes migrations. Le verrou est pris au niveau session, donc à l'extérieur des transactions,
 *   et il est libéré même en cas d'échec.
 *
 * La table `schema_migrations` est créée par le moteur lui-même : elle décrit l'état des
 * migrations et ne peut pas dépendre d'une migration.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from 'pg';
import { scriptLogger } from './script-logger.ts';

export interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly path: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
}

export interface MigrationDrift {
  readonly version: string;
  /** Empreinte enregistrée lors de l'application. Référence faisant foi. */
  readonly expected: string;
  /** Empreinte calculée sur le fichier présent aujourd'hui dans le dépôt. */
  readonly actual: string;
}

export interface MigrationStatus {
  readonly pending: readonly MigrationFile[];
  readonly applied: readonly AppliedMigration[];
  readonly drifted: readonly MigrationDrift[];
  /** Appliquées en base mais absentes du dépôt. */
  readonly missing: readonly AppliedMigration[];
}

export class MigrationDirectoryError extends Error {
  constructor(message: string, options?: { readonly cause: unknown }) {
    super(message, options);
    this.name = 'MigrationDirectoryError';
  }
}

export class MigrationIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationIntegrityError';
  }
}

export class MigrationLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationLockError';
  }
}

export class MigrationExecutionError extends Error {
  readonly version: string;

  constructor(version: string, message: string, options?: { readonly cause: unknown }) {
    super(message, options);
    this.name = 'MigrationExecutionError';
    this.version = version;
  }
}

export class PostgisUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostgisUnavailableError';
  }
}

interface AppliedRow {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: Date;
}

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9]+(?:-[a-z0-9]+)*)\.sql$/;
const DOWN_SUFFIX = '.down.sql';
const SQL_SUFFIX = '.sql';
const BYTE_ORDER_MARK = '﻿';
const MIGRATIONS_TABLE = 'public.schema_migrations';
const ADVISORY_LOCK_NAME = 'fire-support-platform:schema_migrations';
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

/**
 * Clé du verrou consultatif, dérivée d'un nom stable plutôt que d'un nombre magique : deux
 * exécutions du même dépôt calculent la même clé, et aucune autre application ne l'utilisera par
 * hasard. PostgreSQL attend un entier signé 64 bits.
 */
function deriveAdvisoryLockKey(name: string): string {
  return createHash('sha256').update(name, 'utf8').digest().readBigInt64BE(0).toString();
}

const ADVISORY_LOCK_KEY = deriveAdvisoryLockKey(ADVISORY_LOCK_NAME);

/**
 * Normalisation appliquée avant hachage : marque d'ordre des octets retirée, fins de ligne
 * ramenées à LF, espaces de fin supprimés ligne à ligne puis en fin de fichier.
 */
function normalizeContent(content: string): string {
  const withoutMark = content.startsWith(BYTE_ORDER_MARK) ? content.slice(1) : content;
  return withoutMark
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trimEnd();
}

export function computeChecksum(content: string): string {
  return createHash('sha256').update(normalizeContent(content), 'utf8').digest('hex');
}

/** Répertoire canonique des migrations, résolu depuis ce module et non depuis le dossier courant. */
export function defaultMigrationsDirectory(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', 'supabase', 'migrations');
}

/**
 * Recense les migrations du dépôt, triées par version.
 *
 * Un fichier `.sql` qui ne respecte pas la convention `NNNN_nom-en-kebab-case.sql` fait échouer le
 * recensement. L'ignorer silencieusement serait plus dangereux : une migration jamais appliquée
 * passerait inaperçue jusqu'à la première erreur en production.
 */
export async function listMigrationFiles(directory: string): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    throw new MigrationDirectoryError(
      `Répertoire de migrations introuvable ou illisible : ${directory}. Vérifier que le dépôt est complet.`,
      { cause: error },
    );
  }

  const files: MigrationFile[] = [];
  const seen = new Map<string, string>();

  for (const entry of entries.slice().sort()) {
    if (!entry.endsWith(SQL_SUFFIX) || entry.endsWith(DOWN_SUFFIX)) {
      continue;
    }
    const matched = MIGRATION_FILE_PATTERN.exec(entry);
    const version = matched?.[1];
    const name = matched?.[2];
    if (version === undefined || name === undefined) {
      throw new MigrationDirectoryError(
        `Nom de fichier de migration non conforme : ${entry}. Convention attendue : NNNN_nom-en-kebab-case.sql, avec NNNN sur quatre chiffres.`,
      );
    }
    const previous = seen.get(version);
    if (previous !== undefined) {
      throw new MigrationDirectoryError(
        `Deux migrations portent la version ${version} : ${previous} et ${entry}. L'ordre d'application serait indéterminé.`,
      );
    }
    seen.set(version, entry);
    const absolutePath = path.join(directory, entry);
    const content = await readFile(absolutePath, 'utf8');
    files.push({ version, name, path: absolutePath, checksum: computeChecksum(content) });
  }

  return files.sort((left, right) => left.version.localeCompare(right.version));
}

/**
 * Crée la table de suivi si nécessaire. Idempotent, et volontairement hors du jeu de migrations :
 * le moteur doit pouvoir lire son état avant qu'aucune migration n'ait été appliquée.
 */
export async function ensureMigrationsTable(client: Client): Promise<void> {
  await client.query(`create table if not exists ${MIGRATIONS_TABLE} (
    version text primary key,
    name text not null,
    checksum text not null,
    applied_at timestamptz not null default now(),
    execution_ms integer not null
  )`);
}

/**
 * Vérifie que l'extension PostGIS est proposée par le serveur. Sans elle, la première migration
 * géospatiale échouerait au milieu du lot, avec un message de bas niveau difficile à exploiter.
 */
export async function assertPostgisAvailable(client: Client): Promise<void> {
  const { rows } = await client.query<{ readonly available: boolean }>(
    "select exists (select 1 from pg_available_extensions where name = 'postgis') as available",
  );
  const row = rows[0];
  if (row === undefined || !row.available) {
    throw new PostgisUnavailableError(
      "Extension PostGIS indisponible sur ce serveur : elle n'apparaît pas dans pg_available_extensions. Les migrations géospatiales ne peuvent pas être appliquées. Utiliser une image PostgreSQL fournissant PostGIS, par exemple celle décrite dans docker-compose.yml, puis relancer « npm run db:up ». Vérifier aussi que la commande ne vise pas une autre base que la base locale du projet.",
    );
  }
}

function toAppliedMigration(row: AppliedRow): AppliedMigration {
  return {
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  };
}

export async function readStatus(
  client: Client,
  files: readonly MigrationFile[],
): Promise<MigrationStatus> {
  await ensureMigrationsTable(client);
  const { rows } = await client.query<AppliedRow>(
    `select version, name, checksum, applied_at from ${MIGRATIONS_TABLE} order by version asc`,
  );
  const applied = rows.map(toAppliedMigration);

  const fileByVersion = new Map(files.map((file) => [file.version, file]));
  const appliedVersions = new Set(applied.map((record) => record.version));

  const pending = files.filter((file) => !appliedVersions.has(file.version));
  const drifted: MigrationDrift[] = [];
  for (const record of applied) {
    const file = fileByVersion.get(record.version);
    if (file !== undefined && file.checksum !== record.checksum) {
      drifted.push({ version: record.version, expected: record.checksum, actual: file.checksum });
    }
  }
  const missing = applied.filter((record) => !fileByVersion.has(record.version));

  return { pending, applied, drifted, missing };
}

/**
 * Refus d'agir dès qu'un écart d'immuabilité est constaté. Exporté afin que `migrate` échoue sur
 * une dérive même lorsqu'aucune migration n'est en attente : sans cela, une base à jour dont un
 * fichier a été retouché après fusion passerait le contrôle en silence.
 */
export function assertMigrationIntegrity(status: MigrationStatus): void {
  if (status.drifted.length > 0) {
    const details = status.drifted.map(
      (drift) =>
        `  ${drift.version} : enregistrée ${drift.expected}, fichier actuel ${drift.actual}`,
    );
    throw new MigrationIntegrityError(
      [
        `Dérive d'empreinte sur ${status.drifted.length} migration(s) déjà appliquée(s). Les fichiers de migration sont immuables après fusion (CLAUDE.md).`,
        ...details,
        "Restaurer le contenu d'origine de ces fichiers, ou écrire une nouvelle migration décrivant le changement souhaité.",
      ].join('\n'),
    );
  }
  if (status.missing.length > 0) {
    const details = status.missing.map((record) => `  ${record.version}_${record.name}`);
    throw new MigrationIntegrityError(
      [
        `${status.missing.length} migration(s) enregistrée(s) en base sont absentes du dépôt. L'état de la base ne peut plus être reconstitué à partir du code.`,
        ...details,
        "Récupérer la branche qui contient ces fichiers, ou repartir d'une base saine avec « npm run db:reset » sur un poste de développement.",
      ].join('\n'),
    );
  }
}

async function acquireLock(client: Client): Promise<void> {
  const { rows } = await client.query<{ readonly acquired: boolean }>(
    'select pg_try_advisory_lock($1::bigint) as acquired',
    [ADVISORY_LOCK_KEY],
  );
  const row = rows[0];
  if (row === undefined || !row.acquired) {
    throw new MigrationLockError(
      "Une autre exécution applique déjà les migrations sur cette base : le verrou consultatif n'a pas pu être obtenu. Attendre la fin de cette exécution puis relancer.",
    );
  }
}

/** Libération systématique : un verrou de session oublié bloquerait toutes les exécutions suivantes. */
async function releaseLock(client: Client): Promise<void> {
  try {
    await client.query('select pg_advisory_unlock($1::bigint)', [ADVISORY_LOCK_KEY]);
  } catch (error) {
    scriptLogger.warn(
      { reason: error instanceof Error ? error.name : 'inconnue' },
      "Le verrou consultatif n'a pas pu être libéré explicitement. Il le sera à la fermeture de la session.",
    );
  }
}

async function readAppliedVersions(client: Client): Promise<Set<string>> {
  const { rows } = await client.query<{ readonly version: string }>(
    `select version from ${MIGRATIONS_TABLE}`,
  );
  return new Set(rows.map((row) => row.version));
}

/** Les messages du serveur ne sont pas ponctués : on les termine pour garder un compte rendu lisible. */
function terminate(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function describeExecutionFailure(error: unknown, file: MigrationFile): string {
  const parts = [
    `La migration ${file.version}_${file.name} a échoué. La transaction a été annulée : la base est restée dans son état antérieur.`,
    `Fichier : ${file.path}.`,
  ];
  if (typeof error === 'object' && error !== null) {
    if ('code' in error && typeof error.code === 'string') {
      parts.push(`Code PostgreSQL : ${error.code}.`);
    }
    if ('message' in error && typeof error.message === 'string') {
      parts.push(`Détail : ${terminate(error.message)}`);
    }
    if ('hint' in error && typeof error.hint === 'string') {
      parts.push(`Piste : ${terminate(error.hint)}`);
    }
  }
  parts.push('Corriger le fichier puis relancer « npm run db:migrate ».');
  return parts.join(' ');
}

async function applyOne(client: Client, file: MigrationFile): Promise<AppliedMigration> {
  const content = await readFile(file.path, 'utf8');
  // Le fichier a pu changer entre le recensement et l'application : on applique exactement ce
  // dont on enregistre l'empreinte, jamais autre chose.
  const checksum = computeChecksum(content);
  if (checksum !== file.checksum) {
    throw new MigrationIntegrityError(
      `Le fichier ${file.version}_${file.name} a été modifié pendant l'exécution. Aucune migration n'est appliquée à partir d'un contenu incertain.`,
    );
  }

  const startedAt = process.hrtime.bigint();
  await client.query('begin');
  try {
    await client.query(content);
    const executionMs = Number((process.hrtime.bigint() - startedAt) / NANOSECONDS_PER_MILLISECOND);
    const { rows } = await client.query<AppliedRow>(
      `insert into ${MIGRATIONS_TABLE} (version, name, checksum, execution_ms)
       values ($1, $2, $3, $4)
       returning version, name, checksum, applied_at`,
      [file.version, file.name, file.checksum, executionMs],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new MigrationExecutionError(
        file.version,
        `L'enregistrement de la migration ${file.version}_${file.name} n'a rien renvoyé.`,
      );
    }
    await client.query('commit');
    scriptLogger.info(
      { version: file.version, name: file.name, executionMs },
      'Migration appliquée.',
    );
    return toAppliedMigration(row);
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // La transaction est déjà close côté serveur : rien à récupérer de plus.
    }
    if (error instanceof MigrationIntegrityError || error instanceof MigrationExecutionError) {
      throw error;
    }
    throw new MigrationExecutionError(file.version, describeExecutionFailure(error, file), {
      cause: error,
    });
  }
}

/**
 * Applique les migrations en attente, dans l'ordre des versions.
 *
 * L'intégrité est vérifiée avant toute écriture. Le verrou consultatif est pris ensuite, puis
 * l'état appliqué est relu : entre le calcul du statut et l'obtention du verrou, une exécution
 * concurrente a pu appliquer une partie du lot.
 */
export async function applyPending(
  client: Client,
  status: MigrationStatus,
): Promise<AppliedMigration[]> {
  assertMigrationIntegrity(status);
  if (status.pending.length === 0) {
    return [];
  }

  await acquireLock(client);
  try {
    const alreadyApplied = await readAppliedVersions(client);
    const results: AppliedMigration[] = [];
    for (const file of status.pending) {
      if (alreadyApplied.has(file.version)) {
        scriptLogger.info(
          { version: file.version, name: file.name },
          'Migration déjà appliquée par une exécution concurrente, elle est ignorée.',
        );
        continue;
      }
      results.push(await applyOne(client, file));
    }
    return results;
  } finally {
    await releaseLock(client);
  }
}

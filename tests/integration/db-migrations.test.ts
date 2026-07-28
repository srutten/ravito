import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyPending,
  assertMigrationIntegrity,
  computeChecksum,
  defaultMigrationsDirectory,
  listMigrationFiles,
  MigrationIntegrityError,
  readStatus,
} from '../../scripts/db/lib/migration-runner';
import type { DisposableDatabaseSetup } from './setup/database';
import { createDisposableDatabase, databaseOrSkip, NOT_PREPARED } from './setup/database';

/**
 * Moteur de migrations, contre une base réelle (US-002, critères 12 et immuabilité de CLAUDE.md).
 *
 * Le fichier travaille dans une base JETABLE, créée vierge puis supprimée : c'est la seule façon
 * d'observer la première application des migrations sans détruire la base de développement, et cela
 * garantit qu'aucun test ne laisse d'état derrière lui.
 *
 * Les tests d'immuabilité opèrent sur une COPIE du répertoire de migrations. Modifier un fichier du
 * dépôt pour éprouver la détection de dérive reviendrait à commettre, le temps du test, exactement
 * la faute que la règle interdit — et laisserait le dépôt corrompu si le test échouait avant sa
 * restauration.
 */

let setup: DisposableDatabaseSetup = NOT_PREPARED;
let workspace = '';

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'appui-feux-migrations-integration-'));
  setup = await createDisposableDatabase({ withMigrations: false });
});

afterAll(async () => {
  if (setup.available) {
    await setup.database.dispose();
  }
  if (workspace !== '') {
    await rm(workspace, { recursive: true, force: true });
  }
});

/** Copie jetable du répertoire de migrations : le dépôt n'est jamais modifié. */
async function copyMigrations(label: string): Promise<string> {
  const destination = await mkdtemp(path.join(workspace, `${label}-`));
  await cp(defaultMigrationsDirectory(), destination, { recursive: true });
  return destination;
}

interface RecordedMigration {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
  readonly execution_ms: number;
  readonly applied_at: Date;
}

describe('application des migrations sur une base vide', () => {
  it('applique toutes les migrations et les enregistre dans schema_migrations', async (context) => {
    const database = databaseOrSkip(setup, context);
    const files = await listMigrationFiles(defaultMigrationsDirectory());
    expect(files.length).toBeGreaterThan(0);

    const initial = await readStatus(database.owner, files);
    expect(initial.applied).toHaveLength(0);
    expect(initial.pending.map((file) => file.version)).toEqual(files.map((file) => file.version));
    expect(initial.drifted).toHaveLength(0);
    expect(initial.missing).toHaveLength(0);

    const applied = await applyPending(database.owner, initial);
    expect(applied.map((record) => record.version)).toEqual(files.map((file) => file.version));

    const { rows } = await database.owner.query<RecordedMigration>(
      'select version, name, checksum, execution_ms, applied_at from public.schema_migrations order by version',
    );
    expect(rows).toHaveLength(files.length);
    for (const [index, row] of rows.entries()) {
      const file = files[index];
      expect(row.version).toBe(file?.version);
      expect(row.name).toBe(file?.name);
      // L'empreinte enregistrée est la référence qui fera foi lors des exécutions suivantes.
      expect(row.checksum).toBe(file?.checksum);
      expect(row.execution_ms).toBeGreaterThanOrEqual(0);
      expect(row.applied_at.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    }
  });

  it('a réellement construit le socle : extension, tables et types énumérés', async (context) => {
    const database = databaseOrSkip(setup, context);

    const extensions = await database.owner.query<{ readonly extname: string }>(
      "select extname from pg_extension where extname in ('postgis', 'pgcrypto') order by extname",
    );
    expect(extensions.rows.map((row) => row.extname)).toEqual(['pgcrypto', 'postgis']);

    const tables = await database.owner.query<{ readonly relname: string }>(
      `select c.relname
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and c.relname in ('outbox', 'audit_logs', 'idempotency_witness')
        order by c.relname`,
    );
    expect(tables.rows.map((row) => row.relname)).toEqual([
      'audit_logs',
      'idempotency_witness',
      'outbox',
    ]);

    const types = await database.owner.query<{ readonly typname: string }>(
      `select t.typname
         from pg_type t
         join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public' and t.typtype = 'e'
        order by t.typname`,
    );
    expect(types.rows.map((row) => row.typname)).toContain('mission_status');
  });

  it("n'applique rien à la seconde exécution et ne signale aucune anomalie (critère 12)", async (context) => {
    const database = databaseOrSkip(setup, context);
    const files = await listMigrationFiles(defaultMigrationsDirectory());

    const status = await readStatus(database.owner, files);
    expect(status.pending).toHaveLength(0);
    expect(status.applied).toHaveLength(files.length);
    expect(status.drifted).toHaveLength(0);
    expect(status.missing).toHaveLength(0);

    // Aucune erreur, aucune écriture : c'est exactement ce que doit produire un `db:migrate` répété.
    await expect(applyPending(database.owner, status)).resolves.toEqual([]);

    const after = await readStatus(database.owner, files);
    expect(after.applied.map((record) => record.checksum)).toEqual(
      status.applied.map((record) => record.checksum),
    );
    expect(after.applied.map((record) => record.appliedAt.toISOString())).toEqual(
      status.applied.map((record) => record.appliedAt.toISOString()),
    );
  });
});

describe('immuabilité des migrations déjà appliquées', () => {
  it('détecte une dérive quand un fichier fusionné est modifié, et refuse d’agir', async (context) => {
    const database = databaseOrSkip(setup, context);
    const directory = await copyMigrations('derive');
    const victim = path.join(directory, '0005_outbox.sql');
    const original = await readFile(victim, 'utf8');

    await writeFile(victim, `${original}\n-- ligne ajoutée après fusion : dérive volontaire\n`);
    expect(computeChecksum(await readFile(victim, 'utf8'))).not.toBe(computeChecksum(original));

    const files = await listMigrationFiles(directory);
    const status = await readStatus(database.owner, files);

    expect(status.drifted).toHaveLength(1);
    expect(status.drifted[0]?.version).toBe('0005');
    expect(status.drifted[0]?.expected).not.toBe(status.drifted[0]?.actual);
    expect(() => assertMigrationIntegrity(status)).toThrow(MigrationIntegrityError);
    await expect(applyPending(database.owner, status)).rejects.toBeInstanceOf(
      MigrationIntegrityError,
    );

    // Le fichier du dépôt est intact : la dérive n'a existé que dans la copie jetable.
    const repository = path.join(defaultMigrationsDirectory(), '0005_outbox.sql');
    expect(await readFile(repository, 'utf8')).toBe(original);
  });

  it('refuse d’agir quand une migration enregistrée a disparu du dépôt', async (context) => {
    const database = databaseOrSkip(setup, context);
    const directory = await copyMigrations('manquante');
    await rm(path.join(directory, '0007_idempotency-witness.sql'));

    const files = await listMigrationFiles(directory);
    const status = await readStatus(database.owner, files);

    expect(status.missing.map((record) => record.version)).toEqual(['0007']);
    expect(() => assertMigrationIntegrity(status)).toThrow(MigrationIntegrityError);
    await expect(applyPending(database.owner, status)).rejects.toBeInstanceOf(
      MigrationIntegrityError,
    );
  });

  it('ne se déclenche pas sur un dépôt converti en CRLF, qui est le même SQL', async (context) => {
    // Le dépôt est développé sous Windows avec `core.autocrlf` : sans normalisation de l'empreinte,
    // ce cas ferait échouer `db:migrate` sur un poste sain, et la vérification finirait désactivée.
    const database = databaseOrSkip(setup, context);
    const directory = await copyMigrations('crlf');
    const files = await listMigrationFiles(directory);

    for (const file of files) {
      const content = await readFile(file.path, 'utf8');
      const windowsStyle = content
        .split('\n')
        .map((line) => `${line.replace(/\s+$/, '')}  `)
        .join('\r\n');
      await writeFile(file.path, `${windowsStyle}\r\n`);
    }

    const converted = await listMigrationFiles(directory);
    expect(converted.map((file) => file.checksum)).toEqual(files.map((file) => file.checksum));

    const status = await readStatus(database.owner, converted);
    expect(status.drifted).toHaveLength(0);
    expect(status.missing).toHaveLength(0);
    expect(status.pending).toHaveLength(0);
  });
});

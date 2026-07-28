import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MigrationStatus } from '../../scripts/db/lib/migration-runner';
import {
  assertMigrationIntegrity,
  computeChecksum,
  defaultMigrationsDirectory,
  listMigrationFiles,
  MigrationDirectoryError,
  MigrationIntegrityError,
} from '../../scripts/db/lib/migration-runner';

/**
 * Moteur de migrations, partie vérifiable sans base (US-002, immuabilité de CLAUDE.md).
 *
 * Deux propriétés sont éprouvées ici, parce qu'elles conditionnent tout le reste.
 *
 * 1. L'EMPREINTE EST NORMALISÉE. Le dépôt est développé sous Windows, avec `core.autocrlf`
 *    actif : le même fichier arrive en CRLF sur un poste et en LF sur un autre. Si l'empreinte
 *    dépendait des fins de ligne, la vérification d'immuabilité se déclencherait à tort sur la
 *    moitié des postes, et la seule issue praticable serait de la désactiver — c'est-à-dire de
 *    perdre la garantie qu'elle apporte.
 *
 * 2. LE RECENSEMENT REFUSE L'À-PEU-PRÈS. Un fichier mal nommé, ou deux fichiers portant la même
 *    version, font échouer le recensement au lieu d'être ignorés : une migration jamais appliquée
 *    sans que personne ne le sache est le pire des deux défauts.
 */

const SQL = [
  '-- migration de démonstration',
  'create table exemple (',
  '  id uuid primary key',
  ');',
].join('\n');

const BYTE_ORDER_MARK = '﻿';
const HEXADECIMAL_SHA256 = /^[0-9a-f]{64}$/;

let workspace = '';

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'appui-feux-migrations-unitaires-'));
});

afterAll(async () => {
  if (workspace !== '') {
    await rm(workspace, { recursive: true, force: true });
  }
});

/** Crée un répertoire de migrations jetable. Le dépôt n'est jamais modifié par un test. */
async function makeDirectory(
  label: string,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const directory = await mkdtemp(path.join(workspace, `${label}-`));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(directory, name), content, 'utf8');
  }
  return directory;
}

describe('computeChecksum', () => {
  it('produit une empreinte SHA-256 hexadécimale, stable d’un appel à l’autre', () => {
    const first = computeChecksum(SQL);
    expect(first).toMatch(HEXADECIMAL_SHA256);
    expect(computeChecksum(SQL)).toBe(first);
  });

  it('est insensible aux fins de ligne CRLF contre LF', () => {
    expect(computeChecksum(SQL.replaceAll('\n', '\r\n'))).toBe(computeChecksum(SQL));
    expect(computeChecksum(SQL.replaceAll('\n', '\r'))).toBe(computeChecksum(SQL));
  });

  it('est insensible aux espaces de fin de ligne et de fin de fichier', () => {
    const withTrailingSpaces = SQL.split('\n')
      .map((line) => `${line}   `)
      .join('\r\n');
    expect(computeChecksum(`${withTrailingSpaces}\r\n\r\n`)).toBe(computeChecksum(SQL));
  });

  it('est insensible à une marque d’ordre des octets ajoutée par un éditeur', () => {
    expect(computeChecksum(`${BYTE_ORDER_MARK}${SQL}`)).toBe(computeChecksum(SQL));
  });

  it('change dès que le SQL change, y compris dans un commentaire', () => {
    // Un commentaire modifié après fusion reste une modification de migration : la dérive doit
    // être signalée, à charge pour l'auteur d'écrire une nouvelle migration.
    expect(computeChecksum(`${SQL}\n-- ligne ajoutée`)).not.toBe(computeChecksum(SQL));
    expect(computeChecksum(SQL.replace('exemple', 'exemple2'))).not.toBe(computeChecksum(SQL));
  });

  it('distingue une différence d’indentation, qui est une différence de contenu', () => {
    expect(computeChecksum(SQL.replace('  id', '    id'))).not.toBe(computeChecksum(SQL));
  });
});

describe('listMigrationFiles', () => {
  it('recense les migrations du dépôt, triées, sans les fichiers de retour arrière', async () => {
    const files = await listMigrationFiles(defaultMigrationsDirectory());
    expect(files.length).toBeGreaterThan(0);

    const versions = files.map((file) => file.version);
    expect(versions).toEqual([...versions].sort());
    expect(new Set(versions).size).toBe(versions.length);
    for (const file of files) {
      expect(file.version).toMatch(/^\d{4}$/);
      expect(file.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(file.checksum).toMatch(HEXADECIMAL_SHA256);
      // Un `.down.sql` appliqué comme une migration démonterait le schéma en cours de route.
      expect(file.path.endsWith('.down.sql')).toBe(false);
    }
  });

  it('ignore les fichiers de retour arrière et tout ce qui n’est pas du SQL', async () => {
    const directory = await makeDirectory('tri', {
      '0002_deuxieme.sql': SQL,
      '0001_premiere.sql': SQL,
      '0001_premiere.down.sql': 'drop table exemple;',
      'README.md': 'documentation',
      '.gitkeep': '',
    });
    const files = await listMigrationFiles(directory);
    expect(files.map((file) => `${file.version}_${file.name}`)).toEqual([
      '0001_premiere',
      '0002_deuxieme',
    ]);
  });

  it('calcule l’empreinte à partir du contenu réel du fichier', async () => {
    const directory = await makeDirectory('empreinte', { '0001_premiere.sql': SQL });
    const [file] = await listMigrationFiles(directory);
    expect(file?.checksum).toBe(computeChecksum(SQL));
  });

  it('refuse un nom de fichier non conforme plutôt que de l’ignorer', async () => {
    const directory = await makeDirectory('nom', { 'ajout_colonne.sql': SQL });
    await expect(listMigrationFiles(directory)).rejects.toBeInstanceOf(MigrationDirectoryError);
  });

  it('refuse deux migrations portant la même version', async () => {
    const directory = await makeDirectory('doublon', {
      '0001_premiere.sql': SQL,
      '0001_autre.sql': SQL,
    });
    await expect(listMigrationFiles(directory)).rejects.toBeInstanceOf(MigrationDirectoryError);
  });

  it('refuse un répertoire introuvable', async () => {
    await expect(
      listMigrationFiles(path.join(workspace, 'repertoire-absent')),
    ).rejects.toBeInstanceOf(MigrationDirectoryError);
  });
});

describe('assertMigrationIntegrity', () => {
  const clean: MigrationStatus = { pending: [], applied: [], drifted: [], missing: [] };

  it('accepte un état sans dérive ni migration manquante', () => {
    expect(() => assertMigrationIntegrity(clean)).not.toThrow();
  });

  it('refuse une dérive d’empreinte en nommant la version fautive', () => {
    const status: MigrationStatus = {
      ...clean,
      drifted: [{ version: '0005', expected: 'a'.repeat(64), actual: 'b'.repeat(64) }],
    };
    try {
      assertMigrationIntegrity(status);
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationIntegrityError);
      expect(String(error)).toContain('0005');
      expect(String(error)).toContain('immuables');
      return;
    }
    throw new Error('La dérive aurait dû être refusée.');
  });

  it('refuse une migration enregistrée mais absente du dépôt', () => {
    const status: MigrationStatus = {
      ...clean,
      missing: [
        {
          version: '0009',
          name: 'partie-d-une-autre-branche',
          checksum: 'c'.repeat(64),
          appliedAt: new Date('2026-07-27T10:00:00.000Z'),
        },
      ],
    };
    try {
      assertMigrationIntegrity(status);
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationIntegrityError);
      expect(String(error)).toContain('0009');
      return;
    }
    throw new Error('La migration manquante aurait dû être refusée.');
  });
});

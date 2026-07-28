/**
 * `npm run db:migrate` — applique les migrations en attente.
 *
 * Séquence : résolution de la cible, ouverture de la connexion, vérification de la disponibilité
 * de PostGIS, recensement des fichiers, lecture de l'état, refus en cas de dérive, application.
 *
 * La vérification PostGIS précède toute écriture, y compris la création de la table de suivi :
 * une commande dirigée par erreur vers une base inadaptée n'y laisse aucune trace.
 */

import {
  closeClient,
  describeFailure,
  openClient,
  redactUrl,
  resolveMigrationTarget,
} from './lib/database-url.ts';
import {
  applyPending,
  assertMigrationIntegrity,
  assertPostgisAvailable,
  defaultMigrationsDirectory,
  listMigrationFiles,
  readStatus,
} from './lib/migration-runner.ts';
import { scriptLogger, writeLine } from './lib/script-logger.ts';

const COMMAND = 'db:migrate';

async function main(): Promise<number> {
  const env = process.env;
  const target = resolveMigrationTarget(env);
  writeLine(`Cible : ${target.label}, ${redactUrl(target.url)}.`);

  const client = await openClient(target, env);
  try {
    await assertPostgisAvailable(client);

    const directory = defaultMigrationsDirectory();
    const files = await listMigrationFiles(directory);
    writeLine(`${files.length} fichier(s) de migration recensé(s).`);

    const status = await readStatus(client, files);
    // Contrôle d'immuabilité avant toute autre décision : une base déjà à jour dont un fichier a
    // été retouché après fusion doit faire échouer la commande, pas la terminer en silence.
    assertMigrationIntegrity(status);

    if (status.pending.length === 0) {
      writeLine('Aucune migration en attente : la base est à jour.');
      return 0;
    }

    writeLine(`${status.pending.length} migration(s) en attente :`);
    for (const file of status.pending) {
      writeLine(`  ${file.version}_${file.name}`);
    }

    const applied = await applyPending(client, status);
    writeLine(`${applied.length} migration(s) appliquée(s) :`);
    for (const record of applied) {
      writeLine(`  ${record.version}_${record.name} le ${record.appliedAt.toISOString()}`);
    }
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

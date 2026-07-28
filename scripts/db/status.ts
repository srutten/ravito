/**
 * `npm run db:status` — état des migrations.
 *
 * Affiche les migrations appliquées, en attente, en dérive d'empreinte et enregistrées sans
 * fichier correspondant. Le code de sortie vaut 1 dès qu'une anomalie d'immuabilité est constatée
 * — dérive ou fichier manquant — afin qu'une intégration continue puisse s'en servir comme
 * garde-fou. Des migrations en attente ne sont pas une anomalie : c'est l'état normal avant
 * déploiement.
 *
 * La commande n'écrit rien d'autre que la table de suivi, nécessaire à la lecture de l'état.
 */

import {
  closeClient,
  describeFailure,
  openClient,
  redactUrl,
  resolveMigrationTarget,
} from './lib/database-url.ts';
import {
  defaultMigrationsDirectory,
  listMigrationFiles,
  readStatus,
} from './lib/migration-runner.ts';
import { scriptLogger, writeLine } from './lib/script-logger.ts';

const COMMAND = 'db:status';
const SHORT_CHECKSUM_LENGTH = 12;

function shorten(checksum: string): string {
  return checksum.slice(0, SHORT_CHECKSUM_LENGTH);
}

async function main(): Promise<number> {
  const env = process.env;
  const target = resolveMigrationTarget(env);
  writeLine(`Cible : ${target.label}, ${redactUrl(target.url)}.`);

  const client = await openClient(target, env);
  try {
    const files = await listMigrationFiles(defaultMigrationsDirectory());
    const status = await readStatus(client, files);

    writeLine();
    writeLine(`Appliquées (${status.applied.length}) :`);
    if (status.applied.length === 0) {
      writeLine('  aucune');
    }
    for (const record of status.applied) {
      writeLine(
        `  ${record.version}_${record.name}  ${record.appliedAt.toISOString()}  ${shorten(record.checksum)}`,
      );
    }

    writeLine();
    writeLine(`En attente (${status.pending.length}) :`);
    if (status.pending.length === 0) {
      writeLine('  aucune');
    }
    for (const file of status.pending) {
      writeLine(`  ${file.version}_${file.name}  ${shorten(file.checksum)}`);
    }

    writeLine();
    writeLine(`Dérives d'empreinte (${status.drifted.length}) :`);
    if (status.drifted.length === 0) {
      writeLine('  aucune');
    }
    for (const drift of status.drifted) {
      writeLine(
        `  ${drift.version}  enregistrée ${shorten(drift.expected)}  fichier actuel ${shorten(drift.actual)}`,
      );
    }

    writeLine();
    writeLine(`Appliquées mais absentes du dépôt (${status.missing.length}) :`);
    if (status.missing.length === 0) {
      writeLine('  aucune');
    }
    for (const record of status.missing) {
      writeLine(`  ${record.version}_${record.name}  ${record.appliedAt.toISOString()}`);
    }

    writeLine();
    if (status.drifted.length > 0 || status.missing.length > 0) {
      writeLine(
        "Anomalie : les fichiers de migration sont immuables après fusion (CLAUDE.md). Restaurer les fichiers d'origine ou écrire une nouvelle migration.",
      );
      return 1;
    }
    writeLine(
      status.pending.length === 0
        ? 'La base est à jour.'
        : 'Aucune anomalie. Appliquer les migrations en attente avec « npm run db:migrate ».',
    );
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

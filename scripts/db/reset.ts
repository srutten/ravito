/**
 * `npm run db:reset` — supprime et recrée le schéma `public`, puis rejoue toutes les migrations.
 *
 * Commande destructrice. Le README avertit de ne jamais la pointer vers une base partagée ; cet
 * avertissement est rendu effectif par `assertResetAllowed`, qui refuse l'exécution si `APP_ENV`
 * ne vaut ni `local` ni `test`. Le contrôle a lieu avant toute connexion : une commande refusée
 * ne touche même pas le serveur.
 *
 * La suppression et la recréation du schéma se font dans une seule transaction. Les migrations
 * sont ensuite appliquées une par une, chacune dans la sienne, par le moteur.
 */

import type { Client } from 'pg';
import {
  closeClient,
  describeFailure,
  openClient,
  redactUrl,
  resolveMigrationTarget,
} from './lib/database-url.ts';
import { assertResetAllowed } from './lib/environment-guard.ts';
import {
  applyPending,
  assertPostgisAvailable,
  defaultMigrationsDirectory,
  listMigrationFiles,
  readStatus,
} from './lib/migration-runner.ts';
import { scriptLogger, writeLine } from './lib/script-logger.ts';

const COMMAND = 'db:reset';

/**
 * Remise à zéro du schéma applicatif. Les schémas `topology`, `tiger` et `tiger_data` installés
 * par l'image PostGIS ne sont pas touchés : ils appartiennent à l'extension, pas au produit.
 */
async function recreatePublicSchema(client: Client): Promise<void> {
  await client.query('begin');
  try {
    await client.query('drop schema if exists public cascade');
    await client.query('create schema public');
    await client.query("comment on schema public is 'standard public schema'");
    await client.query('commit');
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // La transaction est déjà close côté serveur : rien à récupérer de plus.
    }
    throw error;
  }
}

async function main(): Promise<number> {
  const env = process.env;
  // Garde-fou avant tout le reste : refus par défaut hors local et test.
  assertResetAllowed(env);

  const target = resolveMigrationTarget(env);
  writeLine(`Cible : ${target.label}, ${redactUrl(target.url)}.`);
  writeLine(
    'Commande destructrice : le schéma public et toutes ses données vont être supprimés, puis les migrations rejouées.',
  );

  const client = await openClient(target, env);
  try {
    await assertPostgisAvailable(client);

    await recreatePublicSchema(client);
    writeLine('Schéma public supprimé puis recréé.');

    const files = await listMigrationFiles(defaultMigrationsDirectory());
    const status = await readStatus(client, files);
    const applied = await applyPending(client, status);

    writeLine(`${applied.length} migration(s) appliquée(s) :`);
    if (applied.length === 0) {
      writeLine('  aucune');
    }
    for (const record of applied) {
      writeLine(`  ${record.version}_${record.name}`);
    }
    writeLine('Base remise à zéro. Charger le jeu de démonstration avec « npm run db:seed ».');
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

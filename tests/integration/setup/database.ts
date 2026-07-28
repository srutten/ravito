/**
 * Base jetable pour les tests d'intégration.
 *
 * Trois exigences de la story dictent cette conception.
 *
 * 1. AUCUN ÉTAT RÉSIDUEL. Chaque fichier de test crée SA base, y applique les migrations du dépôt,
 *    et la supprime à la fin. Aucun test ne touche la base de développement : ni ses données, ni
 *    son schéma, ni ses migrations enregistrées. Les migrations ne peuvent pas être jouées dans un
 *    schéma jetable — leur SQL nomme explicitement `public` et `0002` durcit ce schéma — donc c'est
 *    une base entière qui est jetable, pas un schéma.
 *
 * 2. JAMAIS DE VALEUR CODÉE EN DUR. La cible vient de l'environnement, résolue par le même
 *    `resolveMigrationTarget` que `npm run db:migrate`. Les tests s'exécutent donc contre la base
 *    que l'opérateur ou l'intégration continue a désignée, et contre aucune autre.
 *
 * 3. SAUT PROPRE, JAMAIS SILENCIEUX. Si aucune base n'est joignable, `createDisposableDatabase`
 *    renvoie `available: false` avec un motif explicite, que chaque test affiche en se déclarant
 *    ignoré. En revanche, dès qu'une base répond, les tests s'exécutent réellement : aucune
 *    condition supplémentaire ne peut les rendre inertes.
 *
 * Critère 15 : aucune fonction de ce module ne renvoie, n'affiche ni ne journalise la chaîne de
 * connexion, l'identifiant ou le mot de passe. `url` est exposé aux tests qui doivent lancer un
 * sous-processus, avec la consigne explicite de ne jamais l'afficher.
 */

import { randomBytes } from 'node:crypto';
import type { Client } from 'pg';
import type { DatabaseTarget } from '../../../scripts/db/lib/database-url';
import {
  closeClient,
  DatabaseConfigurationError,
  DatabaseConnectionError,
  openClient,
  redactUrl,
  resolveMigrationTarget,
} from '../../../scripts/db/lib/database-url';
import {
  applyPending,
  assertPostgisAvailable,
  defaultMigrationsDirectory,
  listMigrationFiles,
  PostgisUnavailableError,
  readStatus,
} from '../../../scripts/db/lib/migration-runner';
import { loadIntegrationEnvironment } from './environment';

export interface DisposableDatabase {
  /** Nom de la base jetable. Sûr à afficher : engendré aléatoirement, il ne contient aucun secret. */
  readonly name: string;
  /** Nom de la variable d'environnement qui a fourni la cible. Sûr à afficher. */
  readonly label: string;
  /**
   * Chaîne de connexion de la base jetable. NE JAMAIS afficher, journaliser, ni inclure dans un
   * message d'assertion : elle porte l'identifiant et le mot de passe. Réservée au passage à un
   * sous-processus par son environnement.
   */
  readonly url: string;
  /** Connexion propriétaire, ouverte pour toute la durée du fichier de test. */
  readonly owner: Client;
  /** Ouvre une connexion supplémentaire vers la même base : indispensable aux tests de course. */
  connect(): Promise<Client>;
  /** Ferme toutes les connexions ouvertes, puis supprime la base. */
  dispose(): Promise<void>;
}

export type DisposableDatabaseSetup =
  | { readonly available: true; readonly database: DisposableDatabase }
  | { readonly available: false; readonly reason: string };

/** Préfixe commun : il rend les bases de test reconnaissables et permet leur ramassage. */
const DISPOSABLE_PREFIX = 'fire_support_it_';
const SKIPPED = "Tests d'intégration de base de données ignorés";

/**
 * Un saut doit rester visible même avec le rapporteur par défaut, qui n'affiche pas la note portée
 * par chaque test ignoré. Sans cette ligne, une configuration cassée se lirait « 7 skipped » et une
 * suite entièrement inerte passerait pour une suite verte.
 */
function unavailable(reason: string): DisposableDatabaseSetup {
  const explained = `${SKIPPED} : ${reason}`;
  process.stderr.write(`${explained}\n`);
  return { available: false, reason: explained };
}

/**
 * Contexte de test réduit à ce dont ce module a besoin. Le type structurel évite d'importer Vitest
 * dans un utilitaire de préparation.
 */
interface SkippableContext {
  readonly skip: (note?: string) => never;
}

/**
 * Rend la base jetable, ou déclare le test ignoré avec le motif exact. Le motif est affiché par le
 * rapporteur : un saut reste donc toujours visible et expliqué, jamais silencieux.
 */
export function databaseOrSkip(
  setup: DisposableDatabaseSetup,
  context: SkippableContext,
): DisposableDatabase {
  if (setup.available) {
    return setup.database;
  }
  return context.skip(setup.reason);
}

/** État initial, avant que `beforeAll` n'ait pu s'exécuter. */
export const NOT_PREPARED: DisposableDatabaseSetup = {
  available: false,
  reason: "Préparation de la base jetable non exécutée : voir l'erreur du hook beforeAll.",
};

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Même serveur, même compte, autre base : seul le chemin de l'URL change. */
function withDatabaseName(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

async function dropDatabase(admin: Client, name: string): Promise<void> {
  // `WITH (FORCE)` coupe les connexions restées ouvertes : sans lui, une connexion oubliée par un
  // test en échec laisserait la base jetable derrière elle, indéfiniment.
  await admin.query(`drop database if exists ${quoteIdentifier(name)} with (force)`);
}

/**
 * Ramasse les bases jetables abandonnées par une exécution interrompue. Seules celles qui ne
 * portent plus aucune connexion sont supprimées : une exécution en cours n'est jamais coupée.
 */
async function dropLeftovers(admin: Client): Promise<void> {
  const { rows } = await admin.query<{ readonly datname: string }>(
    `select d.datname
       from pg_database d
      where d.datname like $1
        and not exists (select 1 from pg_stat_activity a where a.datname = d.datname)`,
    [`${DISPOSABLE_PREFIX}%`],
  );
  for (const row of rows) {
    await dropDatabase(admin, row.datname);
  }
}

/**
 * Crée une base jetable et, si demandé, y applique les migrations du dépôt.
 *
 * `withMigrations: false` sert au fichier qui teste le moteur lui-même : il a besoin d'une base
 * réellement vierge pour observer la première application.
 */
export async function createDisposableDatabase(options: {
  readonly withMigrations: boolean;
}): Promise<DisposableDatabaseSetup> {
  const env = loadIntegrationEnvironment();

  let target: DatabaseTarget;
  try {
    target = resolveMigrationTarget(env);
  } catch (error) {
    if (error instanceof DatabaseConfigurationError) {
      return unavailable(error.message);
    }
    throw error;
  }

  let admin: Client;
  try {
    admin = await openClient(target, env);
  } catch (error) {
    if (error instanceof DatabaseConnectionError) {
      return unavailable(error.message);
    }
    throw error;
  }

  const name = `${DISPOSABLE_PREFIX}${randomBytes(6).toString('hex')}`;
  try {
    await dropLeftovers(admin);
    await admin.query(`create database ${quoteIdentifier(name)}`);
  } catch (error) {
    await closeClient(admin);
    if (errorCode(error) === '42501') {
      return unavailable(
        `le compte désigné par ${target.label} n'a pas le droit de créer une base de données, or chaque fichier de test travaille dans une base jetable pour ne rien laisser derrière lui. Cible : ${target.label}, ${redactUrl(target.url)}.`,
      );
    }
    throw error;
  }

  const disposableTarget: DatabaseTarget = {
    url: withDatabaseName(target.url, name),
    label: target.label,
  };
  const extraClients: Client[] = [];

  let owner: Client;
  try {
    owner = await openClient(disposableTarget, env);
  } catch (error) {
    await dropDatabase(admin, name);
    await closeClient(admin);
    throw error;
  }

  const dispose = async (): Promise<void> => {
    for (const client of extraClients) {
      await closeClient(client);
    }
    extraClients.length = 0;
    await closeClient(owner);
    await dropDatabase(admin, name);
    await closeClient(admin);
  };

  try {
    await assertPostgisAvailable(owner);
    if (options.withMigrations) {
      const files = await listMigrationFiles(defaultMigrationsDirectory());
      const status = await readStatus(owner, files);
      await applyPending(owner, status);
    }
  } catch (error) {
    await dispose();
    if (error instanceof PostgisUnavailableError) {
      return unavailable(error.message);
    }
    throw error;
  }

  return {
    available: true,
    database: {
      name,
      label: target.label,
      url: disposableTarget.url,
      owner,
      connect: async (): Promise<Client> => {
        const client = await openClient(disposableTarget, env);
        extraClients.push(client);
        return client;
      },
      dispose,
    },
  };
}

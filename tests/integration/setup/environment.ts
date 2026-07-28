/**
 * Chargement de l'environnement pour les tests d'intégration de base de données.
 *
 * Pourquoi ce module existe : Vitest n'expose PAS le contenu de `.env.local` dans `process.env`
 * (vérifié par sonde : `DATABASE_URL` y est absente alors que le fichier la définit). Les commandes
 * `npm run db:*` la reçoivent parce que `package.json` les lance avec
 * `--env-file-if-exists=.env.local --env-file-if-exists=.env` ; `npm run test:integration` n'a pas
 * cet équivalent, et `vitest.config.ts` appartient à un autre périmètre. Ce module reproduit donc
 * exactement la même lecture, avec la même priorité.
 *
 * Règle appliquée : l'environnement réel l'emporte toujours sur le fichier. Une intégration
 * continue qui exporte `DATABASE_URL` vise la base qu'elle a choisie, jamais celle d'un fichier
 * local oublié dans l'image. Aucune valeur n'est codée en dur ici, et aucune n'est affichée.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Mêmes fichiers, dans le même ordre de priorité, que les scripts `db:*` de package.json. */
const ENVIRONMENT_FILES = ['.env.local', '.env'] as const;

const COMMENT_PREFIX = '#';
const QUOTES = ['"', "'"] as const;

/** Racine du dépôt, résolue depuis ce module et non depuis le dossier courant du lanceur. */
export function repositoryRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..');
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  const quoted = QUOTES.some((quote) => quote === first) && first === last;
  return quoted ? trimmed.slice(1, -1) : trimmed;
}

/**
 * Lecture volontairement minimale : une clé, un signe égal, une valeur. Les fichiers du dépôt ne
 * contiennent ni valeur multiligne ni substitution, et un analyseur plus riche introduirait ici une
 * divergence de comportement avec `node --env-file`.
 */
function parseEnvironmentFile(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith(COMMENT_PREFIX)) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    values.set(trimmed.slice(0, separator).trim(), unquote(trimmed.slice(separator + 1)));
  }
  return values;
}

/**
 * Environnement effectif des tests : copie de `process.env` complétée par les fichiers du dépôt.
 * Une variable déjà définie et non vide n'est jamais écrasée.
 *
 * Le résultat est une COPIE : `process.env` n'est pas modifié, afin qu'un fichier de test ne puisse
 * pas contaminer les suivants.
 */
export function loadIntegrationEnvironment(): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...process.env };
  for (const file of ENVIRONMENT_FILES) {
    let content: string;
    try {
      content = readFileSync(path.join(repositoryRoot(), file), 'utf8');
    } catch {
      // Fichier absent : cas normal en intégration continue, où les variables viennent du runner.
      continue;
    }
    for (const [key, value] of parseEnvironmentFile(content)) {
      const existing = merged[key];
      if (existing === undefined || existing.trim() === '') {
        merged[key] = value;
      }
    }
  }
  return merged;
}

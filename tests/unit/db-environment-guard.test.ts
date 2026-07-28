import { describe, expect, it } from 'vitest';
import {
  assertResetAllowed,
  assertSeedAllowed,
  EnvironmentGuardError,
} from '../../scripts/db/lib/environment-guard';

/**
 * Garde-fou d'environnement des commandes destructrices (US-002, critère 16).
 *
 * Mise en œuvre de deux exigences : « seed absent de production »
 * (backlog/release-checklist.md) et le refus par défaut de docs/permissions.md, transposé aux
 * comptes techniques. Le point important est qu'une valeur INCONNUE doit être refusée, et non
 * acceptée « faute de mieux » : un environnement mal orthographié dans une variable de déploiement
 * est exactement le cas où un jeu de démonstration atteindrait une base partagée.
 */

const ALLOWED = ['local', 'test'] as const;
const REFUSED = [
  'production',
  'staging',
  'preprod',
  'prod',
  'recette',
  'dev',
  'LOCALHOST',
] as const;

interface Guard {
  readonly name: string;
  readonly assert: (env: Record<string, string | undefined>) => void;
}

const GUARDS: readonly Guard[] = [
  { name: 'db:seed', assert: assertSeedAllowed },
  { name: 'db:reset', assert: assertResetAllowed },
];

/** Capture le refus attendu, ou échoue si la commande a été autorisée. */
function expectRefusal(
  guard: Guard,
  env: Record<string, string | undefined>,
): EnvironmentGuardError {
  try {
    guard.assert(env);
  } catch (error) {
    if (!(error instanceof EnvironmentGuardError)) {
      throw error;
    }
    return error;
  }
  throw new Error(`La commande « ${guard.name} » aurait dû être refusée.`);
}

describe.each(GUARDS)('garde-fou de $name', (guard) => {
  it.each(ALLOWED)('autorise APP_ENV=%s', (environment) => {
    expect(() => guard.assert({ APP_ENV: environment })).not.toThrow();
  });

  it('accepte une casse et des espaces surnuméraires, qui restent la même valeur', () => {
    expect(() => guard.assert({ APP_ENV: '  Local ' })).not.toThrow();
    expect(() => guard.assert({ APP_ENV: 'TEST' })).not.toThrow();
  });

  it.each(REFUSED)('refuse APP_ENV=%s', (environment) => {
    const failure = expectRefusal(guard, { APP_ENV: environment });
    expect(failure.operation).toBe(guard.name);
    // Le message doit nommer la commande, la valeur lue et les valeurs acceptées : un refus sans
    // consigne pousse l'opérateur à chercher le contournement plutôt que la correction.
    expect(failure.message).toContain(guard.name);
    expect(failure.message).toContain(environment.toLowerCase());
    expect(failure.message).toContain('local');
    expect(failure.message).toContain('test');
  });

  it('refuse une variable absente, vide ou blanche : le refus est la règle par défaut', () => {
    for (const env of [{}, { APP_ENV: '' }, { APP_ENV: '   ' }, { APP_ENV: undefined }]) {
      const failure = expectRefusal(guard, env);
      expect(failure.operation).toBe(guard.name);
      expect(failure.message).toContain('APP_ENV');
    }
  });

  it('ne lit rien d’autre que APP_ENV', () => {
    // Aucune autre variable ne doit pouvoir ouvrir la porte : ni NODE_ENV, ni un indicateur ad hoc.
    expectRefusal(guard, {
      APP_ENV: 'production',
      NODE_ENV: 'test',
      CI: 'true',
      FORCE: '1',
      APP_ENVIRONMENT: 'local',
    });
  });
});

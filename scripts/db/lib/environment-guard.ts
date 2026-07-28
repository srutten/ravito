/**
 * Garde-fous des commandes qui modifient massivement les données.
 *
 * Mise en œuvre de deux exigences :
 * - « seed absent de production » (backlog/release-checklist.md) ;
 * - « ne jamais pointer une commande locale, en particulier `npm run db:reset`, vers une base
 *   partagée, de recette ou de production » (README).
 *
 * Le principe appliqué est celui de docs/permissions.md : refus par défaut. Une variable `APP_ENV`
 * absente, vide ou non reconnue interdit l'exécution ; seules les valeurs `local` et `test`
 * l'autorisent. Un avertissement écrit ne serait pas un contrôle : c'est ce refus qui l'est.
 */

export class EnvironmentGuardError extends Error {
  /** Nom de la commande refusée, pour un compte rendu précis côté appelant. */
  readonly operation: string;

  constructor(operation: string, message: string) {
    super(message);
    this.name = 'EnvironmentGuardError';
    this.operation = operation;
  }
}

const ALLOWED_ENVIRONMENTS = ['local', 'test'] as const;
const ALLOWED_LIST = ALLOWED_ENVIRONMENTS.join(' ou ');

function readEnvironment(env: Record<string, string | undefined>): string | undefined {
  const raw = env.APP_ENV;
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed.toLowerCase();
}

function assertOperationAllowed(
  env: Record<string, string | undefined>,
  operation: string,
  consequence: string,
): void {
  const environment = readEnvironment(env);
  if (environment === undefined) {
    throw new EnvironmentGuardError(
      operation,
      `Commande « ${operation} » refusée : APP_ENV est absente ou vide, et le refus est la règle par défaut. ${consequence} Renseigner APP_ENV=${ALLOWED_ENVIRONMENTS[0]} dans .env.local pour un poste de développement.`,
    );
  }
  const allowed = ALLOWED_ENVIRONMENTS.some((candidate) => candidate === environment);
  if (!allowed) {
    throw new EnvironmentGuardError(
      operation,
      `Commande « ${operation} » refusée : APP_ENV vaut « ${environment} », or seules les valeurs ${ALLOWED_LIST} sont autorisées. ${consequence}`,
    );
  }
}

/**
 * Autorise le chargement du jeu de démonstration. Les données de démonstration ne doivent jamais
 * atteindre un environnement partagé : elles y créeraient des organisations et des missions
 * fictives indiscernables des vraies.
 */
export function assertSeedAllowed(env: Record<string, string | undefined>): void {
  assertOperationAllowed(
    env,
    'db:seed',
    'Le jeu de démonstration crée des organisations, des utilisateurs et des missions fictifs : il ne doit jamais être chargé ailleurs que sur un poste de développement ou une base de test jetable.',
  );
}

/**
 * Autorise la remise à zéro. La commande supprime le schéma `public` et tout ce qu'il contient :
 * une exécution accidentelle contre une base partagée est irréversible sans restauration.
 */
export function assertResetAllowed(env: Record<string, string | undefined>): void {
  assertOperationAllowed(
    env,
    'db:reset',
    'Cette commande supprime le schéma public et toutes ses données, sans confirmation ni sauvegarde préalable.',
  );
}

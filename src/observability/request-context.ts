import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';

/**
 * Contexte porté par une requête HTTP et propagé sans paramètre explicite grâce à
 * `AsyncLocalStorage`. Il ne contient que des identifiants exploitables en journal :
 * jamais d'identité en clair, jamais de jeton, jamais de contenu métier.
 */
export interface RequestContext {
  readonly requestId: string;
  readonly route: string;
  readonly method: string;
  readonly startedAt: number;
  readonly userIdHash?: string;
  readonly organizationId?: string;
}

const REQUEST_ID_PREFIX = 'req_';
const USER_HASH_PREFIX = 'usr_';
/** Séparation de domaine : un même identifiant ne produit pas le même condensé ailleurs. */
const HASH_DOMAIN = 'fire-support:user';
/** 128 bits de condensé : assez pour corréler des journaux, sans encombrer une ligne de log. */
const USER_HASH_LENGTH = 32;

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/** Identifiant de requête opaque et non devinable, exposé au client et tracé en journal. */
export function createRequestId(): string {
  return `${REQUEST_ID_PREFIX}${randomUUID()}`;
}

/**
 * Pseudonymise un identifiant utilisateur pour les journaux (docs/observability.md).
 *
 * Le condensé est stable à configuration constante, ce qui permet de suivre un parcours, et
 * non réversible. `AUTH_SECRET` sert de poivre lorsqu'il est disponible : sans lui, un
 * identifiant deviné resterait vérifiable par simple hachage. Conséquence assumée : une
 * rotation du secret change les pseudonymes, donc rompt la corrélation avec les journaux
 * antérieurs, ce qui va dans le sens de la limitation de conservation.
 */
export function pseudonymizeUserId(userId: string): string {
  const pepper = process.env.AUTH_SECRET ?? '';
  const digest = createHash('sha256').update(`${HASH_DOMAIN}:${pepper}:${userId}`).digest('hex');
  return `${USER_HASH_PREFIX}${digest.slice(0, USER_HASH_LENGTH)}`;
}

/** Exécute `run` avec le contexte fourni. Le contexte est restauré à la sortie. */
export function runWithRequestContext<T>(context: RequestContext, run: () => T): T {
  return requestContextStorage.run(context, run);
}

/** Contexte de la requête courante, ou `undefined` hors requête (script, tâche de fond). */
export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

export function getRequestId(): string | undefined {
  return requestContextStorage.getStore()?.requestId;
}

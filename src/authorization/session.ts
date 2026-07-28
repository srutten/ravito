import { cookies } from 'next/headers';
import { AppError } from '@/application/errors';
import { getSessionCookieName, readSessionTokenFromRequest } from '@/authorization/session-cookie';
import { isFeatureEnabled } from '@/config/feature-flags';
import { hashSessionToken } from '@/domain/identity/hashing';
import {
  SESSION_ABSOLUTE_TTL_SECONDS,
  SESSION_IDLE_TTL_SECONDS,
  SESSION_TOUCH_INTERVAL_SECONDS,
} from '@/domain/identity/policy';
import { findValidSessionByTokenHash, touchSession } from '@/domain/identity/repository';
import type { SessionSummary, UserProfileSummary } from '@/domain/identity/types';
import { getExecutor } from '@/infrastructure/identity/unit-of-work';
import { getRequestLogger } from '@/observability/logger';

/**
 * Résolution de la session courante.
 *
 * REFUS PAR DÉFAUT. Toute anomalie — cookie absent, jeton inconnu, session expirée,
 * session révoquée, compte suspendu, erreur de lecture — produit `null`, jamais une
 * session dégradée ni une exception silencieusement ignorée par l'appelant. Les quatre
 * premiers cas partagent d'ailleurs une réponse unique côté API : la validité d'un
 * identifiant de session n'est pas une information que la plateforme confirme
 * (docs/api-contract.md).
 *
 * AUCUN CACHE. `docs/architecture.md` interdit de cacher les autorisations critiques, et
 * la raison est directe : une session mise en cache survivrait à sa propre révocation
 * pendant la durée du cache, c'est-à-dire pendant la fenêtre exacte que la révocation
 * existe pour fermer. Le coût réel est une lecture indexée sur une connexion déjà
 * ouverte.
 */

export interface Session {
  readonly id: string;
  readonly userId: string;
  readonly user: UserProfileSummary;
  readonly session: SessionSummary;
}

/**
 * Session courante, lue depuis le cookie de la requête en cours.
 *
 * Hors contexte de requête — script, tâche de fond, rendu statique — `cookies()` lève.
 * Le cas est traité comme une absence de session : un script n'a pas d'utilisateur, et
 * lui en inventer un serait la pire réponse possible.
 */
export async function getCurrentSession(): Promise<Session | null> {
  let token: string | undefined;
  try {
    const store = await cookies();
    token = store.get(getSessionCookieName())?.value;
  } catch {
    return null;
  }
  return resolveSession(token);
}

/** Session portée par une requête explicite. Utile aux routes et aux intergiciels. */
export async function getSessionFromRequest(request: Request): Promise<Session | null> {
  return resolveSession(readSessionTokenFromRequest(request));
}

/**
 * Session courante, ou refus.
 *
 * C'est la fonction que toute route protégée doit appeler AVANT de lire quoi que ce soit.
 * Masquer un bouton n'est jamais un contrôle d'accès (CLAUDE.md) : un appel direct à la
 * route doit se heurter à cette barrière et à aucune autre.
 */
export async function requireSession(): Promise<Session> {
  const session = await getCurrentSession();
  if (session === null) {
    throw new AppError('UNAUTHENTICATED');
  }
  return session;
}

/** Variante prenant la requête, pour les routes qui l'ont déjà sous la main. */
export async function requireSessionFromRequest(request: Request): Promise<Session> {
  const session = await getSessionFromRequest(request);
  if (session === null) {
    throw new AppError('UNAUTHENTICATED');
  }
  return session;
}

async function resolveSession(token: string | undefined): Promise<Session | null> {
  if (token === undefined || token.length === 0) {
    return null;
  }
  const globalRevocation = readGlobalRevocation();
  if (globalRevocation.mode === 'ALL') {
    return null;
  }

  const executor = getExecutor();
  const tokenHash = hashSessionToken(token);

  let row: Awaited<ReturnType<typeof findValidSessionByTokenHash>>;
  try {
    row = await findValidSessionByTokenHash(executor, tokenHash);
  } catch (error) {
    // Base indisponible : refuser. Laisser passer « le temps que ça revienne »
    // reviendrait à faire d'une panne un contournement d'authentification.
    getRequestLogger().error(
      { err: error, module: 'identity', errorCode: 'SERVICE_UNAVAILABLE' },
      'lecture de session impossible : acces refuse',
    );
    return null;
  }

  if (row === undefined) {
    return null;
  }

  // Comparaison STRICTE, comme pour `sessions_revoked_at` : une session émise à l'instant
  // exact de la révocation est invalide. Dans le doute, on coupe.
  if (
    globalRevocation.mode === 'SINCE' &&
    row.issued_at.getTime() <= globalRevocation.instant.getTime()
  ) {
    return null;
  }

  // Prolongation paresseuse de la fenêtre d'inactivité. L'échec n'invalide pas la
  // session : au pire elle expirera plus tôt que prévu, ce qui est le sens sûr.
  try {
    await touchSession(executor, {
      sessionId: row.id,
      idleTtlSeconds: SESSION_IDLE_TTL_SECONDS,
      absoluteTtlSeconds: SESSION_ABSOLUTE_TTL_SECONDS,
      throttleSeconds: SESSION_TOUCH_INTERVAL_SECONDS,
    });
  } catch (error) {
    getRequestLogger().warn(
      { err: error, module: 'identity' },
      "prolongation de session impossible, la session reste valide jusqu'a son echeance",
    );
  }

  return {
    id: row.id,
    userId: row.user_profile_id,
    user: {
      id: row.user_profile_id,
      displayName: row.display_name,
      preferredLanguage: row.preferred_language,
      verificationLevel: row.verification_level,
    },
    session: {
      id: row.id,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      absoluteExpiresAt: new Date(row.issued_at.getTime() + SESSION_ABSOLUTE_TTL_SECONDS * 1000),
      lastSeenAt: row.last_seen_at,
    },
  };
}

/** Portée de l'interrupteur de révocation globale. */
export type GlobalRevocation =
  | { readonly mode: 'OFF' }
  | { readonly mode: 'ALL' }
  | { readonly mode: 'SINCE'; readonly instant: Date };

/**
 * Interrupteur de révocation globale (`FORCE_SESSION_REVOCATION`, ADR-017).
 *
 * ADR-017 le décrit comme invalidant « toutes les sessions émises avant son activation ».
 * L'instant d'activation n'est porté par aucun stockage : la seule façon honnête de le
 * connaître est que l'exploitation le déclare, par `FORCE_SESSION_REVOCATION_SINCE`, un
 * horodatage ISO 8601.
 *
 * Sans cette date, ou avec une date illisible, TOUTES les sessions sont refusées, y
 * compris celles ouvertes après l'activation. C'est le sens sûr : un interrupteur de
 * sécurité dont on ne sait pas lire la portée doit fermer, pas ouvrir. La conséquence est
 * assumée et doit être connue de l'exploitation, car elle ferme la plateforme à tout le
 * monde.
 *
 * À REPRENDRE HORS PÉRIMÈTRE : la variable `FORCE_SESSION_REVOCATION_SINCE` doit être
 * déclarée dans `.env.example` et sa sémantique inscrite dans `docs/feature-flags.md`.
 */
export function readGlobalRevocation(): GlobalRevocation {
  if (!isFeatureEnabled('FORCE_SESSION_REVOCATION')) {
    return { mode: 'OFF' };
  }
  const raw = process.env.FORCE_SESSION_REVOCATION_SINCE?.trim();
  if (raw === undefined || raw.length === 0) {
    return { mode: 'ALL' };
  }
  const instant = new Date(raw);
  if (Number.isNaN(instant.getTime())) {
    getRequestLogger().error(
      { module: 'identity', errorCode: 'UNAUTHENTICATED' },
      'FORCE_SESSION_REVOCATION_SINCE illisible : toutes les sessions sont refusees',
    );
    return { mode: 'ALL' };
  }
  return { mode: 'SINCE', instant };
}

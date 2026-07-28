import { getServerConfig } from '@/config/env';
import { SESSION_ABSOLUTE_TTL_SECONDS } from '@/domain/identity/policy';

/**
 * Cookie de session (ADR-017).
 *
 * CINQ ATTRIBUTS, CINQ RAISONS.
 *
 * - `HttpOnly` : le JavaScript de la page ne lit jamais le jeton. Une injection de script
 *   dans une page ne suffit alors plus à voler la session, elle oblige l'attaquant à
 *   agir depuis le navigateur de la victime, ce qui est bruyant et borné dans le temps.
 * - `Secure` : le cookie n'est jamais émis en clair. Retiré en local UNIQUEMENT, où le
 *   serveur est en HTTP et où le navigateur rejetterait silencieusement le cookie — un
 *   rejet silencieux se diagnostique très mal.
 * - `SameSite=Lax` : première ligne contre le CSRF exigé par docs/security.md. Elle ne
 *   suffit pas seule : la vérification d'origine sur les méthodes non sûres reste à la
 *   charge des routes.
 * - `Path=/` : la session vaut pour toute l'application.
 * - Préfixe `__Host-` : le navigateur refuse alors tout cookie de ce nom qui ne serait
 *   pas `Secure`, en `Path=/` et sans `Domain`. Conséquence concrète : un sous-domaine
 *   compromis ne peut pas écraser la session du domaine principal. Le préfixe impose
 *   `Secure`, il est donc retiré en même temps que lui sur le poste local.
 *
 * PAS DE `Max-Age`, PAS D'`Expires` sur le cookie de connexion : le cookie est de
 * session. La durée de vie qui fait foi est celle portée par la ligne en base, la seule
 * qu'un administrateur puisse raccourcir après coup. Un cookie persistant survivrait à
 * une réduction de durée décidée pendant un incident.
 */

const BASE_COOKIE_NAME = 'appui_feux_session';
const HOST_PREFIXED_COOKIE_NAME = `__Host-${BASE_COOKIE_NAME}`;

function isLocalEnvironment(): boolean {
  try {
    return getServerConfig().appEnvironment === 'local';
  } catch {
    // Configuration illisible : on suppose un environnement déployé, donc les attributs
    // les plus stricts. Le défaut sûr est de refuser un cookie, pas d'en accepter un.
    return false;
  }
}

/**
 * Nom du cookie, dépendant de l'environnement. Le préfixe `__Host-` n'a de sens qu'avec
 * `Secure` ; conserver le même nom partout obligerait à trancher entre un cookie rejeté
 * en local et une protection perdue en production.
 */
export function getSessionCookieName(): string {
  return isLocalEnvironment() ? BASE_COOKIE_NAME : HOST_PREFIXED_COOKIE_NAME;
}

/** Attributs du cookie, exposés pour les routes qui préfèrent l'API `cookies()` de Next. */
export interface SessionCookieAttributes {
  readonly name: string;
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: 'lax';
  readonly path: '/';
}

export function getSessionCookieAttributes(): SessionCookieAttributes {
  return {
    name: getSessionCookieName(),
    httpOnly: true,
    secure: !isLocalEnvironment(),
    sameSite: 'lax',
    path: '/',
  };
}

/**
 * En-tête `Set-Cookie` posant la session.
 *
 * Le jeton est inséré tel quel : il est produit par `createSessionToken`, encodé en
 * base64url, donc dépourvu de tout caractère nécessitant un échappement. Un
 * `encodeURIComponent` de plus rendrait la lecture et l'écriture asymétriques si l'une
 * des deux venait à l'oublier.
 */
export function buildSessionCookie(token: string): string {
  const attributes = getSessionCookieAttributes();
  const parts = [`${attributes.name}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (attributes.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/**
 * En-tête `Set-Cookie` effaçant la session.
 *
 * Les attributs sont répétés à l'identique : un navigateur n'efface un cookie que si le
 * nom, le chemin et le domaine correspondent. Un effacement aux attributs approximatifs
 * laisse le cookie en place tout en donnant l'impression d'avoir déconnecté.
 */
export function buildClearedSessionCookie(): string {
  const attributes = getSessionCookieAttributes();
  const parts = [
    `${attributes.name}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (attributes.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/**
 * Extrait le jeton de session d'un en-tête `Cookie`.
 *
 * L'analyse est délibérément littérale : découpage sur `;`, puis sur le premier `=`. Le
 * nom recherché est celui de l'environnement courant, et lui seul — accepter les deux
 * noms « au cas où » permettrait de présenter en production un cookie sans préfixe
 * `__Host-`, donc de contourner la protection que ce préfixe apporte.
 */
export function readSessionTokenFromCookieHeader(header: string | null): string | undefined {
  if (header === null || header.length === 0) {
    return undefined;
  }
  const expected = getSessionCookieName();
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    if (part.slice(0, separator).trim() !== expected) {
      continue;
    }
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

/** Jeton porté par une requête, ou `undefined`. */
export function readSessionTokenFromRequest(request: Request): string | undefined {
  return readSessionTokenFromCookieHeader(request.headers.get('cookie'));
}

/**
 * Borne maximale de conservation côté navigateur, en secondes. Exposée pour les appelants
 * qui utiliseraient un cookie persistant ; le cookie de session n'en pose pas.
 */
export const SESSION_COOKIE_MAX_AGE_SECONDS = SESSION_ABSOLUTE_TTL_SECONDS;

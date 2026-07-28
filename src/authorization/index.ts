/**
 * Surface publique de l'autorisation.
 *
 * `requireSession` est la barrière. Une route protégée l'appelle en premier, avant toute
 * lecture et avant toute écriture. Masquer un bouton n'est jamais un contrôle d'accès
 * (CLAUDE.md) : un appel direct à la route doit se heurter à cette fonction.
 *
 * Ce module ne porte AUCUNE vérification de rôle ni d'appartenance à une organisation, et
 * l'omission est délibérée : `OrganizationMember` n'existe pas au lot 1. Exposer un
 * `requireRole` qui renverrait toujours vrai serait pire que son absence — un contrôle
 * d'accès qui ne contrôle rien est un contrôle qu'on cesse de vérifier. Il arrive avec
 * US-012 et US-014.
 */

export type { GlobalRevocation, Session } from '@/authorization/session';
export {
  getCurrentSession,
  getSessionFromRequest,
  readGlobalRevocation,
  requireSession,
  requireSessionFromRequest,
} from '@/authorization/session';

export type { SessionCookieAttributes } from '@/authorization/session-cookie';
export {
  buildClearedSessionCookie,
  buildSessionCookie,
  getSessionCookieAttributes,
  getSessionCookieName,
  readSessionTokenFromCookieHeader,
  readSessionTokenFromRequest,
} from '@/authorization/session-cookie';

/**
 * Surface publique de l'autorisation.
 *
 * DEUX BARRIÈRES, DANS CET ORDRE, ET AUCUNE NE REMPLACE L'AUTRE.
 *
 * 1. `requireSession` — qui est l'appelant ? Une route protégée l'appelle en premier,
 *    avant toute lecture et avant toute écriture. Masquer un bouton n'est jamais un
 *    contrôle d'accès (CLAUDE.md) : un appel direct à la route doit se heurter à cette
 *    fonction.
 * 2. `resolveOrganizationAccess` et ses gardes — qu'est cet appelant DANS CETTE
 *    organisation, à cet instant ? Une session valide ne dit rien du rôle : elle prouve
 *    l'identité, pas l'habilitation.
 *
 * La seconde barrière est arrivée avec US-012. Elle solde le point ouvert laissé par
 * US-010 : une adhésion suspendue ou expirée coupe désormais l'accès aux données de
 * l'organisation dès la requête suivante, sans attendre l'expiration de la session
 * (`docs/permissions.md`, « accès après suspension » ; supabase/README.md, « Ce qui rend un
 * rôle effectif »).
 *
 * AUCUNE DES DEUX N'EST MISE EN CACHE (ADR-021, `docs/architecture.md`). Une autorisation
 * cachée survit à sa propre révocation pendant la durée du cache, c'est-à-dire pendant la
 * fenêtre exacte que la révocation existe pour fermer.
 */

export type { OrganizationAccess } from '@/authorization/organization-access';
export {
  assertOrganizationActive,
  assertOrganizationRole,
  assertOrganizationVerified,
  assertOrganizationVisible,
  resolveOrganizationAccess,
  toMembershipView,
} from '@/authorization/organization-access';
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

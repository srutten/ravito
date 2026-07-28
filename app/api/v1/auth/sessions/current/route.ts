import { buildClearedSessionCookie, readSessionTokenFromRequest } from '@/authorization';
import { signOut } from '@/domain/identity';
import {
  defineAuthenticatedRoute,
  definePublicAuthRoute,
  emptyResponse,
  jsonResponse,
} from '../../_shared/auth-route';

/**
 * `GET|DELETE /api/v1/auth/sessions/current` — lire la session courante, se déconnecter.
 *
 * DEUX MÉTHODES, DEUX RÉGIMES OPPOSÉS, ET C'EST VOULU.
 *
 * `GET` est protégé au sens strict : sans session valide, `UNAUTHENTICATED`. Cookie absent,
 * inconnu, expiré ou révoqué partagent cette réponse unique — la validité d'un identifiant de
 * session n'est pas une information que la plateforme confirme (docs/api-contract.md).
 *
 * `DELETE` répond `204` en toutes circonstances, y compris sans session valide, et EFFACE LE
 * COOKIE dans tous les cas. Répondre `401` laisserait une session vivante sur un poste partagé au
 * motif que l'appelant n'a pas su prouver qu'elle lui appartenait : exactement l'inverse du
 * service rendu. Cette route n'est pas pour autant une mutation ouverte — `signOut` ne révoque que
 * la session dont le jeton est présenté, une valeur inventée ne révoque rien, et rien n'est écrit
 * dans le journal d'audit dans ce cas, faute de quoi un appelant non authentifié pourrait faire
 * grossir la table de preuve à volonté.
 */

export const dynamic = 'force-dynamic';

export const GET = defineAuthenticatedRoute(async ({ session }) =>
  jsonResponse(
    {
      user: {
        id: session.user.id,
        displayName: session.user.displayName,
        preferredLanguage: session.user.preferredLanguage,
      },
      session: {
        issuedAt: session.session.issuedAt.toISOString(),
        expiresAt: session.session.expiresAt.toISOString(),
        absoluteExpiresAt: session.session.absoluteExpiresAt.toISOString(),
      },
    },
    { status: 200 },
  ),
);

export const DELETE = definePublicAuthRoute(async ({ request, origin }) => {
  // Aucun corps n'est lu : le contrat le dit sans corps, et exiger `application/json` ferait
  // échouer une déconnexion pour une raison de format, ce qu'aucune déconnexion ne doit faire.
  await signOut({ sessionToken: readSessionTokenFromRequest(request), origin });
  return emptyResponse(204, buildClearedSessionCookie());
});

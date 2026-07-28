import { z } from 'zod';
import { buildClearedSessionCookie } from '@/authorization';
import { revokeAllSessions } from '@/domain/identity';
import { defineAuthenticatedRoute, jsonResponse, readJsonBody } from '../../../_shared/auth-route';

/**
 * `POST /api/v1/auth/sessions/commands/revoke-all` — révoquer toutes ses sessions.
 *
 * L'IDENTITÉ VISÉE VIENT DE LA SESSION, JAMAIS DU CORPS. Aucun `userId` n'est accepté en entrée :
 * un identifiant de compte fourni par le client transformerait cette route en déconnexion forcée
 * d'autrui, c'est-à-dire en déni de service ciblé sur un coordinateur en pleine opération. La
 * révocation par un administrateur est une autre commande, avec ses propres contrôles (US-093).
 *
 * LA SESSION COURANTE EST COMPRISE dans la révocation : l'appelant se déconnecte par sa propre
 * commande, et le cookie est effacé par cette réponse. C'est la mise en œuvre côté utilisateur de
 * la révocation immédiate exigée au critère 11. Laisser vivre la session courante serait un
 * contresens : la commande existe pour le cas où l'on soupçonne qu'un tiers détient un accès, et
 * on ne sait pas laquelle des sessions ouvertes est celle du tiers.
 *
 * Le rejeu portant le même `clientEventId` renvoie la réponse initiale sans nouvel effet, avec la
 * limite documentée par le domaine (idempotence adossée au journal d'audit).
 */

export const dynamic = 'force-dynamic';

const revokeAllBodySchema = z.strictObject({
  clientEventId: z.unknown(),
});

export const POST = defineAuthenticatedRoute(async ({ request, origin, session }) => {
  const body = revokeAllBodySchema.parse(await readJsonBody(request));
  const result = await revokeAllSessions({
    userId: session.userId,
    clientEventId: body.clientEventId,
    origin,
  });
  return jsonResponse(
    { revokedCount: result.revokedCount },
    { status: 200, setCookie: buildClearedSessionCookie() },
  );
});

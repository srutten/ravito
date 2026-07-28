import { z } from 'zod';
import { buildSessionCookie } from '@/authorization';
import { verifySignInCode } from '@/domain/identity';
import { definePublicAuthRoute, jsonResponse, readJsonBody } from '../_shared/auth-route';

/**
 * `POST /api/v1/auth/sessions` — échanger un code contre une session. Route PUBLIQUE.
 *
 * LE JETON NE SORT QUE PAR LE COOKIE. `verifySignInCode` renvoie `sessionToken` ; cette route le
 * pose dans `Set-Cookie` et n'en fait rien d'autre. Il n'entre ni dans le corps de la réponse, ni
 * dans un journal, ni dans une trace : un jeton lisible par le JavaScript de la page ou par
 * quiconque consulte les journaux annulerait l'intérêt de `HttpOnly` (ADR-017).
 *
 * LE CORPS NE PORTE NI RÔLE NI ORGANISATION, et ce n'est pas un oubli : `OrganizationMember`
 * n'existe pas au lot 1, exposer un champ vide laisserait croire qu'il est renseigné
 * (docs/api-contract.md). `redirectPath` est calculé par le serveur, jamais choisi par le client
 * (ADR-016) : c'est le point d'extension où US-014 branchera la résolution du rôle.
 *
 * `verificationLevel` est connu du domaine mais n'est PAS renvoyé : le contrat ne l'expose pas et
 * la minimisation de `docs/privacy-rgpd.md` interdit d'ajouter un attribut de compte à une
 * réponse qui n'en a pas besoin.
 */

export const dynamic = 'force-dynamic';

/**
 * Objet strict, même raison que sur la demande de code : aucun mot de passe, aucun rôle, aucun
 * identifiant d'organisation ne peut entrer par cette porte, même à titre facultatif.
 *
 * Les deux champs restent `unknown` : le domaine les valide et distingue `challengeId` de `code`
 * dans `details.fields`, ce dont l'écran a besoin pour désigner le bon champ.
 */
const openSessionBodySchema = z.strictObject({
  challengeId: z.unknown(),
  code: z.unknown(),
});

export const POST = definePublicAuthRoute(async ({ request, origin }) => {
  const body = openSessionBodySchema.parse(await readJsonBody(request));
  const result = await verifySignInCode({
    challengeId: body.challengeId,
    code: body.code,
    origin,
  });

  return jsonResponse(
    {
      user: {
        id: result.user.id,
        displayName: result.user.displayName,
        preferredLanguage: result.user.preferredLanguage,
      },
      session: {
        expiresAt: result.session.expiresAt.toISOString(),
        absoluteExpiresAt: result.session.absoluteExpiresAt.toISOString(),
      },
      nextStep: result.nextStep,
      redirectPath: result.redirectPath,
    },
    { status: 201, setCookie: buildSessionCookie(result.sessionToken) },
  );
});

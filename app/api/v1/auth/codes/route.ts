import { z } from 'zod';
import { requestSignInCode } from '@/domain/identity';
import { definePublicAuthRoute, jsonResponse, readJsonBody } from '../_shared/auth-route';

/**
 * `POST /api/v1/auth/codes` — demander un code à usage unique. Route PUBLIQUE.
 *
 * TOUT CE QUI COMPTE ICI EST DE NE RIEN DIRE. La réponse est `202` avec la même forme et les
 * mêmes valeurs, que l'identifiant corresponde ou non à un compte : mêmes constantes de
 * plateforme, même `challengeId` opaque, même durée. C'est le critère 7 de US-010, et la
 * mécanique qui le tient — défi créé dans les deux cas, envoi jamais attendu, plancher de durée
 * commun — appartient au domaine. La route n'a donc qu'une obligation, ne pas la défaire : ni
 * branche, ni champ conditionnel, ni statut différent.
 *
 * `202` et non `200` : le serveur accepte la demande, il ne garantit pas la remise. L'échec
 * d'envoi ne change pas la réponse (docs/api-contract.md).
 */

export const dynamic = 'force-dynamic';

/**
 * Objet STRICT : une clé inconnue est refusée. C'est la mise en œuvre littérale de la règle
 * commune du contrat — « aucune de ces routes n'accepte de mot de passe, ni en entrée, ni en
 * option ». Un client qui enverrait `password` obtient `VALIDATION_ERROR` au lieu de voir son
 * champ silencieusement ignoré, ce qui laisserait croire qu'il a été pris en compte.
 *
 * `identifier` reste `unknown` à dessein : la validation de forme et la normalisation
 * appartiennent au domaine, qui seul sait produire le motif de refus exploitable par l'écran
 * (`details.reason`). Dupliquer ici un schéma d'adresse ferait diverger les deux verdicts.
 */
const requestCodeBodySchema = z.strictObject({
  identifier: z.unknown(),
});

export const POST = definePublicAuthRoute(async ({ request, origin }) => {
  const body = requestCodeBodySchema.parse(await readJsonBody(request));
  const result = await requestSignInCode({ identifier: body.identifier, origin });
  return jsonResponse(result, { status: 202 });
});

import { createOrganization } from '@/domain/organizations';
import { getRequestLogger } from '@/observability/logger';
import {
  defineOrganizationRoute,
  jsonResponse,
  readJsonBody,
  toMembershipBody,
  toOrganizationBody,
} from './_shared/organization-route';

/**
 * `POST /api/v1/organizations` — créer une organisation en attente de validation (US-012).
 *
 * LA ROUTE NE VALIDE RIEN ET N'AUTORISE RIEN, ET CE N'EST PAS UNE ÉCONOMIE. Elle résout la
 * session, lit le corps, appelle la commande. Tout le reste — schéma, refus des champs
 * inconnus, réservation d'idempotence, création de l'adhésion `ORG_ADMIN`, audit, outbox,
 * `PLATFORM_READ_ONLY` — vit dans la transaction du domaine. C'est ce qui rend impossible
 * d'ouvrir un second chemin d'écriture qui oublierait une garde : une console
 * d'administration, une reprise de données ou un import appelleront la même commande et
 * subiront les mêmes contrôles, sans qu'il faille penser à les recopier.
 *
 * LE CORPS PART BRUT VERS LE DOMAINE. Le typer ici perdrait la distinction entre un champ
 * ABSENT et un champ à `null`, indiscernables une fois passés par un type TypeScript, et
 * dupliquerait un schéma qui divergerait tôt ou tard de celui qui décide. Le domaine refuse
 * d'ailleurs les clés inconnues plutôt que de les ignorer : un client qui enverrait
 * `"verificationStatus": "VERIFIED"` et recevrait `201` croirait avoir été entendu, et c'est
 * exactement l'usurpation d'organisation que `docs/threat-model.md` range parmi les menaces
 * prioritaires.
 *
 * `201` DANS LES DEUX CAS, REJEU COMPRIS. `docs/api-contract.md` : « un rejeu portant le même
 * clientEventId renvoie la réponse initiale à l'identique, statut 201 compris. Le client qui a
 * perdu la première réponse n'a pas à distinguer deux cas. » `replayed` ne sort donc pas dans
 * le corps ; il alimente la ligne de journal et les métriques de rejeu de
 * `docs/observability.md`.
 *
 * AUCUNE JOURNALISATION DU CORPS, ET SURTOUT PAS DE `registrationNumber`. Le numéro
 * d'immatriculation d'une structure tierce n'a rien à faire dans les journaux
 * d'exploitation, où il serait lisible par des rôles qui n'y ont pas accès dans
 * l'application. La ligne ci-dessous ne porte que l'identifiant produit et le drapeau de
 * rejeu.
 */

export const dynamic = 'force-dynamic';

export const POST = defineOrganizationRoute(async ({ request, origin, session }) => {
  const payload = await readJsonBody(request);

  const result = await createOrganization({
    actorUserId: session.userId,
    payload,
    origin,
  });

  getRequestLogger().info(
    {
      module: 'organizations',
      organizationId: result.organization.id,
      replayed: result.replayed,
    },
    result.replayed
      ? 'creation d organisation rejouee : aucune nouvelle organisation'
      : 'organisation creee, en attente de validation',
  );

  return jsonResponse(
    {
      organization: toOrganizationBody(result.organization),
      membership: toMembershipBody(result.membership),
      nextStep: result.nextStep,
    },
    { status: 201 },
  );
});

import { readOrganization, updateOrganizationIdentity } from '@/domain/organizations';
import {
  defineOrganizationRoute,
  jsonResponse,
  readJsonBody,
  readOrganizationIdFromPath,
  toMembershipBody,
  toOrganizationBody,
} from '../_shared/organization-route';

/**
 * `GET` et `PATCH /api/v1/organizations/{organizationId}` (US-012).
 *
 * DEUX MÉTHODES, DEUX RÉGIMES DE REFUS, ET L'ASYMÉTRIE EST CELLE DU CONTRAT.
 *
 * En LECTURE, un appelant qui n'est ni membre effectif ni administrateur plateforme reçoit
 * `NOT_FOUND`, jamais `FORBIDDEN`. Répondre `403` confirmerait que l'identifiant désigne une
 * organisation existante : parcourir des identifiants suffirait alors à dresser la liste des
 * structures enregistrées, ce qui prépare exactement l'usurpation d'organisation de
 * `docs/threat-model.md`. Le journal technique, lui, conserve le motif réel, pour que
 * l'exploitation distingue les deux cas que l'appelant ne distingue pas.
 *
 * En MODIFICATION, un membre dont le rôle ne convient pas reçoit `FORBIDDEN` : à ce stade il
 * sait déjà que l'organisation existe, puisqu'il en est membre. Un non-membre reçoit
 * `NOT_FOUND`, même règle qu'en lecture.
 *
 * LES DEUX DÉCISIONS SONT PRISES DANS LA TRANSACTION QUI LIT OU QUI ÉCRIT (ADR-021), jamais
 * ici. La route ne connaît ni rôle, ni adhésion, ni version : elle n'a donc aucune garde à
 * oublier. Une adhésion suspendue ferme l'accès dès la requête suivante, sans attendre
 * l'expiration de la session — c'est le critère 12 laissé en suspens par US-010.
 *
 * `PATCH` EST SOUMISE À `PLATFORM_READ_ONLY`, `GET` NON. Pendant un incident, consulter une
 * organisation peut être nécessaire ; en renommer une ne l'est jamais. La garde est portée
 * par la commande de domaine, en première instruction.
 */

export const dynamic = 'force-dynamic';

export const GET = defineOrganizationRoute(async ({ request, session }) => {
  const result = await readOrganization({
    actorUserId: session.userId,
    organizationId: readOrganizationIdFromPath(request),
  });

  return jsonResponse(
    {
      organization: toOrganizationBody(result.organization),
      membership: toMembershipBody(result.membership),
    },
    { status: 200 },
  );
});

/**
 * Modification de l'identité.
 *
 * `expectedVersion` est obligatoire et vérifié par la commande, pas ici. Deux administrateurs
 * de la même organisation qui corrigent la même fiche depuis deux postes ne se voient pas
 * l'un l'autre : sans version attendue, le dernier écrivain gagne et la modification de
 * l'autre disparaît sans message ni trace. Sur des champs qui portent l'identité de la
 * structure, cet écrasement silencieux produit une fiche qui affiche autre chose que ce que
 * son administrateur croit avoir enregistré, et sur laquelle un administrateur plateforme
 * fondera pourtant sa décision.
 *
 * `verificationReset` sort dans le corps parce que l'écran doit pouvoir le DIRE : une
 * organisation validée dont on change le nom repart en file d'attente, et ne pas l'annoncer
 * laisserait son administrateur croire qu'il peut continuer à publier.
 */
export const PATCH = defineOrganizationRoute(async ({ request, origin, session }) => {
  const payload = await readJsonBody(request);

  const result = await updateOrganizationIdentity({
    actorUserId: session.userId,
    organizationId: readOrganizationIdFromPath(request),
    payload,
    origin,
  });

  return jsonResponse(
    {
      organization: toOrganizationBody(result.organization),
      membership: toMembershipBody(result.membership),
      verificationReset: result.verificationReset,
    },
    { status: 200 },
  );
});

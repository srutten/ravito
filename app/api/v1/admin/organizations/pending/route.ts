import { AppError } from '@/application/errors';
import { listPendingOrganizations } from '@/domain/organizations';
import {
  defineOrganizationRoute,
  jsonResponse,
} from '../../../organizations/_shared/organization-route';

/**
 * `GET /api/v1/admin/organizations/pending` — file des organisations en attente (US-012).
 *
 * RÉSERVÉE À `PLATFORM_ADMIN`, et le refus est `FORBIDDEN`, non `NOT_FOUND`. La différence
 * avec la lecture d'une organisation est assumée : lire une organisation par son identifiant
 * peut confirmer une existence à qui n'a rien à y voir, donc ouvrir un oracle d'énumération ;
 * ici il n'y a aucune existence à dissimuler, seulement une fonction à refuser. L'adresse
 * elle-même est publiquement documentée par `docs/api-contract.md` — un `404` ne cacherait
 * rien que le document ne dise déjà.
 *
 * ORDRE : DU PLUS ANCIEN AU PLUS RÉCENT. Une file de validation triée par nouveauté laisse au
 * fond celles que personne n'a traitées, c'est-à-dire précisément celles qui attendent depuis
 * le plus longtemps.
 *
 * CE QUE LA RÉPONSE NE PORTE PAS : ni courriel, ni téléphone, ni pièce jointe, ni
 * identifiant de compte du demandeur — seulement son nom d'affichage. Vérifier un numéro
 * d'immatriculation ne suppose pas de joindre le demandeur, et la minimisation de
 * `docs/privacy-rgpd.md` vaut pour un écran d'administration comme pour les autres.
 *
 * `totalCount` EST UN AJOUT AU CORPS D'EXEMPLE DU CONTRAT, exigé par `docs/screens.md` :
 * « le compteur affiché à côté du titre est le nombre réel d'organisations en attente, sans
 * plafonnement ». Le déduire de `items.length` le plafonnerait à la taille d'une page,
 * c'est-à-dire produirait le compteur qui s'arrête à « 99+ » que le document interdit.
 *
 * AUCUNE COMMANDE DE VALIDATION ICI. Le bouton de validation, le refus motivé et la
 * notification associée relèvent d'US-013. La file rend donc visible ce qui attend sans encore
 * permettre de le traiter — préférable à l'inverse.
 */

export const dynamic = 'force-dynamic';

/** Longueur maximale acceptée pour le paramètre de curseur, avant toute analyse. */
const MAX_CURSOR_PARAMETER_LENGTH = 512;

/**
 * Curseur de pagination, lu dans la chaîne de requête.
 *
 * La borne est posée AVANT le domaine : `defineRoute` limite la taille du CORPS, pas celle de
 * l'URL, et un paramètre démesuré n'a pas à traverser une validation de schéma pour être
 * refusé. Sa forme, elle, est validée par le domaine, qui seul sait ce qu'un curseur encode.
 */
function readCursor(request: Request): string | undefined {
  let raw: string | null;
  try {
    raw = new URL(request.url).searchParams.get('cursor');
  } catch {
    return undefined;
  }
  if (raw === null || raw.length === 0) {
    return undefined;
  }
  if (raw.length > MAX_CURSOR_PARAMETER_LENGTH) {
    throw new AppError('VALIDATION_ERROR', { details: { fields: ['cursor'] } });
  }
  return raw;
}

export const GET = defineOrganizationRoute(async ({ request, session }) => {
  const cursor = readCursor(request);

  const result = await listPendingOrganizations({
    actorUserId: session.userId,
    ...(cursor !== undefined ? { cursor } : {}),
  });

  return jsonResponse(
    {
      items: result.items.map((item) => ({
        id: item.id,
        name: item.name,
        type: item.type,
        registrationNumber: item.registrationNumber,
        territoryCode: item.territoryCode,
        createdAt: item.createdAt.toISOString(),
        requestedBy: { displayName: item.requestedByDisplayName },
      })),
      nextCursor: result.nextCursor,
      totalCount: result.totalCount,
    },
    { status: 200 },
  );
});

import type { MembershipView, OrganizationView } from '@/domain/organizations';
import { defineAuthenticatedRoute } from '../../auth/_shared/auth-route';

/**
 * Enveloppe et projections communes aux routes d'organisation (`docs/api-contract.md`).
 *
 * POURQUOI CE MODULE RÉUTILISE L'ENVELOPPE DES ROUTES D'AUTHENTIFICATION plutôt que d'en
 * écrire une seconde. `app/api/v1/auth/_shared/auth-route.ts` porte quatre contrôles que les
 * règles communes du contrat imposent AUSSI aux routes d'organisation : origine reconnue sur
 * les méthodes non sûres, corps strictement `application/json`, réponses jamais mises en
 * cache, barrière de session résolue AVANT toute lecture. Les récrire ici produirait deux
 * implémentations d'un même contrôle de sécurité, et la seconde divergerait de la première au
 * premier correctif appliqué à une seule des deux. Ce module n'ajoute donc rien à
 * l'enveloppe : il la renomme pour que le point d'entrée des routes d'organisation soit
 * lisible, et il porte les projections de réponse.
 *
 * REPRISE À FAIRE, HORS PÉRIMÈTRE DE CETTE STORY. Le module partagé s'appelle « auth-route »
 * et vit sous `auth/_shared/` pour des raisons historiques : il a été livré par US-010, quand
 * seules les routes d'authentification existaient. Sa place est `app/api/v1/_shared/`, sous un
 * nom qui ne parle plus d'authentification. Le déplacement est mécanique et sans effet de
 * bord ; il n'a pas été fait ici parce qu'il toucherait cinq routes hors périmètre.
 *
 * PAS DE GARDE `PLATFORM_READ_ONLY` À CE NIVEAU, ET C'EST RAISONNÉ. `assertPlatformWritable`
 * est déjà appliquée par `createOrganization` et `updateOrganizationIdentity`, en première
 * instruction, avant toute analyse. La poser en plus ici ne coûterait rien mais ferait croire
 * que c'est la route qui protège, alors que la protection doit tenir pour TOUT chemin
 * d'écriture — commande d'administration, reprise de données, tâche planifiée — dont aucun ne
 * passe par cette enveloppe.
 */

/** Route d'organisation : session obligatoire, origine vérifiée, réponse non mise en cache. */
export const defineOrganizationRoute = defineAuthenticatedRoute;

export { jsonResponse, readJsonBody } from '../../auth/_shared/auth-route';

/**
 * Identifiant d'organisation lu dans le chemin.
 *
 * POURQUOI PAS `params`. `defineRoute` (`src/application/api-route.ts`) n'expose que la
 * requête à son gestionnaire : le second argument des gestionnaires de Next, qui porte les
 * segments dynamiques, ne lui est pas transmis. Étendre sa signature relève de
 * `src/application/`, hors du périmètre de cette story. Le chemin de la requête porte
 * exactement la même information et vient de la même source — l'appelant — donc aucune
 * confiance supplémentaire n'est accordée en le lisant ici.
 *
 * AUCUNE VALIDATION ICI, ET C'EST VOULU. La valeur repart brute vers le domaine, qui la
 * valide comme n'importe quelle entrée externe : `parseOrganizationId` refuse par `NOT_FOUND`
 * ce qui n'est pas un UUID. Valider en double dans la route ferait diverger les deux verdicts
 * le jour où l'un des deux changerait, et un identifiant mal formé deviendrait
 * `VALIDATION_ERROR` d'un côté et `NOT_FOUND` de l'autre selon le chemin emprunté.
 *
 * Une URL illisible produit une chaîne vide, que le domaine refuse : la route ne devine pas
 * ce que l'appelant a voulu dire.
 */
export function readOrganizationIdFromPath(request: Request): string {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return '';
  }
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  const last = segments.at(-1) ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    // Séquence d'échappement invalide : la valeur est rendue telle quelle, le domaine refuse.
    return last;
  }
}

/**
 * Organisation, projetée vers le corps de réponse.
 *
 * LES HORODATAGES SORTENT EN ISO 8601 UTC, explicitement et non par la sérialisation
 * implicite de `JSON.stringify`. Le contrat les impose sous cette forme ; s'en remettre au
 * comportement par défaut ferait dépendre le format d'un détail du moteur, et un objet dont
 * on changerait le type — d'une `Date` à une chaîne déjà formatée — sortirait un jour sous
 * une autre forme sans qu'aucun test de route ne s'en aperçoive.
 */
export interface OrganizationBody {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly registrationNumber: string;
  readonly territoryCode: string | null;
  readonly verificationStatus: string;
  readonly status: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MembershipBody {
  readonly role: string;
  readonly status: string;
  readonly validFrom: string;
  readonly validUntil: string | null;
}

export function toOrganizationBody(organization: OrganizationView): OrganizationBody {
  return {
    id: organization.id,
    name: organization.name,
    type: organization.type,
    registrationNumber: organization.registrationNumber,
    territoryCode: organization.territoryCode,
    verificationStatus: organization.verificationStatus,
    status: organization.status,
    version: organization.version,
    createdAt: organization.createdAt.toISOString(),
    updatedAt: organization.updatedAt.toISOString(),
  };
}

/**
 * Adhésion de l'appelant, ou `null`.
 *
 * `null` n'est pas une absence de réponse : il dit qu'un administrateur plateforme accède à
 * une organisation dont il n'est pas membre. Le champ décrit ce que l'appelant EST dans cette
 * organisation, pas ce qui lui donne accès.
 */
export function toMembershipBody(membership: MembershipView | null): MembershipBody | null {
  if (membership === null) {
    return null;
  }
  return {
    role: membership.role,
    status: membership.status,
    validFrom: membership.validFrom.toISOString(),
    validUntil: membership.validUntil?.toISOString() ?? null,
  };
}

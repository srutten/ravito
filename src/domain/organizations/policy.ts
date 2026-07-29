import { AppError } from '@/application/errors';
import { isFeatureEnabled } from '@/config/feature-flags';
import type { OrganizationMemberRole } from '@/domain/organizations/types';

/**
 * Constantes et interrupteurs du module organisations.
 *
 * Elles vivent ici plutôt que dispersées dans les commandes pour qu'une question du type
 * « qui peut modifier une organisation ? » se réponde par une lecture, et non par une
 * recherche dans plusieurs fichiers.
 */

/**
 * Code d'opération réservé dans `idempotency_keys`. Il entre dans l'empreinte de requête :
 * la même clé présentée pour une autre commande produit donc `IDEMPOTENCY_CONFLICT`.
 */
export const ORGANIZATION_CREATE_OPERATION = 'ORGANIZATION_CREATE';

/**
 * Rôle de l'adhésion créée en même temps que l'organisation.
 *
 * Le créateur devient administrateur de l'organisation qu'il crée, sans que le client
 * puisse le demander ni le refuser (ADR-016). Une organisation sans administrateur serait
 * une fiche que personne ne peut corriger, donc une entrée définitivement bloquée dans la
 * file de validation.
 */
export const INITIAL_MEMBER_ROLE: OrganizationMemberRole = 'ORG_ADMIN';

/**
 * Rôles admis pour modifier une fiche d'organisation (`docs/api-contract.md`).
 *
 * LISTE ÉNUMÉRÉE, JAMAIS UNE COMPARAISON. L'ordre du type énuméré n'est pas une hiérarchie :
 * `OBSERVER` y figure en dernier et reste le rôle le moins capable. La fonction
 * d'administrateur plateforme est traitée à part, par `assertOrganizationRole`, parce
 * qu'elle n'est pas une adhésion à l'organisation modifiée.
 */
export const ORGANIZATION_UPDATE_ROLES: readonly OrganizationMemberRole[] = ['ORG_ADMIN'];

/**
 * Refus des mutations en mode lecture seule (`docs/feature-flags.md`).
 *
 * LA GARDE EST DANS LE DOMAINE, ET PAS SEULEMENT DANS LA ROUTE. Un interrupteur posé
 * uniquement à l'entrée HTTP laisserait passer toute autre voie d'écriture — une commande
 * d'administration, une reprise de données, une tâche planifiée — au moment précis où la
 * plateforme est censée ne plus rien écrire. La route peut poser la même garde ; deux
 * refus identiques ne coûtent rien, un refus manquant coûte l'incident.
 *
 * Les LECTURES ne sont pas concernées : pendant un incident, consulter une organisation
 * peut être nécessaire, en créer ou en renommer une ne l'est jamais.
 *
 * L'exemption consentie aux routes d'authentification ne s'étend pas ici : interdire la
 * connexion pendant un incident empêcherait les coordinateurs de consulter les missions en
 * cours, ce qui aggraverait l'incident ; interdire la création d'organisations n'empêche
 * rien d'urgent.
 */
export function assertPlatformWritable(): void {
  if (isFeatureEnabled('PLATFORM_READ_ONLY')) {
    throw new AppError('PLATFORM_READ_ONLY');
  }
}

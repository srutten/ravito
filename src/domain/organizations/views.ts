import type { OrganizationView } from '@/domain/organizations/types';
import type { OrganizationRow } from '@/infrastructure/organizations/repository';

/**
 * Projection d'une ligne `organizations` vers le contrat API.
 *
 * DEUX COLONNES NE SORTENT JAMAIS D'ICI :
 * - `registration_number_normalized`, forme calculée qui porte l'unicité. L'exposer
 *   inviterait un client à la recalculer lui-même, donc à diverger de la définition de la
 *   colonne générée, et l'unicité ne porterait plus sur la même chose selon l'origine ;
 * - rien d'autre, et c'est le point : la table ne porte ni adresse postale, ni contact
 *   nominatif, ni champ libre, précisément pour qu'aucune donnée personnelle ne puisse s'y
 *   glisser (`docs/privacy-rgpd.md`, minimisation).
 *
 * `registrationNumber` est rendu TEL QU'IL A ÉTÉ SAISI, séparateurs compris : un numéro
 * d'immatriculation se lit par groupes, et normaliser l'affichage appauvrirait la
 * vérification humaine d'US-013.
 */
export function toOrganizationView(row: OrganizationRow): OrganizationView {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    registrationNumber: row.registration_number,
    territoryCode: row.territory_code,
    verificationStatus: row.verification_status,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

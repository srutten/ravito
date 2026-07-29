/**
 * Surface publique du module organisations.
 *
 * TROIS COMMANDES EXPLICITES, ET AUCUNE FONCTION DE MUTATION GÉNÉRIQUE : ni
 * `updateOrganization`, ni `setVerificationStatus`, ni `setMemberRole`. CLAUDE.md
 * l'interdit, et la raison se voit ici — une fonction générique de changement de statut
 * serait le chemin le plus court vers la validation d'une organisation par elle-même, donc
 * vers l'usurpation que `docs/threat-model.md` range parmi les menaces prioritaires. La
 * validation (US-013) et la gestion des membres (US-014) arriveront comme des commandes
 * nommées, avec leurs propres gardes.
 *
 * CHAQUE COMMANDE VALIDE SON PROPRE CORPS et résout elle-même l'autorisation, dans la
 * transaction qui écrit. Une route n'a donc rien à vérifier avant de l'appeler, sinon la
 * session : c'est ce qui rend impossible d'ouvrir un second chemin d'écriture qui
 * oublierait une garde.
 *
 * Les composants d'interface n'importent rien de ce module. Ils appellent l'API, qui
 * appelle ces commandes.
 */

export { createOrganization } from '@/domain/organizations/create-organization';
export {
  computeRequestFingerprint,
  timingSafeFingerprintEqual,
} from '@/domain/organizations/fingerprint';
export type {
  ListPendingOrganizationsInput,
  ListPendingOrganizationsResult,
  PendingOrganizationView,
} from '@/domain/organizations/list-pending-organizations';
export {
  isPlatformAdministrator,
  listPendingOrganizations,
} from '@/domain/organizations/list-pending-organizations';
export {
  assertPlatformWritable,
  INITIAL_MEMBER_ROLE,
  ORGANIZATION_CREATE_OPERATION,
  ORGANIZATION_UPDATE_ROLES,
} from '@/domain/organizations/policy';
export { readOrganization } from '@/domain/organizations/read-organization';
export type {
  CreateOrganizationInput,
  CreateOrganizationResult,
  MembershipView,
  OrganizationMemberRole,
  OrganizationMemberStatus,
  OrganizationStatus,
  OrganizationType,
  OrganizationVerificationStatus,
  OrganizationView,
  ReadOrganizationInput,
  ReadOrganizationResult,
  UpdateOrganizationIdentityInput,
  UpdateOrganizationIdentityResult,
} from '@/domain/organizations/types';
export {
  ORGANIZATION_MEMBER_ROLES,
  ORGANIZATION_MEMBER_STATUSES,
  ORGANIZATION_STATUSES,
  ORGANIZATION_TYPES,
  ORGANIZATION_VERIFICATION_STATUSES,
} from '@/domain/organizations/types';
export { updateOrganizationIdentity } from '@/domain/organizations/update-organization-identity';
export { toOrganizationView } from '@/domain/organizations/views';

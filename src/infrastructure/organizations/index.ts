/**
 * Surface publique de l'accès aux données des organisations.
 *
 * Toutes les fonctions exigent un `SqlExecutor` fourni par l'appelant. Aucune n'ouvre de
 * transaction ni ne va chercher le pool elle-même : c'est ce qui rend possible d'écrire
 * l'organisation, son adhésion, son audit et son message d'outbox dans UNE seule
 * transaction, et c'est ce qui empêche qu'une de ces écritures s'échappe dans la sienne.
 */

export type {
  IdempotencyRecord,
  IdempotentOperation,
  ReservationOutcome,
} from '@/infrastructure/organizations/idempotency';
export {
  completeIdempotencyKey,
  reserveIdempotencyKey,
} from '@/infrastructure/organizations/idempotency';
export {
  CHECK_VIOLATION,
  isUniqueViolationOn,
  readConstraintName,
  readSqlState,
  UNIQUE_VIOLATION,
} from '@/infrastructure/organizations/postgres-errors';
export type {
  OrganizationMemberRow,
  OrganizationRow,
} from '@/infrastructure/organizations/repository';
export {
  findMembership,
  findOrganizationById,
  hasPlatformAdminRole,
  insertOrganization,
  insertOrganizationMember,
  listEffectiveMemberships,
  updateOrganizationIdentity,
} from '@/infrastructure/organizations/repository';

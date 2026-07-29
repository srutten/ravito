import type { RequestOrigin } from '@/domain/identity';

/**
 * Vocabulaire et types publics du module organisations.
 *
 * LES CINQ RÉFÉRENTIELS SONT FERMÉS et reprennent, valeur pour valeur, les types énumérés
 * de `0014_organization-enums.sql`, qui font foi. Les redéclarer ici n'est pas une
 * duplication décorative : sans eux, une faute de frappe ne se verrait qu'au premier appel
 * en production, sous la forme d'un `invalid input value for enum` que rien ne rattache au
 * champ fautif.
 *
 * AVERTISSEMENT, à lire avant d'écrire une garde. L'ordre de déclaration de
 * `ORGANIZATION_MEMBER_ROLES` suit `docs/permissions.md` et n'est PAS une hiérarchie de
 * privilèges : `OBSERVER` est déclaré en dernier et reste le rôle le MOINS capable. Une
 * garde écrite `role >= 'ORG_ADMIN'` accorderait donc à un observateur les droits d'un
 * administrateur d'organisation. Les gardes énumèrent les rôles autorisés, action par
 * action ; elles ne comparent jamais l'ordre.
 *
 * De même, `verification_status` se compare par ÉGALITÉ à `VERIFIED`, jamais par `>=` :
 * `REJECTED` n'est pas « plus vérifié » que `VERIFIED`.
 */

/** Nature d'une structure (`organization_type`). */
export const ORGANIZATION_TYPES = [
  'OPERATIONAL_SERVICE',
  'LOCAL_AUTHORITY',
  'COMPANY',
  'ASSOCIATION',
  'FARM',
] as const;
export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];

/** Décision de confiance d'un administrateur plateforme (`organization_verification_status`). */
export const ORGANIZATION_VERIFICATION_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED'] as const;
export type OrganizationVerificationStatus = (typeof ORGANIZATION_VERIFICATION_STATUSES)[number];

/** Cycle de vie de la fiche (`organization_status`). Axe INDÉPENDANT de la vérification. */
export const ORGANIZATION_STATUSES = ['ACTIVE', 'SUSPENDED', 'CLOSED'] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

/** Les cinq rôles de `docs/permissions.md` (`organization_member_role`). Ordre non significatif. */
export const ORGANIZATION_MEMBER_ROLES = [
  'CONTRIBUTOR',
  'COORDINATOR',
  'ORG_ADMIN',
  'PLATFORM_ADMIN',
  'OBSERVER',
] as const;
export type OrganizationMemberRole = (typeof ORGANIZATION_MEMBER_ROLES)[number];

/** Statut d'une adhésion (`organization_member_status`). Seule `ACTIVE` ouvre un accès. */
export const ORGANIZATION_MEMBER_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED'] as const;
export type OrganizationMemberStatus = (typeof ORGANIZATION_MEMBER_STATUSES)[number];

/**
 * Organisation telle que le contrat API l'expose (`docs/api-contract.md`).
 *
 * `registrationNumber` est rendu TEL QU'IL A ÉTÉ SAISI. La forme normalisée qui porte
 * l'unicité n'est jamais exposée : elle est un détail d'implémentation de la contrainte,
 * et l'afficher inviterait un client à la recalculer lui-même, donc à diverger.
 */
export interface OrganizationView {
  readonly id: string;
  readonly name: string;
  readonly type: OrganizationType;
  readonly registrationNumber: string;
  readonly territoryCode: string | null;
  readonly verificationStatus: OrganizationVerificationStatus;
  readonly status: OrganizationStatus;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Adhésion de L'APPELANT, et de lui seul.
 *
 * La liste des membres relève d'US-014 : l'exposer ici ferait de la lecture d'une
 * organisation la liste de ses coordinateurs, alors que les identités des coordinateurs
 * sont un actif de `docs/threat-model.md`.
 */
export interface MembershipView {
  readonly role: OrganizationMemberRole;
  readonly status: OrganizationMemberStatus;
  readonly validFrom: Date;
  readonly validUntil: Date | null;
}

/** Entrée commune : qui agit, et depuis où. */
interface ActorInput {
  /** Identifiant du compte, résolu par la session. JAMAIS fourni par le client (ADR-016). */
  readonly actorUserId: string;
  readonly origin?: RequestOrigin | undefined;
}

/**
 * Création d'une organisation.
 *
 * `payload` est le corps BRUT de la requête. Le domaine le valide lui-même, plutôt que de
 * recevoir des champs déjà typés : `CLAUDE.md` veut toute règle métier côté serveur, et
 * une validation faite dans la route serait à refaire à l'identique dans la prochaine
 * route qui créera une organisation — reprise de données, console d'administration, import.
 * Deux validations finissent toujours par diverger.
 */
export interface CreateOrganizationInput extends ActorInput {
  readonly payload: unknown;
}

export interface CreateOrganizationResult {
  readonly organization: OrganizationView;
  readonly membership: MembershipView;
  /** Toujours `AWAITING_VERIFICATION` : une organisation ne naît jamais vérifiée. */
  readonly nextStep: 'AWAITING_VERIFICATION';
  /**
   * Vrai lorsque la réponse provient du registre d'idempotence, la commande ayant déjà
   * été exécutée. Le CORPS et le STATUT sont identiques dans les deux cas — un client qui
   * a perdu la première réponse n'a pas à distinguer les deux. Le drapeau existe pour la
   * ligne de journal et pour les métriques de rejeu de `docs/observability.md`.
   */
  readonly replayed: boolean;
}

/**
 * Modification de l'identité d'une organisation.
 *
 * `payload` porte `expectedVersion` et les champs à modifier. La PRÉSENCE d'une clé vaut
 * demande de modification, y compris lorsque sa valeur est `null` — c'est ainsi qu'un
 * `territoryCode` se retire. Le domaine lit donc le corps brut : une fois passé par un
 * type TypeScript, « champ absent » et « champ à null » deviennent indiscernables.
 */
export interface UpdateOrganizationIdentityInput extends ActorInput {
  /** Identifiant de chemin, validé par le domaine comme n'importe quelle entrée externe. */
  readonly organizationId: unknown;
  readonly payload: unknown;
}

export interface UpdateOrganizationIdentityResult {
  readonly organization: OrganizationView;
  /** Adhésion de l'appelant, `null` pour un administrateur plateforme sans adhésion. */
  readonly membership: MembershipView | null;
  /** Vrai lorsque la modification a fait retomber la vérification à `PENDING`. */
  readonly verificationReset: boolean;
}

export interface ReadOrganizationInput {
  readonly actorUserId: string;
  readonly organizationId: unknown;
}

export interface ReadOrganizationResult {
  readonly organization: OrganizationView;
  readonly membership: MembershipView | null;
}

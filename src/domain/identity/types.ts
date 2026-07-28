/**
 * Types publics du module d'identité.
 *
 * Ce qui n'y figure PAS est aussi important que ce qui y figure :
 * - aucun rôle, aucune organisation. `OrganizationMember` n'existe pas au lot 1 ; un
 *   champ vide laisserait croire qu'il est renseigné (docs/api-contract.md) ;
 * - aucun mot de passe, aucune empreinte de mot de passe (ADR-015) ;
 * - aucun code, aucun identifiant en clair dans les résultats renvoyés aux routes, à la
 *   seule exception du jeton de session, qui n'a d'autre destination que le cookie.
 */

/** Niveaux de vérification du compte, ordonnés (`user_verification_level`). */
export type UserVerificationLevel = 'NONE' | 'CONTACT_VERIFIED' | 'IDENTITY_VERIFIED';

/** États d'un compte (`user_profile_status`). */
export type UserProfileStatus = 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

/**
 * Origine de l'appel, telle que la route la reconstitue.
 *
 * L'adresse n'est jamais conservée en clair : elle est hachée avant écriture. Elle est
 * transmise en clair jusqu'ici parce qu'il faut bien la hacher quelque part, et que ce
 * quelque part doit être le serveur.
 */
export interface RequestOrigin {
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
}

/** Compte, réduit à ce qu'une interface connectée a besoin d'afficher. */
export interface UserProfileSummary {
  readonly id: string;
  readonly displayName: string;
  readonly preferredLanguage: string;
  readonly verificationLevel: UserVerificationLevel;
}

/** Session, telle qu'exposée par le contrat API. */
export interface SessionSummary {
  readonly id: string;
  readonly issuedAt: Date;
  /** Fin de la fenêtre d'inactivité. Repoussée par l'activité, jamais au-delà de l'absolue. */
  readonly expiresAt: Date;
  /** Fin de vie maximale, indépendante de l'activité. Déduite de `issuedAt`, jamais repoussée. */
  readonly absoluteExpiresAt: Date;
  readonly lastSeenAt: Date;
}

export interface RequestSignInCodeInput {
  /** Saisie brute de l'utilisateur. Validée et normalisée par le domaine. */
  readonly identifier: unknown;
  readonly origin?: RequestOrigin | undefined;
}

/**
 * Réponse d'une demande de code. Les trois valeurs numériques sont des constantes de la
 * plateforme, identiques pour tout appelant : elles alimentent le compte à rebours de
 * l'interface sans rien dire du compte visé.
 *
 * `challengeId` est opaque : il ne contient pas l'identifiant saisi et ne permet pas de
 * le déduire. Il est présent aussi bien pour un identifiant connu que pour un identifiant
 * inconnu, faute de quoi son absence trahirait l'inexistence du compte.
 */
export interface RequestSignInCodeResult {
  readonly challengeId: string;
  readonly codeLength: number;
  readonly expiresInSeconds: number;
  readonly resendAvailableInSeconds: number;
}

export interface VerifySignInCodeInput {
  readonly challengeId: unknown;
  readonly code: unknown;
  readonly origin?: RequestOrigin | undefined;
}

/**
 * Résultat d'une vérification réussie.
 *
 * `sessionToken` est la SEULE copie du secret hors du navigateur, et elle est éphémère :
 * la route la pose dans le cookie et n'en fait rien d'autre. Elle ne doit apparaître ni
 * dans un corps de réponse, ni dans un journal, ni dans une trace.
 */
export interface VerifySignInCodeResult {
  readonly sessionToken: string;
  readonly session: SessionSummary;
  readonly user: UserProfileSummary;
  /**
   * Toujours `READY` au lot 1. `MFA_REQUIRED` est réservé à US-011 et n'est jamais émis
   * par cette version : l'encart de l'écran 2 annonce le second facteur, il ne le fournit
   * pas (docs/api-contract.md).
   */
  readonly nextStep: 'READY';
  /** Calculé par le serveur, jamais choisi par le client (ADR-016). */
  readonly redirectPath: string;
}

export interface SignOutInput {
  /** Jeton lu dans le cookie. Absent, la commande n'a rien à faire et ne lève pas. */
  readonly sessionToken?: string | undefined;
  readonly origin?: RequestOrigin | undefined;
}

export interface RevokeAllSessionsInput {
  readonly userId: string;
  /** Rend le rejeu sans effet supplémentaire (docs/api-contract.md). */
  readonly clientEventId: unknown;
  readonly origin?: RequestOrigin | undefined;
}

/**
 * Nombre de sessions valides au moment de la révocation.
 *
 * ÉCART ASSUMÉ par rapport à la signature `Promise<void>` du cadrage : le contrat API
 * impose `{ "revokedCount": 3 }` dans la réponse de
 * `POST /api/v1/auth/sessions/commands/revoke-all`, et ce nombre ne peut plus être
 * calculé après coup — une fois la révocation faite, il n'y a plus rien à compter. Un
 * appelant qui ignore la valeur de retour reste valide, l'écart est donc additif.
 */
export interface RevokeAllSessionsResult {
  readonly revokedCount: number;
}

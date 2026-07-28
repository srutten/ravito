/**
 * Surface publique du module d'identité.
 *
 * Quatre commandes explicites, et aucune fonction de changement d'état générique : ni
 * `updateSession`, ni `setUserStatus`. CLAUDE.md l'interdit, et la raison se voit ici —
 * une fonction générique de mutation de session serait le chemin le plus court vers une
 * élévation de privilèges depuis une route mal protégée.
 *
 * Les composants d'interface n'importent rien de ce module. Ils appellent l'API, qui
 * appelle ces commandes.
 */

export type { CodeDelivery, SignInCodeMessage } from '@/domain/identity/code-delivery';
export {
  configureCodeDelivery,
  getConfiguredCodeDelivery,
  resetCodeDelivery,
} from '@/domain/identity/code-delivery';
export type {
  IdentifierRejectionReason,
  SignInChannel,
  SignInIdentifier,
} from '@/domain/identity/identifier';
export { maskIdentifier, parseSignInIdentifier } from '@/domain/identity/identifier';
export {
  POST_SIGN_IN_REDIRECT_PATH,
  SESSION_ABSOLUTE_TTL_SECONDS,
  SESSION_IDLE_TTL_SECONDS,
  SIGN_IN_CODE_LENGTH,
  SIGN_IN_CODE_RESEND_SECONDS,
  SIGN_IN_CODE_TTL_SECONDS,
} from '@/domain/identity/policy';
export { requestSignInCode } from '@/domain/identity/request-sign-in-code';
export { revokeAllSessions, signOut } from '@/domain/identity/sign-out';

export type {
  RequestOrigin,
  RequestSignInCodeInput,
  RequestSignInCodeResult,
  RevokeAllSessionsInput,
  RevokeAllSessionsResult,
  SessionSummary,
  SignOutInput,
  UserProfileStatus,
  UserProfileSummary,
  UserVerificationLevel,
  VerifySignInCodeInput,
  VerifySignInCodeResult,
} from '@/domain/identity/types';
export { verifySignInCode } from '@/domain/identity/verify-sign-in-code';

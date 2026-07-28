/**
 * Port de livraison du code à usage unique.
 *
 * Le domaine ne connaît ni SMTP, ni fournisseur, ni gabarit de courriel : il connaît
 * l'obligation de remettre un code sur un canal que l'utilisateur contrôle. Un
 * remplacement du transport ne touche donc qu'un adaptateur
 * (`src/infrastructure/identity/`), conformément à docs/notifications.md — « les
 * fournisseurs externes ne doivent pas être appelés directement depuis le domaine ».
 *
 * Le port est délibérément pauvre : `send` ne renvoie rien. Un identifiant de message ou
 * un accusé d'envoi remonterait jusqu'à la commande, et la tentation serait alors de le
 * refléter dans la réponse — ce que le critère 7 interdit, puisque l'envoi n'a lieu que
 * pour un compte existant.
 */

export interface SignInCodeMessage {
  /** Canal déduit de l'identifiant par le serveur. Seul `EMAIL` est livré au lot 1. */
  readonly channel: 'EMAIL';
  /** Destinataire normalisé. En clair : il faut bien une adresse pour envoyer. */
  readonly recipient: string;
  /** Code en clair. N'existe qu'en mémoire et dans le message envoyé, jamais en base. */
  readonly code: string;
  readonly expiresAt: Date;
  /** Étiquette de langue du compte. Seul le catalogue français est livré. */
  readonly preferredLanguage: string;
  /** Identifiant opaque du défi, pour rapprocher un envoi d'une trace technique. */
  readonly challengeId: string;
}

export interface CodeDelivery {
  send(input: SignInCodeMessage): Promise<void>;
}

/**
 * Adaptateur en vigueur. Injecté au démarrage ou par un test ; à défaut, l'adaptateur par
 * défaut est résolu depuis la configuration.
 */
let configured: CodeDelivery | undefined;

/**
 * Impose un adaptateur. Prévu pour les tests et pour une composition explicite au
 * démarrage : un test qui doit lire le code envoyé n'a alors aucune raison de le chercher
 * dans un journal.
 */
export function configureCodeDelivery(delivery: CodeDelivery): void {
  configured = delivery;
}

/** Rend la résolution à la configuration. Réservé aux tests. */
export function resetCodeDelivery(): void {
  configured = undefined;
}

/** Adaptateur imposé, ou `undefined` si la résolution revient à la configuration. */
export function getConfiguredCodeDelivery(): CodeDelivery | undefined {
  return configured;
}

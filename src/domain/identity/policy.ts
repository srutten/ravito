/**
 * Paramètres de l'authentification.
 *
 * Ces valeurs ne sont pas des réglages libres : chacune vient d'une décision écrite
 * (ADR-015 pour le code à usage unique, ADR-017 pour la session opaque) ou d'un chiffre
 * exposé par `docs/api-contract.md`. Elles sont regroupées ici pour qu'un changement
 * soit visible en un seul endroit, et pour que les commandes ne portent aucun nombre
 * magique.
 *
 * Aucune de ces valeurs n'est lue depuis la configuration d'environnement. Un seuil de
 * sécurité réglable par variable d'environnement se règle aussi par erreur : un
 * `SIGN_IN_MAX_ATTEMPTS=1000` posé en production pour « débloquer un utilisateur »
 * supprimerait la limitation de tentatives sans qu'aucune revue ne le voie passer.
 */

/** Longueur du code à usage unique. Six chiffres, ADR-015. */
export const SIGN_IN_CODE_LENGTH = 6;

/** Durée de vie d'un défi, en secondes. Dix minutes, ADR-015. */
export const SIGN_IN_CODE_TTL_SECONDS = 600;

/**
 * Nombre d'essais par défi. Cinq, ADR-015. La valeur est FIGÉE à l'émission dans
 * `auth_challenges.max_attempts` : un défi déjà envoyé reste jugé selon la règle en
 * vigueur au moment de son envoi.
 */
export const SIGN_IN_CODE_MAX_ATTEMPTS = 5;

/**
 * Délai annoncé à l'interface avant de proposer un nouvel envoi. Constante d'affichage
 * identique pour tout appelant (docs/api-contract.md) : elle ne dit rien du compte visé.
 * Le plafond réellement appliqué côté serveur est celui de `REQUEST_CODE_BY_IDENTIFIER`.
 */
export const SIGN_IN_CODE_RESEND_SECONDS = 60;

/** Fenêtre d'inactivité d'une session, en secondes. Douze heures, ADR-017. */
export const SESSION_IDLE_TTL_SECONDS = 12 * 60 * 60;

/** Durée de vie absolue d'une session, en secondes. Sept jours, ADR-017. */
export const SESSION_ABSOLUTE_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Période minimale entre deux rafraîchissements de `last_seen_at`. Sans ce palier,
 * chaque lecture authentifiée deviendrait une écriture, pour une précision dont
 * personne n'a besoin (voir le commentaire de `last_seen_at` dans 0013_sessions.sql).
 */
export const SESSION_TOUCH_INTERVAL_SECONDS = 60;

/**
 * Destination après connexion. Calculée par le serveur, jamais choisie par le client
 * (ADR-016). Au lot 1 elle désigne toujours la page d'attente : les tableaux de bord par
 * rôle relèvent des lots suivants et l'appartenance à une organisation n'existe pas
 * encore. C'est le point d'extension de US-014.
 */
export const POST_SIGN_IN_REDIRECT_PATH = '/apres-connexion';

/**
 * Plancher de durée appliqué aux deux commandes non authentifiées.
 *
 * La neutralité de durée exigée par le critère 7 repose d'abord sur le fait que le
 * serveur exécute le MÊME travail pour un identifiant connu et pour un identifiant
 * inconnu : mêmes requêtes, même nombre d'allers-retours, envoi jamais attendu. Ce
 * plancher est une seconde ligne : il absorbe les écarts résiduels tant qu'ils restent
 * sous le seuil.
 *
 * Ce que ce plancher ne fait pas, et qu'il ne faut pas croire : si la base devenait
 * assez lente pour qu'une branche dépasse le plancher, l'écart redeviendrait mesurable.
 * Le plancher complète l'égalité du travail, il ne la remplace pas.
 */
export const MINIMUM_PUBLIC_COMMAND_DURATION_MS = 250;

/** Dimension limitée. Le marqueur est préfixé au sujet AVANT hachage (0012). */
export type AttemptDimension = 'identifier' | 'source' | 'pair';

export interface AttemptPolicy {
  /** Marqueur de dimension, préfixé au sujet avant hachage. */
  readonly dimension: AttemptDimension;
  /** Chemin protégé. Deux chemins ne partagent jamais un compteur. */
  readonly purpose: 'sign-in-request' | 'sign-in-verify';
  /** Fenêtre glissante, en secondes. */
  readonly windowSeconds: number;
  /**
   * Nombre de tentatives TOLÉRÉES dans la fenêtre, et non rang de la première refusée.
   * Avec `maxAttempts = 5`, cinq appels passent et le sixième déclenche le blocage.
   */
  readonly maxAttempts: number;
  /** Durée du blocage une fois le seuil franchi, en secondes. */
  readonly blockSeconds: number;
}

const FIFTEEN_MINUTES = 15 * 60;

/**
 * Demande de code, par identifiant. Le seuil est bas : au-delà de cinq codes en quinze
 * minutes pour une même adresse, il ne s'agit plus d'un utilisateur qui n'a rien reçu.
 * Ce compteur protège aussi le destinataire du harcèlement par courriel, pas seulement
 * la plateforme.
 */
export const REQUEST_CODE_BY_IDENTIFIER: AttemptPolicy = {
  dimension: 'identifier',
  purpose: 'sign-in-request',
  windowSeconds: FIFTEEN_MINUTES,
  maxAttempts: 5,
  blockSeconds: FIFTEEN_MINUTES,
};

/**
 * Demande de code, par source. Seuil plus haut : une source légitime peut être un
 * partage de connexion, un réseau d'entreprise ou un centre de secours entier derrière
 * une seule adresse. Trop bas, ce compteur exclurait une caserne pour la faute d'une
 * personne.
 */
export const REQUEST_CODE_BY_SOURCE: AttemptPolicy = {
  dimension: 'source',
  purpose: 'sign-in-request',
  windowSeconds: FIFTEEN_MINUTES,
  maxAttempts: 20,
  blockSeconds: FIFTEEN_MINUTES,
};

/**
 * Vérification, par identifiant. Complète le plafond porté par le défi lui-même : sans
 * ce compteur, il suffirait de redemander un code après cinq essais pour disposer de
 * cinq essais de plus, indéfiniment.
 */
export const VERIFY_CODE_BY_IDENTIFIER: AttemptPolicy = {
  dimension: 'identifier',
  purpose: 'sign-in-verify',
  windowSeconds: FIFTEEN_MINUTES,
  maxAttempts: 10,
  blockSeconds: FIFTEEN_MINUTES,
};

/** Vérification, par source. Même raisonnement que pour la demande de code. */
export const VERIFY_CODE_BY_SOURCE: AttemptPolicy = {
  dimension: 'source',
  purpose: 'sign-in-verify',
  windowSeconds: FIFTEEN_MINUTES,
  maxAttempts: 30,
  blockSeconds: FIFTEEN_MINUTES,
};

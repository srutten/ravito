import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getServerConfig } from '@/config/env';
import { logger } from '@/observability/logger';

/**
 * Empreinte de requête, destinée à `idempotency_keys.request_fingerprint`.
 *
 * À QUOI ELLE SERT. La clé d'idempotence répond à « cette commande a-t-elle déjà été
 * exécutée ? ». L'empreinte répond à la question suivante, qui n'a pas la même réponse :
 * « la commande présentée est-elle bien la même que celle déjà exécutée ? ». Sans elle,
 * une clé réutilisée pour une intention différente recevrait la réponse de la première,
 * et l'appelant croirait sa seconde demande satisfaite alors qu'elle n'a rien produit
 * (`docs/api-contract.md`, `IDEMPOTENCY_CONFLICT`).
 *
 * POURQUOI UN HMAC ET NON UN CONDENSÉ NU. Le corps d'une création d'organisation est une
 * valeur à FAIBLE ENTROPIE : un nom, un type pris dans cinq valeurs, un numéro
 * d'immatriculation à format connu. Un SHA-256 nu de cet ensemble se retourne par
 * énumération, et le vol d'une sauvegarde révélerait alors exactement le contenu que la
 * colonne existe pour ne pas stocker. Avec une clé absente de la base, l'espace de
 * recherche devient celui de la clé. C'est le régime imposé par supabase/README.md,
 * « Convention d'empreinte », au même titre que `identifier_hash` et `code_hash`.
 *
 * À REPRENDRE HORS PÉRIMÈTRE. `src/domain/identity/hashing.ts` porte la même mécanique —
 * même secret, même séparation de domaine, même repli local — sans l'exposer. Les deux
 * modules ont vocation à partager un `src/infrastructure/crypto/hmac.ts` ; la
 * factorisation touche `src/domain/identity/**`, hors du périmètre de cette story. Tant
 * qu'elle n'est pas faite, toute correction apportée à l'un doit être reportée à l'autre.
 */

/** Étiquette de séparation de domaine. Ne jamais la réutiliser pour un autre usage. */
const DOMAIN_REQUEST_FINGERPRINT = 'appui-feux:organizations:request-fingerprint:v1';

/** Longueur de la clé de repli engendrée en local, en octets. */
const LOCAL_SECRET_BYTES = 32;

const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Registre de la clé de repli locale. Même procédé que le pool applicatif : le
 * rechargement à chaud de Next réévalue les modules, et une variable de module donnerait
 * une clé différente après chaque recompilation.
 */
const LOCAL_SECRET_KEY = Symbol.for('appui-feux.organizations.local-secret');

interface SecretRegistry {
  [LOCAL_SECRET_KEY]?: string;
}

const registry = globalThis as unknown as SecretRegistry;

/**
 * Clé du HMAC.
 *
 * Hors poste local, `AUTH_SECRET` est obligatoire et sa validation empêche le démarrage
 * (`src/config/env.ts`) : cette fonction ne peut donc pas y retomber sur le repli.
 *
 * En local, une clé aléatoire est engendrée une fois par processus plutôt que d'empêcher
 * un développeur de travailler sur un poste neuf. CONSÉQUENCE À CONNAÎTRE, et elle est du
 * bon côté : après un redémarrage, une clé d'idempotence réservée avant le redémarrage
 * n'est plus comparable, et un rejeu produit `IDEMPOTENCY_CONFLICT` au lieu de rejouer la
 * réponse. Le rejeu est refusé, jamais exécuté deux fois — c'est le sens sûr. Aucune
 * valeur de repli n'est écrite en dur : un secret de repli commité est un secret partagé
 * par toutes les copies du dépôt.
 */
function resolveSecret(): string {
  const configured = getServerConfig().authSecret;
  if (configured !== undefined) {
    return configured;
  }
  const existing = registry[LOCAL_SECRET_KEY];
  if (existing !== undefined) {
    return existing;
  }
  const generated = randomBytes(LOCAL_SECRET_BYTES).toString('hex');
  registry[LOCAL_SECRET_KEY] = generated;
  logger.warn(
    { module: 'organizations' },
    "AUTH_SECRET est absente : une cle ephemere est utilisee pour les empreintes d'idempotence. Une cle reservee avant un redemarrage ne sera plus rejouable et produira IDEMPOTENCY_CONFLICT. Configurer AUTH_SECRET pour un comportement stable.",
  );
  return generated;
}

/**
 * Encadre chaque partie par sa longueur avant concaténation.
 *
 * Un simple séparateur ne suffit pas ici, contrairement au module d'identité : les valeurs
 * encadrées viennent d'un corps de requête arbitraire et peuvent contenir n'importe quel
 * caractère, y compris celui qu'on aurait choisi comme séparateur. Le préfixe de longueur
 * rend la concaténation injective quoi que contiennent les parties : sans lui,
 * `['ab', 'c']` et `['a', 'bc']` produiraient la même empreinte, donc le même rejeu pour
 * deux requêtes différentes.
 *
 * Une partie absente (`null`) est encadrée par `-:` et se distingue donc d'une chaîne
 * vide, encadrée par `0:`. La distinction compte : « aucun territoire déclaré » et
 * « territoire vide » ne sont pas la même intention.
 */
function frame(parts: readonly (string | null)[]): string {
  return parts.map((part) => (part === null ? '-:' : `${part.length}:${part}`)).join('');
}

/**
 * Empreinte d'une commande idempotente.
 *
 * L'ACTEUR EST DANS L'EMPREINTE, et ce n'est pas un détail de forme. La portée de
 * `client_event_id` étant aujourd'hui globale (0017, point ouvert du corpus), un second
 * acteur peut présenter une clé déjà employée. Sans l'acteur dans l'empreinte, il
 * recevrait la réponse du premier — c'est-à-dire l'organisation d'un tiers. Avec lui, il
 * reçoit `IDEMPOTENCY_CONFLICT`, qui ne révèle rien d'autre que « cette clé est prise »,
 * information sans valeur pour un identifiant tiré au hasard sur 122 bits.
 *
 * L'OPÉRATION AUSSI : la même clé employée pour une commande différente est une erreur de
 * programmation, pas une reprise, et doit être refusée comme telle.
 *
 * Les valeurs encadrées sont les valeurs CANONIQUES, c'est-à-dire celles qui sortent de la
 * validation. Deux requêtes qui ne diffèrent que par un espace de bordure déjà retiré par
 * la validation sont la même intention et doivent donner la même empreinte ; les comparer
 * avant normalisation produirait un conflit là où il n'y a qu'une reprise.
 */
export function computeRequestFingerprint(input: {
  readonly operation: string;
  readonly actorUserId: string;
  readonly fields: readonly (string | null)[];
}): string {
  return createHmac('sha256', resolveSecret())
    .update(
      `${DOMAIN_REQUEST_FINGERPRINT}${frame([input.operation, input.actorUserId, ...input.fields])}`,
    )
    .digest('hex');
}

/**
 * Comparaison en temps constant de deux empreintes hexadécimales.
 *
 * Une comparaison de chaînes ordinaire s'arrête au premier caractère différent : sa durée
 * révèle le nombre de caractères déjà corrects, ce qui transforme la recherche d'une
 * empreinte valide en une suite de recherches indépendantes sur un caractère chacune.
 * L'enjeu est réel ici : qui saurait fabriquer une empreinte acceptée ferait rejouer la
 * réponse d'un autre acteur.
 */
export function timingSafeFingerprintEqual(left: string, right: string): boolean {
  if (!HEX_DIGEST_PATTERN.test(left) || !HEX_DIGEST_PATTERN.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

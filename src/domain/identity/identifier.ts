import { z } from 'zod';
import { AppError } from '@/application/errors';

/**
 * Identifiant de connexion : validation de forme et normalisation.
 *
 * Deux règles gouvernent ce fichier.
 *
 * 1. LA VALIDATION NE CONSULTE JAMAIS L'ÉTAT STOCKÉ. Elle ne porte que sur la forme de
 *    la saisie. Une validation qui interrogerait la base pour décider de son verdict
 *    distinguerait un compte existant d'un compte absent avant même la limitation de
 *    tentatives, ce qui est exactement l'oracle d'énumération que le critère 7 interdit.
 *
 * 2. LA FORME NORMALISÉE EST CELLE QUE LA BASE ACCEPTE. `user_profiles` contraint le
 *    courriel à `email::text = btrim(lower(email::text))`. Toute divergence entre la
 *    normalisation d'ici et celle de PostgreSQL produirait une violation de contrainte à
 *    l'écriture, c'est-à-dire une erreur interne sur un parcours de connexion.
 */

/** Longueur maximale d'une adresse de courriel (docs/api-contract.md). */
const MAX_EMAIL_LENGTH = 254;

/**
 * Motif repris de `user_profiles_email_shape` : une partie locale, une arobase, un
 * domaine avec au moins un point. Volontairement permissif — la seule preuve qu'une
 * adresse existe est qu'un code y parvienne, aucune expression régulière ne la remplace.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Restriction aux caractères ASCII imprimables.
 *
 * Motif : `lower()` de PostgreSQL sous locale C ne met en minuscules que l'ASCII, alors
 * que `String.prototype.toLowerCase` traite tout l'Unicode. Sur une adresse contenant
 * « Ä », les deux normalisations divergent, l'insertion viole
 * `user_profiles_email_normalized` et le parcours de connexion tombe en erreur interne.
 * Le comportement dépendrait en outre de la locale de l'instance, donc différerait entre
 * le poste local et la production.
 *
 * Refuser proprement vaut mieux qu'échouer obscurément. La limite est signalée à
 * l'appelant par `reason: 'IDENTIFIER_NOT_ASCII'` et devra être levée le jour où le
 * produit accueillera des adresses internationalisées, par une normalisation commune au
 * code et au schéma.
 */
const ASCII_PRINTABLE = /^[\x21-\x7e]+$/;

/**
 * Saisie qui ressemble à un numéro de téléphone : chiffres, espaces, points, tirets,
 * parenthèses, éventuellement précédés d'un plus. Le canal SMS n'est pas livré au lot 1
 * (`docs/screens.md` écran 2, `ENABLE_SMS` faux) ; accepter une telle saisie produirait
 * une attente sans fin et sans explication.
 */
const PHONE_LIKE = /^\+?[\d\s.\-()]{6,}$/;

export type SignInChannel = 'EMAIL';

export interface SignInIdentifier {
  /** Canal déduit de l'identifiant par le serveur, jamais choisi par le client. */
  readonly channel: SignInChannel;
  /** Forme normalisée, seule valeur écrite, comparée ou hachée. */
  readonly normalized: string;
}

/**
 * Motif de refus, joint aux `details` de l'erreur de validation. Il ne dépend que de la
 * forme de la saisie et ne dit rien de l'existence d'un compte : l'écran de connexion
 * peut donc l'afficher sans ouvrir d'oracle.
 */
export type IdentifierRejectionReason =
  | 'IDENTIFIER_REQUIRED'
  | 'IDENTIFIER_TOO_LONG'
  | 'IDENTIFIER_NOT_ASCII'
  | 'PHONE_CHANNEL_UNAVAILABLE'
  | 'IDENTIFIER_MALFORMED';

/**
 * Mise en minuscules restreinte à l'ASCII, identique à `lower()` de PostgreSQL sur des
 * caractères ASCII quelle que soit la locale de l'instance. Le refus des caractères non
 * ASCII en amont rend cette fonction totale sur les valeurs acceptées.
 */
function toAsciiLowerCase(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    result += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : character;
  }
  return result;
}

function rejectIdentifier(reason: IdentifierRejectionReason): never {
  throw new AppError('VALIDATION_ERROR', {
    details: { fields: ['identifier'], reason },
  });
}

/**
 * Schéma de transport de l'identifiant. Il ne fait que borner la chaîne reçue : le
 * verdict complet appartient à `parseSignInIdentifier`, qui produit un motif de refus
 * exploitable par l'interface.
 */
export const rawIdentifierSchema = z
  .string({ message: 'Identifiant attendu.' })
  .max(320, { message: 'Identifiant trop long.' });

/**
 * Valide et normalise l'identifiant saisi. Lève `AppError('VALIDATION_ERROR')` avec le
 * motif en `details.reason`.
 *
 * L'ordre des vérifications est choisi pour que le message soit le plus utile : un
 * numéro de téléphone est reconnu comme tel AVANT d'être qualifié d'adresse malformée,
 * parce que « le canal SMS n'est pas disponible » explique la situation alors que
 * « adresse invalide » laisse l'utilisateur corriger indéfiniment une saisie correcte.
 */
export function parseSignInIdentifier(raw: unknown): SignInIdentifier {
  const parsed = rawIdentifierSchema.safeParse(raw);
  if (!parsed.success) {
    rejectIdentifier('IDENTIFIER_MALFORMED');
  }
  const trimmed = parsed.data.trim();
  if (trimmed.length === 0) {
    rejectIdentifier('IDENTIFIER_REQUIRED');
  }
  if (PHONE_LIKE.test(trimmed)) {
    rejectIdentifier('PHONE_CHANNEL_UNAVAILABLE');
  }
  if (!ASCII_PRINTABLE.test(trimmed)) {
    rejectIdentifier('IDENTIFIER_NOT_ASCII');
  }
  if (trimmed.length > MAX_EMAIL_LENGTH) {
    rejectIdentifier('IDENTIFIER_TOO_LONG');
  }
  if (!EMAIL_SHAPE.test(trimmed)) {
    rejectIdentifier('IDENTIFIER_MALFORMED');
  }
  return { channel: 'EMAIL', normalized: toAsciiLowerCase(trimmed) };
}

/**
 * Masque un identifiant pour la journalisation. `docs/observability.md` exclut les
 * coordonnées personnelles des journaux ; un identifiant complet dans une ligne de log
 * est une adresse de plus dans un système que des exploitants consultent, et que des
 * sauvegardes conservent.
 *
 * Ce qui reste — première lettre et domaine — suffit à un exploitant pour rapprocher une
 * ligne d'un incident signalé, sans constituer un annuaire.
 */
export function maskIdentifier(normalizedIdentifier: string): string {
  const separator = normalizedIdentifier.lastIndexOf('@');
  if (separator <= 0) {
    return '***';
  }
  const local = normalizedIdentifier.slice(0, separator);
  const domain = normalizedIdentifier.slice(separator + 1);
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}

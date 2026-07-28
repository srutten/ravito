import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { SIGN_IN_CODE_LENGTH } from '@/domain/identity/policy';

/**
 * Tirage et validation de forme du code à usage unique.
 *
 * `Math.random` est proscrit ici, et pas par principe : son générateur est prévisible à
 * partir de quelques sorties observées. Un attaquant qui demande une série de codes pour
 * une adresse qu'il contrôle en déduirait l'état interne du générateur, donc les codes
 * tirés ensuite pour les autres comptes. Un compte de coordinateur tomberait sans qu'un
 * seul code lui soit dérobé.
 *
 * `crypto.randomInt` tire uniformément sur l'intervalle demandé, par rejet des valeurs
 * excédentaires. Une réduction naïve du type `octet % 10` introduirait au contraire un
 * biais sur les premiers chiffres, et réduirait l'espace réellement atteint.
 */

const CODE_UPPER_BOUND = 10 ** SIGN_IN_CODE_LENGTH;

/** Forme acceptée en entrée : exactement `SIGN_IN_CODE_LENGTH` chiffres décimaux. */
const CODE_PATTERN = new RegExp(`^\\d{${SIGN_IN_CODE_LENGTH}}$`);

/**
 * Tire un code à usage unique. Les zéros de tête sont conservés : « 004821 » est un code
 * valide, et l'écarter réduirait l'espace de tirage tout en rendant la longueur du code
 * variable à l'affichage.
 */
export function createSignInCode(): string {
  return String(randomInt(0, CODE_UPPER_BOUND)).padStart(SIGN_IN_CODE_LENGTH, '0');
}

/**
 * Schéma du code présenté à la vérification. Les espaces de bordure sont retirés parce
 * qu'un code recopié depuis un courriel en traîne souvent ; rien d'autre n'est corrigé.
 */
export const signInCodeSchema = z
  .string({ message: 'Code attendu.' })
  .trim()
  .regex(CODE_PATTERN, { message: 'Code à six chiffres attendu.' });

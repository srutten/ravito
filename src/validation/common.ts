import { z } from 'zod';

/**
 * Schémas partagés par toutes les entrées d'API.
 *
 * Ils sont typés dès le lot 0, avant toute mutation exposée, pour que les contrats
 * d'idempotence, de version optimiste et de pagination soient identiques partout.
 */

/** Longueur maximale d'un curseur opaque, bornée pour éviter une entrée démesurée. */
const MAX_CURSOR_LENGTH = 512;
/** Un curseur est un jeton opaque encodé en base64url : ni espace, ni caractère de contrôle. */
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;

export const uuidSchema = z.uuid({ message: 'Identifiant UUID attendu.' });

/**
 * Identifiant d'événement client, fourni par l'appelant pour rendre une mutation critique
 * idempotente : une même commande ne doit jamais produire deux effets (CLAUDE.md).
 */
export const clientEventIdSchema = z.uuid({
  message: "Identifiant d'événement client UUID attendu.",
});

/**
 * Version attendue de l'agrégat, pour la concurrence optimiste. Un entier négatif n'a pas de
 * sens : la première version d'un agrégat est zéro.
 */
export const expectedVersionSchema = z
  .int({ message: 'Numéro de version entier attendu.' })
  .min(0, { message: 'Numéro de version positif ou nul attendu.' });

/** Curseur de pagination. Sa structure interne reste privée au serveur. */
export const cursorSchema = z
  .string({ message: 'Curseur de pagination attendu.' })
  .min(1, { message: 'Curseur de pagination vide.' })
  .max(MAX_CURSOR_LENGTH, { message: 'Curseur de pagination trop long.' })
  .regex(CURSOR_PATTERN, { message: 'Curseur de pagination invalide.' });

export type ClientEventId = string;
export type ExpectedVersion = z.infer<typeof expectedVersionSchema>;
export type Cursor = z.infer<typeof cursorSchema>;

import { describe, expect, it } from 'vitest';
import { ZodError, z } from 'zod';
import type { ErrorBody } from '@/application/errors';
import { toErrorBody } from '@/application/errors';
import { clientEventIdSchema, cursorSchema, expectedVersionSchema } from '@/validation/common';

/**
 * Schémas partagés (US-001 critère 10).
 *
 * Ces contrats sont typés avant toute mutation exposée : idempotence, concurrence optimiste et
 * pagination doivent avoir la même définition partout, dès le premier lot.
 */

const VALID_UUID = '11111111-2222-4333-8444-555555555555';

describe('clientEventIdSchema', () => {
  it('accepte un UUID', () => {
    expect(clientEventIdSchema.parse(VALID_UUID)).toBe(VALID_UUID);
  });

  it('refuse une valeur qui n est pas un UUID', () => {
    const rejected = [
      'pas-un-uuid',
      '',
      '   ',
      '11111111-2222-4333-8444',
      '11111111222243338444555555555555',
      `${VALID_UUID} `,
      '11111111-2222-4333-8444-55555555555g',
      42,
      null,
      undefined,
      { id: VALID_UUID },
    ];

    for (const value of rejected) {
      expect(clientEventIdSchema.safeParse(value).success, String(value)).toBe(false);
    }
  });
});

describe('expectedVersionSchema', () => {
  it('accepte zéro et les entiers positifs', () => {
    expect(expectedVersionSchema.parse(0)).toBe(0);
    expect(expectedVersionSchema.parse(7)).toBe(7);
  });

  it('refuse un nombre négatif', () => {
    expect(expectedVersionSchema.safeParse(-1).success).toBe(false);
  });

  it('refuse une valeur non entière', () => {
    for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY, '3', true]) {
      expect(expectedVersionSchema.safeParse(value).success, String(value)).toBe(false);
    }
  });
});

describe('cursorSchema', () => {
  it('accepte un jeton opaque encodé en base64url', () => {
    expect(cursorSchema.parse('bWlzc2lvbi0wMDE9')).toBe('bWlzc2lvbi0wMDE9');
  });

  it('refuse un curseur vide, trop long ou porteur de caractères inattendus', () => {
    for (const value of ['', 'curseur invalide', 'curseur/avec+separateurs', 'a'.repeat(513)]) {
      expect(cursorSchema.safeParse(value).success, value.slice(0, 20)).toBe(false);
    }
  });
});

describe('conversion d une erreur de validation', () => {
  const commandSchema = z.object({
    clientEventId: clientEventIdSchema,
    expectedVersion: expectedVersionSchema,
    comment: z.string().max(10),
  });

  it('expose les champs fautifs sans jamais renvoyer les valeurs reçues', () => {
    const sentinel = 'sentinelle-commentaire-confidentiel-Z9X8';
    const parsed = commandSchema.safeParse({
      clientEventId: 'sentinelle-identifiant-Q7W6',
      expectedVersion: -3,
      comment: sentinel,
    });

    expect(parsed.success).toBe(false);
    const error = parsed.error;
    expect(error).toBeInstanceOf(ZodError);
    if (error === undefined) {
      throw new Error('la validation aurait dû échouer');
    }

    const body: ErrorBody = toErrorBody(error, 'req_11111111-2222-4333-8444-555555555555');
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details).toStrictEqual({
      fields: ['clientEventId', 'expectedVersion', 'comment'],
    });

    const payload = JSON.stringify(body);
    expect(payload).not.toContain(sentinel);
    expect(payload).not.toContain('sentinelle-identifiant-Q7W6');
  });
});

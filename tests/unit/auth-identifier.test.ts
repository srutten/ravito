import { describe, expect, it } from 'vitest';
import { type AppError, isAppError, toErrorBody } from '@/application/errors';
import { createSignInCode, signInCodeSchema } from '@/domain/identity/code';
import { maskIdentifier, parseSignInIdentifier } from '@/domain/identity/identifier';
import { SIGN_IN_CODE_LENGTH } from '@/domain/identity/policy';

/**
 * Identifiant de connexion et code à usage unique : forme, normalisation, refus.
 *
 * CE FICHIER EST D'ABORD UN FICHIER DE TESTS NÉGATIFS. La normalisation positive tient en trois
 * lignes ; ce qui compte, c'est que la validation ne consulte jamais l'état stocké, que le motif
 * de refus ne dise rien de l'existence d'un compte, et que la valeur saisie ne ressorte nulle
 * part — ni dans le message, ni dans les détails de l'erreur, qui traversent le réseau et les
 * journaux (docs/api-contract.md, docs/privacy-rgpd.md).
 *
 * NORMALISATION DU TÉLÉPHONE. La story la demande ; le produit livré la refuse. `docs/screens.md`
 * écran 2 et `docs/api-contract.md` imposent qu'un numéro soit rejeté par `VALIDATION_ERROR` tant
 * que le canal SMS n'existe pas : accepter une saisie dont la plateforme ne fera rien produirait
 * une attente sans fin. La seule normalisation de téléphone réellement livrée est celle du schéma
 * (E.164 strict), éprouvée dans `tests/integration/auth-identity-flow.test.ts`. Ici, on vérifie que
 * le refus est explicite et distinct de « adresse invalide » : le message doit expliquer, pas
 * laisser corriger indéfiniment une saisie correcte.
 */

/** Sentinelle : jamais une adresse réelle, et reconnaissable si elle ressortait quelque part. */
const SENTINEL_LOCAL_PART = 'sentinelle-identifiant-K7M2';

function rejectionOf(raw: unknown): AppError {
  try {
    parseSignInIdentifier(raw);
  } catch (error) {
    if (isAppError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error(`la saisie ${JSON.stringify(raw)} aurait dû être refusée`);
}

function reasonOf(raw: unknown): unknown {
  return rejectionOf(raw).details.reason;
}

describe('parseSignInIdentifier — normalisation du courriel', () => {
  it('met en minuscules et retire les espaces de bordure', () => {
    const parsed = parseSignInIdentifier('   Camille.DUPONT@Exemple.TEST  ');

    expect(parsed.normalized).toBe('camille.dupont@exemple.test');
    expect(parsed.channel).toBe('EMAIL');
  });

  it('produit la MÊME forme normalisée pour toutes les écritures d une même adresse', () => {
    const written = [
      'camille@exemple.test',
      'CAMILLE@EXEMPLE.TEST',
      'Camille@Exemple.Test',
      '\tcamille@exemple.test\n',
      '  cAmIlLe@eXeMpLe.tEsT  ',
    ];

    const normalized = new Set(written.map((raw) => parseSignInIdentifier(raw).normalized));

    // Une seule forme : sans cela, deux écritures d'une même adresse donneraient deux empreintes,
    // donc deux files de défis, et la limitation de tentatives se contournerait en changeant la
    // casse.
    expect(normalized).toStrictEqual(new Set(['camille@exemple.test']));
  });

  it('ne met en minuscules QUE l ASCII, comme lower() sous locale C', () => {
    // Le schéma contraint `email::text = btrim(lower(email::text))`. `toLowerCase()` de JavaScript
    // traite tout l'Unicode, `lower()` de PostgreSQL sous locale C ne traite que l'ASCII : sur une
    // adresse accentuée les deux divergeraient et l'insertion violerait la contrainte, en pleine
    // connexion. Le refus en amont est ce qui rend la divergence impossible.
    expect(reasonOf('CAMILLE.DÉPÔT@exemple.test')).toBe('IDENTIFIER_NOT_ASCII');
    expect(reasonOf('camille@exemple.tëst')).toBe('IDENTIFIER_NOT_ASCII');
  });

  it('conserve la casse du domaine sous forme minuscule et n altère rien d autre', () => {
    const parsed = parseSignInIdentifier('Pre-Nom.Nom+etiquette@Sous-Domaine.Exemple.test');

    expect(parsed.normalized).toBe('pre-nom.nom+etiquette@sous-domaine.exemple.test');
  });

  it('accepte la longueur maximale du contrat et refuse un caractère de plus', () => {
    const domain = '@exemple.test';
    const exact = `${'a'.repeat(254 - domain.length)}${domain}`;
    expect(exact).toHaveLength(254);
    expect(parseSignInIdentifier(exact).normalized).toBe(exact);

    expect(reasonOf(`a${exact}`)).toBe('IDENTIFIER_TOO_LONG');
  });
});

describe('parseSignInIdentifier — refus', () => {
  it('refuse une saisie vide', () => {
    expect(reasonOf('')).toBe('IDENTIFIER_REQUIRED');
    expect(reasonOf('     ')).toBe('IDENTIFIER_REQUIRED');
  });

  it('refuse une saisie qui n est pas une chaîne', () => {
    for (const raw of [undefined, null, 42, true, {}, ['camille@exemple.test']]) {
      expect(rejectionOf(raw).code).toBe('VALIDATION_ERROR');
    }
  });

  it('refuse un numéro de téléphone en DISANT que le canal n est pas disponible', () => {
    // Le motif compte autant que le refus : « adresse invalide » laisserait l'utilisateur corriger
    // indéfiniment une saisie parfaitement correcte (docs/screens.md, écran 2).
    const numbers = [
      '0612345678',
      '06 12 34 56 78',
      '+33612345678',
      '+33 6 12 34 56 78',
      '+33 (0)6-12-34-56-78',
      '06.12.34.56.78',
    ];

    for (const number of numbers) {
      expect(reasonOf(number), `saisie refusée : ${number}`).toBe('PHONE_CHANNEL_UNAVAILABLE');
    }
  });

  it('refuse une adresse malformée', () => {
    for (const raw of ['camille', 'camille@', '@exemple.test', 'camille@exemple', 'a@@b.test']) {
      expect(reasonOf(raw), `saisie refusée : ${raw}`).toBe('IDENTIFIER_MALFORMED');
    }
  });

  it('range une adresse contenant une espace parmi les caractères non pris en charge', () => {
    // COMPORTEMENT RÉEL, consigné plutôt que souhaité. L'espace (0x20) est hors de
    // `[\x21-\x7e]`, donc la saisie tombe dans `IDENTIFIER_NOT_ASCII`, dont le libellé parle
    // d'accents. Le refus est correct — une adresse ne contient pas d'espace — mais le message
    // affiché n'explique pas la vraie cause. Écart mineur, sans conséquence de sécurité, signalé
    // au rapport plutôt que corrigé ici.
    expect(reasonOf('camille dupont@exemple.test')).toBe('IDENTIFIER_NOT_ASCII');
  });

  it('ne recopie JAMAIS la saisie dans l erreur renvoyée', () => {
    const raw = `${SENTINEL_LOCAL_PART}@exemple`;

    const error = rejectionOf(raw);
    const serialized = JSON.stringify(
      toErrorBody(error, 'req_11111111-2222-4333-8444-555555555555'),
    );

    // Le corps d'erreur part sur le réseau et se retrouve dans les traces d'un navigateur, d'un
    // mandataire et d'un journal d'accès. Une adresse recopiée là est une adresse de plus dans
    // trois systèmes que personne ne maîtrise (docs/observability.md, docs/privacy-rgpd.md).
    expect(serialized).not.toContain(SENTINEL_LOCAL_PART);
    expect(serialized).toContain('VALIDATION_ERROR');
  });

  it('désigne le champ fautif sans jamais nommer un compte', () => {
    const error = rejectionOf('camille');

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.httpStatus).toBe(400);
    expect(error.details.fields).toStrictEqual(['identifier']);
    // Le verdict ne dépend que de la FORME : il est identique pour une adresse rattachée à un
    // compte et pour une adresse qui n'existe pas, aucune consultation de la base n'ayant lieu.
    expect(Object.keys(error.details).sort()).toStrictEqual(['fields', 'reason']);
  });
});

describe('maskIdentifier', () => {
  it('ne laisse subsister que la première lettre et le domaine', () => {
    expect(maskIdentifier('camille.dupont@exemple.test')).toBe('c***@exemple.test');
  });

  it('ne rend rien quand la valeur n est pas une adresse', () => {
    expect(maskIdentifier('camille')).toBe('***');
    expect(maskIdentifier('@exemple.test')).toBe('***');
    expect(maskIdentifier('')).toBe('***');
  });

  it('ne contient jamais la partie locale complète', () => {
    const masked = maskIdentifier(`${SENTINEL_LOCAL_PART.toLowerCase()}@exemple.test`);

    expect(masked).not.toContain(SENTINEL_LOCAL_PART.toLowerCase());
    expect(masked).toBe('s***@exemple.test');
  });
});

describe('createSignInCode', () => {
  it('tire un code de six chiffres décimaux', () => {
    for (let index = 0; index < 200; index += 1) {
      expect(createSignInCode()).toMatch(/^\d{6}$/);
    }
  });

  it('conserve les zéros de tête et couvre réellement l espace de tirage', () => {
    const drawn = new Set<string>();
    let withLeadingZero = false;
    for (let index = 0; index < 3_000; index += 1) {
      const code = createSignInCode();
      drawn.add(code);
      withLeadingZero ||= code.startsWith('0');
    }

    // Écarter les codes à zéro de tête réduirait l'espace de tirage de dix pour cent et rendrait
    // la longueur affichée variable.
    expect(withLeadingZero).toBe(true);
    // Un générateur constant ou fortement biaisé produirait bien moins de valeurs distinctes.
    expect(drawn.size).toBeGreaterThan(2_900);
  });

  it('respecte la longueur annoncée par la politique', () => {
    expect(SIGN_IN_CODE_LENGTH).toBe(6);
    expect(createSignInCode()).toHaveLength(SIGN_IN_CODE_LENGTH);
  });
});

describe('signInCodeSchema', () => {
  it('accepte six chiffres, espaces de bordure compris', () => {
    expect(signInCodeSchema.parse('  004821 ')).toBe('004821');
  });

  it('refuse toute autre forme', () => {
    for (const raw of ['12345', '1234567', '12 34 56', 'abcdef', '', '  ', '12345a', 42, null]) {
      expect(signInCodeSchema.safeParse(raw).success, `code refusé : ${String(raw)}`).toBe(false);
    }
  });
});

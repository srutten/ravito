import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LE JOURNALISEUR EST DOUBLÉ, ET UNIQUEMENT LUI.
 *
 * `parseOrganizationId` écrit désormais le motif réel de son refus par
 * `denyOrganizationAccess`, qui appelle `getRequestLogger()`. Hors requête, cette fonction rend
 * l'instance racine, laquelle écrit sur la sortie standard : sans doublure, ce fichier
 * imprimerait une trentaine de lignes JSON à chaque exécution, et surtout la ligne resterait
 * INOBSERVABLE — donc non éprouvée, alors que c'est elle qui rend le balayage visible à
 * l'alerte.
 *
 * La doublure ne remplace PAS `denyOrganizationAccess` : la production traversée par ce fichier
 * est la vraie, du refus jusqu'aux champs de la ligne. Seule la destination est interceptée.
 */
const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock('@/observability/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/observability/logger')>();
  const stub = { warn: logWarn } as unknown as ReturnType<typeof actual.getRequestLogger>;
  return { ...actual, getRequestLogger: (): typeof stub => stub };
});

import type { AppError } from '@/application/errors';
import { isAppError } from '@/application/errors';
import { ORGANIZATION_TYPES } from '@/domain/organizations/types';
import {
  parseCreateOrganizationPayload,
  parseOrganizationId,
  parseUpdateOrganizationPayload,
} from '@/domain/organizations/validation';

/**
 * Validation des entrées du module organisations (US-012).
 *
 * POURQUOI CE NIVEAU. Ces trois fonctions sont pures : elles ne touchent ni la base, ni
 * l'horloge, ni la session. Les éprouver ici plutôt qu'à travers une route donne deux
 * choses qu'un test d'intégration ne donne pas. D'abord l'exhaustivité : une borne se teste
 * à la valeur limite ET à la valeur limite plus un, ce qui ferait des dizaines d'appels
 * HTTP pour un verdict identique. Ensuite la localisation du défaut : quand un cas passe
 * ici, il n'y a plus qu'un endroit à regarder.
 *
 * CE QUE CES TESTS PROTÈGENT, et ce n'est pas la commodité du formulaire :
 *
 * 1. LA BASE NE DOIT JAMAIS ARBITRER UNE FAUTE DE SAISIE. Toute contrainte de
 *    `0015_organizations.sql` non doublée ici remonterait en `23514`, converti en
 *    `INTERNAL_ERROR` par l'enveloppe : un 500 pour un champ mal rempli. La plus facile à
 *    manquer est la longueur de la forme NORMALISÉE du numéro d'immatriculation, invisible
 *    à la lecture du corps.
 * 2. AUCUNE VALEUR REÇUE NE RESSORT. `details.fields` ne porte que des noms de champs. Un
 *    corps d'erreur qui renverrait la valeur fautive ferait de la route un miroir de texte
 *    arbitraire, et cette valeur peut être un mot de passe envoyé par erreur.
 * 3. LE SERVEUR DÉCIDE DE L'ÉTAT. `verificationStatus`, `status`, `version`, `id` et le rôle
 *    du créateur ne sont pas des entrées (ADR-016). Un champ inconnu est REFUSÉ et non
 *    ignoré : un client qui enverrait « verificationStatus: VERIFIED » et recevrait 201
 *    croirait avoir été entendu, et c'est l'usurpation d'organisation de
 *    `docs/threat-model.md` qui se glisserait dans cette croyance.
 */

const CLIENT_EVENT_ID = '11111111-2222-4333-8444-555555555555';

/** Corps de création valide, servant de base aux variations d'un seul champ. */
function validCreatePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Exploitation agricole Martin',
    type: 'FARM',
    registrationNumber: 'FICTIF-ORG-0003',
    clientEventId: CLIENT_EVENT_ID,
    ...overrides,
  };
}

/**
 * Seul `try`/`catch` toléré par le style du dépôt : il relance ce qu'il ne reconnaît pas et
 * échoue explicitement quand l'appel a réussi. Un `catch` qui avalerait rendrait vert un
 * test dont la validation ne refuse plus rien.
 */
function captureRefusal(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    if (isAppError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error('ce corps aurait du etre refuse par la validation');
}

function refusedFieldsOf(error: AppError): readonly string[] {
  expect(error.code).toBe('VALIDATION_ERROR');
  expect(error.httpStatus).toBe(400);
  const fields = error.details.fields;
  if (!Array.isArray(fields)) {
    throw new Error('le refus ne porte pas de liste de champs dans details.fields');
  }
  return fields.map(String);
}

/** Champs cités par le refus d'une création. */
function refusedCreateFields(payload: unknown): readonly string[] {
  return refusedFieldsOf(captureRefusal(() => parseCreateOrganizationPayload(payload)));
}

/** Champs cités par le refus d'une modification. */
function refusedUpdateFields(payload: unknown): readonly string[] {
  return refusedFieldsOf(captureRefusal(() => parseUpdateOrganizationPayload(payload)));
}

describe('parseOrganizationId', () => {
  // Le compteur d'appels est remis à zéro explicitement : un test qui compterait les lignes
  // écrites par son voisin ne prouverait rien sur les siennes.
  beforeEach(() => {
    logWarn.mockClear();
  });

  it('rend l identifiant tel quel, sans toucher a la casse', () => {
    // PostgreSQL compare les `uuid` indépendamment de la casse : réécrire la valeur reçue
    // n'apporterait rien et ferait diverger la trace applicative de ce que l'appelant a
    // demandé.
    const upperCase = 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11';

    expect(parseOrganizationId(upperCase)).toBe(upperCase);
    expect(parseOrganizationId(CLIENT_EVENT_ID)).toBe(CLIENT_EVENT_ID);
  });

  it('refuse par NOT_FOUND, jamais par VALIDATION_ERROR', () => {
    // Un identifiant mal formé ne désigne rien : la réponse juste est « cet objet n'existe
    // pas ». Distinguer « mal formé » de « inexistant » n'apprendrait rien d'utile à
    // l'appelant et donnerait à qui sonde des identifiants un signal de plus.
    const rejected = [
      '',
      '   ',
      'pas-un-uuid',
      '11111111-2222-4333-8444',
      `${CLIENT_EVENT_ID} `,
      '123e4567-e89b-42d3-c456-426614174000',
      42,
      null,
      undefined,
      { id: CLIENT_EVENT_ID },
      [CLIENT_EVENT_ID],
    ];

    for (const value of rejected) {
      const error = captureRefusal(() => parseOrganizationId(value));
      expect(error.code, JSON.stringify(value)).toBe('NOT_FOUND');
      expect(error.httpStatus, JSON.stringify(value)).toBe(404);
      expect(error.details, JSON.stringify(value)).toStrictEqual({});
    }
  });

  it('ne renvoie jamais l identifiant refuse dans le corps d erreur', () => {
    const sentinel = 'sentinelle-identifiant-de-chemin-Q7W6';
    const error = captureRefusal(() => parseOrganizationId(sentinel));

    expect(JSON.stringify(error.details)).not.toContain(sentinel);
    expect(error.message).not.toContain(sentinel);
  });

  it('ecrit le motif reel du refus au journal technique', () => {
    /**
     * CE QUE CETTE LIGNE EXISTE POUR RENDRE POSSIBLE. `docs/api-contract.md` ferme l'oracle
     * d'existence — un identifiant inconnu et une organisation dont on n'est pas membre rendent
     * la même réponse, octet pour octet — et promet en contrepartie que le journal technique
     * conserve la cause. Tant que ce chemin restait muet, un balayage mené avec des
     * identifiants QUI NE SONT MÊME PAS DES UUID ne produisait aucune ligne, alors qu'un
     * balayage en UUID bien formés en produisait une par tentative : la métrique « refus
     * d'autorisation » sous-comptait par construction, et l'alerte était aveugle au balayage
     * le moins coûteux à mener.
     */
    const error = captureRefusal(() => parseOrganizationId('pas-un-uuid'));

    expect(error.code).toBe('NOT_FOUND');
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      {
        module: 'organizations',
        organizationId: '(non conforme)',
        errorCode: 'NOT_FOUND',
        reason: 'ORGANIZATION_ABSENT',
      },
      'acces a une organisation refuse',
    );
  });

  it('ne recopie JAMAIS le segment recu dans la ligne de journal', () => {
    // Le segment de chemin est du texte arbitraire, de longueur non bornée, choisi par
    // l'appelant. Le recopier ferait du journal d'exploitation un miroir — la faute même que
    // `src/application/api-route.ts` refuse sur `x-request-id`. Le champ porte donc un marqueur
    // constant, et c'est lui qui regroupe les balayages mal formés au tableau de bord.
    const sentinel = 'sentinelle-journal-N3M2';

    captureRefusal(() => parseOrganizationId(`${sentinel}\n{"injecte":true}`));

    expect(JSON.stringify(logWarn.mock.calls)).not.toContain(sentinel);
  });

  it('n ecrit aucune ligne quand l identifiant est conforme', () => {
    // Le niveau `warn` n'a de sens que s'il ne noie rien : une ligne de refus émise sur un
    // identifiant valide rendrait toute alerte de seuil inutilisable dès le premier jour.
    expect(parseOrganizationId(CLIENT_EVENT_ID)).toBe(CLIENT_EVENT_ID);

    expect(logWarn).not.toHaveBeenCalled();
  });
});

describe('champ name', () => {
  it('accepte les bornes exactes de deux et cent soixante caracteres', () => {
    // Bornes recopiées de `organizations_name_length`. Les tester à la valeur limite ET à la
    // valeur limite plus un est le seul moyen de distinguer `>= 2` de `> 2`.
    expect(parseCreateOrganizationPayload(validCreatePayload({ name: 'ab' })).name).toBe('ab');

    const longest = 'a'.repeat(160);
    expect(parseCreateOrganizationPayload(validCreatePayload({ name: longest })).name).toBe(
      longest,
    );
  });

  it('refuse la borne plus un, dans les deux sens', () => {
    expect(refusedCreateFields(validCreatePayload({ name: 'a' }))).toStrictEqual(['name']);
    expect(refusedCreateFields(validCreatePayload({ name: 'a'.repeat(161) }))).toStrictEqual([
      'name',
    ]);
  });

  it('rogne les espaces de bordure et retient la valeur rognee', () => {
    // La valeur canonique est la valeur rognée, et c'est elle qui entre dans l'empreinte
    // d'idempotence : sans ce rognage, « Ferme Martin » et « Ferme Martin  » seraient deux
    // intentions différentes, donc un conflit là où il n'y a qu'une reprise.
    const parsed = parseCreateOrganizationPayload(validCreatePayload({ name: '  Ferme Martin  ' }));

    expect(parsed.name).toBe('Ferme Martin');
  });

  it('applique les bornes APRES le rognage', () => {
    // « ' a ' » compte trois caractères bruts et un seul une fois rogné : le compter avant
    // de rogner laisserait passer un nom d'un caractère, que `organizations_name_length`
    // refuserait ensuite avec un 500.
    expect(refusedCreateFields(validCreatePayload({ name: ' a ' }))).toStrictEqual(['name']);
    expect(refusedCreateFields(validCreatePayload({ name: '   ' }))).toStrictEqual(['name']);
  });

  it('refuse ce qui n est pas une chaine, sans jamais convertir', () => {
    // Une conversion implicite ferait d'un nombre un nom d'organisation valide.
    for (const value of [42, null, true, {}, [], ['Ferme']]) {
      expect(
        refusedCreateFields(validCreatePayload({ name: value })),
        JSON.stringify(value),
      ).toStrictEqual(['name']);
    }
  });

  it('refuse un nom manquant', () => {
    const payload = {
      type: 'FARM',
      registrationNumber: 'FICTIF-ORG-0003',
      clientEventId: CLIENT_EVENT_ID,
    };

    expect(refusedCreateFields(payload)).toStrictEqual(['name']);
  });

  it('refuse un octet nul, que la base ne sait stocker sur aucune colonne textuelle', () => {
    // CE TEST ÉPROUVE UN REFUS, LÀ OÙ IL FIGEAIT UN ÉCART. `nameSchema` ne porte aucune
    // expression régulière : sans filtre explicite, un nom porteur d'un octet nul traversait
    // la validation et faisait échouer l'ÉCRITURE — `22021 invalid byte sequence for encoding
    // "UTF8": 0x00` —, converti en `INTERNAL_ERROR` par l'enveloppe. Un 500 rendu à une saisie
    // ordinaire : un corps dont le nom porte cet octet est du JSON parfaitement valide, et
    // `postgres-errors.ts` ne convertit que `23505`.
    //
    // AUCUN OCTET NUL N'EST ÉCRIT EN LITTÉRAL dans ce fichier — il est construit par
    // `String.fromCharCode`, même règle que les caractères hors BMP plus bas : déposé tel quel
    // dans une source, il est invisible à la relecture et fait passer le fichier pour binaire.
    //
    // LA PROPRIÉTÉ ÉPROUVÉE EST CELLE DE L'EN-TÊTE DU MODULE : ce que la validation accepte, la
    // base l'accepte. Elle ne se réduit pas aux contraintes `CHECK` recopiées — l'octet nul est
    // refusé par l'encodage lui-même, avant qu'aucune contrainte ait la parole.
    const nul = String.fromCharCode(0);

    // Le refus vaut à toute position, y compris aux bords, où `.trim()` ne le retire pas.
    for (const name of [
      `Ferme${nul}Martin`,
      `${nul}Ferme Martin`,
      `Ferme Martin${nul}`,
      nul.repeat(4),
    ]) {
      expect(refusedCreateFields(validCreatePayload({ name })), JSON.stringify(name)).toStrictEqual(
        ['name'],
      );
      expect(refusedUpdateFields({ expectedVersion: 1, name }), JSON.stringify(name)).toStrictEqual(
        ['name'],
      );
    }

    // TÉMOIN : le même nom sans l'octet nul est accepté. Sans lui, un `nameSchema` qui
    // refuserait tout passerait ce test.
    expect(parseCreateOrganizationPayload(validCreatePayload({ name: 'FermeMartin' })).name).toBe(
      'FermeMartin',
    );
  });

  it('ne renvoie jamais le nom refuse dans le corps d erreur', () => {
    // Même règle que pour le numéro d'immatriculation : le refus cite le CHAMP, jamais la
    // valeur. Un nom peut être une saisie erronée dans le mauvais formulaire.
    const sentinel = `sentinelle-nom-Q4R5${String.fromCharCode(0)}`;
    const error = captureRefusal(() =>
      parseCreateOrganizationPayload(validCreatePayload({ name: sentinel })),
    );

    expect(refusedFieldsOf(error)).toStrictEqual(['name']);
    expect(JSON.stringify(error.details)).not.toContain('sentinelle-nom-Q4R5');
    expect(error.message).not.toContain('sentinelle-nom-Q4R5');
  });
});

describe('champ type, vocabulaire ferme', () => {
  it('accepte exactement les cinq natures de structure', () => {
    // Le référentiel est fermé et recopié de `0014_organization-enums.sql`. Une valeur
    // ajoutée ici sans migration produirait un `invalid input value for enum` à l'insertion.
    expect(ORGANIZATION_TYPES).toHaveLength(5);

    for (const type of ORGANIZATION_TYPES) {
      expect(parseCreateOrganizationPayload(validCreatePayload({ type })).type, type).toBe(type);
    }
  });

  it('refuse toute valeur hors du vocabulaire, la casse comprise', () => {
    // Aucune tolérance de casse : le type est un identifiant de type énuméré, pas un mot
    // saisi par une personne. L'accepter en minuscules obligerait à choisir une conversion,
    // donc à réécrire en silence une valeur que le journal d'audit doit refléter.
    for (const value of ['farm', 'Farm', ' FARM', 'OTHER', 'ORG_ADMIN', '', null, 0, true]) {
      expect(
        refusedCreateFields(validCreatePayload({ type: value })),
        JSON.stringify(value),
      ).toStrictEqual(['type']);
    }
  });

  it('refuse un type manquant', () => {
    const payload = {
      name: 'Exploitation agricole Martin',
      registrationNumber: 'FICTIF-ORG-0003',
      clientEventId: CLIENT_EVENT_ID,
    };

    expect(refusedCreateFields(payload)).toStrictEqual(['type']);
  });
});

describe('champ registrationNumber, forme brute et forme normalisee', () => {
  it('accepte les bornes exactes de quatre et soixante-quatre caracteres', () => {
    expect(
      parseCreateOrganizationPayload(validCreatePayload({ registrationNumber: 'ABCD' }))
        .registrationNumber,
    ).toBe('ABCD');

    const longest = 'A'.repeat(64);
    expect(
      parseCreateOrganizationPayload(validCreatePayload({ registrationNumber: longest }))
        .registrationNumber,
    ).toBe(longest);
  });

  it('refuse la borne plus un, dans les deux sens', () => {
    expect(refusedCreateFields(validCreatePayload({ registrationNumber: 'ABC' }))).toStrictEqual([
      'registrationNumber',
    ]);
    expect(
      refusedCreateFields(validCreatePayload({ registrationNumber: 'A'.repeat(65) })),
    ).toStrictEqual(['registrationNumber']);
  });

  it('accepte deux ecritures du meme numero et conserve chacune telle qu elle a ete saisie', () => {
    // C'EST LE POINT DÉLICAT DE CE CHAMP. La validation ne normalise PAS pour écrire : elle
    // ne normalise que pour mesurer une longueur. La forme stockée est celle saisie, et
    // c'est la colonne générée de `0015_organizations.sql` qui calcule la forme normalisée
    // portant l'unicité. Normaliser ici pour écrire ferait deux chemins de normalisation,
    // qui finiraient par diverger, et l'unicité ne porterait plus sur la même chose selon
    // l'origine de l'écriture. Ces trois écritures désignent donc le même numéro pour la
    // base, tout en restant distinctes à l'affichage.
    const writings = ['123 456-789', '123456789', '123.456/789'];

    for (const writing of writings) {
      const parsed = parseCreateOrganizationPayload(
        validCreatePayload({ registrationNumber: writing }),
      );
      expect(parsed.registrationNumber, writing).toBe(writing);
    }

    // La forme normalisée n'est jamais rendue par la validation : rien dans le résultat
    // canonique ne porte les séparateurs retirés.
    const canonical = parseCreateOrganizationPayload(
      validCreatePayload({ registrationNumber: '123 456-789' }),
    );
    expect(Object.values(canonical)).not.toContain('123456789');
  });

  it('refuse un numero dont la forme NORMALISEE tombe sous quatre caracteres', () => {
    // Borne invisible à la lecture du corps : « 12-3 » fait quatre caractères bruts et trois
    // une fois les séparateurs retirés. Sans ce contrôle, la contrainte
    // `organizations_registration_number_normalized_length` rendrait un 500 pour une saisie.
    for (const value of ['12-3', '1.2/3', '1-2-3', 'A B C', '1 2 3']) {
      expect(
        refusedCreateFields(validCreatePayload({ registrationNumber: value })),
        value,
      ).toStrictEqual(['registrationNumber']);
    }

    // Juste au-dessus de la borne normalisée : accepté.
    expect(
      parseCreateOrganizationPayload(validCreatePayload({ registrationNumber: '12-34' }))
        .registrationNumber,
    ).toBe('12-34');
  });

  it('refuse un caractere hors de la classe autorisee', () => {
    // Classe recopiée de `organizations_registration_number_shape`. Le souligné, le signe
    // plus, la virgule et les lettres accentuées en sont absents.
    for (const value of ['ABC_123', 'ABC+123', 'ABC,123', 'é1234', 'ABC#123', 'ABC\n123']) {
      expect(
        refusedCreateFields(validCreatePayload({ registrationNumber: value })),
        value,
      ).toStrictEqual(['registrationNumber']);
    }
  });

  it('refuse un separateur en tete ou en fin', () => {
    for (const value of ['-1234', '1234-', '.1234', '1234/', ' -1234 ']) {
      expect(
        refusedCreateFields(validCreatePayload({ registrationNumber: value })),
        value,
      ).toStrictEqual(['registrationNumber']);
    }
  });

  it('rogne les espaces de bordure', () => {
    const parsed = parseCreateOrganizationPayload(
      validCreatePayload({ registrationNumber: ' FICTIF-ORG-0003 ' }),
    );

    expect(parsed.registrationNumber).toBe('FICTIF-ORG-0003');
  });

  it('refuse un numero manquant', () => {
    const payload = {
      name: 'Exploitation agricole Martin',
      type: 'FARM',
      clientEventId: CLIENT_EVENT_ID,
    };

    expect(refusedCreateFields(payload)).toStrictEqual(['registrationNumber']);
  });

  it('ne renvoie jamais le numero refuse dans le corps d erreur', () => {
    // Le numéro d'immatriculation ne doit apparaître ni dans un journal, ni dans une réponse
    // d'erreur : il sert à confronter la déclaration à un registre public, et le renvoyer
    // dans un refus ferait de la route un miroir exploitable pour l'énumération.
    const sentinel = 'SENTINELLE_IMMAT_Z9X8';
    const error = captureRefusal(() =>
      parseCreateOrganizationPayload(validCreatePayload({ registrationNumber: sentinel })),
    );

    expect(JSON.stringify(error.details)).not.toContain(sentinel);
    expect(error.message).not.toContain(sentinel);
  });
});

describe('champ territoryCode a la creation', () => {
  it('traite ABSENT, null et chaine vide comme aucun perimetre declare', () => {
    // À la CRÉATION, les trois écritures disent la même chose : une organisation nationale
    // n'a pas de périmètre. Les distinguer obligerait un formulaire à choisir entre ne pas
    // envoyer la clé et l'envoyer vide, choix sans conséquence métier.
    const absent = parseCreateOrganizationPayload(validCreatePayload());
    const explicitNull = parseCreateOrganizationPayload(
      validCreatePayload({ territoryCode: null }),
    );
    const empty = parseCreateOrganizationPayload(validCreatePayload({ territoryCode: '' }));

    expect(absent.territoryCode).toBeNull();
    expect(explicitNull.territoryCode).toBeNull();
    expect(empty.territoryCode).toBeNull();
  });

  it('accepte un code conforme et le rogne', () => {
    expect(
      parseCreateOrganizationPayload(validCreatePayload({ territoryCode: 'ZZ-DEMO-02' }))
        .territoryCode,
    ).toBe('ZZ-DEMO-02');
    expect(
      parseCreateOrganizationPayload(validCreatePayload({ territoryCode: ' ZZ-01 ' }))
        .territoryCode,
    ).toBe('ZZ-01');
  });

  it('accepte la borne exacte de seize caracteres et refuse dix-sept', () => {
    const longest = `Z${'Z'.repeat(15)}`;
    expect(longest).toHaveLength(16);

    expect(
      parseCreateOrganizationPayload(validCreatePayload({ territoryCode: longest })).territoryCode,
    ).toBe(longest);
    expect(refusedCreateFields(validCreatePayload({ territoryCode: `${longest}Z` }))).toStrictEqual(
      ['territoryCode'],
    );
  });

  it('refuse les minuscules AU LIEU de les convertir', () => {
    // Aucune conversion de casse : la valeur reçue est inscrite telle quelle dans
    // `before`/`after` du journal d'audit. Une majuscule posée à l'insu de l'appelant rendrait
    // « zz-01 » et « ZZ-01 » indiscernables dans la preuve.
    expect(refusedCreateFields(validCreatePayload({ territoryCode: 'zz-01' }))).toStrictEqual([
      'territoryCode',
    ]);
    expect(refusedCreateFields(validCreatePayload({ territoryCode: 'Zz-01' }))).toStrictEqual([
      'territoryCode',
    ]);
  });

  it('refuse une forme non conforme', () => {
    for (const value of ['-ZZ01', 'ZZ 01', '   ', 'ZZ_01', 'ZZ.01', 42, true, {}]) {
      expect(
        refusedCreateFields(validCreatePayload({ territoryCode: value })),
        JSON.stringify(value),
      ).toStrictEqual(['territoryCode']);
    }
  });
});

describe('champ clientEventId', () => {
  it('accepte un identifiant tire au hasard', () => {
    const clientEventId = randomUUID();

    expect(
      parseCreateOrganizationPayload(validCreatePayload({ clientEventId })).clientEventId,
    ).toBe(clientEventId);
  });

  it('est obligatoire a la creation', () => {
    // Sans lui, aucune idempotence : un double appui créerait deux organisations jumelles
    // dont l'une resterait dans la file de validation sans que personne sache laquelle fait foi.
    const payload = {
      name: 'Exploitation agricole Martin',
      type: 'FARM',
      registrationNumber: 'FICTIF-ORG-0003',
    };

    expect(refusedCreateFields(payload)).toStrictEqual(['clientEventId']);
  });

  it('refuse ce qui n est pas un UUID', () => {
    for (const value of [
      'abc',
      '',
      '11111111-2222-4333-8444',
      `${CLIENT_EVENT_ID} `,
      '123e4567-e89b-42d3-c456-426614174000',
      42,
      null,
      { id: CLIENT_EVENT_ID },
    ]) {
      expect(
        refusedCreateFields(validCreatePayload({ clientEventId: value })),
        JSON.stringify(value),
      ).toStrictEqual(['clientEventId']);
    }
  });

  it('accepte l UUID nul, CONSTAT et non souhait', () => {
    // `z.uuid()` accepte `00000000-0000-0000-0000-000000000000`. Un client dont le tirage
    // d'UUID échoue silencieusement enverrait cette valeur : sa première création
    // aboutirait, et toute création ultérieure d'un AUTRE acteur avec la même valeur
    // recevrait `IDEMPOTENCY_CONFLICT` — la portée de `client_event_id` étant globale
    // (0017). Le refus est sûr, mais le blocage est durable. Écart signalé, pas corrigé ici.
    const nil = '00000000-0000-0000-0000-000000000000';

    expect(
      parseCreateOrganizationPayload(validCreatePayload({ clientEventId: nil })).clientEventId,
    ).toBe(nil);
  });

  it('est refuse dans une modification, ou il n a pas de sens', () => {
    // `PATCH` n'est pas idempotent par clé mais par version attendue : accepter le champ
    // laisserait croire à une protection contre le rejeu qui n'existe pas.
    expect(
      refusedUpdateFields({ expectedVersion: 1, name: 'Ferme', clientEventId: CLIENT_EVENT_ID }),
    ).toStrictEqual(['clientEventId']);
  });
});

describe('champ expectedVersion', () => {
  it('est obligatoire a la modification', () => {
    expect(refusedUpdateFields({ name: 'Ferme Martin' })).toStrictEqual(['expectedVersion']);
  });

  it('est refuse a la creation, ou aucune version n existe encore', () => {
    expect(refusedCreateFields(validCreatePayload({ expectedVersion: 1 }))).toStrictEqual([
      'expectedVersion',
    ]);
  });

  it('refuse ce qui n est pas un entier positif ou nul', () => {
    for (const value of ['1', 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, true, null, {}]) {
      expect(
        refusedUpdateFields({ expectedVersion: value, name: 'Ferme Martin' }),
        String(value),
      ).toStrictEqual(['expectedVersion']);
    }
  });

  it('accepte zero, ECART CONNU et assume', () => {
    // La première version d'une organisation est 1 (ADR-019) : zéro est syntaxiquement
    // valide et sémantiquement impossible. Il produit `VERSION_CONFLICT` à l'exécution, et
    // jamais `VALIDATION_ERROR`. Le schéma est partagé par des agrégats dont la première
    // version n'est pas encore arbitrée ; l'écart est inscrit au CHANGELOG.
    const parsed = parseUpdateOrganizationPayload({ expectedVersion: 0, name: 'Ferme Martin' });

    expect(parsed.expectedVersion).toBe(0);
  });
});

describe('champs inconnus et decisions reservees au serveur', () => {
  it('refuse un etat fourni en entree, au lieu de l ignorer', () => {
    // Ignorer silencieusement `verificationStatus: VERIFIED` renverrait 201 à un appelant
    // convaincu d'avoir obtenu une organisation vérifiée. Le refus est le contrôle lui-même.
    const forbidden = ['verificationStatus', 'status', 'version', 'id', 'role'];

    for (const field of forbidden) {
      const payload = validCreatePayload({ [field]: 'VERIFIED' });
      expect(refusedCreateFields(payload), field).toStrictEqual([field]);
    }
  });

  it('refuse un role fourni en entree lors d une modification', () => {
    // Le créateur devient `ORG_ADMIN` par décision du serveur (ADR-016) ; nul ne demande son
    // rôle, ni à la création, ni ensuite.
    expect(
      refusedUpdateFields({
        expectedVersion: 1,
        name: 'Ferme Martin',
        role: 'PLATFORM_ADMIN',
      }),
    ).toStrictEqual(['role']);
  });

  it('refuse un champ inconnu quelconque', () => {
    expect(refusedCreateFields(validCreatePayload({ commentaire: 'bonjour' }))).toStrictEqual([
      'commentaire',
    ]);
    expect(
      refusedUpdateFields({ expectedVersion: 1, name: 'Ferme Martin', commentaire: 'bonjour' }),
    ).toStrictEqual(['commentaire']);
  });

  it('cite le nom du champ inconnu mais JAMAIS sa valeur', () => {
    // Aucune de ces routes n'accepte de mot de passe. Le nom `password` est conforme au
    // motif de nom sûr, il ressort donc tel quel ; la valeur, elle, ne sort jamais.
    const sentinel = 'sentinelle-mot-de-passe-Z9X8';
    const error = captureRefusal(() =>
      parseCreateOrganizationPayload(validCreatePayload({ password: sentinel })),
    );

    expect(refusedFieldsOf(error)).toStrictEqual(['password']);
    expect(JSON.stringify(error.details)).not.toContain(sentinel);
  });

  it('remplace un nom de cle non conforme par une etiquette neutre', () => {
    // Sans ce filtre, la réponse d'erreur deviendrait un miroir de texte arbitraire : il
    // suffirait d'envoyer une clé nommée comme une charge utile pour la faire renvoyer par
    // le serveur.
    const unsafeKeys = ['a-b', '<script>alert(1)</script>', '0nom', '_prive', 'x'.repeat(41), ' '];

    for (const key of unsafeKeys) {
      const payload: Record<string, unknown> = validCreatePayload({ [key]: 'valeur' });
      expect(refusedCreateFields(payload), key).toStrictEqual(['(inconnu)']);
    }
  });

  it('neutralise une cle __proto__ recue en JSON, sans polluer le prototype', () => {
    // `JSON.parse` fabrique une propriété PROPRE nommée `__proto__`, là où un littéral
    // modifierait le prototype. Le résultat mesuré ici est une EXCEPTION à la règle « un
    // champ inconnu est refusé, jamais ignoré » : le schéma de racine `z.record` retire
    // cette clé avant que `rejectUnknownFields` ne la voie, si bien qu'elle est SILENCIEUSEMENT
    // ÉCARTÉE au lieu d'être citée. L'écart est sans conséquence de sécurité — la valeur est
    // jetée, aucun prototype n'est modifié, et un corps qui ne porterait que cette clé reste
    // refusé faute des quatre champs obligatoires — mais il est réel et signalé comme tel.
    const emptyPayload: unknown = JSON.parse('{"__proto__":{"pollue":true}}');

    expect(refusedCreateFields(emptyPayload)).toStrictEqual([
      'clientEventId',
      'name',
      'registrationNumber',
      'type',
    ]);

    const fullPayload: unknown = JSON.parse(
      `{"name":"Exploitation agricole Martin","type":"FARM",
        "registrationNumber":"FICTIF-ORG-0003","clientEventId":"${CLIENT_EVENT_ID}",
        "__proto__":{"pollue":true}}`,
    );
    const parsed = parseCreateOrganizationPayload(fullPayload);

    expect(parsed.name).toBe('Exploitation agricole Martin');
    expect(Object.hasOwn(parsed, 'pollue')).toBe(false);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.hasOwn({}, 'pollue')).toBe(false);
  });
});

describe('collecte de toutes les fautes en une passe', () => {
  it('cite les quatre champs obligatoires manquants pour un corps vide', () => {
    // Un formulaire qui ne signalerait qu'un champ à la fois se corrigerait en autant
    // d'allers-retours qu'il compte d'erreurs, sur un téléphone, dans un contexte d'urgence.
    expect(refusedCreateFields({})).toStrictEqual([
      'clientEventId',
      'name',
      'registrationNumber',
      'type',
    ]);
  });

  it('cite TOUS les champs fautifs, y compris les champs interdits, en une seule reponse', () => {
    const payload = {
      name: 'a',
      type: 'farm',
      registrationNumber: '12-3',
      territoryCode: 'zz-01',
      clientEventId: 'pas-un-uuid',
      verificationStatus: 'VERIFIED',
      role: 'PLATFORM_ADMIN',
    };

    // Liste TRIÉE et dédoublonnée : l'ordre ne dépend donc pas de celui des clés reçues.
    expect(refusedCreateFields(payload)).toStrictEqual([
      'clientEventId',
      'name',
      'registrationNumber',
      'role',
      'territoryCode',
      'type',
      'verificationStatus',
    ]);
  });

  it('cite a la fois le champ manquant et l absence de champ modifiable', () => {
    expect(refusedUpdateFields({})).toStrictEqual(['(inconnu)', 'expectedVersion']);
  });

  it('ne cite jamais deux fois le meme champ', () => {
    const fields = refusedCreateFields({ name: 42, type: 'farm', registrationNumber: 42 });

    expect(new Set(fields).size).toBe(fields.length);
  });
});

describe('corps qui n est pas un objet JSON', () => {
  it('refuse un tableau, une valeur simple et null par une etiquette neutre', () => {
    // CONSTAT : `readPayloadObject` passe l'étiquette « (racine) » au collecteur, qui la
    // réécrit en « (inconnu) » faute de correspondre au motif de nom sûr. Seule l'erreur
    // d'analyse JSON de la route produit littéralement « (racine) ». Les deux étiquettes
    // coexistent donc pour des causes voisines ; l'écart est signalé, pas contourné.
    for (const payload of [null, undefined, [], ['name'], 'x', 5, true]) {
      expect(refusedCreateFields(payload), JSON.stringify(payload)).toStrictEqual(['(inconnu)']);
      expect(refusedUpdateFields(payload), JSON.stringify(payload)).toStrictEqual(['(inconnu)']);
    }
  });
});

describe('parseUpdateOrganizationPayload, la presence de la cle vaut demande', () => {
  it('ne retient que les champs presents', () => {
    const parsed = parseUpdateOrganizationPayload({
      expectedVersion: 3,
      name: '  Ferme Martin  ',
    });

    expect(parsed).toStrictEqual({
      expectedVersion: 3,
      changes: { name: 'Ferme Martin' },
      touchesIdentity: true,
    });
  });

  it('distingue un territoryCode ABSENT d un territoryCode a null', () => {
    // LA DISTINCTION EST TOUT LE CONTRAT DE CE CHAMP. Absent signifie « ne touche pas au
    // périmètre » ; `null` signifie « retire-le ». Une fois passés par un type TypeScript,
    // `undefined` et « absent » se confondent, `null` et « absent » non : c'est pourquoi le
    // domaine lit le corps brut.
    const absent = parseUpdateOrganizationPayload({ expectedVersion: 1, name: 'Ferme Martin' });
    const removal = parseUpdateOrganizationPayload({ expectedVersion: 1, territoryCode: null });

    expect(Object.hasOwn(absent.changes, 'territoryCode')).toBe(false);
    expect(Object.hasOwn(removal.changes, 'territoryCode')).toBe(true);
    expect(removal.changes.territoryCode).toBeNull();
    expect(removal).toStrictEqual({
      expectedVersion: 1,
      changes: { territoryCode: null },
      touchesIdentity: false,
    });
  });

  it('refuse une chaine vide, contrairement a la creation', () => {
    // Asymétrie assumée : à la création, la chaîne vide est une case laissée vide ; à la
    // modification, elle serait une demande dont l'effet est ambigu — retrait ou valeur
    // vide ? Le retrait s'écrit `null`, sans ambiguïté possible.
    expect(refusedUpdateFields({ expectedVersion: 1, territoryCode: '' })).toStrictEqual([
      'territoryCode',
    ]);
  });

  it('marque la retombee de verification pour les seuls champs d identite', () => {
    // `touchesIdentity` décide de la retombée en attente de validation d'une organisation
    // déjà validée. `territoryCode` en est exclu : c'est un périmètre d'action, pas une
    // identité, et soumettre sa correction à une revalidation dissuaderait de le corriger.
    const identityFields: readonly [string, unknown][] = [
      ['name', 'Ferme Martin'],
      ['type', 'COMPANY'],
      ['registrationNumber', 'FICTIF-ORG-0004'],
    ];

    for (const [field, value] of identityFields) {
      const parsed = parseUpdateOrganizationPayload({ expectedVersion: 1, [field]: value });
      expect(parsed.touchesIdentity, field).toBe(true);
    }

    expect(
      parseUpdateOrganizationPayload({ expectedVersion: 1, territoryCode: 'ZZ-01' })
        .touchesIdentity,
    ).toBe(false);
    expect(
      parseUpdateOrganizationPayload({ expectedVersion: 1, territoryCode: null }).touchesIdentity,
    ).toBe(false);
    expect(
      parseUpdateOrganizationPayload({
        expectedVersion: 1,
        territoryCode: 'ZZ-01',
        name: 'Ferme Martin',
      }).touchesIdentity,
    ).toBe(true);
  });

  it('refuse un corps qui ne porte que expectedVersion', () => {
    // Une requête sans effet qui répondrait 200 laisserait croire à une modification
    // appliquée, et ferait de surcroît avancer la version pour rien.
    expect(refusedUpdateFields({ expectedVersion: 1 })).toStrictEqual(['(inconnu)']);
  });

  it('applique aux modifications les memes bornes qu a la creation', () => {
    // Les schémas sont partagés : une borne relâchée sur un seul des deux chemins serait une
    // porte dérobée pour écrire ce que la création refuse.
    expect(refusedUpdateFields({ expectedVersion: 1, name: 'a' })).toStrictEqual(['name']);
    expect(refusedUpdateFields({ expectedVersion: 1, name: null })).toStrictEqual(['name']);
    expect(refusedUpdateFields({ expectedVersion: 1, type: 'farm' })).toStrictEqual(['type']);
    expect(refusedUpdateFields({ expectedVersion: 1, registrationNumber: '12-3' })).toStrictEqual([
      'registrationNumber',
    ]);
    expect(refusedUpdateFields({ expectedVersion: 1, territoryCode: 'zz-01' })).toStrictEqual([
      'territoryCode',
    ]);
  });

  it('collecte plusieurs fautes de modification en une passe', () => {
    expect(
      refusedUpdateFields({ expectedVersion: '1', name: 'a', territoryCode: 'zz-01' }),
    ).toStrictEqual(['expectedVersion', 'name', 'territoryCode']);
  });
});

describe('longueur mesuree en CARACTERES, comme char_length', () => {
  /**
   * POURQUOI CE BLOC EXISTE, ET CE QU'IL FERME.
   *
   * `organizations_name_length` compte des CARACTÈRES (`char_length`) ; les bornes `.min()`
   * et `.max()` de Zod comptent des UNITÉS UTF-16. Tout caractère hors du plan multilingue
   * de base — n'importe quel émoji, la lettre mathématique employée ici — vaut DEUX pour
   * Zod et UN pour PostgreSQL. Un nom d'un seul de ces caractères traversait donc la
   * validation et faisait sauter la contrainte SQL : 500 pour une saisie ordinaire, et
   * surtout la ligne refusée journalisée en entier par le champ `detail` de l'erreur du
   * pilote, numéro d'immatriculation compris.
   *
   * LA PROPRIÉTÉ ÉPROUVÉE ICI est donc plus large que ces bornes : une entrée acceptée par
   * la validation ne doit JAMAIS pouvoir faire sauter une contrainte SQL.
   *
   * AUCUN CARACTÈRE HORS BMP N'EST ÉCRIT EN LITTÉRAL dans ce fichier, conformément à la
   * règle du dépôt : il est construit par `String.fromCodePoint`.
   */
  const ASTRAL = String.fromCodePoint(0x1d400);

  it('part d un caractere qui vaut deux unites UTF-16 et un caractere', () => {
    // Le postulat du bloc, vérifié plutôt que supposé : sans cet écart entre les deux
    // mesures, aucun des cas suivants ne prouverait quoi que ce soit.
    expect(ASTRAL).toHaveLength(2);
    expect([...ASTRAL]).toHaveLength(1);
  });

  it('refuse un nom d un seul caractere hors BMP, que la base compterait pour un', () => {
    // C'EST L'ENTRÉE QUI OUVRAIT LA FUITE. Elle doit être refusée par la validation, et
    // n'atteindre ni le pilote, ni le journal.
    expect(refusedCreateFields(validCreatePayload({ name: ASTRAL }))).toStrictEqual(['name']);
    expect(refusedUpdateFields({ expectedVersion: 1, name: ASTRAL })).toStrictEqual(['name']);
  });

  it('accepte deux caracteres hors BMP, borne basse exacte', () => {
    const name = ASTRAL.repeat(2);

    expect(parseCreateOrganizationPayload(validCreatePayload({ name })).name).toBe(name);
  });

  it('accepte cent soixante caracteres hors BMP, borne haute exacte', () => {
    // 320 unités UTF-16 pour 160 caractères : l'ancien `max(160)` refusait ce nom que
    // `organizations_name_length` accepte. Un refus injustifié est moins grave qu'une fuite,
    // mais la validation doit accepter EXACTEMENT ce que la base accepte, pas moins.
    const name = ASTRAL.repeat(160);
    expect(name).toHaveLength(320);

    expect(parseCreateOrganizationPayload(validCreatePayload({ name })).name).toBe(name);
  });

  it('refuse cent soixante et un caracteres hors BMP, borne haute plus un', () => {
    expect(refusedCreateFields(validCreatePayload({ name: ASTRAL.repeat(161) }))).toStrictEqual([
      'name',
    ]);
  });

  it('compte un nom mixte comme la base le compterait', () => {
    // Un vrai nom d'organisation mêle les deux : « Ferme Martin » suivi d'un émoji. La borne
    // porte sur le nombre de caractères, quelle que soit la place qu'ils prennent en mémoire.
    const exact = `${ASTRAL.repeat(159)}Z`;
    const excessive = `${ASTRAL.repeat(160)}Z`;
    expect([...exact]).toHaveLength(160);
    expect([...excessive]).toHaveLength(161);

    expect(parseCreateOrganizationPayload(validCreatePayload({ name: exact })).name).toBe(exact);
    expect(refusedCreateFields(validCreatePayload({ name: excessive }))).toStrictEqual(['name']);
  });

  it('mesure la longueur APRES rognage, y compris hors BMP', () => {
    // Un caractère hors BMP entouré d'espaces vaut quatre unités UTF-16 et un seul caractère
    // une fois rogné : compter avant de rogner rouvrirait exactement le même trou.
    expect(refusedCreateFields(validCreatePayload({ name: ` ${ASTRAL} ` }))).toStrictEqual([
      'name',
    ]);
  });

  it('ne relache rien sur le numero d immatriculation ni sur le code de territoire', () => {
    // Ces deux champs sont bornés par une expression régulière purement ASCII, si bien que
    // les deux unités de mesure y coïncident. Le comptage en caractères ne doit donc RIEN y
    // changer : un caractère hors BMP y reste refusé par la forme, à toute longueur.
    for (const count of [1, 2, 4, 33]) {
      expect(
        refusedCreateFields(validCreatePayload({ registrationNumber: ASTRAL.repeat(count) })),
        `numero de ${count} caracteres hors BMP`,
      ).toStrictEqual(['registrationNumber']);
      expect(
        refusedCreateFields(validCreatePayload({ territoryCode: ASTRAL.repeat(count) })),
        `code de ${count} caracteres hors BMP`,
      ).toStrictEqual(['territoryCode']);
    }

    // Et les bornes ASCII restent celles du schéma, dans les deux sens.
    expect(
      parseCreateOrganizationPayload(validCreatePayload({ registrationNumber: 'A'.repeat(64) }))
        .registrationNumber,
    ).toBe('A'.repeat(64));
    expect(
      refusedCreateFields(validCreatePayload({ registrationNumber: 'A'.repeat(65) })),
    ).toStrictEqual(['registrationNumber']);
    expect(
      parseCreateOrganizationPayload(validCreatePayload({ territoryCode: 'Z'.repeat(16) }))
        .territoryCode,
    ).toBe('Z'.repeat(16));
    expect(
      refusedCreateFields(validCreatePayload({ territoryCode: 'Z'.repeat(17) })),
    ).toStrictEqual(['territoryCode']);
  });
});

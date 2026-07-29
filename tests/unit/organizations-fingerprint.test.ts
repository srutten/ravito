import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `timingSafeEqual` est DOUBLÉ, et c'est le seul moyen d'éprouver la comparaison en temps
 * constant.
 *
 * POURQUOI PASSER PAR UNE DOUBLURE. La durée d'un appel ne se mesure pas de façon fiable dans un
 * test : le ramasse-miettes, la compilation à la volée et l'ordonnanceur du système produisent un
 * bruit très supérieur à l'écart cherché, et un seuil chiffré rendrait ce fichier instable sans
 * rien prouver. La seule observable qui reste est L'APPEL LUI-MÊME : à qui la comparaison est
 * déléguée, combien de fois, et sur quels octets. Un verdict rendu sans passer par la primitive du
 * runtime — `===`, une boucle qui sort au premier écart, une comparaison sur un préfixe — devient
 * alors visible, alors qu'il rend exactement les mêmes booléens.
 *
 * LA DOUBLURE NE REMPLACE PAS L'IMPLÉMENTATION : `vi.fn(actual.timingSafeEqual)` délègue à la
 * vraie primitive, si bien que les tests de comportement de ce fichier continuent de mesurer le
 * vrai verdict. Un seul test impose une réponse, et par `mockReturnValueOnce`, dont l'effet
 * s'éteint au premier appel : aucun état ne fuit d'un test à l'autre.
 *
 * Le reste de `node:crypto` est recopié tel quel — `createHmac` et `randomBytes`, dont dépend
 * l'empreinte elle-même, restent les vrais.
 */
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

import { createHash, timingSafeEqual } from 'node:crypto';
import { resetServerConfigCache } from '@/config/env';
import {
  computeRequestFingerprint,
  timingSafeFingerprintEqual,
} from '@/domain/organizations/fingerprint';
import { ORGANIZATION_CREATE_OPERATION } from '@/domain/organizations/policy';
import { parseCreateOrganizationPayload } from '@/domain/organizations/validation';

/**
 * Empreinte de requête des commandes idempotentes (US-012, colonne
 * `idempotency_keys.request_fingerprint`).
 *
 * CE QU'ELLE DÉCIDE. La clé d'idempotence répond à « cette commande a-t-elle déjà été
 * exécutée ? » ; l'empreinte répond à la question suivante, qui n'a pas la même réponse :
 * « la commande présentée est-elle bien la même ? ». Un défaut ici ne se voit pas en
 * lecture, il se voit le jour où quelqu'un reçoit l'organisation d'un autre.
 *
 * CINQ PROPRIÉTÉS SONT ÉPROUVÉES, et chacune ferme une attaque précise :
 *
 * 1. LA CLÉ EST SECRÈTE. Le corps d'une création est à faible entropie — un nom, un type
 *    pris dans cinq valeurs, un numéro à format connu. Un condensé nu se retourne par
 *    énumération, et le vol d'une sauvegarde révélerait exactement ce que la colonne existe
 *    pour ne pas stocker. La preuve testable est directe : l'empreinte change quand le
 *    secret change, et ne vaut aucun condensé nu des mêmes valeurs.
 * 2. L'ACTEUR EST DANS L'EMPREINTE. La portée de `client_event_id` est GLOBALE (0017) : un
 *    second acteur peut présenter une clé déjà employée. Sans l'acteur, il recevrait la
 *    réponse du premier, c'est-à-dire l'organisation d'un tiers.
 * 3. LA CONCATÉNATION EST INJECTIVE. Les valeurs viennent d'un corps arbitraire et peuvent
 *    contenir n'importe quel caractère, y compris celui qu'on aurait pris pour séparateur.
 *    Sans encadrement par la longueur, deux découpages différents des mêmes caractères
 *    donneraient la même empreinte, donc le même rejeu pour deux requêtes différentes.
 * 4. LA SORTIE ENTIÈRE DÉPEND DE LA CLÉ ET DES CHAMPS. Le numéro d'immatriculation, que
 *    `docs/privacy-rgpd.md` interdit de laisser traîner ailleurs que dans sa colonne, ne se
 *    cherche pas « en clair » dans 64 caractères hexadécimaux — cette recherche-là ne peut rien
 *    trouver. Ce qui se mesure, c'est qu'aucune part de la sortie n'échappe à la clé : une moitié
 *    qui lui échapperait se retournerait par énumération sur un corps à faible entropie.
 * 5. LE VERDICT D'ÉGALITÉ VIENT DE `timingSafeEqual`, et porte sur les 32 octets entiers. La durée
 *    ne se mesure pas dans un test ; l'appel, lui, s'observe — voir la doublure ci-dessus.
 */

const FIRST_SECRET = 'secret-de-test-fictif-organisations-un-de-plus-de-32-caracteres';
const SECOND_SECRET = 'secret-de-test-fictif-organisations-deux-de-plus-de-32-caracteres';

const HEX_DIGEST = /^[0-9a-f]{64}$/;

const ACTOR = '11111111-2222-4333-8444-555555555555';
const OTHER_ACTOR = '99999999-8888-4777-8666-555555555555';
const CLIENT_EVENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** Numéro d'immatriculation servant de sentinelle : il ne doit ressortir nulle part. */
const REGISTRATION_NUMBER = 'FICTIF-ORG-0003';

const initialEnvironment = { ...process.env };

/**
 * Le secret est lu par `getServerConfig()`, dont le résultat est mis en cache : le vider
 * avant chaque changement est la seule façon d'observer réellement un secret différent.
 */
function applySecret(secret: string): void {
  resetServerConfigCache();
  process.env.APP_ENV = 'local';
  process.env.APP_VERSION = '0.0.0-test';
  process.env.LOG_LEVEL = 'error';
  process.env.DATABASE_URL = 'postgresql://utilisateur:motdepasse-fictif@localhost:5432/appui_feux';
  process.env.DATABASE_SSL = 'disable';
  process.env.AUTH_SECRET = secret;
}

beforeEach(() => {
  applySecret(FIRST_SECRET);
});

afterAll(() => {
  resetServerConfigCache();
  for (const key of Object.keys(process.env)) {
    if (!(key in initialEnvironment)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, initialEnvironment);
});

/** Empreinte d'une création d'organisation, dans l'ordre de champs de `createOrganization`. */
function fingerprintOfCreation(
  overrides: {
    readonly operation?: string;
    readonly actorUserId?: string;
    readonly name?: string;
    readonly type?: string;
    readonly registrationNumber?: string;
    readonly territoryCode?: string | null;
  } = {},
): string {
  return computeRequestFingerprint({
    operation: overrides.operation ?? ORGANIZATION_CREATE_OPERATION,
    actorUserId: overrides.actorUserId ?? ACTOR,
    fields: [
      overrides.name ?? 'Exploitation agricole Martin',
      overrides.type ?? 'FARM',
      overrides.registrationNumber ?? REGISTRATION_NUMBER,
      overrides.territoryCode === undefined ? 'ZZ-DEMO-01' : overrides.territoryCode,
    ],
  });
}

describe('forme et determinisme', () => {
  it('produit toujours 64 caracteres hexadecimaux minuscules', () => {
    // La contrainte `idempotency_keys_request_fingerprint_format` n'accepte rien d'autre :
    // une empreinte hors format ferait échouer la RÉSERVATION, donc la commande entière.
    expect(fingerprintOfCreation()).toMatch(HEX_DIGEST);
    expect(fingerprintOfCreation({ territoryCode: null })).toMatch(HEX_DIGEST);
    expect(fingerprintOfCreation({ name: 'é'.repeat(160) })).toMatch(HEX_DIGEST);
  });

  it('rend la meme empreinte pour la meme requete', () => {
    // Sans déterminisme, aucun rejeu ne serait jamais reconnu : le client qui a perdu la
    // réponse d'une création recevrait `IDEMPOTENCY_CONFLICT` au lieu de sa réponse.
    expect(fingerprintOfCreation()).toBe(fingerprintOfCreation());
  });
});

describe('ce qui change l empreinte', () => {
  it('change des qu un champ du corps change', () => {
    const reference = fingerprintOfCreation();
    const variations = new Map<string, string>([
      ['nom', fingerprintOfCreation({ name: 'Exploitation agricole Martiv' })],
      ['type', fingerprintOfCreation({ type: 'COMPANY' })],
      ['immatriculation', fingerprintOfCreation({ registrationNumber: 'FICTIF-ORG-0004' })],
      ['territoire', fingerprintOfCreation({ territoryCode: 'ZZ-DEMO-02' })],
      ['territoire retire', fingerprintOfCreation({ territoryCode: null })],
    ]);

    for (const [label, digest] of variations) {
      expect(digest, label).not.toBe(reference);
    }
    // Aucune collision entre les variations elles-mêmes : chaque champ pèse séparément.
    expect(new Set([reference, ...variations.values()]).size).toBe(variations.size + 1);
  });

  it('change quand l ACTEUR change, meme corps et meme cle', () => {
    // C'EST LA PROTECTION CONTRE LA REPRISE DE CLÉ D'AUTRUI. La clé présentée peut être celle
    // d'un tiers : l'empreinte doit alors différer, pour que le second acteur reçoive
    // `IDEMPOTENCY_CONFLICT` — qui ne révèle rien de plus que « cette clé est prise » — et
    // jamais la réponse du premier.
    expect(fingerprintOfCreation({ actorUserId: OTHER_ACTOR })).not.toBe(fingerprintOfCreation());
  });

  it('change quand l OPERATION change', () => {
    // La même clé employée pour une autre commande est une erreur de programmation, pas une
    // reprise : elle doit être refusée comme telle, et non rejouer la réponse d'une commande
    // qui n'a rien à voir.
    expect(fingerprintOfCreation({ operation: 'ORGANIZATION_UPDATE' })).not.toBe(
      fingerprintOfCreation(),
    );
  });

  it('change quand le SECRET change', () => {
    // Preuve que la clé entre dans le calcul : sans elle, l'empreinte serait un condensé nu,
    // que le vol de la seule base suffirait à retourner par énumération.
    const withFirst = fingerprintOfCreation();

    applySecret(SECOND_SECRET);

    expect(fingerprintOfCreation()).not.toBe(withFirst);
  });
});

describe('injectivite de l encadrement', () => {
  it('distingue deux decoupages des memes caracteres', () => {
    // Sans préfixe de longueur, `['ab', 'c']` et `['a', 'bc']` produiraient la même
    // empreinte : deux requêtes différentes se rejoueraient l'une l'autre.
    const left = computeRequestFingerprint({
      operation: ORGANIZATION_CREATE_OPERATION,
      actorUserId: ACTOR,
      fields: ['ab', 'c'],
    });
    const right = computeRequestFingerprint({
      operation: ORGANIZATION_CREATE_OPERATION,
      actorUserId: ACTOR,
      fields: ['a', 'bc'],
    });

    expect(left).not.toBe(right);
  });

  it('distingue la frontiere entre l operation et l acteur', () => {
    // Un corps ne peut pas déplacer la frontière entre les deux premières parties : sinon,
    // un acteur choisi commencerait par la fin d'un nom d'opération et se confondrait avec
    // une autre commande.
    const left = computeRequestFingerprint({ operation: 'AB', actorUserId: 'C', fields: [] });
    const right = computeRequestFingerprint({ operation: 'A', actorUserId: 'BC', fields: [] });

    expect(left).not.toBe(right);
  });

  it('distingue une partie absente d une partie vide', () => {
    // « Aucun territoire déclaré » et « territoire vide » ne sont pas la même intention :
    // les confondre ferait rejouer une création pour une autre.
    const absent = fingerprintOfCreation({ territoryCode: null });
    const empty = fingerprintOfCreation({ territoryCode: '' });

    expect(absent).not.toBe(empty);
  });

  it('ne se laisse pas confondre par un separateur present dans une valeur', () => {
    // Un nom d'organisation peut contenir n'importe quel caractère, deux-points et barre
    // verticale compris. Le test échouerait si l'implémentation revenait à un séparateur.
    const left = computeRequestFingerprint({
      operation: ORGANIZATION_CREATE_OPERATION,
      actorUserId: ACTOR,
      fields: ['Ferme|Martin', 'FARM'],
    });
    const right = computeRequestFingerprint({
      operation: ORGANIZATION_CREATE_OPERATION,
      actorUserId: ACTOR,
      fields: ['Ferme', 'Martin|FARM'],
    });

    expect(left).not.toBe(right);
  });
});

/** Nombre de corps voisins engendrés pour la mesure de dispersion. */
const DISPERSION_SAMPLE_COUNT = 200;

/**
 * Positions de bit — sur les 256 du condensé — qui portent la MÊME valeur dans tous les
 * échantillons.
 *
 * Sur un HMAC, la liste est vide. Sur une sortie dont une part ne dépend pas des champs comparés,
 * elle nomme exactement cette part, ce qui rend l'échec lisible : « 0 à 127 » se lit
 * « la première moitié est figée ».
 */
function frozenBitPositions(samples: readonly Buffer[]): readonly number[] {
  const [reference] = samples;
  if (reference === undefined) {
    throw new Error('mesure impossible : aucun echantillon');
  }
  const frozen: number[] = [];
  for (let position = 0; position < reference.length * 8; position += 1) {
    const offset = position >> 3;
    const mask = 0x80 >> (position & 7);
    const value = (reference.readUInt8(offset) & mask) !== 0;
    if (samples.every((sample) => ((sample.readUInt8(offset) & mask) !== 0) === value)) {
      frozen.push(position);
    }
  }
  return frozen;
}

describe('aucune valeur en clair ne subsiste', () => {
  it('ne fige aucun bit de la sortie sur 200 corps voisins', () => {
    // CE QUE CE TEST REMPLACE, ET POURQUOI. Il cherchait ici le numéro d'immatriculation, le nom
    // et l'acteur, en clair, dans l'empreinte. Cette recherche ne pouvait RIEN trouver : le test
    // de forme contraint déjà la sortie à `^[0-9a-f]{64}$`, et toutes ces sentinelles portent au
    // moins un caractère hors de `[0-9a-f]`. La seule qui soit entièrement hexadécimale —
    // l'acteur privé de ses tirets — devrait occuper la MOITIÉ du condensé pour être vue. Une
    // assertion qui ne peut pas rougir est pire qu'une assertion absente : elle dissuade d'écrire
    // celle qui mord. (Transposer les sentinelles en hexadécimal rendrait la recherche capable de
    // trouver quelque chose, mais seulement pour une implémentation qui recopierait une valeur
    // telle quelle dans la sortie d'un HMAC. Ce n'est pas une faute plausible ; c'aurait été une
    // deuxième assertion décorative.)
    //
    // CE QUI PORTE DÉJÀ LA CONFIDENTIALITÉ, et qui mord réellement : « change quand le SECRET
    // change » rougit pour toute construction sans clé, et « n'est aucun condensé nu des mêmes
    // valeurs » rougit pour les trois écritures naïves. Aucune des deux, en revanche, ne voit une
    // construction PARTIELLEMENT clavetée du genre `condensé(secret) || condensé(champs)` :
    // l'empreinte y change bien quand le secret change, et ne vaut aucun des condensés nus
    // comparés — mais sa seconde moitié est un condensé NU d'un corps à faible entropie, que le
    // vol d'une sauvegarde retourne par énumération. C'est exactement ce que l'en-tête du module
    // interdit, et personne ne le mesurait.
    //
    // LA MESURE. 200 corps qui ne diffèrent que par le numéro. Si une part de la sortie ne dépend
    // pas des champs, ses bits sont IDENTIQUES sur les 200 échantillons. Un HMAC n'en fige aucun :
    // la probabilité qu'un bit donné soit constant par hasard vaut 2^-199. Secret fixé et numéros
    // énumérés : la mesure est entièrement déterministe, elle ne peut pas devenir intermittente.
    const digests = Array.from({ length: DISPERSION_SAMPLE_COUNT }, (_, index) =>
      fingerprintOfCreation({ registrationNumber: `FICTIF-ORG-${String(index).padStart(4, '0')}` }),
    );

    // Aucune collision : 200 intentions différentes, 200 empreintes différentes. Complémentaire de
    // la mesure de bits, qui ne verrait pas un condensé effondré sur un petit ensemble de valeurs.
    expect(new Set(digests).size).toBe(DISPERSION_SAMPLE_COUNT);

    const frozen = frozenBitPositions(digests.map((digest) => Buffer.from(digest, 'hex')));
    expect(frozen, 'positions de bit insensibles au corps compare').toStrictEqual([]);
  });

  it('n est aucun condense nu des memes valeurs', () => {
    // Trois écritures naïves plausibles, toutes réversibles par énumération sur un corps à
    // faible entropie. L'empreinte ne doit valoir aucune d'elles.
    const parts = [ORGANIZATION_CREATE_OPERATION, ACTOR, 'Exploitation agricole Martin', 'FARM'];
    const naive = [
      createHash('sha256').update(parts.join('')).digest('hex'),
      createHash('sha256').update(parts.join(':')).digest('hex'),
      createHash('sha256').update(JSON.stringify(parts)).digest('hex'),
      createHash('sha256').update(REGISTRATION_NUMBER).digest('hex'),
    ];

    const digest = computeRequestFingerprint({
      operation: ORGANIZATION_CREATE_OPERATION,
      actorUserId: ACTOR,
      fields: ['Exploitation agricole Martin', 'FARM'],
    });

    for (const candidate of naive) {
      expect(digest).not.toBe(candidate);
    }
  });
});

describe('empreinte des corps canoniques', () => {
  it('rend la meme empreinte pour deux corps qui ne different que par des espaces', () => {
    // CE QUI ENTRE DANS L'EMPREINTE EST LA VALEUR CANONIQUE, celle qui sort de la validation.
    // Deux corps dont les seuls écarts ont déjà été rognés sont la même intention : les
    // comparer avant normalisation produirait un conflit là où il n'y a qu'une reprise, et
    // le client verrait sa création refusée pour un espace.
    // L'ordre des champs recopie celui de `createOrganization` : nom, type, numéro, territoire.
    const fingerprintOfBody = (payload: unknown): string => {
      const command = parseCreateOrganizationPayload(payload);
      return computeRequestFingerprint({
        operation: ORGANIZATION_CREATE_OPERATION,
        actorUserId: ACTOR,
        fields: [command.name, command.type, command.registrationNumber, command.territoryCode],
      });
    };

    const reference = fingerprintOfBody({
      name: 'Exploitation agricole Martin',
      type: 'FARM',
      registrationNumber: REGISTRATION_NUMBER,
      clientEventId: CLIENT_EVENT_ID,
    });

    // Espaces de bordure, puis les trois écritures équivalentes de « aucun périmètre ».
    expect(
      fingerprintOfBody({
        name: '  Exploitation agricole Martin  ',
        type: 'FARM',
        registrationNumber: ` ${REGISTRATION_NUMBER} `,
        clientEventId: CLIENT_EVENT_ID,
      }),
    ).toBe(reference);
    expect(
      fingerprintOfBody({
        name: 'Exploitation agricole Martin',
        type: 'FARM',
        registrationNumber: REGISTRATION_NUMBER,
        territoryCode: null,
        clientEventId: CLIENT_EVENT_ID,
      }),
    ).toBe(reference);
    expect(
      fingerprintOfBody({
        name: 'Exploitation agricole Martin',
        type: 'FARM',
        registrationNumber: REGISTRATION_NUMBER,
        territoryCode: '',
        clientEventId: CLIENT_EVENT_ID,
      }),
    ).toBe(reference);

    // En revanche, deux écritures différentes du MÊME numéro ne sont pas la même intention
    // pour l'empreinte : la validation ne normalise pas la valeur stockée, et l'affichage
    // diffère. La base tranchera leur unicité sur la forme normalisée, pas l'empreinte.
    expect(
      fingerprintOfBody({
        name: 'Exploitation agricole Martin',
        type: 'FARM',
        registrationNumber: 'FICTIF ORG 0003',
        clientEventId: CLIENT_EVENT_ID,
      }),
    ).not.toBe(reference);
  });
});

/** Ce que la doublure de `timingSafeEqual` a réellement reçu, pendant une comparaison. */
interface ObservedComparison {
  /** Le booléen rendu par `timingSafeFingerprintEqual`. */
  readonly verdict: boolean;
  /** Un élément par appel à la primitive : les octets soumis, réencodés en hexadécimal. */
  readonly submittedHex: readonly (readonly [string, string])[];
  /** Un élément par appel : la taille, en octets, de chacun des deux opérandes. */
  readonly submittedBytes: readonly (readonly [number, number])[];
}

/** Octets réellement soumis, quelle que soit la vue employée (`Buffer`, `Uint8Array`…). */
function bytesOf(operand: NodeJS.ArrayBufferView): Buffer {
  return Buffer.from(operand.buffer, operand.byteOffset, operand.byteLength);
}

/**
 * Joue une comparaison et rend ce qui est parvenu à la primitive.
 *
 * `mockClear` isole l'appel mesuré de ceux d'un tour de boucle précédent : sans lui, une assertion
 * sur le NOMBRE d'appels ne mesurerait plus la comparaison en cours.
 */
function observeComparison(left: string, right: string): ObservedComparison {
  const delegate = vi.mocked(timingSafeEqual);
  delegate.mockClear();
  const verdict = timingSafeFingerprintEqual(left, right);
  return {
    verdict,
    submittedHex: delegate.mock.calls.map(
      (call) => [bytesOf(call[0]).toString('hex'), bytesOf(call[1]).toString('hex')] as const,
    ),
    submittedBytes: delegate.mock.calls.map(
      (call) => [call[0].byteLength, call[1].byteLength] as const,
    ),
  };
}

describe('timingSafeFingerprintEqual', () => {
  it('reconnait deux empreintes identiques et refuse deux empreintes differentes', () => {
    const digest = fingerprintOfCreation();

    expect(timingSafeFingerprintEqual(digest, digest)).toBe(true);
    expect(timingSafeFingerprintEqual(digest, fingerprintOfCreation({ type: 'COMPANY' }))).toBe(
      false,
    );
  });

  it('refuse sans lever ce qui n est pas une empreinte hexadecimale de 64 caracteres', () => {
    // La forme est vérifiée AVANT `timingSafeEqual`, qui lève sur deux tampons de tailles
    // différentes. Une exception ici produirait une erreur interne, donc un comportement
    // distinguable des autres refus — et un signal exploitable.
    const digest = fingerprintOfCreation();

    expect(timingSafeFingerprintEqual(digest, '')).toBe(false);
    expect(timingSafeFingerprintEqual(digest, digest.slice(0, 63))).toBe(false);
    expect(timingSafeFingerprintEqual(digest, `${digest}0`)).toBe(false);
    expect(timingSafeFingerprintEqual(digest, digest.toUpperCase())).toBe(false);
    expect(timingSafeFingerprintEqual(digest, `${digest.slice(0, 63)}z`)).toBe(false);
    expect(timingSafeFingerprintEqual('', '')).toBe(false);
    expect(timingSafeFingerprintEqual('', digest)).toBe(false);
  });

  it('delegue a timingSafeEqual, une seule fois, sur les deux empreintes decodees', () => {
    // POURQUOI UNE COMPARAISON ORDINAIRE FUIRAIT. `===` sur deux chaînes s'arrête au premier
    // caractère qui diffère : sa durée révèle le nombre de caractères déjà corrects, ce qui
    // remplace la recherche d'une empreinte sur 256 bits par 64 recherches indépendantes sur un
    // caractère chacune. Qui saurait fabriquer une empreinte acceptée ferait rejouer la réponse
    // d'un autre acteur, c'est-à-dire recevrait l'organisation d'un tiers.
    //
    // CE QUE CE TEST ÉTABLIT, et qu'aucun booléen ne pouvait établir : la comparaison est
    // DÉLÉGUÉE à la primitive du runtime, une fois, et sur les 32 octets décodés de l'hexadécimal.
    // Les octets reçus sont réencodés et comparés aux empreintes elles-mêmes, ce qui exclut :
    // une comparaison TRONQUÉE (`left.slice(0, 16)`, qui accepterait une collision sur 64 bits) ;
    // une comparaison portant sur autre chose que les empreintes (un condensé des condensés, qui
    // rendrait la primitive inutile puisque le calcul du condensé, lui, dépendrait de la donnée) ;
    // une comparaison sur les CHAÎNES plutôt que sur les octets, qui soumettrait 64 octets ;
    // et une PERMUTATION des opérandes — `timingSafeEqual(gauche, gauche)` rendrait `true` pour
    // n'importe quel couple.
    const left = fingerprintOfCreation();
    const right = fingerprintOfCreation({ type: 'COMPANY' });

    const observed = observeComparison(left, right);

    expect(observed.verdict).toBe(false);
    expect(observed.submittedHex).toStrictEqual([[left, right]]);
    expect(observed.submittedBytes).toStrictEqual([[32, 32]]);
  });

  it('rend le verdict de timingSafeEqual, sans le recalculer lui meme', () => {
    // C'EST L'ASSERTION QUE `===` NE PASSE PAS. La doublure est forcée à CONTREDIRE l'égalité des
    // chaînes, dans les deux sens : si la fonction tranchait elle-même, elle ignorerait la réponse
    // imposée et rendrait l'inverse. Aucun test portant sur le seul booléen ne peut distinguer les
    // deux implémentations, puisqu'elles rendent les mêmes booléens sur toutes les entrées — c'est
    // précisément pourquoi les trois tests que ce bloc comptait auparavant passaient tous avec
    // `left === right`, contre-épreuve faite.
    //
    // `mockReturnValueOnce` ne vaut que pour l'appel suivant : la vraie primitive reprend la main
    // aussitôt, sans dépendre de la remise à zéro entre tests.
    const digest = fingerprintOfCreation();
    const other = fingerprintOfCreation({ type: 'COMPANY' });
    const delegate = vi.mocked(timingSafeEqual);

    delegate.mockReturnValueOnce(true);
    expect(timingSafeFingerprintEqual(digest, other)).toBe(true);

    delegate.mockReturnValueOnce(false);
    expect(timingSafeFingerprintEqual(digest, digest)).toBe(false);

    expect(delegate).toHaveBeenCalledTimes(2);
  });

  it('ecarte une empreinte mal formee AVANT tout appel a la primitive', () => {
    // L'ORDRE EST LA GARANTIE, pas seulement le verdict. `Buffer.from(x, 'hex')` tronque
    // SILENCIEUSEMENT ce qu'il ne sait pas décoder : `''` devient 0 octet, une chaîne de 63
    // caractères en devient 31, et `timingSafeEqual` LÈVE sur deux tailles différentes. Une
    // implémentation qui appellerait d'abord et rattraperait ensuite rendrait le même booléen que
    // celle-ci — mais elle paierait le coût d'une exception, donc un refus mal formé deviendrait
    // distinguable d'un refus ordinaire depuis l'extérieur, et le décodage hexadécimal de Node
    // IGNORANT LA CASSE, une empreinte en majuscules serait alors reconnue égale à sa forme
    // minuscule, seule forme que la contrainte `..._request_fingerprint_format` accepte en base.
    const digest = fingerprintOfCreation();
    const malformed = new Map<string, string>([
      ['vide, decodee en 0 octet', ''],
      ['63 caracteres, decodee en 31 octets', digest.slice(0, 63)],
      ['majuscules, decodee en 32 octets EGAUX', digest.toUpperCase()],
    ]);

    for (const [label, candidate] of malformed) {
      const asRight = observeComparison(digest, candidate);
      expect(asRight.verdict, label).toBe(false);
      expect(asRight.submittedHex, label).toStrictEqual([]);

      // La garde porte sur les DEUX opérandes : l'empreinte présentée par l'appelant est tantôt
      // celle de la base, tantôt celle de la requête.
      const asLeft = observeComparison(candidate, digest);
      expect(asLeft.verdict, label).toBe(false);
      expect(asLeft.submittedHex, label).toStrictEqual([]);
    }
  });

  it('soumet les 32 octets entiers, que la difference soit en tete ou en fin', () => {
    // CE QUE CE TEST REMPLACE. Il s'appelait « ne s'arrête pas au premier caractère différent » et
    // n'assertait que deux `false` — ce qu'une comparaison à court-circuit rend à l'identique. Le
    // verdict ne pouvait pas porter la propriété : elle est dans la DURÉE, et la durée ne se
    // mesure pas ici. Ce qui s'observe, en revanche, c'est que la primitive reçoit les deux
    // condensés ENTIERS, en un seul appel, que l'écart soit sur le premier ou sur le dernier
    // octet. Une boucle qui sortirait au premier écart soumettrait un préfixe, ou plusieurs
    // appels, ou aucun.
    const reference = 'a'.repeat(64);
    const candidates = new Map<string, string>([
      ['difference sur le premier octet', `b${'a'.repeat(63)}`],
      ['difference sur le dernier octet', `${'a'.repeat(63)}b`],
    ]);

    for (const [label, candidate] of candidates) {
      const observed = observeComparison(reference, candidate);

      expect(observed.verdict, label).toBe(false);
      expect(observed.submittedHex, label).toStrictEqual([[reference, candidate]]);
      expect(observed.submittedBytes, label).toStrictEqual([[32, 32]]);
    }
  });
});

describe('secret absent', () => {
  it('engendre une cle ephemere plutot que d utiliser une valeur en dur', async () => {
    // Un secret de repli écrit dans le dépôt serait partagé par toutes les copies : ce serait
    // un secret public. En local, l'absence de `AUTH_SECRET` produit donc une clé aléatoire
    // par processus. CONSÉQUENCE À CONNAÎTRE, et elle est du bon côté : après un
    // redémarrage, une clé d'idempotence réservée avant celui-ci n'est plus comparable, et
    // un rejeu produit `IDEMPOTENCY_CONFLICT` au lieu de rejouer la réponse — refusé, jamais
    // exécuté deux fois.
    vi.resetModules();
    resetServerConfigCache();
    delete process.env.AUTH_SECRET;

    const registryKey = Symbol.for('appui-feux.organizations.local-secret');
    const registry = globalThis as unknown as Record<symbol, string | undefined>;
    const previous = registry[registryKey];
    delete registry[registryKey];

    try {
      const module = await import('@/domain/organizations/fingerprint');
      const digest = module.computeRequestFingerprint({
        operation: ORGANIZATION_CREATE_OPERATION,
        actorUserId: ACTOR,
        fields: ['Exploitation agricole Martin'],
      });

      expect(digest).toMatch(HEX_DIGEST);
      const generated = registry[registryKey];
      expect(typeof generated).toBe('string');
      expect(generated).toMatch(/^[0-9a-f]{64}$/);
      // La clé engendrée reste stable dans le processus : deux appels successifs restent
      // comparables, sans quoi aucun rejeu ne serait reconnu sur un poste local.
      expect(
        module.computeRequestFingerprint({
          operation: ORGANIZATION_CREATE_OPERATION,
          actorUserId: ACTOR,
          fields: ['Exploitation agricole Martin'],
        }),
      ).toBe(digest);
    } finally {
      if (previous === undefined) {
        delete registry[registryKey];
      } else {
        registry[registryKey] = previous;
      }
      vi.resetModules();
      applySecret(FIRST_SECRET);
    }
  });
});

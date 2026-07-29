import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `timingSafeEqual` est DOUBLÉ, et c'est le seul moyen d'éprouver la comparaison en temps
 * constant du condensé du CODE DE CONNEXION.
 *
 * POURQUOI PASSER PAR UNE DOUBLURE. La durée d'un appel ne se mesure pas de façon fiable dans un
 * test : le ramasse-miettes, la compilation à la volée et l'ordonnanceur du système produisent un
 * bruit très supérieur à l'écart cherché, et un seuil chiffré rendrait ce fichier instable sans
 * rien prouver. La seule observable qui reste est L'APPEL LUI-MÊME : à qui la comparaison est
 * déléguée, combien de fois, et sur quels octets. Un verdict rendu sans passer par la primitive du
 * runtime — `===`, une boucle qui sort au premier écart, une comparaison sur un préfixe — devient
 * alors visible, alors qu'il rend exactement les mêmes booléens. C'est le montage écrit pour
 * `timingSafeFingerprintEqual` (`tests/unit/organizations-fingerprint.test.ts`), transposé ici sur
 * son jumeau : les deux fonctions sont identiques ligne pour ligne, et `src/domain/organizations/
 * fingerprint.ts` demande explicitement que toute correction apportée à l'une soit reportée à
 * l'autre.
 *
 * LA DOUBLURE NE REMPLACE PAS L'IMPLÉMENTATION : `vi.fn(actual.timingSafeEqual)` délègue à la
 * vraie primitive, si bien que les tests de comportement de ce fichier continuent de mesurer le
 * vrai verdict. Un seul test impose une réponse, et par `mockReturnValueOnce`, dont l'effet
 * s'éteint au premier appel : aucun état ne fuit d'un test à l'autre.
 *
 * Le reste de `node:crypto` est recopié tel quel — `createHmac`, `createHash` et `randomBytes`,
 * dont dépendent les empreintes elles-mêmes, restent les vrais.
 */
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

import { createHash, timingSafeEqual } from 'node:crypto';
import { resetServerConfigCache } from '@/config/env';
import {
  createSessionToken,
  hashAttemptSubject,
  hashIdentifier,
  hashIpAddress,
  hashSessionToken,
  hashSignInCode,
  timingSafeHexEqual,
} from '@/domain/identity/hashing';

/**
 * Empreintes du module d'identité (0011, 0012, 0013 ; ADR-015, ADR-017).
 *
 * La contrainte SQL `^[0-9a-f]{64}$` interdit d'écrire une valeur en clair ; elle ne peut pas
 * imposer l'algorithme. Ces tests imposent ce qu'elle ne peut pas :
 *
 * 1. QUE CE NE SOIT PAS UN CONDENSÉ NU pour les valeurs à faible entropie. Un code à six chiffres
 *    compte un million de valeurs et une adresse IPv4 s'énumère en entier : un SHA-256 nu de ces
 *    valeurs se retourne par force brute et ne protège rien. La preuve est directe — l'empreinte
 *    change quand le secret change, et diffère du condensé nu de la même entrée.
 * 2. QUE LES USAGES SOIENT SÉPARÉS. Sans étiquette de domaine, la même adresse produirait la même
 *    empreinte dans `auth_challenges` et dans `auth_attempts`, et qui lit la base pourrait
 *    corréler les deux.
 * 3. QUE LA CONCATÉNATION SOIT INJECTIVE. Avec un séparateur ordinaire, deux découpages différents
 *    des mêmes caractères donneraient la même empreinte, donc deux sujets distincts partageraient
 *    un compteur de tentatives.
 * 4. QUE LE VERDICT D'ÉGALITÉ VIENNE DE `timingSafeEqual`, et porte sur les 32 octets entiers.
 *    `timingSafeHexEqual` est la fonction qui compare le condensé du code de connexion soumis à
 *    celui que porte le défi (`src/domain/identity/verify-sign-in-code.ts:152`). Un canal temporel
 *    sur cette comparaison ne coûte pas une organisation rejouée : il se remonte en code de
 *    connexion valide, donc en session ouverte au nom d'autrui. La durée ne se mesure pas dans un
 *    test ; l'appel, lui, s'observe — voir la doublure ci-dessus.
 */

const FIRST_SECRET = 'secret-de-test-fictif-numero-un-de-plus-de-32-caracteres';
const SECOND_SECRET = 'secret-de-test-fictif-numero-deux-de-plus-de-32-caracteres';

const HEX_DIGEST = /^[0-9a-f]{64}$/;
const CHALLENGE_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_CHALLENGE_ID = '99999999-8888-4777-8666-555555555555';

const initialEnvironment = { ...process.env };

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

describe('format et déterminisme', () => {
  it('produit toujours 64 caractères hexadécimaux minuscules', () => {
    const digests = [
      hashIdentifier('camille@exemple.test'),
      hashSignInCode(CHALLENGE_ID, '004821'),
      hashAttemptSubject('identifier', 'sign-in-verify', 'camille@exemple.test'),
      hashIpAddress('192.0.2.10'),
      hashSessionToken(createSessionToken()),
    ];

    for (const digest of digests) {
      expect(digest).toMatch(HEX_DIGEST);
    }
  });

  it('rend la même empreinte pour la même entrée', () => {
    expect(hashIdentifier('camille@exemple.test')).toBe(hashIdentifier('camille@exemple.test'));
    expect(hashSignInCode(CHALLENGE_ID, '004821')).toBe(hashSignInCode(CHALLENGE_ID, '004821'));
  });
});

describe('résistance à l énumération', () => {
  it('dépend du secret : une fuite de la seule base ne rend rien d exploitable', () => {
    const withFirst = {
      identifier: hashIdentifier('camille@exemple.test'),
      code: hashSignInCode(CHALLENGE_ID, '004821'),
      subject: hashAttemptSubject('identifier', 'sign-in-verify', 'camille@exemple.test'),
      address: hashIpAddress('192.0.2.10'),
    };

    applySecret(SECOND_SECRET);

    expect(hashIdentifier('camille@exemple.test')).not.toBe(withFirst.identifier);
    expect(hashSignInCode(CHALLENGE_ID, '004821')).not.toBe(withFirst.code);
    expect(hashAttemptSubject('identifier', 'sign-in-verify', 'camille@exemple.test')).not.toBe(
      withFirst.subject,
    );
    expect(hashIpAddress('192.0.2.10')).not.toBe(withFirst.address);
  });

  it('n est jamais le condensé nu de l entrée', () => {
    // Un condensé nu d'un code à six chiffres se retourne par un dictionnaire d'un million
    // d'entrées ; celui d'une adresse IPv4 par un dictionnaire de quatre milliards.
    expect(hashSignInCode(CHALLENGE_ID, '004821')).not.toBe(
      createHash('sha256').update('004821').digest('hex'),
    );
    expect(hashIpAddress('192.0.2.10')).not.toBe(
      createHash('sha256').update('192.0.2.10').digest('hex'),
    );
    expect(hashIdentifier('camille@exemple.test')).not.toBe(
      createHash('sha256').update('camille@exemple.test').digest('hex'),
    );
  });

  it('lie l empreinte du code à son défi', () => {
    // Deux défis qui tirent le même code n'ont pas la même empreinte : un dictionnaire des
    // empreintes du million de codes possibles ne s'exploite donc pas sur tous les défis à la fois.
    expect(hashSignInCode(CHALLENGE_ID, '004821')).not.toBe(
      hashSignInCode(OTHER_CHALLENGE_ID, '004821'),
    );
  });
});

describe('séparation des usages', () => {
  it('donne des empreintes différentes à la même valeur selon l usage', () => {
    const value = 'camille@exemple.test';

    const digests = new Set([
      hashIdentifier(value),
      hashAttemptSubject('identifier', 'sign-in-request', value),
      hashIpAddress(value),
      hashSignInCode(CHALLENGE_ID, value),
    ]);

    expect(digests.size).toBe(4);
  });

  it('sépare les dimensions et les chemins d un compteur de tentatives', () => {
    const subject = 'camille@exemple.test';

    const byDimension = new Set([
      hashAttemptSubject('identifier', 'sign-in-request', subject),
      hashAttemptSubject('source', 'sign-in-request', subject),
      hashAttemptSubject('pair', 'sign-in-request', subject),
    ]);
    const byPurpose = new Set([
      hashAttemptSubject('identifier', 'sign-in-request', subject),
      hashAttemptSubject('identifier', 'sign-in-verify', subject),
    ]);

    // Sans marqueur de dimension, la demande de code et la vérification partageraient un compteur,
    // et saturer l'un bloquerait l'autre.
    expect(byDimension.size).toBe(3);
    expect(byPurpose.size).toBe(2);
  });

  it('garde la concaténation injective malgré un sujet contenant des deux-points', () => {
    // Un sujet peut être une adresse IPv6, qui contient déjà des deux-points. Avec un séparateur
    // lisible, « a » + « b:c » et « a:b » + « c » se confondraient et deux sujets distincts
    // partageraient un compteur.
    expect(hashAttemptSubject('identifier', 'sign-in-verify', '2001:db8::1')).not.toBe(
      hashAttemptSubject('identifier', 'sign-in-verify:2001', 'db8::1'),
    );
    expect(hashAttemptSubject('source', 'sign-in-request', '')).not.toBe(
      hashAttemptSubject('source', '', 'sign-in-request'),
    );
  });

  it('normalise l adresse d appel avant de la hacher', () => {
    const reference = hashIpAddress('2001:DB8::1');

    expect(hashIpAddress('  2001:db8::1  ')).toBe(reference);
    expect(hashIpAddress('2001:db8::2')).not.toBe(reference);
  });
});

describe('jeton de session', () => {
  it('porte 256 bits d un générateur cryptographique, encodés sans échappement', () => {
    const token = createSessionToken();

    // base64url : ni « + », ni « / », ni « = ». Le cookie peut donc le porter tel quel, et la
    // lecture n'a pas à décoder ce que l'écriture aurait encodé.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('ne se répète pas', () => {
    const tokens = new Set<string>();
    for (let index = 0; index < 1_000; index += 1) {
      tokens.add(createSessionToken());
    }

    expect(tokens.size).toBe(1_000);
  });

  it('est haché par un condensé nu, et c est suffisant ici', () => {
    // Seul cas où le condensé nu est acceptable : la résistance vient des 256 bits d'entropie du
    // jeton, pas d'un secret ajouté. Le test fige cette propriété, qui ne vaut QUE parce que le
    // jeton vient de `createSessionToken`.
    const token = createSessionToken();

    expect(hashSessionToken(token)).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hashSessionToken(token)).not.toContain(token);
  });

  it('rend une empreinte indépendante du secret, contrairement aux autres', () => {
    const token = createSessionToken();
    const before = hashSessionToken(token);

    applySecret(SECOND_SECRET);

    expect(hashSessionToken(token)).toBe(before);
  });
});

/** Ce que la doublure de `timingSafeEqual` a réellement reçu, pendant une comparaison. */
interface ObservedComparison {
  /** Le booléen rendu par `timingSafeHexEqual`. */
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
  const verdict = timingSafeHexEqual(left, right);
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

describe('timingSafeHexEqual', () => {
  it('reconnaît deux empreintes identiques', () => {
    const digest = hashIdentifier('camille@exemple.test');

    expect(timingSafeHexEqual(digest, digest)).toBe(true);
  });

  it('refuse deux empreintes différentes', () => {
    expect(
      timingSafeHexEqual(hashIdentifier('camille@exemple.test'), hashIdentifier('a@exemple.test')),
    ).toBe(false);
  });

  it('refuse sans lever ce qui n est pas une empreinte hexadécimale de 64 caractères', () => {
    const digest = hashIdentifier('camille@exemple.test');

    // La longueur est vérifiée AVANT `timingSafeEqual`, qui lève sur des tampons de tailles
    // différentes. Une exception ici produirait une erreur interne distinguable des autres échecs.
    expect(timingSafeHexEqual(digest, '')).toBe(false);
    expect(timingSafeHexEqual(digest, digest.slice(0, 63))).toBe(false);
    expect(timingSafeHexEqual(digest, digest.toUpperCase())).toBe(false);
    expect(timingSafeHexEqual(digest, `${digest.slice(0, 63)}z`)).toBe(false);
    expect(timingSafeHexEqual('', '')).toBe(false);
  });

  it('delegue a timingSafeEqual, une seule fois, sur les deux condenses decodes', () => {
    // POURQUOI UNE COMPARAISON ORDINAIRE FUIRAIT ICI. `===` sur deux chaînes s'arrête au premier
    // caractère qui diffère : sa durée révèle le nombre de caractères déjà corrects, ce qui
    // remplace la recherche d'un condensé sur 256 bits par 64 recherches indépendantes sur un
    // caractère chacune. Les deux opérandes sont exactement ceux du chemin de connexion —
    // `verify-sign-in-code.ts:152` compare le condensé du code SOUMIS à celui que porte le défi —
    // et le canal se remonte donc en code de connexion accepté, c'est-à-dire en session ouverte au
    // nom d'autrui.
    //
    // CE QUE CE TEST ÉTABLIT, et qu'aucun booléen ne pouvait établir : la comparaison est
    // DÉLÉGUÉE à la primitive du runtime, une fois, et sur les 32 octets décodés de l'hexadécimal.
    // Les octets reçus sont réencodés et comparés aux condensés eux-mêmes, ce qui exclut :
    // une comparaison TRONQUÉE (`left.slice(0, 16)`, qui accepterait une collision sur 64 bits) ;
    // une comparaison portant sur autre chose que les condensés (un condensé des condensés, qui
    // rendrait la primitive inutile puisque le calcul du condensé, lui, dépendrait de la donnée) ;
    // une comparaison sur les CHAÎNES plutôt que sur les octets, qui soumettrait 64 octets ;
    // et une PERMUTATION des opérandes — `timingSafeEqual(gauche, gauche)` rendrait `true` pour
    // n'importe quel couple.
    const submitted = hashSignInCode(CHALLENGE_ID, '004821');
    const stored = hashSignInCode(CHALLENGE_ID, '004822');

    const observed = observeComparison(submitted, stored);

    expect(observed.verdict).toBe(false);
    expect(observed.submittedHex).toStrictEqual([[submitted, stored]]);
    expect(observed.submittedBytes).toStrictEqual([[32, 32]]);
  });

  it('rend le verdict de timingSafeEqual, sans le recalculer lui meme', () => {
    // C'EST L'ASSERTION QUE `===` NE PASSE PAS. La doublure est forcée à CONTREDIRE l'égalité des
    // chaînes, dans les deux sens : si la fonction tranchait elle-même, elle ignorerait la réponse
    // imposée et rendrait l'inverse. Aucun test portant sur le seul booléen ne peut distinguer les
    // deux implémentations, puisqu'elles rendent les mêmes booléens sur toutes les entrées — c'est
    // précisément pourquoi les quatre tests que ce bloc comptait auparavant passaient tous avec
    // `return left === right` derrière la garde de forme, contre-épreuve faite.
    //
    // `mockReturnValueOnce` ne vaut que pour l'appel suivant : la vraie primitive reprend la main
    // aussitôt, sans dépendre de la remise à zéro entre tests.
    const submitted = hashSignInCode(CHALLENGE_ID, '004821');
    const stored = hashSignInCode(CHALLENGE_ID, '004822');
    const delegate = vi.mocked(timingSafeEqual);

    delegate.mockReturnValueOnce(true);
    expect(timingSafeHexEqual(submitted, stored)).toBe(true);

    delegate.mockReturnValueOnce(false);
    expect(timingSafeHexEqual(submitted, submitted)).toBe(false);

    expect(delegate).toHaveBeenCalledTimes(2);
  });

  it('ecarte un condense mal forme AVANT tout appel a la primitive', () => {
    // L'ORDRE EST LA GARANTIE, pas seulement le verdict. `Buffer.from(x, 'hex')` tronque
    // SILENCIEUSEMENT ce qu'il ne sait pas décoder : `''` devient 0 octet, une chaîne de 63
    // caractères en devient 31, et `timingSafeEqual` LÈVE sur deux tailles différentes. Une
    // implémentation qui appellerait d'abord et rattraperait ensuite rendrait le même booléen que
    // celle-ci — mais elle paierait le coût d'une exception, donc un refus mal formé deviendrait
    // distinguable d'un refus ordinaire depuis l'extérieur, et le décodage hexadécimal de Node
    // IGNORANT LA CASSE, un condensé en majuscules serait alors reconnu égal à sa forme minuscule,
    // seule forme que la contrainte `auth_challenges_code_hash_format` accepte en base.
    const digest = hashSignInCode(CHALLENGE_ID, '004821');
    const malformed = new Map<string, string>([
      ['vide, decodee en 0 octet', ''],
      ['63 caracteres, decodee en 31 octets', digest.slice(0, 63)],
      ['majuscules, decodee en 32 octets EGAUX', digest.toUpperCase()],
      ['caractere hors alphabet en fin', `${digest.slice(0, 63)}z`],
    ]);

    for (const [label, candidate] of malformed) {
      const asRight = observeComparison(digest, candidate);
      expect(asRight.verdict, label).toBe(false);
      expect(asRight.submittedHex, label).toStrictEqual([]);

      // La garde porte sur les DEUX opérandes : le condensé présenté est tantôt celui du défi lu
      // en base, tantôt celui que la requête vient de faire calculer.
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
  it('engendre une clé éphémère plutôt que d utiliser une valeur en dur', async () => {
    // Un secret de repli écrit dans le dépôt serait partagé par tous les postes et toutes les
    // copies : ce serait un secret public. L'absence de `AUTH_SECRET` en local produit donc une
    // clé aléatoire par processus, et un avertissement qui dit ce que cela implique.
    vi.resetModules();
    resetServerConfigCache();
    delete process.env.AUTH_SECRET;

    const registryKey = Symbol.for('appui-feux.identity.local-secret');
    const registry = globalThis as unknown as Record<symbol, string | undefined>;
    const previous = registry[registryKey];
    delete registry[registryKey];

    try {
      const module = await import('@/domain/identity/hashing');
      const digest = module.hashIdentifier('camille@exemple.test');

      expect(digest).toMatch(HEX_DIGEST);
      const generated = registry[registryKey];
      expect(typeof generated).toBe('string');
      expect(generated).toMatch(/^[0-9a-f]{64}$/);
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

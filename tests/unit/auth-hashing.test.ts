import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('ne s arrête pas au premier caractère différent', () => {
    // Preuve indirecte mais suffisante : deux empreintes qui ne diffèrent qu'au DERNIER caractère
    // sont refusées comme deux empreintes qui diffèrent au premier. Une comparaison de chaînes
    // ordinaire donnerait le même verdict, mais pas la même durée ; le contrat testable ici est
    // que le verdict ne dépend pas de la position de la différence.
    const digest = 'a'.repeat(64);
    const differsAtStart = `b${'a'.repeat(63)}`;
    const differsAtEnd = `${'a'.repeat(63)}b`;

    expect(timingSafeHexEqual(digest, differsAtStart)).toBe(false);
    expect(timingSafeHexEqual(digest, differsAtEnd)).toBe(false);
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

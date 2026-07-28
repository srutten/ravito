import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getServerConfig } from '@/config/env';
import { logger } from '@/observability/logger';

/**
 * Empreintes du module d'identité.
 *
 * Cinq colonnes du lot 1 sont contraintes à 64 caractères hexadécimaux
 * (`identifier_hash`, `code_hash`, `subject_hash`, `ip_hash`, `token_hash`). La
 * contrainte SQL interdit d'y écrire une valeur en clair, elle ne peut pas imposer
 * l'algorithme. C'est ce fichier qui l'impose.
 *
 * DEUX RÉGIMES, ET LA DIFFÉRENCE COMPTE.
 *
 * 1. HMAC-SHA-256 avec un secret hors base, pour tout ce qui a une FAIBLE ENTROPIE :
 *    un code à six chiffres compte un million de valeurs, une adresse de courriel se
 *    devine par dictionnaire, une adresse IPv4 s'énumère entièrement. Un condensé nu de
 *    ces valeurs se retourne par force brute en quelques minutes et ne protège donc
 *    rien. Avec une clé absente de la base, l'espace de recherche devient celui de la
 *    clé et une fuite de la seule base ne rend plus rien d'exploitable.
 *
 * 2. SHA-256 nu, pour le jeton de session UNIQUEMENT. Le jeton est tiré sur 256 bits par
 *    un générateur cryptographique : aucune énumération n'atteint cet espace, la
 *    résistance vient de l'entropie du jeton et non d'un secret ajouté. Ce raisonnement
 *    ne tient que tant que le jeton vient bien de `createSessionToken` ci-dessous.
 *
 * Séparation de domaine : chaque usage préfixe son entrée par une étiquette distincte.
 * Sans elle, la même valeur produirait la même empreinte dans deux tables différentes,
 * et une corrélation entre `auth_challenges.identifier_hash` et un compteur de
 * `auth_attempts` redeviendrait possible pour qui lit la base.
 */

const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Séparateur des champs concaténés avant hachage. Le caractère nul est écrit sous forme
 * d'échappement et non littéralement : un octet de contrôle invisible dans un fichier
 * source se perd au premier passage d'un outil qui « nettoie » les caractères non
 * imprimables, et toutes les empreintes changeraient sans qu'aucune revue ne le voie.
 *
 * Un séparateur qui ne peut apparaître dans aucune des parties rend la concaténation
 * injective : sans lui, deux découpages différents des mêmes caractères produiraient la
 * même empreinte.
 */
const FIELD_SEPARATOR = '\u0000';

/** Étiquettes de séparation de domaine. Ne jamais les réutiliser d'un usage à l'autre. */
const DOMAIN_IDENTIFIER = 'appui-feux:identity:identifier:v1';
const DOMAIN_SIGN_IN_CODE = 'appui-feux:identity:sign-in-code:v1';
const DOMAIN_ATTEMPT_SUBJECT = 'appui-feux:identity:attempt-subject:v1';
const DOMAIN_IP_ADDRESS = 'appui-feux:identity:ip-address:v1';

/** 256 bits de jeton de session. Le cookie en est la seule copie. */
const SESSION_TOKEN_BYTES = 32;
/** Longueur de la clé de repli engendrée en local, en octets. */
const LOCAL_SECRET_BYTES = 32;

/**
 * Registre de la clé de repli locale. Même procédé que le pool applicatif : le
 * rechargement à chaud de Next réévalue les modules, et une variable de module donnerait
 * une clé différente après chaque recompilation — donc des codes envoyés dix secondes
 * plus tôt devenus invérifiables.
 */
const LOCAL_SECRET_KEY = Symbol.for('appui-feux.identity.local-secret');

interface SecretRegistry {
  [LOCAL_SECRET_KEY]?: string;
}

const registry = globalThis as unknown as SecretRegistry;

/**
 * Clé des HMAC du module.
 *
 * Hors poste local, `AUTH_SECRET` est obligatoire et sa validation empêche le démarrage
 * (`src/config/env.ts`) : cette fonction ne peut donc pas y retomber sur le repli.
 *
 * En local, `AUTH_SECRET` est facultatif depuis le lot 0. Plutôt que d'empêcher un
 * développeur de se connecter sur un poste neuf, une clé aléatoire est engendrée une
 * fois par processus, et l'avertissement dit exactement ce que cela implique : les défis
 * et les compteurs écrits avant un redémarrage deviennent invérifiables. Aucune valeur
 * de repli n'est écrite en dur dans le dépôt — un secret de repli commité est un secret
 * partagé par tous les postes et par toutes les copies du dépôt.
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
    { module: 'identity' },
    'AUTH_SECRET est absente : une cle ephemere est utilisee pour ce processus. Les defis et les compteurs de tentatives ecrits avant un redemarrage deviendront inverifiables. Configurer AUTH_SECRET pour un comportement stable.',
  );
  return generated;
}

function hmacHex(domain: string, value: string): string {
  return createHmac('sha256', resolveSecret())
    .update(`${domain}${FIELD_SEPARATOR}${value}`)
    .digest('hex');
}

/**
 * Empreinte de l'identifiant NORMALISÉ, destinée à `auth_challenges.identifier_hash`.
 * Normaliser d'abord, hacher ensuite : sans cela, deux écritures d'une même adresse
 * donneraient deux files de défis et la limitation se contournerait en changeant la
 * casse.
 */
export function hashIdentifier(normalizedIdentifier: string): string {
  return hmacHex(DOMAIN_IDENTIFIER, normalizedIdentifier);
}

/**
 * Empreinte du code, destinée à `auth_challenges.code_hash`.
 *
 * Le code est lié à son défi avant hachage. Deux défis qui tirent le même code n'ont
 * donc pas la même empreinte : qui lit la base ne peut ni repérer les collisions, ni
 * constituer un dictionnaire des empreintes des un million de codes possibles pour
 * l'exploiter sur tous les défis à la fois.
 */
export function hashSignInCode(challengeId: string, code: string): string {
  return hmacHex(DOMAIN_SIGN_IN_CODE, `${challengeId}${FIELD_SEPARATOR}${code}`);
}

/**
 * Empreinte du sujet limité, destinée à `auth_attempts.subject_hash`. Le marqueur de
 * dimension est imposé par la signature : il n'est pas possible de hacher un sujet sans
 * dire de quelle dimension il relève, donc pas possible que deux dimensions partagent un
 * compteur (0012_auth-attempts.sql).
 *
 * Le séparateur est le même que partout ailleurs, et non un caractère lisible comme
 * « : ». Un sujet peut être une adresse IPv6, qui en contient déjà : avec un séparateur
 * ordinaire, la concaténation cesserait d'être injective et deux sujets distincts
 * pourraient partager un compteur.
 */
export function hashAttemptSubject(dimension: string, purpose: string, subject: string): string {
  return hmacHex(
    DOMAIN_ATTEMPT_SUBJECT,
    `${dimension}${FIELD_SEPARATOR}${purpose}${FIELD_SEPARATOR}${subject}`,
  );
}

/**
 * Empreinte d'une adresse d'appel, destinée à `sessions.ip_hash` et à
 * `audit_logs.ip_hash`. HMAC et non condensé nu : l'espace des adresses IPv4 s'énumère
 * en entier.
 */
export function hashIpAddress(ipAddress: string): string {
  return hmacHex(DOMAIN_IP_ADDRESS, ipAddress.trim().toLowerCase());
}

/**
 * Jeton de session opaque. 256 bits d'un générateur cryptographique, encodés en
 * base64url pour tenir dans un cookie sans échappement. Aucune structure interne, rien à
 * interpréter : c'est ce qui distingue une session opaque d'un jeton auto-porteur
 * (ADR-017).
 */
export function createSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/**
 * Empreinte du jeton de session. SHA-256 nu, et c'est suffisant : voir l'en-tête de ce
 * fichier. Le jeton lui-même ne doit jamais être écrit ailleurs que dans le cookie.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Comparaison en temps constant de deux empreintes hexadécimales.
 *
 * Une comparaison de chaînes ordinaire s'arrête au premier caractère différent : sa
 * durée révèle le nombre de caractères déjà corrects, ce qui transforme la recherche
 * d'un secret en une suite de recherches indépendantes, chacune sur un seul caractère.
 *
 * Les longueurs sont vérifiées avant `timingSafeEqual`, qui lève sur des tampons de
 * tailles différentes. Cette vérification ne fuit rien : les deux valeurs comparées ici
 * font toujours 64 caractères, la longueur n'est jamais fonction du secret.
 */
export function timingSafeHexEqual(left: string, right: string): boolean {
  if (!HEX_DIGEST_PATTERN.test(left) || !HEX_DIGEST_PATTERN.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

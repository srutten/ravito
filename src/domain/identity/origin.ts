import { hashIpAddress } from '@/domain/identity/hashing';
import type { RequestOrigin } from '@/domain/identity/types';

/**
 * Traitement de l'origine d'un appel avant écriture.
 *
 * Deux données arrivent ici et aucune des deux ne doit être conservée telle quelle.
 *
 * L'ADRESSE D'APPEL est une donnée personnelle. Les colonnes `ip_hash` de `sessions` et
 * de `audit_logs` sont contraintes à 64 caractères hexadécimaux : « 192.168.1.1 » ne
 * satisfait pas le motif, l'écriture en clair est structurellement impossible. Le hachage
 * est un HMAC et non un condensé nu, l'espace des adresses IPv4 s'énumérant en entier.
 *
 * L'EN-TÊTE DE NAVIGATEUR complet est une empreinte de pistage : version exacte,
 * plateforme, moteur de rendu, extensions parfois. `docs/privacy-rgpd.md` range le suivi
 * permanent parmi les données à éviter. Seul un résumé court est conservé, assez pour
 * qu'un utilisateur reconnaisse son propre appareil dans la liste de ses sessions, trop
 * pauvre pour distinguer deux personnes.
 */

/** Borne du résumé. La colonne accepte 200 caractères ; 60 suffisent largement. */
const MAX_SUMMARY_LENGTH = 60;

/**
 * Ordre significatif : le premier motif reconnu gagne. Edge et Opera annoncent « Chrome »
 * dans leur en-tête, Chrome annonce « Safari ». Tester du plus spécifique au plus
 * générique évite de résumer un Edge en « Chrome », puis en « Safari ».
 */
const BROWSER_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/Edg(?:e|A|iOS)?\/(\d+)/, 'Edge'],
  [/OPR\/(\d+)/, 'Opera'],
  [/SamsungBrowser\/(\d+)/, 'Samsung Internet'],
  [/Firefox\/(\d+)/, 'Firefox'],
  [/Chrome\/(\d+)/, 'Chrome'],
  [/Version\/(\d+).*Safari/, 'Safari'],
];

const PLATFORM_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/Android/, 'Android'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Windows NT/, 'Windows'],
  [/Mac OS X/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

/**
 * Résume un en-tête de navigateur sous la forme « Firefox 141 / Android ».
 *
 * Renvoie `null` plutôt qu'une valeur inventée quand rien n'est reconnu : une colonne
 * vide dit « on ne sait pas », une valeur inventée dit quelque chose de faux. La version
 * est réduite au numéro majeur, le numéro mineur n'ajoutant qu'un pouvoir de distinction
 * entre appareils.
 */
export function summarizeUserAgent(userAgent: string | undefined): string | null {
  if (userAgent === undefined) {
    return null;
  }
  const trimmed = userAgent.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let browser: string | null = null;
  for (const [pattern, name] of BROWSER_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match !== null) {
      browser = match[1] === undefined ? name : `${name} ${match[1]}`;
      break;
    }
  }

  let platform: string | null = null;
  for (const [pattern, name] of PLATFORM_PATTERNS) {
    if (pattern.test(trimmed)) {
      platform = name;
      break;
    }
  }

  if (browser === null && platform === null) {
    return null;
  }
  const summary = [browser, platform].filter((part) => part !== null).join(' / ');
  return summary.slice(0, MAX_SUMMARY_LENGTH);
}

/** Empreinte de l'adresse d'appel, ou `null` lorsque la route n'a pas su la déterminer. */
export function hashOriginAddress(origin: RequestOrigin | undefined): string | null {
  const address = origin?.ipAddress?.trim();
  if (address === undefined || address.length === 0) {
    return null;
  }
  return hashIpAddress(address);
}

/**
 * Sujet de limitation par source.
 *
 * Sans adresse, la valeur `unknown-source` est utilisée : tous les appels sans origine
 * connue partagent alors un compteur. C'est volontairement le défaut le plus strict — si
 * l'infrastructure cessait de transmettre l'adresse, la limitation par source
 * deviendrait globale et bruyante au lieu de disparaître en silence.
 */
export function toSourceSubject(origin: RequestOrigin | undefined): string {
  const address = origin?.ipAddress?.trim();
  return address === undefined || address.length === 0 ? 'unknown-source' : address.toLowerCase();
}

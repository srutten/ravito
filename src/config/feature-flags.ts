/**
 * Feature flags et interrupteurs de sécurité (docs/feature-flags.md).
 *
 * Règle unique : refus par défaut. Un flag absent, vide ou illisible vaut `false`.
 * Un flag ne remplace jamais un contrôle d'autorisation, il ne fait que fermer une porte.
 */

/** Flags produit : ils ouvrent une fonctionnalité. */
export const PRODUCT_FLAGS = [
  'ENABLE_PUBLIC_REGISTRATION',
  'ENABLE_SMS',
  'ENABLE_EMAIL',
  'ENABLE_PUSH_NOTIFICATIONS',
  'ENABLE_REALTIME',
  'ENABLE_OFFLINE_QUEUE',
  'ENABLE_RESOURCE_DOCUMENTS',
  'ENABLE_PRECISE_LOCATION',
  'ENABLE_MATCHING_SCORE',
  'ENABLE_OBSERVER_ROLE',
] as const;

/** Interrupteurs de sécurité : ils restreignent la plateforme en exploitation. */
export const SAFETY_SWITCHES = [
  'PLATFORM_READ_ONLY',
  'DISABLE_NEW_REQUESTS',
  'DISABLE_NEW_MISSIONS',
  'HIDE_PRECISE_LOCATIONS',
  'DISABLE_FILE_UPLOADS',
  'FORCE_SESSION_REVOCATION',
] as const;

export type ProductFlag = (typeof PRODUCT_FLAGS)[number];
export type SafetySwitch = (typeof SAFETY_SWITCHES)[number];
export type FeatureFlag = ProductFlag | SafetySwitch;

export const FEATURE_FLAGS: readonly FeatureFlag[] = [...PRODUCT_FLAGS, ...SAFETY_SWITCHES];

const TRUE_VALUES = ['true', '1', 'on', 'yes'];

/** Toute valeur non explicitement vraie est fausse : aucune ouverture par accident. */
function readFlagValue(raw: string | undefined): boolean {
  if (raw === undefined) {
    return false;
  }
  return TRUE_VALUES.includes(raw.trim().toLowerCase());
}

/**
 * Lit l'ensemble des flags depuis une source explicite. Le résultat est figé : un appelant ne
 * peut pas activer un flag en modifiant l'objet retourné.
 */
export function readFeatureFlags(
  source: Record<string, string | undefined>,
): Readonly<Record<FeatureFlag, boolean>> {
  // La liste couvre exactement les clés de `FeatureFlag`, l'objet construit est donc complet.
  const entries = FEATURE_FLAGS.map((flag) => [flag, readFlagValue(source[flag])] as const);
  return Object.freeze(Object.fromEntries(entries) as Record<FeatureFlag, boolean>);
}

/**
 * Lit un flag unique depuis `process.env`, sans cache : un interrupteur de sécurité doit être
 * lisible sans dépendre d'un état mémoire ni d'un service externe.
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  return readFlagValue(process.env[flag]);
}

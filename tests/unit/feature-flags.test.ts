import { afterEach, describe, expect, it } from 'vitest';
import type { FeatureFlag } from '@/config/feature-flags';
import {
  isFeatureEnabled,
  PRODUCT_FLAGS,
  readFeatureFlags,
  SAFETY_SWITCHES,
} from '@/config/feature-flags';

/**
 * Feature flags et interrupteurs de sécurité (docs/feature-flags.md, US-001 critère 9).
 *
 * Règle vérifiée ici : refus par défaut. Toute valeur qui n'est pas explicitement vraie laisse la
 * porte fermée, y compris une valeur illisible, mal orthographiée ou vide.
 */

const ALL_FLAGS: readonly FeatureFlag[] = [...PRODUCT_FLAGS, ...SAFETY_SWITCHES];

describe('readFeatureFlags', () => {
  it('déclare les dix flags produit et les six interrupteurs de sécurité', () => {
    expect(PRODUCT_FLAGS).toHaveLength(10);
    expect(SAFETY_SWITCHES).toHaveLength(6);
    expect(new Set(ALL_FLAGS).size).toBe(16);
  });

  it('vaut false pour tout flag absent de la source', () => {
    const flags = readFeatureFlags({});

    for (const flag of ALL_FLAGS) {
      expect(flags[flag]).toBe(false);
    }
  });

  it('lit correctement true et false', () => {
    const flags = readFeatureFlags({
      ENABLE_SMS: 'true',
      ENABLE_EMAIL: 'false',
      PLATFORM_READ_ONLY: 'true',
      DISABLE_NEW_REQUESTS: 'false',
    });

    expect(flags.ENABLE_SMS).toBe(true);
    expect(flags.ENABLE_EMAIL).toBe(false);
    expect(flags.PLATFORM_READ_ONLY).toBe(true);
    expect(flags.DISABLE_NEW_REQUESTS).toBe(false);
  });

  it('accepte les écritures usuelles du vrai, espaces et casse compris', () => {
    const flags = readFeatureFlags({
      ENABLE_SMS: 'TRUE',
      ENABLE_EMAIL: ' 1 ',
      ENABLE_REALTIME: 'on',
      ENABLE_OFFLINE_QUEUE: 'Yes',
    });

    expect(flags.ENABLE_SMS).toBe(true);
    expect(flags.ENABLE_EMAIL).toBe(true);
    expect(flags.ENABLE_REALTIME).toBe(true);
    expect(flags.ENABLE_OFFLINE_QUEUE).toBe(true);
  });

  it('retombe sur false pour une valeur non reconnue, vide ou approximative', () => {
    const flags = readFeatureFlags({
      ENABLE_SMS: 'peut-être',
      ENABLE_EMAIL: '',
      ENABLE_REALTIME: 'oui',
      ENABLE_PUBLIC_REGISTRATION: 'vrai',
      HIDE_PRECISE_LOCATIONS: '2',
      DISABLE_FILE_UPLOADS: 'enabled',
    });

    expect(flags.ENABLE_SMS).toBe(false);
    expect(flags.ENABLE_EMAIL).toBe(false);
    expect(flags.ENABLE_REALTIME).toBe(false);
    expect(flags.ENABLE_PUBLIC_REGISTRATION).toBe(false);
    expect(flags.HIDE_PRECISE_LOCATIONS).toBe(false);
    expect(flags.DISABLE_FILE_UPLOADS).toBe(false);
  });

  it('ignore les clés inconnues de la source', () => {
    const flags = readFeatureFlags({ ENABLE_TOUT: 'true', DATABASE_URL: 'postgresql://x/y' });

    expect(Object.keys(flags).sort()).toStrictEqual([...ALL_FLAGS].sort());
    expect(Object.values(flags).every((value) => value === false)).toBe(true);
  });

  it('rend un objet figé, qu un appelant ne peut pas ouvrir après coup', () => {
    const flags = readFeatureFlags({});

    expect(Object.isFrozen(flags)).toBe(true);
  });
});

describe('isFeatureEnabled', () => {
  const initialEnvironment = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in initialEnvironment)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, initialEnvironment);
  });

  it('vaut false pour un flag absent de l environnement', () => {
    delete process.env.ENABLE_SMS;

    expect(isFeatureEnabled('ENABLE_SMS')).toBe(false);
  });

  it('reflète immédiatement un changement d environnement, sans cache', () => {
    process.env.PLATFORM_READ_ONLY = 'true';
    expect(isFeatureEnabled('PLATFORM_READ_ONLY')).toBe(true);

    process.env.PLATFORM_READ_ONLY = 'false';
    expect(isFeatureEnabled('PLATFORM_READ_ONLY')).toBe(false);
  });

  it('retombe sur false pour une valeur non reconnue', () => {
    process.env.ENABLE_PRECISE_LOCATION = 'bientôt';

    expect(isFeatureEnabled('ENABLE_PRECISE_LOCATION')).toBe(false);
  });
});

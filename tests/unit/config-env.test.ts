import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  getServerConfig,
  parseServerConfig,
  resetServerConfigCache,
} from '@/config/env';

/**
 * Validation de la configuration serveur (US-001, critères 8 et 15).
 *
 * Le test central de ce fichier est négatif : une configuration invalide doit nommer la variable
 * fautive sans jamais reproduire sa valeur. Une valeur reproduite dans un message d'erreur finit
 * dans un journal, une trace de construction ou une capture d'écran, et un secret est alors
 * divulgué sans qu'aucune faille n'ait été exploitée.
 */

/**
 * Sentinelles reconnaissables. Aucune n'est une donnée réelle : ce sont des marqueurs conçus pour
 * être recherchés dans un message d'erreur.
 */
const SENTINELS = {
  databaseUrl: 'sentinelle-chaine-de-connexion-Z9X8C7',
  authSecret: 'sentinelle-secret-Q7W6E5',
  poolMax: 'sentinelle-pool-R4T3Y2',
  logLevel: 'sentinelle-niveau-U1I0O9',
  mapStyleUrl: 'sentinelle-carte-P8A7S6',
  storageBucket: 'sentinelle-bucket-D5F4G3',
} as const;

const VALID_DATABASE_URL = 'postgresql://utilisateur:motdepasse-fictif@localhost:5432/appui_feux';
const VALID_AUTH_SECRET = 'secret-de-test-fictif-de-plus-de-32-caracteres';

function minimalSource(): Record<string, string | undefined> {
  return { APP_ENV: 'local', DATABASE_URL: VALID_DATABASE_URL };
}

function completeSource(): Record<string, string | undefined> {
  return {
    APP_ENV: 'staging',
    APP_VERSION: '1.2.3',
    LOG_LEVEL: 'warn',
    DATABASE_URL: VALID_DATABASE_URL,
    DATABASE_POOL_MAX: '25',
    DATABASE_STATEMENT_TIMEOUT_MS: '5000',
    DATABASE_SSL: 'require',
    FEATURE_FLAGS_SOURCE: 'env',
    AUTH_SECRET: VALID_AUTH_SECRET,
    MAP_STYLE_URL: 'https://cartes.exemple.test/style.json',
    OBSERVABILITY_DSN: 'https://observabilite.exemple.test/collecte',
    STORAGE_ENDPOINT: 'https://stockage.exemple.test',
    STORAGE_BUCKET: 'documents-fictifs',
    STORAGE_ACCESS_KEY: 'cle-acces-fictive',
    STORAGE_SECRET_KEY: 'cle-secrete-fictive',
  };
}

/** Capture l'erreur de configuration levée, ou échoue si la configuration a été acceptée. */
function expectConfigurationError(source: Record<string, string | undefined>): ConfigurationError {
  try {
    parseServerConfig(source);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    return error as ConfigurationError;
  }
  throw new Error('la configuration invalide a été acceptée alors qu elle devait être rejetée');
}

describe('parseServerConfig', () => {
  it('accepte une configuration complète et la restitue telle quelle', () => {
    const config = parseServerConfig(completeSource());

    expect(config).toStrictEqual({
      appEnvironment: 'staging',
      appVersion: '1.2.3',
      logLevel: 'warn',
      databaseUrl: VALID_DATABASE_URL,
      databasePoolMax: 25,
      databaseStatementTimeoutMs: 5000,
      databaseSsl: true,
      featureFlagsSource: 'env',
      authSecret: VALID_AUTH_SECRET,
      mapStyleUrl: 'https://cartes.exemple.test/style.json',
      observabilityDsn: 'https://observabilite.exemple.test/collecte',
      storage: {
        endpoint: 'https://stockage.exemple.test',
        bucket: 'documents-fictifs',
        accessKey: 'cle-acces-fictive',
        secretKey: 'cle-secrete-fictive',
      },
    });
  });

  it('accepte une configuration minimale et applique les valeurs par défaut documentées', () => {
    const config = parseServerConfig(minimalSource());

    expect(config.appEnvironment).toBe('local');
    expect(config.databaseUrl).toBe(VALID_DATABASE_URL);
    expect(config.logLevel).toBe('debug');
    expect(config.databasePoolMax).toBe(10);
    expect(config.databaseStatementTimeoutMs).toBe(10_000);
    expect(config.databaseSsl).toBe(false);
    expect(config.featureFlagsSource).toBe('env');
    // Les propriétés facultatives sont omises, jamais posées à `undefined`.
    expect('authSecret' in config).toBe(false);
    expect('storage' in config).toBe(false);
  });

  it('refuse une variable obligatoire absente', () => {
    const source = minimalSource();
    delete source.DATABASE_URL;

    const error = expectConfigurationError(source);

    expect(error.invalidVariables).toContain('DATABASE_URL');
    expect(error.message).toContain('DATABASE_URL');
  });

  it('refuse une variable obligatoire présente mais vide', () => {
    const error = expectConfigurationError({ ...minimalSource(), DATABASE_URL: '   ' });

    expect(error.invalidVariables).toStrictEqual(['DATABASE_URL']);
  });

  it('refuse une valeur de type incorrect', () => {
    const error = expectConfigurationError({
      ...minimalSource(),
      DATABASE_POOL_MAX: 'beaucoup',
      DATABASE_STATEMENT_TIMEOUT_MS: '1.5',
    });

    expect(error.invalidVariables).toContain('DATABASE_POOL_MAX');
    expect(error.invalidVariables).toContain('DATABASE_STATEMENT_TIMEOUT_MS');
  });

  it('refuse un entier hors bornes', () => {
    const error = expectConfigurationError({ ...minimalSource(), DATABASE_POOL_MAX: '0' });

    expect(error.invalidVariables).toStrictEqual(['DATABASE_POOL_MAX']);
  });

  it('refuse une chaîne de connexion dont le protocole n est pas PostgreSQL', () => {
    const error = expectConfigurationError({
      ...minimalSource(),
      DATABASE_URL: 'mysql://utilisateur:motdepasse-fictif@localhost:3306/appui_feux',
    });

    expect(error.invalidVariables).toStrictEqual(['DATABASE_URL']);
  });

  it('collecte toutes les anomalies en une seule levée', () => {
    const error = expectConfigurationError({
      APP_ENV: 'preproduction',
      DATABASE_URL: '',
      LOG_LEVEL: 'bavard',
    });

    expect(error.invalidVariables).toContain('APP_ENV');
    expect(error.invalidVariables).toContain('LOG_LEVEL');
    expect(error.invalidVariables).toContain('DATABASE_URL');
  });

  it('exige AUTH_SECRET en staging et en production, mais pas en local', () => {
    const local = { ...minimalSource(), APP_ENV: 'local' };
    expect(() => parseServerConfig(local)).not.toThrow();

    for (const environment of ['staging', 'production']) {
      const error = expectConfigurationError({ ...minimalSource(), APP_ENV: environment });
      expect(error.invalidVariables).toStrictEqual(['AUTH_SECRET']);
    }
  });

  it('exige les quatre variables de stockage ensemble', () => {
    const error = expectConfigurationError({
      ...minimalSource(),
      STORAGE_ENDPOINT: 'https://stockage.exemple.test',
    });

    expect(error.invalidVariables).toStrictEqual([
      'STORAGE_BUCKET',
      'STORAGE_ACCESS_KEY',
      'STORAGE_SECRET_KEY',
    ]);
  });
});

describe('message d erreur de configuration', () => {
  it('nomme chaque variable fautive sans jamais reproduire sa valeur', () => {
    const error = expectConfigurationError({
      APP_ENV: 'local',
      LOG_LEVEL: SENTINELS.logLevel,
      DATABASE_URL: `mysql://utilisateur:${SENTINELS.databaseUrl}@localhost:3306/base`,
      DATABASE_POOL_MAX: SENTINELS.poolMax,
      AUTH_SECRET: SENTINELS.authSecret,
      MAP_STYLE_URL: SENTINELS.mapStyleUrl,
      STORAGE_BUCKET: SENTINELS.storageBucket,
    });

    const expectedVariables = [
      'LOG_LEVEL',
      'DATABASE_URL',
      'DATABASE_POOL_MAX',
      'AUTH_SECRET',
      'MAP_STYLE_URL',
      'STORAGE_ENDPOINT',
      'STORAGE_ACCESS_KEY',
      'STORAGE_SECRET_KEY',
    ];
    for (const variable of expectedVariables) {
      expect(error.message).toContain(variable);
      expect(error.invalidVariables).toContain(variable);
    }

    // Le coeur du test : aucune valeur lue ne ressort, ni dans le message, ni dans les motifs.
    const emitted = [error.message, ...error.problems.map((problem) => problem.reason)].join('\n');
    for (const sentinel of Object.values(SENTINELS)) {
      expect(emitted).not.toContain(sentinel);
    }
  });

  it('ne reproduit pas la valeur d un secret trop court', () => {
    const error = expectConfigurationError({
      ...minimalSource(),
      AUTH_SECRET: SENTINELS.authSecret,
    });

    expect(error.invalidVariables).toStrictEqual(['AUTH_SECRET']);
    expect(error.message).toContain('AUTH_SECRET');
    expect(error.message).not.toContain(SENTINELS.authSecret);
  });
});

describe('getServerConfig', () => {
  const initialEnvironment = { ...process.env };

  beforeEach(() => {
    resetServerConfigCache();
    process.env.APP_ENV = 'local';
    process.env.APP_VERSION = '0.0.0-test';
    process.env.DATABASE_URL = VALID_DATABASE_URL;
  });

  afterEach(() => {
    resetServerConfigCache();
    for (const key of Object.keys(process.env)) {
      if (!(key in initialEnvironment)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, initialEnvironment);
  });

  it('mémoïse la configuration du processus', () => {
    const first = getServerConfig();
    const second = getServerConfig();

    expect(second).toBe(first);
  });

  it('relit l environnement après vidage du cache', () => {
    expect(getServerConfig().appVersion).toBe('0.0.0-test');

    process.env.APP_VERSION = '0.0.1-test';
    expect(getServerConfig().appVersion).toBe('0.0.0-test');

    resetServerConfigCache();
    expect(getServerConfig().appVersion).toBe('0.0.1-test');
  });

  it('refuse de démarrer sur une configuration inutilisable', () => {
    delete process.env.DATABASE_URL;

    expect(() => getServerConfig()).toThrow(ConfigurationError);
  });
});

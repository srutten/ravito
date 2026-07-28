import { describe, expect, it } from 'vitest';
import {
  DatabaseConfigurationError,
  describeFailure,
  redactEnvironmentSecrets,
  redactSecrets,
  redactUrl,
  resolveApplicationTarget,
  resolveMigrationTarget,
} from '../../scripts/db/lib/database-url';

/**
 * Résolution et masquage de la cible de connexion des scripts `db:*` (US-002, critère 15).
 *
 * Le test central de ce fichier est négatif. Le critère 15 énonce que « la chaîne de connexion,
 * l'utilisateur et le mot de passe ne doivent JAMAIS apparaître dans un message d'erreur, un
 * journal ou une sortie de script ». Un critère de cette forme ne se vérifie pas en relisant le
 * code : il se vérifie en fabriquant des valeurs sentinelles reconnaissables, en provoquant chaque
 * chemin d'échec, et en cherchant ces sentinelles dans tout ce qui ressort.
 *
 * Aucune valeur ci-dessous n'est réelle : ce sont des marqueurs conçus pour être recherchés.
 */

const PASSWORD = 'sentinelle-motdepasse-K3L2M1';
const USERNAME = 'sentinelle-utilisateur-N9B8V7';
const DATABASE = 'sentinelle-base-C6X5Z4';
const HOST = 'base.exemple.test';
const PORT = '5432';
const VALID_URL = `postgresql://${USERNAME}:${PASSWORD}@${HOST}:${PORT}/${DATABASE}`;
const MIGRATION_URL = `postgres://${USERNAME}-migration:${PASSWORD}-migration@${HOST}:${PORT}/${DATABASE}`;

/** Tout ce qu'aucune sortie ne doit jamais contenir. */
const FORBIDDEN: readonly string[] = [
  PASSWORD,
  `${PASSWORD}-migration`,
  USERNAME,
  `${USERNAME}-migration`,
  DATABASE,
  VALID_URL,
  MIGRATION_URL,
];

function expectNoSecret(text: string): void {
  for (const secret of FORBIDDEN) {
    expect(text).not.toContain(secret);
  }
}

/** Capture l'erreur de configuration attendue, ou échoue si la valeur a été acceptée. */
function expectConfigurationError(
  resolve: () => unknown,
  ...names: readonly string[]
): DatabaseConfigurationError {
  try {
    resolve();
  } catch (error) {
    if (!(error instanceof DatabaseConfigurationError)) {
      throw error;
    }
    for (const name of names) {
      expect(error.message).toContain(name);
    }
    expectNoSecret(error.message);
    return error;
  }
  throw new Error('La configuration aurait dû être refusée.');
}

describe('redactUrl', () => {
  it('ne restitue que le protocole, l’hôte et le port', () => {
    expect(redactUrl(VALID_URL)).toBe(`postgresql://[masqué]@${HOST}:${PORT}`);
  });

  it('ne laisse fuir ni mot de passe, ni utilisateur, ni nom de base', () => {
    expectNoSecret(redactUrl(VALID_URL));
    expectNoSecret(redactUrl(MIGRATION_URL));
  });

  it('masque aussi un mot de passe encodé en pourcentage', () => {
    const raw = 'mot:de@passe/complexe';
    const url = `postgresql://${USERNAME}:${encodeURIComponent(raw)}@${HOST}:${PORT}/${DATABASE}`;
    const redacted = redactUrl(url);
    expect(redacted).not.toContain(raw);
    expect(redacted).not.toContain(encodeURIComponent(raw));
    expectNoSecret(redacted);
  });

  it('conserve un hôte sans port, qui reste une information non sensible', () => {
    expect(redactUrl(`postgresql://${USERNAME}:${PASSWORD}@${HOST}/${DATABASE}`)).toBe(
      `postgresql://[masqué]@${HOST}`,
    );
  });

  it("masque intégralement une valeur qui n'est pas une URL", () => {
    // Une chaîne illisible peut être un secret mal collé : la restituer serait la divulguer.
    expect(redactUrl(`pas-une-url-${PASSWORD}`)).toBe('[masqué]');
    expect(redactUrl('')).toBe('[masqué]');
  });
});

describe('resolveMigrationTarget', () => {
  it('privilégie DATABASE_MIGRATION_URL quand elle est renseignée', () => {
    const target = resolveMigrationTarget({
      DATABASE_MIGRATION_URL: MIGRATION_URL,
      DATABASE_URL: VALID_URL,
    });
    expect(target.url).toBe(MIGRATION_URL);
    expect(target.label).toBe('DATABASE_MIGRATION_URL');
    // L'étiquette est ce que les messages affichent : elle doit être un nom de variable, pas une valeur.
    expectNoSecret(target.label);
  });

  it('accepte DATABASE_URL en repli, en conservant une étiquette affichable', () => {
    const target = resolveMigrationTarget({ DATABASE_URL: VALID_URL });
    expect(target.url).toBe(VALID_URL);
    expect(target.label).toBe('DATABASE_URL');
  });

  it('refuse une configuration absente en nommant les deux variables attendues', () => {
    expectConfigurationError(
      () => resolveMigrationTarget({}),
      'DATABASE_MIGRATION_URL',
      'DATABASE_URL',
    );
  });

  it('traite une valeur vide ou blanche comme absente', () => {
    expectConfigurationError(() => resolveMigrationTarget({ DATABASE_URL: '   ' }), 'DATABASE_URL');
    expectConfigurationError(
      () => resolveMigrationTarget({ DATABASE_MIGRATION_URL: '', DATABASE_URL: '' }),
      'DATABASE_URL',
    );
  });

  it('refuse un protocole qui n’est pas PostgreSQL, sans reproduire la valeur', () => {
    const failure = expectConfigurationError(
      () =>
        resolveMigrationTarget({ DATABASE_URL: `mysql://${USERNAME}:${PASSWORD}@${HOST}/base` }),
      'DATABASE_URL',
    );
    expect(failure.message).toContain('protocole');
  });

  it("refuse une valeur qui n'est pas une URL, sans reproduire la valeur", () => {
    expectConfigurationError(
      () => resolveMigrationTarget({ DATABASE_MIGRATION_URL: `pas-une-url-${PASSWORD}` }),
      'DATABASE_MIGRATION_URL',
    );
  });

  it('refuse une URL qui ne désigne aucune base de données', () => {
    const failure = expectConfigurationError(
      () =>
        resolveMigrationTarget({ DATABASE_URL: `postgresql://${USERNAME}:${PASSWORD}@${HOST}` }),
      'DATABASE_URL',
    );
    expect(failure.message).toContain('base de données');
  });
});

describe('resolveApplicationTarget', () => {
  it('accepte une configuration valide', () => {
    const target = resolveApplicationTarget({ DATABASE_URL: VALID_URL });
    expect(target).toEqual({ url: VALID_URL, label: 'DATABASE_URL' });
  });

  it('ignore DATABASE_MIGRATION_URL : le compte applicatif ne migre jamais', () => {
    // Critère 17 : le compte applicatif n'a ni droit de schéma ni superutilisateur. Si cette
    // fonction retombait sur la cible de migration, le seed s'exécuterait avec le compte privilégié
    // et un GRANT oublié dans une migration passerait inaperçu jusqu'en recette.
    expectConfigurationError(
      () => resolveApplicationTarget({ DATABASE_MIGRATION_URL: MIGRATION_URL }),
      'DATABASE_URL',
    );
  });

  it('refuse une configuration absente ou invalide sans reproduire la valeur', () => {
    expectConfigurationError(() => resolveApplicationTarget({}), 'DATABASE_URL');
    expectConfigurationError(
      () => resolveApplicationTarget({ DATABASE_URL: `postgresql://${HOST}` }),
      'DATABASE_URL',
    );
  });
});

describe('masquage des sorties', () => {
  it('remplace la chaîne complète, le couple identifiant/mot de passe et le mot de passe seul', () => {
    const text = [
      `échec sur ${VALID_URL}`,
      `identifiant ${USERNAME}, mot de passe ${PASSWORD}`,
      `couple ${USERNAME}:${PASSWORD}`,
    ].join(' ');
    expectNoSecret(redactSecrets(text, [VALID_URL]));
  });

  it('relit les valeurs sensibles depuis l’environnement, y compris DATABASE_APP_PASSWORD', () => {
    const appPassword = 'sentinelle-motdepasse-applicatif-T5R4E3';
    const env = {
      DATABASE_URL: VALID_URL,
      DATABASE_MIGRATION_URL: MIGRATION_URL,
      DATABASE_APP_PASSWORD: appPassword,
    };
    const masked = redactEnvironmentSecrets(
      `${VALID_URL} ${MIGRATION_URL} ${appPassword} ${PASSWORD}`,
      env,
    );
    expectNoSecret(masked);
    expect(masked).not.toContain(appPassword);
  });

  it("masque le message d'une erreur produite par le pilote PostgreSQL", () => {
    // Le pilote recopie volontiers l'identifiant dans « password authentication failed for user … ».
    const error = new Error(`password authentication failed for user "${USERNAME}" (${VALID_URL})`);
    expectNoSecret(describeFailure(error, { DATABASE_URL: VALID_URL }));
  });

  it("masque aussi ce qui n'est pas une instance d'Error", () => {
    expectNoSecret(describeFailure(`échec brut : ${VALID_URL}`, { DATABASE_URL: VALID_URL }));
  });
});

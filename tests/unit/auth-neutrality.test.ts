import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetServerConfigCache } from '@/config/env';
import { withMinimumDuration } from '@/domain/identity/neutrality';
import { hashOriginAddress, summarizeUserAgent, toSourceSubject } from '@/domain/identity/origin';
import { MINIMUM_PUBLIC_COMMAND_DURATION_MS } from '@/domain/identity/policy';

/**
 * Plancher de durée et traitement de l'origine d'un appel.
 *
 * LE PLANCHER EST LA TROISIÈME LIGNE de la neutralité du critère 7, jamais la première : l'égalité
 * du travail passe avant, et elle s'éprouve contre une vraie base
 * (`tests/integration/auth-identity-flow.test.ts`). Ce qui se teste ici, sans base, est que le
 * plancher s'applique AUSSI au chemin d'erreur. Une demande refusée d'emblée reviendrait sinon en
 * une fraction du temps d'une demande acceptée, et la différence suffirait à distinguer les deux.
 *
 * L'ORIGINE arrive en clair et ne doit jamais être conservée telle quelle : l'adresse est hachée,
 * l'en-tête de navigateur réduit à un résumé trop pauvre pour distinguer deux personnes
 * (docs/privacy-rgpd.md).
 */

const initialEnvironment = { ...process.env };

/** Plancher court : ces tests mesurent un rattrapage, pas la valeur de production. */
const FLOOR_MS = 120;
/** Tolérance d'ordonnancement. Les horloges de test ne sont pas des horloges temps réel. */
const SCHEDULING_SLACK_MS = 25;

beforeAll(() => {
  resetServerConfigCache();
  process.env.APP_ENV = 'local';
  process.env.APP_VERSION = '0.0.0-test';
  process.env.LOG_LEVEL = 'error';
  process.env.DATABASE_URL = 'postgresql://utilisateur:motdepasse-fictif@localhost:5432/appui_feux';
  process.env.DATABASE_SSL = 'disable';
  process.env.AUTH_SECRET = 'secret-de-test-fictif-de-plus-de-32-caracteres';
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

async function measure(run: () => Promise<unknown>): Promise<number> {
  const startedAt = performance.now();
  try {
    await run();
  } catch {
    // La durée seule nous intéresse : le sort de l'appel est vérifié séparément.
  }
  return performance.now() - startedAt;
}

describe('withMinimumDuration', () => {
  it('ne rend jamais la main avant le plancher', async () => {
    const elapsed = await measure(() => withMinimumDuration(FLOOR_MS, async () => 'valeur'));

    expect(elapsed).toBeGreaterThanOrEqual(FLOOR_MS - SCHEDULING_SLACK_MS);
  });

  it('applique le plancher AUSSI quand l exécution lève', async () => {
    const elapsed = await measure(() =>
      withMinimumDuration(FLOOR_MS, () => Promise.reject(new Error('refus immédiat'))),
    );

    // C'est le cas qui compte : un refus instantané qui reviendrait plus vite qu'une acceptation
    // rétablirait, par la seule durée, la distinction que la réponse refuse de faire.
    expect(elapsed).toBeGreaterThanOrEqual(FLOOR_MS - SCHEDULING_SLACK_MS);
  });

  it('égalise les durées de deux chemins de coûts très différents', async () => {
    const cheap = await measure(() => withMinimumDuration(FLOOR_MS, async () => 'immédiat'));
    const costly = await measure(() =>
      withMinimumDuration(FLOOR_MS, async () => {
        await new Promise((resolve) => setTimeout(resolve, FLOOR_MS / 3));
        return 'plus lent';
      }),
    );

    expect(Math.abs(costly - cheap)).toBeLessThan(FLOOR_MS / 2);
  });

  it('n ajoute aucun délai lorsque le travail a déjà dépassé le plancher', async () => {
    const elapsed = await measure(() =>
      withMinimumDuration(FLOOR_MS, async () => {
        await new Promise((resolve) => setTimeout(resolve, FLOOR_MS * 2));
        return 'lent';
      }),
    );

    // Le plancher absorbe le résidu ; il ne double pas la durée d'un appel déjà long.
    expect(elapsed).toBeLessThan(FLOOR_MS * 3);
  });

  it('rend la valeur produite et propage l exception d origine', async () => {
    await expect(
      withMinimumDuration(1, async () => ({ challengeId: 'abc' })),
    ).resolves.toStrictEqual({ challengeId: 'abc' });

    const failure = new Error('cause réelle');
    await expect(withMinimumDuration(1, () => Promise.reject(failure))).rejects.toBe(failure);
  });

  it('retient un plancher supérieur au coût réel du travail de connexion', () => {
    // Le plancher n'a de sens que s'il domine largement le travail des deux branches. La mesure
    // de ce travail appartient aux tests d'intégration ; ici on fige seulement la valeur retenue.
    expect(MINIMUM_PUBLIC_COMMAND_DURATION_MS).toBe(250);
  });
});

describe('summarizeUserAgent', () => {
  it('réduit l en-tête à un navigateur majeur et une plateforme', () => {
    expect(
      summarizeUserAgent('Mozilla/5.0 (Android 14; Mobile; rv:141.0) Gecko/141.0 Firefox/141.0.2'),
    ).toBe('Firefox 141 / Android');
  });

  it('ne résume pas un Edge en Chrome, ni un Chrome en Safari', () => {
    // Edge et Opera annoncent « Chrome », Chrome annonce « Safari » : l'ordre des motifs est la
    // logique elle-même, et un résumé faux vaut moins qu'une colonne vide.
    expect(
      summarizeUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
      ),
    ).toBe('Edge 140 / Windows');
    expect(
      summarizeUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome 140 / Windows');
    expect(
      summarizeUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari 18 / iOS');
  });

  it('ne conserve pas le numéro mineur, qui distingue les appareils', () => {
    const summary = summarizeUserAgent(
      'Mozilla/5.0 (Android 14; Mobile; rv:141.0) Gecko/141.0 Firefox/141.0.2',
    );

    expect(summary).not.toContain('141.0.2');
    expect(summary?.length ?? 0).toBeLessThanOrEqual(60);
  });

  it('rend null plutôt qu une valeur inventée', () => {
    expect(summarizeUserAgent(undefined)).toBeNull();
    expect(summarizeUserAgent('')).toBeNull();
    expect(summarizeUserAgent('   ')).toBeNull();
    expect(summarizeUserAgent('client-technique/1.0')).toBeNull();
  });

  it('borne le résumé même sur un en-tête démesuré', () => {
    const summary = summarizeUserAgent(`Firefox/141.0 Android ${'x'.repeat(5_000)}`);

    expect((summary ?? '').length).toBeLessThanOrEqual(60);
  });
});

describe('origine d appel', () => {
  it('hache l adresse, ou rend null quand la route n a rien su déterminer', () => {
    expect(hashOriginAddress(undefined)).toBeNull();
    expect(hashOriginAddress({})).toBeNull();
    expect(hashOriginAddress({ ipAddress: '   ' })).toBeNull();
    expect(hashOriginAddress({ ipAddress: '192.0.2.10' })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ne laisse jamais passer une adresse en clair', () => {
    const digest = hashOriginAddress({ ipAddress: '192.0.2.10' }) ?? '';

    expect(digest).not.toContain('192.0.2.10');
    expect(digest).not.toContain('192');
  });

  it('regroupe les appels sans origine sur un compteur commun, défaut le plus strict', () => {
    // Si l'infrastructure cessait de transmettre l'adresse, la limitation par source deviendrait
    // globale et bruyante au lieu de disparaître en silence.
    expect(toSourceSubject(undefined)).toBe('unknown-source');
    expect(toSourceSubject({})).toBe('unknown-source');
    expect(toSourceSubject({ ipAddress: '  ' })).toBe('unknown-source');
    expect(toSourceSubject({ ipAddress: ' 2001:DB8::1 ' })).toBe('2001:db8::1');
  });
});

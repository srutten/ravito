import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  // `exactOptionalPropertyTypes` interdit d'affecter `undefined` a une propriete optionnelle :
  // en local on omet la cle pour laisser Playwright choisir son parallelisme par defaut.
  ...(isCI ? { workers: 1 } : {}),
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Les libelles utilisateur sont en francais.
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
  },
  projects: [
    // Le parcours mobile est le parcours de reference : cf. docs/functional-specification.md,
    // regles d'interface, mobile-first.
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run start',
    url: baseURL,
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});

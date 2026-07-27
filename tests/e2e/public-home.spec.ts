import { expect, test } from '@playwright/test';

/**
 * Accueil public (US-001 critère 16, docs/screens.md écran 1).
 *
 * Ces vérifications tournent sur les deux projets de `playwright.config.ts`, mobile et bureau. Le
 * parcours mobile est le parcours de référence : la consigne de non-signalement doit y être lue
 * sans effort, c'est-à-dire sans défilement.
 */

/** Libellé de sécurité, repris mot pour mot. Toute reformulation doit être un choix explicite. */
const EMERGENCY_NOTICE =
  'Ne pas utiliser cette application pour signaler un incendie. Appeler le 18 ou le 112 en urgence.';

test.describe('accueil public', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test("affiche la marque et l'objet du service", async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Appui Feux');
    await expect(
      page.getByRole('heading', { name: 'À quoi sert la plateforme', level: 2 }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Ce que la plateforme ne fait pas', level: 3 }),
    ).toBeVisible();
  });

  test('affiche la consigne de non-signalement', async ({ page }) => {
    const notice = page.getByRole('region', { name: 'Consigne de sécurité' });

    await expect(notice).toBeVisible();
    await expect(notice).toContainText(EMERGENCY_NOTICE);
  });

  test('garde la consigne à l écran sans défilement, parcours mobile', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'parcours de référence, cf. docs/screens.md');
    const notice = page.getByRole('region', { name: 'Consigne de sécurité' });

    // Le bandeau est collé au bas de la fenêtre sous 48rem : une consigne de sécurité que l'on
    // doit aller chercher n'est pas une consigne de sécurité.
    await expect(notice).toBeInViewport();
  });

  test('propose un accès au parcours de connexion', async ({ page }) => {
    const signIn = page.getByRole('link', { name: 'Se connecter' });

    await expect(signIn).toBeVisible();
    await expect(signIn).toHaveAttribute('href', '/auth');

    await signIn.click();
    await expect(page).toHaveURL(/\/auth$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Connexion');
  });

  test("propose un accès aux conditions d'utilisation", async ({ page }) => {
    const terms = page.getByRole('link', { name: "Consulter les conditions d'utilisation" });

    await expect(terms).toBeVisible();
    await expect(terms).toHaveAttribute('href', '/terms');

    await terms.click();
    await expect(page).toHaveURL(/\/terms$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText("Conditions d'utilisation");
  });

  test('garde la consigne de non-signalement sur les pages publiques', async ({ page }) => {
    for (const path of ['/auth', '/terms']) {
      await page.goto(path);
      await expect(page.getByRole('region', { name: 'Consigne de sécurité' })).toContainText(
        EMERGENCY_NOTICE,
      );
    }
  });

  test("n'affiche ni formulaire de connexion ni promesse non tenue", async ({ page }) => {
    // Le lot 0 ne livre pas l'authentification : aucun champ ne doit inviter à saisir un
    // identifiant, sur l'accueil comme sur la page de connexion.
    await expect(page.locator('input')).toHaveCount(0);
    await expect(page.locator('form')).toHaveCount(0);

    await page.goto('/auth');
    await expect(page.locator('input')).toHaveCount(0);
    await expect(page.locator('form')).toHaveCount(0);
    await expect(page.getByText('Authentification pas encore disponible')).toBeVisible();
  });

  test('ne charge aucune ressource d origine tierce', async ({ page }) => {
    const externalRequests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.hostname !== 'localhost' && url.protocol !== 'data:') {
        externalRequests.push(request.url());
      }
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    expect(externalRequests).toStrictEqual([]);
  });
});

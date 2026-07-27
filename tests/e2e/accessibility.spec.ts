import { expect, test } from '@playwright/test';

/**
 * Accessibilité de base de l'accueil public (US-001 critère 17, docs/screens.md).
 *
 * Une personne qui navigue au clavier ou avec un lecteur d'écran doit atteindre la connexion sans
 * souris et savoir en permanence où se trouve le focus. Ces vérifications tournent sur les deux
 * projets, mobile et bureau.
 */

const MAX_TAB_PRESSES = 12;

/** Style de focus réellement calculé sur l'élément actif. */
async function activeElementFocusRing(page: import('@playwright/test').Page): Promise<{
  tagName: string;
  outlineStyle: string;
  outlineWidth: number;
}> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active === null) {
      return { tagName: 'aucun', outlineStyle: 'none', outlineWidth: 0 };
    }
    const style = window.getComputedStyle(active);
    return {
      tagName: active.tagName.toLowerCase(),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  });
}

test.describe('accessibilité de l accueil public', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('déclare la langue du document en français', async ({ page }) => {
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  });

  test('porte un titre de niveau 1 unique', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Appui Feux');
  });

  test('expose un repère de contenu principal atteignable au clavier', async ({ page }) => {
    const skipLink = page.getByRole('link', { name: 'Aller au contenu principal' });

    await page.keyboard.press('Tab');

    // Le lien d'évitement est le premier élément focalisable, et il devient visible au focus.
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeInViewport();
    await expect(skipLink).toHaveAttribute('href', '#contenu-principal');

    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toHaveAttribute('id', 'contenu-principal');
  });

  test('atteint le bouton de connexion au clavier, avec un focus visible', async ({ page }) => {
    const signIn = page.getByRole('link', { name: 'Se connecter' });

    let reached = false;
    for (let press = 0; press < MAX_TAB_PRESSES; press += 1) {
      await page.keyboard.press('Tab');
      if (await signIn.evaluate((element) => element === document.activeElement)) {
        reached = true;
        break;
      }
    }

    expect(reached, `connexion non atteinte en ${MAX_TAB_PRESSES} tabulations`).toBe(true);
    await expect(signIn).toBeFocused();
    await expect(signIn).toBeInViewport();

    const focusRing = await activeElementFocusRing(page);
    expect(focusRing.outlineStyle).not.toBe('none');
    expect(focusRing.outlineWidth).toBeGreaterThanOrEqual(2);
  });

  test('active la connexion à la touche Entrée', async ({ page }) => {
    const signIn = page.getByRole('link', { name: 'Se connecter' });

    await signIn.focus();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/auth$/);
  });

  test('nomme la région de consigne de sécurité pour un lecteur d écran', async ({ page }) => {
    const notice = page.getByRole('region', { name: 'Consigne de sécurité' });

    await expect(notice).toHaveCount(1);
    // La consigne est écrite en toutes lettres : rien n'est porté par la seule icône.
    await expect(notice).toContainText('Appeler le 18 ou le 112 en urgence.');
  });

  test('offre des cibles tactiles suffisantes sur le parcours principal', async ({ page }) => {
    const signIn = page.getByRole('link', { name: 'Se connecter' });

    const box = await signIn.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });
});

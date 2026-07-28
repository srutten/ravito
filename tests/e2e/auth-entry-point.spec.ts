import { expect, test } from '@playwright/test';

/**
 * Accès à l'écran de connexion depuis l'accueil public (docs/screens.md, écrans 1 et 2).
 *
 * CE FICHIER PORTE UN TEST QUI ÉCHOUE, ET C'EST VOULU. L'écran de connexion de US-010 est livré,
 * fonctionne et est éprouvé de bout en bout par `auth-sign-in.spec.ts` — mais rien n'y conduit
 * depuis l'accueil public. Le bouton « Se connecter » de `app/(public)/page.tsx` pointe toujours
 * sur `/auth`, coquille du lot 0, dont le texte affirme que « l'authentification n'est pas encore
 * disponible ». C'est faux depuis cette story.
 *
 * POURQUOI CE N'EST PAS UN DÉTAIL D'INTERFACE. `docs/screens.md` écran 1 exige un bouton de
 * connexion, et la note d'arbitrage de US-010 retient la fusion des écrans 1 et 2 : l'accueil est
 * la porte d'entrée. En l'état, un utilisateur qui suit le parcours prévu lit qu'il ne peut pas se
 * connecter, alors qu'il le peut. Une fonctionnalité inatteignable n'est pas une fonctionnalité
 * livrée, et un écran qui annonce une indisponibilité fausse est pire qu'un écran manquant : il
 * fait renoncer.
 *
 * CE QUE LA CORRECTION IMPLIQUE, et pourquoi elle n'est pas faite ici. Deux lignes suffisent —
 * `AUTHENTICATION_PATH` dans `app/(public)/page.tsx`, et le sort de `app/(public)/auth/page.tsx`,
 * à supprimer ou à rediriger. Ces deux fichiers appartiennent au périmètre d'un autre agent. Le
 * changement fera par ailleurs échouer trois assertions de `tests/e2e/public-home.spec.ts`, écrit
 * au lot 0, qui figent l'état ancien : le lien vers `/auth`, le texte « Authentification pas encore
 * disponible » et l'absence de tout formulaire sur ce chemin. Les deux fichiers doivent être
 * repris dans le même commit.
 */

const SIGN_IN_PATH = '/connexion';

test.describe('accès au parcours de connexion', () => {
  test("l'écran de connexion livré est atteignable et opérationnel", async ({ page }) => {
    await page.goto(SIGN_IN_PATH);

    // Le contrôle isole le défaut : l'écran existe, il fonctionne, seul le chemin qui y mène
    // manque. Sans cette vérification, l'échec ci-dessous pourrait passer pour une page absente.
    await expect(page.getByTestId('formulaire-connexion')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bienvenue !');
    await expect(page.getByRole('button', { name: 'Recevoir un code' })).toBeVisible();
  });

  test("depuis l'accueil public, le bouton de connexion mène au formulaire de connexion", async ({
    page,
  }) => {
    await page.goto('/');
    const signIn = page.getByRole('link', { name: 'Se connecter' });
    await expect(signIn).toBeVisible();

    await signIn.click();

    // ÉCHEC ATTENDU EN L'ÉTAT : la navigation aboutit sur `/auth`, qui affiche « Authentification
    // pas encore disponible » et ne contient aucun champ. Voir l'en-tête de ce fichier.
    await expect(page).toHaveURL(new RegExp(`${SIGN_IN_PATH}$`));
    await expect(page.getByTestId('formulaire-connexion')).toBeVisible();
    await expect(page.getByText('Authentification pas encore disponible')).toHaveCount(0);
  });
});

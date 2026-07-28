import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentSession } from '@/authorization';
import { HeroBackdrop } from '@/components/layout/hero-backdrop';
import { Alert } from '@/components/ui/alert';
import { BrandLogo } from '@/components/ui/brand-logo';
import { Card } from '@/components/ui/card';
import { DocumentIcon } from '@/components/ui/icons';
import { NetworkIndicator } from '@/components/ui/network-indicator';
import { isFeatureEnabled } from '@/config/feature-flags';
import { POST_SIGN_IN_REDIRECT_PATH } from '@/domain/identity';
import { messages } from '@/i18n/fr';
import styles from './connexion.module.css';
import { SignInForm } from './sign-in-form';

/**
 * Écran de connexion (docs/screens.md, écran 2).
 *
 * COMPOSANT SERVEUR. Seul le formulaire est un composant client, et il l'est pour des raisons
 * écrites en tête de `sign-in-form.tsx`. Tout le reste — décor, textes, encart du second facteur,
 * présence ou non du lien de création de compte — est décidé et rendu sur le serveur : rien de
 * tout cela ne dépend du navigateur, et le rendre côté client alourdirait le premier écran vu
 * d'une plateforme dont les utilisateurs sont, par construction, sur un téléphone et parfois en
 * réseau dégradé.
 *
 * TROIS ÉCARTS DE MAQUETTE, tous arbitrés par la note de `docs/screens.md` et par la règle de
 * résolution de conflit de `CLAUDE.md`, qui classe les maquettes après la sécurité des personnes,
 * les permissions et les critères d'acceptation.
 *
 * 1. AUCUN ONGLET DE RÔLE. Un onglet qui réagirait différemment selon l'identifiant permettrait
 *    d'énumérer les comptes coordinateurs, première étape du hameçonnage ciblé qui ouvre la liste
 *    des menaces prioritaires ; un onglet sans effet serait une interface qui ment. Le rôle vient
 *    du compte et la destination est calculée par le serveur (ADR-016).
 * 2. AUCUN CHAMP DE MOT DE PASSE, aucune case « Se souvenir de moi », aucun lien « Mot de passe
 *    oublié ». Il n'existe aucun mot de passe sur cette plateforme : un secret qui n'existe pas
 *    ne peut pas fuiter (ADR-015). Le style primaire de la maquette est transféré au bouton
 *    « Recevoir un code », qui devient l'action unique.
 * 3. LE BANDEAU « Temps réel connecté » DE LA MAQUETTE EST ÉCARTÉ : rien ne mesure un temps réel
 *    qui n'est pas livré. L'emplacement porte l'indicateur de connexion réseau, qui, lui, observe
 *    l'état réel du navigateur.
 *
 * Le lien « Créer un compte » est conditionné à `ENABLE_PUBLIC_REGISTRATION`, faux par défaut : il
 * est donc absent en l'état, avec la phrase qui le porte.
 */

export const metadata: Metadata = {
  title: messages.ui.signIn.pageTitle,
  description: messages.ui.signIn.pageDescription,
};

const TERMS_PATH = '/terms';

/**
 * Destination du lien de création de compte. La page correspondante relève d'une story
 * ultérieure : activer `ENABLE_PUBLIC_REGISTRATION` avant sa livraison mènerait à une page
 * introuvable. Le flag est faux par défaut, le lien n'existe donc pas aujourd'hui.
 */
const REGISTRATION_PATH = '/inscription';

const labels = messages.ui.signIn;

export default async function ConnexionPage() {
  /**
   * Une personne déjà connectée n'a rien à faire sur un écran de connexion : elle y saisirait un
   * identifiant pour se retrouver là où elle était déjà. La redirection est décidée par le
   * serveur, à partir de la session réelle, jamais à partir d'un indice conservé côté navigateur.
   */
  const session = await getCurrentSession();
  if (session !== null) {
    redirect(POST_SIGN_IN_REDIRECT_PATH);
  }

  const isRegistrationOpen = isFeatureEnabled('ENABLE_PUBLIC_REGISTRATION');

  return (
    <>
      <section className={styles.hero} aria-labelledby="marque-appui-feux">
        <HeroBackdrop />
        <div className={styles.heroInner}>
          <NetworkIndicator />
          <div className={styles.brand}>
            <BrandLogo size="lg" />
            <p className={styles.wordmark} id="marque-appui-feux">
              {messages.ui.app.name}
            </p>
          </div>
        </div>
      </section>

      <div className={styles.content}>
        <div className={styles.contentInner}>
          <Card padding="large" tone="raised">
            <h1 className={styles.title}>{labels.welcomeTitle}</h1>
            <p className={styles.subtitle}>{labels.welcomeSubtitle}</p>

            <SignInForm />

            <div className={styles.mfa}>
              <Alert tone="info" title={labels.mfaTitle}>
                {labels.mfaBody}
              </Alert>
            </div>

            {isRegistrationOpen ? (
              <p className={styles.registration}>
                <span>{labels.registrationQuestion}</span>{' '}
                <Link className={styles.registrationLink} href={REGISTRATION_PATH}>
                  {labels.registrationLink}
                </Link>
              </p>
            ) : null}
          </Card>

          <p className={styles.terms}>
            <Link
              className={styles.termsLink}
              href={TERMS_PATH}
              aria-label={messages.ui.home.termsAriaLabel}
            >
              <DocumentIcon width={20} height={20} />
              {messages.ui.home.terms}
            </Link>
          </p>
        </div>
      </div>
    </>
  );
}

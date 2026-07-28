import Link from 'next/link';
import { HeroBackdrop } from '@/components/layout/hero-backdrop';
import { BrandLogo } from '@/components/ui/brand-logo';
import { LinkButton } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DocumentIcon, LockIcon, ShieldIcon } from '@/components/ui/icons';
import { NetworkIndicator } from '@/components/ui/network-indicator';
import { messages } from '@/i18n/fr';
import styles from './home.module.css';

/**
 * Accueil public (docs/screens.md, écran 1).
 *
 * Périmètre du lot 0 : marque, présentation du service, accès au parcours d'authentification,
 * accès aux conditions d'utilisation, indicateur de connexion réseau. Le formulaire de connexion
 * de la maquette relève des stories US-010 et US-011.
 *
 * Cette page n'affiche aucune donnée personnelle, aucune donnée opérationnelle, aucune position,
 * et ne charge aucune ressource d'origine tierce.
 */

// À déplacer dans `src/i18n/fr.ts` lorsque ce fichier sera dans le périmètre. L'accroche est
// celle de la maquette de référence.
const BRAND_BASELINE = 'Mobilisation logistique sécurisée';

const AUTHENTICATION_PATH = '/connexion';
const TERMS_PATH = '/terms';

export default function HomePage() {
  return (
    <>
      <section className={styles.hero} aria-labelledby="marque-appui-feux">
        <HeroBackdrop />
        <div className={styles.heroInner}>
          <NetworkIndicator />
          <div className={styles.brand}>
            <BrandLogo size="lg" />
            <h1 className={styles.wordmark} id="marque-appui-feux">
              {messages.ui.home.title}
            </h1>
          </div>
          <p className={styles.baseline}>{BRAND_BASELINE}</p>
        </div>
      </section>

      <div className={styles.content}>
        <div className={styles.contentInner}>
          <Card padding="large" title={messages.ui.home.purposeTitle}>
            <p className={styles.lead}>{messages.ui.home.purpose}</p>

            <div className={styles.actions}>
              <LinkButton
                href={AUTHENTICATION_PATH}
                variant="primary"
                fullWidth
                icon={<LockIcon width={20} height={20} />}
              >
                {messages.ui.home.signIn}
              </LinkButton>
            </div>

            <h3 className={styles.limitsTitle}>{messages.ui.home.limitsTitle}</h3>
            <ul className={styles.limits}>
              {messages.ui.home.limits.map((limit) => (
                <li className={styles.limitItem} key={limit}>
                  <ShieldIcon className={styles.limitMarker} width={20} height={20} />
                  <span>{limit}</span>
                </li>
              ))}
            </ul>
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

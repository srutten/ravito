import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getCurrentSession } from '@/authorization';
import { EmergencyNotice } from '@/components/layout/emergency-notice';
import { MAIN_CONTENT_ID } from '@/components/layout/skip-link';
import { BrandLogo } from '@/components/ui/brand-logo';
import { InboxIcon, ShieldIcon } from '@/components/ui/icons';
import { isPlatformAdministrator } from '@/domain/organizations';
import { messages } from '@/i18n/fr';
import styles from './app-shell.module.css';

/**
 * Coquille des écrans connectés.
 *
 * LE GROUPE DE ROUTAGE N'EST PAS LA PROTECTION, LA REDIRECTION CI-DESSOUS L'EST. Un groupe
 * `(app)` ne ferme rien par lui-même : c'est une convention de mise en page. La barrière réelle
 * est `requireSession`, appelée avant tout rendu, et surtout elle n'est pas la seule — chaque
 * route d'API refait le même contrôle. Masquer un lien n'est jamais un contrôle d'accès
 * (CLAUDE.md) : un appel direct à `/api/v1/organizations` se heurte à la même barrière, que
 * cette coquille ait été rendue ou non.
 *
 * `getCurrentSession` PLUTÔT QUE `requireSession` : la seconde lève `UNAUTHENTICATED`, ce qui
 * produirait une page d'erreur là où l'on veut un écran de connexion. Le refus par défaut
 * reste entier — la fonction renvoie `null` sur toute anomalie, cookie absent, jeton inconnu,
 * session expirée ou révoquée, base injoignable — et toutes ces anomalies mènent ici à la
 * connexion. C'est `requireSession` qui garde les routes d'API, où le code d'erreur est la
 * réponse attendue.
 *
 * LA CONSIGNE DE SÉCURITÉ RESTE AFFICHÉE UNE FOIS CONNECTÉ. Elle est posée par la coquille et
 * non par chaque page : une consigne de sécurité ne doit pas dépendre du fait qu'un auteur de
 * page ait pensé à l'ajouter, et elle vaut autant pour un contributeur connecté que pour un
 * visiteur — davantage même, puisqu'il est en situation d'agir.
 *
 * LE LIEN D'ADMINISTRATION N'APPARAÎT QUE POUR UN ADMINISTRATEUR PLATEFORME. Ce n'est pas une
 * mesure de sécurité, la route et la page refusant toutes deux d'elles-mêmes : c'est une mesure
 * d'honnêteté d'interface. Un lien visible qui mène à un refus fait croire à une panne, et
 * apprend au passage qu'un écran existe.
 */

const SIGN_IN_PATH = '/connexion';
const ACCOUNT_PATH = '/apres-connexion';
const NEW_ORGANIZATION_PATH = '/organisations/nouvelle';
const PENDING_ORGANIZATIONS_PATH = '/administration/organisations-en-attente';

const labels = messages.ui.appShell;

export default async function AppLayout({ children }: { readonly children: ReactNode }) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect(SIGN_IN_PATH);
  }

  // Relu à chaque requête, jamais mis en cache (ADR-021) : une adhésion suspendue fait
  // disparaître le lien dès la navigation suivante, comme elle ferme la route.
  const isAdministrator = await isPlatformAdministrator(session.userId);

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link className={styles.brand} href={ACCOUNT_PATH}>
            <BrandLogo size="sm" />
            <span className={styles.wordmark}>{messages.ui.app.name}</span>
          </Link>
          <nav className={styles.nav} aria-label={labels.navigationLabel}>
            <Link className={styles.navLink} href={ACCOUNT_PATH} data-testid="lien-mon-compte">
              {labels.account}
            </Link>
            <Link
              className={styles.navLink}
              href={NEW_ORGANIZATION_PATH}
              data-testid="lien-nouvelle-organisation"
            >
              <InboxIcon width={18} height={18} />
              {labels.newOrganization}
            </Link>
            {isAdministrator ? (
              <Link
                className={styles.navLink}
                href={PENDING_ORGANIZATIONS_PATH}
                data-testid="lien-organisations-en-attente"
              >
                <ShieldIcon width={18} height={18} />
                {labels.pendingOrganizations}
              </Link>
            ) : null}
          </nav>
        </div>
      </header>

      <main className={styles.main} id={MAIN_CONTENT_ID} tabIndex={-1}>
        <div className={styles.container}>{children}</div>
      </main>

      <EmergencyNotice />
    </div>
  );
}

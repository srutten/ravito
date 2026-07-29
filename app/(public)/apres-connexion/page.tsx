import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentSession } from '@/authorization';
import { ContentPage } from '@/components/layout/content-page';
import { Alert } from '@/components/ui/alert';
import { LinkButton } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ShieldIcon } from '@/components/ui/icons';
import { isPlatformAdministrator } from '@/domain/organizations';
import { messages } from '@/i18n/fr';
import styles from './apres-connexion.module.css';
import { SessionActions } from './session-actions';

/**
 * Page d'attente après connexion (`redirectPath` du contrat API).
 *
 * ELLE NE MENT PAS SUR SON ÉTAT. Les tableaux de bord par rôle relèvent des lots suivants et
 * `OrganizationMember` n'existe pas encore : afficher ici un tableau de bord vide laisserait
 * croire à un échec de chargement plutôt qu'à une fonctionnalité non livrée, et un utilisateur
 * en situation opérationnelle passerait du temps à recharger une page qui n'a rien à charger.
 * Elle dit donc ce qui est vrai : la session est ouverte, et rien d'autre n'est encore ouvert.
 *
 * POURQUOI DANS LE GROUPE `(public)`. Le groupe de routage porte la coquille commune — repère
 * principal du lien d'évitement et bandeau de non-signalement — et non une politique d'accès. La
 * protection de cette page est ici, côté serveur, et nulle part ailleurs : sans session valide,
 * elle redirige. Un futur groupe dédié aux pages connectées pourra l'accueillir sans rien changer
 * à ce contrôle.
 *
 * `getCurrentSession` renvoie `null` sur toute anomalie — cookie absent, jeton inconnu, session
 * expirée ou révoquée, base injoignable. Le refus est donc le comportement par défaut, y compris
 * en panne.
 */

export const metadata: Metadata = {
  title: messages.ui.postSignIn.pageTitle,
  description: messages.ui.postSignIn.description,
};

const SIGN_IN_PATH = '/connexion';
const NEW_ORGANIZATION_PATH = '/organisations/nouvelle';
const PENDING_ORGANIZATIONS_PATH = '/administration/organisations-en-attente';

const labels = messages.ui.postSignIn;

/**
 * Horodatages rendus côté serveur, donc dans un fuseau choisi et non dans celui du serveur.
 * `Europe/Paris` est le fuseau d'exploitation de la plateforme ; le laisser implicite ferait
 * dépendre l'heure affichée de la machine qui rend la page.
 */
const DATE_FORMAT = new Intl.DateTimeFormat('fr-FR', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'Europe/Paris',
});

function formatInstant(instant: Date): string {
  return DATE_FORMAT.format(instant);
}

export default async function ApresConnexionPage() {
  const session = await getCurrentSession();
  if (session === null) {
    redirect(SIGN_IN_PATH);
  }

  // Relue à chaque requête, jamais mise en cache (ADR-021).
  const isAdministrator = await isPlatformAdministrator(session.userId);

  return (
    <ContentPage title={labels.pageTitle} description={labels.description}>
      <Card title={labels.accountTitle} titleLevel={2}>
        <dl className={styles.definitions} data-testid="compte-connecte">
          <div className={styles.definitionRow}>
            <dt className={styles.term}>{labels.displayNameLabel}</dt>
            <dd className={styles.value} data-testid="nom-affiche">
              {session.user.displayName}
            </dd>
          </div>
        </dl>
      </Card>

      <Card title={labels.sessionTitle} titleLevel={2}>
        <dl className={styles.definitions} data-testid="session-courante">
          <div className={styles.definitionRow}>
            <dt className={styles.term}>{labels.issuedAtLabel}</dt>
            <dd className={styles.value}>
              <time dateTime={session.session.issuedAt.toISOString()}>
                {formatInstant(session.session.issuedAt)}
              </time>
            </dd>
          </div>
          <div className={styles.definitionRow}>
            <dt className={styles.term}>{labels.expiresAtLabel}</dt>
            <dd className={styles.value}>
              <time dateTime={session.session.expiresAt.toISOString()}>
                {formatInstant(session.session.expiresAt)}
              </time>
            </dd>
          </div>
          <div className={styles.definitionRow}>
            <dt className={styles.term}>{labels.absoluteExpiresAtLabel}</dt>
            <dd className={styles.value}>
              <time dateTime={session.session.absoluteExpiresAt.toISOString()}>
                {formatInstant(session.session.absoluteExpiresAt)}
              </time>
            </dd>
          </div>
        </dl>
      </Card>

      {/*
        POINT D'ENTRÉE VERS LES ÉCRANS CONNECTÉS, ajouté au lot organisations.
        Les liens ne sont pas un contrôle d'accès : chaque écran et chaque route refont le
        contrôle de session et de rôle. Le lien d'administration n'apparaît que pour un
        administrateur plateforme, par honnêteté d'interface — un lien qui mène à un refus fait
        croire à une panne, et apprend au passage qu'un écran existe.
      */}
      <Card
        title={labels.workspacesTitle}
        description={labels.workspacesDescription}
        titleLevel={2}
      >
        <div className={styles.actions} data-testid="acces-organisations">
          <LinkButton href={NEW_ORGANIZATION_PATH} variant="primary" fullWidth>
            {messages.ui.appShell.newOrganization}
          </LinkButton>
          {isAdministrator ? (
            <LinkButton
              href={PENDING_ORGANIZATIONS_PATH}
              variant="secondary"
              fullWidth
              icon={<ShieldIcon width={20} height={20} />}
            >
              {messages.ui.appShell.pendingOrganizations}
            </LinkButton>
          ) : null}
        </div>
      </Card>

      <Alert tone="info" title={labels.noticeTitle}>
        {labels.notice}
      </Alert>

      <Card title={labels.actionsTitle} titleLevel={2}>
        <SessionActions />
      </Card>
    </ContentPage>
  );
}

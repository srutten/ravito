import type { Metadata } from 'next';
import { ContentPage } from '@/components/layout/content-page';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { getServerConfig } from '@/config/env';
import { messages } from '@/i18n/fr';
import { getRequestLogger } from '@/observability/logger';
import styles from './health.module.css';

/**
 * État du service, lisible par un humain.
 *
 * La page ne divulgue que ce qui est nécessaire à un exploitant : statut, version applicative et
 * horodatage du contrôle. Pas de version de dépendance, pas de nom d'hôte, pas de chaîne de
 * connexion, pas de trace, pas de nom de variable d'environnement (docs/threat-model.md,
 * reconnaissance).
 *
 * La sonde de base de données relève de la story US-002 : elle n'est pas câblée ici.
 */

// Rendu à chaque appel : l'horodatage doit être celui du contrôle, jamais celui de la
// construction du bundle.
export const dynamic = 'force-dynamic';

const UNKNOWN_VERSION = 'indisponible';

export const metadata: Metadata = {
  title: messages.ui.health.title,
  description: messages.ui.health.description,
};

interface ServiceSnapshot {
  readonly isOperational: boolean;
  readonly version: string;
}

/**
 * Une configuration illisible rend l'instance inapte à servir : la page l'annonce sans nommer
 * la variable en cause, le détail restant dans les journaux serveur.
 */
function readServiceSnapshot(): ServiceSnapshot {
  try {
    return { isOperational: true, version: getServerConfig().appVersion };
  } catch (error) {
    getRequestLogger().error(
      { err: error, errorCode: 'SERVICE_UNAVAILABLE' },
      'configuration serveur inutilisable, page de santé dégradée',
    );
    return { isOperational: false, version: UNKNOWN_VERSION };
  }
}

const DATE_FORMATTER = new Intl.DateTimeFormat('fr-FR', {
  dateStyle: 'long',
  timeStyle: 'medium',
  timeZone: 'UTC',
});

export default function HealthPage() {
  const snapshot = readServiceSnapshot();
  const checkedAt = new Date();
  const statusLabel = snapshot.isOperational
    ? messages.ui.health.statusOk
    : messages.ui.health.statusDown;

  return (
    <ContentPage title={messages.ui.health.title} description={messages.ui.health.description}>
      <Card padding="large">
        <p className={styles.summary}>
          <span className={styles.summaryLabel}>{messages.ui.health.statusLabel}</span>
          <StatusBadge label={statusLabel} tone={snapshot.isOperational ? 'success' : 'danger'} />
        </p>
        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt className={styles.factLabel}>{messages.ui.health.versionLabel}</dt>
            <dd className={styles.factValue}>{snapshot.version}</dd>
          </div>
          <div className={styles.fact}>
            <dt className={styles.factLabel}>{messages.ui.health.checkedAtLabel}</dt>
            <dd className={styles.factValue}>
              <time dateTime={checkedAt.toISOString()}>
                {`${DATE_FORMATTER.format(checkedAt)} (UTC)`}
              </time>
            </dd>
          </div>
        </dl>
      </Card>
    </ContentPage>
  );
}

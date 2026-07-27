import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { MAIN_CONTENT_ID } from './skip-link';
import styles from './state-page.module.css';

/**
 * Gabarit des écrans d'état plein cadre : chargement, erreur, page introuvable.
 *
 * Ces écrans ne sont pas rendus dans le gabarit des pages publiques : ils doivent donc fournir
 * eux-mêmes la région principale visée par le lien d'évitement.
 */

export interface StatePageProps {
  readonly children: ReactNode;
}

export function StatePage({ children }: StatePageProps) {
  return (
    <main className={styles.main} id={MAIN_CONTENT_ID} tabIndex={-1}>
      <div className={styles.container}>
        <Card padding="large">{children}</Card>
      </div>
    </main>
  );
}

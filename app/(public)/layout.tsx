import type { ReactNode } from 'react';
import { EmergencyNotice } from '@/components/layout/emergency-notice';
import { MAIN_CONTENT_ID } from '@/components/layout/skip-link';
import styles from './public-shell.module.css';

/**
 * Coquille commune aux pages publiques.
 *
 * Le bandeau de non-signalement est posé ici, et non dans chaque page : une consigne de sécurité
 * ne doit pas dépendre du fait qu'un auteur de page ait pensé à l'ajouter.
 */
export default function PublicLayout({ children }: { readonly children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <main className={styles.main} id={MAIN_CONTENT_ID} tabIndex={-1}>
        {children}
      </main>
      <EmergencyNotice />
    </div>
  );
}

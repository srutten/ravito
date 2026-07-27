import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowLeftIcon } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/page-header';
import styles from './content-page.module.css';

/** Gabarit des pages publiques secondaires : en-tête, contenu, retour à l'accueil. */

// À déplacer dans `src/i18n/fr.ts` lorsque ce fichier sera dans le périmètre.
const BACK_TO_HOME = "Retour à l'accueil";

export interface ContentPageProps {
  readonly title: string;
  readonly description?: string | undefined;
  readonly eyebrow?: string | undefined;
  readonly children: ReactNode;
}

export function ContentPage({ title, description, eyebrow, children }: ContentPageProps) {
  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <Link className={styles.backLink} href="/">
          <ArrowLeftIcon width={20} height={20} />
          {BACK_TO_HOME}
        </Link>
        <PageHeader
          title={title}
          {...(eyebrow !== undefined ? { eyebrow } : {})}
          {...(description !== undefined ? { description } : {})}
        />
        {children}
      </div>
    </div>
  );
}

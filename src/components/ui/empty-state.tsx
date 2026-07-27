import type { ReactNode } from 'react';
import { messages } from '@/i18n/fr';
import styles from './empty-state.module.css';
import { InboxIcon } from './icons';

/** État transverse « vide » (docs/screens.md, états transverses). */

export interface EmptyStateProps {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly icon?: ReactNode | undefined;
  readonly action?: ReactNode | undefined;
  readonly titleLevel?: 2 | 3 | undefined;
}

export function EmptyState({ title, description, icon, action, titleLevel }: EmptyStateProps) {
  const TitleTag = titleLevel === 3 ? 'h3' : 'h2';
  return (
    <div className={styles.emptyState}>
      <span className={styles.icon}>{icon ?? <InboxIcon width={32} height={32} />}</span>
      <TitleTag className={styles.title}>{title ?? messages.ui.states.empty}</TitleTag>
      {description !== undefined ? <p className={styles.description}>{description}</p> : null}
      {action !== undefined ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}

import type { ReactNode } from 'react';
import { classNames } from './class-names';
import styles from './status-badge.module.css';

/**
 * Pastille d'état.
 *
 * Le point coloré est purement décoratif : l'état est toujours écrit en toutes lettres
 * (docs/screens.md, pas d'information uniquement portée par la couleur).
 */

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface StatusBadgeProps {
  readonly label: string;
  readonly tone?: StatusTone | undefined;
  readonly compact?: boolean | undefined;
  /** `alert` réserve l'annonce immédiate aux états qui appellent une réaction. */
  readonly role?: 'status' | 'alert' | undefined;
  readonly icon?: ReactNode | undefined;
}

export function StatusBadge({ label, tone, compact, role, icon }: StatusBadgeProps) {
  const className = classNames(
    styles.badge,
    styles[tone ?? 'neutral'],
    compact === true && styles.compact,
  );
  return (
    <span className={className} {...(role !== undefined ? { role } : {})}>
      <span className={styles.dotHolder} aria-hidden="true">
        {icon ?? <span className={styles.dot} />}
      </span>
      {label}
    </span>
  );
}

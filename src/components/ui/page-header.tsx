import type { ReactNode } from 'react';
import styles from './page-header.module.css';

/**
 * En-tête d'écran : surtitre facultatif, titre, description, actions.
 * Le titre principal d'une page est unique et de niveau 1.
 */

export interface PageHeaderProps {
  readonly title: string;
  readonly eyebrow?: string | undefined;
  readonly description?: string | undefined;
  readonly level?: 1 | 2 | undefined;
  readonly titleId?: string | undefined;
  readonly actions?: ReactNode | undefined;
}

export function PageHeader({
  title,
  eyebrow,
  description,
  level,
  titleId,
  actions,
}: PageHeaderProps) {
  const TitleTag = level === 2 ? 'h2' : 'h1';
  return (
    <header className={styles.header}>
      {eyebrow !== undefined ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
      <TitleTag className={styles.title} {...(titleId !== undefined ? { id: titleId } : {})}>
        {title}
      </TitleTag>
      {description !== undefined ? <p className={styles.description}>{description}</p> : null}
      {actions !== undefined ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}

import type { ReactNode } from 'react';
import styles from './alert.module.css';
import { classNames } from './class-names';
import { CheckCircleIcon, InfoIcon, WarningTriangleIcon } from './icons';

/**
 * Encart d'information, d'avertissement ou d'erreur.
 *
 * Accessibilité :
 * - la tonalité n'est jamais portée par la seule couleur. Un préfixe textuel réservé aux
 *   technologies d'assistance annonce la nature du message, et l'icône reste décorative ;
 * - un encart statique est rendu dans une région nommée, donc repérable dans la liste des points
 *   de repère. Un encart dynamique passe en `role="alert"`, qui est annoncé à son apparition.
 */

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

export interface AlertProps {
  readonly children: ReactNode;
  readonly tone?: AlertTone | undefined;
  readonly title?: string | undefined;
  /** Nom accessible de la région. Par défaut, le préfixe de tonalité. */
  readonly label?: string | undefined;
  /** Encart apparu à la suite d'une action : annoncé immédiatement. */
  readonly live?: boolean | undefined;
  readonly titleId?: string | undefined;
}

/** Préfixe lu avant le contenu, pour ne pas dépendre de la couleur ni de l'icône. */
const TONE_PREFIX: Readonly<Record<AlertTone, string>> = {
  info: 'Information :',
  success: 'Succès :',
  warning: 'Avertissement :',
  danger: 'Avertissement important :',
};

function ToneIcon({ tone }: { readonly tone: AlertTone }) {
  if (tone === 'success') {
    return <CheckCircleIcon className={styles.icon} />;
  }
  if (tone === 'info') {
    return <InfoIcon className={styles.icon} />;
  }
  return <WarningTriangleIcon className={styles.icon} />;
}

export function Alert({ children, tone, title, label, live, titleId }: AlertProps) {
  const resolvedTone: AlertTone = tone ?? 'info';
  const prefix = TONE_PREFIX[resolvedTone];
  const className = classNames(styles.alert, styles[resolvedTone]);
  const content = (
    <>
      <ToneIcon tone={resolvedTone} />
      <div className={styles.body}>
        <span className="visually-hidden">{prefix} </span>
        {title !== undefined ? (
          <p className={styles.title} {...(titleId !== undefined ? { id: titleId } : {})}>
            {title}
          </p>
        ) : null}
        <div className={styles.content}>{children}</div>
      </div>
    </>
  );

  if (live === true) {
    return (
      <div className={className} role="alert">
        {content}
      </div>
    );
  }

  return (
    <section className={className} aria-label={label ?? prefix.replace(' :', '')}>
      {content}
    </section>
  );
}

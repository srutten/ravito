import Link from 'next/link';
import type { ReactNode } from 'react';
import { messages } from '@/i18n/fr';
import styles from './button.module.css';
import { classNames } from './class-names';

/**
 * Bouton et lien-bouton au style de la maquette : pleine largeur possible, hauteur généreuse,
 * coins arrondis, icône à gauche du libellé.
 *
 * Ce module ne porte pas de directive `use client` : il ne contient ni état ni effet. Utilisé
 * depuis un composant serveur, il reste rendu côté serveur ; importé par un composant client, il
 * est compilé avec lui. La propriété `onClick` n'est donc utilisable que depuis un composant
 * client, ce que fait `app/error.tsx`.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface CommonProps {
  readonly children: ReactNode;
  readonly variant?: ButtonVariant | undefined;
  readonly fullWidth?: boolean | undefined;
  readonly compact?: boolean | undefined;
  readonly icon?: ReactNode | undefined;
}

export interface ButtonProps extends CommonProps {
  readonly type?: 'button' | 'submit' | 'reset' | undefined;
  readonly disabled?: boolean | undefined;
  /** État transverse « action en cours » : le bouton se verrouille et l'annonce. */
  readonly busy?: boolean | undefined;
  readonly onClick?: (() => void) | undefined;
}

export interface LinkButtonProps extends CommonProps {
  readonly href: string;
  readonly ariaLabel?: string | undefined;
}

function resolveClassName(props: Pick<CommonProps, 'variant' | 'fullWidth' | 'compact'>): string {
  return classNames(
    styles.button,
    styles[props.variant ?? 'primary'],
    props.fullWidth === true && styles.fullWidth,
    props.compact === true && styles.compact,
  );
}

function SpinnerIcon() {
  return (
    <svg
      className={styles.spinner}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="8.6" opacity="0.3" />
      <path d="M20.6 12a8.6 8.6 0 0 0-8.6-8.6" />
    </svg>
  );
}

export function Button({
  children,
  variant,
  fullWidth,
  compact,
  icon,
  type,
  disabled,
  busy,
  onClick,
}: ButtonProps) {
  const isBusy = busy === true;
  const isDisabled = disabled === true || isBusy;
  return (
    <button
      type={type ?? 'button'}
      className={resolveClassName({ variant, fullWidth, compact })}
      disabled={isDisabled}
      aria-busy={isBusy}
      {...(onClick !== undefined ? { onClick } : {})}
    >
      {isBusy ? <SpinnerIcon /> : null}
      {!isBusy && icon !== undefined ? <span className={styles.icon}>{icon}</span> : null}
      <span>{children}</span>
      {isBusy ? (
        <span className="visually-hidden">{messages.ui.states.actionInProgress}</span>
      ) : null}
    </button>
  );
}

export function LinkButton({
  children,
  variant,
  fullWidth,
  compact,
  icon,
  href,
  ariaLabel,
}: LinkButtonProps) {
  return (
    <Link
      href={href}
      className={resolveClassName({ variant, fullWidth, compact })}
      {...(ariaLabel !== undefined ? { 'aria-label': ariaLabel } : {})}
    >
      {icon !== undefined ? <span className={styles.icon}>{icon}</span> : null}
      <span>{children}</span>
    </Link>
  );
}

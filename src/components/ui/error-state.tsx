import type { ReactNode } from 'react';
import { messages } from '@/i18n/fr';
import { classNames } from './class-names';
import styles from './error-state.module.css';
import {
  AlertCircleIcon,
  BranchIcon,
  ClockIcon,
  type IconProps,
  NetworkOfflineIcon,
  ShieldDeniedIcon,
} from './icons';

/**
 * États transverses en échec (docs/screens.md) : erreur, permission refusée, réseau
 * indisponible, données obsolètes, conflit de version, élément introuvable.
 *
 * Aucun détail technique n'est affiché : ni message d'exception, ni pile d'appel, ni identifiant
 * interne (docs/security.md, messages d'erreur neutres).
 */

export type ErrorStateVariant =
  | 'error'
  | 'permissionDenied'
  | 'networkUnavailable'
  | 'staleData'
  | 'versionConflict'
  | 'notFound';

export interface ErrorStateProps {
  readonly variant?: ErrorStateVariant | undefined;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly action?: ReactNode | undefined;
  readonly titleLevel?: 1 | 2 | 3 | undefined;
  /** Erreur survenue en cours d'utilisation : annoncée immédiatement. */
  readonly live?: boolean | undefined;
}

type Tone = 'toneDanger' | 'toneWarning' | 'toneNeutral';

const TITLE_TAGS = { 1: 'h1', 2: 'h2', 3: 'h3' } as const;

interface VariantDefinition {
  readonly tone: Tone;
  readonly title: string;
  readonly Icon: (props: IconProps) => ReactNode;
}

const VARIANTS: Readonly<Record<ErrorStateVariant, VariantDefinition>> = {
  error: {
    tone: 'toneDanger',
    title: messages.ui.states.error,
    Icon: AlertCircleIcon,
  },
  permissionDenied: {
    tone: 'toneWarning',
    title: messages.ui.states.permissionDenied,
    Icon: ShieldDeniedIcon,
  },
  networkUnavailable: {
    tone: 'toneWarning',
    title: messages.ui.states.networkUnavailable,
    Icon: NetworkOfflineIcon,
  },
  staleData: {
    tone: 'toneWarning',
    title: messages.ui.states.staleData,
    Icon: ClockIcon,
  },
  versionConflict: {
    tone: 'toneWarning',
    title: messages.ui.states.versionConflict,
    Icon: BranchIcon,
  },
  notFound: {
    tone: 'toneNeutral',
    title: messages.errors.NOT_FOUND,
    Icon: AlertCircleIcon,
  },
};

export function ErrorState({
  variant,
  title,
  description,
  action,
  titleLevel,
  live,
}: ErrorStateProps) {
  const definition = VARIANTS[variant ?? 'error'];
  const TitleTag = TITLE_TAGS[titleLevel ?? 2];
  const { Icon } = definition;
  return (
    <div
      className={classNames(styles.errorState, styles[definition.tone])}
      {...(live === true ? { role: 'alert' } : {})}
    >
      <span className={styles.icon}>
        <Icon width={28} height={28} />
      </span>
      <TitleTag className={styles.title}>{title ?? definition.title}</TitleTag>
      {description !== undefined ? <p className={styles.description}>{description}</p> : null}
      {action !== undefined ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}

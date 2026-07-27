import { messages } from '@/i18n/fr';
import { classNames } from './class-names';
import styles from './skeleton.module.css';

/**
 * État transverse « chargement ».
 *
 * Le squelette visuel est masqué aux technologies d'assistance ; seul un libellé textuel est
 * annoncé, une seule fois, dans une région de statut.
 */

export interface SkeletonProps {
  readonly lines?: number | undefined;
  /** Ajoute un bloc haut, à la taille d'un bouton ou d'un champ. */
  readonly withBlock?: boolean | undefined;
  readonly label?: string | undefined;
}

const DEFAULT_LINE_COUNT = 3;
/** Largeurs décroissantes : un paragraphe en cours de chargement, pas une grille. */
const LINE_WIDTHS = ['100%', '92%', '78%', '85%', '64%'] as const;

function readLineWidth(index: number): string {
  return LINE_WIDTHS[index % LINE_WIDTHS.length] ?? '100%';
}

export function Skeleton({ lines, withBlock, label }: SkeletonProps) {
  const count = Math.max(1, lines ?? DEFAULT_LINE_COUNT);
  const indexes = Array.from({ length: count }, (_, index) => index);
  return (
    <div className={styles.skeleton} role="status">
      <span className="visually-hidden">{label ?? messages.ui.states.loading}</span>
      {indexes.map((index) => (
        <div
          key={index}
          className={styles.line}
          style={{ width: readLineWidth(index) }}
          aria-hidden="true"
        />
      ))}
      {withBlock === true ? (
        <div className={classNames(styles.line, styles.block)} aria-hidden="true" />
      ) : null}
    </div>
  );
}

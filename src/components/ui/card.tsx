import type { ReactNode } from 'react';
import styles from './card.module.css';
import { classNames } from './class-names';

/**
 * Surface de contenu de la maquette : carte blanche, coins très arrondis, ombre douce.
 *
 * Le titre est rendu dans un niveau de titre explicite afin que la hiérarchie du document reste
 * correcte pour un lecteur d'écran (docs/screens.md, compatibilité lecteur d'écran).
 */

export type CardTone = 'raised' | 'flat' | 'subtle';
export type CardPadding = 'none' | 'normal' | 'large';

export interface CardProps {
  readonly children: ReactNode;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly titleLevel?: 2 | 3 | undefined;
  readonly tone?: CardTone | undefined;
  readonly padding?: CardPadding | undefined;
  readonly labelledBy?: string | undefined;
  readonly titleId?: string | undefined;
}

const PADDING_CLASS: Readonly<Record<CardPadding, string>> = {
  none: 'paddingNone',
  normal: 'paddingNormal',
  large: 'paddingLarge',
};

const TONE_CLASS: Readonly<Record<CardTone, string | undefined>> = {
  raised: undefined,
  flat: 'flat',
  subtle: 'subtle',
};

export function Card({
  children,
  title,
  description,
  titleLevel,
  tone,
  padding,
  labelledBy,
  titleId,
}: CardProps) {
  const toneKey = TONE_CLASS[tone ?? 'raised'];
  const className = classNames(
    styles.card,
    styles[PADDING_CLASS[padding ?? 'normal']],
    toneKey !== undefined && styles[toneKey],
  );
  const TitleTag = titleLevel === 3 ? 'h3' : 'h2';
  return (
    <section
      className={className}
      {...(labelledBy !== undefined ? { 'aria-labelledby': labelledBy } : {})}
    >
      {title !== undefined ? (
        <TitleTag className={styles.title} {...(titleId !== undefined ? { id: titleId } : {})}>
          {title}
        </TitleTag>
      ) : null}
      {description !== undefined ? <p className={styles.description}>{description}</p> : null}
      {children}
    </section>
  );
}

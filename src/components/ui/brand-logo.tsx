import styles from './brand-logo.module.css';
import { classNames } from './class-names';

/**
 * Logo de la marque : bouclier orange à angles arrondis portant une flamme blanche.
 *
 * Le tracé est écrit dans le dépôt, sans fichier image ni bibliothèque d'icônes. Il n'utilise
 * aucun dégradé, donc aucun identifiant unique : le logo peut être rendu plusieurs fois sur une
 * même page sans collision d'identifiants SVG.
 *
 * Par défaut le logo est décoratif : sur l'accueil, le nom « Appui Feux » est déjà écrit à côté
 * de lui. Passer `title` lorsque le logo apparaît seul.
 */

export type BrandLogoSize = 'sm' | 'md' | 'lg';

export interface BrandLogoProps {
  readonly size?: BrandLogoSize | undefined;
  readonly title?: string | undefined;
}

const SIZE_CLASS: Readonly<Record<BrandLogoSize, string>> = {
  sm: 'sizeSm',
  md: 'sizeMd',
  lg: 'sizeLg',
};

const SHIELD_PATH =
  'M24 3.4c.4 0 .8.07 1.1.2l14.5 5.3c1 .4 1.6 1.3 1.6 2.3V23c0 9.9-6.7 17.8-15.9 21.5' +
  '-.5.2-1.1.2-1.6 0C14.5 40.8 7.8 32.9 7.8 23V11.2c0-1 .6-1.9 1.6-2.3l14.5-5.3c.3-.13.7-.2 1.1-.2z';

const SHADE_PATH =
  'M24 3.4c.4 0 .8.07 1.1.2l14.5 5.3c1 .4 1.6 1.3 1.6 2.3V23c0 9.9-6.7 17.8-15.9 21.5z';

const FLAME_PATH =
  'M24 11.8c-.6 4-2.8 5.9-4.6 8-1.9 2.2-2.9 4.3-2.9 6.9 0 4.4 3.4 7.9 7.6 7.9s7.6-3.5 7.6-7.9' +
  'c0-3.1-1.3-5.6-3.6-8.2-.3 1.4-1.1 2.4-2.2 2.9.6-3.6-.4-7-1.9-9.6z';

function LogoShapes() {
  return (
    <>
      <path className={styles.shield} d={SHIELD_PATH} />
      <path className={styles.shade} d={SHADE_PATH} />
      <path className={styles.flame} d={FLAME_PATH} />
    </>
  );
}

export function BrandLogo({ size, title }: BrandLogoProps) {
  const className = classNames(styles.logo, styles[SIZE_CLASS[size ?? 'md']]);
  if (title === undefined) {
    return (
      <svg className={className} viewBox="0 0 48 48" focusable="false" aria-hidden="true">
        <LogoShapes />
      </svg>
    );
  }
  return (
    <svg className={className} viewBox="0 0 48 48" focusable="false" role="img" aria-label={title}>
      <LogoShapes />
    </svg>
  );
}

import styles from './hero-backdrop.module.css';

/**
 * Fond décoratif du hero de l'accueil.
 *
 * Purement ornemental : `aria-hidden`, aucun texte, aucune information. Les identifiants de
 * dégradés sont préfixés et ce composant n'est utilisé qu'une fois par page.
 */

const SKY_GRADIENT_ID = 'appui-feux-hero-sky';
const GLOW_GRADIENT_ID = 'appui-feux-hero-glow';

const RIDGE_FAR = 'M0 172 58 132 104 158 150 118 206 162 250 138 306 172 352 144 390 168V220H0Z';
const RIDGE_NEAR = 'M0 198 52 168 96 190 148 154 198 188 246 164 300 194 348 170 390 192V220H0Z';

export function HeroBackdrop() {
  return (
    <svg
      className={styles.backdrop}
      viewBox="0 0 390 220"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={SKY_GRADIENT_ID} x1="0" y1="0" x2="0" y2="1">
          <stop className={styles.sky} offset="0%" />
          <stop className={styles.skyEnd} offset="100%" />
        </linearGradient>
        <radialGradient id={GLOW_GRADIENT_ID} cx="78%" cy="74%" r="58%">
          <stop className={styles.glowStart} offset="0%" />
          <stop className={styles.glowEnd} offset="100%" />
        </radialGradient>
      </defs>
      <rect width="390" height="220" fill={`url(#${SKY_GRADIENT_ID})`} />
      <ellipse cx="302" cy="160" rx="220" ry="126" fill={`url(#${GLOW_GRADIENT_ID})`} />
      <path className={styles.ridgeFar} d={RIDGE_FAR} />
      <path className={styles.ridgeNear} d={RIDGE_NEAR} />
    </svg>
  );
}

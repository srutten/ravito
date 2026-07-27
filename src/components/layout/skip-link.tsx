import styles from './skip-link.module.css';

/** Lien d'évitement vers le contenu principal. */

// À déplacer dans `src/i18n/fr.ts` lorsque ce fichier sera dans le périmètre.
const SKIP_LINK_LABEL = 'Aller au contenu principal';

export const MAIN_CONTENT_ID = 'contenu-principal';

export function SkipLink() {
  return (
    <a className={styles.skipLink} href={`#${MAIN_CONTENT_ID}`}>
      {SKIP_LINK_LABEL}
    </a>
  );
}

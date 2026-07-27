import styles from './bullet-list.module.css';

/** Liste à puces sobre, utilisée dans les cartes de contenu des pages publiques. */

export interface BulletListProps {
  readonly items: readonly string[];
}

export function BulletList({ items }: BulletListProps) {
  return (
    <ul className={styles.list}>
      {items.map((item) => (
        <li className={styles.item} key={item}>
          <span className={styles.marker} aria-hidden="true" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

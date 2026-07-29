import type { ChangeEvent, ReactNode, Ref } from 'react';
import { classNames } from './class-names';
import { ChevronDownIcon } from './icons';
import styles from './select-field.module.css';

/**
 * Liste déroulante au style de la maquette : contrôle haut, coins arrondis, icône à gauche.
 *
 * Elle suit exactement les choix de `text-field.tsx` — libellé visible au-dessus, erreur
 * rattachée au champ par `aria-describedby` et `aria-invalid`, hauteur supérieure à la cible
 * tactile de 44 pixels de `docs/screens.md`.
 *
 * POURQUOI UN `select` NATIF ET NON UNE LISTE RECONSTRUITE. Un composant sur mesure suppose de
 * réimplémenter le clavier, le focus, l'annonce au lecteur d'écran et le rendu propre à chaque
 * navigateur mobile ; la moindre de ces pièces oubliée rend le champ inutilisable pour
 * quelqu'un, sur un formulaire qui est la porte d'entrée du produit. Le contrôle natif les
 * apporte toutes, et il est le seul à ouvrir le sélecteur plein écran des téléphones.
 *
 * AUCUNE VALEUR PRÉSÉLECTIONNÉE (docs/screens.md, écran 11). La première option est un texte
 * d'invitation de valeur vide : un choix par défaut ferait classer par inadvertance des
 * structures dans la première catégorie de la liste, et l'administrateur validerait une nature
 * que personne n'a choisie. Elle reste sélectionnable — la rendre inaccessible empêcherait de
 * revenir sur un choix fait par erreur avant d'avoir soumis.
 */

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectFieldProps {
  /** Identifiant du champ. Sert de racine aux identifiants de l'indice et de l'erreur. */
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly SelectOption[];
  /** Libellé de l'option vide, affichée tant que rien n'est choisi. */
  readonly placeholder: string;
  readonly icon?: ReactNode | undefined;
  readonly hint?: string | undefined;
  /** Message d'erreur. Sa présence bascule le champ en état invalide. */
  readonly error?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly required?: boolean | undefined;
  readonly selectRef?: Ref<HTMLSelectElement> | undefined;
  readonly testId?: string | undefined;
}

export function SelectField({
  id,
  name,
  label,
  value,
  onChange,
  options,
  placeholder,
  icon,
  hint,
  error,
  disabled,
  required,
  selectRef,
  testId,
}: SelectFieldProps) {
  const hintId = `${id}-indice`;
  const errorId = `${id}-erreur`;
  const isInvalid = error !== undefined;

  // L'erreur est décrite avant l'aide : c'est ce que la personne cherche à savoir au moment
  // où elle revient sur le champ.
  const describedBy = [isInvalid ? errorId : undefined, hint !== undefined ? hintId : undefined]
    .filter((part): part is string => part !== undefined)
    .join(' ');

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <div className={styles.control}>
        {icon !== undefined ? <span className={styles.icon}>{icon}</span> : null}
        <select
          className={classNames(
            styles.select,
            icon !== undefined && styles.withIcon,
            isInvalid && styles.invalid,
          )}
          id={id}
          name={name}
          value={value}
          onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value)}
          aria-invalid={isInvalid}
          {...(describedBy !== '' ? { 'aria-describedby': describedBy } : {})}
          {...(disabled === true ? { disabled: true } : {})}
          {...(required === true ? { required: true } : {})}
          {...(selectRef !== undefined ? { ref: selectRef } : {})}
          {...(testId !== undefined ? { 'data-testid': testId } : {})}
        >
          <option value="">{placeholder}</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {/*
          Chevron purement décoratif : le contrôle natif porte déjà son propre indicateur sur
          certaines plateformes, et le sens du champ est donné par son libellé, jamais par ce
          dessin.
        */}
        <span className={styles.chevron}>
          <ChevronDownIcon width={20} height={20} />
        </span>
      </div>
      {hint !== undefined ? (
        <p className={styles.hint} id={hintId}>
          {hint}
        </p>
      ) : null}
      {isInvalid ? (
        <p className={styles.error} id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

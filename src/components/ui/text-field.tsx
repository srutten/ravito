import type { ChangeEvent, ReactNode, Ref } from 'react';
import { classNames } from './class-names';
import styles from './text-field.module.css';

/**
 * Champ de saisie au style de la maquette : champ haut, coins arrondis, icône à gauche.
 *
 * Ce module ne porte pas de directive `use client`, comme `button.tsx` : il ne contient ni état
 * ni effet. La propriété `onChange` n'est donc utilisable que depuis un composant client, qui
 * l'embarquera dans son propre paquet.
 *
 * TROIS ÉCARTS ASSUMÉS PAR RAPPORT À LA MAQUETTE, tous au titre de la section Accessibilité de
 * `docs/screens.md`, qui prime sur les détails d'interface dans l'ordre de `CLAUDE.md`.
 *
 * 1. LE LIBELLÉ EST VISIBLE, au-dessus du champ. La maquette n'affiche que des textes de
 *    substitution (« Téléphone ou e-mail »), qui disparaissent dès la première frappe : la
 *    personne qui revient sur un formulaire à moitié rempli n'a plus aucun moyen de savoir ce
 *    qu'elle a saisi où, et un lecteur d'écran n'annonce rien de fiable. Le texte de
 *    substitution est conservé en complément, comme exemple de saisie.
 * 2. L'ERREUR EST ASSOCIÉE AU CHAMP par `aria-describedby` et `aria-invalid`, et jamais portée
 *    par la seule couleur de bordure : `docs/screens.md` exige les deux.
 * 3. LA HAUTEUR MINIMALE dépasse la cible tactile de 44 pixels imposée par la même section.
 */

export interface TextFieldProps {
  /** Identifiant du champ. Sert de racine aux identifiants de l'indice et de l'erreur. */
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: 'text' | 'email' | 'tel' | undefined;
  /** Icône décorative posée à gauche, à la manière de la maquette. */
  readonly icon?: ReactNode | undefined;
  /** Aide permanente, lue avec le champ. */
  readonly hint?: string | undefined;
  /** Message d'erreur. Sa présence bascule le champ en état invalide. */
  readonly error?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly required?: boolean | undefined;
  readonly autoComplete?: string | undefined;
  readonly inputMode?: 'text' | 'email' | 'numeric' | undefined;
  readonly pattern?: string | undefined;
  readonly maxLength?: number | undefined;
  readonly placeholder?: string | undefined;
  /** Référence sur le champ natif, pour déplacer le focus depuis le composant appelant. */
  readonly inputRef?: Ref<HTMLInputElement> | undefined;
  /** Point d'accroche stable pour les tests de bout en bout. */
  readonly testId?: string | undefined;
}

export function TextField({
  id,
  name,
  label,
  value,
  onChange,
  type,
  icon,
  hint,
  error,
  disabled,
  required,
  autoComplete,
  inputMode,
  pattern,
  maxLength,
  placeholder,
  inputRef,
  testId,
}: TextFieldProps) {
  const hintId = `${id}-indice`;
  const errorId = `${id}-erreur`;
  const isInvalid = error !== undefined;

  // L'ordre place l'erreur en premier : elle est lue avant l'aide, ce qui correspond à ce que la
  // personne cherche à savoir au moment où elle revient sur le champ.
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
        <input
          className={classNames(
            styles.input,
            icon !== undefined && styles.withIcon,
            isInvalid && styles.invalid,
          )}
          id={id}
          name={name}
          type={type ?? 'text'}
          value={value}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
          aria-invalid={isInvalid}
          {...(describedBy !== '' ? { 'aria-describedby': describedBy } : {})}
          {...(disabled === true ? { disabled: true } : {})}
          {...(required === true ? { required: true } : {})}
          {...(autoComplete !== undefined ? { autoComplete } : {})}
          {...(inputMode !== undefined ? { inputMode } : {})}
          {...(pattern !== undefined ? { pattern } : {})}
          {...(maxLength !== undefined ? { maxLength } : {})}
          {...(placeholder !== undefined ? { placeholder } : {})}
          {...(inputRef !== undefined ? { ref: inputRef } : {})}
          {...(testId !== undefined ? { 'data-testid': testId } : {})}
        />
      </div>
      {hint !== undefined ? (
        <p className={styles.hint} id={hintId}>
          {hint}
        </p>
      ) : null}
      {/*
        `role="alert"` sur le message d'erreur : il apparaît en réaction à une action et doit
        être annoncé sans que la personne ait à retrouver le champ.
      */}
      {isInvalid ? (
        <p className={styles.error} id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

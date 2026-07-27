/**
 * Assemble une liste de classes CSS.
 *
 * Les modules CSS sont typés par une signature d'index : sous `noUncheckedIndexedAccess`, toute
 * classe lue vaut `string | undefined`. Ce filtre évite qu'une classe absente ne se retrouve
 * sérialisée en « undefined » dans le HTML.
 */
export function classNames(...values: readonly (string | false | undefined)[]): string {
  return values
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join(' ');
}

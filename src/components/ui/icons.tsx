import type { SVGProps } from 'react';

/**
 * Jeu d'icônes dessiné dans le dépôt, sans bibliothèque tierce ni ressource externe : la
 * politique de sécurité du contenu posée par `middleware.ts` bloque toute origine tierce.
 *
 * Toutes les icônes sont décoratives, sans exception possible : `aria-hidden` est posé après la
 * diffusion des propriétés et ne peut donc pas être retiré par l'appelant. Le sens est porté par
 * le libellé textuel qui les accompagne, jamais par l'icône seule ni par sa couleur
 * (docs/screens.md, pas d'information uniquement portée par la couleur). Une image porteuse de
 * sens se déclare avec son propre `role` et son propre nom accessible, comme le fait
 * `brand-logo.tsx`.
 */

export type IconProps = Omit<
  SVGProps<SVGSVGElement>,
  'children' | 'viewBox' | 'aria-hidden' | 'role'
>;

const BASE_PROPS = {
  width: 24,
  height: 24,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  focusable: 'false',
} as const;

export function LockIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props} aria-hidden="true">
      <rect x="4.5" y="10.3" width="15" height="10.2" rx="2.6" />
      <path d="M8.2 10.3V7.6a3.8 3.8 0 0 1 7.6 0v2.7" />
    </svg>
  );
}

export function WarningTriangleIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props} aria-hidden="true">
      <path d="M12 3.8 21.2 19.6a1 1 0 0 1-.9 1.5H3.7a1 1 0 0 1-.9-1.5z" />
      <path d="M12 9.6v4.4" />
      <circle cx="12" cy="17.6" r="0.95" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props} aria-hidden="true">
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 11.2v5.4" />
      <circle cx="12" cy="7.9" r="0.95" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function CheckCircleIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props} aria-hidden="true">
      <circle cx="12" cy="12" r="8.6" />
      <path d="m8.1 12.3 2.7 2.6 5.1-5.5" />
    </svg>
  );
}

export function AlertCircleIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props} aria-hidden="true">
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.4v5.2" />
      <circle cx="12" cy="16.3" r="0.95" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function DocumentIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props} aria-hidden="true">
      <path d="M13.8 3.4H7.6A1.6 1.6 0 0 0 6 5v14a1.6 1.6 0 0 0 1.6 1.6h8.8A1.6 1.6 0 0 0 18 19V7.6z" />
      <path d="M13.8 3.4v4.2H18" />
      <path d="M9 12.6h6M9 16h4.2" />
    </svg>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props} aria-hidden="true">
      <path d="M12 3.3 19.2 6v5.9c0 4.4-2.9 7.6-7.2 9.2-4.3-1.6-7.2-4.8-7.2-9.2V6z" />
    </svg>
  );
}

export function ShieldDeniedIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props} aria-hidden="true">
      <path d="M12 3.3 19.2 6v5.9c0 4.4-2.9 7.6-7.2 9.2-4.3-1.6-7.2-4.8-7.2-9.2V6z" />
      <path d="m9.7 9.7 4.6 4.6M14.3 9.7l-4.6 4.6" />
    </svg>
  );
}

export function NetworkOfflineIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props} aria-hidden="true">
      <path d="m3.2 3.2 17.6 17.6" />
      <path d="M2.3 8.9a16.4 16.4 0 0 1 5.4-3.2" />
      <path d="M5.3 12.6a11.2 11.2 0 0 1 3.9-2.3" />
      <path d="M12.2 5.5a16.4 16.4 0 0 1 9.5 3.4" />
      <path d="M14.9 10.4a11.2 11.2 0 0 1 3.8 2.2" />
      <circle cx="12" cy="18.4" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props} aria-hidden="true">
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.3V12l3.2 1.9" />
    </svg>
  );
}

export function BranchIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props} aria-hidden="true">
      <circle cx="7" cy="17.2" r="2.6" />
      <circle cx="17" cy="6.8" r="2.6" />
      <path d="M7 14.6V6.8h7.4" />
      <path d="M17 9.4v7.8H9.6" />
    </svg>
  );
}

export function InboxIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props} aria-hidden="true">
      <path d="M4 13.4 6.4 5.9A1.7 1.7 0 0 1 8 4.7h8a1.7 1.7 0 0 1 1.6 1.2L20 13.4v4.4a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 17.8z" />
      <path d="M4 13.4h4.2l1.2 2.3h5.2l1.2-2.3H20" />
    </svg>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props} aria-hidden="true">
      <path d="M19.9 11.2a8 8 0 1 0-.9 5" />
      <path d="M20.4 5.6v5.6h-5.6" />
    </svg>
  );
}

export function ActivityIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props} aria-hidden="true">
      <path d="M3 12.2h4.1l2.6-6.6 4.2 12.8 2.5-6.2H21" />
    </svg>
  );
}

/** Enveloppe des champs d'identifiant. Reprend l'icône de la maquette, écran de connexion. */
export function MailIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props} aria-hidden="true">
      <rect x="3.2" y="5.4" width="17.6" height="13.2" rx="2.4" />
      <path d="m3.9 7 7.2 5.3a1.5 1.5 0 0 0 1.8 0L20.1 7" />
    </svg>
  );
}

/** Chevron des listes déroulantes. Décoratif : le sens vient du libellé du champ. */
export function ChevronDownIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props} aria-hidden="true">
      <path d="m6.5 9.5 5.5 5.4 5.5-5.4" />
    </svg>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <svg {...BASE_PROPS} {...props} aria-hidden="true">
      <path d="M19.2 12H4.8" />
      <path d="m10.6 5.8-6 6.2 6 6.2" />
    </svg>
  );
}

'use client';

// Composant client : c'est le seul moyen de lire `navigator.onLine` et d'écouter les événements
// `online` et `offline` du navigateur. Aucune donnée n'est envoyée au serveur.

import { useSyncExternalStore } from 'react';
import { NetworkOfflineIcon } from './icons';
import styles from './network-indicator.module.css';
import { StatusBadge, type StatusTone } from './status-badge';

/**
 * Indicateur de connexion réseau (docs/functional-specification.md, règles d'interface).
 *
 * Au lot 0, l'indicateur reflète uniquement l'état de connexion du navigateur. Il n'indique pas
 * une connexion temps réel : celle-ci dépend du flag `ENABLE_REALTIME`, désactivé par défaut.
 *
 * `useSyncExternalStore` fournit un instantané serveur distinct de l'instantané navigateur :
 * le rendu serveur affiche « vérification », l'hydratation le remplace par l'état réel sans
 * divergence de rendu.
 */

type NetworkStatus = 'unknown' | 'online' | 'offline';

// À déplacer dans `src/i18n/fr.ts` lorsque ce fichier sera dans le périmètre : le catalogue
// livré au lot 0 ne comporte pas de libellé court pour la pastille de connexion.
const NETWORK_LABELS: Readonly<Record<NetworkStatus, string>> = {
  unknown: 'Connexion réseau : vérification',
  online: 'Connexion réseau active',
  offline: 'Connexion réseau indisponible',
};

const NETWORK_TONES: Readonly<Record<NetworkStatus, StatusTone>> = {
  unknown: 'neutral',
  online: 'success',
  offline: 'danger',
};

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener('online', onStoreChange);
  window.addEventListener('offline', onStoreChange);
  return () => {
    window.removeEventListener('online', onStoreChange);
    window.removeEventListener('offline', onStoreChange);
  };
}

function readBrowserStatus(): NetworkStatus {
  return navigator.onLine ? 'online' : 'offline';
}

function readServerStatus(): NetworkStatus {
  return 'unknown';
}

export function NetworkIndicator() {
  const status = useSyncExternalStore(subscribe, readBrowserStatus, readServerStatus);
  const isOffline = status === 'offline';
  return (
    <span className={styles.indicator}>
      {/*
        La clé force le remplacement du nœud à chaque changement d'état : un élément portant
        `role="alert"` n'est annoncé de façon fiable qu'à son insertion dans le document.
      */}
      <StatusBadge
        key={status}
        label={NETWORK_LABELS[status]}
        tone={NETWORK_TONES[status]}
        {...(isOffline ? { role: 'alert' as const } : {})}
        {...(isOffline ? { icon: <NetworkOfflineIcon width={18} height={18} /> } : {})}
      />
    </span>
  );
}

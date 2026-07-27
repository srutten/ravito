import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { SkipLink } from '@/components/layout/skip-link';
import { messages } from '@/i18n/fr';
import './globals.css';

/**
 * Racine du document.
 *
 * La lecture de l'en-tête `x-nonce` posé par `middleware.ts` a deux effets, tous deux
 * nécessaires :
 * 1. elle donne accès au nonce de la requête courante, seul moyen d'autoriser un script en
 *    ligne sous la politique de sécurité du contenu ;
 * 2. elle bascule le rendu en mode dynamique. C'est indispensable : un rendu figé à la
 *    construction porterait le nonce d'un autre instant que celui de l'en-tête de réponse, et
 *    tous les scripts de la page seraient bloqués.
 */

/**
 * Marque le document comme piloté par du script. La feuille de style ne révèle qu'ensuite les
 * éléments dont l'état dépend réellement du navigateur, comme l'indicateur de connexion réseau :
 * sans script, la page n'affiche pas un état qu'elle ne peut pas vérifier.
 */
const PROGRESSIVE_ENHANCEMENT_SCRIPT = "document.documentElement.setAttribute('data-js','on')";

const NONCE_HEADER = 'x-nonce';

export const metadata: Metadata = {
  title: {
    default: messages.ui.app.name,
    template: `%s | ${messages.ui.app.name}`,
  },
  description: messages.ui.home.subtitle,
  applicationName: messages.ui.app.name,
  // Aucune indexation avant l'ouverture publique : la décision relève de la gouvernance, le
  // réglage par défaut est le plus fermé.
  robots: { index: false, follow: false },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Aucun `maximumScale` : le zoom doit rester possible (docs/screens.md, accessibilité).
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#eef2f7' },
    { media: '(prefers-color-scheme: dark)', color: '#121821' },
  ],
};

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  const nonce = (await headers()).get(NONCE_HEADER);
  return (
    <html lang="fr" suppressHydrationWarning>
      <body>
        {nonce === null ? null : (
          <script
            nonce={nonce}
            // Contenu constant écrit dans ce fichier : aucune donnée externe n'y entre.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: seul moyen de poser un script en ligne en React.
            dangerouslySetInnerHTML={{ __html: PROGRESSIVE_ENHANCEMENT_SCRIPT }}
          />
        )}
        <SkipLink />
        {children}
      </body>
    </html>
  );
}

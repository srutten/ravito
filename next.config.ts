import type { NextConfig } from 'next';

/**
 * Les en-tetes de securite dependants d'un nonce (CSP) sont poses dans `middleware.ts`,
 * afin de generer une valeur differente par requete. Seuls les reglages statiques
 * figurent ici.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Ne pas divulguer la technologie ni sa version.
  poweredByHeader: false,
  // Image autonome pour un deploiement conteneurise reproductible.
  output: 'standalone',
  typescript: {
    // Une erreur de type doit casser le build : cf. CLAUDE.md, TypeScript strict.
    ignoreBuildErrors: false,
  },
};

export default nextConfig;

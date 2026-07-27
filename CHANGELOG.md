# Journal des modifications

Toutes les modifications notables de ce projet sont consignées dans ce fichier.

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et le projet respecte le
[versionnage sémantique](https://semver.org/lang/fr/).

Aucune version n'a encore été publiée. La section « Non publié » n'a donc pas de date : une date
n'est inscrite qu'au moment où une version est effectivement livrée et étiquetée.

## Non publié

Lot 0 — Fondation. Objectif : un environnement reproductible sur un poste vierge. Ce lot ne livre
aucune fonctionnalité métier ; le parcours produit commence au lot 1.

### Ajouté

- Squelette du dépôt et structure modulaire attendue par `CLAUDE.md` : `app/`, `src/domain/` par
  module métier, `src/application/`, `src/infrastructure/`, `src/authorization/`, `src/validation/`,
  `src/observability/`, `src/config/`, `src/components/`, `tests/unit/`, `tests/integration/`,
  `tests/e2e/`, `supabase/migrations/`.
- Chaîne d'outillage figée : Node 24, Next 16.2.12 avec App Router, React 19.2.8,
  TypeScript 5.9.3 en mode strict, pg 8.22, pino 10.3, zod 4.4, Biome 2.5.5, Vitest 4.1.10,
  Playwright 1.62.
- Configuration TypeScript stricte, avec `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`
  et `useUnknownInCatchVariables`, ainsi que l'alias de chemin `@/` vers `src/`.
- Biome comme outil unique de lint et de format, avec un style unique pour tout le dépôt.
- Deux projets de test Vitest distincts, `unit` et `integration`, et une configuration Playwright
  couvrant un profil mobile et un profil bureau.
- Base de données locale de développement décrite dans `docker-compose.yml` : PostgreSQL 17 avec
  l'extension PostGIS 3.5, encodage et locale fixés pour rendre les tris reproductibles.
- Fichier `.env.example` documentant toutes les variables d'environnement du produit, y compris
  celles des lots à venir, sans aucune valeur de secret.
- Configuration applicative validée au démarrage et observabilité minimale par journal structuré.
- Design system minimal : jetons de design en variables CSS et CSS Modules, sans framework CSS.
- Refus par défaut câblé dans le routeur API : toute route non déclarée publique répond
  `UNAUTHENTICATED` tant que l'authentification n'est pas livrée par le lot 1.
- Procédure de démarrage reproductible, tableau des commandes disponibles et description des
  portes de qualité dans `README.md`.
- Décisions d'architecture ADR-009 à ADR-014 dans `docs/decision-log.md` : outil de lint unique,
  version de TypeScript retenue et dette associée, absence de framework CSS, gestionnaire de
  paquets, emplacement de la racine du dépôt, refus par défaut dès le lot 0.
- Ce journal des modifications.

### Sécurité

- `.gitignore` couvrant les fichiers d'environnement, les clés, les certificats, les fichiers de
  fournisseurs cloud et les dumps de base, afin qu'aucun secret ni aucune donnée locale ne puisse
  être commité par inadvertance.
- Aucune valeur de secret dans le dépôt, y compris dans les exemples, conformément à
  `docs/security.md`.
- Aucune donnée réelle ou nominative dans les jeux de données de démonstration.

### Dette connue

- TypeScript reste en 5.9.3 alors que la version courante publiée est 7.0.2. Un spike de migration
  vers TypeScript 7 doit être instruit avant le lot 3 (ADR-010).
- Les commandes `npm run db:migrate`, `npm run db:status`, `npm run db:reset` et `npm run db:seed`
  sont déclarées mais leurs scripts sont livrés par la story US-002.

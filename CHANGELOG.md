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
- Pile de développement local complète en conteneurs, décrite dans `docker-compose.yml` et démarrée
  par une commande unique, conformément à l'environnement local de `docs/deployment.md` :
  PostgreSQL 17 avec PostGIS 3.5 encodage et locale fixés, interception des courriels par serveur
  SMTP local, stockage objet compatible S3 avec création automatique de seaux privés, application
  en mode développement. Toutes les images sont épinglées à une version précise.
- Image applicative en plusieurs étapes dans `docker/app.Dockerfile` : une étape de développement
  avec rechargement à chaud et une étape de production fondée sur la sortie `standalone` de Next,
  sans code source ni dépendance de développement, exécutée par un utilisateur non privilégié.
- Synchronisation du code source par le mécanisme de surveillance de Compose plutôt que par
  montage lié : le `node_modules` de l'image n'est jamais masqué par celui du poste, et le
  rechargement à chaud reste fiable depuis un poste Windows ou macOS.
- Normalisation des fins de ligne par `.gitattributes` : le dépôt stocke tout en LF.
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
- Les deux seaux de stockage local sont créés privés, et le seau de sauvegarde est distinct du seau
  de documents, conformément à la séparation imposée par `docs/security.md`.
- Aucun courriel ne peut quitter un poste de développement : l'application ne connaît que le
  serveur SMTP local d'interception.
- Le conteneur applicatif ne s'exécute pas en `root`.
- Les identifiants de la pile locale sont des valeurs de développement explicites, injectées par
  substitution d'environnement avec valeur de repli, inertes hors du poste.

### Dette connue

- TypeScript reste en 5.9.3 alors que la version courante publiée est 7.0.2. Un spike de migration
  vers TypeScript 7 doit être instruit avant le lot 3 (ADR-010).
- Les commandes `npm run db:migrate`, `npm run db:status`, `npm run db:reset` et `npm run db:seed`
  sont déclarées mais leurs scripts sont livrés par la story US-002.
- Next 16 déprécie la convention de fichier `middleware.ts` au profit de `proxy.ts` et émet un
  avertissement à chaque construction. Le renommage reste à décider par un ADR.
- La simulation des SMS de l'environnement local n'est pas encore matérialisée : elle sera
  journalisée par l'application avec la story US-072. Aucun envoi réel n'est possible d'ici là.

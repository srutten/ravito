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
- Moteur de migrations à empreinte, avec table de suivi, application de chaque migration dans sa
  propre transaction et verrou consultatif interdisant deux exécutions simultanées. L'empreinte est
  calculée sur un contenu normalisé en LF, sans quoi un poste Windows ferait échouer la
  vérification à tort. Une migration déjà appliquée puis modifiée, ou appliquée puis disparue du
  dépôt, fait échouer `db:migrate` et `db:status` : c'est la mise en œuvre de la contrainte
  d'immuabilité de `CLAUDE.md`.
- Socle transverse de base de données : extensions PostGIS et pgcrypto, déclencheur partagé de mise
  à jour de `updated_at`, types énumérés reprenant les états de `docs/state-machines.md` pour la
  demande, la ressource, la proposition et la mission, table `outbox` et table `audit_logs` avec
  leurs index.
- Deux comptes SQL distincts : un compte de migration disposant des droits de schéma, et un compte
  applicatif qui ne peut ni créer ni supprimer de table. Le rôle applicatif est créé sans mot de
  passe par la migration ; l'attribution du mot de passe est une étape d'exploitation dédiée, afin
  qu'aucun secret n'entre dans une migration.
- Commandes `db:migrate`, `db:status`, `db:reset`, `db:seed` et `db:bootstrap-roles`, écrites en
  TypeScript exécuté nativement par Node et donc couvertes par `npm run typecheck`.
- Jeu de données de démonstration strictement fictif, structuré par lot : seuls les blocs dont les
  tables existent sont chargés, les autres sont écrits et inactifs jusqu'au lot qui les active. Le
  seed est rejouable et annonce explicitement les blocs qu'il ignore et pourquoi.
- Ce journal des modifications.

### Sécurité

- `.gitignore` couvrant les fichiers d'environnement, les clés, les certificats, les fichiers de
  fournisseurs cloud et les dumps de base, afin qu'aucun secret ni aucune donnée locale ne puisse
  être commité par inadvertance.
- Aucune valeur de secret dans le dépôt, y compris dans les exemples, conformément à
  `docs/security.md`.
- Aucune donnée réelle ou nominative dans les jeux de données de démonstration.
- Le journal d'audit est rendu immuable par deux mécanismes indépendants : les droits SQL refusent
  `UPDATE` et `DELETE` au compte applicatif, et un déclencheur les refuse à tout le monde, y compris
  au propriétaire de la table et au superutilisateur. Les droits seuls ne protègent que du rôle
  auquel on a pensé ; le déclencheur couvre aussi un rôle ajouté plus tard ou un `GRANT ALL`
  accidentel. La purge de rétention est la seule exception et doit se déclarer explicitement.
- `db:seed` et `db:reset` sont refusées hors des environnements local et de test, avec un message
  qui explique le risque. Cela rend effectif le point « seed absent de production » de
  `backlog/release-checklist.md`, et empêche qu'une commande destructrice soit pointée par
  inadvertance vers une base partagée.
- La chaîne de connexion, l'utilisateur et le mot de passe n'apparaissent dans aucun message
  d'erreur ni aucun journal : les messages ne citent que le nom de la variable d'environnement
  concernée et une forme masquée de l'URL.

### Dette connue

- TypeScript reste en 5.9.3 alors que la version courante publiée est 7.0.2. Un spike de migration
  vers TypeScript 7 doit être instruit avant le lot 3 (ADR-010).
- Les commandes `npm run db:migrate`, `npm run db:status`, `npm run db:reset` et `npm run db:seed`
  sont déclarées mais leurs scripts sont livrés par la story US-002.

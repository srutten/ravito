# Plateforme de soutien territorial aux opérations incendie

Ce dépôt documentaire décrit un MVP de web app permettant de mettre en relation :

- les forces d'intervention et coordinateurs habilités ;
- les citoyens, agriculteurs, entreprises, associations et collectivités ;
- les moyens matériels ou logistiques disponibles pour soutenir la lutte contre les incendies.

La plateforme ne remplace ni les services d'urgence ni la chaîne de commandement. Elle sert à recenser, qualifier, proposer, affecter et suivre des ressources vers des points de rassemblement sécurisés.

## Objectif du MVP

Le MVP doit couvrir trois parcours complets :

1. un coordinateur publie une demande ;
2. un contributeur propose une ressource ;
3. le coordinateur affecte la ressource et suit son acheminement vers un point sécurisé.

## Principes non négociables

- Aucun citoyen n'est dirigé directement vers le front.
- La position précise des équipes et du feu n'est jamais publique.
- Toute demande opérationnelle provient d'un compte habilité.
- Toute affectation est validée par un coordinateur humain.
- Les actions sensibles sont journalisées.
- Le mode dégradé ne permet pas d'effectuer une nouvelle affectation hors ligne.
- Les décisions critiques restent côté serveur.

## Structure documentaire

- `CLAUDE.md` : instructions de réalisation pour Claude Code.
- `docs/` : spécifications fonctionnelles, techniques, sécurité et exploitation.
- `backlog/` : epics, stories, critères d'acceptation et plan de livraison.
- `prompts/` : prompt initial de génération et checklist de revue.
- `CHANGELOG.md` : journal des modifications, au format Keep a Changelog.
- `docs/decision-log.md` : journal des décisions d'architecture (ADR).

## Démarrage sur un poste vierge

Procédure reproductible, à exécuter depuis la racine du dépôt (`fire-support-platform`).

### Prérequis

- Node 24. La version de référence est fixée dans `.nvmrc` ; avec nvm, `nvm use` la sélectionne.
- npm, fourni avec Node. C'est le gestionnaire de paquets du projet (ADR-012).
- Docker avec Docker Compose, pour la base de données locale. `docker-compose.yml` démarre PostgreSQL 17 avec l'extension PostGIS 3.5.
- git.

### Étapes

1. Sélectionner la version de Node :

   ```bash
   nvm use
   ```

2. Créer le fichier d'environnement local à partir de l'exemple, puis renseigner les valeurs locales :

   ```bash
   cp .env.example .env.local
   ```

   Sous Windows PowerShell : `Copy-Item .env.example .env.local`.

   `.env.example` ne contient aucune valeur réelle. Renseigner au minimum `DATABASE_URL` en cohérence avec `docker-compose.yml`. Les variables des lots suivants (authentification, stockage, notifications, cartographie) restent vides tant que le lot correspondant n'est pas livré.

3. Installer les dépendances :

   ```bash
   npm install
   ```

4. Démarrer la base de données locale :

   ```bash
   npm run db:up
   ```

   Le conteneur expose PostgreSQL sur le port 5432 par défaut et conserve ses données dans un volume Docker nommé. `npm run db:down` arrête le conteneur.

5. Appliquer le schéma puis charger le jeu de démonstration :

   ```bash
   npm run db:migrate
   npm run db:seed
   ```

   Ces deux commandes sont livrées par la story US-002. À ce stade du lot 0, les scripts qu'elles appellent n'existent pas encore et les commandes échouent. Il en va de même pour `npm run db:status` et `npm run db:reset`.

6. Lancer l'application en développement :

   ```bash
   npm run dev
   ```

   L'application est servie sur `http://localhost:3000`.

### Commandes disponibles

| Commande | Effet |
|---|---|
| `npm run dev` | Démarre le serveur de développement Next. |
| `npm run build` | Construit le bundle de production. |
| `npm run start` | Sert le bundle de production déjà construit. |
| `npm run lint` | Vérifie le format et les règles de lint avec Biome, sans rien modifier. |
| `npm run lint:fix` | Applique les corrections de lint et de format que Biome sait faire seul. |
| `npm run format` | Applique uniquement le format Biome. |
| `npm run typecheck` | Compile les types avec TypeScript en mode strict, sans émettre de fichier. |
| `npm run test` | Exécute les tests unitaires (projet Vitest `unit`, dossier `tests/unit`). |
| `npm run test:watch` | Exécute les tests unitaires en mode surveillance. |
| `npm run test:coverage` | Exécute les tests unitaires avec la couverture. |
| `npm run test:integration` | Exécute les tests d'intégration (projet Vitest `integration`, dossier `tests/integration`). Nécessite une base démarrée et migrée. |
| `npm run test:e2e` | Exécute les tests end-to-end Playwright (dossier `tests/e2e`), en profil mobile et bureau. |
| `npm run db:up` | Démarre le conteneur PostgreSQL avec PostGIS. |
| `npm run db:down` | Arrête le conteneur et libère le port. |
| `npm run db:migrate` | Applique les migrations. Livrée par US-002. |
| `npm run db:status` | Affiche les migrations appliquées et celles en attente. Livrée par US-002. |
| `npm run db:reset` | Recrée une base locale vide puis rejoue les migrations. Livrée par US-002. |
| `npm run db:seed` | Charge le jeu de données de démonstration. Livrée par US-002. |
| `npm run verify` | Enchaîne lint, typecheck, tests unitaires et build. |

### Portes de qualité

Un changement n'est proposé à la revue que si ces portes passent en local, dans cet ordre.

1. `npm run lint` : format et règles Biome. Aucun avertissement toléré.
2. `npm run typecheck` : TypeScript strict, avec `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` et `verbatimModuleSyntax`.
3. `npm run test` : tests unitaires. Ils ne nécessitent ni base ni réseau.
4. `npm run test:integration` : tests d'intégration. Ils exigent une base démarrée par `npm run db:up` et migrée par `npm run db:migrate` ; les fichiers ne sont pas parallélisés entre eux car ils partagent la même base.
5. `npm run test:e2e` : tests end-to-end. Ils s'exécutent sur le bundle de production, donc `npm run build` doit avoir été lancé avant ; Playwright démarre lui-même `npm run start` sur l'URL de `E2E_BASE_URL`.
6. `npm run build` : construction de production. Une erreur de type ou d'import échoue ici même si le développement fonctionnait.

`npm run verify` enchaîne les portes 1, 2, 3 et 6. Les portes 4 et 5 restent explicites, car elles dépendent d'une infrastructure locale.

### Avertissement de sécurité

- Ne jamais commiter `.env` ni `.env.local`. Ces fichiers sont déjà ignorés par `.gitignore` ; ne pas contourner cette règle avec `git add --force`.
- `.env.example` sert de référence de nommage et de commentaire. Il ne doit contenir aucune valeur de secret, même expirée, même de test.
- Un secret exposé par erreur est considéré comme compromis : le faire tourner, ne pas se contenter de réécrire l'historique.
- Ne jamais placer de donnée réelle ou nominative dans le seed ou dans les fixtures de test. Le jeu de démonstration décrit dans `docs/seed-data.md` est intégralement fictif et doit le rester.
- Ne jamais pointer une commande de base de données locale, en particulier `npm run db:reset`, vers une base partagée, de recette ou de production.

## Stack de référence

- Next.js avec TypeScript ;
- PostgreSQL avec PostGIS ;
- Supabase ou PostgreSQL managé pour accélérer le MVP ;
- MapLibre pour la cartographie ;
- stockage objet compatible S3 ;
- Playwright pour les tests end-to-end ;
- Vitest ou Jest pour les tests unitaires ;
- CI/CD GitHub Actions ;
- hébergement dans une région européenne.

## Ordre de lecture recommandé

1. `CLAUDE.md`
2. `docs/product-scope.md`
3. `docs/domain-model.md`
4. `docs/permissions.md`
5. `docs/state-machines.md`
6. `docs/api-contract.md`
7. `backlog/implementation-plan.md`
8. `backlog/epics-and-stories.md`

## Définition de réussite du pilote

Le pilote est considéré comme réussi lorsqu'un utilisateur habilité peut :

- créer une demande ;
- recevoir une proposition ;
- affecter une ressource sans conflit ;
- transmettre un point de rassemblement ;
- suivre les statuts de la mission ;
- clôturer la mission ;
- consulter la trace d'audit ;
- réaliser le parcours depuis un téléphone.

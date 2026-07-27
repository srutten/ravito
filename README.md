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

## Pile de développement en conteneurs

C'est la voie recommandée : elle satisfait la contrainte de `CLAUDE.md` selon laquelle le code doit pouvoir être exécuté localement par une procédure unique, et elle reproduit l'environnement local décrit dans `docs/deployment.md` — base de données, courriels interceptés, stockage fictif, SMS simulés.

Le seul prérequis est Docker avec Docker Compose. Node n'est pas nécessaire sur le poste.

```bash
npm run stack:up
```

À défaut de Node sur le poste, la commande équivalente est `docker compose up --build --watch`.

### Services

| Service | Rôle | Adresse par défaut | Variable de port |
|---|---|---|---|
| `app` | Application Next en développement | http://localhost:3000 | `APP_PORT` |
| `db` | PostgreSQL 17 avec PostGIS 3.5 | `localhost:5433` | `POSTGRES_PORT` |
| `mail` | Interception des courriels, interface de consultation | http://localhost:8026 | `MAIL_UI_PORT`, `MAIL_SMTP_PORT` |
| `storage` | Stockage objet compatible S3, console d'administration | http://localhost:9003 | `STORAGE_API_PORT`, `STORAGE_CONSOLE_PORT` |
| `storage-init` | Crée les seaux privés au démarrage puis se termine | — | — |

Tous les ports sont surchargeables par variable d'environnement, afin de ne pas entrer en conflit avec un service déjà présent sur le poste. Les valeurs de repli figurent dans `.env.example`.

Les valeurs par défaut sont volontairement décalées des ports canoniques : 5433 plutôt que 5432, 9002 plutôt que 9000, 1026 plutôt que 1025. Un poste de développement héberge souvent plusieurs piles en parallèle, et les ports canoniques sont les premiers occupés. Ce décalage ne concerne que les ports publiés vers le poste : à l'intérieur du réseau de la composition, les services se joignent par leur nom et leur port natif.

### Commandes

| Commande | Effet |
|---|---|
| `npm run stack:up` | Construit si nécessaire, démarre tout, et synchronise les modifications de source dans le conteneur |
| `npm run stack:start` | Démarre en arrière-plan, sans synchronisation |
| `npm run stack:stop` | Arrête les conteneurs, conserve les données |
| `npm run stack:down` | Arrête et supprime les conteneurs, conserve les volumes |
| `npm run stack:reset` | Détruit les volumes et repart d'un état vierge |
| `npm run stack:ps` | État et santé de chaque service |
| `npm run stack:logs` | Journaux en continu |
| `npm run stack:psql` | Ouvre une session psql sur la base locale |
| `npm run stack:shell` | Ouvre un interpréteur dans le conteneur applicatif |
| `npm run image:build` | Construit l'image de production et la nomme `appui-feux:local` |

### Rechargement à chaud

Le code source n'est pas monté en volume : il est synchronisé dans le conteneur par le mécanisme de surveillance de Compose. Ce choix règle deux problèmes courants sur un poste Windows ou macOS.

D'une part, le `node_modules` installé dans l'image n'est jamais masqué par celui du poste : aucun conflit possible entre des binaires natifs compilés pour Linux et ceux du système hôte. D'autre part, les fichiers vivent dans le système de fichiers du conteneur, où la surveillance native fonctionne — un montage lié ne propage pas les événements du système de fichiers à travers la frontière de virtualisation, ce qui rend le rechargement à chaud silencieusement inopérant.

Une modification de `package.json` ou de `package-lock.json` déclenche une reconstruction de l'image, afin que les dépendances du conteneur restent cohérentes avec le verrou.

### Ce que la pile locale garantit

- **Aucun courriel ne quitte le poste.** L'application ne connaît que le serveur SMTP local, qui capture tout. Les messages se consultent dans l'interface du service `mail`.
- **Les seaux de stockage sont privés.** Un seau pour les documents applicatifs, un seau distinct pour les sauvegardes, conformément à la séparation imposée par `docs/security.md`. Aucun objet n'est accessible sans URL signée.
- **Aucun SMS réel n'est envoyé.** La simulation est journalisée côté application ; elle sera livrée avec US-072.
- **Le conteneur applicatif ne s'exécute pas en `root`.**
- **Les identifiants sont des valeurs de développement**, inertes hors du poste. Ils ne doivent jamais être réutilisés ailleurs.

`docker-compose.yml` décrit uniquement l'environnement local. Il ne constitue jamais un chemin de déploiement : la préproduction et la production sont décrites en Terraform, story US-004.

## Démarrage sur un poste vierge

Voie alternative, sans conteneur pour l'application. Procédure reproductible, à exécuter depuis la racine du dépôt (`fire-support-platform`).

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

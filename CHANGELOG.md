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
- Description en Terraform de l'infrastructure Scaleway des trois environnements — preview,
  préproduction, production — dans `infra/` : état distant sur Object Storage, modules
  `server-environment` et `object-storage`, un module racine par environnement. Région `fr-par`,
  zone `fr-par-1`, projet dédié `appui-feux`. **Aucune ressource n'est appliquée** : le code est
  formaté et validé hors ligne, il n'a jamais été planifié ni appliqué sur le compte.
- `docs/infrastructure.md` : architecture cible des trois environnements et ce qui les distingue,
  tableau des coûts mensuels séparant les tarifs constatés des postes non chiffrés, procédure
  d'amorçage de l'état distant, procédure d'application environnement par environnement, procédure
  de rollback, modèle de menaces de la couche d'hébergement, et la liste de ce qui n'est pas couvert
  avec la story responsable de chaque manque.
- `infra/README.md` : prérequis, commandes autorisées hors ligne, commandes interdites,
  avertissements d'exploitation.
- Sections ajoutées à `docs/deployment.md` : correspondance entre les environnements du document et
  leur réalisation Scaleway, coût mensuel par environnement, précisions de rollback propres à
  l'infrastructure, limites connues de la chaîne de déploiement.
- Ce journal des modifications.

### Sécurité

- `.gitignore` couvrant les fichiers d'environnement, les clés, les certificats, les fichiers de
  fournisseurs cloud et les dumps de base, afin qu'aucun secret ni aucune donnée locale ne puisse
  être commité par inadvertance.
- Aucune valeur de secret dans le dépôt, y compris dans les exemples, conformément à
  `docs/security.md`.
- Aucune donnée réelle ou nominative dans les jeux de données de démonstration.
- Groupes de sécurité fermés par défaut dans le code d'infrastructure : la base de données n'est
  jamais exposée sur l'Internet public, elle écoute sur l'interface privée de l'instance. L'accès
  administrateur se fait par clé, jamais par mot de passe. Chaque règle entrante est justifiée en
  commentaire.
- Seaux Object Storage tous privés et séparés par usage : état Terraform, documents applicatifs,
  sauvegardes. Un accès en lecture aux documents ne donne ni l'état de l'infrastructure, ni les
  sauvegardes.
- Aucun secret, aucune clé et aucun mot de passe dans `infra/`, y compris dans les fichiers
  `terraform.tfvars.example`. Le seau d'état et les fichiers d'état ne sont pas commités.
- Modèle de menaces de la couche d'hébergement documenté dans `docs/infrastructure.md` : ce qui est
  exposé, ce qui ne l'est pas, et pourquoi.

### Dette connue

- TypeScript reste en 5.9.3 alors que la version courante publiée est 7.0.2. Un spike de migration
  vers TypeScript 7 doit être instruit avant le lot 3 (ADR-010).
- Les commandes `npm run db:migrate`, `npm run db:status`, `npm run db:reset` et `npm run db:seed`
  sont déclarées mais leurs scripts sont livrés par la story US-002.
- Aucune ressource d'infrastructure n'est appliquée. Le code de `infra/` n'a jamais été planifié ni
  appliqué : ni la validité des identifiants de ressources, ni l'idempotence, ni l'existence réelle
  du service ne sont prouvées. Le seau d'état distant n'existe pas et doit être créé à la main avant
  le premier `terraform init` ; le verrouillage par fichier de verrou natif du backend S3 n'a pas
  été vérifié sur l'Object Storage Scaleway.
- Aucune chaîne de déploiement automatisée. Aucun fichier n'est créé sous `.github/` : hors
  périmètre explicite de cette itération. Le critère de sortie du lot 0 — « une PR de test est
  déployée en preview » — n'est donc pas atteint (US-004, US-003).
- Aucune image conteneur, aucun registre alimenté, aucun provisionnement d'instance : proxy TLS,
  certificat et démarrage des conteneurs restent à écrire (US-004).
- Le choix d'auto-héberger PostGIS sur une instance unique crée un point de défaillance unique et
  transfère sur le projet la sauvegarde, la rétention, le test de restauration et sa preuve. Les
  sauvegardes ne sont pas scriptées (US-111), la restauration n'est pas testée (US-112), les smoke
  tests n'existent pas (US-114), la supervision d'infrastructure n'existe pas (US-110) et les
  runbooks d'infrastructure ne sont pas écrits (US-113). Analyse détaillée dans
  `docs/infrastructure.md`.
- La procédure de rollback est écrite mais n'a jamais été jouée, et son responsable n'est pas
  identifié (US-004).
- La clé d'API de déploiement retenue porte sur toute l'organisation et n'est pas restreinte au
  projet `appui-feux` : le critère d'acceptation correspondant de US-004 n'est pas satisfait. Sans
  effet tant qu'aucune ressource n'est appliquée ; à trancher avant la première application.

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

Lot 1 — Identité. Objectif : ouvrir le premier parcours vertical par l'authentification (US-010).
Ce bloc couvre les décisions d'architecture et le contrat ; les organisations, les appartenances et
le second facteur arrivent avec US-011, US-012 et US-014.

### Ajouté — Lot 1

- Décisions d'architecture ADR-015 à ADR-018 dans `docs/decision-log.md` : authentification par
  code à usage unique sans mot de passe, absence d'onglets de rôle sur l'écran de connexion,
  session opaque côté serveur plutôt que jeton auto-porteur, dépendance d'envoi SMTP.
- Contrat des cinq routes d'authentification dans `docs/api-contract.md` : demande d'un code,
  ouverture d'une session, lecture de la session courante, déconnexion, révocation de toutes ses
  sessions. Corps de requête et de réponse, codes d'erreur, règles de neutralité et exemption
  motivée d'idempotence sur les deux routes publiques.
- Code d'erreur `AUTHENTICATION_FAILED`, unique pour les quatre cas d'échec d'un code, afin qu'un
  code inexistant, expiré, déjà consommé ou erroné soit indiscernable.
- Note d'arbitrage sur l'écran 2 dans `docs/screens.md` : fusion de l'accueil et de la connexion
  retenue, trois écarts de maquette arbitrés, périmètre non livré énoncé explicitement.

### Sécurité — Lot 1

- Aucun mot de passe n'est demandé, transmis ni stocké : il n'existe donc aucune base de mots de
  passe à faire fuiter, et le bourrage d'identifiants perd sa cible.
- Le code à usage unique n'est jamais conservé en clair. L'empreinte stockée est un HMAC calculé
  avec `AUTH_SECRET`, qui ne vit pas dans la base : un vol de la seule base ne permet pas de
  rejouer un code en circulation. Un condensat simple serait inutile sur six chiffres.
- Réponses neutres imposées par le contrat : un identifiant inconnu obtient la même réponse, le
  même statut et une durée comparable à un identifiant connu, à la demande de code comme à la
  vérification. La limitation de tentatives s'applique aux deux avec les mêmes seuils.
- L'écran de connexion ne laisse plus déclarer un rôle, ce qui supprime à la fois un oracle
  d'énumération des comptes coordinateurs et une porte d'élévation de privilèges.
- Session opaque révocable à trois échelles sans redéploiement : déconnexion unitaire, révocation
  de toutes ses sessions, interrupteur global `FORCE_SESSION_REVOCATION`.
- Les routes d'authentification sont exemptées de `PLATFORM_READ_ONLY` : le mode lecture seule ne
  doit pas empêcher un coordinateur de consulter ses missions pendant un incident.

### Limites connues — Lot 1

- Le critère 12 de US-010, qui veut qu'une adhésion suspendue coupe l'accès, n'est pas réalisable :
  `organization_members` n'existe pas avant US-014. Seule la suspension du profil utilisateur est
  couverte. Le point d'extension est le calcul serveur de `redirectPath` et la vérification de
  session.
- Le second facteur est annoncé par l'interface et livré par US-011. La valeur `MFA_REQUIRED` du
  champ `nextStep` est réservée et n'est jamais émise.
- Le canal SMS et le fournisseur d'identité tiers ne sont pas livrés. Seul le courriel transporte
  le code.
- La disponibilité de la connexion dépend désormais de la délivrabilité du courriel. Ce risque est
  reporté sur l'exploitation et doit être couvert par une supervision d'envoi et une procédure de
  secours dans `docs/operations.md`.
- Les variables de connexion SMTP doivent être ajoutées à `.env.example`, sans valeur.

Lot 1 — Organisations. Objectif : donner une structure aux comptes et ouvrir la chaîne de
validation (US-012, amorce d'US-014). Ce bloc couvre les décisions d'architecture, le contrat et
les écrans ; la validation par un administrateur plateforme relève d'US-013.

### Ajouté — Organisations

- Décisions d'architecture ADR-019 à ADR-021 dans `docs/decision-log.md` : colonne `version` sur
  `organizations` pour le verrouillage optimiste, écriture dans l'outbox à l'intérieur de la
  transaction, résolution de l'adhésion à chaque requête sans mise en cache.
- Contrat des trois routes d'organisation dans `docs/api-contract.md` : création, lecture,
  modification. Corps de requête et de réponse, vocabulaire fermé de `type`, `verificationStatus` et
  `status`, formats de `name`, `territoryCode` et `registrationNumber`, codes d'erreur et effets
  transactionnels de chaque route.
- Obligation de `clientEventId` à la création et de `expectedVersion` à la modification, avec le
  raisonnement qui sépare les deux : une création n'a pas de version à comparer et rien dans son
  corps ne désigne l'objet visé, une modification porte au contraire sur un objet déjà lu.
- Règle de retour en validation : modifier le nom, le type ou le numéro d'immatriculation d'une
  organisation validée la ramène en attente et la replace dans la file.
- Idempotence de la création adossée au registre central `idempotency_keys` : la clé est réservée
  avant tout autre effet, dans la transaction de la mutation, et un rejeu relit la réponse
  conservée. Un même identifiant présenté avec un corps différent est distingué par l'empreinte de
  la requête, jamais par le corps, qui n'est pas stocké.
- Vocabulaire fermé des adhésions dans le contrat : cinq rôles et quatre statuts, avec
  l'avertissement que l'ordre de déclaration n'est pas une hiérarchie de privilèges et qu'une garde
  énumère les rôles admis au lieu de les comparer.
- Forme de la file `GET /api/v1/admin/organizations/pending`, déjà déclarée dans la section
  Administration du contrat, précisée parce que l'écran 10 en dépend.
- Section « Codes de transport » dans `docs/api-contract.md`, qui documente les sept codes produits
  par l'enveloppe des routes et déjà présents dans `src/application/errors.ts`.
- Description de la file « organisations en attente » de l'écran 10 dans `docs/screens.md` : contenu
  d'une ligne, ordre de service, compteur, absence de rafraîchissement automatique et déclinaison
  des états transverses.
- Écran 11 dans `docs/screens.md`, formulaire de création d'une organisation : champs, champs
  volontairement absents, cycle de vie de la clé d'idempotence et états d'interface.
- Alignement des deux blocs de seed que ces tables activent d'elles-mêmes : `001_organizations.sql`
  emploie désormais les types `OPERATIONAL_SERVICE` et `LOCAL_AUTHORITY` du référentiel arrêté, et
  porte l'attente sur `verification_status` en laissant `status` à `ACTIVE` ;
  `003_organization-members.sql` abandonne la colonne `id`, que la table n'a pas, et résout le
  conflit sur le couple organisation et utilisateur.
- Vocabulaire d'audit du lot : cibles `ORGANIZATION` et `ORGANIZATION_MEMBER`, actions
  `ORGANIZATION_CREATED`, `ORGANIZATION_UPDATED`, `ORGANIZATION_VERIFICATION_RESET` et
  `ORGANIZATION_MEMBER_ADDED`, toutes conformes au format `^[A-Z][A-Z0-9_]{2,63}$`, ainsi que
  l'agrégat `ORGANIZATION` et l'événement `ORGANIZATION_SUBMITTED` de l'outbox.

### Sécurité — Organisations

- Aucun rôle ni statut de vérification n'est accepté en entrée : le créateur devient administrateur
  de son organisation par décision du serveur, et une organisation ne peut pas se déclarer validée.
- La vérification ne survit pas à un changement d'identité. Renommer une organisation validée la
  ramène en attente, ce qui ferme le contournement en deux appels : se faire valider comme
  exploitation agricole, puis se renommer service d'incendie.
- Une organisation inconnue de l'appelant répond `NOT_FOUND` et non `FORBIDDEN` : la route ne
  confirme pas l'existence d'une organisation à qui n'en est pas membre. Le motif réel reste dans le
  journal technique, à l'usage de l'exploitation.
- Le message d'outbox est écrit dans la transaction qui produit la mutation : aucune notification ne
  peut annoncer un effet annulé par un retour arrière.
- L'adhésion est relue à chaque requête : une adhésion suspendue coupe l'accès dès la requête
  suivante, sans attendre l'expiration d'un cache. C'est la cinquième condition de validité de
  session laissée ouverte par `supabase/README.md` au lot précédent.
- L'écran d'administration ne porte ni courriel ni téléphone du demandeur, conformément à la
  minimisation de `docs/privacy-rgpd.md`.
- `POST` et `PATCH` restent soumises à `PLATFORM_READ_ONLY`, contrairement aux routes
  d'authentification : consulter une organisation peut être nécessaire pendant un incident, en créer
  ou en renommer une ne l'est jamais.

### Limites connues — Organisations

- `expectedVersionSchema` de `src/validation/common.ts` accepte la valeur zéro, impossible à
  satisfaire pour une organisation dont la première version est 1. Un zéro produit
  `VERSION_CONFLICT` et non `VALIDATION_ERROR`.
- Une modification dont la réponse s'est perdue en route n'est pas rejouable : la seconde tentative
  reçoit `VERSION_CONFLICT`. L'effet reste unique, seule la restitution est trompeuse, et l'écran
  doit recharger plutôt que laisser croire à l'intervention d'un tiers.
- `AUTHENTICATION_FAILED`, annoncé par le contrat depuis US-010, ne figure toujours pas dans
  `ERROR_CODES` : le code livré émet `UNAUTHENTICATED`. L'écart est désormais consigné dans le
  contrat, il reste à trancher.
- La validation d'une organisation, son refus motivé et la notification associée relèvent d'US-013.
  La file d'administration montre l'attente sans encore permettre de la lever.
- La portée de `PLATFORM_ADMIN` reste un point ouvert : `docs/permissions.md` le range parmi les
  rôles et le type énuméré des adhésions le reprend, si bien qu'un rôle dont la portée est la
  plateforme se trouve rattaché à une organisation. Le contrat tient les deux chemins pour distincts
  en attendant l'arbitrage.
- La porte d'intégration reste verte quand la base est injoignable. `databaseOrSkip`
  (`tests/integration/setup/database.ts`) déclare alors chaque test ignoré, avec son motif écrit sur
  la sortie d'erreur, et le processus sort en succès. Mesuré : avec une cible fermée, un fichier
  rend « 1 passed, 8 skipped » et le code de sortie 0, exactement comme lorsque les tests se sont
  réellement exécutés. Aucune variable ne rend la base obligatoire, en intégration continue comme
  ailleurs. `npm run test:integration` peut donc valider un commit sans avoir exercé une seule ligne
  de code serveur. Reste à trancher : une garde qui fasse échouer au lieu d'ignorer dès que la base
  est censée répondre.
- Le contrôle d'origine des méthodes non sûres, qui garde aussi les trois routes d'organisation
  (`app/api/v1/auth/_shared/auth-route.ts`), compare l'hôte de l'en-tête `Origin` à celui de la
  requête — port compris, schéma exclu. Une origine `http://` est donc acceptée sur un service servi
  en `https://`, là où un hôte étranger et un port différent sont bien refusés. Le comportement est
  volontairement écarté des tests pour ne pas graver un choix qui n'a pas été arbitré : rien ne le
  documente et rien ne le garde. Reste à trancher : comparer l'origine entière, ou assumer l'écart
  derrière une terminaison TLS de confiance, puis le figer dans le sens retenu.
- Dans `src/application/api-route.ts`, la mesure de la taille du corps sur le régime non annoncé lit
  un clone du flux pendant que le gestionnaire lit l'original, et l'abandon du lecteur n'est pas
  attendu. Une course a été observée une fois sur huit — un corps de 4 097 octets traversant
  une limite de 2 048, et un corps arrivant vide au gestionnaire — sans être reproduite en
  isolation. Conséquence : la garde contre l'épuisement de mémoire peut laisser passer une requête
  trop grosse, et une requête légitime peut être refusée sans cause visible. Reste à trancher :
  mesurer en ne lisant le corps qu'une seule fois, plutôt qu'en le clonant.
- `assertOrganizationVerified` (`src/authorization/organization-access.ts`) est exportée sans aucun
  appelant ni aucun test, et `ORGANIZATION_NOT_VERIFIED` n'est par conséquent émis par aucune route.
  La quatrième vérification exigée par `CLAUDE.md`, le niveau de vérification, n'est donc câblée
  nulle part : la garde attend la story qui subordonnera une action à la validation de
  l'organisation. Une garde que rien n'exerce n'offre aucune garantie, et son existence ne doit pas
  être lue comme une protection en place.
- Les écrans connectés répondent 200 là où le protocole attend une redirection ou un 404. La racine
  du document lit `headers()` pour son nonce, si bien que le flux de rendu est déjà commencé quand
  la coquille `(app)` appelle `redirect()` ou qu'un écran appelle `notFound()` : Next transporte
  alors la consigne dans le document. Mesuré. Le corps protégé n'est jamais rendu et le navigateur
  aboutit bien à la connexion ou à la page introuvable, mais aucune supervision ne comptera de 404
  ni de redirection, et un navigateur sans script reste sur une coquille. Reste à trancher : décider
  l'accès avant que le rendu ne commence.
- La page introuvable pose sa propre région principale, par le gabarit `StatePage`, avec
  l'identifiant `contenu-principal` que porte déjà la coquille des écrans connectés. Rendue sous
  cette coquille, elle produit deux `<main id="contenu-principal">` imbriqués : identifiant dupliqué
  et second repère de contenu principal, que ni le lien d'évitement ni une technologie d'assistance
  ne savent départager. Le commentaire de `StatePage` suppose l'inverse, à savoir que ces écrans ne
  sont jamais rendus dans un gabarit qui porte déjà une région principale. Aucun test ne l'éprouve.
- La réversibilité des migrations vérifiée par ce lot ne couvre pas le socle. Quatre migrations
  n'ont aucun `.down.sql` : `0001` (extensions), `0002` (rôle applicatif), `0006` (journal d'audit)
  et `0008` (`citext`). L'absence est délibérée et motivée fichier par fichier dans
  `supabase/README.md` — une extension retirée cascaderait sur des données, un rôle est global à
  l'instance, et un retour arrière capable d'effacer l'audit serait une porte dérobée. La
  conséquence reste entière : la descente s'arrête juste au-dessus de `0008`, aucun retour arrière
  ne ramène à une base vide, et `db:reset` est le seul chemin.
- La règle d'ingénierie qui tient la confidentialité des journaux ne vit que dans le code. Toute
  erreur reconnue comme venant du pilote PostgreSQL est remplacée par une liste d'autorisation
  fermée de champs de diagnostic, appliquée à toute profondeur, cause comprise, et son message ne
  devient jamais le `msg` de la ligne (`src/observability/logger.ts`). `docs/observability.md`
  énonce la règle de principe — ni nom, ni numéro d'immatriculation, ni code territorial dans les
  journaux — mais pas le mécanisme qui la met en œuvre. Une reprise du journaliseur peut donc
  rouvrir la fuite sans contredire aucun document.
- En intégration continue, `playwright.config.ts` accorde deux reprises alors que quatre fichiers de
  bout en bout déclarent `mode: 'serial'`. Une seule défaillance fait rejouer le groupe entier,
  jusqu'à trois exécutions complètes du fichier, sans distinguer le test instable de ses voisins ni
  corriger quoi que ce soit quand l'échec est déterministe. Reste à trancher : reprendre au fichier
  plutôt qu'au groupe, ou renoncer aux reprises au profit d'un diagnostic.
- La consultation de la file d'administration écrit une ligne de journal technique en `info` —
  module, acteur pseudonymisé, volume servi, profondeur de file — mais aucune ligne d'`audit_logs`.
  `docs/permissions.md` demande la journalisation des consultations sensibles ; un déploiement réglé
  sur `warn` perd cette trace. La trace durable suppose d'ouvrir le vocabulaire fermé de
  `src/infrastructure/audit/audit-log.ts` à une action de consultation, ce qui n'est pas fait.
- L'écran d'administration laisse la file déjà chargée visible sous le refus quand la fonction est
  retirée en cours de session : la personne lit qu'elle n'a pas les droits au-dessus des lignes
  restées à l'écran. Ce n'est pas une fuite — ces lignes étaient déjà dans son navigateur, et une
  navigation neuve refuse l'écran entier — mais `docs/screens.md` veut qu'une permission refusée
  refuse l'écran, pas seulement la file.
- Hors intégration continue, `npm run test:e2e` construit l'artefact puis réutilise le serveur déjà
  présent sur le port attendu (`reuseExistingServer`). Les trois fichiers qui dépendent du serveur
  commun sont alors servis par ce qui occupe ce port, et non par ce qui vient d'être construit : sur
  un poste où la pile Docker sert une image antérieure, la porte est rouge pour cette seule raison,
  dix échecs mesurés. Les quatre fichiers autonomes, eux, servent l'artefact du dépôt sur un port
  libre. Reste à trancher : étendre ce montage aux trois derniers, ou refuser de réutiliser un
  serveur dont rien ne prouve qu'il sert l'artefact courant.
- Fait d'exploitation, et non défaut de code : la porte de bout en bout est rouge tant qu'un service
  étranger occupe le port 3000. Trois des sept fichiers — `public-home`, `auth-entry-point` et
  `security-headers` — dépendent légitimement du serveur commun, servi sur ce port. Hors intégration
  continue, Playwright réutilise ce qui s'y trouve et éprouve donc une autre application ; en
  intégration continue, il refuse de démarrer et pas un test ne s'exécute. Mesuré sur le poste de
  référence : le conteneur `appui-feux-app` de la pile Docker locale y sert une autre base de code,
  et la suite entière est verte — 135 tests passés, 1 sauté — dès que la porte ne rend plus son
  verdict sur lui. Aucun fichier du dépôt n'en avertissait ; la procédure est désormais écrite dans
  `README.md`, porte de qualité 5. La question de fond reste celle de la limite précédente :
  réutiliser un serveur dont rien ne prouve qu'il sert l'artefact courant.
- `next.config.ts` déclare `output: 'standalone'`, dont le point d'entrée est
  `.next/standalone/server.js`, alors que les sept fichiers de bout en bout éprouvent `next start` :
  les trois qui dépendent du serveur commun par `npm run start`, les quatre autonomes en le lançant
  eux-mêmes sur un port libre. Next tient la combinaison pour non prise en charge et l'écrit au
  démarrage — « "next start" does not work with "output: standalone" configuration. Use "node
  .next/standalone/server.js" instead. » — sans rien interrompre, là où `output: 'export'` lève une
  erreur. La suite garde donc un serveur que le déploiement n'exécute pas, et le fichier qui vérifie
  ce que le serveur envoie réellement, `tests/e2e/security-headers.spec.ts` — politique de sécurité
  du contenu à nonce comprise —, ne dit rien de l'artefact livré. Aucun fichier du dépôt n'exécute
  cet artefact : les trois répertoires d'`infra/environments/` sont vides. Reste à trancher :
  éprouver le serveur autonome, ou retirer `output: 'standalone'` tant qu'aucun déploiement ne le
  consomme.
- L'atomicité du retour arrière des trois fichiers qui défont plusieurs objets — `0004` (quatre
  types), `0009` (deux) et `0014` (cinq) — n'est éprouvée que sur deux d'entre eux.
  `tests/integration/db-rollback.test.ts` joue `0004` seul sur une base à jour et `0014` hors
  ordre ; aucun révélateur ne porte sur `0009`, et aucun n'est atteignable aujourd'hui : ses deux
  types sont portés par la même table, `user_profiles`, donc refusés ou libérés ensemble. Cette
  immunité tient à une coïncidence du schéma courant, pas au fichier. Une migration future qui
  emploierait `user_verification_level` sur une autre table rouvrirait le refus partiel sans
  qu'aucun test ne le voie, et sans que rien n'avertisse au moment de l'écrire : seul l'en-tête du
  fichier le dit. Reste à trancher : éprouver la propriété par un révélateur qui vaille pour tout
  `.down.sql` défaisant plus d'un objet, plutôt que fichier par fichier.
- La limite consignée plus haut sur la confidentialité des journaux ne décrit que
  `src/observability/logger.ts`. Le second journaliseur du dépôt, `scripts/db/lib/script-logger.ts`,
  n'a ni sérialiseur d'erreur, ni épuration des erreurs du pilote, ni crochet sur le message : il ne
  porte que la rédaction par nom de clé. Or `db:migrate`, `db:status` et `db:bootstrap-roles`
  tournent en intégration continue et sur les déploiements. Aucun de ces scripts ne journalise
  aujourd'hui l'objet d'erreur — le compte rendu opérateur est du texte — mais
  `describeExecutionFailure` (`scripts/db/lib/migration-runner.ts`) et `describeBlockFailure`
  (`scripts/db/seed.ts`) interpolent le `message` et le `hint` du serveur dans ce texte, qui devient
  le `msg` de la ligne : c'est exactement le canal que le crochet ferme côté applicatif. Mesuré avec
  les options de ce module : une erreur du pilote posée sous `err`, passée seule, ou rangée sous une
  clé quelconque, publie `detail` en entier — « Key (registration_number)=(…) already exists. »
  Reste à trancher : partager l'épuration entre les deux journaliseurs malgré l'alias `@/` que
  l'exécution native de Node ne résout pas, ou assumer qu'aucun script ne journalise d'objet
  d'erreur, et le garder par un test.
- Le dépôt n'a pas d'`instrumentation.ts`, donc aucun gestionnaire `onRequestError`. Les routes
  d'API sont couvertes — `defineRoute` attrape tout et passe par le journaliseur épuré — mais pas le
  rendu de page serveur : `app/(app)/administration/organisations-en-attente/page.tsx` appelle
  `isPlatformAdministrator` sans filet, et `app/(app)/organisations/[organizationId]/page.tsx`
  relève tout ce qui n'est pas un `NOT_FOUND`. Une erreur du pilote levée là part au mécanisme par
  défaut de Next, sur la sortie d'erreur du processus, où l'inspection de Node recopie les champs
  propres de l'exception : mesuré, `detail` — donc la ligne qui a échoué — s'y imprime en entier. En
  déploiement conteneurisé, cette sortie est le journal. Reste à trancher : ajouter
  `instrumentation.ts` et y router les erreurs de requête vers le journaliseur épuré.
- Les liaisons d'un journal enfant échappent à l'épuration des erreurs du pilote. Mesuré sur la
  version de pino livrée : la rédaction par chemin couvre bien ces liaisons, le sérialiseur d'erreur
  aussi, mais `formatters.log` — où vivent `redactLogObject` et `sanitizePostgresError` — n'est
  appliqué qu'à l'objet de l'appel. Une erreur du pilote placée dans `logger.child({ … })` sous une
  clé quelconque publie donc `detail` en entier. Aucun site ne l'atteint : `logger.child(` n'a qu'un
  appelant, `buildRequestBindings`, dont les cinq clés portent des chaînes. C'est une mine, pas une
  fuite, et rien ne la garde. Reste à trancher : épurer les liaisons à la construction du journal
  enfant, ou n'y admettre que des chaînes.
- `RequestContext.userIdHash` est déclaré, lu une fois par `buildRequestBindings`, et renseigné
  nulle part : `defineRoute` construit le contexte avant que la session soit résolue, et rien ne le
  complète ensuite. Aucune ligne issue du contexte de requête ne porte donc d'acteur, refus de
  `denyOrganizationAccess` compris. Conséquence : deux rafales d'`ORGANIZATION_ABSENT` de même
  volume — un compte qui balaye des identifiants, ou mille personnes tombées sur un lien mort — sont
  indiscernables, le motif et l'`organizationId` séparant les causes techniques et non les auteurs.
  La seule ligne qui nomme un acteur est la trace de consultation de la file, qui pseudonymise sur
  place. `docs/observability.md` consigne cette dette ; ce journal l'ignorait. Reste à trancher :
  renseigner `userIdHash` dès la session résolue, dans `defineAuthenticatedRoute`.
- Deux gardes refusent sans écrire de motif, alors que l'en-tête de
  `src/authorization/organization-access.ts` affirme que les gardes de ce module ne lèvent jamais
  une `AppError` de refus sans avoir écrit la ligne qui la motive. `assertOrganizationActive` lève
  un `FORBIDDEN` nu et elle est atteinte — `update-organization-identity.ts` l'appelle ;
  `assertPlatformAdministrator` (`src/domain/organizations/list-pending-organizations.ts`) fait de
  même sur la file d'administration. Conséquence : ces deux refus n'alimentent pas la métrique
  « refus d'autorisation » de `docs/observability.md`, et un refus de la file ne laisse que la ligne
  de sortie de requête en `warn`, sans motif. `docs/api-contract.md` assume le premier cas et nomme
  le motif qu'il faudrait — `ORGANIZATION_NOT_ACTIVE` —, qui n'existe que dans ce document et dans
  aucun vocabulaire du code ; le second n'est déclaré nulle part. Reste à trancher : ouvrir le
  vocabulaire des motifs à ces deux refus, ou corriger l'en-tête qui promet plus que le module ne
  tient.
- L'égalité de travail entre les deux branches de `PATCH /api/v1/organizations/{id}` n'est gardée
  par aucun test. `updateOrganizationIdentity` résout l'accès avant de constater l'absence, comme
  `readOrganization`, précisément pour qu'une organisation inconnue et une organisation dont
  l'appelant n'est pas membre coûtent le même travail : les deux réponses sont identiques au bit
  près, et le seraient encore si les durées divergeaient. Mesuré : en remettant le constat d'absence
  avant la résolution d'accès — une requête au lieu de trois —, les 45 tests de
  `organizations-identity-route`, `organizations-refus-journal` et `organizations-atomicity` restent
  verts. L'oracle d'existence se rouvrirait donc par la latence sans qu'aucune porte ne bronche.
  La propriété ne vit aujourd'hui que dans un commentaire. Reste à trancher : la garder par une
  mesure de travail — nombre de requêtes émises, plutôt que durée, qui serait instable en
  intégration continue.
- `sessions.token_hash` est comparé par égalité SQL, sans comparaison applicative à temps constant,
  alors que `src/domain/identity/verify-sign-in-code.ts` applique exactement ce raisonnement à
  `code_hash` et le documente. La sévérité est discutable — l'empreinte comparée est de haute
  entropie, et le canal temporel d'un index PostgreSQL est d'une autre nature que celui d'une
  comparaison d'octets en mémoire —, mais l'asymétrie entre deux secrets de session du même produit
  n'est justifiée nulle part. Reste à trancher : aligner, ou écrire pourquoi les deux cas diffèrent.

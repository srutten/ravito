# Journal de décisions d'architecture

## ADR-001 — Monolithe modulaire

Décision : utiliser une seule application déployable.

Raison : vitesse, simplicité, transactions, observabilité.

Conséquence : séparation logique stricte nécessaire.

## ADR-002 — PostgreSQL et PostGIS

Décision : base relationnelle avec géospatial.

Raison : cohérence, transactions et recherche de proximité.

## ADR-003 — REST versionné

Décision : API REST sous `/api/v1`.

Raison : simplicité et compatibilité.

## ADR-004 — Validation humaine

Décision : le moteur propose, un coordinateur décide.

Raison : sécurité et responsabilité.

## ADR-005 — Position approximative par défaut

Décision : toute vue non affectée utilise une position dégradée.

Raison : protection opérationnelle.

## ADR-006 — Outbox pour notifications

Décision : planifier les notifications via événements persistés.

Raison : éviter les notifications sans transaction ou les pertes.

## ADR-007 — Hors ligne limité

Décision : consultation et file locale uniquement.

Raison : réduire la complexité et les risques du MVP.

## ADR-008 — Événements de mission immuables

Décision : chronologie append-only.

Raison : audit, diagnostic et preuve.

## ADR-009 — Biome comme outil unique de lint et de format

Décision : utiliser Biome pour le lint et le format, à la place du couple ESLint et Prettier.

Raison : une seule dépendance au lieu de deux, une seule configuration, un seul mode d'échec en CI. Applique la contrainte de `CLAUDE.md` de ne pas ajouter de dépendance sans justification.

Conséquence : les règles disponibles sont celles de Biome. Un besoin de règle absente doit être traité par une revue ou un test, pas par la réintroduction d'ESLint sans nouvelle décision. Le format de référence est fixé dans `biome.json` : guillemets simples, points-virgules, largeur 100 colonnes, indentation de 2 espaces, virgule finale.

## ADR-010 — TypeScript 5.9.3 pour le lot 0

Décision : figer TypeScript en 5.9.3 alors que la version courante publiée est 7.0.2.

Raison : dé-risquer le lot 0 en s'appuyant sur une chaîne d'outils éprouvée. Next, Vitest et Biome sont validés avec cette version, et le lot 0 ne doit pas absorber en plus une migration de compilateur.

Conséquence : dette technique explicite. Un spike de migration vers TypeScript 7 doit être instruit avant le lot 3, avec évaluation de la compatibilité du plugin Next, des options strictes déjà activées et du temps de compilation. Tant que le spike n'a pas conclu, la version ne change pas.

## ADR-011 — CSS Modules et jetons de design en variables CSS

Décision : construire l'interface avec les CSS Modules de Next et des jetons de design déclarés en variables CSS natives, sans framework CSS.

Raison : parcimonie des dépendances, conformément à `CLAUDE.md`. Le besoin du MVP est un design system minimal, pas une bibliothèque générique.

Conséquence : le design system est écrit à la main. Les contrastes, les tailles de cibles tactiles et les états d'interface décrits dans `docs/screens.md` doivent être vérifiés explicitement, sans filet fourni par un framework.

## ADR-012 — npm comme gestionnaire de paquets

Décision : utiliser npm, avec `package-lock.json` versionné.

Raison : c'est le gestionnaire imposé par les commandes attendues dans `CLAUDE.md`. Il est disponible avec Node 24 sans installation supplémentaire, ce qui simplifie la procédure de démarrage sur un poste vierge et la configuration de la CI.

Conséquence : toute commande de documentation, de CI et de runbook s'écrit en npm. Changer de gestionnaire supposerait une nouvelle décision et la mise à jour de `CLAUDE.md`.

## ADR-013 — Racine du dépôt git sur `fire-support-platform`

Décision : placer la racine du dépôt git au niveau du répertoire `fire-support-platform`.

Raison : c'est le niveau où `CLAUDE.md` attend `app`, `src`, `tests`, `docs` et `supabase`. Une racine placée plus haut ferait diverger les chemins documentés, les alias `@/` et les chemins de la CI.

Conséquence : les chemins cités dans la documentation, dans `tsconfig.json` et dans les configurations de test sont relatifs à cette racine. Aucun fichier du produit ne vit au-dessus.

## ADR-014 — Refus par défaut câblé dans le routeur API dès le lot 0

Décision : toute route de l'API qui n'est pas déclarée publique de façon explicite répond `UNAUTHENTICATED`, dès le lot 0, avant même que l'authentification existe.

Raison : le principe de refus par défaut de `docs/permissions.md` ne doit pas attendre l'existence de l'authentification pour être structurellement vrai. Une route ajoutée pendant le lot 1 doit être fermée par construction, et non par la vigilance de son auteur.

Conséquence : ouvrir une route est un acte volontaire et traçable, jamais un effet de bord. Le lot 1 remplace le refus systématique par une vérification de session réelle, sans modifier le principe ni le code d'erreur exposé. Le format de réponse suit `docs/api-contract.md`.

## ADR-015 — Authentification par code à usage unique, sans mot de passe

Décision : l'authentification repose exclusivement sur un code à usage unique envoyé sur un canal que l'utilisateur contrôle. Aucun mot de passe permanent n'est demandé, transmis, ni stocké, et aucun parcours de récupération de mot de passe n'existe.

Raison : `docs/screens.md` écran 2 cite le code à usage unique comme moyen d'entrée, et c'est le critère 3 de US-010. Aucun document du corpus n'exige de mot de passe ; la maquette est la seule pièce qui en montre un, et la règle de résolution de conflit de `CLAUDE.md` classe les maquettes en dernier. Le raisonnement de fond est qu'un secret qui n'existe pas ne peut pas fuiter : sans base de mots de passe, il n'y a rien à dérober, rien à ressaisir depuis une fuite tierce, aucune politique de rotation à faire respecter. `docs/security.md` exige une protection contre le bourrage d'identifiants ; la meilleure protection disponible est de supprimer la cible de l'attaque plutôt que de la défendre.

Conséquence, sur le stockage : le code n'est jamais conservé en clair. Seule une empreinte est stockée, avec sa date d'expiration, son compteur de tentatives et sa date de consommation. L'empreinte est un HMAC-SHA-256 calculé avec `AUTH_SECRET`, qui vit dans le gestionnaire de secrets et non dans la base. Un condensat simple ne suffirait pas : un code à six chiffres n'a qu'un million de valeurs, une table complète se calcule en quelques secondes, et l'empreinte n'apporterait alors aucune protection. Avec une clé absente de la base, un vol de la seule base ne permet pas de rejouer un code en circulation.

Conséquence, sur les paramètres : code numérique de six chiffres, tiré par un générateur cryptographique, valable dix minutes, cinq tentatives au maximum par défi, un nouvel envoi possible au bout d'une minute. La probabilité de succès d'une devinette reste de cinq sur un million, encadrée par la limitation de tentatives de `docs/security.md`.

Conséquence, sur la disponibilité : la connexion dépend désormais entièrement de la délivrabilité du canal. Une panne du serveur d'envoi, une mise en liste noire du domaine expéditeur ou un filtrage trop agressif deviennent une panne d'authentification, donc une indisponibilité de la coordination. Ce risque est reporté sur l'exploitation : envoi passant par l'outbox avec relances bornées, supervision de l'échec d'envoi parmi les alertes de `docs/observability.md`, et procédure de secours à documenter dans `docs/operations.md`. La réponse de l'API ne dépend jamais du succès de l'envoi.

Conséquence, sur le risque résiduel : celui qui contrôle la boîte aux lettres contrôle le compte. Le risque n'est pas supprimé, il est déplacé du mot de passe vers le canal. C'est une des raisons pour lesquelles US-011 impose un second facteur aux rôles sensibles, qui sont précisément ceux dont la compromission figure en tête des menaces prioritaires de `docs/security.md`.

## ADR-016 — Aucun onglet de rôle sur l'écran de connexion

Décision : l'écran de connexion ne propose aucun sélecteur de rôle. Le rôle est résolu côté serveur à partir du compte, après authentification, et la destination après connexion est calculée par le serveur.

Raison : la maquette propose trois onglets, « Contributeur », « Coordinateur » et « Administration ». Un onglet qui se comporterait différemment selon l'identifiant saisi serait un oracle d'énumération : il suffirait de soumettre une liste d'adresses sous l'onglet « Coordinateur » et d'observer l'écart pour cartographier les comptes sensibles. Or les identités des coordinateurs sont un actif de `docs/threat-model.md`, et le compte coordinateur compromis ouvre la liste des menaces prioritaires de `docs/security.md` ; l'énumération est l'étape qui précède le hameçonnage ciblé. Un onglet qui, à l'inverse, ne changerait rien au comportement serait une interface qui ment sur ce qu'elle fait.

Raison complémentaire : un rôle déclaré par le client est une donnée client. `docs/security.md` interdit d'y accorder la moindre confiance et `CLAUDE.md` exige que toute règle métier soit côté serveur. Honorer les onglets reviendrait à offrir une élévation de privilèges depuis le formulaire de connexion, ce qui est la dernière menace de la liste prioritaire.

Conséquence : un formulaire unique, identique pour tous, quel que soit le rôle réel du compte. La destination après connexion est portée par le champ `redirectPath` du contrat, jamais par un choix de l'utilisateur. La maquette est écartée sur ce point au titre de la règle de résolution de conflit de `CLAUDE.md`, qui place les permissions et la sécurité des personnes avant les détails d'interface.

## ADR-017 — Session opaque côté serveur plutôt que jeton auto-porteur

Décision : la session est un identifiant opaque, tiré aléatoirement, sans contenu interprétable, transporté par un cookie `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, préfixé `__Host-`. L'état de la session vit en base : utilisateur, dates d'émission, d'expiration d'inactivité et d'expiration absolue, date de révocation. Seule une empreinte du jeton est stockée. Aucun jeton auto-porteur, aucun JWT.

Raison : le critère 11 de US-010 exige une révocation immédiate, `docs/security.md` exige une révocation globale, et `docs/operations.md` fait de la révocation des sessions la deuxième étape de la réponse à incident, juste après la suspension du compte. Un jeton auto-porteur reste valide jusqu'à son échéance : le révoquer impose soit une liste de révocation consultée à chaque requête, c'est-à-dire exactement l'accès serveur que le jeton prétendait éviter, soit des durées de vie si courtes que le mécanisme de rafraîchissement redevient la vraie session, avec sa propre révocation à écrire. Dans les deux cas la complexité est ajoutée sans que le bénéfice le soit.

Raison complémentaire : à l'échelle d'un monolithe modulaire avec une seule base, l'argument de performance du jeton auto-porteur ne s'applique pas. Vérifier une session est une lecture indexée sur une connexion déjà ouverte par le pool applicatif. Enfin, un identifiant opaque ne divulgue rien, alors qu'un jeton auto-porteur expose ses attributs à quiconque accède au poste, ce qui contredit la minimisation de `docs/privacy-rgpd.md`.

Conséquence : la révocation existe à trois échelles, sans redéploiement. Unitaire par la déconnexion, par utilisateur avec `POST /api/v1/auth/sessions/commands/revoke-all`, et globale par l'interrupteur `FORCE_SESSION_REVOCATION` de `docs/feature-flags.md`, qui invalide toutes les sessions émises avant son activation.

Conséquence : chaque requête authentifiée coûte une lecture de session, qui ne doit jamais être mise en cache, conformément au point « ne pas cacher les autorisations critiques » de `docs/architecture.md`. Les durées retenues pour US-010 sont douze heures d'inactivité et sept jours en absolu, valeurs uniques pour tous les comptes ; la réduction exigée par « sessions courtes pour les fonctions sensibles » suppose de connaître le rôle et arrive donc avec US-011 et US-014.

Conséquence : l'usage de cookies impose une protection CSRF, exigée par `docs/security.md`. Elle repose sur `SameSite=Lax` et sur une vérification d'origine pour toute méthode non sûre. En environnement local, servi en HTTP, le préfixe `__Host-` et l'attribut `Secure` sont retirés, faute de quoi le navigateur rejetterait silencieusement le cookie ; cet écart est porté par la configuration d'environnement et par elle seule.

Conséquence : la table des sessions devient un actif à part entière. Elle contient des empreintes et jamais des jetons, elle est purgée selon la rétention de `docs/privacy-rgpd.md`, et sa consultation relève des données sensibles de `docs/permissions.md`.

## ADR-018 — Dépendance d'envoi SMTP

Décision : ajouter `nodemailer` comme unique dépendance nouvelle nécessaire à US-010, placée derrière l'interface `NotificationProvider` de `docs/notifications.md`. La version exacte est figée dans `package.json` et son fichier de verrouillage.

Raison : `CLAUDE.md` interdit d'ajouter une dépendance sans justification, non d'en ajouter. La justification est directe : le code à usage unique d'ADR-015 n'a de valeur que s'il atteint son destinataire, donc sans transport il n'y a pas d'authentification du tout. L'alternative serait d'écrire un client SMTP à la main, ce qui suppose la négociation ESMTP, la bascule STARTTLS, l'authentification du compte d'envoi, l'encodage MIME et des en-têtes acceptables par les filtres. Chacun de ces points est une source d'erreur à conséquence directe de sécurité : une bascule STARTTLS mal traitée envoie un code d'authentification en clair sur le réseau, un en-tête mal encodé ouvre une injection d'en-tête. Le risque d'un composant éprouvé, largement déployé et sans dépendance transitive au moment du choix, est inférieur au risque d'un client artisanal écrit pour l'occasion.

Conséquence : le fournisseur reste derrière l'interface, le domaine ne l'appelle jamais directement, et un remplacement par l'API HTTP d'un fournisseur transactionnel ne touche qu'un adaptateur. En développement, l'envoi pointe sur Mailpit, conformément au mode test de `docs/notifications.md` : aucun courriel réel ne quitte un poste. Les variables de connexion SMTP rejoignent `.env.example` sans valeur.

Conséquence : le code d'authentification n'est pas conditionné par le flag `ENABLE_EMAIL`. Ce flag ouvre les notifications produit ; l'envoi d'un code de connexion est une fonction de sécurité, pas une notification. Le placer derrière un flag produit dont la valeur par défaut est fausse ferait d'un oubli de configuration une mise hors service complète de la plateforme, sans message compréhensible pour personne. Les deux usages partagent l'adaptateur, pas l'interrupteur.

## ADR-019 — Colonne `version` sur `organizations` pour le verrouillage optimiste

Décision : `organizations` porte une colonne `version`, entière, non nulle, initialisée à 1 et strictement positive. Toute modification est conditionnée par la version attendue et incrémente la version dans la même instruction de mise à jour. Zéro ligne mise à jour vaut conflit et se traduit par `VERSION_CONFLICT`.

Raison : `docs/domain-model.md` donne une colonne `version` à `Resource`, `OperationalRequest`, `Offer` et `Mission`, et n'en donne pas à `Organization`. La règle générale du même document, « version positive pour verrouillage optimiste », et l'exigence de `docs/screens.md` d'un état « conflit de version » sur *chaque* écran s'appliquent pourtant sans exception annoncée. L'absence est donc un oubli du modèle et non une décision : le contrat API exige un `expectedVersion` sur la modification d'une organisation, et il n'existe rien pour le porter.

Raison de fond : deux administrateurs de la même organisation ne se voient pas l'un l'autre. Sans version, le dernier écrivain gagne et la modification perdue ne laisse ni message ni trace côté appelant. Les champs concernés — nom, type, numéro d'immatriculation — sont exactement ceux sur lesquels un administrateur plateforme fonde sa décision de validation. Un écrasement silencieux y est un problème de sécurité et non de confort : la fiche validée peut n'être plus celle qui a été examinée.

Conséquence, sur le schéma : `version integer NOT NULL DEFAULT 1`, avec une contrainte `CHECK (version > 0)`. La première version est 1 et non 0. Cela rend un `expectedVersion` à zéro impossible à satisfaire, ce qui est utile puisque le schéma partagé `expectedVersionSchema` de `src/validation/common.ts` l'accepte syntaxiquement : la valeur traverse la validation et échoue à la comparaison, avec `VERSION_CONFLICT` plutôt que `VALIDATION_ERROR`. L'écart est consigné dans `docs/api-contract.md` plutôt que corrigé au passage, le schéma étant partagé par des agrégats dont la première version n'est pas encore arbitrée.

Conséquence, sur le code : l'incrément est écrit dans la requête de mise à jour, jamais dans un déclencheur. Un déclencheur incrémenterait aussi les écritures d'exploitation — reprise de données, purge, correction manuelle — et ferait alors échouer des modifications légitimes sans que personne comprenne pourquoi. Il séparerait surtout la détection du conflit du code qui doit y répondre, alors que c'est le nombre de lignes affectées par `UPDATE ... WHERE id = $1 AND version = $2` qui tranche, et qu'il faut le lire là où l'erreur est levée.

Conséquence, sur la documentation : `docs/domain-model.md` doit recevoir `version` parmi les champs d'`Organization`. La correction n'est pas faite ici, ce journal décrivant les décisions et non le modèle ; elle est signalée au rapport de la story et reste une dette tant qu'elle n'est pas portée.

Conséquence, sur la suite : la même colonne deviendra nécessaire sur `organization_members` le jour où la modification d'un rôle sera concurrente (US-014). Elle n'est pas ajoutée par anticipation : une colonne s'ajoute sans reprise de données, alors qu'une décision prise trop tôt se paie plus longtemps.

## ADR-020 — Écriture dans l'outbox à l'intérieur de la transaction

Décision : le message d'outbox est inséré dans la transaction qui produit la mutation, avant le commit, au même titre que la ligne d'audit. Aucune notification n'est planifiée après le commit, ni par une seconde connexion, ni par un appel du gestionnaire de route.

Raison : `docs/architecture.md` demande de « garantir que les notifications sont planifiées après une mutation réussie ». Le mot « après » se lit de deux façons et une seule est tenable. Après dans le temps — commiter, puis écrire le message — laisse une fenêtre entre les deux : si le processus s'arrête, ou si la seconde écriture échoue, l'effet existe et la notification n'existera jamais. Personne ne s'en aperçoit, puisqu'il ne reste rien à observer. Après dans la causalité — écrire le message dans la même transaction, de sorte qu'il ne devienne visible que si la mutation l'est — ne laisse aucune fenêtre. C'est cette lecture qui est retenue, et c'est la raison d'être de l'outbox selon ADR-006 : « éviter les notifications sans transaction ou les pertes ».

Raison de fond : notifier une mutation qui n'a pas abouti est pire que ne pas notifier. Ce n'est pas une préférence d'ingénierie. Le produit coordonne des moyens matériels pendant un incendie : une notification annonçant une affectation annulée par un retour arrière envoie un conducteur et un engin sur une route, de nuit, pour une mission qui n'existe pas — soit exactement ce que `CLAUDE.md` interdit d'un bout à l'autre. À l'échelle de ce lot, la conséquence est plus modeste, un administrateur plateforme cherchant dans sa file une organisation qui n'y figure pas ; mais le mécanisme retenu doit être celui qui tiendra au lot 5, où il déplace des personnes. Le mode d'échec inverse, un message commité alors que l'envoi ne part pas encore, ne produit qu'un retard, et le retard est précisément ce que la file existe pour absorber : `attempt_count`, `last_error` et relances bornées sont déjà dans `0005_outbox.sql`.

Conséquence : aucun fournisseur externe n'est appelé pendant une transaction. L'insertion dans l'outbox est une écriture locale ; elle ne peut ni allonger la transaction de la durée d'un aller-retour réseau, ni la faire échouer parce qu'un serveur d'envoi est lent. C'est aussi ce qui rend la règle tenable : si la planification supposait un appel externe, la tenir dans la transaction serait irresponsable.

Conséquence : le contenu du message est minimal — un identifiant d'agrégat, un type d'événement, et le strict nécessaire au rendu du modèle. Ni position précise, ni document, ni téléphone complet, ni code : la table est lue par le processus d'envoi et par l'exploitation, et `docs/observability.md` comme `docs/security.md` interdisent d'y faire transiter des données sensibles. Le processus d'envoi relit l'état courant au moment d'envoyer, ce qui évite en outre d'expédier une information devenue fausse entre l'écriture et l'envoi.

Conséquence : `event_type` et `aggregate_type` suivent la même contrainte de casse que le journal d'audit, `^[A-Z][A-Z0-9_]{2,63}$`. Ce lot y ajoute l'agrégat `ORGANIZATION` et l'événement `ORGANIZATION_SUBMITTED`. Écrire « Organization » échoue sur la contrainte, avec un message qui ne dit pas pourquoi (`supabase/README.md`).

Conséquence : l'échec de l'insertion du message fait échouer la mutation, puisque les deux partagent la transaction. C'est voulu, et symétrique de l'audit — `src/infrastructure/audit/audit-log.ts` ne capture aucune erreur pour la même raison. Une mutation qui aboutirait sans que sa notification soit planifiée est une mutation dont personne ne sera prévenu ; mieux vaut la refuser et laisser l'appelant recommencer.

## ADR-021 — Adhésion résolue à chaque requête, sans mise en cache

Décision : le rôle et l'adhésion de l'appelant dans une organisation sont relus à chaque requête qui en dépend, par une lecture indexée, dans la transaction qui décide. Aucun cache, aucune mémorisation dans la session, aucun rôle recopié dans le cookie.

Raison : `docs/architecture.md` range les autorisations parmi ce qu'il ne faut pas cacher, et `docs/permissions.md` exige que l'appartenance soit vérifiée « pour chaque action ». Un cache d'autorisation survit à sa propre révocation pendant sa durée de vie, c'est-à-dire précisément pendant la fenêtre que la révocation existe pour fermer. Suspendre une adhésion est une mesure de réponse à incident au même titre que suspendre un compte ; une mesure qui prend effet « dans une minute » n'est pas une mesure.

Raison complémentaire : ce qu'il faudrait cacher n'est pas un fait, c'est une relation. La réponse dépend du couple utilisateur et organisation, de l'action demandée, du statut de l'organisation et de l'instant. Le jeu de démonstration en donne l'illustration littérale : le même compte y administre une organisation encore en attente de validation et conduit pour une organisation validée (`supabase/seed/003_organization-members.sql`). Un cache par utilisateur répondrait « autorisé » ou « refusé » pour quelqu'un qui est les deux à la fois selon l'organisation visée. Une clé de cache correcte serait aussi précise que la requête elle-même, et son calcul aussi coûteux que la lecture qu'elle prétend éviter.

Coût assumé : une lecture supplémentaire par requête authentifiée touchant une organisation, servie par un index et exécutée sur une connexion déjà ouverte par le pool applicatif. Deux index la couvrent selon le sens de la question : celui de la clé primaire, `(organization_id, user_id)`, pour « quel rôle cette personne a-t-elle ici ? », et `idx_organization_members_user_status`, sur `(user_id, status)`, pour « à quelles organisations appartient-elle ? ». Un index B-tree ne se parcourant pas par sa seconde colonne, le second n'est pas un doublon du premier : c'est la lecture faite à chaque requête authentifiée, précisément parce que le rôle ne se cache pas. C'est le même ordre de grandeur que la lecture de session déjà consentie par ADR-017, et le même raisonnement : à l'échelle d'un monolithe modulaire avec une seule base, l'argument de performance ne pèse pas contre l'argument de sécurité. Si cette lecture devenait un jour un problème mesuré — et non supposé — la réponse serait de la joindre à la lecture de session en une seule requête, pas de la mettre en cache.

Conséquence : la liste des conditions de validité d'une session s'allonge d'une cinquième, annoncée comme point ouvert par `supabase/README.md`. Une adhésion suspendue, échue par `valid_until`, ou rattachée à une organisation qui n'est plus `ACTIVE`, ne donne aucun droit dans cette organisation. Le point ouvert « l'adhésion suspendue ne coupe pas encore l'accès » est donc refermé pour les routes d'organisation. Il reste ouvert partout où aucune organisation n'est en jeu, et c'est volontaire : la suspension d'une adhésion ne ferme pas un compte, elle ferme un périmètre.

Conséquence : le rôle n'apparaît dans aucun jeton, aucun cookie, aucun corps de requête. Un rôle transporté par le client est une donnée client, et ADR-016 a déjà tranché ce qu'il faut en penser. Il figure en revanche dans la réponse de lecture d'une organisation, à l'usage de l'interface pour n'afficher que les actions possibles : un affichage n'est jamais un contrôle, et la vérification serveur a lieu de toute façon.

Conséquence : `actor_organization_id` du journal d'audit peut enfin être renseigné. La colonne existe depuis `0006_audit-logs.sql` et restait nulle au lot 1 faute d'appartenance ; sans elle, un administrateur d'organisation ne verrait jamais les lignes de son organisation (`docs/permissions.md`, « Consulter l'audit »).

## ADR-022 — La fonction d'administrateur plateforme exige une organisation porteuse `ACTIVE`

Décision : `hasPlatformAdminRole` ne reconnaît la fonction d'administrateur plateforme que si l'adhésion `PLATFORM_ADMIN` est effective **et** si l'organisation qui la porte est `ACTIVE`. C'est la seule lecture d'autorisation du produit qui joigne `organizations` pour décider d'un rôle.

Raison : tant que `PLATFORM_ADMIN` reste un rôle d'adhésion — le point ouvert hérité de `docs/permissions.md`, que ce lot n'arbitre pas —, la fonction est nécessairement accordée par une organisation. Sans cette condition, suspendre une organisation ne retirerait pas les pouvoirs de plateforme qu'elle a accordés : la fiche serait coupée, ses administrateurs plateforme continueraient de lire et de modifier toutes les autres. Or la suspension d'une organisation est une mesure de réponse à incident au même titre que la suspension d'un compte (`docs/security.md`, « Réponse »), et le rôle qu'elle laisserait intact est le plus puissant du produit. `0014_organization-enums.sql` l'écrit sans réserve : « Aucune adhésion à une organisation suspendue ne doit ouvrir d'accès. »

Raison complémentaire : ADR-021 pose deux gardes, l'une sur la personne, l'autre sur l'organisation visée par l'action. Cette seconde garde n'a pas de prise ici, puisque la fonction d'administrateur plateforme sert justement à atteindre d'autres organisations que la sienne : il n'y a pas d'organisation visée à contrôler. Le contrôle de l'organisation porteuse est ce qui rétablit la symétrie, et c'est le seul cas où les deux gardes ne peuvent pas être séparées.

Conséquence : la règle des trois conditions d'effectivité d'une adhésion reste inchangée pour tous les autres rôles ; elle qualifie l'adhésion, et l'état de l'organisation demeure vérifié séparément par `assertOrganizationActive`. La condition ajoutée ici ne s'applique qu'à la reconnaissance de la fonction de plateforme.

Conséquence : suspendre une organisation devient un acte à portée plus large qu'il n'y paraît, et l'exploitation doit le savoir. Suspendre la seule organisation qui porte des adhésions `PLATFORM_ADMIN` retirerait la fonction à tous ses titulaires en même temps, sans qu'aucun message ne l'annonce. Le risque est celui d'une exclusion générale de l'administration ; il est accepté parce que l'inverse — une organisation suspendue qui continue de gouverner la plateforme — est une élévation de privilèges persistante, et parce que la manœuvre se défait en repassant l'organisation porteuse à `ACTIVE`. Aucune route ne le permet à ce lot : la remise en état est une opération de base, à documenter dans `docs/operations.md` le jour où la suspension d'une organisation sera exposée.

Conséquence : l'arbitrage de la portée de `PLATFORM_ADMIN` reste ouvert et cette décision ne le préempte pas. Le jour où la fonction cessera d'être une adhésion pour devenir un attribut de compte, la condition disparaîtra d'elle-même faute d'organisation porteuse, et cette entrée devra être révisée plutôt que recopiée.

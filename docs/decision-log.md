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

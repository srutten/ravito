# Écrans et états UI

## 1. Accueil public

- Présentation du service.
- Avertissement : ne pas utiliser pour signaler un incendie.
- Bouton de connexion.
- Accès aux conditions d'utilisation.

## 2. Connexion

- Courriel ou téléphone.
- Code à usage unique ou fournisseur d'identité.
- MFA pour les rôles sensibles.
- Gestion des erreurs et blocage temporaire.

### Note d'arbitrage US-010

La maquette `docs/design/maquette-accueil-connexion-mobile.png` fusionne l'écran 1 et l'écran 2 en
une seule page mobile : la carte de connexion est posée sur l'accueil public, l'avertissement
« ne pas utiliser cette application pour signaler un incendie » et le lien vers les conditions
d'utilisation restant visibles sous la carte. Cette fusion est retenue. Elle raccourcit le parcours
sans faire disparaître l'avertissement de sécurité, qui demeure sur le premier écran vu.

La maquette fait foi pour la forme : carte blanche centrée à grands rayons, champs hauts à icône à
gauche, boutons pleine largeur, encart informatif bleu pâle pour le second facteur, bandeau
d'avertissement rouge en pied de page. Les jetons et les composants existent depuis US-001.

Trois écarts sont arbitrés, au titre de la règle de résolution de conflit de `CLAUDE.md`, qui
classe les maquettes après la sécurité des personnes, les permissions et les critères
d'acceptation.

1. Les onglets « Contributeur », « Coordinateur » et « Administration » sont supprimés. Un onglet
   qui réagirait différemment selon l'identifiant permettrait d'énumérer les comptes sensibles ;
   un onglet sans effet serait une interface qui ment. Le rôle vient du compte et la destination
   après connexion est calculée par le serveur (ADR-016).
2. Le champ « Mot de passe », son œil de révélation, la case « Se souvenir de moi », le lien
   « Mot de passe oublié ? » et le bouton primaire « Se connecter » sont supprimés. Il ne reste
   qu'un identifiant et un bouton primaire pleine largeur portant l'action « Recevoir un code ».
   L'écran devient une séquence en deux temps : saisie de l'identifiant, puis saisie du code reçu
   (ADR-015). Le style primaire de la maquette est transféré à ce bouton, qui devient l'action
   unique.
3. Le lien « Créer un compte » est conditionné au flag `ENABLE_PUBLIC_REGISTRATION`, dont la valeur
   par défaut est fausse (`docs/feature-flags.md`). Il est donc absent en l'état, avec la phrase
   « Nouveau sur Appui Feux ? » qui le porte.

L'encart du second facteur est conservé tel quel : il annonce une exigence à venir, il ne promet
pas un parcours. Le second facteur lui-même est livré par US-011 ; aucun écran de MFA n'existe au
terme de US-010, et la réponse d'ouverture de session ne demande jamais d'étape supplémentaire.

Écart supplémentaire relevé, hors des trois arbitrages ci-dessus : le bandeau « Temps réel
connecté » de la maquette affirme un état qu'aucun code ne mesure. `ENABLE_REALTIME` vaut faux par
défaut et le temps réel n'est livré par aucune story du lot 1. Un indicateur qui affiche
« connecté » sans rien observer est un état d'interface faux, il est donc écarté. L'emplacement
reste disponible pour l'indicateur de connexion réseau demandé par
`docs/functional-specification.md`, qui se fonde, lui, sur l'état réel du navigateur.

Ce que l'écran 2 ne livre pas au terme de US-010, et qu'il ne doit donc pas laisser espérer :

- le canal SMS. `ENABLE_SMS` vaut faux et le canal n'est pas écrit ; un identifiant de type
  téléphone est refusé par un message de champ explicite plutôt qu'accepté sans suite ;
- le fournisseur d'identité tiers cité plus haut dans cette section ;
- le second facteur, livré par US-011 ;
- les tableaux de bord par rôle. La connexion mène à une page d'attente sobre, qui indique l'état
  réel du compte sans le travestir en tableau de bord vide.

Le blocage temporaire attendu par cette section est rendu par le code d'erreur `RATE_LIMITED` du
contrat API, avec le même seuil pour un identifiant connu et pour un identifiant inconnu.

## 3. Tableau de bord contributeur

- Ressources disponibles.
- Propositions en attente.
- Missions actives.
- Notifications.
- Bouton de déclaration d'une ressource.

## 4. Fiche ressource

- Informations techniques.
- Documents.
- Disponibilité.
- Historique.
- État.
- Actions autorisées.

## 5. Tableau de bord coordinateur

- Demandes actives.
- Couverture.
- Ressources proposées.
- Missions en transit.
- Incidents.
- Carte simplifiée.

## 6. Création d'une demande

Étapes courtes :

1. besoin ;
2. quantité et contraintes ;
3. point de rassemblement ;
4. priorité et délai ;
5. vérification ;
6. publication.

## 7. Comparaison des propositions

Afficher :

- compatibilité ;
- délai ;
- capacité ;
- documents ;
- opérateur ;
- distance approximative ;
- risques ou incompatibilités ;
- bouton d'affectation.

## 8. Mission contributeur

- statut très visible ;
- prochaine action ;
- point de rendez-vous ;
- contact ;
- consignes ;
- bouton d'appel ;
- mode hors ligne ;
- déclaration d'incident.

## 9. Mission coordinateur

- chronologie ;
- ressource ;
- contributeur ;
- point de rassemblement ;
- événements ;
- incidents ;
- actions de transition ;
- audit lié.

## 10. Administration

- organisations en attente ;
- comptes suspendus ;
- documents expirés ;
- alertes ;
- configuration ;
- mode lecture seule.

### File « organisations en attente » (US-012)

Premier élément de cet écran, et le seul livré par le lot organisations. La file liste les
organisations dont `verificationStatus` vaut `PENDING`, servie par
`GET /api/v1/admin/organizations/pending` (`docs/api-contract.md`) et réservée au rôle
`PLATFORM_ADMIN`.

Ordre de service : de la plus ancienne à la plus récente. Une file de validation triée par nouveauté
laisse au fond celles que personne n'a traitées, c'est-à-dire précisément celles qui attendent
depuis le plus longtemps. Chaque ligne affiche donc l'ancienneté en toutes lettres — « en attente
depuis 3 jours » — et non par une pastille de couleur : la section « Accessibilité » de ce document
interdit qu'une information soit portée par la seule couleur, et un délai d'attente est une
information, pas une décoration.

Chaque ligne porte ce sur quoi la décision se fonde, et rien de plus :

- le nom déclaré ;
- le type de structure ;
- le numéro d'immatriculation, tel qu'il a été saisi, séparateurs compris : c'est sous cette forme
  qu'il se compare à un registre public ;
- le code territorial, ou la mention « aucun périmètre déclaré » lorsqu'il est absent, l'absence
  étant une information et non une case vide ;
- la date de dépôt et l'ancienneté ;
- le nom d'affichage du demandeur.

Ni courriel, ni téléphone, ni pièce jointe. Vérifier un numéro d'immatriculation ne suppose pas de
joindre le demandeur, et `docs/privacy-rgpd.md` vaut pour un écran d'administration comme pour les
autres. Le compteur affiché à côté du titre est le nombre réel d'organisations en attente, sans
plafonnement : un compteur qui s'arrête à « 99+ » cache exactement la situation qu'il devrait
signaler.

La file ne se rafraîchit pas d'elle-même. `ENABLE_REALTIME` vaut faux et aucun canal temps réel
n'est livré ; l'écran affiche l'heure du dernier chargement et propose un rafraîchissement manuel,
plutôt qu'un indicateur de fraîcheur qu'aucun code ne mesure. C'est la règle déjà appliquée au
bandeau « Temps réel connecté » de l'écran 2.

États de la file, déclinaison des états transverses :

- chargement : silhouettes de trois lignes, sans compteur, le nombre n'étant pas encore connu ;
- vide : « Aucune organisation en attente. » C'est un état normal et il se dit comme tel, sans
  illustration d'erreur ;
- erreur : message de reprise et action « Réessayer », la file restant vide plutôt qu'affichée à
  moitié ;
- permission refusée : l'écran entier est refusé, pas seulement la file. Masquer la file en laissant
  l'écran ouvert poserait la question de ce que l'appelant peut encore y faire ;
- réseau indisponible : la dernière liste chargée reste affichée, marquée comme datée, sans action
  possible ;
- données obsolètes : une organisation validée ou modifiée entre-temps par un autre administrateur
  est signalée au rafraîchissement suivant, jamais retirée en silence ;
- action en cours et action réussie : sans objet dans ce lot, la file n'offrant encore aucune
  action.

Ce que la file ne livre pas ici : le bouton de validation, le refus motivé et la notification
associée relèvent d'US-013. Elle affiche donc ce qui attend sans encore permettre de le traiter.
C'est préférable à l'inverse : rendre visible une attente que personne ne peut encore lever vaut
mieux que la laisser invisible.

## 11. Création d'une organisation

Formulaire ouvert à tout compte authentifié, servi par `POST /api/v1/organizations`. Une seule
colonne, mobile d'abord, sans assistant : quatre champs n'en justifient pas un.

Champs :

- nom de la structure — obligatoire, 2 à 160 caractères ;
- type — liste fermée de cinq valeurs, sans valeur présélectionnée. Un choix par défaut ferait
  classer par inadvertance des structures dans la première catégorie de la liste. Les libellés
  affichés disent l'étendue réelle de chaque valeur — « service opérationnel » couvre un service
  d'incendie comme un service technique — plutôt que de reprendre le cas le plus fréquent ;
- numéro d'immatriculation — obligatoire, 4 à 64 caractères. Le champ explique en une phrase
  pourquoi il l'est : c'est ce que l'administrateur confronte à un registre public au moment de
  valider. Les séparateurs saisis sont conservés à l'affichage, un numéro se relisant par groupes ;
- code territorial — facultatif, format annoncé sous le champ avant la saisie et non après l'erreur,
  avec la mention qu'une organisation sans périmètre territorial le laisse vide.

Ce que le formulaire ne demande pas, et ne doit jamais demander : le rôle du créateur, qui devient
administrateur de l'organisation par construction ; l'état de validation, posé par le serveur ; une
pièce justificative, le dépôt de documents n'étant pas livré par ce lot. C'est le principe d'ADR-016
appliqué au-delà de la connexion — ce que le client déclare ne fonde jamais un droit.

L'identifiant d'idempotence est tiré au premier affichage du formulaire, une fois, et conservé tant
que la saisie dure. Un second appui sur le bouton, une reprise après coupure ou un rejeu de la file
locale portent donc la même clé et ne créent qu'une organisation. Une erreur de validation conserve
la clé, l'intention étant la même ; une création réussie en tire une nouvelle, sans quoi la personne
ne pourrait pas créer une deuxième organisation.

Après création, l'écran ne promet rien qu'il ne tienne. Il annonce l'état réel — « organisation
créée, en attente de validation » — puis distingue ce qui est déjà possible de ce qui ne l'est pas
encore : compléter la fiche oui, publier une demande non, tant que la validation n'a pas eu lieu
(`ORGANIZATION_NOT_VERIFIED`). Aucun délai de traitement n'est affiché : aucune règle du produit
n'en garantit un, et un délai annoncé puis dépassé est pire qu'une absence de délai.

États, déclinaison des états transverses :

- action en cours : bouton désactivé et libellé changé, pour que le double appui soit impossible
  avant même que l'idempotence ait à jouer ;
- erreur de champ : message rattaché au champ concerné, en texte, jamais par la seule couleur ;
- numéro d'immatriculation déjà utilisé : le message dit que le numéro est refusé, sans nommer la
  structure qui le détient ;
- permission refusée : sans session valide, le formulaire n'est pas rendu et l'écran de connexion
  prend la main ;
- lecture seule : lorsque `PLATFORM_READ_ONLY` est actif, la soumission est refusée côté serveur ;
  l'écran affiche ce refus tel quel plutôt qu'un échec générique ;
- réseau indisponible : la saisie est conservée et la soumission différée, sans perte de la clé
  d'idempotence ;
- action réussie : redirection vers la fiche de l'organisation créée, jamais vers un tableau de bord
  vide.

Le conflit de version ne s'applique pas à cet écran : il n'y a pas encore d'objet à écraser. Il
apparaît sur la modification de la fiche, qui exige la version attendue et affiche l'état réel
lorsqu'un autre administrateur est passé avant.

## États transverses

Chaque écran doit avoir :

- chargement ;
- vide ;
- erreur ;
- permission refusée ;
- réseau indisponible ;
- données obsolètes ;
- conflit de version ;
- action en cours ;
- action réussie.

## Accessibilité

- Navigation clavier.
- Contrastes suffisants.
- Libellés explicites.
- Pas d'information uniquement portée par la couleur.
- Taille minimale des cibles tactiles.
- Messages d'erreur associés aux champs.
- Compatibilité lecteur d'écran pour les actions critiques.

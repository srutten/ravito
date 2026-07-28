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

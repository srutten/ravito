# Backlog — Epics et user stories

## EPIC 1 — Fondation

### US-001 Initialiser le projet

En tant que développeur, je veux un projet TypeScript strict afin de disposer d'une base fiable.

Critères :

- application démarre ;
- lint ;
- typecheck ;
- tests ;
- build ;
- variables documentées.

Priorité : P0.

### US-002 Configurer la base

Critères :

- PostgreSQL ;
- PostGIS ;
- migrations ;
- seed ;
- reset local.

Priorité : P0.

### US-003 Mettre en place la CI

Critères :

- lint ;
- typecheck ;
- tests ;
- build ;
- scan de secrets ;
- artefacts.

Priorité : P0.

## EPIC 2 — Identité et organisations

### US-010 Authentification

En tant qu'utilisateur, je veux me connecter de façon sécurisée.

Critères :

- connexion ;
- déconnexion ;
- session ;
- erreurs ;
- protection des routes.

### US-011 MFA rôles sensibles

Critères :

- coordinateur ;
- admin ;
- récupération ;
- audit.

### US-012 Créer une organisation

Critères :

- type ;
- identité ;
- statut en attente ;
- admin initial.

### US-013 Valider une organisation

Critères :

- réservé admin plateforme ;
- commentaire ;
- audit ;
- notification.

### US-014 Gérer les membres

Critères :

- invitation ;
- rôle ;
- suspension ;
- expiration.

## EPIC 3 — Ressources

### US-020 Créer une ressource

Critères :

- catégorie ;
- caractéristiques ;
- localisation approximative ;
- validation.

### US-021 Gérer la disponibilité

Critères :

- disponible ;
- indisponible ;
- maintenance ;
- historique.

### US-022 Ajouter des documents

Critères :

- upload privé ;
- expiration ;
- statut de validation ;
- URL temporaire.

### US-023 Lister et filtrer

Critères :

- catégorie ;
- statut ;
- distance approximative ;
- pagination.

### US-024 Empêcher la modification en mission

Critères :

- champs verrouillés ;
- message explicite ;
- test.

## EPIC 4 — Demandes

### US-030 Créer un brouillon

### US-031 Ajouter des exigences

### US-032 Sélectionner un point de rassemblement

### US-033 Publier une demande

Critères :

- organisation validée ;
- exigences ;
- point ;
- audit ;
- notification.

### US-034 Annuler une demande

Critères :

- transition autorisée ;
- motif ;
- propagation aux propositions ;
- audit.

## EPIC 5 — Propositions

### US-040 Voir les demandes compatibles

### US-041 Soumettre une proposition

### US-042 Retirer une proposition

### US-043 Comparer les propositions

### US-044 Expirer une proposition

## EPIC 6 — Affectation et missions

### US-050 Accepter une proposition

Critères :

- transaction ;
- ressource réservée ;
- mission créée ;
- autres offres traitées ;
- audit ;
- notification ;
- anti-double affectation.

### US-051 Consulter une mission

### US-052 Confirmer l'acceptation

### US-053 Confirmer le départ

### US-054 Confirmer l'arrivée

### US-055 Confirmer la remise

### US-056 Clôturer la mission

### US-057 Annuler une mission

### US-058 Gérer un conflit de version

## EPIC 7 — Incidents

### US-060 Déclarer un incident

### US-061 Qualifier la gravité

### US-062 Résoudre un incident

### US-063 Notifier les responsables

## EPIC 8 — Notifications

### US-070 Notification web

### US-071 Courriel

### US-072 SMS critique

### US-073 Acquittement

### US-074 Déduplication

### US-075 Gestion des échecs

## EPIC 9 — Cartographie

### US-080 Afficher les positions approximatives

### US-081 Afficher un point exact après affectation

### US-082 Filtrer par rayon

### US-083 Masquer toutes les positions

## EPIC 10 — Audit et administration

### US-090 Journaliser les actions

### US-091 Consulter les audits

### US-092 Suspendre un compte

### US-093 Révoquer les sessions

### US-094 Lecture seule

### US-095 Désactiver les nouvelles missions

## EPIC 11 — Mode dégradé

### US-100 Installer la PWA

### US-101 Mettre en cache une mission

### US-102 Mettre une transition en file

### US-103 Synchroniser

### US-104 Résoudre un conflit

## EPIC 12 — Exploitation

### US-110 Observabilité

### US-111 Sauvegardes

### US-112 Restauration

### US-113 Runbooks

### US-114 Smoke tests

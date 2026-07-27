# Mode dégradé et hors connexion

## Objectif MVP

Permettre à un contributeur déjà affecté de consulter sa mission et d'enregistrer quelques actions lorsque le réseau est temporairement indisponible.

## Données conservées localement

- identifiant de mission ;
- statut connu ;
- point de rassemblement ;
- consignes ;
- contact ;
- heure de dernière synchronisation ;
- transitions locales en attente.

## Actions autorisées hors ligne

- consulter la mission active ;
- consulter le point de rendez-vous ;
- appeler le contact ;
- préparer une confirmation de départ ;
- préparer une confirmation d'arrivée ;
- préparer un signalement d'incident.

## Actions interdites hors ligne

- nouvelle affectation ;
- modification du point de rassemblement ;
- changement de rôle ;
- validation d'une organisation ;
- consultation de nouvelles ressources sensibles ;
- annulation globale.

## File locale

Chaque action contient :

- `clientEventId`
- `missionId`
- `transition`
- `expectedVersion`
- `createdAt`
- `payload`
- `syncStatus`

## Synchronisation

1. vérifier la session ;
2. envoyer dans l'ordre ;
3. traiter l'idempotence ;
4. résoudre les conflits ;
5. afficher la confirmation serveur ;
6. conserver une trace locale minimale.

## Conflits

En cas de version différente :

- ne pas écraser ;
- récupérer l'état serveur ;
- expliquer le conflit ;
- demander une nouvelle action ;
- conserver l'événement local comme non appliqué.

## Sécurité locale

- stockage limité ;
- expiration ;
- chiffrement si possible ;
- suppression à la déconnexion ;
- aucune copie de document ;
- aucun audit complet.

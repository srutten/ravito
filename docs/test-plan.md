# Plan de test

## Niveaux

### Unitaires

- machines à états ;
- score de compatibilité ;
- autorisations ;
- validation ;
- masquage ;
- expiration ;
- idempotence.

### Intégration

- repositories ;
- transactions ;
- contraintes ;
- outbox ;
- audit ;
- stockage ;
- permissions SQL.

### End-to-end

- publier un besoin ;
- proposer une ressource ;
- affecter ;
- confirmer le départ ;
- confirmer l'arrivée ;
- clôturer ;
- déclarer un incident ;
- suspendre un utilisateur.

## Scénarios critiques

### Double affectation

Deux requêtes simultanées tentent d'accepter la même ressource. Une seule réussit.

### Rejeu

Le même `clientEventId` est envoyé deux fois. Le second appel renvoie le résultat existant ou une réponse idempotente.

### Accès inter-organisations

Un coordinateur ne peut pas lire une mission hors de son périmètre.

### Position

Un utilisateur non affecté ne reçoit jamais la position exacte.

### Document expiré

Une ressource dont le document obligatoire est expiré ne peut pas être affectée.

### Réseau

Une transition locale est synchronisée une seule fois.

### Lecture seule

Les mutations sont refusées avec un code explicite.

## Tests sécurité

- injection ;
- élévation de privilèges ;
- upload ;
- rate limiting ;
- CSRF ;
- XSS ;
- URL signée ;
- session révoquée ;
- données dans les logs.

## Données de test

Utiliser des données fictives. Aucun document ni contact réel.

## Critères CI

La CI échoue si :

- lint ;
- typecheck ;
- tests ;
- build ;
- migration ;
- scan de secret ;
- scan de dépendances ;
- test e2e critique échoue.

## Tests manuels avant pilote

- Android récent ;
- iPhone récent ;
- navigateur desktop ;
- réseau lent ;
- coupure réseau ;
- faible luminosité ;
- utilisateur stressé ;
- lecture écran ;
- exercice simulé.

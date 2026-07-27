# Machines à états

## Demande opérationnelle

### États

- `DRAFT`
- `PENDING_VALIDATION`
- `PUBLISHED`
- `PARTIALLY_COVERED`
- `COVERED`
- `IN_PROGRESS`
- `SUSPENDED`
- `CLOSED`
- `CANCELLED`

### Transitions principales

```text
DRAFT → PENDING_VALIDATION
PENDING_VALIDATION → PUBLISHED
PENDING_VALIDATION → DRAFT
PUBLISHED → PARTIALLY_COVERED
PUBLISHED → COVERED
PARTIALLY_COVERED → COVERED
COVERED → IN_PROGRESS
IN_PROGRESS → CLOSED
PUBLISHED → CANCELLED
PARTIALLY_COVERED → CANCELLED
COVERED → CANCELLED
* → SUSPENDED
SUSPENDED → état précédent validé
```

## Ressource

### États

- `UNAVAILABLE`
- `AVAILABLE`
- `PROPOSED`
- `RESERVED`
- `IN_TRANSIT`
- `ON_SITE`
- `ENGAGED`
- `RETURNING`
- `RETURNED`
- `MAINTENANCE`
- `SUSPENDED`

### Règle critique

Une ressource ne peut posséder qu'une mission non terminale à la fois.

## Proposition

### États

- `DRAFT`
- `SUBMITTED`
- `WITHDRAWN`
- `ACCEPTED`
- `REJECTED`
- `EXPIRED`

### Transitions

```text
DRAFT → SUBMITTED
SUBMITTED → WITHDRAWN
SUBMITTED → ACCEPTED
SUBMITTED → REJECTED
SUBMITTED → EXPIRED
```

L'acceptation d'une proposition rejette ou expire les propositions incompatibles selon la politique choisie.

## Mission

### États

- `PROPOSED`
- `ACCEPTED`
- `VALIDATED`
- `DEPARTURE_CONFIRMED`
- `IN_TRANSIT`
- `ARRIVED`
- `HANDED_OVER`
- `ACTIVE`
- `RETURNING`
- `COMPLETED`
- `CANCELLED`
- `INCIDENT`

### Parcours nominal

```text
PROPOSED
→ ACCEPTED
→ VALIDATED
→ DEPARTURE_CONFIRMED
→ IN_TRANSIT
→ ARRIVED
→ HANDED_OVER
→ ACTIVE
→ RETURNING
→ COMPLETED
```

### Transitions exceptionnelles

```text
PROPOSED → CANCELLED
ACCEPTED → CANCELLED
VALIDATED → CANCELLED
DEPARTURE_CONFIRMED → INCIDENT
IN_TRANSIT → INCIDENT
ARRIVED → INCIDENT
HANDED_OVER → INCIDENT
ACTIVE → INCIDENT
RETURNING → INCIDENT
INCIDENT → RETURNING
INCIDENT → COMPLETED
INCIDENT → CANCELLED
```

## Règles de transition

Chaque transition vérifie :

- l'état source ;
- le rôle ;
- le propriétaire ou l'organisation ;
- les préconditions ;
- la présence d'un `clientEventId` ;
- la version de l'entité ;
- l'absence de conflit ;
- le contenu minimal du commentaire ;
- la production de l'audit.

## Concurrence

Utiliser une combinaison de :

- transaction SQL ;
- verrouillage de ligne ;
- contrainte unique partielle ;
- version optimiste ;
- idempotence.

## Événements

Chaque transition produit un événement immuable :

```text
MISSION_VALIDATED
MISSION_DEPARTURE_CONFIRMED
MISSION_ARRIVED
MISSION_HANDED_OVER
MISSION_COMPLETED
MISSION_CANCELLED
MISSION_INCIDENT_REPORTED
```

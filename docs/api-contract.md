# Contrat API

## Principes

- API JSON versionnée sous `/api/v1`.
- Authentification obligatoire sauf routes publiques explicites.
- Validation stricte.
- Erreurs normalisées.
- Idempotence pour les mutations critiques.
- Pagination par curseur.
- Horodatages ISO 8601 UTC.
- Pas de données sensibles dans les messages d'erreur.

## Format d'erreur

```json
{
  "error": {
    "code": "RESOURCE_ALREADY_ASSIGNED",
    "message": "La ressource n'est plus disponible.",
    "requestId": "req_123",
    "details": {}
  }
}
```

## Ressources

### Créer une ressource

```http
POST /api/v1/resources
```

```json
{
  "categoryId": "uuid",
  "name": "Citerne 12 m3",
  "description": "Citerne agricole tractée",
  "capacity": 12,
  "capacityUnit": "M3",
  "requiresOperator": true,
  "mobilizationRadiusKm": 50
}
```

### Lister les ressources

```http
GET /api/v1/resources?status=AVAILABLE&categoryId=uuid&cursor=...
```

### Modifier une ressource

```http
PATCH /api/v1/resources/{resourceId}
```

## Demandes

### Créer

```http
POST /api/v1/requests
```

### Publier

```http
POST /api/v1/requests/{requestId}/commands/publish
```

```json
{
  "clientEventId": "uuid",
  "expectedVersion": 3
}
```

### Lister

```http
GET /api/v1/requests?status=PUBLISHED&territoryCode=...
```

## Propositions

### Soumettre

```http
POST /api/v1/requests/{requestId}/offers
```

```json
{
  "resourceId": "uuid",
  "estimatedArrivalAt": "2026-07-27T15:30:00Z",
  "operatorIncluded": true,
  "comment": "Disponible immédiatement",
  "clientEventId": "uuid"
}
```

### Retirer

```http
POST /api/v1/offers/{offerId}/commands/withdraw
```

## Missions

### Affecter

```http
POST /api/v1/offers/{offerId}/commands/accept
```

```json
{
  "clientEventId": "uuid",
  "expectedOfferVersion": 2,
  "expectedResourceVersion": 5,
  "meetingPointId": "uuid"
}
```

### Transition

```http
POST /api/v1/missions/{missionId}/transitions
```

```json
{
  "transition": "CONFIRM_DEPARTURE",
  "clientEventId": "uuid",
  "expectedVersion": 4,
  "comment": "Départ confirmé"
}
```

### Lire une mission

```http
GET /api/v1/missions/{missionId}
```

La réponse dépend du rôle et de la relation avec la mission.

## Incidents

```http
POST /api/v1/missions/{missionId}/incidents
```

```json
{
  "type": "VEHICLE_BREAKDOWN",
  "severity": "HIGH",
  "description": "Immobilisation sur l'axe prévu",
  "clientEventId": "uuid"
}
```

## Notifications

```http
GET /api/v1/notifications
POST /api/v1/notifications/{notificationId}/acknowledge
```

## Administration

```http
GET  /api/v1/admin/organizations/pending
POST /api/v1/admin/organizations/{organizationId}/commands/verify
POST /api/v1/admin/users/{userId}/commands/suspend
POST /api/v1/admin/platform/commands/enable-read-only
```

## Codes d'erreur principaux

- `UNAUTHENTICATED`
- `FORBIDDEN`
- `ORGANIZATION_NOT_VERIFIED`
- `INVALID_TRANSITION`
- `VERSION_CONFLICT`
- `IDEMPOTENCY_CONFLICT`
- `RESOURCE_UNAVAILABLE`
- `RESOURCE_ALREADY_ASSIGNED`
- `DOCUMENT_EXPIRED`
- `MEETING_POINT_REQUIRED`
- `REQUEST_EXPIRED`
- `RATE_LIMITED`
- `PLATFORM_READ_ONLY`

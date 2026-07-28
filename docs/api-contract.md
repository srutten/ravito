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

## Authentification

Cinq routes couvrent US-010. Elles appliquent ADR-015 (code à usage unique, aucun mot de passe),
ADR-016 (aucun rôle déclaré par le client) et ADR-017 (session opaque côté serveur).

| Route | Méthode | Accès | Objet |
|---|---|---|---|
| `/api/v1/auth/codes` | POST | publique | demander un code à usage unique |
| `/api/v1/auth/sessions` | POST | publique | échanger un code contre une session |
| `/api/v1/auth/sessions/current` | GET | session requise | lire la session courante |
| `/api/v1/auth/sessions/current` | DELETE | session requise | se déconnecter |
| `/api/v1/auth/sessions/commands/revoke-all` | POST | session requise | révoquer toutes ses sessions |

### Règles communes

- Aucune de ces routes n'accepte de mot de passe, ni en entrée, ni en option.
- Aucun rôle, aucun identifiant d'organisation n'est accepté en entrée. Le rôle est résolu côté
  serveur à partir du compte.
- La session est portée par un cookie `HttpOnly`. Aucun jeton n'apparaît dans un corps de réponse
  ni n'est lisible par le JavaScript de la page.
- Les réponses ne sont jamais mises en cache.
- Les corps de requête sont en `application/json`. Toute méthode non sûre exige une origine
  reconnue, en complément de `SameSite`.
- Ces routes ne sont pas soumises à `PLATFORM_READ_ONLY`. Le mode lecture seule existe pour
  protéger la plateforme pendant un incident ; interdire la connexion à ce moment-là empêcherait
  les coordinateurs de consulter les missions en cours, ce qui aggraverait l'incident au lieu de
  le contenir.

### Neutralité des réponses

Critère 7 de US-010. Un code inexistant, expiré, déjà consommé ou erroné produit une réponse
strictement identique : même code `AUTHENTICATION_FAILED`, même message, même statut `401`, même
`details` vide. Le serveur exécute le même travail dans les quatre cas, y compris lorsqu'il sait
déjà que la tentative échouera : l'empreinte du code fourni est toujours calculée et les mêmes
accès à la base sont toujours effectués, afin que la durée de réponse ne trahisse rien.

De la même façon, `POST /api/v1/auth/codes` répond `202` avec un corps de même forme, que
l'identifiant corresponde ou non à un compte. Un défi est créé dans les deux cas, avec la même
durée de vie et le même compteur de tentatives. Seul l'envoi diffère, et il est asynchrone, donc
invisible dans la réponse.

La limitation de tentatives est appliquée à l'identifiant normalisé et à l'adresse d'appel, avec
les mêmes seuils pour un identifiant connu et pour un identifiant inconnu. Un compteur qui ne
s'appliquerait qu'aux comptes existants serait lui-même un oracle d'énumération.

Conséquence de test : les quatre cas d'échec sont comparés champ à champ, `requestId` exclu, et la
neutralité de durée se vérifie sur une distribution de mesures, jamais sur une exécution unique.

### Idempotence de ces routes

Le principe général du contrat impose un `clientEventId` sur les mutations critiques.
`POST /api/v1/auth/codes` et `POST /api/v1/auth/sessions` en sont exemptées volontairement. Une clé
d'idempotence suppose de mémoriser la réponse produite et de la rejouer sur présentation de la même
clé ; or la réponse d'une ouverture de session est l'octroi d'une session. Quiconque connaîtrait la
clé obtiendrait un second octroi. La protection contre le rejeu vient d'ailleurs : le code est
consommé une seule fois, par une mise à jour conditionnelle exécutée dans la même transaction que
la création de la session.

### Demander un code à usage unique

```http
POST /api/v1/auth/codes
```

```json
{
  "identifier": "prenom.nom@exemple.fr"
}
```

`identifier` est une adresse de courriel de 254 caractères au maximum, normalisée côté serveur.
Le canal d'envoi est déduit de l'identifiant par le serveur et n'est jamais choisi par le client.
Un numéro de téléphone est refusé par `VALIDATION_ERROR` tant que le canal SMS n'est pas livré :
accepter une saisie dont la plateforme ne fera rien produirait une attente sans fin et sans
explication.

Réponse `202 Accepted` :

```json
{
  "challengeId": "uuid",
  "codeLength": 6,
  "expiresInSeconds": 600,
  "resendAvailableInSeconds": 60
}
```

Les trois valeurs numériques sont des constantes de la plateforme, identiques pour tout appelant.
Elles alimentent le compte à rebours de l'interface sans rien dire du compte visé. `challengeId`
est un identifiant opaque : il ne contient pas l'identifiant saisi et ne permet pas de le déduire.

Erreurs : `VALIDATION_ERROR`, `RATE_LIMITED`.

L'échec d'envoi ne modifie pas la réponse. Il est repris par la file d'envoi et suivi par les
alertes d'exploitation.

### Ouvrir une session

```http
POST /api/v1/auth/sessions
```

```json
{
  "challengeId": "uuid",
  "code": "000000"
}
```

Réponse `201 Created` :

```json
{
  "user": {
    "id": "uuid",
    "displayName": "Camille D.",
    "preferredLanguage": "fr"
  },
  "session": {
    "expiresAt": "2026-07-28T04:30:00Z",
    "absoluteExpiresAt": "2026-08-03T16:30:00Z"
  },
  "nextStep": "READY",
  "redirectPath": "/apres-connexion"
}
```

Le cookie de session est posé par l'en-tête `Set-Cookie` de cette réponse.

`session.expiresAt` est la fin de la fenêtre d'inactivité, `session.absoluteExpiresAt` la fin de vie
maximale, indépendante de l'activité.

`nextStep` vaut `READY` dans US-010. La valeur `MFA_REQUIRED` est réservée à US-011 et n'est jamais
émise par cette version : l'encart de l'écran 2 annonce le second facteur, il ne le fournit pas.

`redirectPath` est calculé par le serveur, jamais choisi par le client (ADR-016). Dans US-010 il
désigne toujours une page d'attente, les tableaux de bord par rôle relevant des lots suivants.
C'est le point d'extension prévu : US-014 y branche la résolution du rôle et de l'appartenance sans
changer le contrat.

La réponse ne porte ni rôle, ni organisation. `OrganizationMember` n'existe pas encore ; exposer un
champ vide laisserait croire qu'il est renseigné.

Erreurs :

- `VALIDATION_ERROR` — corps mal formé. La validation ne porte que sur la forme et ne consulte
  jamais l'état stocké : elle ne peut donc pas distinguer un compte d'un autre.
- `AUTHENTICATION_FAILED` — code inexistant, expiré, déjà consommé, erroné, ou défi dont les
  tentatives sont épuisées. Réponse identique dans tous ces cas.
- `FORBIDDEN` — compte suspendu. Cette distinction n'est faite qu'après vérification réussie du
  code, donc après que l'appelant a prouvé qu'il contrôle le canal : elle n'ouvre aucune
  énumération. Un compte suspendu doit savoir qu'il l'est, sans quoi il ne peut pas demander sa
  réactivation.
- `RATE_LIMITED`.

Effets : consommation du défi et création de la session dans une seule transaction, puis écriture
d'audit `USER_SIGNED_IN`. Les tentatives échouées alimentent les métriques et le journal technique,
sans écriture d'audit nominative : un appelant non authentifié ne doit pas pouvoir faire grossir la
table de preuve à volonté. Le blocage d'un compte après tentatives répétées est audité par
`SIGN_IN_BLOCKED`.

### Lire la session courante

```http
GET /api/v1/auth/sessions/current
```

Réponse `200` :

```json
{
  "user": {
    "id": "uuid",
    "displayName": "Camille D.",
    "preferredLanguage": "fr"
  },
  "session": {
    "issuedAt": "2026-07-27T16:30:00Z",
    "expiresAt": "2026-07-28T04:30:00Z",
    "absoluteExpiresAt": "2026-08-03T16:30:00Z"
  }
}
```

Erreurs : `UNAUTHENTICATED` lorsque le cookie est absent, inconnu, expiré ou révoqué. Ces quatre
cas partagent une réponse unique : la validité d'un identifiant de session n'est pas une
information que la plateforme confirme.

### Se déconnecter

```http
DELETE /api/v1/auth/sessions/current
```

Sans corps. Réponse `204 No Content`, y compris lorsque aucune session valide n'est présentée. Une
déconnexion ne doit jamais échouer : répondre `401` laisserait une session vivante sur un poste
partagé au motif que l'appelant n'a pas su prouver qu'elle lui appartenait, soit l'inverse du
service rendu. Le cookie est effacé dans tous les cas.

Effets : la session présentée est marquée révoquée, les autres sessions du compte ne sont pas
touchées. Audit `USER_SIGNED_OUT` lorsqu'une session existait.

### Révoquer toutes ses sessions

```http
POST /api/v1/auth/sessions/commands/revoke-all
```

```json
{
  "clientEventId": "uuid"
}
```

Réponse `200` :

```json
{
  "revokedCount": 3
}
```

La session courante est comprise dans la révocation : l'appelant est déconnecté par sa propre
commande et le cookie est effacé par la réponse. C'est la mise en œuvre côté utilisateur de la
révocation immédiate exigée au critère 11 ; la révocation par un administrateur relève de US-093 et
l'interrupteur global `FORCE_SESSION_REVOCATION` de `docs/feature-flags.md`.

Un rejeu portant le même `clientEventId` renvoie la réponse initiale sans nouvel effet.

Erreurs : `UNAUTHENTICATED`, `VALIDATION_ERROR`, `RATE_LIMITED`.

Effets : révocation et écriture d'audit `USER_SESSIONS_REVOKED` dans une seule transaction, avec le
nombre de sessions concernées.

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
- `AUTHENTICATION_FAILED`
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

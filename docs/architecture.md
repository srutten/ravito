# Architecture technique

## Style

Monolithe modulaire déployable comme une seule application, avec séparation nette entre domaine, application, infrastructure et présentation.

## Composants

### Frontend

- Next.js.
- React.
- TypeScript strict.
- Composants serveur par défaut.
- Composants client uniquement lorsque nécessaire.
- Progressive Web App limitée.
- MapLibre pour la carte.

### Backend

- Routes serveur Next.js ou couche API dédiée dans le même dépôt.
- Services de domaine.
- PostgreSQL.
- PostGIS.
- File de tâches pour notifications.
- Stockage objet.

### Services externes

- fournisseur d'identité ou Supabase Auth ;
- fournisseur SMS ;
- fournisseur courriel ;
- stockage objet ;
- observabilité ;
- cartographie.

## Modules

```text
organizations
identity
resources
requests
offers
missions
incidents
notifications
audit
administration
geospatial
```

Chaque module expose :

- types ;
- commandes ;
- requêtes ;
- politiques ;
- repositories ;
- événements ;
- tests.

## Flux d'affectation

```text
UI
→ Route API
→ Authentification
→ Autorisation
→ Validation
→ Command handler
→ Transaction
→ Domaine
→ Repository
→ Événement
→ Audit
→ Outbox
→ Notification
→ Réponse
```

## Outbox

Utiliser une table d'outbox pour garantir que les notifications sont planifiées après une mutation réussie.

Champs :

- `id`
- `event_type`
- `aggregate_type`
- `aggregate_id`
- `payload`
- `created_at`
- `processed_at`
- `attempt_count`
- `last_error`

## Cache

Ne pas cacher les autorisations critiques.

Le cache peut servir à :

- catégories ;
- configuration publique ;
- tuiles cartographiques ;
- listes non sensibles ;
- session locale de consultation.

## Résilience

- timeouts ;
- retries bornés ;
- circuit breaker pour SMS ;
- file d'échec ;
- idempotence ;
- lecture seule ;
- sauvegardes ;
- procédure manuelle.

## Décisions à éviter dans le MVP

- microservices ;
- Kafka ;
- Kubernetes obligatoire ;
- CQRS complet ;
- event sourcing complet ;
- GraphQL si REST suffit ;
- synchronisation hors ligne bidirectionnelle générale.

## Déploiements

- Preview par pull request.
- Staging.
- Production.
- Migrations exécutées séparément.
- Feature flags.
- Rollback documenté.

# Conception de la base de données

## Technologie

PostgreSQL avec extension PostGIS.

## Conventions

- Identifiants UUID.
- Noms de tables en `snake_case`.
- Horodatages en UTC.
- Colonnes `created_at` et `updated_at`.
- Suppression logique uniquement si nécessaire.
- Contraintes SQL avant validation applicative lorsque possible.
- JSONB réservé aux charges variables, pas aux données relationnelles centrales.

## Index

Prévoir au minimum :

- index géospatial sur les positions approximatives ;
- index sur les statuts ;
- index sur `organization_id` ;
- index sur `resource_id` et `request_id` ;
- index sur les dates d'expiration ;
- index unique sur `client_event_id` ;
- index sur `mission_events(mission_id, occurred_at)` ;
- index sur `audit_logs(target_type, target_id, occurred_at)`.

## Contrainte anti-double affectation

Exemple conceptuel :

```sql
CREATE UNIQUE INDEX one_active_mission_per_resource
ON missions(resource_id)
WHERE status NOT IN ('COMPLETED', 'CANCELLED');
```

## Vues

### `public_resource_view`

Ne contient que :

- catégorie ;
- disponibilité ;
- capacité ;
- zone approximative ;
- niveau de vérification ;
- rayon de mobilisation.

### `coordinator_resource_view`

Ajoute les données nécessaires à l'analyse, sans exposer les documents bruts.

### `assigned_mission_view`

Expose au contributeur affecté :

- point exact ;
- contact ;
- consignes ;
- statut ;
- informations de mission.

## Chiffrement

Les données suivantes doivent être chiffrées au niveau applicatif ou via un service adapté :

- position précise habituelle ;
- documents ;
- téléphone opérationnel sensible ;
- notes d'incident sensibles.

## Migrations

- Une migration par changement cohérent.
- Pas d'édition d'une migration fusionnée.
- Migration testée sur base vide et base existante.
- Prévoir les migrations réversibles lorsque possible.
- Les migrations destructives sont séparées en plusieurs déploiements.

## Seed

Le jeu de données doit créer :

- quatre organisations ;
- six utilisateurs ;
- huit ressources ;
- trois demandes ;
- quatre propositions ;
- trois missions dans des états différents ;
- un incident ;
- plusieurs documents valides et expirés.

## Sauvegardes

- Sauvegarde quotidienne au minimum.
- Rétention définie.
- Chiffrement.
- Test périodique de restauration.
- Procédure documentée dans `operations.md`.

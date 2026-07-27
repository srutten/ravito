# Feature flags et interrupteurs opérationnels

## Flags produit

- `ENABLE_PUBLIC_REGISTRATION`
- `ENABLE_SMS`
- `ENABLE_EMAIL`
- `ENABLE_PUSH_NOTIFICATIONS`
- `ENABLE_REALTIME`
- `ENABLE_OFFLINE_QUEUE`
- `ENABLE_RESOURCE_DOCUMENTS`
- `ENABLE_PRECISE_LOCATION`
- `ENABLE_MATCHING_SCORE`
- `ENABLE_OBSERVER_ROLE`

## Interrupteurs de sécurité

- `PLATFORM_READ_ONLY`
- `DISABLE_NEW_REQUESTS`
- `DISABLE_NEW_MISSIONS`
- `HIDE_PRECISE_LOCATIONS`
- `DISABLE_FILE_UPLOADS`
- `FORCE_SESSION_REVOCATION`

## Règles

- Les flags sensibles sont modifiés uniquement par un admin plateforme.
- Chaque changement est audité.
- Les valeurs sont différentes par environnement.
- Les flags ne remplacent pas les contrôles d'autorisation.
- Les flags critiques doivent être lisibles sans dépendre d'un service externe fragile.

## Interface d'administration

Afficher :

- valeur ;
- description ;
- impact ;
- auteur ;
- date ;
- environnement ;
- confirmation renforcée.

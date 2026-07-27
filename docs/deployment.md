# Déploiement

## Environnements

### Local

- base locale ou projet de développement ;
- courriels interceptés ;
- SMS simulés ;
- stockage fictif ;
- données seed.

### Staging

- configuration proche de la production ;
- données fictives ;
- comptes de test ;
- tests e2e ;
- revue métier.

### Production

- région européenne ;
- sauvegardes ;
- observabilité ;
- MFA ;
- secrets dédiés ;
- accès restreints.

## Pipeline

```text
checkout
→ install
→ lint
→ typecheck
→ unit tests
→ integration tests
→ build
→ migration validation
→ security scans
→ preview
→ e2e
→ approval
→ production migration
→ deploy
→ smoke tests
```

## Variables d'environnement

Documenter sans valeur :

```text
DATABASE_URL
AUTH_SECRET
STORAGE_ENDPOINT
STORAGE_BUCKET
STORAGE_ACCESS_KEY
STORAGE_SECRET_KEY
EMAIL_PROVIDER_KEY
SMS_PROVIDER_KEY
MAP_STYLE_URL
OBSERVABILITY_DSN
FEATURE_FLAGS_SOURCE
```

## Migration production

1. sauvegarde ;
2. vérification ;
3. migration compatible ;
4. déploiement ;
5. smoke test ;
6. surveillance ;
7. rollback si nécessaire.

## Rollback

Prévoir :

- version précédente de l'application ;
- migrations non destructives ;
- flags ;
- lecture seule ;
- procédure documentée ;
- responsable identifié.

## Smoke tests

- connexion ;
- lecture du dashboard ;
- création d'une ressource de test ;
- création d'une demande de test ;
- suppression des données de test ;
- vérification de l'audit ;
- vérification de la file.

## Livraison

Chaque version possède :

- numéro ;
- changelog ;
- migrations ;
- flags ;
- risques ;
- procédure de retour ;
- validation métier.

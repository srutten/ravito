# Observabilité

## Objectifs

- Détecter les pannes.
- Diagnostiquer les erreurs.
- Mesurer les parcours.
- Identifier les abus.
- Conserver des traces sans exposer de données sensibles.

## Logs

Inclure :

- niveau ;
- horodatage ;
- environnement ;
- service ;
- route ;
- requestId ;
- userId pseudonymisé ;
- organizationId ;
- code d'erreur ;
- durée.

Exclure :

- mots de passe ;
- jetons ;
- documents ;
- position exacte ;
- téléphone complet ;
- contenu sensible d'incident.

## Métriques

- taux d'erreur ;
- latence ;
- disponibilité ;
- nombre de demandes ;
- propositions ;
- affectations ;
- transitions ;
- conflits ;
- notifications échouées ;
- profondeur de file ;
- connexions ;
- refus d'autorisation.

## Alertes

- taux d'erreur élevé ;
- impossibilité d'affecter ;
- base indisponible ;
- file bloquée ;
- SMS en échec ;
- hausse d'accès refusés ;
- uploads suspects ;
- saturation ;
- sauvegarde échouée.

## Traces

Tracer les opérations critiques :

```text
request
→ authorization
→ transaction
→ audit
→ outbox
→ notification
```

## Tableaux de bord

- santé technique ;
- activité opérationnelle ;
- sécurité ;
- notifications ;
- base de données ;
- files.

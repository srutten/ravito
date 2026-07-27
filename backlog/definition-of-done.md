# Definition of Done

Une story est terminée lorsque toutes les conditions applicables sont satisfaites.

## Fonctionnel

- Critères d'acceptation validés.
- Cas d'erreur couverts.
- États UI présents.
- Libellés relus.
- Parcours mobile testé.

## Domaine

- Règle métier dans le bon module.
- Transition explicite.
- Invariants protégés.
- Concurrence traitée.
- Idempotence si nécessaire.

## Sécurité

- Autorisation serveur.
- Test inter-organisations.
- Données sensibles masquées.
- Audit.
- Pas de secret.
- Upload contrôlé si applicable.

## Données

- Migration.
- Index.
- Contrainte.
- Seed mis à jour.
- Rollback ou stratégie de compatibilité.

## Tests

- Unitaires.
- Intégration.
- End-to-end critique.
- Tests négatifs.
- CI verte.

## Livraison

- Documentation.
- Variables.
- Feature flag si nécessaire.
- Observabilité.
- Changelog.
- Plan de rollback.
- Validation staging.

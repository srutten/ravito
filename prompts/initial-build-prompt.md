# Prompt initial pour Claude Code

Construis le MVP décrit dans ce dépôt documentaire.

Commence par lire :

1. `CLAUDE.md`
2. `docs/product-scope.md`
3. `docs/domain-model.md`
4. `docs/permissions.md`
5. `docs/state-machines.md`
6. `docs/api-contract.md`
7. `backlog/implementation-plan.md`

## Première mission

Produis le Lot 0 puis le Lot 1 uniquement.

### Lot 0

- Initialiser Next.js avec TypeScript strict.
- Installer et configurer la qualité.
- Préparer PostgreSQL/PostGIS.
- Créer le système de migrations.
- Créer le seed.
- Ajouter les commandes npm.
- Ajouter la CI.
- Ajouter une page de santé.
- Ajouter la structure modulaire.

### Lot 1

- Authentification.
- Profils.
- Organisations.
- Membres.
- Rôles.
- Validation d'organisation.
- MFA pour rôles sensibles.
- Audit.
- Tests d'autorisation.

## Contraintes

- Ne pas implémenter la carte.
- Ne pas implémenter les notifications réelles.
- Ne pas créer de microservices.
- Ne pas ignorer les tests.
- Ne pas introduire de données réelles.
- Ne pas contourner les permissions avec l'UI.
- Documenter chaque décision importante.

## Résultat attendu

- code exécutable ;
- migrations ;
- seed ;
- tests ;
- README de lancement ;
- `.env.example` sans secret ;
- CI ;
- liste des décisions ;
- compte rendu des écarts.

# Standards de développement

## TypeScript

- Mode strict.
- Pas de `any` non justifié.
- Types de domaine distincts.
- Validation runtime avec un schéma.
- Pas de cast destiné à contourner le compilateur.
- Fonctions courtes et nommées selon l'intention.

## Nommage

- Entités en anglais dans le code.
- Libellés utilisateur en français via i18n.
- Commandes sous forme de verbes.
- Événements au passé.
- Codes d'erreur stables en majuscules.

## Domaine

- Pas d'accès direct à la base depuis les composants.
- Pas de règles métier dans l'UI.
- Pas de changement de statut générique.
- Services de domaine testés.
- Transactions explicites.

## API

- Schémas d'entrée et sortie.
- Pagination.
- Codes d'erreur.
- Request ID.
- Pas de stack trace au client.
- Idempotence.

## UI

- Composants accessibles.
- Mobile-first.
- États de chargement.
- États d'erreur.
- Pas de données sensibles dans le HTML avant autorisation.
- Boutons désactivés pendant les mutations.

## Tests

- Test du comportement, pas de l'implémentation.
- Fixtures lisibles.
- Pas de dépendance réseau réelle en test.
- Horloge contrôlable.
- Tests de concurrence pour l'affectation.

## Commits

Format recommandé :

```text
feat(missions): add departure confirmation
fix(auth): prevent suspended user access
test(resources): cover expired documents
docs(api): document idempotency
```

## Pull requests

Chaque PR contient :

- objectif ;
- périmètre ;
- captures si UI ;
- migrations ;
- tests ;
- risques ;
- plan de rollback ;
- checklist sécurité.

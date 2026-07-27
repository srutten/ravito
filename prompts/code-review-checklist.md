# Checklist de revue pour Claude Code

## Compréhension

- Le changement correspond-il à une story ?
- Les critères sont-ils identifiés ?
- Le périmètre est-il maîtrisé ?

## Domaine

- La règle est-elle côté serveur ?
- Une transition générique a-t-elle été ajoutée par erreur ?
- Les invariants sont-ils protégés ?
- Les effets sont-ils transactionnels ?

## Autorisation

- Le rôle est-il vérifié ?
- L'organisation est-elle vérifiée ?
- La relation avec l'objet est-elle vérifiée ?
- Un appel API direct est-il protégé ?

## Données

- Migration correcte ?
- Index ?
- Contrainte ?
- Données sensibles ?
- Compatibilité de déploiement ?

## Sécurité

- Entrées validées ?
- Sorties filtrées ?
- Logs propres ?
- Fichiers contrôlés ?
- Idempotence ?
- Rate limiting ?

## Tests

- Nominal ?
- Erreur ?
- Accès refusé ?
- Concurrence ?
- Rejeu ?
- Mobile ?

## Exploitation

- Logs ?
- Métriques ?
- Alertes ?
- Feature flag ?
- Rollback ?
- Documentation ?

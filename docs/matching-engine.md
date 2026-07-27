# Moteur de mise en relation

## Principe

Le moteur propose des correspondances. Il ne prend jamais la décision finale.

## Filtres obligatoires

Une ressource est exclue si :

- indisponible ;
- suspendue ;
- déjà engagée ;
- catégorie incompatible ;
- capacité insuffisante ;
- document obligatoire expiré ;
- rayon de mobilisation dépassé ;
- opérateur requis absent ;
- restriction territoriale incompatible.

## Score indicatif

```text
score =
  compatibilité technique
+ proximité
+ disponibilité immédiate
+ présence opérateur
+ niveau de vérification
+ historique fiable
- pénalités de contraintes
```

## Explicabilité

Pour chaque proposition, afficher :

- critères satisfaits ;
- critères non satisfaits ;
- distance approximative ;
- délai estimé ;
- documents manquants ;
- raison du classement.

## Limites MVP

- Pas d'apprentissage automatique.
- Pas d'optimisation globale.
- Pas de réputation publique.
- Pas de score caché impossible à expliquer.
- Pas de décision automatique.

## Tests

- même catégorie ;
- capacité limite ;
- distance limite ;
- document expiré ;
- ressource engagée ;
- absence d'opérateur ;
- égalité de score ;
- donnée manquante.

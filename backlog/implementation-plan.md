# Plan d'implémentation

## Lot 0 — Fondation

Objectif : environnement reproductible.

Livrables :

- dépôt ;
- TypeScript strict ;
- base ;
- migrations ;
- seed ;
- CI ;
- observabilité minimale ;
- design system minimal.

Critère de sortie : une PR de test est déployée en preview.

## Lot 1 — Identité et organisations

Livrables :

- authentification ;
- rôles ;
- organisations ;
- validation ;
- middleware ;
- audit.

Critère de sortie : un admin valide une organisation et un coordinateur se connecte avec MFA.

## Lot 2 — Ressources

Livrables :

- CRUD ;
- catégories ;
- disponibilité ;
- documents ;
- liste ;
- permissions.

Critère de sortie : un contributeur enregistre une citerne vérifiable.

## Lot 3 — Demandes

Livrables :

- brouillon ;
- exigences ;
- point ;
- publication ;
- annulation ;
- dashboard.

Critère de sortie : un coordinateur publie un besoin complet en moins de deux minutes.

## Lot 4 — Propositions

Livrables :

- compatibilité ;
- proposition ;
- retrait ;
- comparaison ;
- expiration.

Critère de sortie : un contributeur propose une ressource compatible.

## Lot 5 — Affectation

Livrables :

- transaction ;
- anti-concurrence ;
- mission ;
- événements ;
- audit ;
- notifications.

Critère de sortie : deux tentatives concurrentes n'affectent jamais deux fois une ressource.

## Lot 6 — Suivi

Livrables :

- mission mobile ;
- départ ;
- transit ;
- arrivée ;
- remise ;
- clôture ;
- incident.

Critère de sortie : parcours complet démontrable.

## Lot 7 — Carte et mode dégradé

Livrables :

- carte ;
- masquage ;
- point exact ;
- cache ;
- file locale ;
- synchronisation.

Critère de sortie : une mission déjà ouverte reste consultable lors d'une coupure réseau.

## Lot 8 — Administration et pilote

Livrables :

- interrupteurs ;
- lecture seule ;
- exports limités ;
- runbooks ;
- sauvegarde ;
- tests ;
- exercice.

Critère de sortie : validation métier et sécurité.

## Stratégie de branches

- branche principale protégée ;
- branches courtes ;
- pull requests ;
- preview ;
- revue ;
- fusion après CI.

## Priorités

- P0 : sécurité, transaction, permissions, audit.
- P1 : parcours principal et ergonomie mobile.
- P2 : carte, rapports, confort.
- P3 : optimisation et intégrations.

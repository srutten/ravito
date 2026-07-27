# Personas et parcours

## Persona A — Coordinateur opérationnel

### Besoins

- Publier un besoin en moins de deux minutes.
- Voir les propositions compatibles.
- Éviter les doublons.
- Savoir quelle ressource est en route.
- Transmettre des consignes contrôlées.
- Conserver une trace.

### Irritants à éviter

- Formulaires longs.
- Informations non vérifiées.
- Carte surchargée.
- Notifications inutiles.
- Actions non confirmées.

## Persona B — Agriculteur contributeur

### Besoins

- Déclarer une citerne ou un tracteur.
- Comprendre les contraintes.
- Ne pas être envoyé dans une zone dangereuse.
- Savoir qui contacter.
- Retirer sa disponibilité.
- Garder une preuve de la mission.

### Irritants à éviter

- Demandes vagues.
- Appels multiples.
- Position de rendez-vous tardive.
- Absence de confirmation.
- Responsabilités ambiguës.

## Persona C — Entreprise de travaux publics

### Besoins

- Enregistrer plusieurs engins.
- Associer des opérateurs.
- Gérer les disponibilités.
- Fournir des documents.
- Recevoir une demande structurée.
- Exporter un historique.

## Persona D — Administrateur territorial

### Besoins

- Valider les organisations.
- Identifier les comportements anormaux.
- Suspendre rapidement un compte.
- Vérifier les audits.
- Préparer un exercice.
- Mesurer la couverture territoriale.

## Parcours nominal

```text
Organisation validée
→ demande publiée
→ ressources compatibles identifiées
→ proposition déposée
→ proposition acceptée
→ mission créée
→ départ confirmé
→ arrivée confirmée
→ remise confirmée
→ mission terminée
```

## Parcours dégradé

```text
Mission déjà chargée
→ perte de réseau
→ consultation locale des consignes
→ statut placé en file locale
→ retour du réseau
→ synchronisation idempotente
→ confirmation serveur
```

# Modèle de menaces

## Actifs

- positions exactes ;
- identités des coordinateurs ;
- coordonnées des contributeurs ;
- documents ;
- demandes opérationnelles ;
- missions ;
- journal d'audit ;
- disponibilité des ressources ;
- canaux de notification.

## Acteurs malveillants

- utilisateur externe ;
- contributeur malveillant ;
- compte compromis ;
- membre interne abusif ;
- robot de scraping ;
- attaquant cherchant à perturber les opérations.

## Scénarios

### Fausse demande

Un attaquant tente de publier une demande pour attirer des citoyens.

Contrôles :

- organisation validée ;
- MFA ;
- rôle explicite ;
- signature de l'action ;
- audit ;
- détection d'anomalie ;
- suspension rapide.

### Exposition des positions

Un utilisateur tente de parcourir les ressources ou missions.

Contrôles :

- position approximative ;
- contrôle d'accès ;
- limitation de requêtes ;
- détection de scraping ;
- journalisation ;
- vues SQL dédiées.

### Double affectation

Deux coordinateurs sélectionnent la même ressource.

Contrôles :

- transaction ;
- verrouillage ;
- contrainte unique ;
- version optimiste ;
- message de conflit clair.

### Modification de statut frauduleuse

Un contributeur appelle directement une route.

Contrôles :

- machine à états ;
- rôle ;
- relation ;
- préconditions ;
- idempotence ;
- audit.

### Téléversement malveillant

Contrôles :

- liste blanche ;
- taille ;
- signature ;
- antivirus ;
- stockage privé ;
- URL signée ;
- rendu sécurisé.

### Saturation

Contrôles :

- rate limiting ;
- files ;
- cache public ;
- dégradation gracieuse ;
- lecture seule ;
- priorité aux routes opérationnelles.

## Revue

Le modèle de menaces doit être revu :

- avant pilote ;
- avant ouverture publique ;
- après incident ;
- après intégration majeure ;
- au moins annuellement.

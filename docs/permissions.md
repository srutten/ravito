# Rôles et permissions

## Rôles

- `CONTRIBUTOR`
- `COORDINATOR`
- `ORG_ADMIN`
- `PLATFORM_ADMIN`
- `OBSERVER`

## Principes

- Refus par défaut.
- Autorisation contrôlée côté serveur.
- Appartenance à l'organisation vérifiée pour chaque action.
- Permissions sensibles conditionnées par la validation du compte.
- Accès aux coordonnées précises uniquement en cas de besoin légitime.
- Journalisation des consultations sensibles.

## Matrice

| Action | Contributeur | Coordinateur | Admin organisation | Admin plateforme | Observateur |
|---|---:|---:|---:|---:|---:|
| Créer une ressource personnelle | Oui | Oui | Oui | Oui | Non |
| Voir ses ressources | Oui | Oui | Oui | Oui | Non |
| Voir toutes les ressources exactes | Non | Limité | Limité | Oui | Non |
| Voir les ressources approximatives | Oui | Oui | Oui | Oui | Limité |
| Créer une demande | Non | Oui | Oui | Oui | Non |
| Publier une demande | Non | Oui | Oui | Oui | Non |
| Proposer une ressource | Oui | Oui | Oui | Oui | Non |
| Affecter une ressource | Non | Oui | Oui | Oui | Non |
| Voir le point exact de rendez-vous | Mission affectée | Oui | Oui | Oui | Non |
| Changer le statut d'une mission | Limité | Oui | Oui | Oui | Non |
| Déclarer un incident | Oui | Oui | Oui | Oui | Non |
| Valider une organisation | Non | Non | Non | Oui | Non |
| Suspendre un compte | Non | Non | Limité à l'organisation | Oui | Non |
| Consulter l'audit | Non | Limité | Organisation | Oui | Lecture limitée |
| Activer le mode lecture seule | Non | Non | Non | Oui | Non |

## Autorisations contextuelles

### Ressource

Un contributeur peut modifier une ressource si :

- il en est propriétaire ou gestionnaire ;
- la ressource n'est pas engagée ;
- la modification ne change pas une donnée verrouillée pendant une mission.

### Demande

Un coordinateur peut publier une demande si :

- son organisation est validée ;
- son adhésion est active ;
- la demande contient un point de rassemblement valide ;
- les champs obligatoires sont présents.

### Mission

Un contributeur peut confirmer le départ si :

- il est associé à la ressource ;
- la mission est validée ;
- il a accepté les consignes ;
- la transition est autorisée.

## Données sensibles

Les champs suivants nécessitent un contrôle renforcé :

- coordonnées exactes ;
- téléphone direct ;
- documents ;
- détails d'incident ;
- identifiants techniques ;
- journaux de consultation ;
- informations de santé éventuellement saisies par erreur.

## Cas de test obligatoires

- accès à une autre organisation ;
- modification d'une ressource engagée ;
- lecture d'un point exact sans mission ;
- transition par un rôle non autorisé ;
- accès après suspension ;
- réutilisation d'une ancienne session ;
- appel direct d'une route masquée par l'interface.

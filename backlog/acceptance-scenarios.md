# Scénarios d'acceptation

## Publier une demande

```gherkin
Étant donné un coordinateur authentifié
Et une organisation validée
Et une demande complète
Et un point de rassemblement actif
Lorsque le coordinateur publie la demande
Alors le statut devient PUBLISHED
Et une trace d'audit est écrite
Et les contributeurs compatibles peuvent la voir
```

## Refuser une organisation non validée

```gherkin
Étant donné un utilisateur coordinateur
Et une organisation en attente
Lorsque l'utilisateur tente de publier
Alors la requête est refusée
Et aucune demande n'est publiée
Et un code ORGANIZATION_NOT_VERIFIED est retourné
```

## Soumettre une proposition

```gherkin
Étant donné une demande publiée
Et une ressource disponible
Et des documents valides
Lorsque le contributeur soumet une proposition
Alors la proposition est SUBMITTED
Et la ressource devient PROPOSED
Et le coordinateur reçoit une notification
```

## Affectation atomique

```gherkin
Étant donné une ressource disponible
Et deux propositions concurrentes
Lorsque deux coordinateurs tentent une affectation
Alors une seule mission est créée
Et une seule proposition est acceptée
Et l'autre tentative reçoit RESOURCE_ALREADY_ASSIGNED
```

## Masquage de position

```gherkin
Étant donné un contributeur non affecté
Lorsque la liste des ressources est demandée
Alors seule une position approximative est retournée
Et aucune coordonnée exacte n'est présente
```

## Départ hors ligne

```gherkin
Étant donné une mission validée chargée sur le téléphone
Et une perte de réseau
Lorsque le contributeur confirme le départ
Alors l'action est placée en file locale
Et elle possède un clientEventId
Lorsque le réseau revient
Alors l'action est synchronisée une seule fois
```

## Document expiré

```gherkin
Étant donné une ressource avec document obligatoire expiré
Lorsque le coordinateur tente l'affectation
Alors l'affectation est refusée
Et DOCUMENT_EXPIRED est retourné
```

## Lecture seule

```gherkin
Étant donné la plateforme en lecture seule
Lorsque toute mutation est appelée
Alors la mutation est refusée
Et les consultations restent disponibles
```

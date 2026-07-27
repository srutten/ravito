# Notifications

## Canaux

- notification web ;
- courriel ;
- SMS pour événements critiques ;
- notification push PWA si activée.

## Événements

- nouvelle demande compatible ;
- proposition reçue ;
- proposition acceptée ;
- proposition refusée ;
- mission validée ;
- point de rendez-vous disponible ;
- rappel de départ ;
- retard ;
- incident ;
- annulation ;
- restitution attendue ;
- document proche de l'expiration.

## Priorités

### Critique

- annulation après départ ;
- changement de point ;
- incident ;
- suspension de mission.

### Haute

- mission validée ;
- proposition acceptée ;
- demande urgente compatible.

### Normale

- proposition reçue ;
- document expirant ;
- mission clôturée.

## Règles

- Ne jamais inclure de position exacte dans un SMS.
- Ne jamais inclure de données sensibles dans l'objet d'un courriel.
- Limiter les relances.
- Respecter les préférences lorsque l'événement n'est pas critique.
- Enregistrer le statut d'envoi.
- Utiliser une file et des retries bornés.
- Permettre l'acquittement.

## Abstraction

Créer une interface :

```ts
interface NotificationProvider {
  send(message: NotificationMessage): Promise<NotificationResult>;
}
```

Les fournisseurs externes ne doivent pas être appelés directement depuis le domaine.

## Déduplication

Clé recommandée :

```text
recipient + template + aggregateId + eventId
```

## Mode test

En développement :

- boîte de réception locale ;
- aucun SMS réel ;
- rendu des modèles ;
- simulation d'échec ;
- simulation de délai.

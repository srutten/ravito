# Instructions pour Claude Code

## Mission

Construire un MVP sûr, testable et déployable d'une plateforme de mobilisation de moyens civils en soutien aux opérations incendie.

Le produit doit rester un outil de coordination logistique. Il ne doit jamais automatiser une décision opérationnelle critique ni envoyer un citoyen vers le front.

## Priorité absolue

Implémenter un parcours vertical complet avant d'ajouter des fonctionnalités secondaires :

1. authentification ;
2. organisations et rôles ;
3. ressources ;
4. demandes ;
5. propositions ;
6. affectation ;
7. mission et transitions ;
8. audit ;
9. notifications ;
10. carte et mode dégradé limité.

## Contraintes

- Utiliser TypeScript en mode strict.
- Préférer un monolithe modulaire.
- Ne pas introduire de microservices.
- Ne pas ajouter de dépendance sans justification.
- Toute règle métier doit être côté serveur.
- Toute transition de statut doit passer par un service de domaine.
- Toute mutation critique doit être transactionnelle.
- Toute action critique doit écrire dans le journal d'audit.
- La carte ne doit pas exposer les coordonnées exactes sans autorisation.
- Les contrôles d'accès doivent être testés.
- Les erreurs ne doivent jamais révéler de données sensibles.
- Les secrets ne doivent jamais être commités.
- Les fichiers de migration sont immuables après fusion.
- Le code doit pouvoir être exécuté localement avec une procédure unique.

## Architecture attendue

```text
app/
  (public)/
  auth/
  contributor/
  coordinator/
  admin/
  api/

src/
  components/
  domain/
    organizations/
    resources/
    requests/
    offers/
    missions/
    incidents/
  application/
  infrastructure/
  authorization/
  validation/
  observability/
  config/

tests/
  unit/
  integration/
  e2e/

docs/
supabase/
  migrations/
  seed.sql
```

## Règles de conception

### Domaine

Les entités principales sont :

- Organization
- UserProfile
- OrganizationMember
- Resource
- ResourceDocument
- OperationalRequest
- RequestRequirement
- Offer
- Mission
- MissionEvent
- MeetingPoint
- Incident
- Notification
- AuditLog

### État métier

Ne jamais modifier directement le statut d'une demande, d'une ressource ou d'une mission depuis un composant UI ou une route générique.

Créer des commandes explicites :

- `publishRequest`
- `submitOffer`
- `acceptOffer`
- `assignResource`
- `confirmDeparture`
- `confirmArrival`
- `confirmHandover`
- `completeMission`
- `reportIncident`
- `cancelMission`

### Transactions

L'affectation d'une ressource doit, dans une seule transaction :

1. vérifier la disponibilité ;
2. verrouiller la ressource ;
3. créer la mission ;
4. changer le statut de la proposition ;
5. changer le statut de la demande ;
6. produire un événement métier ;
7. écrire l'audit ;
8. planifier la notification.

### Idempotence

Chaque mutation critique accepte un `clientEventId` UUID unique. Une même commande ne doit jamais produire deux effets.

### Autorisation

Ne pas se contenter de masquer les boutons. Vérifier côté serveur :

- le rôle ;
- l'appartenance à l'organisation ;
- le niveau de vérification ;
- la relation avec la ressource ou la mission ;
- le statut courant de l'objet ;
- le périmètre territorial si activé.

## Méthode de travail

Pour chaque fonctionnalité :

1. lire les documents associés ;
2. écrire ou mettre à jour les tests ;
3. créer la migration si nécessaire ;
4. implémenter le domaine ;
5. implémenter l'application ;
6. implémenter l'API ;
7. implémenter l'interface ;
8. vérifier les permissions ;
9. vérifier l'audit ;
10. mettre à jour la documentation.

## Commandes attendues

```bash
npm install
npm run dev
npm run lint
npm run typecheck
npm run test
npm run test:integration
npm run test:e2e
npm run build
npm run db:reset
npm run db:seed
```

## Qualité minimale

Une story n'est terminée que si :

- les critères d'acceptation sont satisfaits ;
- les tests passent ;
- les erreurs sont gérées ;
- les permissions sont testées ;
- la mutation est auditée ;
- l'interface mobile est utilisable ;
- aucune donnée sensible n'est exposée ;
- la documentation est à jour.

## Interdictions

- Ne pas inventer de processus d'urgence officiel.
- Ne pas afficher publiquement les fronts, tactiques ou positions d'équipe.
- Ne pas envoyer automatiquement une mission sans validation humaine.
- Ne pas créer un système de réputation publique des intervenants.
- Ne pas conserver un suivi GPS permanent.
- Ne pas stocker de documents sensibles dans les logs.
- Ne pas contourner un test échoué en supprimant le test.
- Ne pas utiliser `any` sauf justification locale commentée.
- Ne pas laisser de TODO critique avant livraison.

## Source de vérité

En cas de contradiction, respecter cet ordre :

1. sécurité des personnes ;
2. permissions et chaîne de commandement ;
3. machines à états ;
4. critères d'acceptation ;
5. contrat API ;
6. maquettes et détails d'interface.

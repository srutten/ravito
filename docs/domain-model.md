# Modèle de domaine

## Organization

Représente une structure opérationnelle, une entreprise, une association ou une collectivité.

Champs principaux :

- `id`
- `name`
- `type`
- `registrationNumber`
- `territoryCode`
- `verificationStatus`
- `status`
- `version`
- `createdAt`
- `updatedAt`

`version` porte le verrouillage optimiste (ADR-019). Son absence de ce document était un oubli et
non une exception : la règle générale « version positive pour verrouillage optimiste » ci-dessous
s'applique, `0015_organizations.sql` porte la colonne et `docs/api-contract.md` exige un
`expectedVersion` sur la modification d'une organisation.

## UserProfile

- `id`
- `authUserId`
- `displayName`
- `phone`
- `email`
- `preferredLanguage`
- `verificationLevel`
- `status`

## OrganizationMember

Portée par la table `organization_members` (`0016_organization-members.sql`). L'entité n'a pas
d'identifiant propre : sa clé est le couple organisation et utilisateur, donc une personne détient
au plus un rôle par organisation. L'absence d'`id` ci-dessous est voulue.

- `organizationId`
- `userId`
- `role`
- `status`
- `validFrom`
- `validUntil`

## Resource

- `id`
- `ownerOrganizationId`
- `ownerUserId`
- `categoryId`
- `name`
- `description`
- `capacity`
- `capacityUnit`
- `fuelType`
- `requiresOperator`
- `status`
- `availabilityStatus`
- `approximateLocation`
- `preciseLocationEncrypted`
- `mobilizationRadiusKm`
- `version`

## ResourceDocument

- `id`
- `resourceId`
- `documentType`
- `storageKey`
- `verificationStatus`
- `expiresAt`
- `verifiedBy`
- `verifiedAt`

## OperationalRequest

- `id`
- `organizationId`
- `createdBy`
- `title`
- `description`
- `priority`
- `status`
- `meetingPointId`
- `neededBefore`
- `expiresAt`
- `territoryCode`
- `version`

## RequestRequirement

- `id`
- `requestId`
- `categoryId`
- `quantity`
- `minimumCapacity`
- `capacityUnit`
- `requiresOperator`
- `constraints`

## Offer

- `id`
- `requestId`
- `resourceId`
- `submittedBy`
- `estimatedArrivalAt`
- `operatorIncluded`
- `comment`
- `status`
- `expiresAt`
- `version`

## Mission

- `id`
- `requestId`
- `offerId`
- `resourceId`
- `coordinatorOrganizationId`
- `contributorUserId`
- `meetingPointId`
- `status`
- `contactName`
- `contactPhone`
- `instructions`
- `startedAt`
- `completedAt`
- `version`

## MissionEvent

Événement append-only.

- `id`
- `missionId`
- `eventType`
- `actorUserId`
- `actorOrganizationId`
- `clientEventId`
- `payload`
- `occurredAt`
- `recordedAt`

## MeetingPoint

- `id`
- `organizationId`
- `name`
- `instructions`
- `preciseLocation`
- `publicApproximateLocation`
- `active`
- `validFrom`
- `validUntil`

## Incident

- `id`
- `missionId`
- `reportedBy`
- `type`
- `severity`
- `description`
- `status`
- `createdAt`
- `resolvedAt`

## Notification

- `id`
- `recipientUserId`
- `channel`
- `template`
- `payload`
- `status`
- `attemptCount`
- `scheduledAt`
- `sentAt`
- `acknowledgedAt`

## AuditLog

- `id`
- `actorUserId`
- `actorOrganizationId`
- `action`
- `targetType`
- `targetId`
- `before`
- `after`
- `ipHash`
- `userAgentSummary`
- `occurredAt`

## IdempotencyKey

Registre technique, et non entité métier : il porte l'unicité des commandes, pas un objet du
domaine. Il est cité ici parce qu'aucun autre document du modèle ne le fait, et qu'une table dont
dépend l'invariant « une même commande ne produit jamais deux effets » ne peut rester invisible.
Table `idempotency_keys` (`0017_idempotency-keys.sql`), lue et écrite dans la transaction de la
mutation qu'elle protège.

- `id`
- `clientEventId`
- `operation`
- `actorUserId`
- `requestFingerprint`
- `targetType`
- `targetId`
- `result`
- `createdAt`
- `updatedAt`

Le corps de la requête n'est jamais conservé : seule son empreinte l'est, ce qui suffit à
distinguer une reprise légitime d'une clé réutilisée pour une autre intention, sans faire du
registre un second stockage des données de la commande. `result` ne porte que des identifiants et
une version, jamais la réponse rendue à l'appelant.

## Contraintes SQL importantes

- `clientEventId` unique par acteur ou mission.
- Une seule mission active par ressource.
- Version positive pour verrouillage optimiste.
- Documents expirés non valides.
- Position exacte non incluse dans les vues publiques.
- Événements de mission non modifiables.
- Audit non modifiable par l'application.

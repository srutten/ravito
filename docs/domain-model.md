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
- `createdAt`
- `updatedAt`

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

## Contraintes SQL importantes

- `clientEventId` unique par acteur ou mission.
- Une seule mission active par ressource.
- Version positive pour verrouillage optimiste.
- Documents expirés non valides.
- Position exacte non incluse dans les vues publiques.
- Événements de mission non modifiables.
- Audit non modifiable par l'application.

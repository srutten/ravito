import { AppError } from '@/application/errors';
import {
  assertOrganizationActive,
  assertOrganizationRole,
  denyOrganizationAccess,
  resolveOrganizationAccess,
  toMembershipView,
} from '@/authorization/organization-access';
import { hashOriginAddress, summarizeUserAgent } from '@/domain/identity/origin';
import { assertPlatformWritable, ORGANIZATION_UPDATE_ROLES } from '@/domain/organizations/policy';
import type {
  UpdateOrganizationIdentityInput,
  UpdateOrganizationIdentityResult,
} from '@/domain/organizations/types';
import type { CanonicalOrganizationChanges } from '@/domain/organizations/validation';
import {
  parseOrganizationId,
  parseUpdateOrganizationPayload,
} from '@/domain/organizations/validation';
import { toOrganizationView } from '@/domain/organizations/views';
import { writeAuditLog } from '@/infrastructure/audit/audit-log';
import type { SqlExecutor } from '@/infrastructure/identity/unit-of-work';
import { withTransaction } from '@/infrastructure/identity/unit-of-work';
import { isUniqueViolationOn } from '@/infrastructure/organizations/postgres-errors';
import type { OrganizationRow } from '@/infrastructure/organizations/repository';
import {
  findOrganizationById,
  updateOrganizationIdentity as updateOrganizationRow,
} from '@/infrastructure/organizations/repository';
import { enqueueOutboxMessage } from '@/infrastructure/outbox/outbox';
import { getRequestLogger } from '@/observability/logger';

/**
 * Modification de l'identité d'une organisation (US-012).
 *
 * UNE SEULE TRANSACTION :
 *   1. lecture de l'organisation, puis résolution de l'adhésion DANS la transaction qui
 *      décide (ADR-021) — une adhésion suspendue entre la garde et l'écriture ne doit pas
 *      laisser passer l'écriture. Les deux lectures sont faites AVANT tout refus, pour que
 *      « cet identifiant ne désigne rien » et « vous n'êtes rien ici » coûtent le même
 *      travail : la réponse est déjà indiscernable, la durée doit l'être aussi ;
 *   2. mise à jour conditionnée par la version attendue, incrément compris ;
 *   3. audit `ORGANIZATION_UPDATED`, `before` et `after` réduits aux seuls champs modifiés ;
 *   4. lorsque la vérification retombe : audit `ORGANIZATION_VERIFICATION_RESET` et message
 *      d'outbox `ORGANIZATION_SUBMITTED`, comme à la création.
 *
 * MODIFIER UN CHAMP D'IDENTITÉ ANNULE LA VÉRIFICATION. Sans cette règle, la validation
 * serait contournable en deux appels : faire valider une exploitation agricole, puis la
 * renommer « Service incendie territorial ». L'usurpation d'organisation est l'une des
 * menaces prioritaires de `docs/security.md`, et un état « validée » qui survit au
 * changement de nom la rend triviale. La décision est prise PAR LE SERVEUR, dans l'`UPDATE`
 * lui-même : la prendre d'après la lecture de l'étape 1 laisserait passer le cas où
 * l'organisation est validée entre la lecture et l'écriture.
 *
 * `territoryCode` est volontairement exclu des champs d'identité : il décrit un périmètre
 * d'action, et le soumettre à revalidation dissuaderait de le corriger.
 *
 * PAS D'IDEMPOTENCE ICI, ET C'EST DÉLIBÉRÉ. `clientEventId` répond à « cette commande a-t-elle
 * déjà été exécutée ? », `expectedVersion` à « l'objet est-il encore tel que l'appelant l'a
 * lu ? ». Chaque route porte la clé qui a un sens pour elle. LIMITE ASSUMÉE, à ne pas se
 * cacher : une modification dont la réponse s'est perdue en route n'est pas rejouable — la
 * seconde tentative présente une version devenue périmée et reçoit `VERSION_CONFLICT`.
 * L'invariant tient — la commande n'a produit qu'un seul effet — mais l'écran doit traiter
 * ce cas en rechargeant, où l'appelant retrouvera sa propre modification.
 */
export async function updateOrganizationIdentity(
  input: UpdateOrganizationIdentityInput,
): Promise<UpdateOrganizationIdentityResult> {
  assertPlatformWritable();

  const organizationId = parseOrganizationId(input.organizationId);
  const command = parseUpdateOrganizationPayload(input.payload);
  const ipHash = hashOriginAddress(input.origin);
  const userAgentSummary = summarizeUserAgent(input.origin?.userAgent);

  return withTransaction(async (tx) => {
    const before = await findOrganizationById(tx, organizationId);
    // L'ACCÈS EST RÉSOLU AVANT QUE L'ABSENCE SOIT ÉPROUVÉE, exactement comme dans
    // `read-organization.ts`, et l'ordre est la propriété elle-même. Éprouver l'absence
    // d'abord épargnait deux requêtes au cas « identifiant inconnu » et les faisait payer au
    // cas « existe, mais l'appelant n'y est rien » : une requête contre trois, pour deux
    // réponses identiques au bit près. Aucune comparaison d'octets ne voit cet écart, une
    // horloge le voit très bien — l'oracle d'existence que la réponse ferme par la porte se
    // rouvrait par la durée.
    const access = await resolveOrganizationAccess(tx, {
      userId: input.actorUserId,
      organizationId,
    });

    if (before === undefined) {
      // Aucune existence n'est confirmée à un appelant qui n'a rien à voir avec cet
      // identifiant : même réponse que pour une organisation qu'il n'a pas le droit de voir.
      // Le motif réel, lui, part au journal technique — c'est la contrepartie écrite au
      // contrat, et elle n'était tenue que sur la lecture.
      throw denyOrganizationAccess(organizationId, 'ORGANIZATION_ABSENT', 'NOT_FOUND');
    }
    assertOrganizationRole(access, ORGANIZATION_UPDATE_ROLES);
    // Seconde garde, distincte de la première : l'adhésion dit ce que la personne peut
    // faire, elle ne dit pas si la structure est en état d'agir. Une organisation suspendue
    // ou close ne se modifie pas, quel que soit le rôle de qui le demande.
    assertOrganizationActive(before);

    const after = await applyUpdate(tx, {
      organizationId,
      expectedVersion: command.expectedVersion,
      changes: command.changes,
      touchesIdentity: command.touchesIdentity,
    });
    if (after === undefined) {
      // NIVEAU `warn`, PAS `info`, et par le même argument que les motifs de refus : la ligne
      // de sortie de requête est émise en `warn` par `logOutcome` pour tout 4xx, or ce refus
      // est un 409. Journalisé en dessous, il disparaîtrait de tout déploiement réglé sur
      // `warn`, qui conserverait alors le refus et perdrait sa cause.
      getRequestLogger().warn(
        { module: 'organizations', organizationId, errorCode: 'VERSION_CONFLICT' },
        'version attendue perimee : modification refusee, rien n a ete ecrit',
      );
      throw new AppError('VERSION_CONFLICT');
    }

    const verificationReset =
      before.verification_status === 'VERIFIED' && after.verification_status === 'PENDING';

    await writeAuditLog(tx, {
      action: 'ORGANIZATION_UPDATED',
      targetType: 'ORGANIZATION',
      targetId: organizationId,
      actorUserId: input.actorUserId,
      actorOrganizationId: organizationId,
      before: projectChangedFields(before, command.changes),
      after: {
        ...projectChangedFields(after, command.changes),
        version: after.version,
      },
      ipHash,
      userAgentSummary,
    });

    if (verificationReset) {
      // Ligne DISTINCTE de la précédente. La modification et la perte de confiance sont
      // deux faits : les confondre rendrait impossible de compter les secondes sans relire
      // et interpréter les premières, alors que c'est exactement ce qu'un administrateur
      // plateforme cherche dans le journal.
      await writeAuditLog(tx, {
        action: 'ORGANIZATION_VERIFICATION_RESET',
        targetType: 'ORGANIZATION',
        targetId: organizationId,
        actorUserId: input.actorUserId,
        actorOrganizationId: organizationId,
        before: { verificationStatus: before.verification_status },
        after: {
          verificationStatus: after.verification_status,
          reason: 'IDENTITY_CHANGED',
          changedFields: Object.keys(command.changes).sort(),
        },
        ipHash,
        userAgentSummary,
      });

      await enqueueOutboxMessage(tx, {
        eventType: 'ORGANIZATION_SUBMITTED',
        aggregateType: 'ORGANIZATION',
        aggregateId: organizationId,
        payload: {
          organizationId,
          submittedByUserId: input.actorUserId,
          reason: 'IDENTITY_CHANGED',
        },
      });
    }

    return {
      organization: toOrganizationView(after),
      membership: access.membership === null ? null : toMembershipView(access.membership),
      verificationReset,
    };
  });
}

/**
 * Applique la mise à jour, avec conversion du doublon d'immatriculation.
 *
 * Même règle de neutralité et de confidentialité qu'à la création : la réponse ne nomme
 * jamais la structure qui détient déjà le numéro, et l'erreur du pilote — dont le champ
 * `detail` porte la valeur en conflit — n'est ni propagée ni journalisée.
 */
async function applyUpdate(
  executor: SqlExecutor,
  input: {
    readonly organizationId: string;
    readonly expectedVersion: number;
    readonly changes: CanonicalOrganizationChanges;
    readonly touchesIdentity: boolean;
  },
): Promise<OrganizationRow | undefined> {
  try {
    return await updateOrganizationRow(executor, {
      organizationId: input.organizationId,
      expectedVersion: input.expectedVersion,
      name: input.changes.name ?? null,
      type: input.changes.type ?? null,
      registrationNumber: input.changes.registrationNumber ?? null,
      territoryCodeProvided: Object.hasOwn(input.changes, 'territoryCode'),
      territoryCode: input.changes.territoryCode ?? null,
      touchesIdentity: input.touchesIdentity,
    });
  } catch (error) {
    if (isUniqueViolationOn(error, 'uq_organizations_registration_number')) {
      getRequestLogger().warn(
        {
          module: 'organizations',
          organizationId: input.organizationId,
          errorCode: 'VALIDATION_ERROR',
          constraint: 'uq_organizations_registration_number',
        },
        'immatriculation deja enregistree : modification refusee',
      );
      throw new AppError('VALIDATION_ERROR', { details: { fields: ['registrationNumber'] } });
    }
    throw error;
  }
}

/**
 * Réduit un état d'organisation aux SEULS champs modifiés (`docs/api-contract.md`).
 *
 * Le journal d'audit porte ce qui a changé, pas une copie de la fiche. Recopier l'objet
 * entier à chaque modification ferait du journal un second stockage de l'organisation,
 * consultable par des rôles qui n'y ont pas le même accès, et rendrait illisible ce qui a
 * réellement bougé.
 */
function projectChangedFields(
  row: OrganizationRow,
  changes: CanonicalOrganizationChanges,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  if (Object.hasOwn(changes, 'name')) {
    projected.name = row.name;
  }
  if (Object.hasOwn(changes, 'type')) {
    projected.type = row.type;
  }
  if (Object.hasOwn(changes, 'registrationNumber')) {
    projected.registrationNumber = row.registration_number;
  }
  if (Object.hasOwn(changes, 'territoryCode')) {
    projected.territoryCode = row.territory_code;
  }
  return projected;
}

import { AppError } from '@/application/errors';
import { toMembershipView } from '@/authorization/organization-access';
import { hashOriginAddress, summarizeUserAgent } from '@/domain/identity/origin';
import {
  computeRequestFingerprint,
  timingSafeFingerprintEqual,
} from '@/domain/organizations/fingerprint';
import {
  assertPlatformWritable,
  INITIAL_MEMBER_ROLE,
  ORGANIZATION_CREATE_OPERATION,
} from '@/domain/organizations/policy';
import type {
  CreateOrganizationInput,
  CreateOrganizationResult,
} from '@/domain/organizations/types';
import type { CanonicalCreateOrganization } from '@/domain/organizations/validation';
import { parseCreateOrganizationPayload } from '@/domain/organizations/validation';
import { toOrganizationView } from '@/domain/organizations/views';
import { writeAuditLog } from '@/infrastructure/audit/audit-log';
import type { SqlExecutor } from '@/infrastructure/identity/unit-of-work';
import { withTransaction } from '@/infrastructure/identity/unit-of-work';
import type { IdempotencyRecord } from '@/infrastructure/organizations/idempotency';
import {
  completeIdempotencyKey,
  reserveIdempotencyKey,
} from '@/infrastructure/organizations/idempotency';
import { isUniqueViolationOn } from '@/infrastructure/organizations/postgres-errors';
import type { OrganizationRow } from '@/infrastructure/organizations/repository';
import {
  findMembership,
  findOrganizationById,
  insertOrganization,
  insertOrganizationMember,
} from '@/infrastructure/organizations/repository';
import { enqueueOutboxMessage } from '@/infrastructure/outbox/outbox';
import { getRequestLogger } from '@/observability/logger';

/**
 * Création d'une organisation (US-012).
 *
 * UNE SEULE TRANSACTION, SIX ÉCRITURES, DANS CET ORDRE :
 *   1. réservation du `clientEventId` dans `idempotency_keys` — AVANT tout autre effet ;
 *   2. l'organisation, `PENDING` et `ACTIVE`, version 1 ;
 *   3. l'adhésion `ORG_ADMIN` du créateur ;
 *   4. l'audit `ORGANIZATION_CREATED` ;
 *   5. l'audit `ORGANIZATION_MEMBER_ADDED` ;
 *   6. le message d'outbox `ORGANIZATION_SUBMITTED`, puis l'inscription du résultat sur la
 *      ligne réservée à l'étape 1.
 *
 * L'ORDRE DE LA PREMIÈRE ÉTAPE N'EST PAS NÉGOCIABLE. Réserver après avoir agi laisserait
 * ouverte exactement la fenêtre que la réservation existe pour fermer : deux appels
 * simultanés créeraient deux organisations jumelles, dont l'une resterait dans la file de
 * validation sans que personne sache laquelle fait foi.
 *
 * TOUT ÉCHOUE ENSEMBLE OU RIEN N'ABOUTIT. L'audit et l'outbox sont écrits dans la
 * transaction, jamais après : un message d'outbox émis hors transaction notifierait une
 * organisation qui peut encore ne pas exister, et une ligne d'audit écrite après coup
 * laisserait une mutation sans preuve. C'est le flux de `docs/architecture.md`, dans
 * l'ordre exact où il est écrit.
 *
 * UN ÉCHEC LIBÈRE LA CLÉ. Si l'insertion échoue — numéro déjà enregistré, par exemple — la
 * transaction est annulée, réservation comprise. C'est voulu : la commande n'a produit
 * aucun effet, elle n'a donc pas « déjà été exécutée », et une reprise avec le même
 * `clientEventId` et un numéro corrigé doit pouvoir aboutir.
 */
export async function createOrganization(
  input: CreateOrganizationInput,
): Promise<CreateOrganizationResult> {
  // Refusé avant toute analyse : en lecture seule, il n'y a rien à valider.
  assertPlatformWritable();

  const command = parseCreateOrganizationPayload(input.payload);
  const requestFingerprint = computeRequestFingerprint({
    operation: ORGANIZATION_CREATE_OPERATION,
    actorUserId: input.actorUserId,
    fields: [command.name, command.type, command.registrationNumber, command.territoryCode],
  });
  const ipHash = hashOriginAddress(input.origin);
  const userAgentSummary = summarizeUserAgent(input.origin?.userAgent);

  return withTransaction(async (tx) => {
    const reservation = await reserveIdempotencyKey(tx, {
      clientEventId: command.clientEventId,
      operation: ORGANIZATION_CREATE_OPERATION,
      actorUserId: input.actorUserId,
      requestFingerprint,
    });

    if (reservation.kind === 'ALREADY_RESERVED') {
      return replayCreation(tx, {
        existing: reservation.existing,
        requestFingerprint,
        actorUserId: input.actorUserId,
        clientEventId: command.clientEventId,
      });
    }

    const organization = await insertOrganizationOrReject(tx, command);
    const member = await insertOrganizationMember(tx, {
      organizationId: organization.id,
      userId: input.actorUserId,
      role: INITIAL_MEMBER_ROLE,
      status: 'ACTIVE',
    });

    await writeAuditLog(tx, {
      action: 'ORGANIZATION_CREATED',
      targetType: 'ORGANIZATION',
      targetId: organization.id,
      actorUserId: input.actorUserId,
      actorOrganizationId: organization.id,
      after: {
        name: organization.name,
        type: organization.type,
        registrationNumber: organization.registration_number,
        territoryCode: organization.territory_code,
        verificationStatus: organization.verification_status,
        status: organization.status,
        version: organization.version,
        clientEventId: command.clientEventId,
      },
      ipHash,
      userAgentSummary,
    });

    // `target_id` porte l'UTILISATEUR et non l'organisation : l'adhésion n'a pas
    // d'identifiant propre, sa clé est le couple, et `actor_organization_id` porte déjà
    // l'organisation. Répéter l'organisation dans les deux colonnes perdrait la seule
    // information que la ligne pouvait encore porter. US-014 doit suivre la même
    // convention, faute de quoi l'historique des mandats serait illisible.
    await writeAuditLog(tx, {
      action: 'ORGANIZATION_MEMBER_ADDED',
      targetType: 'ORGANIZATION_MEMBER',
      targetId: member.user_id,
      actorUserId: input.actorUserId,
      actorOrganizationId: organization.id,
      after: {
        organizationId: member.organization_id,
        userId: member.user_id,
        role: member.role,
        status: member.status,
        validFrom: member.valid_from.toISOString(),
        validUntil: member.valid_until?.toISOString() ?? null,
        reason: 'ORGANIZATION_CREATED',
      },
      ipHash,
      userAgentSummary,
    });

    await enqueueOutboxMessage(tx, {
      eventType: 'ORGANIZATION_SUBMITTED',
      aggregateType: 'ORGANIZATION',
      aggregateId: organization.id,
      // Identifiants seulement : la charge est recopiée dans les journaux du fournisseur
      // d'envoi. Ni nom, ni numéro d'immatriculation. Le service de notification relit
      // l'organisation s'il en a besoin, avec les droits qui vont avec.
      payload: {
        organizationId: organization.id,
        submittedByUserId: input.actorUserId,
        reason: 'CREATED',
      },
    });

    await completeIdempotencyKey(tx, {
      id: reservation.id,
      targetType: 'ORGANIZATION',
      targetId: organization.id,
      result: { organizationId: organization.id, version: organization.version },
    });

    return {
      organization: toOrganizationView(organization),
      membership: toMembershipView(member),
      nextStep: 'AWAITING_VERIFICATION',
      replayed: false,
    };
  });
}

/**
 * Insertion, avec conversion du doublon d'immatriculation.
 *
 * NEUTRALITÉ. La réponse dit que la saisie est refusée, jamais qui détient déjà le numéro :
 * ni le nom, ni l'existence de l'organisation en face. Sans cela, la route deviendrait un
 * oracle d'énumération — il suffirait d'essayer des numéros pour dresser la liste des
 * structures enregistrées, ce qui prépare exactement l'usurpation d'organisation de
 * `docs/threat-model.md`.
 *
 * CONFIDENTIALITÉ. L'erreur du pilote n'est ni propagée, ni attachée en `cause`, ni
 * journalisée : son champ `detail` contient la VALEUR en conflit
 * (« Key (registration_number_normalized)=(...) already exists »), et l'enveloppe de route
 * journalise la cause réelle de toute exception non identifiée. Le numéro d'une
 * organisation tierce se retrouverait dans les journaux d'exploitation, où il serait
 * lisible par des rôles qui n'y ont pas accès dans l'application. Seul le nom de l'index
 * est journalisé : c'est un identifiant du schéma, présent en clair dans le dépôt.
 *
 * AUCUNE LECTURE PRÉALABLE. L'unicité est tranchée par la contrainte, jamais par un
 * contrôle applicatif : deux créations simultanées portant le même numéro normalisé
 * liraient toutes deux « libre » avant que l'une n'écrive.
 */
async function insertOrganizationOrReject(
  executor: SqlExecutor,
  command: CanonicalCreateOrganization,
): Promise<OrganizationRow> {
  try {
    return await insertOrganization(executor, {
      name: command.name,
      type: command.type,
      registrationNumber: command.registrationNumber,
      territoryCode: command.territoryCode,
    });
  } catch (error) {
    if (isUniqueViolationOn(error, 'uq_organizations_registration_number')) {
      getRequestLogger().warn(
        {
          module: 'organizations',
          errorCode: 'VALIDATION_ERROR',
          constraint: 'uq_organizations_registration_number',
        },
        'immatriculation deja enregistree : creation refusee',
      );
      throw new AppError('VALIDATION_ERROR', { details: { fields: ['registrationNumber'] } });
    }
    throw error;
  }
}

/**
 * Rejeu d'une création déjà exécutée.
 *
 * DEUX CAS, ET IL FAUT LES SÉPARER :
 * - même empreinte : reprise légitime. Le client a perdu la première réponse — coupure
 *   réseau, double appui, file locale du mode dégradé — et reçoit la même réponse, avec le
 *   même statut. Aucun nouvel effet ;
 * - empreinte différente : deux requêtes distinctes présentent la même clé. C'est
 *   `IDEMPOTENCY_CONFLICT`. Rejouer la première réponse serait pire que refuser :
 *   l'appelant croirait sa seconde demande satisfaite alors qu'elle n'a rien produit.
 *
 * La comparaison est en TEMPS CONSTANT : qui saurait fabriquer une empreinte acceptée
 * ferait rejouer la réponse d'un autre acteur. L'acteur entrant dans l'empreinte, un rejeu
 * présenté par quelqu'un d'autre tombe déjà dans le second cas.
 *
 * LA RÉPONSE EST RECONSTRUITE, PAS RECOPIÉE. `idempotency_keys.result` ne conserve que des
 * identifiants et une version, comme l'impose `0017` : le registre n'a pas à devenir un
 * second stockage du nom et du numéro d'immatriculation, avec sa propre rétention et sa
 * propre fuite possible. CONSÉQUENCE ASSUMÉE : si l'organisation a été modifiée depuis, le
 * rejeu rend son état COURANT et non une copie figée. C'est le comportement souhaitable —
 * rendre un état périmé induirait le client en erreur — et l'écart se constate sur
 * `version`, dont la valeur d'origine reste dans le registre.
 *
 * AUCUNE GARDE D'ADHÉSION SUR CE CHEMIN, ET L'ABSENCE EST RAISONNÉE. Une première version
 * y appliquait `assertOrganizationVisible`, au motif que le critère 12 vaut partout où des
 * données d'organisation sont rendues. Deux raisons l'ont fait retirer.
 *
 * 1. LE CONTRAT L'INTERDIT. `docs/api-contract.md` : « Un rejeu portant le même
 *    clientEventId renvoie la réponse initiale à l'identique, statut 201 compris. Le client
 *    qui a perdu la première réponse n'a pas à distinguer deux cas. » Un rejeu n'est pas une
 *    consultation, c'est l'écho d'une commande déjà exécutée par cet acteur — l'empreinte
 *    contient l'acteur, un tiers tombe sur `IDEMPOTENCY_CONFLICT` avant d'arriver ici.
 * 2. LA GARDE REFUSAIT UN REJEU LÉGITIME UNE FOIS SUR DEUX, et la mesure l'a montré sur le
 *    double appui simultané. `valid_from` reçoit le `now()` de la transaction GAGNANTE,
 *    c'est-à-dire son instant de DÉBUT ; la transaction perdante, démarrée au même moment,
 *    évalue `valid_from <= now()` avec son propre instant de début, souvent antérieur. Elle
 *    voyait donc l'adhésion comme « pas encore commencée » et répondait `NOT_FOUND` sur une
 *    organisation qui venait d'être créée pour elle. L'effet, lui, restait juste : une seule
 *    organisation, un seul message d'outbox.
 *
 * Le critère 12 reste appliqué là où il porte : `readOrganization` et
 * `updateOrganizationIdentity`, les deux chemins par lesquels on accède aux données d'une
 * organisation qu'on n'est pas en train de créer.
 */
async function replayCreation(
  executor: SqlExecutor,
  input: {
    readonly existing: IdempotencyRecord;
    readonly requestFingerprint: string;
    readonly actorUserId: string;
    readonly clientEventId: string;
  },
): Promise<CreateOrganizationResult> {
  const log = getRequestLogger();
  if (!timingSafeFingerprintEqual(input.existing.requestFingerprint, input.requestFingerprint)) {
    log.warn(
      {
        module: 'organizations',
        errorCode: 'IDEMPOTENCY_CONFLICT',
        clientEventId: input.clientEventId,
      },
      "cle d'idempotence deja employee pour une requete differente : commande refusee",
    );
    throw new AppError('IDEMPOTENCY_CONFLICT');
  }

  const organizationId = input.existing.targetId;
  if (organizationId === null) {
    // Impossible en théorie : la réservation et l'inscription du résultat partagent la
    // transaction de la mutation, une ligne validée est donc toujours complète. Échouer
    // bruyamment plutôt que de fabriquer une réponse qui n'a jamais été produite.
    throw new Error("Reservation d'idempotence validee sans cible : etat incoherent du registre.");
  }

  const organization = await findOrganizationById(executor, organizationId);
  if (organization === undefined) {
    throw new Error("Rejeu d'une creation dont l'organisation est introuvable.");
  }

  const membership = await findMembership(executor, {
    organizationId,
    userId: input.actorUserId,
  });
  if (membership === undefined) {
    // L'adhésion initiale est créée dans la même transaction que l'organisation et aucun
    // droit `DELETE` n'existe sur `organization_members` : son absence signale une base
    // incohérente, pas un cas métier.
    throw new Error("Rejeu d'une creation dont l'adhesion initiale est introuvable.");
  }

  log.info(
    { module: 'organizations', organizationId, clientEventId: input.clientEventId },
    'creation d organisation rejouee : reponse initiale renvoyee sans nouvel effet',
  );

  return {
    organization: toOrganizationView(organization),
    membership: toMembershipView(membership),
    nextStep: 'AWAITING_VERIFICATION',
    replayed: true,
  };
}

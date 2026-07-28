import { randomUUID } from 'node:crypto';
import { AppError } from '@/application/errors';
import type { AttemptDecision } from '@/domain/identity/attempt-limiter';
import { consumeAttempt } from '@/domain/identity/attempt-limiter';
import { createSignInCode } from '@/domain/identity/code';
import type { CodeDelivery, SignInCodeMessage } from '@/domain/identity/code-delivery';
import { getConfiguredCodeDelivery } from '@/domain/identity/code-delivery';
import { hashIdentifier, hashSignInCode } from '@/domain/identity/hashing';
import { parseSignInIdentifier } from '@/domain/identity/identifier';
import { withMinimumDuration } from '@/domain/identity/neutrality';
import { hashOriginAddress, summarizeUserAgent, toSourceSubject } from '@/domain/identity/origin';
import {
  MINIMUM_PUBLIC_COMMAND_DURATION_MS,
  REQUEST_CODE_BY_IDENTIFIER,
  REQUEST_CODE_BY_SOURCE,
  SIGN_IN_CODE_LENGTH,
  SIGN_IN_CODE_MAX_ATTEMPTS,
  SIGN_IN_CODE_RESEND_SECONDS,
  SIGN_IN_CODE_TTL_SECONDS,
} from '@/domain/identity/policy';
import { findProfileByEmail, insertChallenge } from '@/domain/identity/repository';
import type {
  RequestOrigin,
  RequestSignInCodeInput,
  RequestSignInCodeResult,
} from '@/domain/identity/types';
import { writeAuditLog } from '@/infrastructure/audit/audit-log';
import { resolveDefaultCodeDelivery } from '@/infrastructure/identity/code-delivery-factory';
import { getExecutor, withTransaction } from '@/infrastructure/identity/unit-of-work';
import { getRequestLogger } from '@/observability/logger';

/**
 * Commande : demander un code de connexion à usage unique.
 *
 * ROUTE PUBLIQUE, DONC HOSTILE PAR DÉFAUT. Toute la difficulté tient en une phrase : la
 * réponse doit être rigoureusement la même pour une adresse rattachée à un compte et pour
 * une adresse qui n'existe pas. Même forme, même statut, même durée. Sinon, un attaquant
 * soumet une liste d'adresses, observe la différence et obtient l'annuaire des comptes —
 * étape préalable au hameçonnage ciblé d'un coordinateur.
 *
 * COMMENT C'EST OBTENU, ligne par ligne dans le corps de `execute` :
 * - un défi est créé DANS LES DEUX CAS, avec la même durée de vie et le même plafond
 *   d'essais. `auth_challenges.user_profile_id` est nullable exactement pour cela ;
 * - la lecture du profil a lieu DANS LES DEUX CAS, même lorsque son résultat ne changera
 *   rien : c'est le même nombre d'allers-retours vers la base ;
 * - l'envoi n'est JAMAIS attendu. C'est le seul travail réellement différent, et il coûte
 *   des dizaines de millisecondes ; il est sorti du chemin de réponse ;
 * - la durée totale est ramenée à un plancher commun.
 *
 * AUCUNE ÉCRITURE D'AUDIT sur le chemin nominal. Un appelant non authentifié ne doit pas
 * pouvoir faire grossir la table de preuve à volonté (docs/api-contract.md) ; seul le
 * franchissement d'un seuil de limitation est audité, et une seule fois par blocage.
 */

interface RequestSignInCodeDependencies {
  /** Adaptateur d'envoi. Injectable pour les tests ; à défaut, celui de la configuration. */
  readonly delivery?: CodeDelivery;
}

export async function requestSignInCode(
  input: RequestSignInCodeInput,
  dependencies?: RequestSignInCodeDependencies,
): Promise<RequestSignInCodeResult> {
  return withMinimumDuration(MINIMUM_PUBLIC_COMMAND_DURATION_MS, () =>
    execute(input, dependencies),
  );
}

async function execute(
  input: RequestSignInCodeInput,
  dependencies: RequestSignInCodeDependencies | undefined,
): Promise<RequestSignInCodeResult> {
  // Validation de forme uniquement : elle ne consulte jamais l'état stocké, elle ne peut
  // donc pas distinguer un compte d'un autre.
  const identifier = parseSignInIdentifier(input.identifier);
  const origin = input.origin;

  // L'adaptateur est résolu AVANT de savoir si un envoi aura lieu. La résolution construit,
  // au premier appel du processus, un transport SMTP avec son pool de connexions : la
  // placer dans la branche « compte connu » ferait payer ce coût à cette seule branche, et
  // la première demande de code pour un compte existant serait mesurablement plus lente.
  const delivery =
    dependencies?.delivery ?? getConfiguredCodeDelivery() ?? resolveDefaultCodeDelivery();

  await enforceRateLimits(identifier.normalized, origin);

  const identifierHash = hashIdentifier(identifier.normalized);
  const code = createSignInCode();

  // L'identifiant du défi est tiré avant l'écriture : l'empreinte du code y est liée, et
  // le défi doit être écrit avec son empreinte définitive du premier coup.
  const challengeId = randomUUID();

  const created = await withTransaction(async (tx) => {
    // Lecture systématique. Voir `findProfileByEmail` : la court-circuiter rendrait la
    // branche « identifiant inconnu » mesurablement plus rapide.
    const profile = await findProfileByEmail(tx, identifier.normalized);

    await insertChallenge(tx, {
      id: challengeId,
      identifierHash,
      codeHash: hashSignInCode(challengeId, code),
      userProfileId: profile?.id ?? null,
      maxAttempts: SIGN_IN_CODE_MAX_ATTEMPTS,
      ttlSeconds: SIGN_IN_CODE_TTL_SECONDS,
    });
    return { challengeId, profile };
  });

  // L'envoi n'est décidé qu'ici, hors du chemin de réponse. Un compte suspendu ou clos ne
  // reçoit rien : lui remettre un code laisserait croire que la connexion aboutira, et le
  // refus n'arriverait qu'après la saisie.
  if (created.profile !== undefined && created.profile.status === 'ACTIVE') {
    scheduleDelivery(delivery, {
      channel: 'EMAIL',
      recipient: identifier.normalized,
      code,
      expiresAt: new Date(Date.now() + SIGN_IN_CODE_TTL_SECONDS * 1000),
      preferredLanguage: created.profile.preferred_language,
      challengeId: created.challengeId,
    });
  }

  getRequestLogger().info(
    { module: 'identity', challengeId: created.challengeId },
    'defi de connexion cree',
  );

  return {
    challengeId: created.challengeId,
    codeLength: SIGN_IN_CODE_LENGTH,
    expiresInSeconds: SIGN_IN_CODE_TTL_SECONDS,
    resendAvailableInSeconds: SIGN_IN_CODE_RESEND_SECONDS,
  };
}

/**
 * Limitation sur les DEUX dimensions exigées : l'identifiant et la source.
 *
 * Les deux compteurs sont consommés avant tout verdict. Interrompre après un premier
 * refus laisserait la seconde dimension non comptée, et il suffirait de saturer la
 * première pour se déplacer librement sur la seconde.
 *
 * Les seuils sont les mêmes pour un identifiant connu et pour un identifiant inconnu : un
 * compteur qui ne s'appliquerait qu'aux comptes existants serait lui-même un oracle
 * d'énumération (docs/api-contract.md).
 */
async function enforceRateLimits(
  normalizedIdentifier: string,
  origin: RequestOrigin | undefined,
): Promise<void> {
  const executor = getExecutor();
  const byIdentifier = await consumeAttempt(
    executor,
    REQUEST_CODE_BY_IDENTIFIER,
    normalizedIdentifier,
  );
  const bySource = await consumeAttempt(executor, REQUEST_CODE_BY_SOURCE, toSourceSubject(origin));

  await auditBlockedSubjects([byIdentifier, bySource], origin, null);

  if (byIdentifier.allowed && bySource.allowed) {
    return;
  }
  const retryAfterSeconds = Math.max(byIdentifier.retryAfterSeconds, bySource.retryAfterSeconds);
  throw new AppError('RATE_LIMITED', { details: { retryAfterSeconds } });
}

/**
 * Écrit une ligne d'audit par franchissement de seuil, et une seule.
 *
 * `justBlocked` est vrai au seul appel qui a fait basculer le compteur. Auditer chaque
 * tentative refusée offrirait à un appelant non authentifié un moyen de faire grossir la
 * table de preuve indéfiniment ; n'auditer jamais ferait disparaître la trace d'une
 * campagne de tentatives, que `docs/security.md` demande justement de conserver.
 *
 * La cible est le défi lorsqu'il y en a un. `actor_user_id` reste nul : l'appelant n'est
 * pas authentifié, et le compte éventuellement visé n'est pas l'auteur de l'action.
 * `subjectHash` est une empreinte, jamais l'adresse ni l'identifiant.
 */
async function auditBlockedSubjects(
  decisions: readonly AttemptDecision[],
  origin: RequestOrigin | undefined,
  challengeId: string | null,
): Promise<void> {
  const blocked = decisions.filter((decision) => decision.justBlocked);
  if (blocked.length === 0) {
    return;
  }
  const ipHash = hashOriginAddress(origin);
  const userAgentSummary = summarizeUserAgent(origin?.userAgent);
  await withTransaction(async (tx) => {
    for (const decision of blocked) {
      await writeAuditLog(tx, {
        action: 'SIGN_IN_BLOCKED',
        targetType: 'AUTH_CHALLENGE',
        targetId: challengeId,
        actorUserId: null,
        after: {
          subjectHash: decision.subjectHash,
          attemptCount: decision.attemptCount,
          retryAfterSeconds: decision.retryAfterSeconds,
        },
        ipHash,
        userAgentSummary,
      });
    }
  });
}

/**
 * Remise du code, détachée du chemin de réponse.
 *
 * L'attente de l'envoi est ce qui distinguerait le plus sûrement un compte existant d'un
 * compte absent : une connexion SMTP coûte des dizaines de millisecondes, un plancher de
 * durée ne l'absorberait pas. L'échec est journalisé et n'est jamais propagé — la réponse
 * de l'API ne dépend pas du succès de l'envoi (ADR-015).
 *
 * Limite connue : cette remise vit dans le processus. Un arrêt entre la réponse et
 * l'envoi perd le message, et l'utilisateur redemandera un code. ADR-015 prévoit à terme
 * un passage par l'outbox avec relances bornées ; la table existe (0005), le drainage
 * n'est pas livré au lot 1. C'est le point d'extension à reprendre.
 */
function scheduleDelivery(delivery: CodeDelivery, message: SignInCodeMessage): void {
  const logger = getRequestLogger();
  void delivery.send(message).catch((error: unknown) => {
    logger.error(
      {
        err: error,
        module: 'identity',
        challengeId: message.challengeId,
        errorCode: 'SERVICE_UNAVAILABLE',
      },
      "echec de remise du code de connexion, la reponse n'en depend pas",
    );
  });
}

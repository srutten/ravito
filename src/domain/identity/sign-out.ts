import { AppError } from '@/application/errors';
import { hashSessionToken } from '@/domain/identity/hashing';
import { hashOriginAddress, summarizeUserAgent } from '@/domain/identity/origin';
import {
  countValidSessions,
  revokeAllSessionsOfProfile,
  revokeSessionByTokenHash,
} from '@/domain/identity/repository';
import type {
  RevokeAllSessionsInput,
  RevokeAllSessionsResult,
  SignOutInput,
} from '@/domain/identity/types';
import { findAuditLogByClientEventId, writeAuditLog } from '@/infrastructure/audit/audit-log';
import { withTransaction } from '@/infrastructure/identity/unit-of-work';
import { getRequestLogger } from '@/observability/logger';
import { clientEventIdSchema } from '@/validation/common';

/**
 * Commandes de fin de session : déconnexion individuelle et révocation globale.
 */

/**
 * Déconnexion de la session présentée.
 *
 * NE LÈVE JAMAIS, même sans session valide, et c'est un choix de sécurité, pas une
 * facilité. Répondre en erreur laisserait une session vivante sur un poste partagé au
 * motif que l'appelant n'a pas su prouver qu'elle lui appartenait — soit l'inverse du
 * service rendu. La route efface le cookie dans tous les cas (docs/api-contract.md).
 *
 * Les autres sessions du compte ne sont pas touchées : se déconnecter d'un poste
 * emprunté ne doit pas fermer la session du téléphone d'astreinte. La révocation
 * générale est une commande distincte, explicitement demandée.
 */
export async function signOut(input: SignOutInput): Promise<void> {
  const token = input.sessionToken;
  if (token === undefined || token.length === 0) {
    return;
  }
  const tokenHash = hashSessionToken(token);

  await withTransaction(async (tx) => {
    const revoked = await revokeSessionByTokenHash(tx, tokenHash);
    if (revoked === undefined) {
      // Jeton inconnu, déjà révoqué ou expiré. Rien à écrire : une ligne d'audit par
      // jeton inventé offrirait à un appelant non authentifié un moyen de faire grossir
      // la table de preuve à volonté.
      return;
    }
    await writeAuditLog(tx, {
      action: 'USER_SIGNED_OUT',
      targetType: 'SESSION',
      targetId: revoked.id,
      actorUserId: revoked.user_profile_id,
      ipHash: hashOriginAddress(input.origin),
      userAgentSummary: summarizeUserAgent(input.origin?.userAgent),
    });
  });
}

/**
 * Révocation de toutes les sessions d'un compte, la session courante comprise.
 *
 * UNE SEULE ÉCRITURE COUPE TOUT. `user_profiles.sessions_revoked_at` est avancé, et le
 * prédicat de validité — `issued_at > sessions_revoked_at`, comparaison stricte — rend
 * invalides toutes les sessions déjà émises, y compris sur des appareils dont personne
 * n'a la liste. Marquer les N lignes de `sessions` produirait le même effet visible en N
 * écritures, et laisserait une fenêtre ouverte tant que le balayage n'est pas terminé.
 * Sur un compte compromis, c'est précisément cette fenêtre qu'il faut fermer d'abord
 * (docs/operations.md, réponse à incident).
 *
 * Le nombre renvoyé est compté AVANT la révocation : après, il n'y a plus rien à
 * compter.
 *
 * IDEMPOTENCE. Un rejeu portant le même `clientEventId` renvoie la réponse initiale sans
 * nouvel effet. La détection s'appuie sur le journal d'audit, faute de registre
 * d'idempotence — voir `findAuditLogByClientEventId`, qui documente la limite exacte de
 * ce procédé.
 */
export async function revokeAllSessions(
  input: RevokeAllSessionsInput,
): Promise<RevokeAllSessionsResult> {
  const clientEventId = parseClientEventId(input.clientEventId);
  const ipHash = hashOriginAddress(input.origin);
  const userAgentSummary = summarizeUserAgent(input.origin?.userAgent);

  return withTransaction(async (tx) => {
    const replayed = await findAuditLogByClientEventId(tx, {
      action: 'USER_SESSIONS_REVOKED',
      targetType: 'USER_PROFILE',
      targetId: input.userId,
      clientEventId,
    });
    if (replayed !== undefined) {
      const previousCount = replayed.revokedCount;
      getRequestLogger().info(
        { module: 'identity', clientEventId },
        'revocation globale rejouee : reponse initiale renvoyee sans nouvel effet',
      );
      return { revokedCount: typeof previousCount === 'number' ? previousCount : 0 };
    }

    const revokedCount = await countValidSessions(tx, input.userId);
    const revokedAt = await revokeAllSessionsOfProfile(tx, input.userId);
    if (revokedAt === undefined) {
      // Le compte a disparu entre l'authentification et la commande. Refuser plutôt
      // qu'écrire une preuve sur une cible inexistante.
      throw new AppError('UNAUTHENTICATED');
    }

    await writeAuditLog(tx, {
      action: 'USER_SESSIONS_REVOKED',
      targetType: 'USER_PROFILE',
      targetId: input.userId,
      actorUserId: input.userId,
      after: {
        revokedCount,
        clientEventId,
        sessionsRevokedAt: revokedAt.toISOString(),
      },
      ipHash,
      userAgentSummary,
    });

    return { revokedCount };
  });
}

function parseClientEventId(raw: unknown): string {
  const parsed = clientEventIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', { details: { fields: ['clientEventId'] } });
  }
  return parsed.data;
}

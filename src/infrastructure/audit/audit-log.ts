import type { SqlExecutor } from '@/infrastructure/identity/unit-of-work';

/**
 * Écriture dans le journal d'audit.
 *
 * La table est append-only et doublement verrouillée (0006_audit-logs.sql) : ni `UPDATE`
 * ni `DELETE` pour le compte applicatif, et un déclencheur qui refuse les deux même si
 * un `GRANT` était accordé par erreur. Ce module est donc le seul chemin d'écriture, et
 * il n'expose volontairement aucune fonction de correction : une ligne d'audit fausse se
 * complète par une nouvelle ligne, elle ne se réécrit pas.
 *
 * L'appelant fournit son propre exécutant. C'est l'exigence de CLAUDE.md — « toute
 * mutation critique est transactionnelle et écrit dans audit_logs » : la preuve est
 * écrite DANS la transaction qui produit l'effet. Une écriture d'audit hors transaction
 * laisserait deux issues fausses, un effet sans preuve si l'audit échoue, une preuve
 * sans effet si la transaction est annulée après coup.
 */

/**
 * Codes d'action du lot 1. La colonne est contrainte à `^[A-Z][A-Z0-9_]{2,63}$` : le
 * type ci-dessous rend l'erreur visible à la compilation plutôt qu'au premier appel en
 * production.
 */
export type AuditAction =
  /** Ouverture de session réussie (docs/api-contract.md). */
  | 'USER_SIGNED_IN'
  /** Code valide présenté pour un compte non actif : le canal est contrôlé par quelqu'un. */
  | 'USER_SIGN_IN_REFUSED'
  /** Déconnexion d'une session identifiée. */
  | 'USER_SIGNED_OUT'
  /** Révocation de toutes les sessions d'un compte. */
  | 'USER_SESSIONS_REVOKED'
  /** Franchissement d'un seuil de limitation de tentatives. */
  | 'SIGN_IN_BLOCKED';

/**
 * Types de cible du lot 1.
 *
 * Casse imposée par la contrainte SQL, et elle NE SUIT PAS celle du modèle de domaine :
 * `UserProfile` de `docs/domain-model.md` s'écrit ici `USER_PROFILE`. Écrire
 * « UserProfile » échoue, avec un message qui ne dit pas pourquoi (voir « Convention de
 * casse » dans supabase/README.md).
 */
export type AuditTargetType = 'USER_PROFILE' | 'SESSION' | 'AUTH_CHALLENGE';

export interface AuditLogEntry {
  readonly action: AuditAction;
  readonly targetType: AuditTargetType;
  /** `null` lorsque l'action n'a pas de cible désignée par un UUID. */
  readonly targetId: string | null;
  /** `null` pour une action non authentifiée ou décidée par le système. */
  readonly actorUserId: string | null;
  /**
   * `null` au lot 1 : `organization_members` n'existe pas encore (US-012, US-014). La
   * colonne existe pour porter le filtrage par organisation de `docs/permissions.md` ;
   * le lot qui crée l'appartenance devra la renseigner, sans quoi un admin
   * d'organisation ne verra jamais les lignes de son organisation.
   */
  readonly actorOrganizationId?: string | null;
  readonly before?: Record<string, unknown> | null;
  /**
   * État après l'action, réduit aux champs réellement utiles. NE DOIT CONTENIR NI
   * position précise, NI document, NI téléphone complet, NI code, NI jeton : le journal
   * est consultable par des rôles qui n'ont pas accès à ces données dans l'application
   * (0006_audit-logs.sql, docs/observability.md).
   */
  readonly after?: Record<string, unknown> | null;
  /** Empreinte de l'adresse d'appel. Jamais l'adresse (contrainte `^[0-9a-f]{64}$`). */
  readonly ipHash?: string | null;
  /** Résumé court du navigateur, jamais l'en-tête complet. */
  readonly userAgentSummary?: string | null;
  /** Instant métier. Absent, le serveur pose `now()`. */
  readonly occurredAt?: Date | null;
}

const INSERT_AUDIT_LOG = `
  INSERT INTO public.audit_logs (
    actor_user_id, actor_organization_id, action, target_type, target_id,
    before, after, ip_hash, user_agent_summary, occurred_at
  )
  VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, COALESCE($10::timestamptz, now()))
  RETURNING id
`;

interface AuditLogIdRow {
  readonly id: string;
}

function toJsonParameter(value: Record<string, unknown> | null | undefined): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/**
 * Écrit une ligne d'audit et renvoie son identifiant.
 *
 * Aucune capture d'erreur ici, volontairement : si l'écriture échoue, la transaction
 * doit échouer avec elle. Absorber l'échec produirait une mutation sans preuve, ce qui
 * est précisément la situation contre laquelle le journal existe.
 */
export async function writeAuditLog(
  executor: SqlExecutor,
  entry: AuditLogEntry,
): Promise<string | undefined> {
  const result = await executor.query<AuditLogIdRow>(INSERT_AUDIT_LOG, [
    entry.actorUserId,
    entry.actorOrganizationId ?? null,
    entry.action,
    entry.targetType,
    entry.targetId,
    toJsonParameter(entry.before),
    toJsonParameter(entry.after),
    entry.ipHash ?? null,
    entry.userAgentSummary ?? null,
    entry.occurredAt ?? null,
  ]);
  return result.rows[0]?.id;
}

/**
 * Recherche la dernière ligne d'audit produite par une commande idempotente donnée.
 *
 * POURQUOI ICI, ET CE QUE CELA VAUT. `docs/api-contract.md` demande qu'un rejeu de
 * `revoke-all` portant le même `clientEventId` renvoie la réponse initiale sans nouvel
 * effet. Aucun registre d'idempotence n'existe : `idempotency_witness` est une table
 * témoin du lot 0, explicitement interdite au code applicatif, et l'arbitrage de la
 * portée de `clientEventId` est renvoyé au lot 5 (voir l'en-tête de
 * 0007_idempotency-witness.sql). Le journal d'audit, lui, contient déjà la trace exacte
 * de l'effet produit, il est inaltérable, et la recherche est servie par
 * `idx_audit_logs_target` puisqu'elle est bornée au couple (type de cible, cible).
 *
 * Limite assumée, à ne pas se cacher : deux rejeux STRICTEMENT simultanés ne se voient
 * pas l'un l'autre et produiront deux lignes. L'effet reste idempotent — la seconde
 * révocation ne révoque plus rien — seul le compte renvoyé peut différer. Un registre
 * réservant la clé avant d'agir est la seule façon de fermer cette fenêtre ; il relève
 * de l'arbitrage du lot 5.
 */
export async function findAuditLogByClientEventId(
  executor: SqlExecutor,
  criteria: {
    readonly action: AuditAction;
    readonly targetType: AuditTargetType;
    readonly targetId: string;
    readonly clientEventId: string;
  },
): Promise<Record<string, unknown> | undefined> {
  const result = await executor.query<{ after: Record<string, unknown> | null }>(
    `
      SELECT after
        FROM public.audit_logs
       WHERE target_type = $1
         AND target_id = $2
         AND action = $3
         AND after ->> 'clientEventId' = $4
       ORDER BY occurred_at DESC
       LIMIT 1
    `,
    [criteria.targetType, criteria.targetId, criteria.action, criteria.clientEventId],
  );
  return result.rows[0]?.after ?? undefined;
}

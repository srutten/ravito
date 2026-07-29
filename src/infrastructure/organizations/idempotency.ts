import type { SqlExecutor } from '@/infrastructure/identity/unit-of-work';

/**
 * Registre central d'idempotence (`0017_idempotency-keys.sql`).
 *
 * L'IDEMPOTENCE EST PORTÉE PAR UNE CONTRAINTE, JAMAIS PAR UNE LECTURE SUIVIE D'UNE
 * ÉCRITURE. C'est le point central de ce module, et la raison tient en une phrase : deux
 * transactions simultanées liraient toutes deux « pas encore fait » avant que l'une
 * n'écrive. Un `SELECT` puis, s'il ne trouve rien, un `INSERT`, produit donc deux
 * organisations pour un double appui sur le bouton. Seule une insertion tranche.
 *
 * `src/infrastructure/audit/audit-log.ts` détectait un rejeu en relisant le journal
 * d'audit, faute de registre, et documentait honnêtement sa limite : « deux rejeux
 * strictement simultanés ne se voient pas l'un l'autre ». Ce module ferme cette fenêtre.
 *
 * POURQUOI `ON CONFLICT DO NOTHING` ET NON UN `INSERT` NU. Un `23505` remonté par le
 * pilote AVORTE la transaction : plus aucune lecture n'y est possible, et il faudrait un
 * point de sauvegarde pour continuer. `ON CONFLICT DO NOTHING` ne renvoie simplement
 * aucune ligne, sans abandonner la transaction, et — c'est la propriété qui compte — il
 * ATTEND la transaction concurrente qui détient une insertion non validée sur la même
 * clé. Trois issues, toutes correctes :
 *   - la concurrente valide : notre insertion ne fait rien, la relecture voit sa ligne
 *     complète, le rejeu renvoie son résultat ;
 *   - la concurrente annule : notre insertion aboutit, la commande s'exécute normalement ;
 *   - aucune concurrente : notre insertion aboutit.
 *
 * UNE LIGNE VALIDÉE EST TOUJOURS COMPLÈTE. La réservation et l'inscription du résultat ont
 * lieu dans la MÊME transaction que la mutation : une autre session n'observe jamais l'état
 * intermédiaire, et un arrêt brutal entre les deux annule tout. Une ligne validée sans
 * cible est donc impossible ; l'appelant traite malgré tout le cas plutôt que d'inventer
 * une réponse.
 *
 * PORTÉE DE `client_event_id` : GLOBALE aujourd'hui, comme en 0007, et la contradiction du
 * corpus reste OUVERTE (`supabase/README.md`, arbitrage au lot 5). Ce module n'en dépend
 * pas : il passe `actor_user_id` à l'insertion bien qu'il n'entre pas dans l'unicité, de
 * sorte qu'une portée par acteur ne demanderait qu'un changement d'index.
 */

/**
 * Codes d'opération réservés par ce lot. Format `^[A-Z][A-Z0-9_]{2,63}$`, comme
 * `audit_logs.action` et `outbox.event_type`.
 */
export type IdempotentOperation = 'ORGANIZATION_CREATE';

export interface IdempotencyRecord {
  readonly id: string;
  readonly clientEventId: string;
  readonly operation: string;
  readonly actorUserId: string | null;
  readonly requestFingerprint: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly result: Record<string, unknown>;
}

/**
 * Issue d'une réservation.
 *
 * `RESERVED` : la clé était libre, l'appelant doit exécuter la mutation puis appeler
 * `completeIdempotencyKey`.
 * `ALREADY_RESERVED` : la clé était prise. L'appelant COMPARE LES EMPREINTES avant toute
 * autre décision — même empreinte, rejeu légitime ; empreinte différente,
 * `IDEMPOTENCY_CONFLICT`.
 */
export type ReservationOutcome =
  | { readonly kind: 'RESERVED'; readonly id: string }
  | { readonly kind: 'ALREADY_RESERVED'; readonly existing: IdempotencyRecord };

interface IdempotencyRow {
  readonly id: string;
  readonly client_event_id: string;
  readonly operation: string;
  readonly actor_user_id: string | null;
  readonly request_fingerprint: string;
  readonly target_type: string | null;
  readonly target_id: string | null;
  readonly result: Record<string, unknown>;
}

const IDEMPOTENCY_COLUMNS = `
  id, client_event_id, operation, actor_user_id, request_fingerprint,
  target_type, target_id, result
`;

function toRecord(row: IdempotencyRow): IdempotencyRecord {
  return {
    id: row.id,
    clientEventId: row.client_event_id,
    operation: row.operation,
    actorUserId: row.actor_user_id,
    requestFingerprint: row.request_fingerprint,
    targetType: row.target_type,
    targetId: row.target_id,
    result: row.result,
  };
}

/**
 * Réserve la clé AVANT tout autre effet.
 *
 * L'ordre n'est pas négociable : réserver après avoir agi laisserait ouverte exactement la
 * fenêtre que la réservation existe pour fermer (`docs/api-contract.md`, effets de la
 * création, étape 1).
 */
export async function reserveIdempotencyKey(
  executor: SqlExecutor,
  input: {
    readonly clientEventId: string;
    readonly operation: IdempotentOperation;
    readonly actorUserId: string | null;
    readonly requestFingerprint: string;
  },
): Promise<ReservationOutcome> {
  const inserted = await executor.query<{ readonly id: string }>(
    `
      INSERT INTO public.idempotency_keys (
        client_event_id, operation, actor_user_id, request_fingerprint
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (client_event_id) DO NOTHING
      RETURNING id
    `,
    [input.clientEventId, input.operation, input.actorUserId, input.requestFingerprint],
  );
  const row = inserted.rows[0];
  if (row !== undefined) {
    return { kind: 'RESERVED', id: row.id };
  }

  const existing = await executor.query<IdempotencyRow>(
    `
      SELECT ${IDEMPOTENCY_COLUMNS}
        FROM public.idempotency_keys
       WHERE client_event_id = $1
       LIMIT 1
    `,
    [input.clientEventId],
  );
  const existingRow = existing.rows[0];
  if (existingRow === undefined) {
    // Inatteignable : l'insertion n'a rien renvoyé, donc la ligne existe et le compte
    // applicatif n'a aucun droit `DELETE` sur cette table. Échouer bruyamment plutôt que
    // de rejouer la commande, ce qui produirait le second effet que le registre interdit.
    throw new Error("Cle d'idempotence en conflit puis introuvable : etat incoherent du registre.");
  }
  return { kind: 'ALREADY_RESERVED', existing: toRecord(existingRow) };
}

/**
 * Inscrit la cible produite et la réponse à rejouer sur la ligne réservée.
 *
 * `result` est réduit au strict nécessaire — des identifiants et une version — comme
 * l'impose l'en-tête de `0017`. Le registre n'a pas à devenir un second stockage des
 * données qu'il désigne, avec sa propre durée de rétention et sa propre fuite possible.
 */
export async function completeIdempotencyKey(
  executor: SqlExecutor,
  input: {
    readonly id: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly result: Record<string, unknown>;
  },
): Promise<void> {
  await executor.query(
    `
      UPDATE public.idempotency_keys
         SET target_type = $2,
             target_id = $3,
             result = $4::jsonb
       WHERE id = $1
    `,
    [input.id, input.targetType, input.targetId, JSON.stringify(input.result)],
  );
}

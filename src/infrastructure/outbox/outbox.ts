import type { SqlExecutor } from '@/infrastructure/identity/unit-of-work';

/**
 * Écriture dans la file transactionnelle `outbox` (0005_outbox.sql, ADR-006).
 *
 * UNE SEULE RÈGLE, ET ELLE EST DANS LA SIGNATURE. L'appelant fournit son exécutant :
 * le message est donc écrit DANS la transaction qui produit la mutation, exactement
 * comme le journal d'audit. `docs/architecture.md` le formule ainsi — « garantir qu'une
 * notification n'est planifiée que si la mutation métier a réellement été validée ». Les
 * deux issues fausses qu'on évite ainsi méritent d'être nommées :
 *
 * - écrire le message APRÈS la transaction laisse une mutation validée sans notification
 *   si le processus tombe entre les deux ; une organisation resterait invisible de la
 *   file de validation, donc bloquée sans que personne ne le sache ;
 * - écrire le message AVANT, ou hors transaction, notifie une mutation qui peut encore
 *   échouer ; un administrateur plateforme recevrait une organisation à valider qui
 *   n'existe pas.
 *
 * Aucune fonction de drainage ici : elle relève du lot 5. Ce module ne fait qu'écrire, et
 * n'expose ni suppression ni correction — le compte applicatif n'a pas le droit `DELETE`
 * sur cette table, et la purge de rétention est une tâche d'exploitation.
 */

/**
 * Agrégats concernés par les messages de ce lot.
 *
 * Casse imposée par `outbox_aggregate_type_format` (`^[A-Z][A-Z0-9_]{2,63}$`), et elle NE
 * SUIT PAS celle du modèle de domaine : `Organization` de `docs/domain-model.md` s'écrit
 * ici `ORGANIZATION`, `OrganizationMember` s'écrit `ORGANIZATION_MEMBER`. Écrire
 * « Organization » échoue, avec un message qui ne dit pas pourquoi (supabase/README.md,
 * « Convention de casse »). Le type ci-dessous rend l'erreur visible à la compilation
 * plutôt qu'au premier appel en production.
 */
export type OutboxAggregateType = 'ORGANIZATION' | 'ORGANIZATION_MEMBER';

/**
 * Événements émis par ce lot. Nommés au passé et en majuscules
 * (`docs/coding-standards.md`).
 *
 * `ORGANIZATION_SUBMITTED` est émis deux fois dans la vie d'une organisation : à sa
 * création, et à chaque fois qu'une modification d'identité fait retomber sa
 * vérification. Les deux cas placent la même organisation dans la même file
 * d'administration ; leur donner deux noms d'événement obligerait le drainage à router
 * deux fois vers la même destination.
 */
export type OutboxEventType = 'ORGANIZATION_SUBMITTED';

export interface OutboxMessage {
  readonly eventType: OutboxEventType;
  readonly aggregateType: OutboxAggregateType;
  readonly aggregateId: string;
  /**
   * Charge du message. IDENTIFIANTS ET RIEN D'AUTRE, sauf nécessité démontrée : la charge
   * est recopiée dans les journaux du fournisseur d'envoi (0005_outbox.sql). Ni nom, ni
   * numéro d'immatriculation, ni position, ni téléphone. Le service d'envoi relit
   * l'agrégat s'il a besoin de son contenu, avec les droits qui vont avec.
   */
  readonly payload?: Record<string, unknown> | undefined;
}

const INSERT_OUTBOX_MESSAGE = `
  INSERT INTO public.outbox (event_type, aggregate_type, aggregate_id, payload)
  VALUES ($1, $2, $3, $4::jsonb)
  RETURNING id
`;

interface OutboxIdRow {
  readonly id: string;
}

/**
 * Empile un message et renvoie son identifiant.
 *
 * Aucune capture d'erreur, volontairement : si l'écriture échoue, la transaction doit
 * échouer avec elle. Absorber l'échec produirait une mutation validée dont la
 * notification a disparu en silence, ce qui est précisément ce que l'outbox existe pour
 * empêcher.
 */
export async function enqueueOutboxMessage(
  executor: SqlExecutor,
  message: OutboxMessage,
): Promise<string> {
  const result = await executor.query<OutboxIdRow>(INSERT_OUTBOX_MESSAGE, [
    message.eventType,
    message.aggregateType,
    message.aggregateId,
    JSON.stringify(message.payload ?? {}),
  ]);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Insertion d'un message d'outbox sans ligne retournee : ecriture inattendue.");
  }
  return row.id;
}

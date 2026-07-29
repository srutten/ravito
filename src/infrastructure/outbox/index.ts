/**
 * Surface publique de la file transactionnelle.
 *
 * Une seule fonction, et c'est volontaire : `enqueueOutboxMessage` exige un exécutant,
 * donc une transaction ouverte par l'appelant. Aucune variante « hors transaction » n'est
 * exposée, parce qu'elle serait immédiatement le chemin le plus court vers une
 * notification émise pour une mutation annulée.
 */

export type {
  OutboxAggregateType,
  OutboxEventType,
  OutboxMessage,
} from '@/infrastructure/outbox/outbox';
export { enqueueOutboxMessage } from '@/infrastructure/outbox/outbox';

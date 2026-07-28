import { getServerConfig } from '@/config/env';
import type { CodeDelivery } from '@/domain/identity/code-delivery';
import { LoggingCodeDelivery } from '@/infrastructure/identity/logging-code-delivery';
import {
  assertSmtpTransportIsAcceptable,
  SmtpCodeDelivery,
} from '@/infrastructure/identity/smtp-code-delivery';
import { readSmtpConfig } from '@/infrastructure/identity/smtp-config';
import { logger } from '@/observability/logger';

/**
 * Choix de l'adaptateur de livraison, PAR LA CONFIGURATION et jamais en dur.
 *
 * Règle : SMTP configuré, on envoie ; SMTP absent, on retombe sur la journalisation.
 * Le repli n'est silencieux qu'en local. Hors poste local, il est signalé au niveau
 * `error` avec le code `SERVICE_UNAVAILABLE`, qui déclenche l'alerte « SMS en échec » de
 * `docs/observability.md` transposée au courriel — parce qu'un repli non signalé
 * signifierait que plus personne ne peut se connecter, sans que rien ne le dise.
 *
 * Ce module NE FAIT PAS échouer le démarrage lorsque SMTP manque en production, et c'est
 * délibéré : `getCodeDelivery` est appelé sur le chemin d'une commande publique. Lever
 * ici changerait la durée et la forme de la réponse selon l'état du transport, ce qui est
 * exactement ce que le critère 7 interdit. Le bon endroit pour refuser de démarrer est
 * `src/config/env.ts`, qui rendra `SMTP_HOST` et `SMTP_FROM` obligatoires hors local
 * quand les variables y entreront.
 *
 * L'instance est mémoïsée sur un registre global : `nodemailer` maintient un pool de
 * connexions, et un adaptateur reconstruit à chaque demande de code rouvrirait une
 * connexion SMTP par appel — le rechargement à chaud de Next suffirait à saturer le
 * serveur d'envoi.
 */

const DELIVERY_SINGLETON_KEY = Symbol.for('appui-feux.identity.code-delivery');

interface DeliveryRegistry {
  [DELIVERY_SINGLETON_KEY]?: CodeDelivery;
}

const registry = globalThis as unknown as DeliveryRegistry;

function buildDelivery(): CodeDelivery {
  let smtp: ReturnType<typeof readSmtpConfig>;
  try {
    smtp = readSmtpConfig(process.env);
  } catch (error) {
    // Configuration commencée mais invalide : le message nomme les variables fautives et
    // ne reproduit aucune valeur. On retombe sur la journalisation plutôt que d'empêcher
    // toute demande de code, mais l'anomalie est bruyante.
    logger.error(
      { err: error, module: 'identity', errorCode: 'SERVICE_UNAVAILABLE' },
      'configuration SMTP invalide : repli sur la journalisation',
    );
    return new LoggingCodeDelivery();
  }

  if (smtp === undefined) {
    const environment = readEnvironment();
    if (environment !== 'local') {
      // `environment` est déjà un champ de base du journal : le répéter dupliquerait la
      // clé dans la ligne JSON.
      logger.error(
        { module: 'identity', errorCode: 'SERVICE_UNAVAILABLE' },
        'aucun transport SMTP configure hors poste local : aucun code de connexion ne sera remis',
      );
    }
    return new LoggingCodeDelivery();
  }

  assertSmtpTransportIsAcceptable(smtp);
  logger.info(
    { module: 'identity', transport: 'smtp', host: smtp.host, port: smtp.port },
    'transport de code de connexion configure',
  );
  return new SmtpCodeDelivery(smtp);
}

function readEnvironment(): string {
  try {
    return getServerConfig().appEnvironment;
  } catch {
    return 'inconnu';
  }
}

/** Adaptateur par défaut, résolu une fois par processus. */
export function resolveDefaultCodeDelivery(): CodeDelivery {
  const existing = registry[DELIVERY_SINGLETON_KEY];
  if (existing !== undefined) {
    return existing;
  }
  const delivery = buildDelivery();
  registry[DELIVERY_SINGLETON_KEY] = delivery;
  return delivery;
}

/** Oublie l'adaptateur mémoïsé. Réservé aux tests qui changent la configuration. */
export function resetDefaultCodeDelivery(): void {
  delete registry[DELIVERY_SINGLETON_KEY];
}

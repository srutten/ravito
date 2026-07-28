import { getServerConfig } from '@/config/env';
import type { CodeDelivery, SignInCodeMessage } from '@/domain/identity/code-delivery';
import { maskIdentifier } from '@/domain/identity/identifier';
import { logger } from '@/observability/logger';

/**
 * Adaptateur de repli : le code n'est pas envoyé, il est signalé.
 *
 * Il sert un seul cas légitime, le poste de développement sans serveur d'envoi. Il est
 * néanmoins écrit pour le cas illégitime, celui où il serait sélectionné par erreur en
 * staging ou en production faute de configuration SMTP.
 *
 * LA RÈGLE ABSOLUE DE CE FICHIER : le code n'apparaît dans un journal QUE si
 * `appEnvironment` vaut `local`. Ailleurs, la ligne dit qu'un envoi n'a pas eu lieu et
 * ne dit pas quoi. Un journal n'est pas un canal privé — il est agrégé, expédié à un
 * service tiers, conservé, consulté par des exploitants et repris dans des sauvegardes.
 * Y écrire un code de connexion transformerait l'accès aux journaux en accès à tous les
 * comptes, ce qui contredit `docs/observability.md` et ruinerait ADR-015.
 *
 * La vérification est faite à CHAQUE envoi et non une fois à la construction : un
 * adaptateur construit en local puis réutilisé dans un autre contexte doit se
 * reconfigurer, pas conserver une décision périmée.
 */
export class LoggingCodeDelivery implements CodeDelivery {
  send(message: SignInCodeMessage): Promise<void> {
    const environment = readEnvironment();
    if (environment === 'local') {
      logger.info(
        {
          module: 'identity',
          transport: 'log',
          challengeId: message.challengeId,
          recipient: maskIdentifier(message.recipient),
          // Poste local uniquement. Aucune autre branche n'écrit cette valeur.
          signInCode: message.code,
          expiresAt: message.expiresAt.toISOString(),
        },
        'aucun transport configure : code de connexion journalise (poste local uniquement)',
      );
      return Promise.resolve();
    }

    // `environment` figure déjà dans les champs de base du journal : le répéter ici
    // produirait une clé dupliquée dans la ligne JSON, que chaque analyseur tranche à sa
    // façon.
    logger.error(
      {
        module: 'identity',
        transport: 'log',
        challengeId: message.challengeId,
        errorCode: 'SERVICE_UNAVAILABLE',
      },
      "aucun transport de code configure : le code n'a pas ete remis et n'est pas journalise",
    );
    return Promise.resolve();
  }
}

/**
 * L'environnement est lu sans jamais faire échouer l'envoi. Si la configuration est
 * illisible, le repli est le plus strict : tout sauf `local`, donc pas de code journalisé.
 */
function readEnvironment(): string {
  try {
    return getServerConfig().appEnvironment;
  } catch {
    return 'inconnu';
  }
}

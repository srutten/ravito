import type { Transporter } from 'nodemailer';
import nodemailer from 'nodemailer';
import { getServerConfig } from '@/config/env';
import type { CodeDelivery, SignInCodeMessage } from '@/domain/identity/code-delivery';
import { maskIdentifier } from '@/domain/identity/identifier';
import type { SmtpConfig } from '@/infrastructure/identity/smtp-config';
import { logger } from '@/observability/logger';

/**
 * Adaptateur d'envoi SMTP (ADR-018).
 *
 * Ce que cet adaptateur ne fait PAS, et qui compte autant que ce qu'il fait :
 * - il n'écrit jamais le code dans un journal, à aucun niveau ;
 * - il n'écrit jamais l'adresse complète du destinataire, seulement sa forme masquée
 *   (docs/observability.md exclut les coordonnées personnelles des journaux) ;
 * - il ne fait remonter aucun accusé d'envoi au domaine. Un échec est journalisé et levé,
 *   la commande appelante l'absorbe : la réponse de l'API ne dépend jamais du succès de
 *   l'envoi (ADR-015), sans quoi la durée de réponse trahirait l'existence du compte.
 *
 * L'objet et le corps ne contiennent aucune donnée sensible autre que le code lui-même :
 * ni nom, ni organisation, ni mission. Un courriel transite par des serveurs et s'affiche
 * en notification sur un écran verrouillé.
 */

const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

function formatExpiry(expiresAt: Date): string {
  return new Intl.DateTimeFormat('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Paris',
  }).format(expiresAt);
}

/**
 * Corps du message. Le rappel de sécurité n'est pas une formule de politesse : un
 * utilisateur qui reçoit un code qu'il n'a pas demandé est le premier témoin d'une
 * tentative sur son compte, et c'est la seule occasion de le lui dire.
 */
function buildTextBody(message: SignInCodeMessage): string {
  return [
    'Bonjour,',
    '',
    `Votre code de connexion à Appui Feux est : ${message.code}`,
    '',
    `Ce code est valable jusqu'à ${formatExpiry(message.expiresAt)} et ne peut servir qu'une seule fois.`,
    '',
    "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : sans le code, personne ne peut ouvrir de session sur votre compte. Aucun membre de l'équipe ne vous demandera jamais ce code.",
    '',
    "Appui Feux — coordination logistique. Ce service ne remplace pas les secours : en cas d'urgence, appelez le 18 ou le 112.",
  ].join('\n');
}

export class SmtpCodeDelivery implements CodeDelivery {
  readonly #transporter: Transporter;
  readonly #from: string;

  constructor(config: SmtpConfig) {
    this.#from = config.from;
    this.#transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      // Sans TLS implicite, STARTTLS est EXIGÉ hors poste local : sans cette exigence,
      // un serveur qui n'annonce pas STARTTLS ferait basculer l'envoi en clair, et le
      // code d'authentification traverserait le réseau lisible.
      requireTLS: !config.secure && !config.allowInsecureTls,
      ...(config.allowInsecureTls ? { tls: { rejectUnauthorized: false } } : {}),
      ...(config.user !== undefined && config.password !== undefined
        ? { auth: { user: config.user, pass: config.password } }
        : {}),
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: GREETING_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
    });
  }

  async send(message: SignInCodeMessage): Promise<void> {
    try {
      await this.#transporter.sendMail({
        from: this.#from,
        to: message.recipient,
        subject: 'Votre code de connexion Appui Feux',
        text: buildTextBody(message),
        headers: {
          // Un code de connexion n'a pas à être classé, indexé ni archivé automatiquement.
          'Auto-Submitted': 'auto-generated',
          'X-Auto-Response-Suppress': 'All',
        },
      });
      logger.info(
        { module: 'identity', challengeId: message.challengeId, transport: 'smtp' },
        'code de connexion remis au transport',
      );
    } catch (error) {
      logger.error(
        {
          err: error,
          module: 'identity',
          challengeId: message.challengeId,
          transport: 'smtp',
          recipient: maskIdentifier(message.recipient),
          errorCode: 'SERVICE_UNAVAILABLE',
        },
        "echec d'envoi du code de connexion",
      );
      throw error;
    }
  }

  /** Ferme le pool de connexions SMTP. Utile aux tests et à un arrêt ordonné. */
  close(): void {
    this.#transporter.close();
  }
}

/**
 * Refus explicite d'un transport non chiffré hors poste local. La vérification est ici
 * plutôt que dans le schéma de configuration parce qu'elle dépend de l'environnement
 * déclaré, et qu'un opérateur doit pouvoir pointer Mailpit en local sans dérogation.
 */
export function assertSmtpTransportIsAcceptable(config: SmtpConfig): void {
  if (getServerConfig().appEnvironment === 'local') {
    return;
  }
  if (config.allowInsecureTls) {
    throw new Error(
      "SMTP_ALLOW_INSECURE_TLS est interdit hors environnement local : un certificat non verifie expose les codes d'authentification.",
    );
  }
}

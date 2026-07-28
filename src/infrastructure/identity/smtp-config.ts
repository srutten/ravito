import { z } from 'zod';

/**
 * Configuration du transport SMTP.
 *
 * Elle est lue et validée ici, et non dans `src/config/env.ts`, pour une raison de
 * périmètre de livraison : ce fichier appartient au lot 1, `env.ts` au lot 0. Le
 * mécanisme est le même — schéma explicite, valeur jamais reproduite dans un message
 * d'erreur — et la configuration a vocation à rejoindre `env.ts` avec les autres, en
 * même temps que les variables entreront dans `.env.example`.
 *
 * Règle appliquée : une configuration PARTIELLE est un refus, pas un repli. Un `SMTP_HOST`
 * renseigné sans expéditeur donnerait un adaptateur qui échoue à chaque envoi, donc une
 * authentification muette. Mieux vaut dire lesquelles des variables vont ensemble.
 */

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  /** TLS implicite dès la connexion. Faux, la connexion est promue par STARTTLS. */
  readonly secure: boolean;
  readonly from: string;
  readonly user?: string;
  readonly password?: string;
  /**
   * Autorise un certificat non vérifiable. Réservé au poste local, où Mailpit présente un
   * certificat auto-signé ou pas de TLS du tout. Toute autre valeur qu'un environnement
   * local est refusée : accepter un certificat inconnu en production reviendrait à
   * envoyer des codes d'authentification à qui se place sur le chemin.
   */
  readonly allowInsecureTls: boolean;
}

/** Variables lues. Elles vont par groupes, voir `readSmtpConfig`. */
export const SMTP_VARIABLES = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_FROM',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'SMTP_ALLOW_INSECURE_TLS',
] as const;

const DEFAULT_SMTP_PORT = 587;
const IMPLICIT_TLS_PORT = 465;

const booleanSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.enum(['true', '1', 'on', 'yes', 'false', '0', 'off', 'no']))
  .transform((value) => ['true', '1', 'on', 'yes'].includes(value));

const portSchema = z
  .string()
  .regex(/^\d+$/, { message: 'Numéro de port entier attendu.' })
  .transform((value) => Number.parseInt(value, 10))
  .refine((value) => value >= 1 && value <= 65_535, {
    message: 'Numéro de port hors bornes.',
  });

const hostSchema = z.string().trim().min(1, { message: "Nom d'hôte attendu." });

/**
 * Expéditeur, sous la forme `Nom <adresse>` ou `adresse`. Les retours à la ligne sont
 * refusés explicitement : un en-tête d'expéditeur contenant `\r\n` permettrait d'injecter
 * des en-têtes supplémentaires dans le message, donc d'y ajouter des destinataires.
 */
const fromSchema = z
  .string()
  .trim()
  .min(3, { message: 'Expéditeur attendu.' })
  .max(320, { message: 'Expéditeur trop long.' })
  .refine((value) => !/[\r\n]/.test(value), {
    message: 'Expéditeur invalide : retour à la ligne interdit dans un en-tête.',
  });

export class SmtpConfigurationError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[], reason: string) {
    super(`Configuration SMTP invalide (${variables.join(', ')}) : ${reason}`);
    this.name = 'SmtpConfigurationError';
    this.variables = variables;
  }
}

function readOptional(
  source: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const raw = source[name];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Lit la configuration SMTP. Renvoie `undefined` lorsque AUCUNE variable n'est
 * renseignée : c'est le cas nominal d'un poste local sans serveur d'envoi, et il conduit
 * à l'adaptateur de journalisation.
 *
 * Lève `SmtpConfigurationError` lorsque la configuration est commencée mais incomplète ou
 * illisible. Aucune valeur lue n'apparaît dans le message.
 */
export function readSmtpConfig(source: Record<string, string | undefined>): SmtpConfig | undefined {
  const provided = SMTP_VARIABLES.filter((name) => readOptional(source, name) !== undefined);
  if (provided.length === 0) {
    return undefined;
  }

  const rawHost = readOptional(source, 'SMTP_HOST');
  const rawFrom = readOptional(source, 'SMTP_FROM');
  if (rawHost === undefined || rawFrom === undefined) {
    throw new SmtpConfigurationError(
      ['SMTP_HOST', 'SMTP_FROM'],
      "configuration commencee mais incomplete, l'hote et l'expediteur vont ensemble",
    );
  }

  const host = hostSchema.safeParse(rawHost);
  if (!host.success) {
    throw new SmtpConfigurationError(['SMTP_HOST'], "nom d'hote invalide");
  }
  const from = fromSchema.safeParse(rawFrom);
  if (!from.success) {
    throw new SmtpConfigurationError(['SMTP_FROM'], 'expediteur invalide');
  }

  const rawPort = readOptional(source, 'SMTP_PORT');
  let port = DEFAULT_SMTP_PORT;
  if (rawPort !== undefined) {
    const parsed = portSchema.safeParse(rawPort);
    if (!parsed.success) {
      throw new SmtpConfigurationError(['SMTP_PORT'], 'numero de port invalide');
    }
    port = parsed.data;
  }

  const rawSecure = readOptional(source, 'SMTP_SECURE');
  let secure = port === IMPLICIT_TLS_PORT;
  if (rawSecure !== undefined) {
    const parsed = booleanSchema.safeParse(rawSecure);
    if (!parsed.success) {
      throw new SmtpConfigurationError(['SMTP_SECURE'], 'valeur booleenne attendue');
    }
    secure = parsed.data;
  }

  const user = readOptional(source, 'SMTP_USER');
  const password = readOptional(source, 'SMTP_PASSWORD');
  if ((user === undefined) !== (password === undefined)) {
    throw new SmtpConfigurationError(
      ['SMTP_USER', 'SMTP_PASSWORD'],
      "identifiants incomplets, l'utilisateur et le mot de passe vont ensemble",
    );
  }

  const rawAllowInsecure = readOptional(source, 'SMTP_ALLOW_INSECURE_TLS');
  let allowInsecureTls = false;
  if (rawAllowInsecure !== undefined) {
    const parsed = booleanSchema.safeParse(rawAllowInsecure);
    if (!parsed.success) {
      throw new SmtpConfigurationError(['SMTP_ALLOW_INSECURE_TLS'], 'valeur booleenne attendue');
    }
    allowInsecureTls = parsed.data;
  }

  // `exactOptionalPropertyTypes` : une propriété facultative est omise, jamais posée à undefined.
  return {
    host: host.data,
    port,
    secure,
    from: from.data,
    allowInsecureTls,
    ...(user !== undefined ? { user } : {}),
    ...(password !== undefined ? { password } : {}),
  };
}

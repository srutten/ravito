import { hashAttemptSubject } from '@/domain/identity/hashing';
import type { AttemptPolicy } from '@/domain/identity/policy';
import type { SqlExecutor } from '@/infrastructure/identity/unit-of-work';

/**
 * Limitation de tentatives (docs/security.md, écran 2 de docs/screens.md).
 *
 * TOUT TIENT DANS UN SEUL ÉNONCÉ SQL, et ce n'est pas une coquetterie. Lire le compteur
 * puis décider puis écrire laisse, entre la lecture et l'écriture, la place d'exactement
 * autant de tentatives simultanées que l'attaquant en lance : la limitation ne
 * s'appliquerait qu'aux utilisateurs honnêtes, qui n'envoient qu'une requête à la fois.
 * L'`INSERT ... ON CONFLICT DO UPDATE` sérialise les concurrents sur le verrou de ligne
 * et rend le comptage exact.
 *
 * TROIS ÉTATS DANS LE MÊME ÉNONCÉ, d'où les `CASE` répétés :
 *   1. sujet déjà bloqué et blocage en cours — rien ne bouge, le compteur est gelé et le
 *      blocage n'est pas prolongé. Prolonger à chaque tentative rendrait le blocage
 *      indéfini pour qui insiste, donc une arme de déni de service contre un
 *      coordinateur : il suffirait de marteler son adresse pour l'exclure en pleine
 *      opération ;
 *   2. fenêtre écoulée — la ligne est réutilisée, le compteur repart à un, le blocage
 *      éventuel est levé ;
 *   3. fenêtre en cours — incrément, et blocage si le seuil est atteint.
 *
 * NEUTRALITÉ : le sujet est une empreinte. La politique, les seuils et la durée de
 * blocage sont identiques qu'un compte existe ou non derrière l'identifiant. Un compteur
 * qui ne s'appliquerait qu'aux comptes existants serait lui-même un oracle d'énumération
 * (docs/api-contract.md).
 */

export interface AttemptDecision {
  /** `false` lorsque le sujet est bloqué : l'appelant doit répondre `RATE_LIMITED`. */
  readonly allowed: boolean;
  /** Secondes restantes avant la fin du blocage. Zéro lorsque `allowed` vaut `true`. */
  readonly retryAfterSeconds: number;
  /** Nombre de tentatives comptées dans la fenêtre courante. */
  readonly attemptCount: number;
  /**
   * `true` uniquement à l'appel qui a fait franchir le seuil. Sert à n'écrire qu'une
   * seule ligne d'audit par blocage : un appelant non authentifié ne doit pas pouvoir
   * faire grossir la table de preuve à volonté (docs/api-contract.md).
   */
  readonly justBlocked: boolean;
  /** Empreinte du sujet, joignable à l'audit. Jamais le sujet lui-même. */
  readonly subjectHash: string;
}

/**
 * QUATRE ÉTATS, TRAITÉS DANS LE MÊME ORDRE PAR LES TROIS `CASE`. L'ordre des branches est
 * la logique elle-même ; les intervertir change le comportement en silence.
 *
 *   1. `blocked_until > now()` — blocage en cours. La date de blocage n'est JAMAIS
 *      prolongée : prolonger à chaque tentative rendrait le blocage indéfini pour qui
 *      insiste, donc une arme de déni de service contre un coordinateur qu'il suffirait
 *      de marteler pour l'exclure en pleine opération. Le compteur, lui, continue de
 *      monter : il mesure l'intensité de la campagne, ce que `docs/observability.md`
 *      demande de détecter, et c'est aussi ce qui rend le point 4 ci-dessous exact.
 *   2. `blocked_until IS NOT NULL` — le blocage vient de s'écouler. Fenêtre neuve,
 *      compteur à un, blocage levé. Cette branche rend la politique indépendante du
 *      rapport entre durée de blocage et durée de fenêtre : sans elle, une durée de
 *      blocage plus courte que la fenêtre ferait re-bloquer le sujet dès sa première
 *      tentative suivante, indéfiniment.
 *   3. fenêtre écoulée — la ligne est réutilisée, compteur à un.
 *   4. cas courant — incrément, et blocage si le seuil est franchi.
 *
 * DÉTECTION DU BASCULEMENT, SANS COURSE. `justBlocked` ne se déduit pas d'une lecture de
 * l'état précédent : sous rafale, plusieurs énoncés liraient tous « pas encore bloqué »
 * dans leur propre instantané et se croiraient tous responsables du blocage, ce qui
 * multiplierait les écritures d'audit — exactement ce que l'audit borné cherche à
 * éviter. Elle se déduit du compteur : le verrou de ligne de `ON CONFLICT` sérialise les
 * concurrents, donc chaque énoncé obtient une valeur de compteur DIFFÉRENTE, et un seul
 * obtient `maxAttempts + 1`. C'est celui-là, et lui seul, qui a posé le blocage.
 */
const CONSUME_ATTEMPT = `
  INSERT INTO public.auth_attempts (subject_hash, window_started_at, attempt_count, blocked_until)
  VALUES ($1, now(), 1, NULL)
  ON CONFLICT (subject_hash) DO UPDATE SET
    window_started_at = CASE
      WHEN public.auth_attempts.blocked_until > now() THEN public.auth_attempts.window_started_at
      WHEN public.auth_attempts.blocked_until IS NOT NULL THEN now()
      WHEN public.auth_attempts.window_started_at < now() - ($2 || ' seconds')::interval THEN now()
      ELSE public.auth_attempts.window_started_at
    END,
    attempt_count = CASE
      WHEN public.auth_attempts.blocked_until > now() THEN public.auth_attempts.attempt_count + 1
      WHEN public.auth_attempts.blocked_until IS NOT NULL THEN 1
      WHEN public.auth_attempts.window_started_at < now() - ($2 || ' seconds')::interval THEN 1
      ELSE public.auth_attempts.attempt_count + 1
    END,
    blocked_until = CASE
      WHEN public.auth_attempts.blocked_until > now() THEN public.auth_attempts.blocked_until
      WHEN public.auth_attempts.blocked_until IS NOT NULL THEN NULL
      WHEN public.auth_attempts.window_started_at < now() - ($2 || ' seconds')::interval THEN NULL
      -- STRICTEMENT SUPÉRIEUR, et l'écart d'un cran compte : maxAttempts est le nombre de
      -- tentatives TOLÉRÉES dans la fenêtre, pas le rang de la première refusée. Avec un
      -- test large, un plafond annoncé à cinq n'en laisserait passer que quatre — un
      -- utilisateur qui a droit à cinq essais serait bloqué au cinquième, celui-là même
      -- que la politique lui accordait.
      WHEN public.auth_attempts.attempt_count + 1 > $3 THEN now() + ($4 || ' seconds')::interval
      ELSE NULL
    END
  RETURNING attempt_count,
            blocked_until,
            GREATEST(0, CEIL(EXTRACT(EPOCH FROM (blocked_until - now()))))::int AS retry_after_seconds
`;

interface AttemptRow {
  readonly attempt_count: number;
  readonly blocked_until: Date | null;
  readonly retry_after_seconds: number | null;
}

/**
 * Consomme une tentative pour un sujet et renvoie la décision.
 *
 * `subject` est la valeur en clair — identifiant normalisé, adresse d'appel. Elle n'est
 * jamais écrite : `hashAttemptSubject` impose le marqueur de dimension et le HMAC avant
 * qu'elle n'atteigne la base.
 *
 * L'appel doit se faire HORS de la transaction métier. Une tentative annulée avec la
 * transaction ne serait pas comptée, et il suffirait alors de provoquer une erreur pour
 * disposer d'un nombre d'essais illimité.
 */
export async function consumeAttempt(
  executor: SqlExecutor,
  policy: AttemptPolicy,
  subject: string,
): Promise<AttemptDecision> {
  const subjectHash = hashAttemptSubject(policy.dimension, policy.purpose, subject);
  const result = await executor.query<AttemptRow>(CONSUME_ATTEMPT, [
    subjectHash,
    String(policy.windowSeconds),
    policy.maxAttempts,
    String(policy.blockSeconds),
  ]);
  const row = result.rows[0];
  if (row === undefined) {
    // Inatteignable : `ON CONFLICT DO UPDATE` renvoie toujours une ligne. Le refus est
    // le défaut sûr si cette invariante venait à changer.
    return {
      allowed: false,
      retryAfterSeconds: policy.blockSeconds,
      attemptCount: 0,
      justBlocked: false,
      subjectHash,
    };
  }
  const now = Date.now();
  const blockedUntil = row.blocked_until;
  const blocked = blockedUntil !== null && blockedUntil.getTime() > now;
  // Un seul énoncé peut obtenir cette valeur de compteur : voir l'en-tête de la requête.
  const wasBlocked = blocked && row.attempt_count !== policy.maxAttempts + 1;
  return {
    allowed: !blocked,
    retryAfterSeconds: blocked ? Math.max(1, row.retry_after_seconds ?? 0) : 0,
    attemptCount: row.attempt_count,
    justBlocked: blocked && !wasBlocked,
    subjectHash,
  };
}

/**
 * Remet à zéro le compteur d'un sujet après une authentification réussie.
 *
 * Appliqué au seul sujet « identifiant ». La source n'est jamais remise à zéro : sinon,
 * un attaquant disposant d'un compte à lui viderait le compteur de son adresse d'appel à
 * chaque connexion réussie, et pourrait reprendre indéfiniment ses tentatives contre
 * d'autres comptes depuis la même origine.
 *
 * La remise à zéro ne lève pas un blocage en cours : `blocked_until` n'est pas touché.
 * Une réussite pendant un blocage n'est pas censée arriver, et si elle arrivait, elle ne
 * doit pas servir de moyen de le lever.
 */
export async function resetAttempts(
  executor: SqlExecutor,
  policy: AttemptPolicy,
  subject: string,
): Promise<void> {
  const subjectHash = hashAttemptSubject(policy.dimension, policy.purpose, subject);
  await executor.query(
    `
      UPDATE public.auth_attempts
         SET attempt_count = 0,
             window_started_at = now()
       WHERE subject_hash = $1
         AND (blocked_until IS NULL OR blocked_until <= now())
    `,
    [subjectHash],
  );
}

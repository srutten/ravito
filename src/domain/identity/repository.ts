import type { UserProfileStatus, UserVerificationLevel } from '@/domain/identity/types';
import type { SqlExecutor } from '@/infrastructure/identity/unit-of-work';

/**
 * Accès aux quatre tables d'identité.
 *
 * Toutes les requêtes sont ici, aucune ailleurs. La raison n'est pas l'esthétique en
 * couches : plusieurs de ces énoncés portent une garantie de concurrence qui tient à leur
 * rédaction exacte — la consommation atomique du défi, la remise à jour conditionnelle
 * d'une session. Un énoncé recopié ailleurs et légèrement modifié perdrait la garantie
 * sans qu'aucun test unitaire ne s'en aperçoive.
 */

export interface UserProfileRow {
  readonly id: string;
  readonly display_name: string;
  readonly preferred_language: string;
  readonly verification_level: UserVerificationLevel;
  readonly status: UserProfileStatus;
  readonly sessions_revoked_at: Date | null;
}

export interface ChallengeRow {
  readonly id: string;
  readonly identifier_hash: string;
  readonly code_hash: string;
  readonly user_profile_id: string | null;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
}

export interface SessionRow {
  readonly id: string;
  readonly user_profile_id: string;
  readonly issued_at: Date;
  readonly last_seen_at: Date;
  readonly expires_at: Date;
}

export interface AuthenticatedSessionRow extends SessionRow {
  readonly display_name: string;
  readonly preferred_language: string;
  readonly verification_level: UserVerificationLevel;
}

/**
 * Recherche un compte par identifiant normalisé.
 *
 * Exécutée MÊME lorsque l'appelant sait déjà que le résultat ne changera pas la réponse :
 * la neutralité de durée du critère 7 suppose que les deux branches fassent le même
 * travail (docs/api-contract.md). Court-circuiter cette lecture quand elle « ne sert à
 * rien » rendrait la branche « identifiant inconnu » mesurablement plus rapide.
 *
 * La comparaison est servie par `uq_user_profiles_email`, sur un type `citext` : elle est
 * insensible à la casse côté serveur, en plus de la normalisation applicative.
 */
export async function findProfileByEmail(
  executor: SqlExecutor,
  normalizedEmail: string,
): Promise<UserProfileRow | undefined> {
  const result = await executor.query<UserProfileRow>(
    `
      SELECT id, display_name, preferred_language, verification_level, status, sessions_revoked_at
        FROM public.user_profiles
       WHERE email = $1::citext
       LIMIT 1
    `,
    [normalizedEmail],
  );
  return result.rows[0];
}

export async function findProfileById(
  executor: SqlExecutor,
  userId: string,
): Promise<UserProfileRow | undefined> {
  const result = await executor.query<UserProfileRow>(
    `
      SELECT id, display_name, preferred_language, verification_level, status, sessions_revoked_at
        FROM public.user_profiles
       WHERE id = $1
       LIMIT 1
    `,
    [userId],
  );
  return result.rows[0];
}

/**
 * Crée un défi.
 *
 * `userProfileId` vaut `null` lorsque l'identifiant n'est rattaché à aucun compte : la
 * colonne est nullable à dessein, c'est la mise en œuvre du critère 7
 * (0011_auth-challenges.sql).
 *
 * L'identifiant du défi est FOURNI par l'appelant plutôt que tiré par la base. Ce n'est
 * pas un détail : l'empreinte du code est liée à l'identifiant du défi avant hachage, et
 * laisser la base tirer l'identifiant obligerait à insérer une empreinte provisoire puis
 * à la corriger par une seconde écriture. Une empreinte provisoire est une empreinte
 * fausse en base, fût-ce une milliseconde. Le tirage applicatif est cryptographique
 * (`crypto.randomUUID`), au même titre que celui de `gen_random_uuid`.
 */
export async function insertChallenge(
  executor: SqlExecutor,
  input: {
    readonly id: string;
    readonly identifierHash: string;
    readonly codeHash: string;
    readonly userProfileId: string | null;
    readonly maxAttempts: number;
    readonly ttlSeconds: number;
  },
): Promise<string> {
  const result = await executor.query<{ id: string }>(
    `
      INSERT INTO public.auth_challenges (
        id, identifier_hash, code_hash, user_profile_id, max_attempts, expires_at
      )
      VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' seconds')::interval)
      RETURNING id
    `,
    [
      input.id,
      input.identifierHash,
      input.codeHash,
      input.userProfileId,
      input.maxAttempts,
      String(input.ttlSeconds),
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Insertion du defi sans ligne retournee : contrainte d'ecriture inattendue.");
  }
  return row.id;
}

export async function findChallengeById(
  executor: SqlExecutor,
  challengeId: string,
): Promise<ChallengeRow | undefined> {
  const result = await executor.query<ChallengeRow>(
    `
      SELECT id, identifier_hash, code_hash, user_profile_id,
             attempts, max_attempts, expires_at, consumed_at
        FROM public.auth_challenges
       WHERE id = $1
       LIMIT 1
    `,
    [challengeId],
  );
  return result.rows[0];
}

/**
 * CONSOMMATION ATOMIQUE DU DÉFI. C'est l'énoncé le plus important du module.
 *
 * Toutes les conditions d'acceptation sont dans le `WHERE` d'une SEULE mise à jour :
 * bonne empreinte, non consommé, non expiré, plafond d'essais non atteint. Deux
 * vérifications simultanées du même code ne peuvent donc ouvrir qu'une session.
 * PostgreSQL sérialise les deux mises à jour sur le verrou de ligne ; la seconde, une
 * fois le verrou obtenu, réévalue son `WHERE` sur la version à jour de la ligne, y lit
 * `consumed_at` renseigné et ne met à jour aucune ligne.
 *
 * Écrire `SELECT ... FOR UPDATE` puis décider puis `UPDATE` donnerait le même résultat
 * ici, mais au prix d'une garantie déplacée dans le code appelant, où le prochain
 * remaniement peut la perdre. Le plafond d'essais est appliqué AVANT l'incrément, comme
 * l'exige 0011 : aucune contrainte SQL ne le fait à notre place, précisément pour que le
 * dépassement ne produise pas une erreur distinguable.
 *
 * `attempts < max_attempts` porte sur la valeur d'avant l'essai courant : avec
 * `max_attempts = 5`, cinq essais erronés sont possibles et le sixième est refusé.
 */
export async function consumeChallenge(
  executor: SqlExecutor,
  input: { readonly challengeId: string; readonly codeHash: string },
): Promise<{ readonly id: string; readonly user_profile_id: string | null } | undefined> {
  const result = await executor.query<{ id: string; user_profile_id: string | null }>(
    `
      UPDATE public.auth_challenges
         SET consumed_at = now()
       WHERE id = $1
         AND code_hash = $2
         AND consumed_at IS NULL
         AND expires_at > now()
         AND attempts < max_attempts
      RETURNING id, user_profile_id
    `,
    [input.challengeId, input.codeHash],
  );
  return result.rows[0];
}

/**
 * Compte un essai erroné.
 *
 * L'incrément est calculé PAR LE SERVEUR (`attempts + 1`) sous le verrou de ligne, jamais
 * à partir d'une valeur lue plus tôt : deux essais simultanés liraient la même valeur et
 * n'en compteraient qu'un.
 *
 * Aucune condition autre que l'identité de la ligne. Restreindre l'incrément aux défis
 * non consommés créerait une différence de travail entre « code déjà consommé » et
 * « code erroné », alors que le critère 7 exige que les quatre cas d'échec soient
 * indiscernables. Incrémenter le compteur d'un défi déjà consommé est sans effet : il
 * n'est de toute façon plus acceptable.
 */
export async function incrementChallengeAttempts(
  executor: SqlExecutor,
  challengeId: string,
): Promise<void> {
  await executor.query(
    `
      UPDATE public.auth_challenges
         SET attempts = attempts + 1
       WHERE id = $1
    `,
    [challengeId],
  );
}

/**
 * Ouvre une session.
 *
 * `expires_at` porte la fin de la fenêtre d'INACTIVITÉ, bornée par la fin de vie absolue.
 * La fin de vie absolue n'est pas stockée : elle se déduit de `issued_at`, qui n'est
 * jamais réavancé (0013_sessions.sql). Deux colonnes pour deux échéances laisseraient la
 * porte ouverte à ce que l'une soit repoussée sans l'autre.
 */
export async function insertSession(
  executor: SqlExecutor,
  input: {
    readonly userProfileId: string;
    readonly tokenHash: string;
    readonly idleTtlSeconds: number;
    readonly absoluteTtlSeconds: number;
    readonly userAgentSummary: string | null;
    readonly ipHash: string | null;
  },
): Promise<SessionRow> {
  const result = await executor.query<SessionRow>(
    `
      INSERT INTO public.sessions (
        user_profile_id, token_hash, issued_at, last_seen_at, expires_at,
        user_agent_summary, ip_hash
      )
      VALUES (
        $1, $2, now(), now(),
        LEAST(now() + ($3 || ' seconds')::interval, now() + ($4 || ' seconds')::interval),
        $5, $6
      )
      RETURNING id, user_profile_id, issued_at, last_seen_at, expires_at
    `,
    [
      input.userProfileId,
      input.tokenHash,
      String(input.idleTtlSeconds),
      String(input.absoluteTtlSeconds),
      input.userAgentSummary,
      input.ipHash,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('Insertion de session sans ligne retournee : ecriture inattendue.');
  }
  return row;
}

/**
 * Charge la session désignée par une empreinte de jeton, à la condition qu'elle soit
 * valide.
 *
 * LES QUATRE CONDITIONS DE VALIDITÉ sont dans cet énoncé, et nulle part ailleurs
 * (0013_sessions.sql) :
 *   1. `revoked_at IS NULL` — pas de déconnexion individuelle ;
 *   2. `expires_at > now()` — pas d'expiration ;
 *   3. `issued_at > sessions_revoked_at` — pas de révocation globale, comparaison
 *      STRICTE : une session émise à l'instant exact de la révocation est invalide ;
 *   4. `status = 'ACTIVE'` — le compte n'est ni suspendu ni clos.
 *
 * La quatrième porte sur une autre table et c'est celle qu'on oublie. Sans elle, la
 * suspension d'un coordinateur compromis ne couperait rien tant que son onglet reste
 * ouvert, alors que c'est la première mesure de réponse à incident de docs/security.md et
 * un cas de test obligatoire de docs/permissions.md.
 *
 * POINT D'EXTENSION : docs/permissions.md exige aussi qu'une adhésion suspendue coupe
 * l'accès. Cette cinquième condition n'est PAS réalisable au lot 1,
 * `organization_members` n'existant pas (US-012, US-014). Le lot qui crée la table doit
 * ajouter la jointure ici, et un test d'accès dédié.
 */
export async function findValidSessionByTokenHash(
  executor: SqlExecutor,
  tokenHash: string,
): Promise<AuthenticatedSessionRow | undefined> {
  const result = await executor.query<AuthenticatedSessionRow>(
    `
      SELECT s.id, s.user_profile_id, s.issued_at, s.last_seen_at, s.expires_at,
             p.display_name, p.preferred_language, p.verification_level
        FROM public.sessions s
        JOIN public.user_profiles p ON p.id = s.user_profile_id
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > now()
         AND p.status = 'ACTIVE'
         AND (p.sessions_revoked_at IS NULL OR s.issued_at > p.sessions_revoked_at)
       LIMIT 1
    `,
    [tokenHash],
  );
  return result.rows[0];
}

/**
 * Prolonge la fenêtre d'inactivité d'une session encore valide.
 *
 * Trois propriétés portées par l'énoncé lui-même :
 * - la nouvelle échéance est bornée par la fin de vie absolue, `issued_at` faisant foi.
 *   Une session ne peut donc pas se maintenir indéfiniment par simple activité ;
 * - `issued_at` n'est jamais touché. Le réavancer ferait redevenir valide une session
 *   révoquée globalement, par le seul fait qu'elle se rafraîchit ;
 * - les conditions de validité sont répétées dans le `WHERE`. Sans elles, une session
 *   expirée entre la lecture et l'écriture serait ressuscitée par sa propre prolongation.
 *
 * L'écriture est espacée d'au moins `throttleSeconds` : sans ce palier, chaque lecture
 * authentifiée deviendrait une écriture.
 */
export async function touchSession(
  executor: SqlExecutor,
  input: {
    readonly sessionId: string;
    readonly idleTtlSeconds: number;
    readonly absoluteTtlSeconds: number;
    readonly throttleSeconds: number;
  },
): Promise<void> {
  await executor.query(
    `
      UPDATE public.sessions
         SET last_seen_at = now(),
             expires_at = LEAST(
               now() + ($2 || ' seconds')::interval,
               issued_at + ($3 || ' seconds')::interval
             )
       WHERE id = $1
         AND revoked_at IS NULL
         AND expires_at > now()
         AND last_seen_at < now() - ($4 || ' seconds')::interval
    `,
    [
      input.sessionId,
      String(input.idleTtlSeconds),
      String(input.absoluteTtlSeconds),
      String(input.throttleSeconds),
    ],
  );
}

/**
 * Révoque la session désignée par une empreinte de jeton. La ligne est marquée, jamais
 * supprimée : la trace d'une session ayant existé fait partie de ce qui permet de
 * reconstituer un incident.
 *
 * `revoked_at IS NULL` rend l'opération idempotente : une seconde déconnexion ne renvoie
 * aucune ligne, donc n'écrit pas une seconde ligne d'audit.
 */
export async function revokeSessionByTokenHash(
  executor: SqlExecutor,
  tokenHash: string,
): Promise<{ readonly id: string; readonly user_profile_id: string } | undefined> {
  const result = await executor.query<{ id: string; user_profile_id: string }>(
    `
      UPDATE public.sessions
         SET revoked_at = now()
       WHERE token_hash = $1
         AND revoked_at IS NULL
      RETURNING id, user_profile_id
    `,
    [tokenHash],
  );
  return result.rows[0];
}

/**
 * Nombre de sessions RÉELLEMENT VALIDES d'un compte, selon le même prédicat que
 * `findValidSessionByTokenHash`.
 *
 * Les quatre conditions sont indispensables ici, et l'oubli de la troisième est un piège
 * réel : la révocation globale n'écrit pas dans `sessions`, elle avance
 * `sessions_revoked_at` sur le profil. Une simple lecture de `revoked_at IS NULL AND
 * expires_at > now()` recompterait donc, à chaque révocation suivante, des sessions déjà
 * mortes — et le `revokedCount` renvoyé à l'utilisateur annoncerait la coupure de
 * sessions que plus personne ne pouvait utiliser.
 */
export async function countValidSessions(executor: SqlExecutor, userId: string): Promise<number> {
  const result = await executor.query<{ valid_count: string }>(
    `
      SELECT count(*)::text AS valid_count
        FROM public.sessions s
        JOIN public.user_profiles p ON p.id = s.user_profile_id
       WHERE s.user_profile_id = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > now()
         AND p.status = 'ACTIVE'
         AND (p.sessions_revoked_at IS NULL OR s.issued_at > p.sessions_revoked_at)
    `,
    [userId],
  );
  return Number.parseInt(result.rows[0]?.valid_count ?? '0', 10);
}

/**
 * Révocation globale des sessions d'un compte.
 *
 * UNE SEULE ÉCRITURE, sur le profil. Marquer les N lignes de `sessions` produirait le
 * même effet visible en N écritures, et laisserait une fenêtre ouverte tant que le
 * balayage n'est pas terminé — sur un compte compromis, cette fenêtre est exactement ce
 * qu'il faut fermer d'abord. Le prédicat de validité fait le reste, à la lecture.
 *
 * `GREATEST` interdit de faire reculer la date : un rejeu tardif ne doit pas ranimer les
 * sessions coupées par une révocation antérieure.
 */
export async function revokeAllSessionsOfProfile(
  executor: SqlExecutor,
  userId: string,
): Promise<Date | undefined> {
  const result = await executor.query<{ sessions_revoked_at: Date }>(
    `
      UPDATE public.user_profiles
         SET sessions_revoked_at = GREATEST(now(), COALESCE(sessions_revoked_at, now()))
       WHERE id = $1
      RETURNING sessions_revoked_at
    `,
    [userId],
  );
  return result.rows[0]?.sessions_revoked_at;
}

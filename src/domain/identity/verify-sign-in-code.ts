import { AppError } from '@/application/errors';
import type { AttemptDecision } from '@/domain/identity/attempt-limiter';
import { consumeAttempt, resetAttempts } from '@/domain/identity/attempt-limiter';
import { signInCodeSchema } from '@/domain/identity/code';
import {
  createSessionToken,
  hashSessionToken,
  hashSignInCode,
  timingSafeHexEqual,
} from '@/domain/identity/hashing';
import { withMinimumDuration } from '@/domain/identity/neutrality';
import { hashOriginAddress, summarizeUserAgent, toSourceSubject } from '@/domain/identity/origin';
import {
  MINIMUM_PUBLIC_COMMAND_DURATION_MS,
  POST_SIGN_IN_REDIRECT_PATH,
  SESSION_ABSOLUTE_TTL_SECONDS,
  SESSION_IDLE_TTL_SECONDS,
  VERIFY_CODE_BY_IDENTIFIER,
  VERIFY_CODE_BY_SOURCE,
} from '@/domain/identity/policy';
import {
  consumeChallenge,
  findChallengeById,
  findProfileById,
  incrementChallengeAttempts,
  insertSession,
} from '@/domain/identity/repository';
import type {
  RequestOrigin,
  VerifySignInCodeInput,
  VerifySignInCodeResult,
} from '@/domain/identity/types';
import { writeAuditLog } from '@/infrastructure/audit/audit-log';
import type { SqlExecutor } from '@/infrastructure/identity/unit-of-work';
import { getExecutor, withTransaction } from '@/infrastructure/identity/unit-of-work';
import { getRequestLogger } from '@/observability/logger';
import { uuidSchema } from '@/validation/common';

/**
 * Commande : échanger un code à usage unique contre une session.
 *
 * TROIS PROPRIÉTÉS PORTENT CETTE COMMANDE. Aucune n'est optionnelle.
 *
 * 1. NEUTRALITÉ DES ÉCHECS (critère 7). Code inexistant, expiré, déjà consommé, erroné,
 *    ou défi dont les essais sont épuisés : une seule et même réponse, `UNAUTHENTICATED`,
 *    même message, même statut, mêmes détails vides. Le serveur exécute le même travail
 *    dans tous ces cas — trois énoncés SQL, toujours les mêmes — y compris lorsqu'il sait
 *    déjà que la tentative échouera.
 *
 * 2. CONSOMMATION ATOMIQUE. Deux vérifications simultanées du même code n'ouvrent qu'UNE
 *    session. La garantie ne vient pas d'un verrou applicatif ni d'une lecture suivie
 *    d'une écriture : elle vient d'une mise à jour conditionnelle unique, dont le `WHERE`
 *    porte toutes les conditions d'acceptation (voir `consumeChallenge`).
 *
 * 3. COMPTE NON ACTIF REFUSÉ. Un code valide ne suffit pas : `FORBIDDEN`, avec un message
 *    qui ne dit pas pourquoi. Cette distinction n'est faite qu'APRÈS vérification réussie
 *    du code, donc après que l'appelant a prouvé qu'il contrôle le canal — elle n'ouvre
 *    donc aucune énumération (docs/api-contract.md).
 *
 * POURQUOI LA TRANSACTION COMMET AUSSI SUR ÉCHEC. Le compteur d'essais est incrémenté
 * dans la même transaction que la vérification. Annuler sur échec effacerait l'incrément,
 * et il suffirait d'échouer pour disposer d'un nombre d'essais illimité. La transaction
 * renvoie donc un verdict, et l'exception est levée APRÈS validation.
 */
export async function verifySignInCode(
  input: VerifySignInCodeInput,
): Promise<VerifySignInCodeResult> {
  return withMinimumDuration(MINIMUM_PUBLIC_COMMAND_DURATION_MS, () => execute(input));
}

/**
 * Empreinte leurre, comparée lorsque le défi n'existe pas. Sans elle, ce cas sauterait la
 * comparaison en temps constant et répondrait plus vite que les autres échecs. La valeur
 * est calculée sur un couple que `createSignInCode` ne produit jamais : elle n'est
 * l'empreinte d'aucun code atteignable.
 */
const DECOY_CODE_HASH = hashSignInCode('00000000-0000-4000-8000-000000000000', 'leurre-neutralite');

/**
 * Sujet de limitation employé quand le défi présenté n'existe pas.
 *
 * Il faut UN sujet, et le même travail : sauter la consommation du compteur dans ce cas
 * rendrait « identifiant de défi inconnu » plus rapide que « code erroné ». Ce sujet
 * partagé ne pénalise personne — il n'est consulté que par des tentatives portant un
 * identifiant de défi inexistant — et il borne le tâtonnement à l'aveugle.
 */
const UNKNOWN_CHALLENGE_SUBJECT = 'defi-inconnu';

type Verdict =
  | {
      readonly kind: 'SIGNED_IN';
      readonly result: VerifySignInCodeResult;
      readonly identifierHash: string;
    }
  | { readonly kind: 'REFUSED_INACTIVE'; readonly identifierHash: string }
  | { readonly kind: 'FAILED'; readonly identifierHash: string | null };

async function execute(input: VerifySignInCodeInput): Promise<VerifySignInCodeResult> {
  const challengeId = parseChallengeId(input.challengeId);
  const code = parseCode(input.code);
  const origin = input.origin;

  await enforceSourceRateLimit(origin);

  const verdict = await withTransaction(async (tx) => decide(tx, challengeId, code, origin));

  if (verdict.kind === 'SIGNED_IN') {
    // Une réussite remet à zéro le compteur de l'identifiant, jamais celui de la source :
    // sinon un attaquant disposant d'un compte à lui viderait le compteur de son adresse
    // d'appel à chaque connexion et reprendrait ses tentatives contre d'autres comptes.
    await resetAttempts(getExecutor(), VERIFY_CODE_BY_IDENTIFIER, verdict.identifierHash);
    return verdict.result;
  }

  // Le compteur par identifiant est alimenté dans les deux cas de refus. Un compte
  // suspendu dont le canal est contrôlé par un tiers doit être freiné comme les autres.
  await countFailureAgainstIdentifier(verdict.identifierHash, origin, challengeId);

  if (verdict.kind === 'REFUSED_INACTIVE') {
    throw new AppError('FORBIDDEN');
  }
  throw new AppError('UNAUTHENTICATED');
}

/**
 * Le cœur, en une transaction. TROIS ÉNONCÉS SQL, toujours les mêmes, quel que soit le
 * sort de la tentative.
 *
 * 1. lecture du défi — toujours, même si l'identifiant présenté est absurde ;
 * 2. mise à jour conditionnelle atomique. Elle revérifie TOUT — empreinte, non
 *    consommation, non expiration, plafond d'essais — parce que la lecture de l'étape 1
 *    est déjà périmée au moment où on l'exploite, et parce que c'est cette unique
 *    instruction qui tranche entre deux vérifications simultanées ;
 * 3. incrément du compteur d'essais, exécuté sur tous les chemins d'échec.
 *
 * LA COMPARAISON EN TEMPS CONSTANT est faite en plus de la comparaison SQL, et ce n'est
 * pas une redondance décorative. La comparaison SQL porte sur une colonne `text`, dont
 * l'égalité dépend de la collation : une collation non déterministe, si l'instance venait
 * à en adopter une, élargirait silencieusement l'égalité à des chaînes qui ne sont pas
 * identiques octet à octet. `timingSafeHexEqual` compare les octets décodés, sans
 * dépendre d'aucune collation, et sans que sa durée dépende du nombre de caractères déjà
 * corrects. Les deux doivent conclure pour qu'une session s'ouvre.
 */
async function decide(
  tx: SqlExecutor,
  challengeId: string,
  code: string,
  origin: RequestOrigin | undefined,
): Promise<Verdict> {
  const challenge = await findChallengeById(tx, challengeId);
  const submittedHash = hashSignInCode(challengeId, code);
  const matches = timingSafeHexEqual(submittedHash, challenge?.code_hash ?? DECOY_CODE_HASH);
  const consumed = await consumeChallenge(tx, { challengeId, codeHash: submittedHash });

  if (consumed !== undefined && matches && challenge !== undefined) {
    return openSession(tx, consumed.user_profile_id, challenge.identifier_hash, origin);
  }

  // Échec : toutes les causes convergent ici, sans distinction ni raccourci. Si le défi a
  // malgré tout été consommé à l'énoncé précédent, il reste brûlé — c'est la direction
  // sûre : un code sur lequel il y a un doute ne doit plus jamais servir.
  await incrementChallengeAttempts(tx, challengeId);
  return { kind: 'FAILED', identifierHash: challenge?.identifier_hash ?? null };
}

/**
 * Ouverture de la session, dans la transaction qui vient de consommer le défi.
 *
 * `userProfileId` nul signifie que le défi avait été créé pour un identifiant inconnu.
 * La branche est en pratique inatteignable — le code n'a jamais été envoyé nulle part —
 * mais elle doit exister et répondre comme n'importe quel échec : traiter ce cas comme
 * une anomalie technique produirait une réponse différente des autres, donc un oracle.
 */
async function openSession(
  tx: SqlExecutor,
  userProfileId: string | null,
  identifierHash: string,
  origin: RequestOrigin | undefined,
): Promise<Verdict> {
  if (userProfileId === null) {
    return { kind: 'FAILED', identifierHash };
  }
  const profile = await findProfileById(tx, userProfileId);
  if (profile === undefined) {
    return { kind: 'FAILED', identifierHash };
  }

  const ipHash = hashOriginAddress(origin);
  const userAgentSummary = summarizeUserAgent(origin?.userAgent);

  if (profile.status !== 'ACTIVE') {
    // Le défi reste consommé : le code est brûlé, il ne servira pas à une seconde
    // tentative. L'événement mérite une trace — quelqu'un contrôle le canal d'un compte
    // suspendu — et il est borné, puisqu'il exige un code valide.
    await writeAuditLog(tx, {
      action: 'USER_SIGN_IN_REFUSED',
      targetType: 'USER_PROFILE',
      targetId: profile.id,
      actorUserId: profile.id,
      after: { status: profile.status },
      ipHash,
      userAgentSummary,
    });
    return { kind: 'REFUSED_INACTIVE', identifierHash };
  }

  const token = createSessionToken();
  const session = await insertSession(tx, {
    userProfileId: profile.id,
    tokenHash: hashSessionToken(token),
    idleTtlSeconds: SESSION_IDLE_TTL_SECONDS,
    absoluteTtlSeconds: SESSION_ABSOLUTE_TTL_SECONDS,
    userAgentSummary,
    ipHash,
  });

  // Audit de la connexion réussie. Auditée pour TOUS les comptes et non pour les seuls
  // rôles sensibles : le rôle vient de `OrganizationMember`, qui n'existe pas au lot 1.
  // Auditer trop est réparable, auditer trop peu laisse un trou dans la preuve. Le
  // filtrage par rôle, s'il est voulu, appartient au lot qui crée l'appartenance.
  await writeAuditLog(tx, {
    action: 'USER_SIGNED_IN',
    targetType: 'USER_PROFILE',
    targetId: profile.id,
    actorUserId: profile.id,
    after: { sessionId: session.id },
    ipHash,
    userAgentSummary,
  });

  return {
    kind: 'SIGNED_IN',
    identifierHash,
    result: {
      sessionToken: token,
      session: {
        id: session.id,
        issuedAt: session.issued_at,
        expiresAt: session.expires_at,
        absoluteExpiresAt: new Date(
          session.issued_at.getTime() + SESSION_ABSOLUTE_TTL_SECONDS * 1000,
        ),
        lastSeenAt: session.last_seen_at,
      },
      user: {
        id: profile.id,
        displayName: profile.display_name,
        preferredLanguage: profile.preferred_language,
        verificationLevel: profile.verification_level,
      },
      nextStep: 'READY',
      redirectPath: POST_SIGN_IN_REDIRECT_PATH,
    },
  };
}

/**
 * Limitation par source, consommée avant toute lecture.
 *
 * La dimension « identifiant » ne peut pas être consommée ici : l'identifiant n'est pas
 * fourni par l'appelant, il est porté par le défi. Elle l'est après coup, et c'est le bon
 * ordre — il s'agit d'une limitation des ÉCHECS, et un compteur d'identifiant alimenté
 * par les réussites pénaliserait l'utilisateur qui se connecte souvent.
 */
async function enforceSourceRateLimit(origin: RequestOrigin | undefined): Promise<void> {
  const decision = await consumeAttempt(
    getExecutor(),
    VERIFY_CODE_BY_SOURCE,
    toSourceSubject(origin),
  );
  if (decision.justBlocked) {
    await auditBlocked(decision, origin, null);
  }
  if (!decision.allowed) {
    throw new AppError('RATE_LIMITED', {
      details: { retryAfterSeconds: decision.retryAfterSeconds },
    });
  }
}

/**
 * Compte l'échec sur la dimension « identifiant ».
 *
 * Le sujet est l'EMPREINTE d'identifiant portée par le défi, jamais l'identifiant :
 * `verifySignInCode` ne le connaît pas et n'a pas à le connaître. Ce compteur est
 * indispensable en plus du plafond porté par le défi : sans lui, il suffirait de
 * redemander un code après cinq essais pour disposer de cinq essais de plus,
 * indéfiniment.
 *
 * Le refus n'est PAS levé ici. Au moment où ce compteur est consommé, la tentative a déjà
 * échoué et la réponse est déjà décidée : lever `RATE_LIMITED` au lieu de
 * `UNAUTHENTICATED` révélerait, par le changement de code, que le défi présenté existait
 * bel et bien. Le blocage prend effet à la tentative suivante, qui n'ira pas plus loin
 * que la lecture du compteur.
 */
async function countFailureAgainstIdentifier(
  identifierHash: string | null,
  origin: RequestOrigin | undefined,
  challengeId: string,
): Promise<void> {
  const decision = await consumeAttempt(
    getExecutor(),
    VERIFY_CODE_BY_IDENTIFIER,
    identifierHash ?? UNKNOWN_CHALLENGE_SUBJECT,
  );
  if (decision.justBlocked) {
    await auditBlocked(decision, origin, identifierHash === null ? null : challengeId);
  }
  getRequestLogger().warn(
    {
      module: 'identity',
      errorCode: 'UNAUTHENTICATED',
      challengeId,
      identifierAttempts: decision.attemptCount,
    },
    'verification de code refusee',
  );
}

/**
 * Une ligne d'audit par franchissement de seuil, et une seule (`justBlocked`). Auditer
 * chaque tentative refusée offrirait à un appelant non authentifié un moyen de faire
 * grossir la table de preuve indéfiniment ; n'auditer jamais ferait disparaître la trace
 * d'une campagne de tentatives, que `docs/security.md` demande de conserver.
 */
async function auditBlocked(
  decision: AttemptDecision,
  origin: RequestOrigin | undefined,
  challengeId: string | null,
): Promise<void> {
  await withTransaction(async (tx) => {
    await writeAuditLog(tx, {
      action: 'SIGN_IN_BLOCKED',
      targetType: 'AUTH_CHALLENGE',
      targetId: challengeId,
      actorUserId: null,
      after: {
        subjectHash: decision.subjectHash,
        attemptCount: decision.attemptCount,
        retryAfterSeconds: decision.retryAfterSeconds,
      },
      ipHash: hashOriginAddress(origin),
      userAgentSummary: summarizeUserAgent(origin?.userAgent),
    });
  });
}

function parseChallengeId(raw: unknown): string {
  const parsed = uuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', { details: { fields: ['challengeId'] } });
  }
  return parsed.data;
}

function parseCode(raw: unknown): string {
  const parsed = signInCodeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', { details: { fields: ['code'] } });
  }
  return parsed.data;
}

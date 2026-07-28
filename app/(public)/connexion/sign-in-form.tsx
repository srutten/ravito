'use client';

/*
 * COMPOSANT CLIENT, ET IL DOIT L'ÊTRE.
 *
 * La connexion par code à usage unique est une séquence en deux temps qui vit ENTIÈREMENT dans le
 * navigateur : saisir un identifiant, recevoir un défi, saisir le code, sans quitter la page. Quatre
 * besoins imposent le navigateur et aucun ne se règle côté serveur.
 *
 * 1. Un état de formulaire qui survit entre deux appels réseau : l'identifiant saisi, le défi en
 *    cours, l'étape courante.
 * 2. Les décomptes exigés par `docs/screens.md` — expiration du code, nouvel envoi possible,
 *    blocage temporaire. Un décompte est une horloge, une horloge ne se rend pas côté serveur.
 * 3. Les états transverses « action en cours » et « réseau indisponible », qui se mesurent au
 *    moment de l'appel.
 * 4. Le déplacement du focus vers le champ de code au changement d'étape, sans lequel la séquence
 *    est inutilisable au clavier comme au lecteur d'écran.
 *
 * Ce que ce composant NE FAIT PAS, et ne doit jamais faire : décider. Il n'existe ici aucune règle
 * métier, aucun verdict sur l'existence d'un compte, aucun rôle, aucune destination choisie
 * localement. Il affiche ce que le serveur répond et rien de plus (CLAUDE.md : toute règle métier
 * est côté serveur ; ADR-016 : la destination est calculée par le serveur).
 */

import { useRouter } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Alert, type AlertTone } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { LockIcon, MailIcon } from '@/components/ui/icons';
import { TextField } from '@/components/ui/text-field';
import { messages } from '@/i18n/fr';
import styles from './sign-in-form.module.css';

const REQUEST_CODE_PATH = '/api/v1/auth/codes';
const OPEN_SESSION_PATH = '/api/v1/auth/sessions';

const IDENTIFIER_FIELD_ID = 'connexion-identifiant';
const CODE_FIELD_ID = 'connexion-code';

/** Longueur attendue du code tant que le serveur n'a pas répondu la sienne. */
const DEFAULT_CODE_LENGTH = 6;

/**
 * Destination de repli si le serveur renvoyait un chemin non conforme. Ce n'est pas un choix de
 * destination — le serveur reste seul à décider — c'est un refus de suivre une valeur inattendue.
 */
const FALLBACK_REDIRECT_PATH = '/';

const labels = messages.ui.signIn;

/**
 * Les réponses de l'API sont validées avant usage, comme toute entrée externe. Le serveur est de
 * confiance, la couche de transport ne l'est pas : un intermédiaire, une page d'erreur de
 * mandataire ou un décalage de version produiraient une forme inattendue, et un champ absent
 * s'afficherait alors en « undefined » au milieu d'un écran de connexion.
 */
const requestCodeResponseSchema = z.object({
  challengeId: z.string().min(1),
  codeLength: z.number().int().positive(),
  expiresInSeconds: z.number().int().positive(),
  resendAvailableInSeconds: z.number().int().nonnegative(),
});

const openSessionResponseSchema = z.object({
  redirectPath: z.string().min(1),
});

const failureResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

type PostOutcome =
  | { readonly kind: 'SUCCESS'; readonly payload: unknown }
  | {
      readonly kind: 'FAILURE';
      readonly code: string;
      readonly message: string;
      readonly details: Record<string, unknown>;
    }
  /** Le réseau n'a pas répondu : l'appel n'a jamais atteint le serveur. */
  | { readonly kind: 'OFFLINE' }
  /** Une réponse est arrivée mais elle est inexploitable. */
  | { readonly kind: 'UNREADABLE' };

interface Challenge {
  readonly id: string;
  /** Identifiant saisi, conservé pour le renvoi. Il n'est ni journalisé, ni transmis ailleurs. */
  readonly identifier: string;
  readonly codeLength: number;
  readonly expiresAtMs: number;
  readonly resendAtMs: number;
}

interface Notice {
  readonly tone: AlertTone;
  readonly title: string;
  readonly body: string;
}

type Phase = 'IDENTIFIER' | 'CODE' | 'SIGNED_IN';

async function postJson(path: string, body: unknown): Promise<PostOutcome> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      // `application/json` est exigé par le contrat et bloque au passage la soumission d'un
      // formulaire inter-site, qui ne sait produire que trois autres types de contenu.
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return { kind: 'OFFLINE' };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { kind: 'UNREADABLE' };
  }

  if (response.ok) {
    return { kind: 'SUCCESS', payload };
  }
  const parsed = failureResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return { kind: 'UNREADABLE' };
  }
  return {
    kind: 'FAILURE',
    code: parsed.data.error.code,
    message: parsed.data.error.message,
    details: parsed.data.error.details ?? {},
  };
}

/** « 42 s », « 9 min 05 s ». Lisible à voix haute par un lecteur d'écran. */
function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) {
    return `${rest} s`;
  }
  return `${minutes} min ${String(rest).padStart(2, '0')} s`;
}

function toSeconds(deadlineMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}

/**
 * N'accepte qu'un chemin interne. Le serveur est aujourd'hui la seule source de cette valeur, mais
 * une redirection suivie sans contrôle est le composant de base d'un hameçonnage : la victime
 * s'authentifie sur le vrai site puis atterrit ailleurs.
 */
function toSafeInternalPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    return FALLBACK_REDIRECT_PATH;
  }
  return path;
}

function readIdentifierReason(details: Record<string, unknown>): string | undefined {
  const reason = details.reason;
  if (typeof reason !== 'string') {
    return undefined;
  }
  const catalogue: Record<string, string | undefined> = labels.identifierErrors;
  return catalogue[reason];
}

function readFailedFields(details: Record<string, unknown>): readonly string[] {
  const fields = details.fields;
  if (!Array.isArray(fields)) {
    return [];
  }
  return fields.filter((field): field is string => typeof field === 'string');
}

function readRetryAfterSeconds(details: Record<string, unknown>): number {
  const seconds = details.retryAfterSeconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }
  return Math.ceil(seconds);
}

export function SignInForm() {
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>('IDENTIFIER');
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [identifierError, setIdentifierError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [blockedUntilMs, setBlockedUntilMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [isHydrated, setIsHydrated] = useState(false);

  const identifierInputRef = useRef<HTMLInputElement>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);

  /**
   * VERROU JUSQU'À L'HYDRATATION, et ce n'est pas une précaution théorique.
   *
   * Entre l'affichage du formulaire et le moment où React reprend la main, `onSubmit` n'existe
   * pas encore : une touche Entrée dans le champ déclencherait la soumission NATIVE du
   * formulaire. Sur un téléphone d'entrée de gamme en réseau dégradé — c'est-à-dire la situation
   * ordinaire des utilisateurs de cette plateforme — cet intervalle se compte en secondes, pas en
   * millisecondes.
   *
   * Ce que cela coûterait : l'adresse saisie partirait dans une requête vers `/connexion`,
   * c'est-à-dire dans l'historique du navigateur, dans les journaux d'accès et dans l'en-tête
   * `Referer` des requêtes suivantes. `docs/observability.md` exclut les coordonnées personnelles
   * des journaux et `docs/privacy-rgpd.md` impose la minimisation : une adresse de courriel
   * recopiée dans trois endroits qu'on ne maîtrise pas est exactement ce que ces deux textes
   * interdisent.
   *
   * La spécification HTML est explicite : si le bouton par défaut d'un formulaire est désactivé,
   * la soumission implicite n'a pas lieu. Le verrou suffit donc, et `method="post"` sur le
   * formulaire reste en filet — même soumis nativement, rien ne passerait par l'URL.
   */
  useEffect(() => {
    setIsHydrated(true);
  }, []);

  /**
   * Une seule horloge pour les trois décomptes, et seulement lorsqu'il y a quelque chose à
   * décompter. Un intervalle qui tournerait en permanence sur un écran de connexion réveillerait
   * un téléphone en veille pour ne rien afficher.
   */
  useEffect(() => {
    if (phase !== 'CODE' && blockedUntilMs === null) {
      return undefined;
    }
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [phase, blockedUntilMs]);

  /**
   * Le focus suit l'étape. Sans cela, la personne au clavier ou au lecteur d'écran reste sur le
   * bouton qu'elle vient d'activer et doit chercher elle-même le champ qui vient d'apparaître.
   */
  useEffect(() => {
    if (phase === 'CODE') {
      codeInputRef.current?.focus();
    }
  }, [phase]);

  const blockedSeconds = blockedUntilMs === null ? 0 : toSeconds(blockedUntilMs, nowMs);
  const isBlocked = blockedSeconds > 0;
  const expiresInSeconds = challenge === null ? 0 : toSeconds(challenge.expiresAtMs, nowMs);
  const resendInSeconds = challenge === null ? 0 : toSeconds(challenge.resendAtMs, nowMs);
  const isCodeExpired = challenge !== null && expiresInSeconds === 0;
  const codeLength = challenge?.codeLength ?? DEFAULT_CODE_LENGTH;

  const applyFailure = useCallback((outcome: PostOutcome): void => {
    if (outcome.kind === 'OFFLINE') {
      setNotice({
        tone: 'warning',
        title: messages.ui.states.networkUnavailable,
        body: messages.ui.states.retry,
      });
      return;
    }
    if (outcome.kind === 'UNREADABLE') {
      setNotice({ tone: 'danger', title: labels.failureTitle, body: messages.ui.states.error });
      return;
    }
    if (outcome.kind !== 'FAILURE') {
      return;
    }

    if (outcome.code === 'RATE_LIMITED') {
      const seconds = readRetryAfterSeconds(outcome.details);
      setBlockedUntilMs(seconds > 0 ? Date.now() + seconds * 1000 : null);
      setNowMs(Date.now());
      setNotice({ tone: 'danger', title: labels.blockedTitle, body: outcome.message });
      return;
    }

    if (outcome.code === 'VALIDATION_ERROR') {
      const reasonMessage = readIdentifierReason(outcome.details);
      if (reasonMessage !== undefined) {
        setIdentifierError(reasonMessage);
        return;
      }
      const fields = readFailedFields(outcome.details);
      if (fields.includes('identifier')) {
        setIdentifierError(labels.identifierErrors.IDENTIFIER_MALFORMED);
        return;
      }
      if (fields.includes('code')) {
        setCodeError(labels.codeError);
        return;
      }
      setNotice({ tone: 'danger', title: labels.failureTitle, body: outcome.message });
      return;
    }

    // UN SEUL MESSAGE POUR LES QUATRE ÉCHECS DE CODE. Le serveur renvoie déjà un unique
    // `UNAUTHENTICATED` pour un code inexistant, expiré, déjà consommé ou erroné ; l'écran ne
    // rétablit pas la distinction qu'il a refusé d'ouvrir (critère 7).
    if (outcome.code === 'UNAUTHENTICATED') {
      setCodeError(labels.codeRejected);
      return;
    }

    // Compte suspendu ou clos. La distinction n'est faite qu'APRÈS un code valide, donc après que
    // l'appelant a prouvé qu'il contrôle le canal : elle n'ouvre aucune énumération, et un compte
    // suspendu doit savoir qu'il l'est pour pouvoir demander sa réactivation.
    if (outcome.code === 'FORBIDDEN') {
      setNotice({
        tone: 'danger',
        title: labels.failureTitle,
        body: labels.accountUnavailable,
      });
      return;
    }

    setNotice({ tone: 'danger', title: labels.failureTitle, body: outcome.message });
  }, []);

  const requestCode = useCallback(
    async (targetIdentifier: string): Promise<void> => {
      setIsBusy(true);
      setIdentifierError(null);
      setCodeError(null);
      setNotice(null);

      const outcome = await postJson(REQUEST_CODE_PATH, { identifier: targetIdentifier });
      setIsBusy(false);

      if (outcome.kind !== 'SUCCESS') {
        applyFailure(outcome);
        return;
      }
      const parsed = requestCodeResponseSchema.safeParse(outcome.payload);
      if (!parsed.success) {
        applyFailure({ kind: 'UNREADABLE' });
        return;
      }

      const startedAtMs = Date.now();
      setChallenge({
        id: parsed.data.challengeId,
        identifier: targetIdentifier,
        codeLength: parsed.data.codeLength,
        expiresAtMs: startedAtMs + parsed.data.expiresInSeconds * 1000,
        resendAtMs: startedAtMs + parsed.data.resendAvailableInSeconds * 1000,
      });
      setCode('');
      setNowMs(startedAtMs);
      setPhase('CODE');
    },
    [applyFailure],
  );

  const submitCode = useCallback(
    async (current: Challenge, submittedCode: string): Promise<void> => {
      setIsBusy(true);
      setCodeError(null);
      setNotice(null);

      const outcome = await postJson(OPEN_SESSION_PATH, {
        challengeId: current.id,
        code: submittedCode,
      });

      if (outcome.kind !== 'SUCCESS') {
        setIsBusy(false);
        setCode('');
        applyFailure(outcome);
        codeInputRef.current?.focus();
        return;
      }

      const parsed = openSessionResponseSchema.safeParse(outcome.payload);
      if (!parsed.success) {
        setIsBusy(false);
        applyFailure({ kind: 'UNREADABLE' });
        return;
      }

      // `isBusy` reste vrai : la navigation est engagée, plus aucune action ne doit partir.
      setPhase('SIGNED_IN');
      setNotice({ tone: 'success', title: labels.successTitle, body: labels.successBody });
      router.replace(toSafeInternalPath(parsed.data.redirectPath));
    },
    [applyFailure, router],
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (isBusy || isBlocked) {
      return;
    }
    if (phase === 'IDENTIFIER') {
      const trimmed = identifier.trim();
      if (trimmed.length === 0) {
        // Contrôle local de confort uniquement : le verdict qui fait foi reste celui du serveur,
        // qui revalide la saisie entière et normalise l'identifiant.
        setIdentifierError(labels.identifierErrors.IDENTIFIER_REQUIRED);
        identifierInputRef.current?.focus();
        return;
      }
      void requestCode(trimmed);
      return;
    }
    if (phase === 'CODE' && challenge !== null) {
      if (code.length !== challenge.codeLength) {
        setCodeError(labels.codeError);
        return;
      }
      void submitCode(challenge, code);
    }
  }

  function handleChangeIdentifier(): void {
    setPhase('IDENTIFIER');
    setChallenge(null);
    setCode('');
    setCodeError(null);
    setNotice(null);
    identifierInputRef.current?.focus();
  }

  const isSignedIn = phase === 'SIGNED_IN';
  const isSubmitDisabled = isBusy || isBlocked || isSignedIn || !isHydrated;

  return (
    <form
      className={styles.form}
      onSubmit={handleSubmit}
      // `post` n'est jamais réellement employé — `handleSubmit` intercepte — mais il fixe ce qui
      // se passerait si l'interception n'avait pas lieu : la saisie partirait dans un corps de
      // requête, jamais dans une URL. Le défaut `get` recopierait l'adresse dans la barre
      // d'adresse, l'historique et les journaux d'accès.
      method="post"
      // La validation native est désactivée : ses bulles ne sont ni traduisibles, ni associées
      // aux messages de champ décrits par `docs/screens.md`.
      noValidate
      aria-label={labels.formLabel}
      data-testid="formulaire-connexion"
    >
      {/*
        Sans script actif, ce formulaire ne peut pas fonctionner : la séquence en deux temps
        repose entièrement sur des appels depuis le navigateur. Le dire est la seule option
        honnête — un bouton qui reste inerte sans explication laisse croire à une panne.
      */}
      <noscript>
        <Alert tone="warning" title={labels.scriptRequiredTitle}>
          {labels.scriptRequired}
        </Alert>
      </noscript>

      {notice !== null ? (
        <div data-testid="message-connexion">
          <Alert tone={notice.tone} title={notice.title} live>
            {notice.body}
          </Alert>
        </div>
      ) : null}

      {/*
        Le décompte de blocage est DEHORS de l'encart. L'encart porte `role="alert"`, donc une
        région assertive : y placer une valeur qui change chaque seconde ferait répéter le message
        à un lecteur d'écran une fois par seconde pendant tout le blocage, c'est-à-dire quinze
        minutes de parole continue. L'encart annonce une fois, le décompte se met à jour en
        silence et reste lisible à la demande.
      */}
      {isBlocked ? (
        <p className={styles.countdown} data-testid="decompte-blocage">
          {labels.blockedRetryIn} {formatDuration(blockedSeconds)}
        </p>
      ) : null}

      {phase === 'IDENTIFIER' ? (
        <div className={styles.step} data-testid="etape-identifiant">
          <TextField
            id={IDENTIFIER_FIELD_ID}
            name="identifier"
            label={labels.identifierLabel}
            value={identifier}
            onChange={setIdentifier}
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder={labels.identifierPlaceholder}
            hint={labels.identifierHint}
            {...(identifierError !== null ? { error: identifierError } : {})}
            maxLength={254}
            required
            disabled={isBusy}
            inputRef={identifierInputRef}
            icon={<MailIcon width={22} height={22} />}
            testId="champ-identifiant"
          />
          <div className={styles.action} data-testid="action-demander-code">
            <Button
              type="submit"
              variant="primary"
              fullWidth
              busy={isBusy}
              disabled={isSubmitDisabled}
              icon={<MailIcon width={20} height={20} />}
            >
              {labels.requestCode}
            </Button>
          </div>
        </div>
      ) : null}

      {phase !== 'IDENTIFIER' && challenge !== null ? (
        <div className={styles.step} data-testid="etape-code">
          <div data-testid="message-code-envoye">
            <Alert tone="info" title={labels.codeStepTitle} live>
              {labels.codeStepBody}
              <p className={styles.recipient}>{challenge.identifier}</p>
            </Alert>
          </div>

          <TextField
            id={CODE_FIELD_ID}
            name="code"
            label={labels.codeLabel}
            value={code}
            // Les chiffres seuls sont conservés : un code collé depuis un courriel arrive souvent
            // avec une espace ou un caractère invisible, qui ferait échouer une saisie correcte.
            onChange={(value) => setCode(value.replace(/\D/g, '').slice(0, codeLength))}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={codeLength}
            hint={labels.codeHint}
            {...(codeError !== null ? { error: codeError } : {})}
            required
            disabled={isBusy || isSignedIn}
            inputRef={codeInputRef}
            icon={<LockIcon width={22} height={22} />}
            testId="champ-code"
          />

          <p className={styles.countdown} data-testid="decompte-expiration">
            {isCodeExpired
              ? labels.codeExpired
              : `${labels.codeExpiresIn} ${formatDuration(expiresInSeconds)}`}
          </p>

          <div className={styles.action} data-testid="action-valider-code">
            <Button
              type="submit"
              variant="primary"
              fullWidth
              busy={isBusy}
              disabled={isSubmitDisabled}
              icon={<LockIcon width={20} height={20} />}
            >
              {labels.submitCode}
            </Button>
          </div>

          <div className={styles.secondaryActions}>
            {/*
              LE LIBELLÉ DU BOUTON NE PORTE PAS LE DÉCOMPTE, et c'est délibéré. Un bouton
              désactivé sort de l'ordre de tabulation : une information placée dans son libellé
              devient inatteignable au clavier et n'est plus annoncée. Le libellé reste donc
              constant, et le délai restant vit dans un texte adjacent, lisible par tous.
            */}
            <div className={styles.action} data-testid="action-renvoyer-code">
              <Button
                variant="secondary"
                fullWidth
                disabled={isBusy || isSignedIn || resendInSeconds > 0}
                onClick={() => {
                  if (!isBusy && !isSignedIn && resendInSeconds === 0) {
                    void requestCode(challenge.identifier);
                  }
                }}
              >
                {labels.resendCode}
              </Button>
            </div>
            {resendInSeconds > 0 ? (
              <p className={styles.countdown} data-testid="decompte-renvoi">
                {labels.resendAvailableIn} {formatDuration(resendInSeconds)}
              </p>
            ) : null}
            <Button
              variant="ghost"
              fullWidth
              disabled={isBusy || isSignedIn}
              onClick={handleChangeIdentifier}
            >
              {labels.changeIdentifier}
            </Button>
          </div>
        </div>
      ) : null}
    </form>
  );
}

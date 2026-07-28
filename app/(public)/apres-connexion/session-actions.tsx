'use client';

/*
 * COMPOSANT CLIENT, ET IL DOIT L'ÊTRE.
 *
 * Les deux commandes de fin de session sont des mutations déclenchées par un appui, avec un état
 * « action en cours », un résultat à annoncer et une redirection à la clé. Trois besoins imposent
 * le navigateur : le verrouillage des boutons pendant l'appel, la restitution des états
 * transverses de `docs/screens.md` — action en cours, action réussie, réseau indisponible — et la
 * génération de la clé d'idempotence, qui doit être tirée une fois par intention de l'utilisateur
 * et non une fois par rendu de page.
 *
 * Comme le formulaire de connexion, ce composant ne décide rien : la révocation, son étendue et le
 * compte visé sont déterminés côté serveur à partir de la session présentée. Aucun identifiant de
 * compte n'est envoyé, et la route n'en accepterait pas.
 */

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { z } from 'zod';
import { Alert, type AlertTone } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { LockIcon, ShieldDeniedIcon } from '@/components/ui/icons';
import { messages } from '@/i18n/fr';
import styles from './apres-connexion.module.css';

const SIGN_OUT_PATH = '/api/v1/auth/sessions/current';
const REVOKE_ALL_PATH = '/api/v1/auth/sessions/commands/revoke-all';
const SIGN_IN_PATH = '/connexion';

const labels = messages.ui.postSignIn;

const revokeAllResponseSchema = z.object({
  revokedCount: z.number().int().nonnegative(),
});

const failureResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

interface Notice {
  readonly tone: AlertTone;
  readonly title: string;
  readonly body: string;
}

type PendingAction = 'NONE' | 'SIGN_OUT' | 'REVOKE_ALL';

/**
 * Clé d'idempotence de la révocation globale.
 *
 * `crypto.randomUUID` n'existe que dans un contexte sécurisé : sur un téléphone qui atteint un
 * poste de développement par son adresse de réseau local, en HTTP, il est absent. Le repli tire
 * les mêmes 122 bits d'aléa par `getRandomValues`, disponible partout, et compose un UUID de
 * version 4 conforme — le schéma serveur n'accepte rien d'autre.
 */
function createClientEventId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Version 4 et variante RFC 4122, imposées par le format.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export function SessionActions() {
  const router = useRouter();
  const [pending, setPending] = useState<PendingAction>('NONE');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isDone, setIsDone] = useState(false);

  const reportFailure = useCallback((payload: unknown): void => {
    const parsed = failureResponseSchema.safeParse(payload);
    setNotice({
      tone: 'danger',
      title: messages.ui.states.error,
      body: parsed.success ? parsed.data.error.message : messages.ui.states.retry,
    });
  }, []);

  const reportOffline = useCallback((): void => {
    setNotice({
      tone: 'warning',
      title: messages.ui.states.networkUnavailable,
      body: messages.ui.states.retry,
    });
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    setPending('SIGN_OUT');
    setNotice(null);
    let response: Response;
    try {
      response = await fetch(SIGN_OUT_PATH, {
        method: 'DELETE',
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch {
      setPending('NONE');
      reportOffline();
      return;
    }
    if (!response.ok) {
      setPending('NONE');
      reportFailure(await response.json().catch(() => null));
      return;
    }
    // Le verrou reste posé : la navigation est engagée, plus aucune action ne doit partir.
    setIsDone(true);
    setNotice({
      tone: 'success',
      title: labels.signedOutTitle,
      body: messages.ui.states.actionSucceeded,
    });
    router.replace(SIGN_IN_PATH);
  }, [reportFailure, reportOffline, router]);

  const revokeAll = useCallback(async (): Promise<void> => {
    setPending('REVOKE_ALL');
    setNotice(null);
    let response: Response;
    try {
      response = await fetch(REVOKE_ALL_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientEventId: createClientEventId() }),
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch {
      setPending('NONE');
      reportOffline();
      return;
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      setPending('NONE');
      reportFailure(payload);
      return;
    }
    const parsed = revokeAllResponseSchema.safeParse(payload);
    setIsDone(true);
    setNotice({
      tone: 'success',
      title: labels.revokedTitle,
      body: parsed.success
        ? `${labels.revokedBody} (${String(parsed.data.revokedCount)})`
        : labels.revokedBody,
    });
    router.replace(SIGN_IN_PATH);
  }, [reportFailure, reportOffline, router]);

  const isBusy = pending !== 'NONE';
  const isLocked = isBusy || isDone;

  return (
    <div className={styles.actions} data-testid="actions-session">
      {notice !== null ? (
        <div data-testid="message-session">
          <Alert tone={notice.tone} title={notice.title} live>
            {notice.body}
          </Alert>
        </div>
      ) : null}

      <div data-testid="action-deconnexion">
        <Button
          variant="secondary"
          fullWidth
          busy={pending === 'SIGN_OUT'}
          disabled={isLocked}
          icon={<LockIcon width={20} height={20} />}
          onClick={() => {
            if (!isLocked) {
              void signOut();
            }
          }}
        >
          {labels.signOut}
        </Button>
      </div>

      <p className={styles.hint} id="revocation-globale-indice">
        {labels.revokeAllHint}
      </p>
      <div data-testid="action-revocation-globale">
        <Button
          variant="danger"
          fullWidth
          busy={pending === 'REVOKE_ALL'}
          disabled={isLocked}
          icon={<ShieldDeniedIcon width={20} height={20} />}
          onClick={() => {
            if (!isLocked) {
              void revokeAll();
            }
          }}
        >
          {labels.revokeAll}
        </Button>
      </div>
    </div>
  );
}

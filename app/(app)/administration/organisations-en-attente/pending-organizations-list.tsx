'use client';

/*
 * COMPOSANT CLIENT, ET IL DOIT L'ÊTRE.
 *
 * `docs/screens.md`, écran 10 : « la file ne se rafraîchit pas d'elle-même. ENABLE_REALTIME vaut
 * faux et aucun canal temps réel n'est livré ; l'écran affiche l'heure du dernier chargement et
 * propose un rafraîchissement manuel, plutôt qu'un indicateur de fraîcheur qu'aucun code ne
 * mesure. » Quatre besoins en découlent, tous dans le navigateur : le rafraîchissement à la
 * demande, l'heure du dernier chargement ABOUTI, la conservation de la dernière liste lue quand
 * le réseau tombe, et la comparaison d'un chargement au précédent pour signaler ce qui a quitté
 * la file entre-temps.
 *
 * CE COMPOSANT NE DÉCIDE RIEN ET N'AUTORISE RIEN. La route refait le contrôle de rôle à chaque
 * requête, dans la transaction qui lit : une fonction d'administrateur plateforme retirée pendant
 * que l'écran est ouvert ferme la file au rafraîchissement suivant, et le composant affiche alors
 * le refus au lieu de la liste.
 *
 * AUCUNE ACTION DE VALIDATION ICI. Le bouton de validation, le refus motivé et la notification
 * associée relèvent d'US-013. La file rend visible ce qui attend sans encore permettre de le
 * traiter : préférable à l'inverse.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { RefreshIcon } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
// `types` et non l'index du module : l'index exporte les commandes, donc le pilote PostgreSQL,
// qui n'a rien à faire dans le paquet du navigateur. Voir `create-organization-form.tsx`.
import { ORGANIZATION_TYPES } from '@/domain/organizations/types';
import { messages } from '@/i18n/fr';
import styles from './pending-organizations.module.css';

const PENDING_PATH = '/api/v1/admin/organizations/pending';

const labels = messages.ui.pendingOrganizations;
const vocabulary = messages.ui.organizations;

const MILLISECONDS_PER_HOUR = 3_600_000;
const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * Réponse validée avant usage, comme toute entrée externe. `type` est contraint au référentiel
 * fermé : une valeur inconnue ferait afficher un libellé vide, c'est-à-dire une ligne de file
 * sans nature de structure, sur l'écran où cette nature fonde la décision.
 */
const pendingItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(ORGANIZATION_TYPES),
  registrationNumber: z.string().min(1),
  territoryCode: z.string().nullable(),
  createdAt: z.string().min(1),
  requestedBy: z.object({ displayName: z.string().nullable() }),
});

const pendingResponseSchema = z.object({
  items: z.array(pendingItemSchema),
  nextCursor: z.string().nullable(),
  totalCount: z.number().int().nonnegative(),
});

const failureResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

type PendingItem = z.infer<typeof pendingItemSchema>;

/** Ce que l'écran sait de la file, et rien d'autre. */
type Phase = 'LOADING' | 'READY' | 'ERROR' | 'FORBIDDEN';

const INSTANT_FORMAT = new Intl.DateTimeFormat('fr-FR', {
  dateStyle: 'long',
  timeStyle: 'short',
});

const TIME_FORMAT = new Intl.DateTimeFormat('fr-FR', {
  dateStyle: 'short',
  timeStyle: 'short',
});

/**
 * Ancienneté écrite EN TOUTES LETTRES.
 *
 * `docs/screens.md` l'exige : « chaque ligne affiche donc l'ancienneté en toutes lettres — en
 * attente depuis 3 jours — et non par une pastille de couleur : la section Accessibilité de ce
 * document interdit qu'une information soit portée par la seule couleur, et un délai d'attente
 * est une information, pas une décoration. »
 *
 * Les durées inférieures à l'heure ne sont pas comptées en minutes : à cette échelle la
 * précision n'apporte rien à une décision de validation, et une valeur qui change à chaque
 * rendu ferait douter de la fraîcheur de tout le reste.
 *
 * EXPORTÉE POUR ÊTRE ÉPROUVÉE, ET POUR RIEN D'AUTRE. Ses trois bornes ne sont atteignables par un
 * parcours de bout en bout qu'en fabriquant des organisations vieilles d'heures et de semaines,
 * c'est-à-dire en datant des lignes à la main : le test unitaire les couvre toutes pour le prix
 * d'aucune base. Une inversion de borne afficherait « 1 jour » à une organisation qui attend
 * depuis trois semaines — un mensonge sur l'écran dont `docs/screens.md` fait une exigence
 * d'accessibilité, puisque l'ancienneté y est écrite en toutes lettres et non par une couleur.
 */
export function formatAge(createdAt: Date, now: Date): string {
  const elapsed = Math.max(0, now.getTime() - createdAt.getTime());
  if (elapsed < MILLISECONDS_PER_HOUR) {
    return labels.ageLessThanHour;
  }
  if (elapsed < MILLISECONDS_PER_DAY) {
    const hours = Math.floor(elapsed / MILLISECONDS_PER_HOUR);
    return hours <= 1 ? labels.ageHourOne : `${String(hours)} ${labels.ageHourMany}`;
  }
  const days = Math.floor(elapsed / MILLISECONDS_PER_DAY);
  return days <= 1 ? labels.ageDayOne : `${String(days)} ${labels.ageDayMany}`;
}

function formatCount(total: number): string {
  return `${String(total)} ${total <= 1 ? labels.countOne : labels.countMany}`;
}

interface LoadOutcome {
  readonly items: readonly PendingItem[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

type LoadResult =
  | { readonly kind: 'SUCCESS'; readonly value: LoadOutcome }
  | { readonly kind: 'FORBIDDEN' }
  /** Le réseau n'a pas répondu : la dernière liste lue reste à l'écran, marquée comme datée. */
  | { readonly kind: 'OFFLINE' }
  | { readonly kind: 'ERROR' };

async function loadPage(cursor: string | null): Promise<LoadResult> {
  const url =
    cursor === null ? PENDING_PATH : `${PENDING_PATH}?cursor=${encodeURIComponent(cursor)}`;
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  } catch {
    return { kind: 'OFFLINE' };
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = failureResponseSchema.safeParse(payload);
    if (
      parsed.success &&
      (parsed.data.error.code === 'FORBIDDEN' || parsed.data.error.code === 'UNAUTHENTICATED')
    ) {
      return { kind: 'FORBIDDEN' };
    }
    return { kind: 'ERROR' };
  }

  const parsed = pendingResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return { kind: 'ERROR' };
  }
  return { kind: 'SUCCESS', value: parsed.data };
}

export function PendingOrganizationsList() {
  const [phase, setPhase] = useState<Phase>('LOADING');
  const [items, setItems] = useState<readonly PendingItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isStale, setIsStale] = useState(false);
  /** Organisations qui ont quitté la file depuis le chargement précédent. */
  const [departed, setDeparted] = useState<readonly string[]>([]);

  /**
   * Miroir des éléments affichés.
   *
   * IL EXISTE POUR QUE `reload` NE DÉPENDE DE RIEN. Une fonction de rechargement qui se
   * recréerait à chaque changement de liste, appelée depuis un effet, relancerait un
   * chargement à chaque chargement : une boucle permanente sur l'écran dont `docs/screens.md`
   * dit précisément qu'il ne se rafraîchit pas de lui-même. La référence n'est jamais lue pour
   * rendre — seulement pour comparer deux chargements successifs.
   */
  const itemsRef = useRef<readonly PendingItem[]>([]);

  const rememberItems = useCallback((next: readonly PendingItem[]): void => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    setIsBusy(true);
    const previous = itemsRef.current;
    const previousIds = new Set(previous.map((item) => item.id));
    const previousNames = new Map(previous.map((item) => [item.id, item.name]));

    const result = await loadPage(null);
    setIsBusy(false);

    if (result.kind === 'OFFLINE') {
      // LA DERNIÈRE LISTE RESTE AFFICHÉE, MARQUÉE COMME DATÉE. La vider ferait croire que la
      // file est vide, c'est-à-dire l'inverse exact de l'information disponible.
      setIsStale(true);
      return;
    }
    if (result.kind === 'FORBIDDEN') {
      setPhase('FORBIDDEN');
      return;
    }
    if (result.kind === 'ERROR') {
      // La file reste vide plutôt qu'affichée à moitié (docs/screens.md).
      rememberItems([]);
      setTotalCount(null);
      setNextCursor(null);
      setPhase('ERROR');
      return;
    }

    // DONNÉES OBSOLÈTES : une organisation traitée entre-temps par un autre administrateur est
    // SIGNALÉE, jamais retirée en silence. Sans ce relevé, une ligne disparaîtrait entre deux
    // rafraîchissements et personne ne saurait si elle a été validée, refusée, ou perdue.
    const currentIds = new Set(result.value.items.map((item) => item.id));
    const gone = [...previousIds]
      .filter((id) => !currentIds.has(id))
      .map((id) => previousNames.get(id) ?? id);

    rememberItems(result.value.items);
    setNextCursor(result.value.nextCursor);
    setTotalCount(result.value.totalCount);
    setLastLoadedAt(new Date());
    setIsStale(false);
    setDeparted(gone);
    setPhase('READY');
  }, [rememberItems]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (nextCursor === null) {
      return;
    }
    setIsBusy(true);
    const result = await loadPage(nextCursor);
    setIsBusy(false);

    if (result.kind === 'OFFLINE') {
      setIsStale(true);
      return;
    }
    if (result.kind === 'FORBIDDEN') {
      setPhase('FORBIDDEN');
      return;
    }
    if (result.kind === 'ERROR') {
      setPhase('ERROR');
      return;
    }
    rememberItems([...itemsRef.current, ...result.value.items]);
    setNextCursor(result.value.nextCursor);
    setTotalCount(result.value.totalCount);
    setLastLoadedAt(new Date());
    setIsStale(false);
  }, [nextCursor, rememberItems]);

  // Premier chargement, et lui seul. `reload` est stable, l'effet ne se rejoue donc jamais :
  // la file ne se rafraîchit pas d'elle-même (docs/screens.md).
  useEffect(() => {
    void reload();
  }, [reload]);

  const now = lastLoadedAt ?? new Date();

  return (
    <section
      className={styles.queue}
      aria-label={labels.listLabel}
      data-testid="file-organisations-en-attente"
    >
      <div className={styles.toolbar}>
        {/*
          LE COMPTEUR N'APPARAÎT PAS PENDANT LE CHARGEMENT : le nombre n'est pas encore connu, et
          en afficher un provisoire reviendrait à annoncer une situation qu'on ne mesure pas.
        */}
        {totalCount !== null ? (
          <p className={styles.count} data-testid="compteur-organisations-en-attente">
            {formatCount(totalCount)}
          </p>
        ) : null}

        <div className={styles.toolbarActions}>
          <p className={styles.lastLoaded} data-testid="horodatage-dernier-chargement">
            {lastLoadedAt === null
              ? labels.lastLoadedUnknown
              : `${labels.lastLoadedAt} : ${INSTANT_FORMAT.format(lastLoadedAt)}`}
          </p>
          <div data-testid="action-rafraichir-file">
            <Button
              variant="secondary"
              compact
              busy={isBusy}
              disabled={isBusy}
              icon={<RefreshIcon width={18} height={18} />}
              onClick={() => {
                if (!isBusy) {
                  void reload();
                }
              }}
            >
              {labels.refresh}
            </Button>
          </div>
        </div>
      </div>

      {isStale ? (
        <div data-testid="message-file-datee">
          <Alert tone="warning" title={labels.staleTitle} live>
            {labels.staleBody}
          </Alert>
        </div>
      ) : null}

      {departed.length > 0 ? (
        <div data-testid="message-file-obsolete">
          <Alert tone="info" title={messages.ui.states.staleData} live>
            {departed.join(', ')}
          </Alert>
        </div>
      ) : null}

      {phase === 'LOADING' ? (
        <div className={styles.loading} data-testid="etat-file-chargement">
          <Skeleton lines={3} />
        </div>
      ) : null}

      {phase === 'FORBIDDEN' ? (
        <div data-testid="etat-file-refusee">
          <ErrorState variant="permissionDenied" />
        </div>
      ) : null}

      {phase === 'ERROR' ? (
        <div data-testid="etat-file-erreur">
          <ErrorState
            variant="error"
            live
            action={
              <Button
                variant="secondary"
                busy={isBusy}
                disabled={isBusy}
                onClick={() => {
                  if (!isBusy) {
                    void reload();
                  }
                }}
              >
                {messages.ui.states.retry}
              </Button>
            }
          />
        </div>
      ) : null}

      {phase === 'READY' && items.length === 0 ? (
        <div data-testid="etat-file-vide">
          {/* État NORMAL, dit comme tel : pas d'illustration d'erreur (docs/screens.md). */}
          <EmptyState title={labels.emptyTitle} description={labels.emptyDescription} />
        </div>
      ) : null}

      {items.length > 0 ? (
        <ul className={styles.list}>
          {items.map((item) => {
            const createdAt = new Date(item.createdAt);
            return (
              <li key={item.id} data-testid="ligne-organisation-en-attente">
                <Card title={item.name} titleLevel={3} tone="flat">
                  <dl className={styles.details}>
                    <div className={styles.detailRow}>
                      <dt className={styles.term}>{vocabulary.typeLabel}</dt>
                      <dd className={styles.value} data-testid="ligne-type">
                        {vocabulary.types[item.type]}
                      </dd>
                    </div>
                    <div className={styles.detailRow}>
                      <dt className={styles.term}>{vocabulary.registrationNumberLabel}</dt>
                      <dd className={styles.value} data-testid="ligne-immatriculation">
                        {item.registrationNumber}
                      </dd>
                    </div>
                    <div className={styles.detailRow}>
                      <dt className={styles.term}>{vocabulary.territoryCodeLabel}</dt>
                      <dd className={styles.value} data-testid="ligne-territoire">
                        {item.territoryCode ?? vocabulary.noTerritory}
                      </dd>
                    </div>
                    <div className={styles.detailRow}>
                      <dt className={styles.term}>{labels.submittedAtLabel}</dt>
                      <dd className={styles.value}>
                        <time dateTime={item.createdAt}>{TIME_FORMAT.format(createdAt)}</time>
                      </dd>
                    </div>
                    <div className={styles.detailRow}>
                      <dt className={styles.term}>{labels.waitingSinceLabel}</dt>
                      <dd className={styles.value} data-testid="ligne-anciennete">
                        {formatAge(createdAt, now)}
                      </dd>
                    </div>
                    <div className={styles.detailRow}>
                      <dt className={styles.term}>{labels.requestedByLabel}</dt>
                      <dd className={styles.value} data-testid="ligne-demandeur">
                        {item.requestedBy.displayName ?? labels.requestedByUnknown}
                      </dd>
                    </div>
                  </dl>
                </Card>
              </li>
            );
          })}
        </ul>
      ) : null}

      {nextCursor !== null ? (
        <div data-testid="action-page-suivante">
          <Button
            variant="secondary"
            fullWidth
            busy={isBusy}
            disabled={isBusy}
            onClick={() => {
              if (!isBusy) {
                void loadMore();
              }
            }}
          >
            {labels.loadMore}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

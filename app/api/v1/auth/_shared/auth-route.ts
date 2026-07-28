import { defineRoute, type RouteContext } from '@/application/api-route';
import { AppError, isAppError, toErrorResponse } from '@/application/errors';
import { requireSessionFromRequest, type Session } from '@/authorization';
import type { RequestOrigin } from '@/domain/identity';

/**
 * Enveloppe commune aux cinq routes d'authentification (docs/api-contract.md).
 *
 * Elle applique, pour toutes, les quatre règles communes du contrat que `defineRoute` ne peut pas
 * porter seul : origine reconnue sur les méthodes non sûres, corps strictement `application/json`,
 * réponses jamais mises en cache, et barrière de session pour les routes protégées.
 *
 * POURQUOI `isPublic: true` PARTOUT, Y COMPRIS SUR LES ROUTES PROTÉGÉES. `defineRoute` refuse par
 * défaut en levant `UNAUTHENTICATED` AVANT d'appeler le gestionnaire : c'est le refus systématique
 * d'ADR-014, posé au lot 0 quand aucune session n'existait. ADR-014 prévoit explicitement que
 * « le lot 1 remplace le refus systématique par une vérification de session réelle, sans modifier
 * le principe ni le code d'erreur exposé ». C'est ce que fait ce module : le drapeau neutralise le
 * refus aveugle pour laisser passer la barrière réelle, `requireSessionFromRequest`, qui lève le
 * MÊME `UNAUTHENTICATED`. Aucune route ne devient ouverte par ce biais.
 *
 * `src/application/api-route.ts` étant hors du périmètre de cette story, l'option
 * `requiresSession` qui rendrait la chose lisible d'un coup d'œil n'y a pas été ajoutée. C'est la
 * reprise à faire : tant qu'elle n'est pas faite, AUCUNE route ne doit appeler `defineRoute`
 * directement avec `isPublic: true` sans passer par une des deux fabriques ci-dessous.
 *
 * EXEMPTION DE `PLATFORM_READ_ONLY`. Le contrat exempte ces routes du mode lecture seule : refuser
 * la connexion pendant un incident empêcherait les coordinateurs de consulter les missions en
 * cours, donc aggraverait l'incident au lieu de le contenir. L'exemption est aujourd'hui acquise
 * par construction — aucun garde de lecture seule n'existe encore côté route. Le jour où il
 * arrive, il doit être posé ailleurs qu'ici, ou ces cinq routes explicitement listées en dehors.
 */

/**
 * Corps minuscules par nature : le plus gros est une adresse de 254 caractères. Deux kibioctets
 * laissent une marge confortable et réduisent d'autant la surface d'analyse offerte à un appelant
 * non authentifié (`defineRoute` refuse au-delà, avant toute lecture).
 */
const AUTH_MAX_BODY_BYTES = 2_048;

const JSON_MEDIA_TYPE = 'application/json';
const SAFE_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS'];

/** Bornes de lecture des en-têtes d'origine. Au-delà, la valeur n'est plus une adresse. */
const MAX_ADDRESS_LENGTH = 64;
const MAX_USER_AGENT_LENGTH = 400;

export interface AuthRouteContext extends RouteContext {
  /** Origine de l'appel, reconstituée par la route et hachée par le domaine. */
  readonly origin: RequestOrigin;
}

export interface AuthenticatedRouteContext extends AuthRouteContext {
  readonly session: Session;
}

export type AuthRouteHandler = (context: AuthRouteContext) => Promise<Response>;
export type AuthenticatedRouteHandler = (context: AuthenticatedRouteContext) => Promise<Response>;

/**
 * Hôte attendu pour cette requête.
 *
 * `Host` est posé par le navigateur à partir de l'adresse réellement visitée : un site tiers ne
 * peut pas le choisir. C'est ce qui rend la comparaison avec `Origin` significative. Les en-têtes
 * de mandataire (`X-Forwarded-Host`) sont volontairement ignorés ici : ils sont fournis par
 * l'appelant tant qu'aucun mandataire de confiance n'est déclaré en configuration, et les prendre
 * en compte permettrait de valider n'importe quelle origine en la déclarant soi-même.
 */
function readExpectedHost(request: Request): string | undefined {
  const host = request.headers.get('host')?.trim();
  if (host !== undefined && host.length > 0) {
    return host.toLowerCase();
  }
  try {
    return new URL(request.url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Vérification d'origine sur les méthodes non sûres, exigée par `docs/security.md` et rappelée
 * par ADR-017 : `SameSite=Lax` est une première ligne, elle ne suffit pas seule.
 *
 * TROIS CAS, TROIS TRAITEMENTS.
 *
 * 1. `Origin` présent : son hôte doit être exactement celui de la requête. `Origin: null`, émis
 *    par un cadre isolé ou un document `data:`, ne s'analyse pas en URL et tombe donc en refus.
 * 2. `Origin` absent mais `Sec-Fetch-Site` présent : tout ce qui n'est pas `same-origin` ou
 *    `none` est refusé. C'est le cas d'une soumission de formulaire par un navigateur ancien qui
 *    n'aurait pas posé `Origin`.
 * 3. Ni l'un ni l'autre : accepté. Ce n'est pas un navigateur — un client en ligne de commande,
 *    un test d'intégration, une sonde. La falsification de requête inter-site suppose un
 *    navigateur qui joigne le cookie tout seul ; hors navigateur, l'appelant doit déjà détenir le
 *    jeton, auquel cas il n'a rien à falsifier. Refuser ce cas fermerait l'API aux clients
 *    légitimes sans rien fermer à l'attaquant.
 *
 * S'y ajoute, pour les routes à corps, l'exigence de `application/json` : un formulaire HTML
 * inter-site ne sait produire que trois types de contenu, dont celui-ci ne fait pas partie. Il ne
 * peut donc pas atteindre ces routes sans un contrôle préalable que la politique CORS refuse.
 */
function assertTrustedOrigin(request: Request): void {
  if (SAFE_METHODS.includes(request.method)) {
    return;
  }
  const declared = request.headers.get('origin');
  if (declared === null) {
    const site = request.headers.get('sec-fetch-site');
    if (site !== null && site !== 'same-origin' && site !== 'none') {
      throw new AppError('FORBIDDEN');
    }
    return;
  }
  const expected = readExpectedHost(request);
  if (expected === undefined) {
    throw new AppError('FORBIDDEN');
  }
  let declaredHost: string;
  try {
    declaredHost = new URL(declared).host.toLowerCase();
  } catch {
    throw new AppError('FORBIDDEN');
  }
  if (declaredHost.length === 0 || declaredHost !== expected) {
    throw new AppError('FORBIDDEN');
  }
}

/**
 * Origine de l'appel, telle que la route peut la reconstituer.
 *
 * LIMITE CONNUE, ET ELLE COMPTE. `X-Forwarded-For` est fourni par l'appelant tant qu'un
 * mandataire de confiance ne le réécrit pas. Un attaquant peut donc changer de valeur à chaque
 * requête et se rendre invisible à la limitation par source. Le choix est assumé : ne pas lire cet
 * en-tête ferait partager un compteur unique à tout le trafic, et une seule source suffirait alors
 * à bloquer la connexion de tout le monde — un déni de service offert. La dimension qui protège
 * réellement les comptes est celle par identifiant, qui, elle, ne dépend d'aucun en-tête.
 *
 * À REPRENDRE HORS PÉRIMÈTRE : une variable de configuration déclarant le mandataire de confiance
 * (et le nombre de sauts à retirer) doit rejoindre `src/config/env.ts`.
 */
function readRequestOrigin(request: Request): RequestOrigin {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0];
  const candidates: readonly (string | null | undefined)[] = [
    forwarded,
    request.headers.get('x-real-ip'),
  ];
  let ipAddress: string | undefined;
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed !== undefined && trimmed.length > 0) {
      ipAddress = trimmed.slice(0, MAX_ADDRESS_LENGTH);
      break;
    }
  }
  const userAgent = request.headers.get('user-agent')?.trim();
  return {
    ...(ipAddress !== undefined ? { ipAddress } : {}),
    ...(userAgent !== undefined && userAgent.length > 0
      ? { userAgent: userAgent.slice(0, MAX_USER_AGENT_LENGTH) }
      : {}),
  };
}

/**
 * Lecture du corps JSON.
 *
 * Le type de contenu est exigé et non deviné. Un corps vide devient `{}` afin que la validation
 * de schéma produise une erreur de champ exploitable par l'écran, plutôt qu'une erreur de syntaxe
 * qui ne dirait pas quoi corriger.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  const mediaType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (mediaType !== JSON_MEDIA_TYPE) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE');
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch (error) {
    throw new AppError('VALIDATION_ERROR', { cause: error });
  }
  if (raw.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    // Le détail de l'erreur d'analyse contient le corps envoyé : il ne sort pas d'ici.
    throw new AppError('VALIDATION_ERROR', { details: { fields: ['(racine)'] }, cause: error });
  }
}

export interface JsonResponseOptions {
  readonly status: number;
  /** En-tête `Set-Cookie` complet. Le jeton n'apparaît jamais ailleurs. */
  readonly setCookie?: string | undefined;
}

/** Réponse JSON, jamais mise en cache : elle dépend de l'appelant et du moment. */
export function jsonResponse(body: unknown, options: JsonResponseOptions): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  if (options.setCookie !== undefined) {
    headers.set('set-cookie', options.setCookie);
  }
  return new Response(JSON.stringify(body), { status: options.status, headers });
}

/** Réponse sans corps, pour les `204`. */
export function emptyResponse(status: number, setCookie?: string): Response {
  const headers = new Headers({ 'cache-control': 'no-store' });
  if (setCookie !== undefined) {
    headers.set('set-cookie', setCookie);
  }
  return new Response(null, { status, headers });
}

/**
 * Ajoute `Retry-After` à une réponse `RATE_LIMITED`.
 *
 * Le délai est déjà porté par `details.retryAfterSeconds` dans le corps, que l'écran de connexion
 * lit pour afficher le décompte. L'en-tête existe pour les appelants qui ne lisent pas le corps —
 * clients techniques, sondes, intermédiaires — et parce qu'un `429` sans `Retry-After` invite à
 * réessayer immédiatement, c'est-à-dire à aggraver la situation qui a déclenché le blocage.
 */
function toRateLimitedResponse(error: unknown, requestId: string): Response | undefined {
  if (!isAppError(error) || error.code !== 'RATE_LIMITED') {
    return undefined;
  }
  const response = toErrorResponse(error, requestId);
  const seconds = error.details.retryAfterSeconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('retry-after', String(Math.max(1, Math.ceil(seconds))));
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Convertit `RATE_LIMITED` sur place, au lieu de le laisser remonter à `defineRoute`.
 *
 * CE QUE CELA COÛTE, ET POURQUOI C'EST NUL. L'exception ne remontant plus, la ligne de journal
 * émise par `defineRoute` ne porte pas `errorCode` pour ce cas. Aucune information n'est perdue :
 * `RATE_LIMITED` est le SEUL code de `ERROR_CODES` associé au statut 429, la ligne
 * `"status":429` le désigne donc sans ambiguïté. Journaliser le code ici en plus doublerait le
 * nombre de lignes sur le chemin exact conçu pour délester la plateforme sous attaque.
 */
async function runWithRateLimitHeader(
  requestId: string,
  run: () => Promise<Response>,
): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    const limited = toRateLimitedResponse(error, requestId);
    if (limited !== undefined) {
      return limited;
    }
    // Tout le reste part vers la conversion normalisée de `defineRoute`, qui journalise le code.
    throw error;
  }
}

/**
 * Route d'authentification ouverte, sans session requise.
 *
 * Le nom est explicite : ces routes sont hostiles par nature et le contrat leur impose des
 * réponses neutres. Elles n'en portent pas moins la vérification d'origine et la limitation de
 * tentatives, cette dernière appliquée par le domaine.
 */
export function definePublicAuthRoute(
  handler: AuthRouteHandler,
): (request: Request) => Promise<Response> {
  return defineRoute(
    async (context) =>
      runWithRateLimitHeader(context.requestId, async () => {
        assertTrustedOrigin(context.request);
        return handler({ ...context, origin: readRequestOrigin(context.request) });
      }),
    { isPublic: true, maxBodyBytes: AUTH_MAX_BODY_BYTES },
  );
}

/**
 * Route d'authentification protégée : la session est résolue AVANT toute lecture et AVANT tout
 * appel au gestionnaire. Un appel direct, sans passer par l'interface, se heurte à cette seule
 * barrière et n'en trouve aucune autre à contourner (CLAUDE.md : masquer un bouton n'est jamais
 * un contrôle d'accès).
 */
export function defineAuthenticatedRoute(
  handler: AuthenticatedRouteHandler,
): (request: Request) => Promise<Response> {
  return defineRoute(
    async (context) =>
      runWithRateLimitHeader(context.requestId, async () => {
        assertTrustedOrigin(context.request);
        const session = await requireSessionFromRequest(context.request);
        return handler({ ...context, origin: readRequestOrigin(context.request), session });
      }),
    { isPublic: true, maxBodyBytes: AUTH_MAX_BODY_BYTES },
  );
}

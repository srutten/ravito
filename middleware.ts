import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/**
 * En-têtes de sécurité posés sur toutes les réponses (docs/security.md, section Sécurité API).
 *
 * Ce fichier s'exécute dans le moteur de périphérie de Next : il n'utilise que des API Web
 * standard et ne dépend d'aucun module Node. Il est volontairement autonome, sans import depuis
 * `src/`, car la couche d'observabilité repose sur `node:async_hooks` et `node:crypto`,
 * indisponibles ici.
 */

/** Environnement de déploiement logique. Inconnu vaut « pas local » : réglage le plus strict. */
const APP_ENVIRONMENT = process.env.APP_ENV;
/** Vrai uniquement sous `next dev`, jamais dans un artefact de production. */
const IS_DEVELOPMENT_SERVER = process.env.NODE_ENV === 'development';
const IS_LOCAL_ENVIRONMENT =
  APP_ENVIRONMENT === 'local' || (APP_ENVIRONMENT === undefined && IS_DEVELOPMENT_SERVER);

const REQUEST_ID_HEADER = 'x-request-id';
const NONCE_HEADER = 'x-nonce';
const CSP_HEADER = 'content-security-policy';
const API_PATH_PREFIX = '/api/';
const NONCE_BYTE_LENGTH = 16;
/** Un an. Sans `preload` : l'inscription sur la liste préchargée est une décision d'exploitation. */
const HSTS_VALUE = 'max-age=31536000; includeSubDomains';

const REQUEST_ID_PATTERN = /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function createNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/** Reprend l'identifiant fourni s'il respecte le format de la plateforme, sinon en crée un. */
function resolveRequestId(request: NextRequest): string {
  const provided = request.headers.get(REQUEST_ID_HEADER);
  if (provided !== null && REQUEST_ID_PATTERN.test(provided)) {
    return provided;
  }
  return `req_${crypto.randomUUID()}`;
}

/**
 * Politique de sécurité du contenu.
 *
 * Les scripts ne sont acceptés que par nonce, propagé à Next par l'en-tête de requête, complété
 * par `strict-dynamic` pour que les modules chargés par un script de confiance héritent de cette
 * confiance sans liste d'hôtes. `'self'` reste présent comme repli pour les navigateurs qui
 * ignorent `strict-dynamic`.
 *
 * Assouplissements réservés au serveur de développement, jamais présents en production :
 * - `'unsafe-eval'` : le rafraîchissement à chaud de React et la compilation incrémentale de Next
 *   évaluent du code à la volée. Un artefact de production ne contient plus ce mécanisme, la
 *   directive est donc retirée dès que `NODE_ENV` n'est pas `development`.
 * - `ws:` et `wss:` dans `connect-src` : le canal de rechargement à chaud est une websocket vers
 *   le serveur local. La production n'ouvre aucune websocket au lot 0.
 *
 * `style-src` conserve `'unsafe-inline'` : Next injecte des styles critiques en ligne et un nonce
 * sur cette directive désactiverait `'unsafe-inline'` pour les navigateurs récents, ce qui
 * casserait le rendu. Le risque associé à une feuille de style en ligne est sans commune mesure
 * avec celui d'un script, et `script-src` reste strict.
 */
function buildContentSecurityPolicy(nonce: string): string {
  const scriptSrc = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  const connectSrc = ["'self'"];
  if (IS_DEVELOPMENT_SERVER) {
    scriptSrc.push("'unsafe-eval'");
    connectSrc.push('ws:', 'wss:');
  }

  const directives = [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    `connect-src ${connectSrc.join(' ')}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "media-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];

  if (!IS_LOCAL_ENVIRONMENT) {
    // Inutile en local, où le service est servi en clair sur la boucle locale.
    directives.push('upgrade-insecure-requests');
  }

  return directives.join('; ');
}

function applySecurityHeaders(headers: Headers, contentSecurityPolicy: string): void {
  headers.set(CSP_HEADER, contentSecurityPolicy);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('x-frame-options', 'DENY');
  headers.set(
    'permissions-policy',
    'geolocation=(), camera=(), microphone=(), interest-cohort=(), payment=(), usb=()',
  );
  headers.set('cross-origin-opener-policy', 'same-origin');
  headers.set('cross-origin-resource-policy', 'same-origin');
  if (!IS_LOCAL_ENVIRONMENT) {
    headers.set('strict-transport-security', HSTS_VALUE);
  }
}

/**
 * Politique de partage entre origines : aucune origine tierce n'est autorisée, jamais de joker.
 *
 * L'absence d'`Access-Control-Allow-Origin` est le refus lui-même : le navigateur bloque alors la
 * lecture de la réponse. Le contrôle contre la falsification de requête inter-site sera complété
 * au lot 1, lorsque des cookies de session existeront.
 */
function applyCorsHeaders(headers: Headers): void {
  headers.set('vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
}

export function middleware(request: NextRequest): NextResponse {
  const nonce = createNonce();
  const requestId = resolveRequestId(request);
  const contentSecurityPolicy = buildContentSecurityPolicy(nonce);
  const isApiPath = request.nextUrl.pathname.startsWith(API_PATH_PREFIX);

  // Réponse explicite au contrôle préalable : rien n'est autorisé, la réponse reste correcte.
  if (isApiPath && request.method === 'OPTIONS') {
    const preflight = new NextResponse(null, { status: 204 });
    applySecurityHeaders(preflight.headers, contentSecurityPolicy);
    applyCorsHeaders(preflight.headers);
    preflight.headers.set(REQUEST_ID_HEADER, requestId);
    return preflight;
  }

  // Les en-têtes de requête transmis à l'application sont réécrits, jamais complétés : une valeur
  // envoyée par le client ne peut pas se faire passer pour le nonce ou l'identifiant de requête.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  requestHeaders.set(REQUEST_ID_HEADER, requestId);
  // Next relit cette politique pour appliquer le nonce à ses propres scripts.
  requestHeaders.set(CSP_HEADER, contentSecurityPolicy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  applySecurityHeaders(response.headers, contentSecurityPolicy);
  response.headers.set(REQUEST_ID_HEADER, requestId);
  if (isApiPath) {
    applyCorsHeaders(response.headers);
  }
  return response;
}

/**
 * Toutes les réponses sont couvertes, ressources statiques comprises : un en-tête de sécurité
 * manquant sur une seule route suffirait à ouvrir une brèche.
 */
export const config = {
  matcher: ['/:path*'],
};

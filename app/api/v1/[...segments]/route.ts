import { defineRoute, type RouteHandler } from '@/application/api-route';
import { AppError } from '@/application/errors';

/**
 * Route attrape-tout de `/api/v1`.
 *
 * Elle applique le refus par défaut : toute adresse qui n'est pas une route explicitement
 * déclarée répond `UNAUTHENTICATED` avec le statut 401, avant même de considérer son existence.
 * Répondre 401 plutôt que 404 est délibéré : un appelant non authentifié n'apprend pas quelles
 * routes existent (docs/threat-model.md, reconnaissance ; docs/security.md, refus par défaut).
 *
 * La route statique `/api/v1/health` conserve la priorité : dans le routeur de Next, un segment
 * littéral l'emporte sur un segment dynamique.
 */

export const dynamic = 'force-dynamic';

/**
 * Inatteignable tant que le refus par défaut s'applique : `defineRoute` répond 401 sans appeler
 * le gestionnaire. Conservé pour que la route reste correcte lorsque le lot 1 aura livré
 * l'authentification et que la question deviendra « cette route existe-t-elle ».
 */
const rejectUnknownRoute: RouteHandler = () => {
  throw new AppError('NOT_FOUND');
};

export const GET = defineRoute(rejectUnknownRoute);
export const POST = defineRoute(rejectUnknownRoute);
export const PATCH = defineRoute(rejectUnknownRoute);
export const PUT = defineRoute(rejectUnknownRoute);
export const DELETE = defineRoute(rejectUnknownRoute);

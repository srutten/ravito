-- =============================================================================
-- 0004 — Types énumérés partagés des machines à états
-- Lot 0 · socle transverse
--
-- Objet   : interdire les valeurs libres. Un statut stocké en `text` autorise
--           `'published'`, `'PUBLISHÉ'` ou une faute de frappe, et la faute ne
--           se voit qu'au moment où une requête de filtrage renvoie
--           silencieusement une ligne de moins. Un type énuméré fait échouer
--           l'écriture, immédiatement, côté serveur.
-- Source  : docs/state-machines.md — les valeurs sont reprises telles quelles,
--           dans l'ordre du document, sans ajout ni omission.
-- Retour  : supabase/migrations/0004_shared-enums.down.sql
--
-- Contrat pour les lots suivants : ces quatre types sont la référence unique.
-- Aucune colonne de statut ne doit être déclarée en `text` avec une contrainte
-- `CHECK`, sous peine de faire diverger deux listes de valeurs.
--
-- Ajouter une valeur plus tard : `ALTER TYPE ... ADD VALUE` est possible et non
-- bloquant, mais irréversible — PostgreSQL ne sait pas retirer une valeur d'un
-- type énuméré. Toute nouvelle valeur doit donc être décidée dans
-- docs/state-machines.md avant d'être écrite ici.
--
-- L'ordre de déclaration fixe l'ordre de tri du type. Il suit la progression
-- naturelle de chaque machine à états, ce qui rend `ORDER BY status` lisible
-- dans les tableaux de bord sans table de correspondance.
-- =============================================================================

-- `CREATE TYPE` n'accepte pas `IF NOT EXISTS`. Le test d'existence explicite
-- est préféré à `EXCEPTION WHEN duplicate_object`, qui masquerait aussi une
-- erreur réelle survenue pendant la création.

-- --- Demande opérationnelle --------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'operational_request_status'
  ) THEN
    CREATE TYPE public.operational_request_status AS ENUM (
      'DRAFT',
      'PENDING_VALIDATION',
      'PUBLISHED',
      'PARTIALLY_COVERED',
      'COVERED',
      'IN_PROGRESS',
      'SUSPENDED',
      'CLOSED',
      'CANCELLED'
    );
  END IF;
END
$$;

-- --- Ressource ---------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'resource_status'
  ) THEN
    CREATE TYPE public.resource_status AS ENUM (
      'UNAVAILABLE',
      'AVAILABLE',
      'PROPOSED',
      'RESERVED',
      'IN_TRANSIT',
      'ON_SITE',
      'ENGAGED',
      'RETURNING',
      'RETURNED',
      'MAINTENANCE',
      'SUSPENDED'
    );
  END IF;
END
$$;

-- --- Proposition (entité `Offer` du modèle de domaine) -----------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'offer_status'
  ) THEN
    CREATE TYPE public.offer_status AS ENUM (
      'DRAFT',
      'SUBMITTED',
      'WITHDRAWN',
      'ACCEPTED',
      'REJECTED',
      'EXPIRED'
    );
  END IF;
END
$$;

-- --- Mission -----------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'mission_status'
  ) THEN
    CREATE TYPE public.mission_status AS ENUM (
      'PROPOSED',
      'ACCEPTED',
      'VALIDATED',
      'DEPARTURE_CONFIRMED',
      'IN_TRANSIT',
      'ARRIVED',
      'HANDED_OVER',
      'ACTIVE',
      'RETURNING',
      'COMPLETED',
      'CANCELLED',
      'INCIDENT'
    );
  END IF;
END
$$;

COMMENT ON TYPE public.operational_request_status IS
  'États de la demande opérationnelle. Référence : docs/state-machines.md.';

-- Point ouvert signalé au lot 2 : docs/domain-model.md donne à `Resource` deux
-- colonnes distinctes, `status` et `availabilityStatus`, alors que
-- docs/state-machines.md ne décrit qu'une seule liste d'états mêlant la
-- disponibilité (`AVAILABLE`, `MAINTENANCE`) et l'avancement de la mission en
-- cours (`IN_TRANSIT`, `ON_SITE`). Le socle fournit une seule énumération, la
-- seule documentée. Le lot 2 doit trancher : soit `availability_status` porte
-- ce type et `status` devient un cycle de vie administratif distinct, soit les
-- deux colonnes fusionnent. Aucune valeur n'a été inventée ici pour anticiper
-- cet arbitrage.
COMMENT ON TYPE public.resource_status IS
  'États de la ressource. Référence : docs/state-machines.md. '
  'Arbitrage attendu au lot 2 entre les colonnes status et availability_status.';

COMMENT ON TYPE public.offer_status IS
  'États de la proposition (entité Offer). Référence : docs/state-machines.md.';

-- Les états terminaux sont `COMPLETED` et `CANCELLED`. `INCIDENT` n'est pas
-- terminal : docs/state-machines.md autorise INCIDENT vers RETURNING,
-- COMPLETED et CANCELLED. Une ressource dont la mission est en INCIDENT reste
-- donc engagée, et l'index unique partiel anti-double affectation doit la
-- considérer comme telle (voir 0007).
COMMENT ON TYPE public.mission_status IS
  'États de la mission. Référence : docs/state-machines.md. '
  'États terminaux : COMPLETED et CANCELLED. INCIDENT n''est pas terminal.';

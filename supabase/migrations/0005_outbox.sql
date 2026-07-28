-- =============================================================================
-- 0005 — Table `outbox`
-- Lot 0 · socle transverse
--
-- Objet   : garantir qu'une notification n'est planifiée que si la mutation
--           métier a réellement été validée. L'écriture dans `outbox` a lieu
--           dans la transaction de la mutation (docs/architecture.md, flux
--           d'affectation) : si la transaction échoue, la notification
--           disparaît avec elle ; si elle réussit, la notification est
--           persistée même en cas de panne du service d'envoi.
-- Source  : docs/architecture.md (champs de l'outbox), ADR-006.
-- Retour  : supabase/migrations/0005_outbox.down.sql
--
-- Le drainage lui-même, les tentatives et la file d'échec relèvent du lot 5.
-- Le socle ne fournit que la table, ses index et ses droits.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Nom d'événement au passé, en majuscules, stable dans le temps
  -- (docs/coding-standards.md). La contrainte de forme empêche qu'un lot
  -- introduise `mission.validated` à côté de `MISSION_VALIDATED` et casse
  -- silencieusement le routage des notifications.
  event_type text NOT NULL
    CONSTRAINT outbox_event_type_format CHECK (event_type ~ '^[A-Z][A-Z0-9_]{2,63}$'),

  -- Agrégat concerné, par exemple ('MISSION', <uuid de la mission>). Pas de
  -- clé étrangère : l'outbox doit survivre à la suppression de l'agrégat, sans
  -- quoi une purge métier effacerait la preuve qu'une notification était due.
  aggregate_type text NOT NULL
    CONSTRAINT outbox_aggregate_type_format CHECK (aggregate_type ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  aggregate_id uuid NOT NULL,

  -- Charge variable selon le type d'événement : JSONB est ici légitime
  -- (docs/database-design.md). Ne doit contenir que des identifiants et le
  -- minimum nécessaire au rendu du message — jamais de position précise, de
  -- téléphone complet ni de contenu sensible d'incident
  -- (docs/observability.md, docs/privacy-rgpd.md). La charge est recopiée dans
  -- les journaux du service d'envoi.
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT outbox_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- NULL tant que le message n'a pas été traité : c'est le critère de
  -- sélection du drainage, et le critère d'éligibilité à la purge.
  processed_at timestamptz,

  attempt_count integer NOT NULL DEFAULT 0
    CONSTRAINT outbox_attempt_count_positive CHECK (attempt_count >= 0),

  -- Message technique du dernier échec. Longueur bornée pour qu'une trace du
  -- fournisseur ne transforme pas la table en dépotoir, et parce qu'une erreur
  -- verbeuse finit par recopier des données personnelles.
  last_error text
    CONSTRAINT outbox_last_error_length CHECK (char_length(last_error) <= 2000)
);

COMMENT ON TABLE public.outbox IS
  'File transactionnelle des événements à notifier (ADR-006). '
  'Rétention : purge des lignes traitées, voir supabase/README.md.';
COMMENT ON COLUMN public.outbox.processed_at IS
  'NULL tant que le message n''est pas traité. Critère de drainage et de purge.';
COMMENT ON COLUMN public.outbox.payload IS
  'Identifiants et données minimales de rendu. Aucune donnée sensible : '
  'la charge est recopiée dans les journaux du fournisseur d''envoi.';
COMMENT ON COLUMN public.outbox.last_error IS
  'Message technique du dernier échec. Ne doit contenir ni secret, ni donnée personnelle.';

-- `updated_at` est utile ici : la ligne est mutable, le drainage incrémente
-- `attempt_count` et écrit `last_error`. La colonne permet de repérer une file
-- qui tourne à vide sans progresser (docs/operations.md, runbook file bloquée).
CREATE OR REPLACE TRIGGER outbox_set_updated_at
  BEFORE UPDATE ON public.outbox
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- --- Index -------------------------------------------------------------------
-- Drainage : `WHERE processed_at IS NULL`. Un index B-tree indexe les NULL, la
-- même structure sert donc aussi la purge de rétention
-- (`WHERE processed_at < ...`). Un index partiel serait plus compact mais ne
-- couvrirait pas la purge ; le lot 5 pourra l'affiner une fois la volumétrie
-- réelle connue.
CREATE INDEX IF NOT EXISTS idx_outbox_processed_at
  ON public.outbox (processed_at);

-- Reconstitution de la chronologie des événements d'un agrégat, utilisée par
-- le diagnostic et par la détection de doublons de notification.
CREATE INDEX IF NOT EXISTS idx_outbox_aggregate
  ON public.outbox (aggregate_type, aggregate_id);

-- --- Droits ------------------------------------------------------------------
-- L'application écrit les messages et les marque traités. Elle ne les supprime
-- pas : la purge de rétention est une tâche d'exploitation, exécutée avec le
-- compte de maintenance. Séparer les deux évite qu'un défaut de drainage se
-- traduise par un effacement irréversible de messages non envoyés.
GRANT SELECT, INSERT, UPDATE ON public.outbox TO fire_support_app;
REVOKE DELETE, TRUNCATE ON public.outbox FROM fire_support_app;

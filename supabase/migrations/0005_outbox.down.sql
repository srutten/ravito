-- =============================================================================
-- Retour arrière de 0005 — Table `outbox`
--
-- Le retour arrière est possible, mais il détruit des notifications non
-- envoyées. Le garde-fou ci-dessous refuse la suppression tant qu'il reste des
-- messages non traités : un retour arrière ne doit jamais faire disparaître en
-- silence une notification due à un intervenant engagé sur une mission.
--
-- Pour forcer malgré tout, la procédure est explicite et tracée : drainer la
-- file, ou l'exporter, puis relancer. Elle est décrite dans supabase/README.md.
-- =============================================================================

DO $$
DECLARE
  pending_count bigint;
BEGIN
  IF to_regclass('public.outbox') IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*) INTO pending_count FROM public.outbox WHERE processed_at IS NULL;

  IF pending_count > 0 THEN
    RAISE EXCEPTION
      'Retour arrière refusé : % message(s) non traité(s) dans outbox. '
      'Drainer ou exporter la file avant de supprimer la table.', pending_count
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$$;

DROP TABLE IF EXISTS public.outbox;

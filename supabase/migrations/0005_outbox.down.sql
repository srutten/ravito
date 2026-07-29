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

-- LE CONTRÔLE ET LA SUPPRESSION SONT DANS UN SEUL BLOC, DONC INDISSOCIABLES. Séparés — le contrôle
-- en `DO`, le `DROP TABLE` en énoncé suivant — psql les dissociait : il envoie chaque énoncé
-- séparément, en autocommit, et sans `-v ON_ERROR_STOP=1` il poursuit après un refus. La table
-- partait alors MALGRÉ le refus, avec ses messages non envoyés, et le garde-fou ne gardait rien.
-- Réunis ici, le refus annule le bloc entier : rien ne peut plus s'exécuter après lui.
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

  -- Sans `IF EXISTS` : l'existence vient d'être établie deux énoncés plus haut, et un `DROP` qui
  -- ne trouverait rien signalerait une suppression concurrente qu'il vaut mieux voir échouer.
  DROP TABLE public.outbox;
END
$$;

-- Retrait de la ligne de suivi, CONDITIONNÉ à la disparition réelle de l'objet, vérifiée ici même.
-- Sans ce retrait, `db:status` annoncerait une base à jour dont les objets ont disparu. Sans cette
-- condition, la position en fin de fichier ne protégerait rien : `psql -f` envoie chaque énoncé
-- séparément, en autocommit, et sans `-v ON_ERROR_STOP=1` il POURSUIT après un refus. La ligne
-- d'un retour arrière que PostgreSQL vient de REFUSER partirait donc quand même, et le moteur
-- décrirait une base plus démontée qu'elle ne l'est. La propriété tient du FICHIER, jamais de la
-- façon de l'invoquer (`supabase/README.md`, « Dérouler un retour arrière »). Le test d'existence
-- de la table de suivi couvre une base montée hors moteur : il n'y a alors rien à retirer.
DO $$
BEGIN
  IF to_regclass('public.outbox') IS NOT NULL THEN
    RAISE EXCEPTION
      'Retour arrière 0005 incomplet : la table public.outbox existe encore. '
      'La ligne 0005 de public.schema_migrations est CONSERVÉE, elle dit vrai.'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM public.schema_migrations WHERE version = '0005';
  END IF;
END
$$;

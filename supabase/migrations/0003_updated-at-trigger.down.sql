-- =============================================================================
-- Retour arrière de 0003 — Fonction `updated_at`
--
-- Volontairement sans `CASCADE` : si un déclencheur d'une table encore
-- présente dépend de la fonction, PostgreSQL refuse la suppression. C'est le
-- comportement recherché — il faut d'abord dérouler les migrations qui ont
-- attaché le déclencheur. Un `CASCADE` détruirait ces déclencheurs en silence
-- et laisserait des tables dont `updated_at` cesserait d'être maintenu sans
-- qu'aucune erreur ne le signale.
-- =============================================================================

DROP FUNCTION IF EXISTS public.set_updated_at();

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
  IF to_regprocedure('public.set_updated_at()') IS NOT NULL THEN
    RAISE EXCEPTION
      'Retour arrière 0003 incomplet : la fonction public.set_updated_at() existe encore. '
      'La ligne 0003 de public.schema_migrations est CONSERVÉE, elle dit vrai.'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM public.schema_migrations WHERE version = '0003';
  END IF;
END
$$;

-- =============================================================================
-- Retour arrière de 0007 — Table témoin
--
-- Sans réserve : la table ne porte aucune donnée métier, seulement des lignes
-- écrites par les tests d'intégration du lot 0. Sa suppression est d'ailleurs
-- programmée au lot 5.
-- =============================================================================

DROP TABLE IF EXISTS public.idempotency_witness;

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
  IF to_regclass('public.idempotency_witness') IS NOT NULL THEN
    RAISE EXCEPTION
      'Retour arrière 0007 incomplet : la table public.idempotency_witness existe encore. '
      'La ligne 0007 de public.schema_migrations est CONSERVÉE, elle dit vrai.'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM public.schema_migrations WHERE version = '0007';
  END IF;
END
$$;

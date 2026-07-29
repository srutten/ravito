-- =============================================================================
-- Retour arrière de 0011 — Table `auth_challenges`
--
-- Sans réserve particulière : la table ne porte que des codes de connexion à
-- durée de vie courte, tous hachés. Sa suppression n'efface aucune preuve — les
-- connexions réussies sont tracées dans `audit_logs`, qui n'est pas concerné —
-- et n'interrompt aucune mission. Les codes en circulation deviennent
-- inutilisables, ce qui est le comportement attendu d'un retour arrière du
-- mécanisme de connexion.
--
-- Sans `CASCADE` : aucun objet d'un lot ultérieur ne doit dépendre de cette
-- table. Si PostgreSQL refuse, c'est qu'un tel objet existe, et il faut dérouler
-- son retour arrière d'abord.
-- =============================================================================

DROP TABLE IF EXISTS public.auth_challenges;

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
  IF to_regclass('public.auth_challenges') IS NOT NULL THEN
    RAISE EXCEPTION
      'Retour arrière 0011 incomplet : la table public.auth_challenges existe encore. '
      'La ligne 0011 de public.schema_migrations est CONSERVÉE, elle dit vrai.'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM public.schema_migrations WHERE version = '0011';
  END IF;
END
$$;

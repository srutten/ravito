-- =============================================================================
-- Retour arrière de 0012 — Table `auth_attempts`
--
-- Point à connaître avant de l'exécuter : supprimer cette table LÈVE TOUS LES
-- BLOCAGES en cours. Si le retour arrière est déclenché pendant une campagne de
-- tentatives, celle-ci reprend immédiatement sans limite. Ce n'est pas une
-- raison de refuser la suppression — un garde-fou qui bloquerait sur la
-- présence de compteurs empêcherait tout retour arrière dès la première
-- tentative enregistrée, y compris en développement — mais c'en est une pour ne
-- pas la déclencher en réaction à un incident de sécurité.
--
-- Aucune donnée personnelle n'est perdue : la table ne contient que des
-- empreintes et des compteurs.
--
-- Sans `CASCADE`, comme les autres retours arrière du dépôt.
-- =============================================================================

DROP TABLE IF EXISTS public.auth_attempts;

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
  IF to_regclass('public.auth_attempts') IS NOT NULL THEN
    RAISE EXCEPTION
      'Retour arrière 0012 incomplet : la table public.auth_attempts existe encore. '
      'La ligne 0012 de public.schema_migrations est CONSERVÉE, elle dit vrai.'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM public.schema_migrations WHERE version = '0012';
  END IF;
END
$$;

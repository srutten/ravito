-- =============================================================================
-- Retour arrière de 0016 — Table `organization_members`
--
-- ATTENTION : ce retour arrière SUPPRIME TOUS LES RÔLES. Aucun rôle n'étant
-- écrit ailleurs dans le schéma, plus personne n'est coordinateur, ni
-- administrateur d'organisation, ni administrateur plateforme. Les sessions
-- ouvertes restent valides — elles ne dépendent pas de cette table (0013) —
-- mais toute garde qui interroge l'appartenance doit alors refuser, par refus
-- par défaut (docs/permissions.md).
--
-- C'est le sens sûr, et il faut le vérifier plutôt que l'espérer : une couche
-- d'autorisation qui, faute de table, laisserait passer au lieu de refuser
-- transformerait ce retour arrière en ouverture générale. Le cas mérite un test
-- d'accès dédié.
--
-- Ce qui est perdu est l'historique des mandats : qui appartenait à quelle
-- organisation, à quel titre et pendant quelle période. Si une analyse est en
-- cours, exporter d'abord :
--
--   \copy (SELECT organization_id, user_id, role, status, valid_from,
--                 valid_until, created_at, updated_at
--          FROM public.organization_members)
--         TO 'adhesions-avant-retour.csv' CSV HEADER
--
-- Sans `CASCADE`, comme les autres retours arrière du dépôt.
--
-- Ordre de déroulement : 0017, 0016, 0015, 0014. Dérouler 0015.down avant
-- celui-ci échoue sur « cannot drop table organizations because other objects
-- depend on it », et c'est le comportement recherché.
-- =============================================================================

DROP TABLE IF EXISTS public.organization_members;

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
  IF to_regclass('public.organization_members') IS NOT NULL THEN
    RAISE EXCEPTION
      'Retour arrière 0016 incomplet : la table public.organization_members existe encore. '
      'La ligne 0016 de public.schema_migrations est CONSERVÉE, elle dit vrai.'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM public.schema_migrations WHERE version = '0016';
  END IF;
END
$$;

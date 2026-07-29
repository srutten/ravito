-- =============================================================================
-- Retour arrière de 0010 — Table `user_profiles`
--
-- ATTENTION : ce retour arrière DÉTRUIT DES COMPTES. Il n'est légitime que sur
-- une base de développement ou juste après une migration qui vient d'échouer,
-- avant toute création de compte réelle. Sur une base portant des comptes, la
-- voie est un déploiement en plusieurs étapes (docs/database-design.md), pas
-- une suppression.
--
-- Volontairement sans `CASCADE` : `sessions` et `auth_challenges` référencent
-- cette table, PostgreSQL refusera donc tant que 0013, 0012 et 0011 n'auront
-- pas été déroulés. Le refus est le comportement recherché — un `CASCADE`
-- emporterait les sessions ouvertes et les défis en circulation sans le dire.
--
-- Aucun garde-fou sur le nombre de lignes, contrairement à
-- 0005_outbox.down.sql : un tel garde-fou refuserait le retour arrière dès le
-- premier compte de test créé en local, et serait donc contourné à la première
-- occasion. La protection réelle est ailleurs — le compte applicatif ne détient
-- pas le droit de supprimer cette table (0002), et un retour arrière de schéma
-- ne s'exécute jamais sans sauvegarde vérifiée (docs/operations.md).
-- =============================================================================

DROP TABLE IF EXISTS public.user_profiles;

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
  IF to_regclass('public.user_profiles') IS NOT NULL THEN
    RAISE EXCEPTION
      'Retour arrière 0010 incomplet : la table public.user_profiles existe encore. '
      'La ligne 0010 de public.schema_migrations est CONSERVÉE, elle dit vrai.'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM public.schema_migrations WHERE version = '0010';
  END IF;
END
$$;

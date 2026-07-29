-- =============================================================================
-- Retour arrière de 0015 — Table `organizations`
--
-- ATTENTION : ce retour arrière DÉTRUIT DES ORGANISATIONS, et avec elles la
-- trace des vérifications déjà prononcées par un administrateur plateforme. Il
-- n'est légitime que sur une base de développement, ou juste après une
-- migration qui vient d'échouer, avant toute déclaration réelle. Sur une base
-- portant des organisations, la voie est un déploiement en plusieurs étapes
-- (docs/database-design.md), pas une suppression.
--
-- Les lignes de `audit_logs` qui portent `target_type = 'ORGANIZATION'`
-- survivent, elles : le journal ne référence aucune table par clé étrangère,
-- précisément pour que la preuve survive à la disparition de son objet. Elles
-- désigneront alors des identifiants sans ligne correspondante, ce qui est le
-- comportement voulu.
--
-- Volontairement sans `CASCADE` : `organization_members` référence cette table,
-- PostgreSQL refusera donc tant que 0016 n'aura pas été déroulé. Le refus est
-- le comportement recherché — un `CASCADE` emporterait toutes les adhésions,
-- donc tous les rôles, sans le dire.
--
-- Ordre de déroulement : 0017, 0016, 0015, 0014.
-- =============================================================================

DROP TABLE IF EXISTS public.organizations;

-- Retrait de la ligne de suivi, CONDITIONNÉ à la disparition réelle de l'objet, vérifiée ici même.
-- Sans ce retrait, `db:status` annoncerait une base à jour dont les objets ont disparu. Sans cette
-- condition, la position en fin de fichier ne protégerait rien : `psql -f` envoie chaque énoncé
-- séparément, en autocommit, et sans `-v ON_ERROR_STOP=1` il POURSUIT après un refus. La ligne
-- d'un retour arrière que PostgreSQL vient de REFUSER — ici, `organization_members` encore en
-- place — partirait donc quand même, et le moteur annoncerait 0015 « en attente » alors que la
-- table et ses données sont intactes. La propriété tient du FICHIER, jamais de la façon de
-- l'invoquer (`supabase/README.md`, « Dérouler un retour arrière »). Le test d'existence de la
-- table de suivi couvre une base montée hors moteur : il n'y a alors rien à retirer.
DO $$
BEGIN
  IF to_regclass('public.organizations') IS NOT NULL THEN
    RAISE EXCEPTION
      'Retour arrière 0015 incomplet : la table public.organizations existe encore. '
      'La ligne 0015 de public.schema_migrations est CONSERVÉE, elle dit vrai.'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM public.schema_migrations WHERE version = '0015';
  END IF;
END
$$;

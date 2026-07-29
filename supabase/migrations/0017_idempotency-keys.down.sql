-- =============================================================================
-- Retour arrière de 0017 — Registre central d'idempotence
--
-- ATTENTION : ce retour arrière REND REJOUABLE toute commande déjà exécutée.
-- Les identifiants réservés disparaissent, et une requête rejouée — depuis la
-- file locale d'un téléphone qui retrouve le réseau (docs/offline-mode.md),
-- depuis un client qui réessaie, ou depuis une capture réseau — produira un
-- second effet. Sur une base portant du trafic réel, la voie est un déploiement
-- en plusieurs étapes (docs/database-design.md), pas une suppression.
--
-- Aucun garde-fou sur le nombre de lignes : il refuserait le retour arrière dès
-- la première commande de test en local, et serait donc contourné à la première
-- occasion. La protection réelle est ailleurs — le compte applicatif n'a pas le
-- droit de supprimer cette table (0002), et un retour arrière de schéma ne
-- s'exécute jamais sans sauvegarde vérifiée (docs/operations.md).
--
-- Ce fichier ne touche PAS à `idempotency_witness` (0007), qui est une autre
-- table, sans droit applicatif, supprimée par la migration du lot 5.
--
-- Sans `CASCADE`, comme les autres retours arrière du dépôt. Ordre de
-- déroulement : 0017, 0016, 0015, 0014.
-- =============================================================================

DROP TABLE IF EXISTS public.idempotency_keys;

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
  IF to_regclass('public.idempotency_keys') IS NOT NULL THEN
    RAISE EXCEPTION
      'Retour arrière 0017 incomplet : la table public.idempotency_keys existe encore. '
      'La ligne 0017 de public.schema_migrations est CONSERVÉE, elle dit vrai.'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM public.schema_migrations WHERE version = '0017';
  END IF;
END
$$;

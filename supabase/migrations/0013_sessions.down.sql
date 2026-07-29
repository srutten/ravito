-- =============================================================================
-- Retour arrière de 0013 — Table `sessions`
--
-- Effet immédiat : toutes les sessions ouvertes deviennent invalides, puisque
-- plus aucune empreinte de jeton n'est retrouvable. Les utilisateurs connectés
-- sont déconnectés et doivent demander un nouveau code. C'est acceptable — et
-- c'est même le sens sûr : un retour arrière du mécanisme de session ne doit
-- pas laisser d'accès ouverts derrière lui.
--
-- Ce qui est perdu, en revanche, est la trace des sessions ayant existé.
-- Si un incident de sécurité est en cours d'analyse, exporter la table avant :
--
--   \copy (SELECT id, user_profile_id, issued_at, last_seen_at, expires_at,
--                 revoked_at, user_agent_summary, ip_hash
--          FROM public.sessions) TO 'sessions-avant-retour.csv' CSV HEADER
--
-- La requête ne sélectionne pas `token_hash` : une empreinte de jeton n'a
-- aucune valeur d'analyse et son export multiplierait les copies d'un secret
-- dérivé.
--
-- Sans `CASCADE`, comme les autres retours arrière du dépôt.
-- =============================================================================

DROP TABLE IF EXISTS public.sessions;

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
  IF to_regclass('public.sessions') IS NOT NULL THEN
    RAISE EXCEPTION
      'Retour arrière 0013 incomplet : la table public.sessions existe encore. '
      'La ligne 0013 de public.schema_migrations est CONSERVÉE, elle dit vrai.'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM public.schema_migrations WHERE version = '0013';
  END IF;
END
$$;

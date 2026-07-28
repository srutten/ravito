-- =============================================================================
-- 0003 — Fonction et convention de déclencheur `updated_at`
-- Lot 0 · socle transverse
--
-- Objet   : garantir que `updated_at` reflète l'horloge du serveur et non celle
--           du client. Une mise à jour applicative de la colonne serait
--           falsifiable et divergerait d'un poste à l'autre ; le déclencheur
--           rend la valeur non contournable, y compris pour une écriture faite
--           en console.
-- Source  : docs/database-design.md (colonnes `created_at` et `updated_at`).
-- Retour  : supabase/migrations/0003_updated-at-trigger.down.sql
--
-- Convention imposée aux lots suivants : toute table mutable déclare
--   created_at timestamptz NOT NULL DEFAULT now(),
--   updated_at timestamptz NOT NULL DEFAULT now()
-- puis attache le déclencheur partagé sous le nom `<table>_set_updated_at`.
-- Une table strictement append-only (journal d'audit, événements de mission)
-- ne porte pas `updated_at` : la colonne laisserait croire qu'une mise à jour
-- est prévue.
-- =============================================================================

-- `now()` renvoie l'instant de début de transaction, en `timestamptz`, donc
-- comparable entre fuseaux. Deux lignes modifiées dans la même transaction
-- portent volontairement le même `updated_at` : c'est la propriété attendue
-- d'une mutation atomique.
--
-- `search_path` est figé : sans cela, un appelant pourrait détourner la
-- résolution de `now()` en plaçant un schéma de son choix devant `pg_catalog`.
CREATE OR REPLACE FUNCTION public.set_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.set_updated_at() IS
  'Déclencheur partagé : force updated_at à l''horloge du serveur. '
  'À attacher en BEFORE UPDATE FOR EACH ROW sous le nom <table>_set_updated_at.';

-- Le rôle applicatif n'appelle jamais cette fonction directement : un
-- déclencheur s'exécute sans vérifier le droit EXECUTE de l'appelant, le droit
-- n'étant contrôlé qu'à la création du déclencheur. Le retirer à `PUBLIC` évite
-- qu'un compte compromis ne s'en serve comme brique dans une expression.
REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC;

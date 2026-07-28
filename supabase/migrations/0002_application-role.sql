-- =============================================================================
-- 0002 — Rôle applicatif, sans droit de schéma ni mot de passe
-- Lot 0 · socle transverse
--
-- Objet   : séparer le compte qui applique les migrations du compte qui sert le
--           trafic applicatif. Le compte applicatif ne peut ni créer, ni
--           modifier, ni supprimer un objet de schéma : une injection SQL
--           réussie ne peut donc pas installer de porte dérobée durable.
-- Source  : docs/security.md (réduire l'impact d'un compte compromis),
--           docs/permissions.md (refus par défaut), docs/threat-model.md.
--
-- AUCUN MOT DE PASSE ICI. Le rôle est créé `NOLOGIN`. L'attribution d'un
-- secret de connexion est une étape d'exploitation, distincte du schéma :
--   - en local  : un script dédié, qui lit une variable d'environnement et
--                 n'écrit rien dans le dépôt ;
--   - à distance : gestionnaire de secrets, rotation documentée dans
--                 docs/security.md.
-- La procédure exacte est décrite dans supabase/README.md, qui reste
-- modifiable, contrairement à ce fichier.
-- Un mot de passe dans une migration serait un secret commité, interdit par
-- CLAUDE.md, et resterait lisible dans `pg_stat_statements` et les journaux
-- du serveur.
--
-- Stratégie de retour : aucun fichier `.down.sql`.
--   Un rôle est un objet global à l'instance, partagé par toutes les bases.
--   Le supprimer pendant un retour arrière couperait l'application encore
--   déployée, et échouerait de toute façon tant qu'il détient des droits sur
--   un objet existant. Le retour arrière compatible consiste à révoquer les
--   droits du rôle (`REVOKE ... FROM fire_support_app`), ce qui rend le compte
--   inoffensif sans casser les autres bases de l'instance.
-- =============================================================================

-- --- Rôle applicatif ---------------------------------------------------------
-- Créé sans connexion, sans superutilisateur, sans création de base ni de rôle,
-- sans réplication et sans contournement de RLS : le strict nécessaire pour
-- lire et écrire les données que les migrations lui ouvrent explicitement.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fire_support_app') THEN
    CREATE ROLE fire_support_app
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS
      INHERIT;
  END IF;
END
$$;

COMMENT ON ROLE fire_support_app IS
  'Compte applicatif Appui Feux. Aucun droit de schéma, aucun superutilisateur. '
  'Les droits sur les tables sont accordés table par table par les migrations. '
  'Le mot de passe est attribué hors dépôt, par une étape d''exploitation.';

-- --- Durcissement du schéma public ------------------------------------------
-- Redondant sur PostgreSQL 15 et suivants, où `PUBLIC` ne reçoit plus `CREATE`
-- sur `public` par défaut. Rendu explicite pour que le durcissement soit une
-- décision inscrite dans le schéma, et non un effet de bord de la version du
-- serveur.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Le rôle applicatif traverse le schéma mais ne peut rien y créer.
GRANT USAGE ON SCHEMA public TO fire_support_app;
REVOKE CREATE ON SCHEMA public FROM fire_support_app;

-- --- Refus par défaut sur les objets à venir ---------------------------------
-- Volontairement, AUCUN `ALTER DEFAULT PRIVILEGES` n'accorde de droit large au
-- rôle applicatif. Une table créée par un lot futur est donc invisible pour
-- l'application tant que sa migration n'a pas écrit son `GRANT` explicite.
-- C'est la transposition aux comptes techniques du refus par défaut de
-- docs/permissions.md : oublier un droit provoque une erreur immédiate et
-- visible, alors qu'un droit accordé en trop passe inaperçu.
--
-- Ce qui suit fige au contraire le refus, pour qu'un `GRANT ... TO PUBLIC`
-- accidentel dans un futur script ne contourne pas la règle sans être vu.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC;

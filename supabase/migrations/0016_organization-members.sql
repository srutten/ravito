-- =============================================================================
-- 0016 — Table `organization_members`
-- Lot 1 · identité et organisations
--
-- Objet   : porter l'entité `OrganizationMember` de docs/domain-model.md, seul
--           endroit du schéma où un rôle est écrit. docs/permissions.md exige
--           que l'appartenance soit vérifiée « pour chaque action », donc
--           action par action ET organisation par organisation : c'est cette
--           table qui rend la vérification possible.
-- Source  : docs/domain-model.md (champs), docs/permissions.md (les cinq rôles,
--           refus par défaut, cas de test « accès à une autre organisation » et
--           « accès après suspension »), backlog/epics-and-stories.md (US-014),
--           docs/database-design.md (conventions, index).
-- Retour  : supabase/migrations/0016_organization-members.down.sql
--
-- ---------------------------------------------------------------------------
-- CE QUE CETTE TABLE FERME : LE POINT OUVERT LAISSÉ PAR LE LOT 1 (US-010)
-- ---------------------------------------------------------------------------
-- supabase/README.md, section « Ce qui rend une session valide », énumère
-- quatre conditions et signale qu'une CINQUIÈME manquait : « docs/permissions.md
-- exige qu'une adhésion suspendue coupe l'accès. Cette cinquième condition
-- n'est pas réalisable au lot 1 : organization_members n'existe pas encore. »
-- Elle existe à partir d'ici. La condition à ajouter, mot pour mot, est :
--
--     organization_members.status = 'ACTIVE'
--     AND organization_members.valid_from <= now()
--     AND (organization_members.valid_until IS NULL
--          OR organization_members.valid_until > now())
--
-- Trois propriétés de cette formulation, qui ne sont pas des détails :
--   - `valid_from <= now()` : une adhésion datée du futur n'ouvre rien. Sans
--     cette borne, préparer une adhésion à l'avance l'activerait aussitôt ;
--   - `valid_until > now()`, comparaison STRICTE : à la seconde exacte de
--     l'échéance, l'adhésion est déjà close. C'est le même choix que
--     `sessions_revoked_at` en 0010 — dans le doute, on coupe ;
--   - `status = 'ACTIVE'`, énuméré et non « différent de SUSPENDED ». Une
--     valeur ajoutée plus tard au type serait alors refusée par défaut.
--
-- Le rôle effectif doit être RELU À CHAQUE REQUÊTE. docs/architecture.md
-- interdit de cacher les autorisations critiques, et la raison est directe : un
-- rôle mis en cache survivrait à sa propre suspension pendant la durée du
-- cache, c'est-à-dire pendant la fenêtre exacte que la suspension existe pour
-- fermer. Le coût réel est une lecture sur la clé primaire de cette table.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.organization_members (
  -- Clé primaire COMPOSITE, sans colonne `id` de substitution. Conséquence
  -- voulue : une personne détient AU PLUS UN rôle par organisation. Un rôle
  -- unique par organisation rend la question « que peut faire cette personne
  -- ici ? » décidable par une seule lecture ; deux adhésions concurrentes
  -- auraient obligé chaque garde à choisir entre elles, et le choix le plus
  -- naturel — retenir la plus permissive — aurait transformé une adhésion
  -- oubliée en élévation de privilèges silencieuse.
  --
  -- La même personne peut en revanche appartenir à PLUSIEURS organisations,
  -- avec des rôles différents et des statuts différents : c'est le cas que le
  -- jeu de démonstration installe volontairement (bloc 003).
  organization_id uuid NOT NULL
    REFERENCES public.organizations (id),

  user_id uuid NOT NULL
    REFERENCES public.user_profiles (id),

  -- Aucune action `ON DELETE` n'est déclarée : le comportement par défaut,
  -- `NO ACTION`, refuse la suppression d'une organisation ou d'un compte tant
  -- qu'une adhésion les référence. C'est cohérent avec les droits accordés —
  -- le compte applicatif ne peut supprimer ni l'un ni l'autre — et c'est le
  -- sens sûr : un `ON DELETE CASCADE` ferait disparaître des rôles en silence
  -- au moment précis où l'on manipule un compte.

  role public.organization_member_role NOT NULL,

  -- `ACTIVE` par défaut. La création d'une adhésion par invitation (US-014)
  -- doit poser explicitement `INVITED` : le défaut sert le cas rattaché à la
  -- création de l'organisation, où l'administrateur initial n'a personne à qui
  -- envoyer une invitation puisqu'il est déjà là.
  status public.organization_member_status NOT NULL DEFAULT 'ACTIVE',

  -- --- Fenêtre de validité -------------------------------------------------------
  -- docs/domain-model.md donne `validFrom` et `validUntil` à
  -- `OrganizationMember`. Un mandat de coordination est souvent temporaire —
  -- une saison, un exercice, un renfort — et l'expiration est explicitement un
  -- critère d'US-014. La fenêtre est portée par des données, pas par une tâche
  -- de fond : une adhésion expire d'elle-même à l'instant dit, même si aucun
  -- traitement ne tourne. Un travail périodique qui basculerait le statut
  -- laisserait l'accès ouvert entre l'échéance et son prochain passage.
  valid_from timestamptz NOT NULL DEFAULT now(),

  -- NULL signifie « sans terme ». C'est le cas courant.
  valid_until timestamptz,

  CONSTRAINT organization_members_validity_window
    CHECK (valid_until IS NULL OR valid_until > valid_from),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT organization_members_pkey PRIMARY KEY (organization_id, user_id)
);

COMMENT ON TABLE public.organization_members IS
  'Adhésions : le seul endroit du schéma où un rôle est écrit. Une personne a '
  'au plus un rôle par organisation. Le rôle effectif se relit à chaque '
  'requête, jamais depuis un cache (docs/architecture.md).';
COMMENT ON COLUMN public.organization_members.role IS
  'Un des cinq rôles de docs/permissions.md. L''ordre du type énuméré n''est '
  'pas une hiérarchie : énumérer les rôles autorisés, ne pas comparer avec >=.';
COMMENT ON COLUMN public.organization_members.status IS
  'Seule ACTIVE ouvre un accès, et seulement dans la fenêtre de validité. '
  'INVITED n''est pas une appartenance.';
COMMENT ON COLUMN public.organization_members.valid_from IS
  'Début du mandat. Une adhésion datée du futur n''ouvre aucun accès.';
COMMENT ON COLUMN public.organization_members.valid_until IS
  'Fin du mandat, NULL si sans terme. Comparaison stricte : à l''échéance, '
  'l''adhésion est déjà close.';

-- Le déclencheur partagé de 0003 impose `updated_at` côté serveur.
CREATE OR REPLACE TRIGGER organization_members_set_updated_at
  BEFORE UPDATE ON public.organization_members
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- --- Index -------------------------------------------------------------------
-- docs/database-design.md demande un index sur `organization_id`. Il EXISTE
-- DÉJÀ : l'index unique qui porte la clé primaire composite a
-- `organization_id` en colonne de tête, il sert donc aussi bien la recherche
-- « rôle de cette personne dans cette organisation » que le listage des membres
-- d'une organisation. En créer un second sur la seule colonne `organization_id`
-- serait un doublon : coût d'écriture à chaque mutation, aucun gain de lecture.
-- L'absence est donc délibérée et non un oubli.
--
-- L'ordre inverse, lui, n'est PAS couvert : un index B-tree ne se parcourt pas
-- par sa seconde colonne. Or c'est la lecture la plus fréquente du produit —
-- « à quelles organisations cette personne appartient-elle ? » — exécutée à
-- chaque requête authentifiée, puisque le rôle effectif ne se cache pas.
-- `status` en seconde position permet d'écarter dans l'index les adhésions
-- invitées, suspendues ou révoquées.
CREATE INDEX IF NOT EXISTS idx_organization_members_user_status
  ON public.organization_members (user_id, status);

COMMENT ON INDEX public.idx_organization_members_user_status IS
  'Résolution du rôle à chaque requête : adhésions d''une personne, filtrées '
  'par statut. L''index de la clé primaire couvre déjà le sens organisation.';

-- --- Droits ------------------------------------------------------------------
-- Pas de `DELETE`, comme pour `user_profiles` et `organizations`. Retirer
-- quelqu'un d'une organisation est un changement de statut (`REVOKED`) ou la
-- pose d'un terme (`valid_until`), pas un effacement. La raison est d'abord une
-- raison de preuve : les lignes d'audit déjà écrites portent
-- `actor_organization_id`, et supprimer l'adhésion effacerait le seul moyen de
-- reconstituer à quel titre la personne agissait. C'est aussi une raison de
-- sécurité — un compte applicatif compromis pourrait sinon effacer la trace de
-- l'appartenance dont il s'est servi.
GRANT SELECT, INSERT, UPDATE ON public.organization_members TO fire_support_app;
REVOKE DELETE, TRUNCATE ON public.organization_members FROM fire_support_app;

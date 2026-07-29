-- =============================================================================
-- 0014 — Types énumérés du domaine organisations
-- Lot 1 · identité et organisations
--
-- Objet   : donner un type fermé aux cinq colonnes qualitatives de
--           `Organization` et de `OrganizationMember`. La règle posée par 0004
--           s'applique sans exception : « Aucune colonne de statut ne doit être
--           déclarée en `text` avec une contrainte `CHECK` », sous peine de
--           faire diverger deux listes de valeurs.
-- Source  : docs/domain-model.md (Organization.type, .verificationStatus,
--           .status ; OrganizationMember.role, .status), docs/permissions.md
--           (les cinq rôles, « Valider une organisation », « Suspendre un
--           compte »), docs/seed-data.md (les quatre organisations de
--           démonstration et leurs natures), docs/api-contract.md
--           (`ORGANIZATION_NOT_VERIFIED`, file `/admin/organizations/pending`),
--           docs/screens.md écran 10 (« organisations en attente »),
--           backlog/epics-and-stories.md (US-012, US-013, US-014).
-- Retour  : supabase/migrations/0014_organization-enums.down.sql
--
-- ---------------------------------------------------------------------------
-- POURQUOI CINQ TYPES ET PAS TROIS
-- ---------------------------------------------------------------------------
-- docs/domain-model.md donne à `Organization` DEUX colonnes distinctes,
-- `verificationStatus` et `status`. Elles ne décrivent pas la même chose et ne
-- doivent jamais être fusionnées :
--   - `verification_status` répond à « cette structure est-elle celle qu'elle
--     prétend être ? ». C'est la décision d'un administrateur plateforme
--     (US-013), et c'est elle que docs/permissions.md interroge lorsqu'il
--     conditionne les permissions sensibles à la validation ;
--   - `status` répond à « ce compte d'organisation est-il utilisable ? ». C'est
--     un cycle de vie administratif, celui que « Suspendre un compte » modifie.
-- Une organisation peut être VERIFIED et SUSPENDED — structure authentique dont
-- l'accès est coupé après incident — ou PENDING et ACTIVE — structure qui vient
-- de se déclarer et dont l'administrateur peut travailler, sans accéder aux
-- fonctions réservées aux organisations validées. Une colonne unique rendrait
-- ces deux cas inexprimables.
--
-- ---------------------------------------------------------------------------
-- RETENUE SUR LE NOMBRE DE VALEURS
-- ---------------------------------------------------------------------------
-- Reprise de 0009 : `ALTER TYPE ... ADD VALUE` est possible, non bloquant et
-- applicable à chaud, alors que PostgreSQL ne sait PAS retirer une valeur d'un
-- type énuméré. Une valeur inventée par anticipation est définitive ; une
-- valeur manquante se rattrape en une ligne. Chaque valeur ci-dessous est
-- justifiée par un usage écrit dans un document du dépôt, et aucune ne l'est
-- par une simple symétrie.
-- =============================================================================

-- `CREATE TYPE` n'accepte pas `IF NOT EXISTS`. Le test d'existence explicite
-- est repris de 0004 et 0009 : il est préféré à `EXCEPTION WHEN
-- duplicate_object`, qui masquerait aussi une erreur réelle survenue pendant la
-- création.

-- --- Nature d'une organisation ------------------------------------------------
-- Référentiel FERMÉ, repris dans l'ordre du cadrage : service opérationnel,
-- collectivité, entreprise, association, exploitation agricole. Les quatre
-- organisations de docs/seed-data.md s'y rangent sans reste.
--
-- Deux valeurs méritent d'être expliquées, parce qu'elles sont volontairement
-- PLUS LARGES que l'exemple qui les a inspirées :
--   - `OPERATIONAL_SERVICE` plutôt que « service d'incendie ». Le produit
--     coordonne des moyens civils en soutien (CLAUDE.md) ; le service qui
--     coordonne peut être un service d'incendie, un service technique ou une
--     unité de sécurité civile. Nommer le type d'après un seul de ces cas
--     obligerait à ajouter une valeur au premier suivant, et
--     `ALTER TYPE ... ADD VALUE` est irréversible ;
--   - `LOCAL_AUTHORITY` plutôt que « commune ». Une collectivité peut être une
--     commune, un groupement, un département ou une région. « Commune de
--     démonstration » de docs/seed-data.md en est un cas particulier, pas la
--     définition.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'organization_type'
  ) THEN
    CREATE TYPE public.organization_type AS ENUM (
      -- Service opérationnel : service d'incendie et de secours, service
      -- technique territorial, unité de sécurité civile. C'est la nature de
      -- l'organisation qui publie des demandes.
      'OPERATIONAL_SERVICE',
      -- Collectivité territoriale ou groupement de collectivités.
      'LOCAL_AUTHORITY',
      -- Entreprise, quelle que soit sa forme juridique.
      'COMPANY',
      -- Association déclarée.
      'ASSOCIATION',
      -- Exploitation agricole.
      'FARM'
    );
  END IF;
END
$$;

-- --- Vérification d'une organisation ------------------------------------------
-- L'ordre suit le parcours de la file d'administration : en attente, puis issue
-- de la décision. Il n'est PAS un ordre de force et ne doit pas être comparé
-- avec `>=`, contrairement à `user_verification_level` de 0009 : `REJECTED`
-- n'est pas « plus vérifié » que `VERIFIED`. La seule garde correcte est
-- l'égalité à `VERIFIED`.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'organization_verification_status'
  ) THEN
    CREATE TYPE public.organization_verification_status AS ENUM (
      -- Déclarée, non encore contrôlée. Valeur PAR DÉFAUT à la création
      -- (US-012, critère « statut en attente ») : aucune organisation ne naît
      -- vérifiée, y compris si son créateur l'affirme. C'est la population de
      -- `GET /api/v1/admin/organizations/pending` et de l'écran 10.
      'PENDING',
      -- Contrôlée par un administrateur plateforme (US-013). Seule valeur qui
      -- ouvre les actions conditionnées par docs/permissions.md ; toute autre
      -- doit produire `ORGANIZATION_NOT_VERIFIED`.
      'VERIFIED',
      -- Contrôle défavorable. La valeur existe parce que US-013 exige un
      -- « commentaire » sur la décision, ce qui n'a de sens que si la décision
      -- peut être négative, et parce que sans elle une organisation refusée
      -- resterait indéfiniment `PENDING` : la file d'administration ne se
      -- viderait jamais et le même dossier serait réexaminé sans fin.
      'REJECTED'
    );
  END IF;
END
$$;

-- --- Cycle de vie d'une organisation ------------------------------------------
-- Volontairement identique, mot pour mot, à `user_profile_status` de 0009.
-- Les deux répondent à la même question — ce compte est-il utilisable ? — et
-- leur donner des vocabulaires différents obligerait chaque garde
-- d'autorisation à traduire d'une échelle à l'autre, ce qui est exactement
-- l'endroit où une erreur ne se voit pas.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'organization_status'
  ) THEN
    CREATE TYPE public.organization_status AS ENUM (
      -- Organisation utilisable. C'est la valeur par défaut, y compris tant que
      -- la vérification est en attente : les deux axes sont indépendants.
      'ACTIVE',
      -- Suspendue par un administrateur (docs/permissions.md, « Suspendre un
      -- compte » ; docs/security.md, réponse à incident). Aucune adhésion à une
      -- organisation suspendue ne doit ouvrir d'accès.
      'SUSPENDED',
      -- Close. Suppression logique, conforme à docs/database-design.md : une
      -- suppression physique emporterait les adhésions et ferait perdre le lien
      -- des lignes d'audit déjà écrites.
      'CLOSED'
    );
  END IF;
END
$$;

-- --- Rôle porté par une adhésion ----------------------------------------------
-- Les cinq valeurs de docs/permissions.md, reprises telles quelles et DANS
-- L'ORDRE DU DOCUMENT, comme 0004 le fait pour les machines à états.
--
-- AVERTISSEMENT, à lire avant d'écrire une garde d'autorisation : cet ordre
-- n'est PAS une hiérarchie de privilèges. `OBSERVER` est déclaré en dernier et
-- il est le rôle le MOINS capable — docs/permissions.md ne lui accorde qu'une
-- lecture limitée. Une comparaison du type `role >= 'ORG_ADMIN'` accorderait
-- donc à un observateur les droits d'un administrateur d'organisation. Les
-- gardes doivent énumérer les rôles autorisés, action par action, à partir de
-- la matrice de docs/permissions.md, jamais comparer l'ordre du type.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'organization_member_role'
  ) THEN
    CREATE TYPE public.organization_member_role AS ENUM (
      'CONTRIBUTOR',
      'COORDINATOR',
      'ORG_ADMIN',
      'PLATFORM_ADMIN',
      'OBSERVER'
    );
  END IF;
END
$$;

-- --- Statut d'une adhésion ----------------------------------------------------
-- L'ordre suit la vie d'une adhésion : invitée, active, suspendue, révoquée.
-- Une seule de ces valeurs ouvre un accès, et c'est `ACTIVE`. La résolution du
-- rôle doit énumérer ce qu'elle accepte, jamais ce qu'elle refuse : une valeur
-- ajoutée par un lot ultérieur serait alors refusée par défaut, ce qui est le
-- sens sûr.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'organization_member_status'
  ) THEN
    CREATE TYPE public.organization_member_status AS ENUM (
      -- Invitation émise, non encore acceptée (US-014, critère « invitation »).
      -- N'ouvre AUCUN accès : une invitation en attente n'est pas une
      -- appartenance.
      'INVITED',
      -- Adhésion en vigueur. Seule valeur qui, combinée à la fenêtre de
      -- validité, donne un rôle effectif.
      'ACTIVE',
      -- Adhésion suspendue (US-014, critère « suspension » ;
      -- docs/permissions.md, « Suspendre un compte », limité à l'organisation
      -- pour un administrateur d'organisation). La suspension doit couper
      -- l'accès immédiatement, sans attendre l'expiration de la session.
      'SUSPENDED',
      -- Adhésion retirée définitivement : la personne a quitté l'organisation.
      -- La valeur existe parce que le compte applicatif n'a PAS le droit
      -- `DELETE` sur `organization_members` (voir 0016) et parce qu'une sortie
      -- décidée ne doit pas se confondre avec un mandat arrivé à son terme, que
      -- `valid_until` exprime déjà.
      'REVOKED'
    );
  END IF;
END
$$;

COMMENT ON TYPE public.organization_type IS
  'Nature d''une organisation. Référentiel fermé : service opérationnel, '
  'collectivité, entreprise, association, exploitation agricole.';

COMMENT ON TYPE public.organization_verification_status IS
  'Contrôle de l''identité d''une organisation (US-013). Seule VERIFIED ouvre '
  'les actions sensibles ; toute autre valeur donne ORGANIZATION_NOT_VERIFIED. '
  'Ordre non significatif : ne pas comparer avec >=.';

COMMENT ON TYPE public.organization_status IS
  'Cycle de vie administratif d''une organisation, indépendant de la '
  'vérification. Mêmes valeurs que user_profile_status, volontairement.';

COMMENT ON TYPE public.organization_member_role IS
  'Les cinq rôles de docs/permissions.md, dans l''ordre du document. '
  'L''ordre n''est PAS une hiérarchie : OBSERVER est le moins capable. '
  'Énumérer les rôles autorisés, ne jamais comparer avec >=.';

COMMENT ON TYPE public.organization_member_status IS
  'Statut d''une adhésion. Seule ACTIVE ouvre un accès, et seulement dans la '
  'fenêtre valid_from / valid_until. Référence : US-014, docs/permissions.md.';

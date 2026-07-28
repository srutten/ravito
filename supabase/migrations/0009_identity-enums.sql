-- =============================================================================
-- 0009 — Types énumérés du domaine identité
-- Lot 1 · identité
--
-- Objet   : donner un type fermé aux deux colonnes qualitatives de
--           `UserProfile`, `verificationLevel` et `status`. 0004 impose la
--           règle : « Aucune colonne de statut ne doit être déclarée en `text`
--           avec une contrainte `CHECK` ». Les états d'identité n'existaient
--           pas au lot 0, ils sont donc créés ici, dans le lot qui les
--           introduit.
-- Source  : docs/domain-model.md (UserProfile.verificationLevel, .status),
--           docs/permissions.md (« Permissions sensibles conditionnées par la
--           validation du compte », « Suspendre un compte », cas de test
--           « accès après suspension »), docs/screens.md écran 10
--           (« comptes suspendus »), docs/privacy-rgpd.md (comptes supprimés).
-- Retour  : supabase/migrations/0009_identity-enums.down.sql
--
-- ---------------------------------------------------------------------------
-- POURQUOI SI PEU DE VALEURS
-- ---------------------------------------------------------------------------
-- Aucun document du dépôt n'énumère les états d'un compte, contrairement aux
-- quatre machines à états de docs/state-machines.md que 0004 a pu recopier
-- telles quelles. Les valeurs ci-dessous sont donc déduites d'usages
-- explicitement documentés, et rien de plus.
--
-- Cette retenue n'est pas de la timidité, elle suit l'asymétrie rappelée par
-- 0004 : `ALTER TYPE ... ADD VALUE` est possible, non bloquant et applicable à
-- chaud, alors que PostgreSQL ne sait PAS retirer une valeur d'un type
-- énuméré. Une valeur inventée par anticipation est définitive ; une valeur
-- manquante se rattrape en une ligne. Toute valeur ajoutée par un lot ultérieur
-- doit d'abord être décidée dans docs/domain-model.md ou
-- docs/state-machines.md, jamais ici.
--
-- Ces deux types ne décrivent pas une machine à états au sens de
-- docs/state-machines.md : aucune table de transitions ne leur est associée à
-- ce stade. Les règles de suspension et de réactivation relèvent d'US-014
-- (gestion des membres) ; c'est ce lot qui devra les inscrire dans
-- docs/state-machines.md s'il introduit des transitions contraintes.
-- =============================================================================

-- `CREATE TYPE` n'accepte pas `IF NOT EXISTS`. Le test d'existence explicite
-- est repris de 0004 : il est préféré à `EXCEPTION WHEN duplicate_object`, qui
-- masquerait aussi une erreur réelle survenue pendant la création.

-- --- Niveau de vérification d'un compte -------------------------------------
-- L'ordre de déclaration fixe l'ordre de tri du type, et donc la sémantique des
-- comparaisons. Il est volontairement CROISSANT, du moins vérifié au plus
-- vérifié, pour qu'une garde d'autorisation s'écrive
-- `verification_level >= 'CONTACT_VERIFIED'` plutôt que par une énumération de
-- valeurs autorisées. Une liste `IN (...)` doit être relue et complétée à
-- chaque nouveau niveau, et l'oubli d'un niveau y est silencieusement
-- permissif ; la comparaison ordonnée, elle, reste correcte par construction.
--
-- Le nom est préfixé `user_` : docs/domain-model.md donne aussi un
-- `verificationStatus` à `Organization` et à `ResourceDocument`. Ce sont trois
-- échelles distinctes, elles ne doivent pas partager un type au nom générique.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'user_verification_level'
  ) THEN
    CREATE TYPE public.user_verification_level AS ENUM (
      -- Compte dont aucun identifiant n'a encore été prouvé. C'est le niveau
      -- d'un profil qui vient d'être créé, avant toute connexion réussie.
      'NONE',
      -- Contrôle d'un identifiant démontré par un code à usage unique reçu et
      -- présenté. C'est exactement ce que la connexion d'US-010 établit : la
      -- preuve porte sur le canal, pas sur l'état civil.
      'CONTACT_VERIFIED',
      -- Identité vérifiée par un humain habilité. Requis par
      -- docs/permissions.md pour les permissions sensibles. Le niveau est un
      -- fait, il n'implique aucune conservation de pièce d'identité :
      -- docs/privacy-rgpd.md classe les pièces non nécessaires parmi les
      -- données à éviter.
      'IDENTITY_VERIFIED'
    );
  END IF;
END
$$;

-- --- Statut d'un compte -------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'user_profile_status'
  ) THEN
    CREATE TYPE public.user_profile_status AS ENUM (
      -- Compte utilisable.
      'ACTIVE',
      -- Compte suspendu par un administrateur. docs/security.md en fait la
      -- première mesure de réponse à incident, avant même la révocation des
      -- sessions. Un compte suspendu ne doit ni obtenir de code, ni ouvrir de
      -- session, ni conserver une session ouverte.
      'SUSPENDED',
      -- Compte clos. Suppression logique, conforme à docs/database-design.md
      -- (« suppression logique uniquement si nécessaire ») : elle l'est ici,
      -- parce qu'une suppression physique emporterait le lien des lignes
      -- d'audit et détruirait la preuve que le journal existe pour conserver.
      -- La suppression des données personnelles associées relève de la
      -- procédure d'effacement de docs/privacy-rgpd.md, pas d'un changement de
      -- statut.
      'CLOSED'
    );
  END IF;
END
$$;

COMMENT ON TYPE public.user_verification_level IS
  'Niveau de vérification d''un compte, ordonné du plus faible au plus fort. '
  'Comparer avec >= plutôt que par une liste IN. Référence : docs/permissions.md.';

COMMENT ON TYPE public.user_profile_status IS
  'Statut d''un compte. Seul ACTIVE autorise la connexion et l''usage d''une '
  'session. Référence : docs/security.md (suspension), docs/privacy-rgpd.md.';

-- =============================================================================
-- 0010 — Table `user_profiles`
-- Lot 1 · identité
--
-- Objet   : porter l'entité `UserProfile` de docs/domain-model.md, c'est-à-dire
--           le compte auquel une session se rattache et dont le rôle sera
--           résolu côté serveur.
-- Source  : docs/domain-model.md (champs), docs/security.md (révocation
--           globale, suspension), docs/permissions.md (validation du compte),
--           docs/privacy-rgpd.md (minimisation), docs/database-design.md
--           (conventions, index sur les statuts).
-- Retour  : supabase/migrations/0010_user-profiles.down.sql
--
-- ---------------------------------------------------------------------------
-- MINIMISATION — CE QUE LA TABLE NE PORTE PAS
-- ---------------------------------------------------------------------------
-- docs/privacy-rgpd.md classe parmi les données à éviter : données de santé,
-- informations familiales, opinions, pièces d'identité non nécessaires, suivi
-- permanent. Aucune colonne ne leur correspond ici, et aucune ne doit être
-- ajoutée par un lot ultérieur sans passage par le registre des traitements.
-- Il n'y a pas non plus de date de naissance, d'adresse postale ni de champ
-- libre de commentaire : chacun serait un réceptacle naturel pour ce genre de
-- donnée saisie par erreur, que docs/permissions.md range explicitement dans
-- les données sensibles.
--
-- AUCUN MOT DE PASSE, ni empreinte de mot de passe. La connexion repose sur un
-- code à usage unique (docs/screens.md écran 2). Il n'existe donc pas de base
-- de mots de passe à faire fuiter, et le bourrage d'identifiants que
-- docs/security.md demande de contrer devient sans objet faute de cible.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.user_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identifiant opaque chez un fournisseur d'identité externe, prévu par
  -- docs/screens.md écran 2 (« code à usage unique OU fournisseur
  -- d'identité »). NULL tant que le compte n'est rattaché à aucun fournisseur,
  -- ce qui est le cas de tous les comptes créés par ce lot. La colonne est
  -- déclarée maintenant parce que l'ajouter plus tard obligerait à la remplir
  -- rétroactivement ; elle reste inerte jusqu'au lot qui branche un
  -- fournisseur.
  auth_user_id text
    CONSTRAINT user_profiles_auth_user_id_shape
    CHECK (
      auth_user_id IS NULL
      OR (auth_user_id = btrim(auth_user_id) AND char_length(auth_user_id) BETWEEN 1 AND 255)
    ),

  -- Nom d'affichage présenté aux coordinateurs et aux contributeurs engagés sur
  -- une même mission. NOT NULL et SANS valeur par défaut : la création d'un
  -- compte doit décider d'un nom, elle ne doit pas le déduire de l'identifiant.
  -- Dériver « alice » de « alice@example.org » recopierait une partie de
  -- l'adresse dans un champ affiché à des tiers, ce qui la divulguerait à des
  -- personnes qui n'y ont pas accès.
  display_name text NOT NULL
    CONSTRAINT user_profiles_display_name_length
    CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 120),

  -- --- Identifiants de connexion ---------------------------------------------
  -- Stockés NORMALISÉS, et l'unicité porte sur cette forme normalisée. La
  -- normalisation n'est pas un confort d'affichage : sans elle,
  -- « Alice@Example.org » et « alice@example.org » ouvriraient deux comptes
  -- pour une seule boîte, et « 06 12 34 56 78 » et « +33612345678 » deux
  -- comptes pour un seul téléphone. Deux comptes pour un destinataire, c'est un
  -- compte fantôme qui reçoit de vrais codes à usage unique.
  --
  -- Le type `citext` (0008) rend la comparaison insensible à la casse, y
  -- compris pour une requête qui aurait oublié de normaliser. La contrainte de
  -- forme ci-dessous garantit en plus que la valeur STOCKÉE est bien la forme
  -- normalisée : `citext` seul accepterait d'écrire « Alice@Example.org » et de
  -- le restituer tel quel, ce qui ferait dépendre de la casse saisie tout ce
  -- qui compare des chaînes hors du serveur — un hachage d'identifiant, par
  -- exemple (voir 0011).
  email citext
    CONSTRAINT user_profiles_email_normalized
    CHECK (email IS NULL OR email::text = btrim(lower(email::text)))
    CONSTRAINT user_profiles_email_shape
    CHECK (
      email IS NULL
      OR (email::text ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
          AND char_length(email::text) <= 254)
    ),

  -- Format E.164 strict : « + », indicatif pays, puis chiffres, 15 chiffres au
  -- maximum. C'est la seule forme qui rende l'unicité vraie : toute autre
  -- écriture du même numéro est refusée à l'écriture plutôt que tolérée puis
  -- dédoublonnée. Le stockage du numéro complet est assumé, il est l'un des
  -- deux canaux de connexion ; docs/observability.md en interdit en revanche la
  -- présence dans les journaux.
  phone text
    CONSTRAINT user_profiles_phone_e164
    CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'),

  -- Au moins un canal de connexion, sinon le compte est inaccessible : aucun
  -- code à usage unique ne pourrait lui être remis. La contrainte est portée
  -- par le serveur, et non par une validation applicative, parce qu'une
  -- validation applicative ne couvre pas les écritures faites par une reprise
  -- de données ou une console.
  CONSTRAINT user_profiles_identifier_required
    CHECK (email IS NOT NULL OR phone IS NOT NULL),

  -- --- Préférences et état ----------------------------------------------------
  -- Étiquette de langue courte, du type « fr » ou « fr-CA ». Le produit ne
  -- livre que le catalogue français (src/i18n/fr.ts) ; la colonne existe pour
  -- que l'ajout d'une langue ne soit pas une migration de données.
  preferred_language text NOT NULL DEFAULT 'fr'
    CONSTRAINT user_profiles_preferred_language_format
    CHECK (preferred_language ~ '^[a-z]{2}(-[A-Z]{2})?$'),

  verification_level public.user_verification_level NOT NULL DEFAULT 'NONE',

  status public.user_profile_status NOT NULL DEFAULT 'ACTIVE',

  -- --- Révocation globale ------------------------------------------------------
  -- Exigée par docs/security.md. Toute session émise AVANT cet instant est
  -- invalide, sans avoir à parcourir ni à mettre à jour la table des sessions :
  -- une seule écriture coupe tous les accès d'un compte compromis, y compris
  -- ceux d'appareils que l'administrateur ne connaît pas. Un balayage de
  -- `sessions` ferait le même travail en N écritures, et laisserait une fenêtre
  -- ouverte tant qu'il n'est pas terminé.
  --
  -- La comparaison à retenir côté code est STRICTE : une session n'est valide
  -- que si `issued_at > sessions_revoked_at`. Une session émise à l'instant
  -- exact de la révocation est donc invalidée. C'est le défaut sûr : dans le
  -- doute, on coupe.
  sessions_revoked_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.user_profiles IS
  'Comptes de la plateforme. Aucun mot de passe : la connexion repose sur un '
  'code à usage unique. Minimisation : ni santé, ni famille, ni pièce d''identité.';
COMMENT ON COLUMN public.user_profiles.auth_user_id IS
  'Identifiant opaque chez un fournisseur d''identité externe. NULL tant '
  'qu''aucun fournisseur n''est rattaché.';
COMMENT ON COLUMN public.user_profiles.email IS
  'Courriel normalisé : minuscules, sans espaces de bordure. Type citext, donc '
  'unicité insensible à la casse même pour une requête non normalisée.';
COMMENT ON COLUMN public.user_profiles.phone IS
  'Téléphone au format E.164 strict (+indicatif puis chiffres). Jamais journalisé '
  'en entier (docs/observability.md).';
COMMENT ON COLUMN public.user_profiles.verification_level IS
  'Niveau ordonné. Comparer avec >= plutôt qu''avec une liste IN.';
COMMENT ON COLUMN public.user_profiles.sessions_revoked_at IS
  'Révocation globale. Une session n''est valide que si issued_at > cette date. '
  'NULL signifie aucune révocation globale.';

-- Le déclencheur partagé de 0003 impose `updated_at` côté serveur : une valeur
-- fournie par l'application serait falsifiable et divergerait d'un poste à
-- l'autre.
CREATE OR REPLACE TRIGGER user_profiles_set_updated_at
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- --- Unicité des identifiants normalisés -------------------------------------
-- Index uniques plutôt que contraintes `UNIQUE` en ligne : la convention de
-- nommage de supabase/README.md impose le préfixe `uq_`, qu'une contrainte en
-- ligne ne permet pas de choisir sans la nommer séparément.
--
-- PostgreSQL considère deux NULL comme distincts (`NULLS DISTINCT`, comportement
-- par défaut conservé ici volontairement) : plusieurs comptes peuvent donc
-- n'avoir aucun courriel, ou aucun téléphone, tant que l'un des deux est
-- renseigné. `NULLS NOT DISTINCT` interdirait un second compte sans courriel,
-- ce qui n'a aucun sens ici.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_profiles_email
  ON public.user_profiles (email);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_profiles_phone
  ON public.user_profiles (phone);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_profiles_auth_user_id
  ON public.user_profiles (auth_user_id);

COMMENT ON INDEX public.uq_user_profiles_email IS
  'Unicité du courriel normalisé, insensible à la casse par le type citext.';
COMMENT ON INDEX public.uq_user_profiles_phone IS
  'Unicité du téléphone normalisé E.164.';

-- --- Index de statut ----------------------------------------------------------
-- docs/database-design.md demande un index sur les statuts. Il est PARTIEL,
-- restreint aux comptes qui ne sont pas actifs : c'est exactement la population
-- de l'écran 10 (« comptes suspendus ») et des revues de sécurité, et elle est
-- minoritaire par construction. Un index complet aurait indexé la quasi-totalité
-- de la table pour ne jamais être choisi sur la valeur majoritaire, un
-- balayage séquentiel étant alors moins coûteux.
CREATE INDEX IF NOT EXISTS idx_user_profiles_status
  ON public.user_profiles (status, updated_at DESC)
  WHERE status <> 'ACTIVE';

COMMENT ON INDEX public.idx_user_profiles_status IS
  'Comptes non actifs : écran d''administration et revues de sécurité.';

-- --- Droits ------------------------------------------------------------------
-- Pas de `DELETE`. La clôture d'un compte est un changement de statut
-- (`CLOSED`), pas une suppression : une suppression physique emporterait en
-- cascade les sessions et les défis, donc la trace de ce qui s'est passé, et
-- ferait perdre le lien des lignes d'audit déjà écrites. L'effacement réel,
-- lorsqu'il est dû au titre de docs/privacy-rgpd.md, est une opération
-- d'exploitation menée avec le compte de migration, précédée d'une sauvegarde
-- vérifiée — le même régime que la purge de rétention de `audit_logs`.
GRANT SELECT, INSERT, UPDATE ON public.user_profiles TO fire_support_app;
REVOKE DELETE, TRUNCATE ON public.user_profiles FROM fire_support_app;

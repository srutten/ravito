-- =============================================================================
-- 0011 — Table `auth_challenges` : codes de connexion à usage unique
-- Lot 1 · identité
--
-- Objet   : porter le défi de connexion de docs/screens.md écran 2. Un défi
--           associe un identifiant à un code à usage unique, une date
--           d'expiration et un compteur de tentatives.
-- Source  : docs/screens.md écran 2, docs/security.md (limitation de
--           tentatives, messages d'erreur neutres), docs/threat-model.md
--           (compte compromis, énumération), docs/privacy-rgpd.md
--           (minimisation), docs/observability.md (jetons exclus des journaux).
-- Retour  : supabase/migrations/0011_auth-challenges.down.sql
--
-- ---------------------------------------------------------------------------
-- DEUX RÈGLES QUE LA STRUCTURE REND NON CONTOURNABLES
-- ---------------------------------------------------------------------------
-- 1. LE CODE N'EST JAMAIS STOCKÉ EN CLAIR. Seule une empreinte l'est, et la
--    contrainte de forme rend l'écriture d'un code en clair impossible :
--    « 482913 » ne satisfait pas le motif de 64 caractères hexadécimaux. C'est
--    le procédé déjà retenu par 0006 pour `ip_hash` — la minimisation devient
--    structurelle au lieu d'être confiée à la vigilance de l'appelant. Un vol
--    de sauvegarde ne permet donc pas de rejouer un code en circulation.
--
-- 2. L'IDENTIFIANT N'EST JAMAIS STOCKÉ EN CLAIR NON PLUS. Cette table est la
--    seule que le chemin de connexion écrit AVANT toute authentification :
--    c'est donc la plus exposée à une écriture massive par un attaquant. Si
--    elle portait les courriels et téléphones en clair, il suffirait de
--    demander un code pour chaque adresse d'une liste, puis de faire fuiter
--    cette table, pour disposer d'un annuaire — alors qu'aucun de ces comptes
--    n'existe forcément. Hachée, la table ne rend rien.
--
-- ---------------------------------------------------------------------------
-- CE QUE « EMPREINTE » VEUT DIRE ICI — POINT CRITIQUE POUR LE CODE
-- ---------------------------------------------------------------------------
-- Les deux colonnes portent des valeurs à TRÈS FAIBLE ENTROPIE : un code à six
-- chiffres compte un million de possibilités, un courriel se devine par
-- dictionnaire. Un condensé simple, SHA-256 nu, s'inverse donc par force brute
-- exhaustive en quelques secondes sur du matériel courant : il ne protège rien.
--
-- Les deux colonnes doivent recevoir un HMAC-SHA-256 calculé avec un SECRET
-- DÉTENU PAR L'APPLICATION et absent de la base (docs/security.md, stockage
-- dans le gestionnaire de secrets). L'espace de recherche cesse alors d'être
-- celui du code ou de l'adresse pour devenir celui de la clé, et une fuite de
-- la seule base ne rend plus rien d'exploitable.
--
-- La contrainte SQL ne sait pas distinguer un HMAC d'un condensé nu : les deux
-- font 64 caractères hexadécimaux. Elle interdit le clair, elle n'impose pas la
-- clé. Le choix de l'algorithme est donc une exigence du code, écrite ici pour
-- qu'aucune relecture ne la découvre trop tard.
--
-- ---------------------------------------------------------------------------
-- POURQUOI `user_profile_id` EST NULLABLE — CRITÈRE DE NEUTRALITÉ
-- ---------------------------------------------------------------------------
-- Un défi est créé MÊME POUR UN IDENTIFIANT INCONNU. C'est délibéré et c'est le
-- cœur du critère de neutralité : une demande de code pour une adresse qui
-- n'existe pas doit produire la même réponse, le même code HTTP et une durée
-- comparable qu'une demande pour une adresse connue. Court-circuiter l'écriture
-- quand le compte est absent rendrait la requête mesurablement plus rapide, et
-- cette différence de durée suffirait à cartographier les comptes — la première
-- menace de docs/threat-model.md, appliquée aux coordinateurs.
--
-- Conséquence directe pour le code : la colonne NULL ne signale pas une anomalie
-- de données, elle signale un défi qui ne pourra jamais aboutir. La
-- vérification doit s'exécuter jusqu'au bout, comparer l'empreinte, incrémenter
-- le compteur, puis répondre le message unique — sans jamais prendre de raccourci
-- sur l'absence de compte.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.auth_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- HMAC-SHA-256 de l'identifiant NORMALISÉ, jamais l'identifiant. Normalisé
  -- d'abord, haché ensuite : hacher « Alice@Example.org » et
  -- « alice@example.org » donnerait deux empreintes, donc deux files de défis
  -- pour une seule boîte, et la limitation de tentatives se contournerait en
  -- changeant la casse.
  identifier_hash text NOT NULL
    CONSTRAINT auth_challenges_identifier_hash_format
    CHECK (identifier_hash ~ '^[0-9a-f]{64}$'),

  -- HMAC-SHA-256 du code à usage unique. La comparaison côté application doit
  -- se faire en TEMPS CONSTANT : une comparaison de chaînes qui s'arrête au
  -- premier octet différent laisse mesurer le nombre de caractères corrects, et
  -- transforme la recherche d'un code en une suite de recherches indépendantes.
  code_hash text NOT NULL
    CONSTRAINT auth_challenges_code_hash_format
    CHECK (code_hash ~ '^[0-9a-f]{64}$'),

  -- NULL quand l'identifiant ne correspond à aucun compte : voir l'en-tête.
  -- `ON DELETE CASCADE` : un défi n'a aucun sens sans son compte, et un
  -- effacement au titre de docs/privacy-rgpd.md doit emporter les défis en
  -- circulation. C'est le contraire du choix fait pour `audit_logs`, qui ne
  -- porte volontairement aucune clé étrangère parce que la preuve doit survivre
  -- au compte ; un code de connexion, lui, n'est pas une preuve.
  user_profile_id uuid
    CONSTRAINT auth_challenges_user_profile_fk
    REFERENCES public.user_profiles (id) ON DELETE CASCADE,

  -- Nombre de codes erronés déjà présentés pour ce défi. L'incrément doit être
  -- fait par le serveur — `SET attempts = attempts + 1` sous verrou de ligne,
  -- dans la transaction de vérification — et jamais calculé côté application à
  -- partir d'une valeur lue plus tôt : deux essais simultanés liraient la même
  -- valeur et n'en compteraient qu'un.
  attempts integer NOT NULL DEFAULT 0
    CONSTRAINT auth_challenges_attempts_positive CHECK (attempts >= 0),

  -- Plafond propre au défi, figé à sa création. Il est stocké plutôt que lu
  -- dans la configuration au moment de la vérification : un défi en circulation
  -- doit être jugé selon la règle en vigueur quand il a été émis, faute de quoi
  -- un changement de configuration modifierait rétroactivement le nombre
  -- d'essais restants de codes déjà envoyés.
  --
  -- Il n'existe VOLONTAIREMENT PAS de contrainte `attempts <= max_attempts`.
  -- Une telle contrainte ferait échouer l'incrément d'un essai en trop avec une
  -- erreur serveur, alors que l'essai suivant un épuisement doit produire
  -- exactement le même message neutre que tous les autres échecs. Un code
  -- d'erreur différent au-delà du plafond serait précisément l'oracle que le
  -- critère de neutralité interdit. Le plafond est donc appliqué par le domaine
  -- AVANT l'incrément, pas par un refus du serveur après coup.
  max_attempts integer NOT NULL DEFAULT 5
    CONSTRAINT auth_challenges_max_attempts_range CHECK (max_attempts BETWEEN 1 AND 10),

  -- Durée de vie courte (docs/security.md, sessions courtes pour les fonctions
  -- sensibles). La contrainte interdit un défi déjà expiré ou éternel à
  -- l'écriture.
  expires_at timestamptz NOT NULL,

  -- Usage unique : renseigné à la première vérification RÉUSSIE. Un défi
  -- consommé n'est plus jamais acceptable, même avant son expiration. La
  -- colonne est un horodatage et non un booléen, parce que l'instant de
  -- consommation sert aussi à mesurer le délai entre l'envoi et l'usage, donc à
  -- détecter une interception.
  consumed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT auth_challenges_expires_after_creation CHECK (expires_at > created_at),
  CONSTRAINT auth_challenges_consumed_after_creation
    CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

COMMENT ON TABLE public.auth_challenges IS
  'Codes de connexion à usage unique. Ni le code ni l''identifiant ne sont '
  'stockés en clair. Un défi est créé même pour un identifiant inconnu, afin que '
  'la réponse et la durée soient identiques dans les deux cas.';
COMMENT ON COLUMN public.auth_challenges.identifier_hash IS
  'HMAC-SHA-256 de l''identifiant normalisé, avec un secret hors base. Un '
  'condensé nu serait inversible par dictionnaire.';
COMMENT ON COLUMN public.auth_challenges.code_hash IS
  'HMAC-SHA-256 du code, avec un secret hors base. Comparaison en temps constant '
  'côté application.';
COMMENT ON COLUMN public.auth_challenges.user_profile_id IS
  'NULL lorsque l''identifiant ne correspond à aucun compte. Délibéré : '
  'neutralité des réponses.';
COMMENT ON COLUMN public.auth_challenges.max_attempts IS
  'Plafond figé à l''émission. Appliqué par le domaine avant incrément, jamais '
  'par une contrainte : un refus du serveur produirait une erreur distinguable.';

CREATE OR REPLACE TRIGGER auth_challenges_set_updated_at
  BEFORE UPDATE ON public.auth_challenges
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- --- Index de vérification ----------------------------------------------------
-- Chemin de la vérification : retrouver, pour une empreinte d'identifiant, le
-- défi non consommé le plus récent. L'index est PARTIEL sur `consumed_at IS
-- NULL` — un défi consommé n'est plus jamais candidat, l'indexer serait du
-- volume mort qui ne fait que grossir.
--
-- Le prédicat ne peut pas inclure `expires_at > now()` : `now()` n'est pas
-- immuable, PostgreSQL refuse une telle expression dans un index. L'expiration
-- reste donc un filtre de requête, servi par le tri de l'index.
--
-- Cet index n'est pas seulement une optimisation. Sans lui, la recherche
-- devient un balayage dont la durée croît avec le nombre de défis en base, et
-- un attaquant qui inonde la table rendrait mesurable l'écart entre un
-- identifiant connu et un identifiant inconnu — la neutralité de durée exigée
-- par le critère 7 dépend donc de cet index.
CREATE INDEX IF NOT EXISTS idx_auth_challenges_identifier
  ON public.auth_challenges (identifier_hash, expires_at DESC)
  WHERE consumed_at IS NULL;

-- --- Index de purge -----------------------------------------------------------
-- docs/privacy-rgpd.md impose une limitation de conservation, et cette table
-- est celle qui grossit le plus vite : une ligne par demande de code, y compris
-- pour les identifiants inconnus, donc y compris pour chaque tentative d'un
-- robot. Sans purge outillée, elle devient à la fois un coût et une réserve de
-- données inutiles.
CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires_at
  ON public.auth_challenges (expires_at);

-- PostgreSQL n'indexe pas automatiquement la colonne portant une clé étrangère.
-- Sans cet index, la suppression d'un compte balaierait toute la table pour
-- appliquer la cascade, et l'effacement RGPD deviendrait d'autant plus lent que
-- la plateforme est ancienne. Partiel : les défis sans compte, majoritaires en
-- cas d'attaque, n'ont pas à y figurer.
CREATE INDEX IF NOT EXISTS idx_auth_challenges_user_profile_id
  ON public.auth_challenges (user_profile_id)
  WHERE user_profile_id IS NOT NULL;

-- --- Droits ------------------------------------------------------------------
-- `UPDATE` est nécessaire : incrément des tentatives et marquage de la
-- consommation. Pas de `DELETE` — la purge par ancienneté est une tâche
-- d'exploitation, comme celle de `outbox`. Séparer les deux évite qu'un défaut
-- applicatif n'efface les traces d'une campagne de tentatives en cours,
-- c'est-à-dire la matière même de la détection d'abus demandée par
-- docs/observability.md.
GRANT SELECT, INSERT, UPDATE ON public.auth_challenges TO fire_support_app;
REVOKE DELETE, TRUNCATE ON public.auth_challenges FROM fire_support_app;

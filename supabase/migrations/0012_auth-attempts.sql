-- =============================================================================
-- 0012 — Table `auth_attempts` : limitation de tentatives de connexion
-- Lot 1 · identité
--
-- Objet   : porter le compteur qui permet de refuser les demandes de code et
--           les vérifications au-delà d'un seuil, puis de bloquer
--           temporairement le sujet fautif.
-- Source  : docs/security.md (limitation de tentatives, protection contre le
--           bourrage d'identifiants), docs/screens.md écran 2 (« blocage
--           temporaire »), docs/api-contract.md (code `RATE_LIMITED`),
--           docs/threat-model.md (saturation), docs/privacy-rgpd.md.
-- Retour  : supabase/migrations/0012_auth-attempts.down.sql
--
-- ---------------------------------------------------------------------------
-- POURQUOI EN BASE ET NON EN MÉMOIRE
-- ---------------------------------------------------------------------------
-- Un compteur en mémoire de processus se réinitialise à chaque redémarrage et
-- ne voit qu'une instance : sur deux répliques, le seuil réel devient le double
-- du seuil configuré, et un déploiement remet tous les compteurs à zéro. Une
-- limitation dont le seuil dépend de la topologie n'en est pas une. La table
-- est partagée et survit aux redémarrages ; le coût, une écriture par
-- tentative, est négligeable devant l'envoi d'un courriel ou d'un SMS qu'elle
-- évite.
--
-- ---------------------------------------------------------------------------
-- UNE LIGNE PAR SUJET, PAS UN JOURNAL DE TENTATIVES
-- ---------------------------------------------------------------------------
-- La table porte un COMPTEUR COURANT, pas l'historique des essais. Deux raisons.
--
-- Minimisation d'abord (docs/privacy-rgpd.md) : un journal de tentatives est un
-- registre horodaté des moments où une personne s'est connectée depuis tel
-- réseau, conservé indéfiniment et pour une finalité — compter — qui n'en a pas
-- besoin. La fenêtre glissante suffit, et se réinitialise d'elle-même.
--
-- Concurrence ensuite : une ligne unique par sujet permet un `INSERT ... ON
-- CONFLICT (subject_hash) DO UPDATE`, opération atomique servie par l'index
-- unique. Avec un journal, compter les lignes de la fenêtre puis décider
-- laisserait passer, entre le comptage et la décision, autant de tentatives
-- simultanées que l'attaquant en lance — c'est-à-dire exactement le cas que la
-- limitation existe pour couvrir.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.auth_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- HMAC-SHA-256 du sujet limité, jamais le sujet lui-même : ni l'identifiant,
  -- ni l'adresse IP n'apparaissent en clair. Même exigence de clé hors base que
  -- pour 0011 — une adresse IPv4 ne compte que quatre milliards de valeurs, un
  -- condensé nu s'inverse par énumération complète en quelques minutes.
  --
  -- La colonne est unique et générique : c'est l'appelant qui décide de la
  -- DIMENSION limitée en choisissant ce qu'il hache — l'identifiant seul,
  -- l'adresse seule, ou le couple. Une seule table sert ainsi plusieurs
  -- politiques, sans migration à chaque ajout.
  --
  -- Conséquence impérative pour le code : le texte haché DOIT être préfixé par
  -- un marqueur de dimension, par exemple « identifier: », « source: » ou
  -- « pair: ». Sans préfixe, deux dimensions différentes pourraient produire la
  -- même empreinte et partager un compteur, ce qui bloquerait un sujet à cause
  -- des tentatives d'un autre.
  subject_hash text NOT NULL
    CONSTRAINT auth_attempts_subject_hash_format
    CHECK (subject_hash ~ '^[0-9a-f]{64}$'),

  -- Début de la fenêtre courante. Le compteur est remis à zéro et cette date
  -- réavancée lorsque la fenêtre est écoulée : la ligne est réutilisée, jamais
  -- dupliquée.
  window_started_at timestamptz NOT NULL DEFAULT now(),

  attempt_count integer NOT NULL DEFAULT 0
    CONSTRAINT auth_attempts_count_positive CHECK (attempt_count >= 0),

  -- Blocage temporaire, NULL tant qu'aucun seuil n'est franchi. Temporaire et
  -- non définitif à dessein : un blocage définitif déclenché par un tiers
  -- deviendrait une arme de déni de service contre un compte précis — il
  -- suffirait de saisir de mauvais codes pour l'adresse d'un coordinateur pour
  -- l'exclure durablement, en pleine opération (docs/threat-model.md,
  -- saturation).
  --
  -- Pour la même raison, le blocage doit être signalé par le message neutre et
  -- le code `RATE_LIMITED` de docs/api-contract.md, identiques qu'un compte
  -- existe ou non derrière l'identifiant.
  blocked_until timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.auth_attempts IS
  'Compteur de tentatives par sujet haché, une ligne par sujet, fenêtre '
  'réinitialisable. Ni journal, ni historique : docs/privacy-rgpd.md.';
COMMENT ON COLUMN public.auth_attempts.subject_hash IS
  'HMAC-SHA-256 du sujet limité, préfixé par un marqueur de dimension '
  '(identifier:, source:, pair:). Secret hors base.';
COMMENT ON COLUMN public.auth_attempts.blocked_until IS
  'Blocage temporaire. Jamais définitif : un blocage définitif provoqué par un '
  'tiers serait un déni de service ciblé.';

CREATE OR REPLACE TRIGGER auth_attempts_set_updated_at
  BEFORE UPDATE ON public.auth_attempts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- --- Unicité du sujet ---------------------------------------------------------
-- C'est cet index qui rend l'incrément atomique, en servant la clause
-- `ON CONFLICT (subject_hash)`. Il tient aussi lieu d'index de recherche : un
-- index composite `(subject_hash, window_started_at)` serait redondant, la
-- première colonne désignant déjà au plus une ligne.
CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_attempts_subject_hash
  ON public.auth_attempts (subject_hash);

COMMENT ON INDEX public.uq_auth_attempts_subject_hash IS
  'Une seule ligne par sujet. Support de l''incrément atomique par ON CONFLICT.';

-- --- Index de fenêtre ---------------------------------------------------------
-- Sert la purge des compteurs dormants, ceux dont la fenêtre est écoulée depuis
-- longtemps et qui n'ont aucune raison d'être conservés.
CREATE INDEX IF NOT EXISTS idx_auth_attempts_window_started_at
  ON public.auth_attempts (window_started_at);

-- Partiel : les sujets effectivement bloqués sont une minorité, et ce sont les
-- seuls que la supervision consulte. docs/observability.md demande une alerte
-- sur la hausse des accès refusés ; sans cet index, cette alerte coûterait un
-- balayage complet à chaque évaluation.
CREATE INDEX IF NOT EXISTS idx_auth_attempts_blocked_until
  ON public.auth_attempts (blocked_until)
  WHERE blocked_until IS NOT NULL;

-- --- Droits ------------------------------------------------------------------
-- `INSERT` et `UPDATE` sont indissociables ici : l'incrément atomique est un
-- `INSERT ... ON CONFLICT DO UPDATE`, qui exige les deux droits.
-- Pas de `DELETE` : l'application ne doit pas pouvoir effacer un compteur, ce
-- qui reviendrait à lever un blocage. La levée normale est l'écoulement du
-- temps ; la levée exceptionnelle est une opération d'exploitation, tracée.
GRANT SELECT, INSERT, UPDATE ON public.auth_attempts TO fire_support_app;
REVOKE DELETE, TRUNCATE ON public.auth_attempts FROM fire_support_app;

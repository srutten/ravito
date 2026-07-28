-- =============================================================================
-- 0013 — Table `sessions`
-- Lot 1 · identité
--
-- Objet   : porter les sessions ouvertes. Le cookie remis au navigateur
--           contient un jeton opaque ; la base n'en conserve que l'empreinte.
-- Source  : docs/security.md (sessions courtes, révocation globale, jetons
--           absents des journaux), docs/permissions.md (cas de test
--           « réutilisation d'une ancienne session »), docs/threat-model.md
--           (compte coordinateur compromis), docs/privacy-rgpd.md,
--           docs/observability.md.
-- Retour  : supabase/migrations/0013_sessions.down.sql
--
-- ---------------------------------------------------------------------------
-- CE QUI REND UNE SESSION VALIDE — CONTRAT POUR src/authorization/
-- ---------------------------------------------------------------------------
-- Quatre conditions, toutes nécessaires, à vérifier à CHAQUE requête et
-- toujours côté serveur :
--
--   1. `revoked_at IS NULL`            — pas de déconnexion individuelle ;
--   2. `expires_at > now()`            — pas d'expiration ;
--   3. `issued_at > user_profiles.sessions_revoked_at`, lorsque cette date
--                                        n'est pas NULL — pas de révocation
--                                        globale ;
--   4. `user_profiles.status = 'ACTIVE'` — le compte n'est ni suspendu ni clos.
--
-- La quatrième est facile à oublier parce qu'elle porte sur une autre table.
-- L'omettre laisserait une session ouverte survivre à la suspension du compte,
-- c'est-à-dire à la première mesure de réponse à incident de docs/security.md :
-- suspendre un coordinateur compromis ne couperait rien tant que son onglet
-- reste ouvert. docs/permissions.md en fait d'ailleurs un cas de test
-- obligatoire, « accès après suspension ».
--
-- La condition 3 est STRICTE. Une session émise à l'instant exact de la
-- révocation globale est invalide : dans le doute, on coupe.
--
-- Point d'extension à connaître : docs/permissions.md exige aussi qu'une
-- adhésion suspendue coupe l'accès. Cette cinquième condition n'est PAS
-- réalisable ici, la table `organization_members` n'existant pas encore
-- (US-012 et US-014). Elle devra être ajoutée à cette liste par le lot qui la
-- crée, et vérifiée par un test d'accès dédié.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- `ON DELETE CASCADE` : une session sans compte serait un accès sans
  -- titulaire. La clôture ordinaire d'un compte passe cependant par le statut
  -- `CLOSED` et non par une suppression (voir 0010) ; la cascade ne joue donc
  -- que lors d'un effacement au titre de docs/privacy-rgpd.md.
  user_profile_id uuid NOT NULL
    CONSTRAINT sessions_user_profile_fk
    REFERENCES public.user_profiles (id) ON DELETE CASCADE,

  -- SHA-256 du jeton opaque, jamais le jeton. Le cookie est la seule copie du
  -- secret : un vol de la base ne permet donc pas d'usurper une session en
  -- cours, et la base ne peut pas restituer un jeton perdu — un jeton perdu se
  -- remplace par une reconnexion, il ne se retrouve pas.
  --
  -- Contrairement aux empreintes de 0011 et 0012, un condensé simple SUFFIT
  -- ici, et la différence mérite d'être comprise plutôt que subie : un code à
  -- six chiffres ou une adresse de courriel se retrouvent par énumération de
  -- l'espace des valeurs possibles, alors qu'un jeton de session est tiré au
  -- hasard sur au moins 128 bits, espace qu'aucune énumération n'atteint. La
  -- résistance ne vient pas d'un secret ajouté, elle vient de l'entropie du
  -- jeton — que le code doit donc garantir : un jeton tiré d'un générateur non
  -- cryptographique ruinerait ce raisonnement sans qu'aucune contrainte SQL
  -- puisse le signaler.
  token_hash text NOT NULL
    CONSTRAINT sessions_token_hash_format
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),

  -- Instant d'émission. C'est LA valeur comparée à
  -- `user_profiles.sessions_revoked_at` : elle ne doit jamais être mise à jour
  -- après coup, sans quoi une session révoquée globalement redeviendrait valide
  -- en se rafraîchissant elle-même. Prolonger une session, si le produit le
  -- décide un jour, consiste à repousser `expires_at`, jamais à réavancer
  -- `issued_at`.
  issued_at timestamptz NOT NULL DEFAULT now(),

  -- Dernière activité observée. Sert la détection d'usage anormal et la purge
  -- des sessions dormantes. Écrite paresseusement — une écriture par requête
  -- transformerait chaque lecture en écriture, pour une précision dont personne
  -- n'a besoin.
  last_seen_at timestamptz NOT NULL DEFAULT now(),

  -- Expiration absolue. docs/security.md demande des sessions courtes pour les
  -- fonctions sensibles ; la durée exacte relève de la configuration, mais
  -- l'expiration est portée par la ligne et non déduite d'un jeton signé : une
  -- expiration inscrite dans le jeton ne serait pas raccourcissable après
  -- émission, alors qu'ici une réduction de durée s'applique immédiatement.
  expires_at timestamptz NOT NULL,

  -- Déconnexion individuelle, ou révocation ciblée d'un appareil. La ligne est
  -- CONSERVÉE et marquée, jamais supprimée : la trace d'une session ayant
  -- existé fait partie de ce qui permet de reconstituer un incident.
  revoked_at timestamptz,

  -- Résumé court, du type « Firefox 141 / Android ». Même borne et même
  -- intention que dans `audit_logs` : la borne interdit de stocker l'en-tête
  -- complet, qui constituerait une empreinte de navigateur exploitable pour du
  -- pistage (docs/privacy-rgpd.md, suivi permanent parmi les données à éviter).
  user_agent_summary text
    CONSTRAINT sessions_user_agent_length
    CHECK (user_agent_summary IS NULL OR char_length(user_agent_summary) <= 200),

  -- Empreinte de l'adresse IP d'ouverture, jamais l'adresse. Sert à signaler à
  -- l'utilisateur ses sessions ouvertes et à repérer un changement brutal
  -- d'origine. La contrainte de forme rend l'écriture d'une IP en clair
  -- impossible, comme dans `audit_logs` : « 192.168.1.1 » ne satisfait pas le
  -- motif.
  ip_hash text
    CONSTRAINT sessions_ip_hash_format
    CHECK (ip_hash ~ '^[0-9a-f]{64}$'),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Une session qui expire avant d'être émise n'existe pas ; l'écriture est
  -- refusée plutôt que tolérée puis interprétée.
  CONSTRAINT sessions_expires_after_issue CHECK (expires_at > issued_at),
  CONSTRAINT sessions_last_seen_after_issue CHECK (last_seen_at >= issued_at),
  CONSTRAINT sessions_revoked_after_issue
    CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);

COMMENT ON TABLE public.sessions IS
  'Sessions ouvertes. Le jeton n''est jamais stocké, seule son empreinte l''est. '
  'Une session révoquée est marquée, jamais supprimée.';
COMMENT ON COLUMN public.sessions.token_hash IS
  'SHA-256 du jeton opaque. Suffisant parce que le jeton porte au moins 128 bits '
  'd''entropie ; ce n''est pas le cas des empreintes de 0011 et 0012.';
COMMENT ON COLUMN public.sessions.issued_at IS
  'Instant d''émission, jamais réavancé. Comparé à '
  'user_profiles.sessions_revoked_at pour la révocation globale.';
COMMENT ON COLUMN public.sessions.revoked_at IS
  'Déconnexion ou révocation ciblée. NULL tant que la session n''est pas '
  'révoquée individuellement.';
COMMENT ON COLUMN public.sessions.ip_hash IS
  'Empreinte SHA-256 hexadécimale de l''adresse IP. Jamais l''adresse en clair.';

CREATE OR REPLACE TRIGGER sessions_set_updated_at
  BEFORE UPDATE ON public.sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- --- Recherche par jeton ------------------------------------------------------
-- Chemin le plus fréquent du produit : une requête authentifiée présente un
-- cookie, le serveur en calcule l'empreinte et retrouve la ligne. Unique, donc
-- une seule ligne au plus, et l'unicité interdit structurellement que deux
-- sessions partagent un jeton — situation qui, si elle survenait, ferait
-- accéder un utilisateur au compte d'un autre.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_token_hash
  ON public.sessions (token_hash);

COMMENT ON INDEX public.uq_sessions_token_hash IS
  'Recherche de session par empreinte de jeton. Unique : deux sessions ne '
  'peuvent pas partager un jeton.';

-- --- Sessions d'un compte -----------------------------------------------------
-- Sert l'écran « mes sessions », la révocation ciblée, et la cascade de
-- suppression du compte. Non partiel volontairement : un index partiel sur les
-- sessions non révoquées ne servirait pas la cascade, qui doit atteindre toutes
-- les lignes, et la suppression retomberait sur un balayage complet.
CREATE INDEX IF NOT EXISTS idx_sessions_user_profile_id
  ON public.sessions (user_profile_id, issued_at DESC);

-- --- Purge --------------------------------------------------------------------
-- docs/privacy-rgpd.md, limitation de conservation. Une session expirée depuis
-- longtemps n'a plus d'utilité opérationnelle ; la durée de conservation reste
-- à valider juridiquement, comme pour les autres purges du dépôt.
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at
  ON public.sessions (expires_at);

-- --- Droits ------------------------------------------------------------------
-- `UPDATE` couvre `last_seen_at` et `revoked_at`. Pas de `DELETE` : la
-- déconnexion est un marquage, pas une suppression. Accorder `DELETE` offrirait
-- à un compte applicatif compromis un moyen d'effacer la trace des sessions
-- qu'il a ouvertes, alors que cette trace est justement ce qui permet de
-- constater l'intrusion après coup.
GRANT SELECT, INSERT, UPDATE ON public.sessions TO fire_support_app;
REVOKE DELETE, TRUNCATE ON public.sessions FROM fire_support_app;

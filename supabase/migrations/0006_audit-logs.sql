-- =============================================================================
-- 0006 — Journal d'audit immuable
-- Lot 0 · socle transverse
--
-- Objet   : conserver une preuve exploitable des actions critiques
--           (docs/security.md). Un journal que l'application peut réécrire
--           n'est pas une preuve : un compte coordinateur compromis
--           effacerait d'abord ses traces. L'immuabilité est donc verrouillée
--           deux fois, par les droits SQL et par un déclencheur.
-- Source  : docs/domain-model.md (champs), docs/database-design.md (index),
--           docs/permissions.md (filtrage par organisation),
--           docs/privacy-rgpd.md (minimisation).
--
-- Stratégie de retour : aucun fichier `.down.sql`.
--   Supprimer la table détruirait la preuve, c'est-à-dire exactement ce que le
--   journal existe pour empêcher. Un retour arrière capable d'effacer l'audit
--   serait une porte dérobée, disponible en une commande, pour quiconque
--   obtient le compte de migration.
--   La compatibilité descendante est assurée sans suppression : la table est
--   purement additive, aucune migration antérieure n'en dépend, et une version
--   antérieure du code l'ignore simplement. En cas de retour arrière du code,
--   la table reste en place et continue de recevoir les écritures de la
--   version redéployée. Si le schéma devait réellement évoluer, la voie est un
--   déploiement en plusieurs étapes (docs/database-design.md), pas une
--   suppression.
--   Voir supabase/README.md pour la procédure d'exception, qui exige la même
--   décision qu'une purge de rétention.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Acteur. NULL pour une action du système lui-même (expiration automatique
  -- d'une proposition, drainage). Aucune clé étrangère : le journal doit
  -- survivre à la suppression du compte, faute de quoi l'exercice du droit à
  -- l'effacement emporterait la preuve des actions passées. Le lien est
  -- reconstitué par jointure applicative au lot 1.
  actor_user_id uuid,

  -- Organisation de l'acteur au moment de l'action. Support du filtrage exigé
  -- par la ligne « Consulter l'audit » de docs/permissions.md : un admin
  -- d'organisation ne voit que les lignes de son organisation. La valeur est
  -- figée à l'écriture et n'est jamais recalculée depuis l'appartenance
  -- courante, qui peut avoir changé depuis.
  actor_organization_id uuid,

  -- Code d'action stable en majuscules (docs/coding-standards.md), par exemple
  -- MISSION_VALIDATED ou PRECISE_LOCATION_VIEWED.
  action text NOT NULL
    CONSTRAINT audit_logs_action_format CHECK (action ~ '^[A-Z][A-Z0-9_]{2,63}$'),

  target_type text NOT NULL
    CONSTRAINT audit_logs_target_type_format CHECK (target_type ~ '^[A-Z][A-Z0-9_]{2,63}$'),

  -- NULL pour une action sans cible identifiée par un UUID, comme l'activation
  -- du mode lecture seule (docs/security.md), dont la cible est la plateforme.
  target_id uuid,

  -- États avant et après, réduits aux champs réellement modifiés. Ne doivent
  -- jamais contenir de position précise, de document, ni de téléphone complet
  -- (docs/observability.md) : le journal d'audit est consultable par des rôles
  -- qui n'ont pas accès à ces données dans l'application.
  before jsonb
    CONSTRAINT audit_logs_before_is_object
    CHECK (before IS NULL OR jsonb_typeof(before) = 'object'),
  after jsonb
    CONSTRAINT audit_logs_after_is_object
    CHECK (after IS NULL OR jsonb_typeof(after) = 'object'),

  -- Empreinte SHA-256 de l'adresse IP, jamais l'adresse elle-même. La
  -- contrainte de forme rend l'écriture d'une IP en clair impossible :
  -- « 192.168.1.1 » ne satisfait pas le motif. C'est la minimisation de
  -- docs/privacy-rgpd.md rendue structurelle plutôt que confiée à la vigilance
  -- de l'appelant.
  ip_hash text
    CONSTRAINT audit_logs_ip_hash_format CHECK (ip_hash ~ '^[0-9a-f]{64}$'),

  -- Résumé volontairement court, du type « Firefox 141 / Android ». La borne
  -- interdit de stocker l'en-tête complet, qui constituerait une empreinte de
  -- navigateur exploitable pour du pistage.
  user_agent_summary text
    CONSTRAINT audit_logs_user_agent_length CHECK (char_length(user_agent_summary) <= 200),

  -- Instant métier de l'action, fourni par l'application. Peut être antérieur
  -- à l'écriture en base lorsqu'une action est rejouée depuis la file locale
  -- du mode dégradé (docs/offline-mode.md).
  occurred_at timestamptz NOT NULL DEFAULT now(),

  -- Instant d'écriture en base, imposé par le serveur. Tient lieu de
  -- `created_at` pour une table append-only. L'écart avec `occurred_at` mesure
  -- le retard de rejeu.
  recorded_at timestamptz NOT NULL DEFAULT now()
);

-- Pas de colonne `updated_at` : la table est append-only. La colonne
-- laisserait croire qu'une mise à jour est prévue, alors que le déclencheur
-- ci-dessous la refuse.
COMMENT ON TABLE public.audit_logs IS
  'Journal d''audit append-only. Ni UPDATE ni DELETE pour le compte applicatif. '
  'Rétention : purge par ancienneté sous compte de maintenance, voir supabase/README.md.';
COMMENT ON COLUMN public.audit_logs.actor_organization_id IS
  'Organisation de l''acteur au moment de l''action. Support du filtrage par '
  'organisation de docs/permissions.md. Figée à l''écriture.';
COMMENT ON COLUMN public.audit_logs.ip_hash IS
  'Empreinte SHA-256 hexadécimale de l''adresse IP. Jamais l''adresse en clair.';
COMMENT ON COLUMN public.audit_logs.occurred_at IS
  'Instant métier, fourni par l''application. Peut précéder recorded_at (rejeu hors ligne).';
COMMENT ON COLUMN public.audit_logs.recorded_at IS
  'Instant d''écriture en base, imposé par le serveur. Tient lieu de created_at.';

-- --- Index -------------------------------------------------------------------
-- Exigé par docs/database-design.md : reconstitution de l'historique d'un
-- objet donné. `occurred_at DESC` sert l'affichage naturel, du plus récent au
-- plus ancien.
CREATE INDEX IF NOT EXISTS idx_audit_logs_target
  ON public.audit_logs (target_type, target_id, occurred_at DESC);

-- Exigé par la ligne « Consulter l'audit » de docs/permissions.md, où l'accès
-- d'un admin d'organisation est borné à son organisation. Sans cet index, le
-- filtrage obligatoire serait un balayage complet du journal, donc une
-- consultation d'autant plus lente que la preuve est riche.
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_organization
  ON public.audit_logs (actor_organization_id, occurred_at DESC);

-- --- Immuabilité, verrou 1 : le déclencheur ----------------------------------
-- Les droits SQL ne protègent que du rôle auquel on a pensé. Un rôle ajouté
-- plus tard, un compte de maintenance réutilisé par erreur par l'application,
-- ou un `GRANT ALL` accidentel suffiraient à rendre le journal réinscriptible.
-- Le déclencheur, lui, s'applique à tout le monde sauf à qui le désactive
-- explicitement — ce qui est une action visible et privilégiée.
--
-- Exception unique et volontaire : la purge de rétention exigée par
-- docs/privacy-rgpd.md (limitation de conservation). Elle doit déclarer son
-- intention en posant le paramètre de session `appui_feux.audit_purge`. Un
-- DELETE ordinaire, y compris passé à la main en console, échoue. Poser le
-- paramètre ne suffit d'ailleurs pas : il faut aussi détenir le droit DELETE,
-- que le compte applicatif n'a pas.
CREATE OR REPLACE FUNCTION public.reject_audit_log_mutation()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('appui_feux.audit_purge', true) = 'on' THEN
    -- Purge de rétention assumée : la session l'a déclarée explicitement.
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'Le journal d''audit est immuable : opération % refusée sur %.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

COMMENT ON FUNCTION public.reject_audit_log_mutation() IS
  'Refuse toute modification du journal d''audit. Seule exception : DELETE '
  'lorsque la session a posé appui_feux.audit_purge = on (purge de rétention).';

REVOKE ALL ON FUNCTION public.reject_audit_log_mutation() FROM PUBLIC;

CREATE OR REPLACE TRIGGER audit_logs_reject_mutation
  BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_audit_log_mutation();

-- TRUNCATE ne déclenche pas les déclencheurs de ligne : sans ce second
-- déclencheur, une seule commande viderait le journal en contournant le
-- premier. Aucune exception n'est prévue, pas même pour la purge : une purge
-- de rétention est sélective par ancienneté, jamais totale.
CREATE OR REPLACE TRIGGER audit_logs_reject_truncate
  BEFORE TRUNCATE ON public.audit_logs
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.reject_audit_log_mutation();

-- --- Immuabilité, verrou 2 : les droits SQL ----------------------------------
-- L'application écrit et relit. Elle ne peut ni corriger ni effacer.
-- Le REVOKE est redondant avec le refus par défaut de 0002, mais il rend
-- l'intention explicite dans le schéma : un futur `GRANT ALL` ajouté sans
-- réfléchir contredira une ligne visible de cette migration.
GRANT SELECT, INSERT ON public.audit_logs TO fire_support_app;
REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_logs FROM fire_support_app;

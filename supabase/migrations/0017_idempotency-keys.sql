-- =============================================================================
-- 0017 — Registre central d'idempotence `idempotency_keys`
-- Lot 1 · identité et organisations
--
-- Objet   : rendre une mutation critique rejouable sans second effet.
--           CLAUDE.md : « Chaque mutation critique accepte un clientEventId
--           UUID unique. Une même commande ne doit jamais produire deux
--           effets. » docs/api-contract.md le rend obligatoire sur la création
--           d'organisation et lui associe le code `IDEMPOTENCY_CONFLICT`.
-- Source  : docs/domain-model.md, docs/database-design.md (« index unique sur
--           client_event_id »), docs/api-contract.md, docs/test-plan.md
--           (scénario critique « Rejeu »), docs/offline-mode.md et
--           backlog/acceptance-scenarios.md (« Départ hors ligne » : l'action
--           mise en file locale porte un clientEventId et n'est synchronisée
--           qu'une seule fois).
-- Retour  : supabase/migrations/0017_idempotency-keys.down.sql
--
-- ###########################################################################
-- # À NE PAS CONFONDRE AVEC `idempotency_witness` (0007)                    #
-- #                                                                          #
-- # `idempotency_witness` est une TABLE TÉMOIN du lot 0, sans aucun GRANT,   #
-- # interdite au code applicatif et supprimée par la migration du lot 5.     #
-- # Elle démontrait le mécanisme. `idempotency_keys` est le registre RÉEL,   #
-- # utilisable par le domaine. Les deux coexistent jusqu'au lot 5 ; le code  #
-- # applicatif n'écrit QUE dans celle-ci.                                    #
-- ###########################################################################
--
-- ---------------------------------------------------------------------------
-- PORTÉE DE `client_event_id` — LE POINT OUVERT DU CORPUS RESTE OUVERT
-- ---------------------------------------------------------------------------
-- La contradiction documentaire signalée par 0007 et par supabase/README.md
-- n'est PAS tranchée ici, et cette migration ne doit pas être lue comme un
-- arbitrage.
--   - docs/domain-model.md écrit : « clientEventId unique par acteur ou
--     mission » ;
--   - docs/database-design.md écrit : « index unique sur client_event_id »,
--     donc une portée globale.
-- Les deux ne peuvent pas être vrais en même temps. US-002 a implémenté la
-- portée GLOBALE, la plus stricte, et a documenté la contradiction comme
-- ouverte. CETTE MIGRATION SUIT LA MÊME PORTÉE, par cohérence et pour la même
-- raison : le sens de l'évolution n'est pas symétrique.
--   - global vers par acteur est un RELÂCHEMENT : toutes les lignes existantes
--     satisfont déjà la nouvelle contrainte, la migration ne peut pas échouer ;
--   - par acteur vers global est un DURCISSEMENT : si deux acteurs ont déjà
--     réutilisé le même identifiant, la création de l'index unique échoue, en
--     production.
-- Commencer strict laisse les deux portes ouvertes ; commencer permissif en
-- ferme une. La décision appartient au lot 5 et doit être inscrite dans
-- docs/decision-log.md, avec correction de l'un des deux documents.
--
-- Ce que cette table apporte au débat, et qui manquait. 0007 relevait qu'un
-- index unique PAR TABLE ne rend pas l'identifiant globalement unique, puisque
-- docs/api-contract.md attache un `clientEventId` à des mutations qui écrivent
-- dans des tables différentes. Un registre central — une table unique où chaque
-- mutation critique réserve son identifiant AVANT d'agir — est la seule forme
-- qui rende la portée réellement globale. C'est l'option (a) du tableau de
-- supabase/README.md, et elle est ici DISPONIBLE, pas imposée : si le lot 5
-- retient la portée par acteur, la table reste correcte, seul son index unique
-- change.
--
-- Coût réel d'un passage ultérieur à une portée par acteur, avec ce schéma :
-- `CREATE UNIQUE INDEX CONCURRENTLY` sur `(actor_user_id, client_event_id)`
-- puis `DROP INDEX CONCURRENTLY` sur l'ancien, sans verrouiller la table et
-- sans reprise de données. C'est précisément pour rendre cette manœuvre
-- possible que la clé primaire est une colonne de substitution et NON
-- `client_event_id` : une contrainte de clé primaire ne se remplace pas sans
-- verrou exclusif, alors qu'un index unique ordinaire se remplace à chaud.
-- `actor_user_id` est déjà stocké pour la même raison — la colonne serait
-- irremplissable rétroactivement le jour où l'index en aurait besoin.
--
-- ---------------------------------------------------------------------------
-- CE QUE CETTE TABLE FERME
-- ---------------------------------------------------------------------------
-- `src/infrastructure/audit/audit-log.ts` détecte aujourd'hui un rejeu en
-- relisant le journal d'audit, faute de registre, et documente honnêtement sa
-- limite : « deux rejeux STRICTEMENT simultanés ne se voient pas l'un l'autre
-- et produiront deux lignes ». Une réservation par insertion ferme cette
-- fenêtre : la seconde transaction se bloque sur l'index unique jusqu'à ce que
-- la première tranche, puis reçoit `unique_violation` (23505) si la première a
-- validé, ou obtient la clé si la première a été annulée. C'est la seule
-- construction qui n'ait pas de fenêtre de concurrence, pour la même raison
-- qu'en 0007 : deux transactions simultanées liront toutes deux « pas encore
-- fait » avant que l'une n'écrive.
--
-- Séquence attendue du code appelant, dans UNE SEULE transaction :
--   1. INSERT de la réservation ; `23505` signifie « déjà vu » ;
--   2. la mutation métier elle-même, l'audit et l'écriture dans `outbox` ;
--   3. UPDATE de la ligne réservée avec la cible produite et la réponse à
--      rejouer.
-- Sur `23505`, relire la ligne existante :
--   - empreinte de requête IDENTIQUE : rejeu légitime, renvoyer `result` sans
--     nouvel effet ;
--   - empreinte DIFFÉRENTE : deux requêtes distinctes présentent la même clé,
--     c'est `IDEMPOTENCY_CONFLICT` de docs/api-contract.md. Rejouer la première
--     réponse serait pire que refuser : l'appelant croirait sa seconde demande
--     satisfaite alors qu'elle n'a rien produit.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  -- Colonne de substitution, volontairement : voir l'en-tête. La clé primaire
  -- ne doit pas être `client_event_id`, sous peine de rendre coûteux le
  -- changement de portée que le lot 5 pourrait décider.
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identifiant fourni par le client pour rendre la commande rejouable sans
  -- effet supplémentaire (docs/api-contract.md). Un UUID : le type refuse à
  -- l'écriture une chaîne devinable ou séquentielle, qu'un tiers pourrait
  -- présenter pour absorber la commande d'un autre.
  client_event_id uuid NOT NULL,

  -- Code de la mutation réservée, en majuscules, au même format que
  -- `outbox.event_type` et `audit_logs.action` (docs/coding-standards.md).
  -- Exemple : `ORGANIZATION_CREATE`. Il n'entre PAS dans l'unicité : la portée
  -- est globale, un identifiant déjà employé pour une opération ne peut pas
  -- être réemployé pour une autre. Il sert au diagnostic et à la lisibilité du
  -- registre.
  operation text NOT NULL
    CONSTRAINT idempotency_keys_operation_format
    CHECK (operation ~ '^[A-Z][A-Z0-9_]{2,63}$'),

  -- Acteur de la commande. NULL pour une action du système. Aucune clé
  -- étrangère, pour la raison de `audit_logs` (0006) : le registre doit
  -- survivre à la suppression d'un compte, sans quoi l'exercice du droit à
  -- l'effacement rendrait rejouables des commandes déjà exécutées.
  --
  -- La colonne n'entre PAS dans l'index unique aujourd'hui. Elle est renseignée
  -- dès maintenant parce qu'une portée par acteur, si le lot 5 la retient, ne
  -- pourrait pas la remplir rétroactivement.
  actor_user_id uuid,

  -- --- Empreinte de la requête ---------------------------------------------------
  -- Sert à distinguer un rejeu légitime d'une réutilisation de clé pour une
  -- requête différente (`IDEMPOTENCY_CONFLICT`).
  --
  -- HMAC-SHA-256, avec un secret tenu HORS BASE, jamais un condensé nu. La
  -- règle et sa raison sont celles du lot 1 (voir « Convention d'empreinte »
  -- dans supabase/README.md) : le corps d'une requête de création
  -- d'organisation est une valeur à FAIBLE ENTROPIE — un nom, un type pris
  -- dans cinq valeurs, un numéro d'immatriculation à format connu. Un condensé
  -- nu s'inverserait par énumération, et le vol d'une sauvegarde révélerait le
  -- contenu de requêtes que cette colonne existe justement pour ne pas
  -- stocker. Le secret vient du gestionnaire de secrets (docs/security.md).
  --
  -- La contrainte de forme interdit structurellement d'y écrire la requête en
  -- clair : un corps JSON ne satisfait pas `^[0-9a-f]{64}$`.
  request_fingerprint text NOT NULL
    CONSTRAINT idempotency_keys_request_fingerprint_format
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),

  -- --- Effet produit --------------------------------------------------------------
  -- Cible de la mutation, renseignée par l'UPDATE de fin de transaction. NULL
  -- entre la réservation et la fin de la mutation ; comme les deux ont lieu
  -- dans la même transaction, aucune autre session n'observe cet état
  -- intermédiaire.
  target_type text
    CONSTRAINT idempotency_keys_target_type_format
    CHECK (target_type IS NULL OR target_type ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  target_id uuid,

  -- Réponse à rejouer à l'identique. Réduite au strict nécessaire : des
  -- identifiants et une version, jamais une position précise, un document, un
  -- téléphone complet ni un contenu sensible (docs/observability.md,
  -- docs/privacy-rgpd.md). Le registre est relu par un chemin qui a déjà passé
  -- les contrôles d'autorisation, mais il n'a pas à devenir un second stockage
  -- des données qu'il désigne.
  result jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT idempotency_keys_result_is_object CHECK (jsonb_typeof(result) = 'object'),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.idempotency_keys IS
  'Registre central d''idempotence. Chaque mutation critique y réserve son '
  'clientEventId AVANT d''agir, dans la transaction de la mutation. '
  'Portée globale, cohérente avec 0007 ; arbitrage ouvert, voir supabase/README.md.';
COMMENT ON COLUMN public.idempotency_keys.client_event_id IS
  'Identifiant fourni par le client. Unicité GLOBALE aujourd''hui, par index '
  'ordinaire et non par clé primaire, pour que le changement de portée reste à chaud.';
COMMENT ON COLUMN public.idempotency_keys.actor_user_id IS
  'Acteur de la commande. Hors de l''unicité aujourd''hui ; renseigné pour '
  'qu''une portée par acteur reste possible sans reprise de données.';
COMMENT ON COLUMN public.idempotency_keys.request_fingerprint IS
  'HMAC-SHA-256 de la requête normalisée, secret hors base. Jamais un condensé '
  'nu : le corps d''une requête est à faible entropie et s''énumère.';
COMMENT ON COLUMN public.idempotency_keys.result IS
  'Réponse à rejouer. Identifiants et version seulement, aucune donnée sensible.';

-- `updated_at` est utile ici : la ligne est mutable une fois, quand la
-- réservation reçoit son résultat. L'écart avec `created_at` mesure la durée de
-- la mutation réservée.
CREATE OR REPLACE TRIGGER idempotency_keys_set_updated_at
  BEFORE UPDATE ON public.idempotency_keys
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- --- Unicité de `client_event_id`, portée globale -----------------------------
-- Transcription directe de docs/database-design.md, « index unique sur
-- client_event_id ». Une seconde insertion du même identifiant lève
-- `unique_violation` (23505). Le code doit traiter cette erreur comme « déjà
-- fait », et non comme un échec : c'est ainsi qu'un rejeu devient sans effet.
CREATE UNIQUE INDEX IF NOT EXISTS uq_idempotency_keys_client_event_id
  ON public.idempotency_keys (client_event_id);

COMMENT ON INDEX public.uq_idempotency_keys_client_event_id IS
  'Portée globale, la plus stricte. Contradiction documentaire ouverte : voir '
  'l''en-tête de 0017_idempotency-keys.sql, celui de 0007 et supabase/README.md.';

-- --- Purge de rétention -------------------------------------------------------
-- Le registre croît d'une ligne par mutation critique et n'a aucune limite
-- naturelle. La sélection de la purge porte sur l'ancienneté ; cet index la
-- couvre. Les durées restent à valider juridiquement (docs/privacy-rgpd.md,
-- avertissement final) et la purge s'exécute avec le compte de migration : la
-- requête est dans supabase/README.md.
--
-- Point de vigilance, à ne pas se cacher : purger une clé rend la commande
-- correspondante REJOUABLE. La fenêtre de rétention doit donc dépasser
-- largement celle du mode dégradé de docs/offline-mode.md, où une action peut
-- rester en file locale sur un téléphone hors réseau.
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at
  ON public.idempotency_keys (created_at);

COMMENT ON INDEX public.idx_idempotency_keys_created_at IS
  'Sélection de la purge par ancienneté. Purger une clé rend sa commande rejouable.';

-- --- Droits ------------------------------------------------------------------
-- `SELECT` pour relire une réservation existante, `INSERT` pour la poser,
-- `UPDATE` pour y inscrire le résultat. Pas de `DELETE` : effacer une clé
-- rouvrirait la porte à un rejeu, ce qui donnerait à un compte applicatif
-- compromis le moyen de faire produire deux fois le même effet à une commande
-- interceptée. La purge est une tâche d'exploitation, au même régime que celle
-- d'`outbox`.
GRANT SELECT, INSERT, UPDATE ON public.idempotency_keys TO fire_support_app;
REVOKE DELETE, TRUNCATE ON public.idempotency_keys FROM fire_support_app;

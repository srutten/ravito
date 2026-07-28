-- =============================================================================
-- 0007 — Table témoin : idempotence et anti-double affectation
-- Lot 0 · socle transverse
--
-- Objet   : prouver, avant que `missions` et `mission_events` n'existent, que
--           les deux garanties les plus critiques du produit sont réalisables
--           au niveau de la base :
--             1. l'unicité de `client_event_id`, qui rend une commande
--                rejouée sans effet (CLAUDE.md, idempotence) ;
--             2. l'index unique partiel qui interdit qu'une ressource porte
--                deux missions non terminales (docs/state-machines.md, règle
--                critique ; docs/database-design.md, contrainte
--                anti-double affectation).
--           Ces deux garanties ne peuvent pas être vérifiées applicativement
--           sans fenêtre de concurrence : deux transactions simultanées liront
--           toutes deux « aucune mission en cours » avant que l'une écrive.
--           Seule une contrainte d'unicité tranche, et elle doit être prouvée
--           tôt, pas découverte au lot 5.
--
-- ###########################################################################
-- # TABLE TÉMOIN PROVISOIRE — NE PAS UTILISER DEPUIS LE CODE APPLICATIF     #
-- #                                                                          #
-- # `idempotency_witness` n'est pas une table de production. Elle n'existe   #
-- # que pour porter les tests d'intégration de concurrence du lot 0.         #
-- # Elle est supprimée par la migration du LOT 5 (affectation), celle-là     #
-- # même qui crée `missions` et `mission_events` et qui reprend à son compte #
-- # les deux index démontrés ici. Aucun `GRANT` n'est accordé au compte      #
-- # applicatif : l'application ne doit jamais pouvoir l'atteindre.           #
-- ###########################################################################
--
-- Retour  : supabase/migrations/0007_idempotency-witness.down.sql
--
-- ---------------------------------------------------------------------------
-- CONTRADICTION DOCUMENTAIRE OUVERTE — À ARBITRER AVANT LE LOT 5
-- ---------------------------------------------------------------------------
-- docs/domain-model.md écrit : « clientEventId unique par acteur ou mission ».
-- docs/database-design.md écrit : « index unique sur client_event_id », donc
-- une portée globale.
-- Les deux ne peuvent pas être vrais en même temps : une portée par acteur
-- accepte que deux acteurs différents présentent le même identifiant, une
-- portée globale la refuse.
--
-- Ce qui est fait ici, et pourquoi : la portée GLOBALE est implémentée, parce
-- qu'elle est la plus stricte. Le sens de l'évolution n'est pas symétrique.
--   - Passer de global à par acteur est un RELÂCHEMENT : la nouvelle
--     contrainte est satisfaite par toutes les lignes déjà écrites, la
--     migration ne peut pas échouer sur les données existantes.
--   - Passer de par acteur à global est un DURCISSEMENT : si deux acteurs ont
--     déjà réutilisé le même identifiant, la création de l'index unique échoue
--     et il faut arbitrer, en production, quelles lignes historiques modifier.
-- Commencer strict laisse donc les deux portes ouvertes ; commencer permissif
-- en ferme une.
--
-- Coût réel d'un passage ultérieur à une portée par acteur :
--   - schéma : ajouter `actor_user_id` à l'index, en `CREATE UNIQUE INDEX
--     CONCURRENTLY` puis `DROP INDEX CONCURRENTLY` sur l'ancien, sans
--     verrouiller la table. Aucune reprise de données. Coût faible ;
--   - code : la détection de rejeu devient une recherche sur le couple
--     (acteur, identifiant). Un acteur système ou une action non authentifiée
--     n'ayant pas d'`actor_user_id`, il faut soit une valeur sentinelle, soit
--     un index partiel supplémentaire pour les lignes sans acteur, sinon
--     PostgreSQL considère deux NULL comme distincts et l'unicité disparaît
--     exactement là où elle protégeait le plus ;
--   - sécurité : la protection contre un rejeu par un acteur DIFFÉRENT est
--     perdue. C'est le cas concret d'un coordinateur qui rejoue la requête
--     d'un contributeur captée sur le réseau ; avec la portée globale, le
--     rejeu est absorbé, avec la portée par acteur il produit un second effet.
--
-- Point que l'arbitrage devra trancher en plus, non signalé par les documents :
-- docs/api-contract.md attache un `clientEventId` à des mutations qui écrivent
-- dans des TABLES DIFFÉRENTES — soumission de proposition, acceptation,
-- transition de mission, déclaration d'incident. Un index unique par table ne
-- rend donc pas l'identifiant globalement unique. Une portée réellement
-- globale suppose un registre central d'idempotence, une table unique où
-- chaque mutation critique réserve son identifiant avant d'agir. Ce témoin
-- démontre la faisabilité d'un tel registre, puisqu'il est justement une table
-- unique et transverse.
-- Trois options à départager avant le lot 5 :
--   (a) registre central : une table `idempotency_keys`, unicité vraiment
--       globale, une écriture supplémentaire par mutation critique ;
--   (b) index unique par table : simple, mais l'unicité n'est que locale et le
--       document de conception ne dit pas laquelle des deux il décrit ;
--   (c) portée par acteur : conforme à docs/domain-model.md, avec le coût de
--       sécurité décrit ci-dessus.
-- Aucune de ces options n'est retenue ici : le socle prouve le mécanisme, il
-- ne tranche pas un arbitrage qui appartient au lot 5. La décision devra être
-- inscrite dans docs/decision-log.md et l'un des deux documents corrigé.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.idempotency_witness (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identifiant fourni par le client pour rendre la commande rejouable sans
  -- effet supplémentaire (docs/api-contract.md).
  client_event_id uuid NOT NULL,

  -- Présent uniquement pour que les tests puissent démontrer la différence
  -- entre les deux portées de l'unicité, globale et par acteur.
  actor_user_id uuid NOT NULL,

  resource_id uuid NOT NULL,

  -- Utilise le type énuméré partagé de 0004 : le témoin prouve aussi que la
  -- liste d'états et l'index partiel sont cohérents entre eux.
  status public.mission_status NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.idempotency_witness IS
  'TABLE TÉMOIN PROVISOIRE du lot 0. Supprimée par la migration du lot 5, qui '
  'crée missions et mission_events. Aucun accès applicatif, aucun GRANT.';

-- Le témoin exerce aussi le déclencheur partagé de 0003 : si `updated_at`
-- cessait d'être maintenu, les tests d'intégration du socle le verraient.
CREATE OR REPLACE TRIGGER idempotency_witness_set_updated_at
  BEFORE UPDATE ON public.idempotency_witness
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- --- Preuve 1 : unicité de `client_event_id`, portée globale -----------------
-- Une seconde insertion du même identifiant lève `unique_violation` (23505).
-- Le code applicatif du lot 5 devra traiter cette erreur comme « déjà fait »,
-- et non comme un échec : c'est ainsi qu'un rejeu devient sans effet.
CREATE UNIQUE INDEX IF NOT EXISTS uq_idempotency_witness_client_event_id
  ON public.idempotency_witness (client_event_id);

COMMENT ON INDEX public.uq_idempotency_witness_client_event_id IS
  'Portée globale, la plus stricte. Contradiction documentaire ouverte : voir '
  'l''en-tête de 0007_idempotency-witness.sql et supabase/README.md.';

-- --- Preuve 2 : une seule mission non terminale par ressource ----------------
-- Transcription directe de l'exemple de docs/database-design.md et de la règle
-- critique de docs/state-machines.md. Les états terminaux sont COMPLETED et
-- CANCELLED ; INCIDENT n'en est pas un, une ressource en incident reste donc
-- engagée et ne peut pas recevoir une seconde mission.
-- Le prédicat est écrit sur le type énuméré : ajouter un état à
-- `mission_status` sans revoir cet index laisserait le nouvel état considéré
-- comme non terminal, ce qui est le défaut sûr.
CREATE UNIQUE INDEX IF NOT EXISTS uq_idempotency_witness_active_resource
  ON public.idempotency_witness (resource_id)
  WHERE status NOT IN ('COMPLETED', 'CANCELLED');

COMMENT ON INDEX public.uq_idempotency_witness_active_resource IS
  'Anti-double affectation : une seule ligne non terminale par ressource. '
  'Repris tel quel par missions au lot 5.';

-- --- Droits ------------------------------------------------------------------
-- Aucun. Le refus par défaut de 0002 s'applique : le compte applicatif ne peut
-- ni lire ni écrire cette table. Rendu explicite pour qu'aucune relecture ne
-- prenne l'absence de GRANT pour un oubli.
REVOKE ALL ON public.idempotency_witness FROM PUBLIC;

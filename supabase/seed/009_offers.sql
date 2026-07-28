-- =============================================================================
-- 009 — Propositions
--
-- @titre: Propositions
-- @lot: 4
-- @story: US-041, US-043
-- @tables: offers
-- @requiert-blocs: 002, 005, 008
-- @etat: inactif
--
-- Bloc PRÉPARÉ, INACTIF au lot 0 : la table `offers` n'existe pas encore.
--
-- Contenu : les quatre propositions de docs/seed-data.md. Leur répartition
-- n'est pas libre : ce sont elles qui rendent vrais les statuts des demandes du
-- bloc 008 et ceux des ressources du bloc 005.
--
--   O1 — SUBMITTED sur la demande A (citerne 8 m³).
--        C'est cette offre, et elle seule, qui justifie que la ressource soit
--        « proposée » et que la demande A reste PUBLISHED : une demande dont une
--        proposition serait acceptée ne serait plus publiée mais partiellement
--        couverte.
--   O2 — ACCEPTED sur la demande B (pelle 20 tonnes) → mission M1, en transit.
--   O3 — ACCEPTED sur la demande B (tracteur avec lame) → mission M2, arrivée.
--        Deux acceptations sur trois engins demandés : la demande B est bien
--        partiellement couverte, et non couverte.
--   O4 — ACCEPTED sur la demande C (groupe électrogène) → mission M3, terminée.
--
-- CE QUE LE JEU NE CONTIENT PAS, ET POURQUOI
--   Aucune offre REJECTED, WITHDRAWN ni EXPIRED. docs/seed-data.md en demande
--   quatre, et les quatre servent déjà à établir les statuts ci-dessus. Ajouter
--   des offres décoratives rendrait le jeu plus riche en apparence et plus
--   difficile à vérifier : on ne saurait plus quelles lignes portent une
--   contrainte. Les états restants sont du ressort des tests du lot 4 (US-042,
--   US-044), qui produisent leurs propres données.
--
-- DÉLAIS D'ARRIVÉE
--   `estimated_arrival_at` de l'offre encore ouverte est relatif à `now()` :
--   une arrivée annoncée dans le passé sur une offre non traitée serait
--   incohérente dès le lendemain du chargement.
-- =============================================================================

INSERT INTO public.offers (
  id,
  request_id,
  resource_id,
  submitted_by,
  estimated_arrival_at,
  operator_included,
  comment,
  status,
  expires_at,
  version
)
VALUES
  -- O1 — proposition en attente de décision.
  (
    '0000000a-0000-4000-8000-000000000001',
    '00000008-0000-4000-8000-000000000001',
    '00000005-0000-4000-8000-000000000002',
    '00000002-0000-4000-8000-000000000003',
    now() + interval '4 hours',
    true,
    'Disponible dans la journée, conducteur inclus.',
    'SUBMITTED',
    now() + interval '2 days',
    1
  ),
  -- O2 — acceptée, donne la mission en transit.
  (
    '0000000a-0000-4000-8000-000000000002',
    '00000008-0000-4000-8000-000000000002',
    '00000005-0000-4000-8000-000000000004',
    '00000002-0000-4000-8000-000000000003',
    '2026-07-20 11:00:00+00',
    true,
    'Transport de la pelle assuré par nos soins.',
    'ACCEPTED',
    '2026-07-20 10:00:00+00',
    2
  ),
  -- O3 — acceptée, donne la mission arrivée.
  (
    '0000000a-0000-4000-8000-000000000003',
    '00000008-0000-4000-8000-000000000002',
    '00000005-0000-4000-8000-000000000003',
    '00000002-0000-4000-8000-000000000003',
    '2026-07-20 09:30:00+00',
    true,
    'Tracteur équipé de la lame, prêt au départ.',
    'ACCEPTED',
    '2026-07-20 09:00:00+00',
    2
  ),
  -- O4 — acceptée, donne la mission terminée.
  (
    '0000000a-0000-4000-8000-000000000004',
    '00000008-0000-4000-8000-000000000003',
    '00000005-0000-4000-8000-000000000005',
    '00000002-0000-4000-8000-000000000002',
    '2026-07-19 14:00:00+00',
    false,
    'Groupe livré et raccordé par l''équipe technique communale.',
    'ACCEPTED',
    '2026-07-19 13:00:00+00',
    2
  )
ON CONFLICT (id) DO NOTHING;

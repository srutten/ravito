-- =============================================================================
-- 010 — Missions
--
-- @titre: Missions
-- @lot: 5
-- @story: US-050, US-052, US-053, US-054, US-055, US-056
-- @tables: missions
-- @requiert-blocs: 001, 002, 005, 007, 008, 009
-- @etat: inactif
--
-- Bloc PRÉPARÉ, INACTIF au lot 0 : la table `missions` n'existe pas encore.
--
-- Contenu : les trois missions de docs/seed-data.md, dans trois états
-- différents du parcours nominal de docs/state-machines.md.
--
--   M1 — IN_TRANSIT  : pelle 20 tonnes, conduite par David Conducteur.
--   M2 — ARRIVED     : tracteur avec lame, conduit par Claire Agricultrice.
--   M3 — COMPLETED   : groupe électrogène, mission terminée la veille.
--
-- RÈGLE CRITIQUE VÉRIFIÉE PAR CONSTRUCTION
--   « Une ressource ne peut posséder qu'une mission non terminale à la fois »
--   (docs/state-machines.md). Les trois missions portent trois ressources
--   distinctes, et la seule ressource qui pourrait en porter une seconde est
--   celle de M3, dont la mission est terminale. L'index unique partiel de
--   docs/database-design.md :
--
--     CREATE UNIQUE INDEX one_active_mission_per_resource
--     ON missions(resource_id) WHERE status NOT IN ('COMPLETED', 'CANCELLED');
--
--   accepte donc ce jeu tel quel. Si une modification future de ce fichier le
--   fait échouer avec une violation d'unicité, ce n'est pas l'index qu'il faut
--   assouplir : c'est le jeu de données qui est devenu faux.
--
-- CONTACT OPÉRATIONNEL
--   `contact_phone` utilise la plage 06 39 98 00 00 – 06 39 98 99 99, réservée à
--   la fiction par l'ARCEP. Ces numéros n'aboutissent chez aucun abonné, ce qui
--   est indispensable : docs/functional-specification.md prévoit un bouton
--   « appeler le contact opérationnel », et une démonstration ne doit jamais
--   pouvoir déclencher un appel vers une personne réelle.
--   Une règle de scan de secrets interdisant les numéros complets doit inscrire
--   le préfixe `063998` en liste d'exception.
--
--   docs/observability.md interdit le téléphone complet dans les journaux. La
--   colonne le contient, les journaux ne doivent pas : c'est une contrainte sur
--   le code du lot 5, que ce jeu permet précisément de mettre à l'épreuve.
--
-- CONSIGNES
--   `instructions` reste générique, sans axe tactique ni fréquence radio.
-- =============================================================================

INSERT INTO public.missions (
  id,
  request_id,
  offer_id,
  resource_id,
  coordinator_organization_id,
  contributor_user_id,
  meeting_point_id,
  status,
  contact_name,
  contact_phone,
  instructions,
  started_at,
  completed_at,
  version
)
VALUES
  -- M1 — en transit. Elle porte l'incident du bloc 012.
  (
    '0000000b-0000-4000-8000-000000000001',
    '00000008-0000-4000-8000-000000000002',
    '0000000a-0000-4000-8000-000000000002',
    '00000005-0000-4000-8000-000000000004',
    '00000001-0000-4000-8000-000000000001',
    '00000002-0000-4000-8000-000000000004',
    '00000007-0000-4000-8000-000000000002',
    'IN_TRANSIT',
    'Alice Coordinateur',
    '0639980001',
    'Se présenter au point Sud. Prévenir en cas de retard de plus de trente minutes.',
    '2026-07-20 10:30:00+00',
    NULL,
    4
  ),
  -- M2 — arrivée au point de rassemblement, remise non encore effectuée.
  (
    '0000000b-0000-4000-8000-000000000002',
    '00000008-0000-4000-8000-000000000002',
    '0000000a-0000-4000-8000-000000000003',
    '00000005-0000-4000-8000-000000000003',
    '00000001-0000-4000-8000-000000000001',
    '00000002-0000-4000-8000-000000000003',
    '00000007-0000-4000-8000-000000000002',
    'ARRIVED',
    'Alice Coordinateur',
    '0639980001',
    'Se présenter au point Sud. Attendre la consigne avant tout déplacement.',
    '2026-07-20 09:15:00+00',
    NULL,
    5
  ),
  -- M3 — terminée. Sa ressource est redevenue disponible.
  (
    '0000000b-0000-4000-8000-000000000003',
    '00000008-0000-4000-8000-000000000003',
    '0000000a-0000-4000-8000-000000000004',
    '00000005-0000-4000-8000-000000000005',
    '00000001-0000-4000-8000-000000000001',
    '00000002-0000-4000-8000-000000000002',
    '00000007-0000-4000-8000-000000000001',
    'COMPLETED',
    'Alice Coordinateur',
    '0639980001',
    'Livraison au point Nord, raccordement par l''équipe technique.',
    '2026-07-19 13:30:00+00',
    '2026-07-19 18:00:00+00',
    8
  )
ON CONFLICT (id) DO NOTHING;

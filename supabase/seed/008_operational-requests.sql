-- =============================================================================
-- 008 — Demandes opérationnelles et exigences
--
-- @titre: Demandes opérationnelles et exigences
-- @lot: 3
-- @story: US-030, US-031, US-033
-- @tables: operational_requests, request_requirements
-- @requiert-blocs: 001, 002, 004, 007
-- @etat: inactif
--
-- Bloc PRÉPARÉ, INACTIF au lot 0 : ni `operational_requests` ni
-- `request_requirements` n'existent encore. Les deux tables sont dans le même
-- bloc parce qu'une demande sans exigence n'est pas publiable
-- (docs/permissions.md, « Demande ») : les insérer séparément produirait un
-- état intermédiaire invalide entre deux blocs.
--
-- Contenu : les trois demandes A, B et C de docs/seed-data.md, avec leurs
-- statuts exacts.
--
--   A — Eau, priorité urgente, deux citernes, point Nord, PUBLISHED.
--       PUBLISHED signifie qu'aucune proposition n'a encore été acceptée. Le
--       jeu respecte cette contrainte : la seule offre portée sur A (bloc 009)
--       est à l'état SUBMITTED.
--   B — Engin de terrassement, priorité haute, PARTIALLY_COVERED.
--       Trois engins demandés, deux affectés : c'est ce qui rend le statut vrai
--       plutôt que déclaré. Les deux missions non terminales du jeu en
--       découlent.
--   C — Groupe électrogène, CLOSED, avec sa mission terminée.
--
-- ÉCHÉANCES
--   `needed_before` et `expires_at` des demandes encore ouvertes sont relatifs à
--   `now()` : une demande urgente dont le délai est dépassé n'est plus une
--   demande urgente, et la démonstration perdrait son sens en quelques jours.
--   La demande fermée porte des dates fixes, passées, qui doivent le rester.
--
-- INFORMATIONS VOLONTAIREMENT ABSENTES
--   Aucun titre ni aucune description ne nomme un lieu réel, une position de
--   front, un axe tactique ou une fréquence radio : docs/functional-specification.md
--   les interdit au public, et un jeu de démonstration qui en contiendrait
--   apprendrait aux utilisateurs à en saisir.
-- =============================================================================

INSERT INTO public.operational_requests (
  id,
  organization_id,
  created_by,
  title,
  description,
  priority,
  status,
  meeting_point_id,
  needed_before,
  expires_at,
  territory_code,
  version
)
VALUES
  -- Demande A — publiée, aucune proposition acceptée.
  (
    '00000008-0000-4000-8000-000000000001',
    '00000001-0000-4000-8000-000000000001',
    '00000002-0000-4000-8000-000000000001',
    'Ravitaillement en eau du secteur Nord',
    'Besoin de deux citernes pour alimenter le dispositif du secteur Nord. Opérateur requis.',
    'URGENT',
    'PUBLISHED',
    '00000007-0000-4000-8000-000000000001',
    now() + interval '12 hours',
    now() + interval '3 days',
    'ZZ-DEMO-01',
    1
  ),
  -- Demande B — partiellement couverte : deux engins affectés sur trois.
  (
    '00000008-0000-4000-8000-000000000002',
    '00000001-0000-4000-8000-000000000001',
    '00000002-0000-4000-8000-000000000001',
    'Ouverture de pistes du secteur Est',
    'Trois engins de terrassement pour l''ouverture et l''entretien de pistes d''accès.',
    'HIGH',
    'PARTIALLY_COVERED',
    '00000007-0000-4000-8000-000000000002',
    now() + interval '2 days',
    now() + interval '5 days',
    'ZZ-DEMO-01',
    3
  ),
  -- Demande C — fermée, sa mission est terminée.
  (
    '00000008-0000-4000-8000-000000000003',
    '00000001-0000-4000-8000-000000000001',
    '00000002-0000-4000-8000-000000000001',
    'Alimentation électrique du poste de commandement',
    'Groupe électrogène pour l''alimentation du poste de commandement de secteur.',
    'NORMAL',
    'CLOSED',
    '00000007-0000-4000-8000-000000000001',
    '2026-07-19 12:00:00+00',
    '2026-07-19 18:00:00+00',
    'ZZ-DEMO-01',
    4
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.request_requirements (
  id,
  request_id,
  category_id,
  quantity,
  minimum_capacity,
  capacity_unit,
  requires_operator,
  constraints
)
VALUES
  -- A — deux citernes d'au moins 6 m³, opérateur inclus.
  (
    '00000009-0000-4000-8000-000000000001',
    '00000008-0000-4000-8000-000000000001',
    '00000004-0000-4000-8000-000000000001',
    2,
    6,
    'm3',
    true,
    '{"acces":"piste carrossable","remplissage":"raccord pompier"}'::jsonb
  ),
  -- B — trois engins de terrassement, sans seuil de capacité : une lame et une
  -- pelle ne se comparent pas sur la même grandeur.
  (
    '00000009-0000-4000-8000-000000000002',
    '00000008-0000-4000-8000-000000000002',
    '00000004-0000-4000-8000-000000000002',
    3,
    NULL,
    NULL,
    true,
    '{"acces":"chemin non revetu"}'::jsonb
  ),
  -- C — un groupe électrogène d'au moins 30 kVA.
  (
    '00000009-0000-4000-8000-000000000003',
    '00000008-0000-4000-8000-000000000003',
    '00000004-0000-4000-8000-000000000003',
    1,
    30,
    'kVA',
    false,
    '{"raccordement":"prise normalisee","autonomie_heures":8}'::jsonb
  )
ON CONFLICT (id) DO NOTHING;

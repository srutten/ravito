-- =============================================================================
-- 005 — Ressources
--
-- @titre: Ressources
-- @lot: 2
-- @story: US-020, US-021
-- @tables: resources
-- @requiert-blocs: 001, 002, 004
-- @etat: inactif
--
-- Bloc PRÉPARÉ, INACTIF au lot 0 : la table `resources` n'existe pas encore.
--
-- Contenu : les huit ressources de docs/seed-data.md.
--
-- LOCALISATION — PRÉCISION VOLONTAIREMENT FAIBLE
--   Les coordonnées sont données à UNE décimale, soit environ 11 km. À cette
--   précision une valeur désigne une zone, jamais un lieu, encore moins un
--   domicile ou une exploitation identifiable. C'est cohérent avec
--   docs/database-design.md (« index géospatial sur les positions
--   approximatives ») et avec docs/security.md (« masquage des coordonnées »),
--   et cela évite qu'un scan de secrets signale une position à pleine précision
--   dans le dépôt. Aucune de ces zones ne correspond à une installation réelle.
--
--   `precise_location_encrypted` reste NULL. Le jeu de démonstration n'a aucun
--   besoin d'une position exacte, et docs/privacy-rgpd.md limite la
--   conservation des positions précises à « tant que nécessaire » : la valeur
--   nécessaire pour une démonstration est aucune. Le chiffrement applicatif de
--   cette colonne relève du lot 2 ; ce fichier ne doit jamais servir à
--   éprouver un mécanisme de chiffrement avec une position vraie.
--
-- ÉCARTS ASSUMÉS PAR RAPPORT À docs/seed-data.md — 2 sur 8
--   Le document attribue un statut à chaque ressource ET demande trois missions
--   dans des états différents. Les deux listes ne sont pas simultanément
--   satisfiables : une ressource engagée dans une mission non terminale ne peut
--   pas être « disponible ». docs/state-machines.md l'emporte (CLAUDE.md, ordre
--   de la source de vérité : machines à états avant critères d'acceptation).
--
--   1. « Tracteur avec lame — disponible » devient `ON_SITE` : il porte la
--      mission arrivée (M2). Une des trois missions du jeu devait bien engager
--      une ressource que le document déclare disponible.
--   2. « Pompe haut débit — réservée » reste `RESERVED` sans mission associée.
--      `RESERVED` correspond normalement à une mission validée avant départ, et
--      le jeu n'en compte que trois, toutes attribuées. La ressource est ici
--      réservée par son propriétaire, ce qui reste un usage légitime de l'état.
--
--   Les six autres statuts sont conformes au document.
--
-- POINT OUVERT SIGNALÉ, NON TRANCHÉ (lot 2, US-021)
--   docs/domain-model.md donne à `Resource` deux colonnes de statut, `status` et
--   `availabilityStatus`, pour une seule liste d'états dans
--   docs/state-machines.md. Le jeu retient la lecture suivante, à confirmer :
--   `status` est l'état opérationnel constaté, `availability_status` la
--   disponibilité déclarée par le propriétaire. Les deux utilisent le type
--   `public.resource_status` créé par `0004_shared-enums.sql`.
-- =============================================================================

INSERT INTO public.resources (
  id,
  owner_organization_id,
  owner_user_id,
  category_id,
  name,
  description,
  capacity,
  capacity_unit,
  fuel_type,
  requires_operator,
  status,
  availability_status,
  approximate_location,
  precise_location_encrypted,
  mobilization_radius_km,
  version
)
VALUES
  -- 1. Citerne 12 m³ — disponible (conforme au document).
  (
    '00000005-0000-4000-8000-000000000001',
    '00000001-0000-4000-8000-000000000003',
    '00000002-0000-4000-8000-000000000003',
    '00000004-0000-4000-8000-000000000001',
    'Citerne 12 m³',
    'Citerne tractée pour ravitaillement en eau, remplissage par raccord pompier.',
    12,
    'm3',
    'NONE',
    true,
    'AVAILABLE',
    'AVAILABLE',
    ST_SetSRID(ST_MakePoint(6.1, 43.5), 4326)::geography,
    NULL,
    40,
    1
  ),
  -- 2. Citerne 8 m³ — proposée (conforme) : elle porte l'offre O1, soumise et
  --    non encore traitée, sur la demande A.
  (
    '00000005-0000-4000-8000-000000000002',
    '00000001-0000-4000-8000-000000000003',
    '00000002-0000-4000-8000-000000000003',
    '00000004-0000-4000-8000-000000000001',
    'Citerne 8 m³',
    'Citerne tractée, second matériel de ravitaillement de l''exploitation.',
    8,
    'm3',
    'NONE',
    true,
    'PROPOSED',
    'AVAILABLE',
    ST_SetSRID(ST_MakePoint(6.1, 43.5), 4326)::geography,
    NULL,
    40,
    1
  ),
  -- 3. Tracteur avec lame — ÉCART 1 : `ON_SITE`, il porte la mission M2.
  (
    '00000005-0000-4000-8000-000000000003',
    '00000001-0000-4000-8000-000000000003',
    '00000002-0000-4000-8000-000000000003',
    '00000004-0000-4000-8000-000000000002',
    'Tracteur avec lame',
    'Tracteur équipé d''une lame frontale, ouverture et entretien de pistes.',
    NULL,
    NULL,
    'DIESEL',
    true,
    'ON_SITE',
    'UNAVAILABLE',
    ST_SetSRID(ST_MakePoint(6.2, 43.5), 4326)::geography,
    NULL,
    60,
    3
  ),
  -- 4. Pelle 20 tonnes — document expiré (bloc 006). Elle porte la mission M1,
  --    en transit : le document a expiré APRÈS l'affectation, ce qui est le cas
  --    opérationnel intéressant, et non un contournement de la règle
  --    « documents expirés non valides » de docs/domain-model.md.
  (
    '00000005-0000-4000-8000-000000000004',
    '00000001-0000-4000-8000-000000000003',
    '00000002-0000-4000-8000-000000000003',
    '00000004-0000-4000-8000-000000000002',
    'Pelle 20 tonnes',
    'Pelle sur chenilles, terrassement et création de coupures.',
    20,
    't',
    'DIESEL',
    true,
    'IN_TRANSIT',
    'UNAVAILABLE',
    ST_SetSRID(ST_MakePoint(6.2, 43.5), 4326)::geography,
    NULL,
    80,
    4
  ),
  -- 5. Groupe électrogène 40 kVA — disponible (conforme) : sa mission M3 est
  --    terminée, la ressource est donc revenue à la disponibilité.
  (
    '00000005-0000-4000-8000-000000000005',
    '00000001-0000-4000-8000-000000000002',
    '00000002-0000-4000-8000-000000000002',
    '00000004-0000-4000-8000-000000000003',
    'Groupe électrogène 40 kVA',
    'Groupe électrogène mobile pour alimentation d''un poste de commandement.',
    40,
    'kVA',
    'DIESEL',
    false,
    'AVAILABLE',
    'AVAILABLE',
    ST_SetSRID(ST_MakePoint(6.0, 43.4), 4326)::geography,
    NULL,
    50,
    5
  ),
  -- 6. Camion plateau — maintenance (conforme). Seule ressource de
  --    l'organisation encore en attente de validation : elle n'est engagée
  --    nulle part, ce qui illustre la condition de validation.
  (
    '00000005-0000-4000-8000-000000000006',
    '00000001-0000-4000-8000-000000000004',
    '00000002-0000-4000-8000-000000000004',
    '00000004-0000-4000-8000-000000000005',
    'Camion plateau',
    'Camion plateau pour transport d''engins, immobilisé pour révision.',
    19,
    't',
    'DIESEL',
    true,
    'MAINTENANCE',
    'UNAVAILABLE',
    ST_SetSRID(ST_MakePoint(5.9, 43.4), 4326)::geography,
    NULL,
    100,
    1
  ),
  -- 7. Pompe haut débit — ÉCART 2 : `RESERVED` sans mission, voir l'en-tête.
  (
    '00000005-0000-4000-8000-000000000007',
    '00000001-0000-4000-8000-000000000002',
    '00000002-0000-4000-8000-000000000002',
    '00000004-0000-4000-8000-000000000004',
    'Pompe haut débit',
    'Motopompe haut débit avec tuyaux, réservée par la commune.',
    120,
    'm3/h',
    'PETROL',
    true,
    'RESERVED',
    'UNAVAILABLE',
    ST_SetSRID(ST_MakePoint(6.0, 43.4), 4326)::geography,
    NULL,
    30,
    2
  ),
  -- 8. Base logistique temporaire — disponible (conforme).
  (
    '00000005-0000-4000-8000-000000000008',
    '00000001-0000-4000-8000-000000000002',
    '00000002-0000-4000-8000-000000000002',
    '00000004-0000-4000-8000-000000000006',
    'Base logistique temporaire',
    'Structure démontable, vingt places assises, sanitaires et point d''eau.',
    20,
    'place',
    'NONE',
    false,
    'AVAILABLE',
    'AVAILABLE',
    ST_SetSRID(ST_MakePoint(6.0, 43.3), 4326)::geography,
    NULL,
    25,
    1
  )
ON CONFLICT (id) DO NOTHING;

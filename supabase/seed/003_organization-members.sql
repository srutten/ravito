-- =============================================================================
-- 003 — Appartenances aux organisations
--
-- @titre: Appartenances aux organisations
-- @lot: 1
-- @story: US-014
-- @tables: organization_members
-- @requiert-blocs: 001, 002
-- @etat: inactif
--
-- Bloc PRÉPARÉ, INACTIF au lot 0 : la table `organization_members` n'existe pas
-- encore.
--
-- Contenu : le rattachement des six personnages, avec le rôle qui pilote toute
-- la matrice de docs/permissions.md. Les cinq rôles du document sont
-- représentés : sans cela, le jeu ne permettrait pas de démontrer un refus
-- d'autorisation, seulement des parcours qui réussissent.
--
-- SEPT APPARTENANCES POUR SIX UTILISATEURS, VOLONTAIREMENT
--   David Conducteur appartient à deux organisations : il administre
--   « Travaux Publics Horizon », encore en attente de validation, et conduit
--   pour « Exploitation agricole Martin », validée. C'est le cas que la couche
--   d'autorisation doit traiter correctement — docs/permissions.md exige que
--   l'appartenance soit vérifiée « pour chaque action », donc action par action
--   et organisation par organisation, et non une fois pour l'utilisateur.
--   Un même compte y est simultanément bloqué d'un côté et autorisé de l'autre.
--
-- POINT OUVERT SIGNALÉ, NON TRANCHÉ (lot 1, US-014)
--   docs/permissions.md liste `PLATFORM_ADMIN` parmi les rôles mais ne dit pas
--   s'il est porté par l'appartenance ou par le profil. Un rôle dont la portée
--   est la plateforme, rattaché à une organisation, est contradictoire. Le jeu
--   le pose ici faute de colonne où le poser ailleurs, et le signale. Si le
--   lot 1 le porte sur `user_profiles`, cette ligne migre vers le bloc 002.
-- =============================================================================

INSERT INTO public.organization_members (
  id,
  organization_id,
  user_id,
  role,
  status,
  valid_from,
  valid_until
)
VALUES
  -- Coordinatrice du service incendie : autrice des trois demandes du jeu.
  (
    '00000003-0000-4000-8000-000000000001',
    '00000001-0000-4000-8000-000000000001',
    '00000002-0000-4000-8000-000000000001',
    'COORDINATOR',
    'ACTIVE',
    '2026-07-18 08:00:00+00',
    NULL
  ),
  -- Coordinateur de la commune : propose le groupe électrogène communal.
  (
    '00000003-0000-4000-8000-000000000002',
    '00000001-0000-4000-8000-000000000002',
    '00000002-0000-4000-8000-000000000002',
    'COORDINATOR',
    'ACTIVE',
    '2026-07-18 08:00:00+00',
    NULL
  ),
  -- Contributrice : propriétaire des citernes, du tracteur et de la pelle.
  (
    '00000003-0000-4000-8000-000000000003',
    '00000001-0000-4000-8000-000000000003',
    '00000002-0000-4000-8000-000000000003',
    'CONTRIBUTOR',
    'ACTIVE',
    '2026-07-18 08:00:00+00',
    NULL
  ),
  -- Administrateur d'une organisation encore en attente : ses actions sensibles
  -- doivent être refusées tant que la validation n'a pas eu lieu.
  (
    '00000003-0000-4000-8000-000000000004',
    '00000001-0000-4000-8000-000000000004',
    '00000002-0000-4000-8000-000000000004',
    'ORG_ADMIN',
    'ACTIVE',
    '2026-07-18 08:00:00+00',
    NULL
  ),
  -- Le même compte, contributeur d'une organisation validée : il conduit la
  -- mission en transit du bloc 010. Voir la note en tête de fichier.
  (
    '00000003-0000-4000-8000-000000000005',
    '00000001-0000-4000-8000-000000000003',
    '00000002-0000-4000-8000-000000000004',
    'CONTRIBUTOR',
    'ACTIVE',
    '2026-07-19 08:00:00+00',
    NULL
  ),
  -- Administratrice plateforme : voir le point ouvert en tête de fichier.
  (
    '00000003-0000-4000-8000-000000000006',
    '00000001-0000-4000-8000-000000000001',
    '00000002-0000-4000-8000-000000000005',
    'PLATFORM_ADMIN',
    'ACTIVE',
    '2026-07-18 08:00:00+00',
    NULL
  ),
  -- Observateur : lecture limitée, aucune mutation possible.
  (
    '00000003-0000-4000-8000-000000000007',
    '00000001-0000-4000-8000-000000000002',
    '00000002-0000-4000-8000-000000000006',
    'OBSERVER',
    'ACTIVE',
    '2026-07-18 08:00:00+00',
    NULL
  )
ON CONFLICT (id) DO NOTHING;

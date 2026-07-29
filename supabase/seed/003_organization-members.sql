-- =============================================================================
-- 003 — Appartenances aux organisations
--
-- @titre: Appartenances aux organisations
-- @lot: 1
-- @story: US-014
-- @tables: organization_members
-- @requiert-blocs: 001, 002
-- @etat: actif
--
-- Bloc ACTIF depuis le lot 1 : la migration 0016 a créé `organization_members`.
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
--   La clé primaire composite de 0016 autorise cette double appartenance et
--   interdit en revanche deux rôles dans la MÊME organisation.
--
-- ---------------------------------------------------------------------------
-- ALIGNÉ SUR LA MIGRATION 0016 AU MOMENT DE L'ACTIVATION
-- ---------------------------------------------------------------------------
-- Ce bloc a été écrit au lot 0, avant la table. Deux écarts ont dû être
-- corrigés, tous deux structurels :
--
--   1. La colonne `id` a disparu. 0016 donne à la table une CLÉ PRIMAIRE
--      COMPOSITE `(organization_id, user_id)` et aucune colonne de
--      substitution : docs/domain-model.md n'en donne pas à
--      `OrganizationMember`, et une adhésion est identifiée par le couple
--      qu'elle relie. Les sept identifiants `00000003-…` qui figuraient ici
--      n'ont donc plus de colonne où aller.
--   2. `ON CONFLICT` porte désormais sur `(organization_id, user_id)`, la
--      vraie clé. Écrit sur `(id)`, il n'aurait plus désigné aucune contrainte
--      et la seconde exécution du seed aurait échoué au lieu d'être neutre.
--
-- `valid_from` est daté dans le passé, et `valid_until` est nul : c'est ce qui
-- rend ces adhésions valides au sens de 0016 — `status = 'ACTIVE'`,
-- `valid_from <= now()`, `valid_until` nul ou postérieur à maintenant. Une
-- date de début future produirait des adhésions inertes, et le jeu semblerait
-- cassé sans raison visible.
--
-- POINT OUVERT SIGNALÉ, NON TRANCHÉ (lot 1, US-014)
--   docs/permissions.md liste `PLATFORM_ADMIN` parmi les rôles mais ne dit pas
--   s'il est porté par l'appartenance ou par le profil. Un rôle dont la portée
--   est la plateforme, rattaché à une organisation, est contradictoire. 0014 a
--   retenu les cinq rôles du document, sans en écarter un seul, et le point
--   reste donc ouvert : le jeu le pose ici faute de colonne où le poser
--   ailleurs, et le signale. Si un lot ultérieur le porte sur `user_profiles`,
--   cette ligne migre vers le bloc 002.
-- =============================================================================

INSERT INTO public.organization_members (
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
    '00000001-0000-4000-8000-000000000001',
    '00000002-0000-4000-8000-000000000001',
    'COORDINATOR',
    'ACTIVE',
    '2026-07-18 08:00:00+00',
    NULL
  ),
  -- Coordinateur de la commune : propose le groupe électrogène communal.
  (
    '00000001-0000-4000-8000-000000000002',
    '00000002-0000-4000-8000-000000000002',
    'COORDINATOR',
    'ACTIVE',
    '2026-07-18 08:00:00+00',
    NULL
  ),
  -- Contributrice : propriétaire des citernes, du tracteur et de la pelle.
  (
    '00000001-0000-4000-8000-000000000003',
    '00000002-0000-4000-8000-000000000003',
    'CONTRIBUTOR',
    'ACTIVE',
    '2026-07-18 08:00:00+00',
    NULL
  ),
  -- Administrateur d'une organisation encore en attente de vérification : ses
  -- actions sensibles doivent être refusées par ORGANIZATION_NOT_VERIFIED tant
  -- que la validation n'a pas eu lieu. L'adhésion, elle, est bien active : le
  -- refus vient de l'organisation, pas de l'appartenance.
  (
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
    '00000001-0000-4000-8000-000000000003',
    '00000002-0000-4000-8000-000000000004',
    'CONTRIBUTOR',
    'ACTIVE',
    '2026-07-19 08:00:00+00',
    NULL
  ),
  -- Administratrice plateforme : voir le point ouvert en tête de fichier.
  (
    '00000001-0000-4000-8000-000000000001',
    '00000002-0000-4000-8000-000000000005',
    'PLATFORM_ADMIN',
    'ACTIVE',
    '2026-07-18 08:00:00+00',
    NULL
  ),
  -- Observateur : lecture limitée, aucune mutation possible.
  (
    '00000001-0000-4000-8000-000000000002',
    '00000002-0000-4000-8000-000000000006',
    'OBSERVER',
    'ACTIVE',
    '2026-07-18 08:00:00+00',
    NULL
  )
ON CONFLICT (organization_id, user_id) DO NOTHING;

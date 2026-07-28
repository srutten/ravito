-- =============================================================================
-- 001 — Organisations
--
-- @titre: Organisations
-- @lot: 1
-- @story: US-012, US-013
-- @tables: organizations
-- @requiert-blocs: aucun
-- @etat: inactif
--
-- Bloc PRÉPARÉ, INACTIF au lot 0 : la table `organizations` n'existe pas
-- encore. `npm run db:seed` détecte son absence et ignore ce fichier en
-- l'annonçant. Il s'exécutera de lui-même, sans modification de `seed.ts`, dès
-- que la migration du lot 1 aura créé la table.
--
-- Contenu : les quatre organisations de docs/seed-data.md, dont une en attente
-- de validation, qui sert à démontrer le refus par défaut de docs/permissions.md
-- (« Permissions sensibles conditionnées par la validation du compte »).
--
-- Données entièrement fictives. Aucune structure réelle, aucun numéro
-- d'immatriculation réel : `registration_number` porte un préfixe `FICTIF-` qui
-- rend toute confusion impossible et qui ne peut correspondre à aucun SIRET
-- (14 chiffres). `territory_code` utilise le préfixe `ZZ`, non attribué.
--
-- À RÉCONCILIER AU LOT 1 (US-012) : le vocabulaire de `type`,
-- `verification_status` et `status` n'est fixé ni par docs/domain-model.md ni
-- par les types énumérés du lot 0 (`0004_shared-enums.sql` ne couvre que les
-- quatre machines à états). Les valeurs ci-dessous sont des hypothèses lisibles.
-- La migration qui crée la table fait foi : ce fichier doit être aligné sur elle
-- au moment où le bloc s'active. En cas d'écart, `npm run db:seed` nomme le bloc
-- et la colonne en cause plutôt que d'échouer en bloc.
-- =============================================================================

INSERT INTO public.organizations (
  id,
  name,
  type,
  registration_number,
  territory_code,
  verification_status,
  status
)
VALUES
  -- Organisation coordinatrice : elle publie les trois demandes du jeu.
  (
    '00000001-0000-4000-8000-000000000001',
    'Service incendie territorial',
    'FIRE_SERVICE',
    'FICTIF-ORG-0001',
    'ZZ-DEMO-01',
    'VERIFIED',
    'ACTIVE'
  ),
  (
    '00000001-0000-4000-8000-000000000002',
    'Commune de démonstration',
    'MUNICIPALITY',
    'FICTIF-ORG-0002',
    'ZZ-DEMO-01',
    'VERIFIED',
    'ACTIVE'
  ),
  (
    '00000001-0000-4000-8000-000000000003',
    'Exploitation agricole Martin',
    'FARM',
    'FICTIF-ORG-0003',
    'ZZ-DEMO-02',
    'VERIFIED',
    'ACTIVE'
  ),
  -- En attente : aucune de ses ressources ne porte de mission dans le jeu, ce
  -- qui illustre la condition de validation sans avoir besoin d'un test.
  (
    '00000001-0000-4000-8000-000000000004',
    'Travaux Publics Horizon',
    'COMPANY',
    'FICTIF-ORG-0004',
    'ZZ-DEMO-02',
    'PENDING',
    'PENDING'
  )
ON CONFLICT (id) DO NOTHING;

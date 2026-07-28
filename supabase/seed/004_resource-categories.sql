-- =============================================================================
-- 004 — Catégories de ressources
--
-- @titre: Catégories de ressources
-- @lot: 2
-- @story: US-020
-- @tables: resource_categories
-- @requiert-blocs: aucun
-- @etat: inactif
--
-- Bloc PRÉPARÉ, INACTIF au lot 0 : la table `resource_categories` n'existe pas
-- encore.
--
-- Contenu : le référentiel minimal permettant de qualifier les huit ressources
-- du bloc 005 et les exigences des trois demandes du bloc 008. docs/seed-data.md
-- ne nomme pas les catégories ; elles sont déduites des libellés de ressources
-- et des besoins exprimés par les demandes A, B et C.
--
-- Nature des données : référentiel technique, pas des données personnelles.
-- Il figure tout de même dans le jeu de démonstration parce que sans lui, ni les
-- ressources ni les exigences des demandes ne peuvent être insérées, et que le
-- moteur de rapprochement de docs/matching-engine.md travaille sur la catégorie.
--
-- À RÉCONCILIER AU LOT 2 (US-020) : la table de catégories peut porter une
-- hiérarchie, une liste de documents obligatoires par catégorie et une unité de
-- capacité par défaut. Les colonnes ci-dessous sont le minimum vital ; ce fichier
-- doit être complété au moment où la table est créée.
-- =============================================================================

INSERT INTO public.resource_categories (id, code, label, capacity_unit)
VALUES
  ('00000004-0000-4000-8000-000000000001', 'WATER_TANK', 'Citerne à eau', 'm3'),
  ('00000004-0000-4000-8000-000000000002', 'EARTHMOVING', 'Engin de terrassement', 't'),
  ('00000004-0000-4000-8000-000000000003', 'POWER_GENERATOR', 'Groupe électrogène', 'kVA'),
  ('00000004-0000-4000-8000-000000000004', 'PUMP', 'Pompe haut débit', 'm3/h'),
  ('00000004-0000-4000-8000-000000000005', 'FLATBED_TRUCK', 'Camion plateau', 't'),
  ('00000004-0000-4000-8000-000000000006', 'LOGISTICS_BASE', 'Base logistique temporaire', 'place')
ON CONFLICT (id) DO NOTHING;

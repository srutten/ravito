-- =============================================================================
-- 001 — Organisations
--
-- @titre: Organisations
-- @lot: 1
-- @story: US-012, US-013
-- @tables: organizations
-- @requiert-blocs: aucun
-- @etat: actif
--
-- Bloc ACTIF depuis le lot 1 : la migration 0015 a créé `organizations`.
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
-- ---------------------------------------------------------------------------
-- VOCABULAIRE RÉCONCILIÉ AU LOT 1 (US-012), MIGRATIONS 0014 ET 0015
-- ---------------------------------------------------------------------------
-- Ce bloc a été écrit au lot 0, AVANT que le vocabulaire n'existe, avec des
-- valeurs qui étaient des hypothèses lisibles. La migration 0014 l'a arrêté, et
-- ce fichier est aligné sur elle. Quatre écarts ont dû être corrigés ; ils sont
-- consignés ici parce que ce sont exactement les erreurs qu'un bloc préparé
-- d'avance produit au moment où il s'active.
--
--   1. `type` : `FIRE_SERVICE` devient `OPERATIONAL_SERVICE`. Le référentiel
--      fermé retient la nature générale — service d'incendie, service technique
--      ou unité de sécurité civile — et non le seul cas qui avait servi
--      d'exemple.
--   2. `type` : `MUNICIPALITY` devient `LOCAL_AUTHORITY`. Une commune est un
--      cas particulier de collectivité, pas la définition du type.
--   3. `status` : la quatrième organisation portait `PENDING`, valeur qui
--      n'existe PAS dans `organization_status` et qui aurait fait échouer ce
--      bloc à son activation. Elle confondait deux axes que 0014 sépare : la
--      VÉRIFICATION (`verification_status`, en attente) et le CYCLE DE VIE
--      (`status`, actif). Les quatre organisations sont `ACTIVE` ; seule la
--      quatrième est `PENDING` du point de vue de la vérification.
--      C'est précisément le cas à démontrer : son administrateur peut
--      travailler, mais toute action sensible doit lui être refusée par
--      `ORGANIZATION_NOT_VERIFIED`, et non par un refus de connexion.
--   4. `version` n'est pas écrite : la colonne existe depuis 0015 avec la
--      valeur par défaut 1, et l'écrire à la main ferait croire qu'un
--      verrouillage optimiste a déjà eu lieu.
--
-- `registration_number` est stocké tel quel ; l'unicité porte sur sa forme
-- NORMALISÉE, calculée par 0015 (majuscules, séparateurs retirés), soit ici
-- `FICTIFORG0001` à `FICTIFORG0004`.
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
    'OPERATIONAL_SERVICE',
    'FICTIF-ORG-0001',
    'ZZ-DEMO-01',
    'VERIFIED',
    'ACTIVE'
  ),
  (
    '00000001-0000-4000-8000-000000000002',
    'Commune de démonstration',
    'LOCAL_AUTHORITY',
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
  -- En attente de vérification, mais bien active : aucune de ses ressources ne
  -- porte de mission dans le jeu, ce qui illustre la condition de validation
  -- sans avoir besoin d'un test. Voir l'écart 3 de l'en-tête.
  (
    '00000001-0000-4000-8000-000000000004',
    'Travaux Publics Horizon',
    'COMPANY',
    'FICTIF-ORG-0004',
    'ZZ-DEMO-02',
    'PENDING',
    'ACTIVE'
  )
ON CONFLICT (id) DO NOTHING;

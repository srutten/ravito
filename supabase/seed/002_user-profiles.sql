-- =============================================================================
-- 002 — Profils utilisateur
--
-- @titre: Profils utilisateur
-- @lot: 1
-- @story: US-010
-- @tables: user_profiles
-- @requiert-blocs: aucun
-- @etat: inactif
--
-- Bloc PRÉPARÉ, INACTIF au lot 0 : la table `user_profiles` n'existe pas encore.
--
-- Contenu : les six personnages de docs/seed-data.md. Ce sont des personnages,
-- pas des personnes : aucun nom, aucun contact et aucun compte réel n'apparaît
-- ici.
--
-- TÉLÉPHONES — plage réservée à la fiction
--   Les numéros appartiennent à la plage 06 39 98 00 00 – 06 39 98 99 99, que
--   l'ARCEP réserve aux œuvres de fiction. Ils n'aboutissent chez aucun abonné.
--   Une règle de scan de secrets qui interdit les numéros complets doit inscrire
--   le préfixe `063998` en liste d'exception, faute de quoi elle signalera des
--   valeurs dont l'existence même garantit qu'aucun numéro réel n'a été utilisé.
--
-- COURRIELS
--   Domaine `example.org`, réservé à la documentation par la RFC 2606. Aucune
--   remise possible, donc aucun risque d'envoi accidentel depuis un poste de
--   développement.
--
-- AUTHENTIFICATION
--   `auth_user_id` porte un identifiant fixe et fictif. Aucun compte n'est créé
--   chez le fournisseur d'identité : le jeu de démonstration alimente la base,
--   il ne crée pas de moyen de connexion. La création des comptes de
--   démonstration relève du lot 1 et d'une commande distincte, pour que le
--   chargement de données ne puisse jamais ouvrir un accès.
--
-- À RÉCONCILIER AU LOT 1 (US-010) : `verification_level` et `status` n'ont pas
-- de vocabulaire arrêté. Le rôle n'est volontairement pas porté ici : d'après
-- docs/domain-model.md il appartient à `OrganizationMember` (bloc 003).
-- =============================================================================

INSERT INTO public.user_profiles (
  id,
  auth_user_id,
  display_name,
  phone,
  email,
  preferred_language,
  verification_level,
  status
)
VALUES
  (
    '00000002-0000-4000-8000-000000000001',
    '000000a0-0000-4000-8000-000000000001',
    'Alice Coordinateur',
    '0639980001',
    'alice.coordinateur@example.org',
    'fr',
    'VERIFIED',
    'ACTIVE'
  ),
  (
    '00000002-0000-4000-8000-000000000002',
    '000000a0-0000-4000-8000-000000000002',
    'Bruno Coordinateur',
    '0639980002',
    'bruno.coordinateur@example.org',
    'fr',
    'VERIFIED',
    'ACTIVE'
  ),
  (
    '00000002-0000-4000-8000-000000000003',
    '000000a0-0000-4000-8000-000000000003',
    'Claire Agricultrice',
    '0639980003',
    'claire.agricultrice@example.org',
    'fr',
    'VERIFIED',
    'ACTIVE'
  ),
  (
    '00000002-0000-4000-8000-000000000004',
    '000000a0-0000-4000-8000-000000000004',
    'David Conducteur',
    '0639980004',
    'david.conducteur@example.org',
    'fr',
    'BASIC',
    'ACTIVE'
  ),
  (
    '00000002-0000-4000-8000-000000000005',
    '000000a0-0000-4000-8000-000000000005',
    'Emma Administratrice',
    '0639980005',
    'emma.administratrice@example.org',
    'fr',
    'VERIFIED',
    'ACTIVE'
  ),
  (
    '00000002-0000-4000-8000-000000000006',
    '000000a0-0000-4000-8000-000000000006',
    'François Observateur',
    '0639980006',
    'francois.observateur@example.org',
    'fr',
    'BASIC',
    'ACTIVE'
  )
ON CONFLICT (id) DO NOTHING;

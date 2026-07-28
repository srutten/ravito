-- =============================================================================
-- 002 — Profils utilisateur
--
-- @titre: Profils utilisateur
-- @lot: 1
-- @story: US-010
-- @tables: user_profiles
-- @requiert-blocs: aucun
-- @etat: actif
--
-- secret-scan:fixtures
--
-- Bloc ACTIF depuis le lot 1 : la migration 0010 a créé `user_profiles`.
--
-- Contenu : les six personnages de docs/seed-data.md. Ce sont des personnages,
-- pas des personnes : aucun nom, aucun contact et aucun compte réel n'apparaît
-- ici.
--
-- TÉLÉPHONES — plage réservée à la fiction, au format E.164
--   Les numéros appartiennent à la plage 06 39 98 00 00 – 06 39 98 99 99, que
--   l'ARCEP réserve aux œuvres de fiction. Ils n'aboutissent chez aucun abonné.
--   La migration 0010 contraint `phone` au format E.164 strict : un numéro
--   national comme `0639980001` serait refusé, et surtout `0639980001` et
--   `+33639980001` désigneraient deux comptes pour un seul destinataire.
--   Le marqueur `secret-scan:fixtures` en tête de fichier écarte ces valeurs du
--   scan de secrets, qui refuse les numéros complets : sans lui, le scan
--   signalerait des numéros dont l'existence même prouve qu'aucun numéro réel
--   n'a été utilisé.
--
-- COURRIELS
--   Domaine `example.org`, réservé à la documentation par la RFC 2606. Aucune
--   remise possible, donc aucun risque d'envoi accidentel depuis un poste de
--   développement. Ils sont écrits en minuscules : la migration 0010 impose la
--   forme normalisée, `citext` seul accepterait de stocker une casse mixte et
--   ferait alors dépendre de la casse tout hachage calculé hors du serveur.
--
-- AUTHENTIFICATION
--   `auth_user_id` porte un identifiant fixe et fictif. Aucun moyen de connexion
--   n'est créé : le jeu de démonstration alimente la base, il n'ouvre aucun
--   accès. Pour se connecter avec l'un de ces profils en développement, il faut
--   demander un code par le parcours normal, qui aboutira dans le service
--   d'interception de courriels de la pile Docker.
--
-- NIVEAUX DE VÉRIFICATION — réconciliés au lot 1
--   La migration 0009 arrête le vocabulaire : `NONE`, `CONTACT_VERIFIED`,
--   `IDENTITY_VERIFIED`, dans cet ordre croissant. Les valeurs `VERIFIED` et
--   `BASIC` employées au lot 0, avant que ce vocabulaire n'existe, sont donc
--   remplacées. Les coordinateurs et l'administratrice portent une identité
--   vérifiée, condition d'accès aux fonctions sensibles ; les contributeurs et
--   l'observateur n'ont qu'un contact vérifié.
--
--   Le rôle n'est volontairement pas porté ici : d'après docs/domain-model.md il
--   appartient à `OrganizationMember`, livré par US-014 dans le bloc 003.
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
    '+33639980001',
    'alice.coordinateur@example.org',
    'fr',
    'IDENTITY_VERIFIED',
    'ACTIVE'
  ),
  (
    '00000002-0000-4000-8000-000000000002',
    '000000a0-0000-4000-8000-000000000002',
    'Bruno Coordinateur',
    '+33639980002',
    'bruno.coordinateur@example.org',
    'fr',
    'IDENTITY_VERIFIED',
    'ACTIVE'
  ),
  (
    '00000002-0000-4000-8000-000000000003',
    '000000a0-0000-4000-8000-000000000003',
    'Claire Agricultrice',
    '+33639980003',
    'claire.agricultrice@example.org',
    'fr',
    'CONTACT_VERIFIED',
    'ACTIVE'
  ),
  (
    '00000002-0000-4000-8000-000000000004',
    '000000a0-0000-4000-8000-000000000004',
    'David Conducteur',
    '+33639980004',
    'david.conducteur@example.org',
    'fr',
    'CONTACT_VERIFIED',
    'ACTIVE'
  ),
  (
    '00000002-0000-4000-8000-000000000005',
    '000000a0-0000-4000-8000-000000000005',
    'Emma Administratrice',
    '+33639980005',
    'emma.administratrice@example.org',
    'fr',
    'IDENTITY_VERIFIED',
    'ACTIVE'
  ),
  (
    '00000002-0000-4000-8000-000000000006',
    '000000a0-0000-4000-8000-000000000006',
    'François Observateur',
    '+33639980006',
    'francois.observateur@example.org',
    'fr',
    'CONTACT_VERIFIED',
    'ACTIVE'
  )
ON CONFLICT (id) DO NOTHING;

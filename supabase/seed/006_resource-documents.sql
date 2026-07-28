-- =============================================================================
-- 006 — Documents de ressource
--
-- @titre: Documents de ressource
-- @lot: 2
-- @story: US-022
-- @tables: resource_documents
-- @requiert-blocs: 005
-- @etat: inactif
--
-- Bloc PRÉPARÉ, INACTIF au lot 0 : la table `resource_documents` n'existe pas
-- encore.
--
-- Contenu : les « plusieurs documents valides et expirés » demandés par
-- docs/database-design.md — quatre valides, deux expirés.
--
-- AUCUN DOCUMENT RÉEL, AUCUN FICHIER DÉPOSÉ
--   `storage_key` désigne un objet qui n'existe pas dans le stockage. Le jeu de
--   démonstration ne dépose aucun fichier et n'en référence aucun : un
--   justificatif d'assurance ou un contrôle technique est une pièce
--   professionnelle, parfois nominative, et docs/security.md interdit tout
--   document accessible autrement que par une URL signée. Une demande de
--   téléchargement sur ces clés doit échouer proprement — c'est aussi un cas de
--   test utile pour le lot 2.
--
-- DATES — DEUX RÉGIMES, VOLONTAIREMENT
--   - Échéance qui doit rester future : relative à `now()`. Un document
--     « valide » figé sur une date absolue finit par expirer, et la
--     démonstration perd son sens sans que personne ne s'en aperçoive.
--   - Échéance qui doit rester passée : littéral fixe. Le jeu est daté d'un
--     instant de référence, le 20 juillet 2026, et n'a de sens que chargé après
--     cette date.
--   Dans les deux cas, l'insertion est idempotente (`DO NOTHING`) : une seconde
--   exécution ne recalcule rien et laisse l'état inchangé.
--
-- CAS INTÉRESSANT — expiration EN COURS DE MISSION
--   Le contrôle technique de la pelle 20 tonnes a expiré le 25 juillet, cinq
--   jours APRÈS l'affectation du 20 juillet. La ressource est en transit avec un
--   document devenu invalide. docs/domain-model.md exige que les documents
--   expirés ne soient pas valides ; il ne dit pas ce qu'il advient d'une mission
--   déjà partie. C'est le genre de situation qu'une plateforme de coordination
--   doit faire remonter à un humain plutôt que trancher seule — à traiter au
--   lot 2 (US-022) et au lot 6.
-- =============================================================================

INSERT INTO public.resource_documents (
  id,
  resource_id,
  document_type,
  storage_key,
  verification_status,
  expires_at,
  verified_by,
  verified_at
)
VALUES
  -- Valide — citerne 12 m³.
  (
    '00000006-0000-4000-8000-000000000001',
    '00000005-0000-4000-8000-000000000001',
    'INSURANCE',
    'demo/resource-documents/00000006-0000-4000-8000-000000000001',
    'VERIFIED',
    now() + interval '18 months',
    '00000002-0000-4000-8000-000000000001',
    '2026-07-18 10:00:00+00'
  ),
  -- EXPIRÉ — citerne 8 m³. Elle porte pourtant une offre soumise (bloc 009) :
  -- la comparaison des propositions du lot 4 doit le signaler au coordinateur.
  (
    '00000006-0000-4000-8000-000000000002',
    '00000005-0000-4000-8000-000000000002',
    'INSURANCE',
    'demo/resource-documents/00000006-0000-4000-8000-000000000002',
    'EXPIRED',
    '2026-03-31 22:00:00+00',
    '00000002-0000-4000-8000-000000000001',
    '2025-04-02 09:00:00+00'
  ),
  -- Valide — tracteur avec lame.
  (
    '00000006-0000-4000-8000-000000000003',
    '00000005-0000-4000-8000-000000000003',
    'INSURANCE',
    'demo/resource-documents/00000006-0000-4000-8000-000000000003',
    'VERIFIED',
    now() + interval '10 months',
    '00000002-0000-4000-8000-000000000001',
    '2026-07-18 10:05:00+00'
  ),
  -- EXPIRÉ — pelle 20 tonnes, expiration postérieure à l'affectation.
  (
    '00000006-0000-4000-8000-000000000004',
    '00000005-0000-4000-8000-000000000004',
    'TECHNICAL_INSPECTION',
    'demo/resource-documents/00000006-0000-4000-8000-000000000004',
    'EXPIRED',
    '2026-07-25 12:00:00+00',
    '00000002-0000-4000-8000-000000000001',
    '2025-07-25 12:00:00+00'
  ),
  -- Valide — groupe électrogène.
  (
    '00000006-0000-4000-8000-000000000005',
    '00000005-0000-4000-8000-000000000005',
    'CONFORMITY',
    'demo/resource-documents/00000006-0000-4000-8000-000000000005',
    'VERIFIED',
    now() + interval '24 months',
    '00000002-0000-4000-8000-000000000001',
    '2026-07-18 10:10:00+00'
  ),
  -- Valide mais NON ENCORE VÉRIFIÉ — camion plateau. Un document déposé n'est
  -- pas un document validé : `verified_by` et `verified_at` restent NULL.
  (
    '00000006-0000-4000-8000-000000000006',
    '00000005-0000-4000-8000-000000000006',
    'TECHNICAL_INSPECTION',
    'demo/resource-documents/00000006-0000-4000-8000-000000000006',
    'PENDING',
    now() + interval '6 months',
    NULL,
    NULL
  )
ON CONFLICT (id) DO NOTHING;

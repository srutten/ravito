-- =============================================================================
-- 013 — File transactionnelle de notifications (outbox)
--
-- @titre: File transactionnelle de notifications
-- @lot: 0
-- @story: US-002
-- @tables: outbox
-- @requiert-blocs: aucun
-- @etat: actif
--
-- Bloc ACTIF : `public.outbox` existe depuis `0005_outbox.sql`.
--
-- Il peut être chargé dès maintenant alors que les missions et les demandes
-- qu'il évoque n'existent pas encore, parce que `0005_outbox.sql` ne pose
-- AUCUNE clé étrangère — décision explicite de cette migration : « l'outbox doit
-- survivre à la suppression de l'agrégat, sans quoi une purge métier effacerait
-- la preuve qu'une notification était due ». Les `aggregate_id` ci-dessous sont
-- les identifiants fixes des blocs 008, 009 et 010 : le jour où ces blocs
-- s'activent, la file décrit exactement leurs objets, sans qu'une seule ligne
-- d'ici ait à changer.
--
-- CONTENU DES CHARGES UTILES
--   `0005_outbox.sql` avertit que la charge est recopiée dans les journaux du
--   fournisseur d'envoi. Elle ne contient donc que des identifiants et le
--   strict nécessaire au rendu du message : ni téléphone, ni position, ni
--   description d'incident. Le rendu réel va rechercher les données en base au
--   moment de l'envoi, avec les droits de l'expéditeur.
--
-- UN MESSAGE VOLONTAIREMENT NON TRAITÉ
--   La ligne `0000000e-…-0006` a `processed_at IS NULL` et trois tentatives en
--   échec. C'est une file bloquée, cas que docs/observability.md demande de
--   savoir alerter et docs/operations.md de savoir diagnostiquer : sans une
--   ligne comme celle-ci, le tableau de bord des files serait toujours vert en
--   démonstration.
--   Conséquence à connaître : `0005_outbox.down.sql` refuse de s'exécuter tant
--   qu'un message non traité subsiste. Après un `db:seed`, le retour arrière de
--   la migration 0005 est donc refusé — c'est le garde-fou qui fonctionne, pas
--   un défaut. Sur un poste de développement, `npm run db:reset` remet tout à
--   plat sans avoir à drainer quoi que ce soit.
--
-- IDEMPOTENCE — POURQUOI CE `ON CONFLICT` ET PAS UN AUTRE
--   `DO UPDATE … WHERE … IS DISTINCT FROM …` fait deux choses qu'un simple
--   `DO NOTHING` ne fait pas : il ramène une ligne modifiée à la main à l'état
--   déclaré ici, et il n'écrit RIEN quand la ligne est déjà conforme. Sans la
--   clause `WHERE`, chaque exécution déclencherait `outbox_set_updated_at` et
--   ferait avancer `updated_at` : deux exécutions consécutives ne produiraient
--   plus le même état. `created_at` est volontairement absent de la liste des
--   colonnes mises à jour, pour la même raison.
--   Tous les horodatages sont des littéraux fixes : une valeur relative à
--   `now()` rendrait la comparaison toujours différente et remettrait à jour la
--   table à chaque exécution.
-- =============================================================================

INSERT INTO public.outbox (
  id,
  event_type,
  aggregate_type,
  aggregate_id,
  payload,
  created_at,
  updated_at,
  processed_at,
  attempt_count,
  last_error
)
VALUES
  -- Publication de la demande A.
  (
    '0000000e-0000-4000-8000-000000000001',
    'REQUEST_PUBLISHED',
    'OPERATIONAL_REQUEST',
    '00000008-0000-4000-8000-000000000001',
    '{"requestId":"00000008-0000-4000-8000-000000000001","priority":"URGENT","territoryCode":"ZZ-DEMO-01"}'::jsonb,
    '2026-07-20 07:00:00+00',
    '2026-07-20 07:00:00+00',
    '2026-07-20 07:00:06+00',
    1,
    NULL
  ),
  -- Soumission de la proposition O1 sur la demande A.
  (
    '0000000e-0000-4000-8000-000000000002',
    'OFFER_SUBMITTED',
    'OFFER',
    '0000000a-0000-4000-8000-000000000001',
    '{"offerId":"0000000a-0000-4000-8000-000000000001","requestId":"00000008-0000-4000-8000-000000000001"}'::jsonb,
    '2026-07-20 08:10:00+00',
    '2026-07-20 08:10:00+00',
    '2026-07-20 08:10:04+00',
    1,
    NULL
  ),
  -- Validation de la mission M1.
  (
    '0000000e-0000-4000-8000-000000000003',
    'MISSION_VALIDATED',
    'MISSION',
    '0000000b-0000-4000-8000-000000000001',
    '{"missionId":"0000000b-0000-4000-8000-000000000001","recipientUserId":"00000002-0000-4000-8000-000000000004"}'::jsonb,
    '2026-07-20 10:20:00+00',
    '2026-07-20 10:20:00+00',
    '2026-07-20 10:20:03+00',
    1,
    NULL
  ),
  -- Confirmation du départ de M1.
  (
    '0000000e-0000-4000-8000-000000000004',
    'MISSION_DEPARTURE_CONFIRMED',
    'MISSION',
    '0000000b-0000-4000-8000-000000000001',
    '{"missionId":"0000000b-0000-4000-8000-000000000001","recipientUserId":"00000002-0000-4000-8000-000000000001"}'::jsonb,
    '2026-07-20 10:30:00+00',
    '2026-07-20 10:30:00+00',
    '2026-07-20 10:30:05+00',
    1,
    NULL
  ),
  -- Arrivée de M2 au point de rassemblement.
  (
    '0000000e-0000-4000-8000-000000000005',
    'MISSION_ARRIVED',
    'MISSION',
    '0000000b-0000-4000-8000-000000000002',
    '{"missionId":"0000000b-0000-4000-8000-000000000002","recipientUserId":"00000002-0000-4000-8000-000000000001"}'::jsonb,
    '2026-07-20 10:02:00+00',
    '2026-07-20 10:02:00+00',
    '2026-07-20 10:02:07+00',
    1,
    NULL
  ),
  -- File bloquée : incident déclaré sur M1, notification jamais partie.
  -- `last_error` ne cite ni URL, ni jeton, ni destinataire : docs/security.md
  -- interdit les secrets dans les exemples, et un message d'erreur recopié tel
  -- quel depuis un fournisseur en contient souvent.
  (
    '0000000e-0000-4000-8000-000000000006',
    'MISSION_INCIDENT_REPORTED',
    'MISSION',
    '0000000b-0000-4000-8000-000000000001',
    '{"missionId":"0000000b-0000-4000-8000-000000000001","incidentId":"0000000d-0000-4000-8000-000000000001","severity":"MEDIUM"}'::jsonb,
    '2026-07-20 11:05:00+00',
    '2026-07-20 11:05:00+00',
    NULL,
    3,
    'Fournisseur SMS injoignable : delai depasse apres trois tentatives. Circuit ouvert.'
  ),
  -- Clôture de M3.
  (
    '0000000e-0000-4000-8000-000000000007',
    'MISSION_COMPLETED',
    'MISSION',
    '0000000b-0000-4000-8000-000000000003',
    '{"missionId":"0000000b-0000-4000-8000-000000000003","recipientUserId":"00000002-0000-4000-8000-000000000002"}'::jsonb,
    '2026-07-19 18:00:00+00',
    '2026-07-19 18:00:00+00',
    '2026-07-19 18:00:04+00',
    1,
    NULL
  )
ON CONFLICT (id) DO UPDATE SET
  event_type = excluded.event_type,
  aggregate_type = excluded.aggregate_type,
  aggregate_id = excluded.aggregate_id,
  payload = excluded.payload,
  processed_at = excluded.processed_at,
  attempt_count = excluded.attempt_count,
  last_error = excluded.last_error
WHERE (
  outbox.event_type,
  outbox.aggregate_type,
  outbox.aggregate_id,
  outbox.payload,
  outbox.processed_at,
  outbox.attempt_count,
  outbox.last_error
) IS DISTINCT FROM (
  excluded.event_type,
  excluded.aggregate_type,
  excluded.aggregate_id,
  excluded.payload,
  excluded.processed_at,
  excluded.attempt_count,
  excluded.last_error
);

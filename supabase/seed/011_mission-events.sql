-- =============================================================================
-- 011 — Événements de mission
--
-- @titre: Événements de mission
-- @lot: 6
-- @story: US-052, US-053, US-054, US-055, US-056
-- @tables: mission_events
-- @requiert-blocs: 002, 010
-- @etat: inactif
--
-- Bloc PRÉPARÉ, INACTIF au lot 0 : la table `mission_events` n'existe pas
-- encore.
--
-- Contenu : la trace immuable des transitions qui ont conduit chaque mission du
-- bloc 010 à son état courant. Sans ces lignes, les trois missions auraient un
-- statut sans histoire : la démonstration du suivi (US-051) et celle de l'écran
-- de mission n'auraient rien à afficher.
--
--   M1, en transit   : VALIDATED → DEPARTURE_CONFIRMED, puis INCIDENT_REPORTED.
--   M2, arrivée      : VALIDATED → DEPARTURE_CONFIRMED → ARRIVED.
--   M3, terminée     : le parcours nominal complet, jusqu'à COMPLETED.
--
--   Les noms d'événements sont exactement ceux de docs/state-machines.md, sans
--   ajout. Conséquence à connaître : ce document nomme sept événements alors que
--   le parcours nominal compte neuf transitions. Les passages
--   HANDED_OVER → ACTIVE et ACTIVE → RETURNING n'ont pas de nom d'événement et
--   n'apparaissent donc pas ici. La chaîne lisible dans `mission_events` n'est
--   pas la chaîne complète des états : c'est visible sur M3, dont l'événement
--   MISSION_COMPLETED part de RETURNING sans qu'aucun événement n'ait annoncé
--   cet état. Soit le lot 6 nomme les deux événements manquants, soit il assume
--   que la table ne restitue pas tout l'historique — ce qui affaiblirait la
--   valeur de preuve exigée par docs/security.md.
--
-- IDEMPOTENCE
--   `client_event_id` porte un identifiant fixe par événement. La portée
--   d'unicité retenue au lot 0 est GLOBALE (voir l'en-tête de
--   `supabase/migrations/0007_idempotency-witness.sql` et le point ouvert
--   correspondant du README des migrations) : les identifiants de ce fichier
--   sont donc distincts deux à deux, ce qui reste valide si la portée est
--   ensuite relâchée par acteur ou par mission.
--
-- POINT OUVERT SIGNALÉ, NON TRANCHÉ (lot 6, US-060)
--   docs/seed-data.md demande une mission « en transit » ET un incident porté
--   par cette mission. docs/state-machines.md prévoit la transition
--   IN_TRANSIT → INCIDENT, et aucune transition de retour vers IN_TRANSIT.
--   Les deux ne sont vrais ensemble que si la déclaration d'un incident
--   n'entraîne pas automatiquement la transition de la mission.
--   Le jeu retient cette lecture : l'incident est enregistré, la mission reste
--   IN_TRANSIT, et la décision de la faire basculer appartient à un humain.
--   Elle est cohérente avec CLAUDE.md, « ne pas automatiser une décision
--   opérationnelle critique ». Si le lot 6 tranche l'inverse, il faut passer M1
--   à INCIDENT dans le bloc 010 et l'assumer comme un écart au document.
-- =============================================================================

INSERT INTO public.mission_events (
  id,
  mission_id,
  event_type,
  actor_user_id,
  actor_organization_id,
  client_event_id,
  payload,
  occurred_at,
  recorded_at
)
VALUES
  -- --- M1, en transit -------------------------------------------------------
  (
    '0000000c-0000-4000-8000-000000000001',
    '0000000b-0000-4000-8000-000000000001',
    'MISSION_VALIDATED',
    '00000002-0000-4000-8000-000000000001',
    '00000001-0000-4000-8000-000000000001',
    '000000ce-0000-4000-8000-000000000001',
    '{"from":"ACCEPTED","to":"VALIDATED"}'::jsonb,
    '2026-07-20 10:20:00+00',
    '2026-07-20 10:20:00+00'
  ),
  (
    '0000000c-0000-4000-8000-000000000002',
    '0000000b-0000-4000-8000-000000000001',
    'MISSION_DEPARTURE_CONFIRMED',
    '00000002-0000-4000-8000-000000000004',
    '00000001-0000-4000-8000-000000000003',
    '000000ce-0000-4000-8000-000000000002',
    '{"from":"VALIDATED","to":"IN_TRANSIT"}'::jsonb,
    '2026-07-20 10:30:00+00',
    '2026-07-20 10:30:00+00'
  ),
  (
    '0000000c-0000-4000-8000-000000000003',
    '0000000b-0000-4000-8000-000000000001',
    'MISSION_INCIDENT_REPORTED',
    '00000002-0000-4000-8000-000000000004',
    '00000001-0000-4000-8000-000000000003',
    '000000ce-0000-4000-8000-000000000003',
    '{"incidentId":"0000000d-0000-4000-8000-000000000001","severity":"MEDIUM"}'::jsonb,
    '2026-07-20 11:05:00+00',
    '2026-07-20 11:05:00+00'
  ),

  -- --- M2, arrivée ----------------------------------------------------------
  (
    '0000000c-0000-4000-8000-000000000004',
    '0000000b-0000-4000-8000-000000000002',
    'MISSION_VALIDATED',
    '00000002-0000-4000-8000-000000000001',
    '00000001-0000-4000-8000-000000000001',
    '000000ce-0000-4000-8000-000000000004',
    '{"from":"ACCEPTED","to":"VALIDATED"}'::jsonb,
    '2026-07-20 09:05:00+00',
    '2026-07-20 09:05:00+00'
  ),
  (
    '0000000c-0000-4000-8000-000000000005',
    '0000000b-0000-4000-8000-000000000002',
    'MISSION_DEPARTURE_CONFIRMED',
    '00000002-0000-4000-8000-000000000003',
    '00000001-0000-4000-8000-000000000003',
    '000000ce-0000-4000-8000-000000000005',
    '{"from":"VALIDATED","to":"IN_TRANSIT"}'::jsonb,
    '2026-07-20 09:15:00+00',
    '2026-07-20 09:15:00+00'
  ),
  -- Rejeu hors ligne démontré : l'arrivée a été constatée à 09:50 et n'a été
  -- enregistrée qu'à 10:02, à la reconnexion (docs/offline-mode.md). L'écart
  -- entre `occurred_at` et `recorded_at` mesure ce retard.
  (
    '0000000c-0000-4000-8000-000000000006',
    '0000000b-0000-4000-8000-000000000002',
    'MISSION_ARRIVED',
    '00000002-0000-4000-8000-000000000003',
    '00000001-0000-4000-8000-000000000003',
    '000000ce-0000-4000-8000-000000000006',
    '{"from":"IN_TRANSIT","to":"ARRIVED"}'::jsonb,
    '2026-07-20 09:50:00+00',
    '2026-07-20 10:02:00+00'
  ),

  -- --- M3, terminée : parcours nominal complet ------------------------------
  (
    '0000000c-0000-4000-8000-000000000007',
    '0000000b-0000-4000-8000-000000000003',
    'MISSION_VALIDATED',
    '00000002-0000-4000-8000-000000000001',
    '00000001-0000-4000-8000-000000000001',
    '000000ce-0000-4000-8000-000000000007',
    '{"from":"ACCEPTED","to":"VALIDATED"}'::jsonb,
    '2026-07-19 13:20:00+00',
    '2026-07-19 13:20:00+00'
  ),
  (
    '0000000c-0000-4000-8000-000000000008',
    '0000000b-0000-4000-8000-000000000003',
    'MISSION_DEPARTURE_CONFIRMED',
    '00000002-0000-4000-8000-000000000002',
    '00000001-0000-4000-8000-000000000002',
    '000000ce-0000-4000-8000-000000000008',
    '{"from":"VALIDATED","to":"IN_TRANSIT"}'::jsonb,
    '2026-07-19 13:30:00+00',
    '2026-07-19 13:30:00+00'
  ),
  (
    '0000000c-0000-4000-8000-000000000009',
    '0000000b-0000-4000-8000-000000000003',
    'MISSION_ARRIVED',
    '00000002-0000-4000-8000-000000000002',
    '00000001-0000-4000-8000-000000000002',
    '000000ce-0000-4000-8000-000000000009',
    '{"from":"IN_TRANSIT","to":"ARRIVED"}'::jsonb,
    '2026-07-19 14:05:00+00',
    '2026-07-19 14:05:00+00'
  ),
  (
    '0000000c-0000-4000-8000-00000000000a',
    '0000000b-0000-4000-8000-000000000003',
    'MISSION_HANDED_OVER',
    '00000002-0000-4000-8000-000000000001',
    '00000001-0000-4000-8000-000000000001',
    '000000ce-0000-4000-8000-00000000000a',
    '{"from":"ARRIVED","to":"HANDED_OVER"}'::jsonb,
    '2026-07-19 14:30:00+00',
    '2026-07-19 14:30:00+00'
  ),
  (
    '0000000c-0000-4000-8000-00000000000b',
    '0000000b-0000-4000-8000-000000000003',
    'MISSION_COMPLETED',
    '00000002-0000-4000-8000-000000000001',
    '00000001-0000-4000-8000-000000000001',
    '000000ce-0000-4000-8000-00000000000b',
    '{"from":"RETURNING","to":"COMPLETED","restitution":"CONFORME"}'::jsonb,
    '2026-07-19 18:00:00+00',
    '2026-07-19 18:00:00+00'
  )
ON CONFLICT (id) DO NOTHING;

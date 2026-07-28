-- =============================================================================
-- 014 — Journal d'audit
--
-- @titre: Journal d'audit
-- @lot: 0
-- @story: US-002, US-090
-- @tables: audit_logs
-- @requiert-blocs: aucun
-- @etat: actif
--
-- Bloc ACTIF : `public.audit_logs` existe depuis `0006_audit-logs.sql`.
--
-- Comme l'outbox, ce bloc ne dépend d'aucun autre : `0006_audit-logs.sql` ne
-- pose aucune clé étrangère, « le journal doit survivre à la suppression du
-- compte, faute de quoi l'exercice du droit à l'effacement emporterait la preuve
-- des actions passées ». Les identifiants d'acteur et de cible sont ceux, fixes,
-- des blocs 001 à 012 : les lignes deviennent jointes le jour où ces blocs
-- s'activent, sans modification.
--
-- COUVERTURE
--   Les actions choisies couvrent la liste « Journaliser » de docs/security.md :
--   publication, affectation, transition, lecture de position exacte,
--   téléchargement de document, validation d'organisation, activation du mode
--   lecture seule. Un journal de démonstration qui ne contiendrait que des
--   créations réussies ne permettrait pas de montrer à quoi sert un audit.
--
-- CE QUE CE BLOC IMPOSE À `seed.ts` — LE PIÈGE DE LA REJOUABILITÉ
--   `audit_logs` refuse `UPDATE`, `DELETE` et `TRUNCATE`, par les droits ET par
--   un déclencheur qui s'applique même au superutilisateur. Un seed rendu
--   rejouable « à la manière habituelle », c'est-à-dire en vidant les tables
--   avant de les remplir, échouerait ici en `42501`. La rejouabilité est donc
--   obtenue par des identifiants fixes et `ON CONFLICT (id) DO NOTHING`.
--   `DO UPDATE` est également exclu : il déclencherait l'interdiction de
--   modification. `DO NOTHING` ne déclenche rien, puisqu'aucune ligne existante
--   n'est touchée.
--   Corollaire assumé : si une ligne de ce fichier est modifiée après un
--   premier chargement, la base ne s'aligne pas. Il faut passer par
--   `npm run db:reset`, qui supprime le schéma. C'est le comportement voulu —
--   un journal d'audit qu'un script de données peut réécrire n'est pas une
--   preuve.
--
-- ADRESSES IP
--   `ip_hash` est calculé ici même, par `sha256()`, à partir d'adresses de la
--   plage 192.0.2.0/24 que la RFC 5737 réserve à la documentation. Deux raisons
--   de calculer plutôt que de coller une empreinte : le lecteur voit que la
--   colonne contient bien une empreinte et jamais une adresse, et il vérifie
--   d'un coup d'œil qu'aucune adresse réelle n'a servi. La contrainte
--   `audit_logs_ip_hash_format` rejetterait de toute façon une adresse en clair.
--   Les lignes produites par le système lui-même portent `ip_hash` à NULL :
--   aucune requête HTTP n'en est à l'origine, et inventer une adresse serait
--   fabriquer une preuve.
--
-- RÉSUMÉS DE NAVIGATEUR
--   `user_agent_summary` reste très court, conformément à l'intention de
--   `0006_audit-logs.sql` : l'en-tête complet constituerait une empreinte de
--   navigateur exploitable pour du pistage.
-- =============================================================================

INSERT INTO public.audit_logs (
  id,
  actor_user_id,
  actor_organization_id,
  action,
  target_type,
  target_id,
  before,
  after,
  ip_hash,
  user_agent_summary,
  occurred_at
)
VALUES
  -- Validation d'une organisation par l'administratrice plateforme (US-013).
  (
    '0000000f-0000-4000-8000-000000000001',
    '00000002-0000-4000-8000-000000000005',
    '00000001-0000-4000-8000-000000000001',
    'ORGANIZATION_VERIFIED',
    'ORGANIZATION',
    '00000001-0000-4000-8000-000000000002',
    '{"verificationStatus":"PENDING"}'::jsonb,
    '{"verificationStatus":"VERIFIED"}'::jsonb,
    encode(sha256(convert_to('192.0.2.10', 'utf8')), 'hex'),
    'Firefox 141 / Windows',
    '2026-07-18 09:12:00+00'
  ),
  -- Publication de la demande A (US-033).
  (
    '0000000f-0000-4000-8000-000000000002',
    '00000002-0000-4000-8000-000000000001',
    '00000001-0000-4000-8000-000000000001',
    'REQUEST_PUBLISHED',
    'OPERATIONAL_REQUEST',
    '00000008-0000-4000-8000-000000000001',
    '{"status":"PENDING_VALIDATION"}'::jsonb,
    '{"status":"PUBLISHED","priority":"URGENT"}'::jsonb,
    encode(sha256(convert_to('192.0.2.20', 'utf8')), 'hex'),
    'Chrome 139 / Windows',
    '2026-07-20 07:00:00+00'
  ),
  -- Soumission d'une proposition (US-041).
  (
    '0000000f-0000-4000-8000-000000000003',
    '00000002-0000-4000-8000-000000000003',
    '00000001-0000-4000-8000-000000000003',
    'OFFER_SUBMITTED',
    'OFFER',
    '0000000a-0000-4000-8000-000000000001',
    NULL,
    '{"status":"SUBMITTED","resourceId":"00000005-0000-4000-8000-000000000002"}'::jsonb,
    encode(sha256(convert_to('192.0.2.30', 'utf8')), 'hex'),
    'Safari 19 / iOS',
    '2026-07-20 08:10:00+00'
  ),
  -- Consultation d'un document avant affectation (docs/security.md,
  -- « téléchargement de document »). Le document en question est celui qui
  -- expirera cinq jours plus tard : la trace montre qu'il était encore valide
  -- au moment de la vérification.
  (
    '0000000f-0000-4000-8000-000000000004',
    '00000002-0000-4000-8000-000000000001',
    '00000001-0000-4000-8000-000000000001',
    'DOCUMENT_DOWNLOADED',
    'RESOURCE_DOCUMENT',
    '00000006-0000-4000-8000-000000000004',
    NULL,
    '{"documentType":"TECHNICAL_INSPECTION","verificationStatus":"VERIFIED"}'::jsonb,
    encode(sha256(convert_to('192.0.2.20', 'utf8')), 'hex'),
    'Chrome 139 / Windows',
    '2026-07-20 10:14:00+00'
  ),
  -- Affectation : le cœur de la transaction de CLAUDE.md (US-050).
  (
    '0000000f-0000-4000-8000-000000000005',
    '00000002-0000-4000-8000-000000000001',
    '00000001-0000-4000-8000-000000000001',
    'RESOURCE_ASSIGNED',
    'MISSION',
    '0000000b-0000-4000-8000-000000000001',
    '{"offerStatus":"SUBMITTED","resourceStatus":"AVAILABLE"}'::jsonb,
    '{"offerStatus":"ACCEPTED","resourceStatus":"RESERVED","missionStatus":"PROPOSED"}'::jsonb,
    encode(sha256(convert_to('192.0.2.20', 'utf8')), 'hex'),
    'Chrome 139 / Windows',
    '2026-07-20 10:15:00+00'
  ),
  -- Lecture d'un point exact par le conducteur affecté (docs/security.md,
  -- « lecture de position exacte » ; docs/permissions.md, « Voir le point exact
  -- de rendez-vous : mission affectée »).
  (
    '0000000f-0000-4000-8000-000000000006',
    '00000002-0000-4000-8000-000000000004',
    '00000001-0000-4000-8000-000000000003',
    'PRECISE_LOCATION_VIEWED',
    'MEETING_POINT',
    '00000007-0000-4000-8000-000000000002',
    NULL,
    '{"missionId":"0000000b-0000-4000-8000-000000000001","reason":"ASSIGNED_MISSION"}'::jsonb,
    encode(sha256(convert_to('192.0.2.40', 'utf8')), 'hex'),
    'Firefox 141 / Android',
    '2026-07-20 10:26:00+00'
  ),
  -- Transition de mission par le contributeur (US-053).
  (
    '0000000f-0000-4000-8000-000000000007',
    '00000002-0000-4000-8000-000000000004',
    '00000001-0000-4000-8000-000000000003',
    'MISSION_DEPARTURE_CONFIRMED',
    'MISSION',
    '0000000b-0000-4000-8000-000000000001',
    '{"status":"VALIDATED"}'::jsonb,
    '{"status":"IN_TRANSIT"}'::jsonb,
    encode(sha256(convert_to('192.0.2.40', 'utf8')), 'hex'),
    'Firefox 141 / Android',
    '2026-07-20 10:30:00+00'
  ),
  -- Déclaration d'incident (US-060).
  (
    '0000000f-0000-4000-8000-000000000008',
    '00000002-0000-4000-8000-000000000004',
    '00000001-0000-4000-8000-000000000003',
    'MISSION_INCIDENT_REPORTED',
    'MISSION',
    '0000000b-0000-4000-8000-000000000001',
    NULL,
    '{"incidentId":"0000000d-0000-4000-8000-000000000001","severity":"MEDIUM"}'::jsonb,
    encode(sha256(convert_to('192.0.2.40', 'utf8')), 'hex'),
    'Firefox 141 / Android',
    '2026-07-20 11:05:00+00'
  ),
  -- Clôture de la mission M3 (US-056).
  (
    '0000000f-0000-4000-8000-000000000009',
    '00000002-0000-4000-8000-000000000001',
    '00000001-0000-4000-8000-000000000001',
    'MISSION_COMPLETED',
    'MISSION',
    '0000000b-0000-4000-8000-000000000003',
    '{"status":"RETURNING"}'::jsonb,
    '{"status":"COMPLETED","restitution":"CONFORME"}'::jsonb,
    encode(sha256(convert_to('192.0.2.20', 'utf8')), 'hex'),
    'Chrome 139 / Windows',
    '2026-07-19 18:00:00+00'
  ),
  -- Action du système, sans acteur ni adresse : l'échec d'acheminement de la
  -- notification restée dans la file du bloc 013.
  (
    '0000000f-0000-4000-8000-00000000000a',
    NULL,
    NULL,
    'NOTIFICATION_DELIVERY_FAILED',
    'OUTBOX_MESSAGE',
    '0000000e-0000-4000-8000-000000000006',
    NULL,
    '{"attemptCount":3,"channel":"SMS"}'::jsonb,
    NULL,
    NULL,
    '2026-07-20 11:12:00+00'
  ),
  -- Action d'administration sans cible identifiée par un UUID : la cible est la
  -- plateforme elle-même (US-094).
  (
    '0000000f-0000-4000-8000-00000000000b',
    '00000002-0000-4000-8000-000000000005',
    '00000001-0000-4000-8000-000000000001',
    'READ_ONLY_MODE_ENABLED',
    'PLATFORM',
    NULL,
    '{"readOnly":false}'::jsonb,
    '{"readOnly":true,"reason":"EXERCICE"}'::jsonb,
    encode(sha256(convert_to('192.0.2.10', 'utf8')), 'hex'),
    'Firefox 141 / Windows',
    '2026-07-20 11:20:00+00'
  )
ON CONFLICT (id) DO NOTHING;

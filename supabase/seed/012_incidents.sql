-- =============================================================================
-- 012 — Incident
--
-- @titre: Incident
-- @lot: 6
-- @story: US-060, US-061
-- @tables: incidents
-- @requiert-blocs: 002, 010
-- @etat: inactif
--
-- Bloc PRÉPARÉ, INACTIF au lot 0 : la table `incidents` n'existe pas encore.
--
-- Contenu : l'incident unique de docs/seed-data.md — panne mécanique simulée,
-- gravité moyenne, sur la mission en transit.
--
-- LE MOT « SIMULÉE » EST DANS LA DESCRIPTION, VOLONTAIREMENT
--   docs/seed-data.md écrit « panne mécanique simulée ». La description en base
--   le répète mot pour mot. Un jeu de démonstration finit toujours par être
--   affiché à côté de données réelles, sur un écran partagé, pendant un
--   exercice ; un incident dont le libellé ne dit pas qu'il est fictif est un
--   incident que quelqu'un traitera comme vrai.
--
-- DESCRIPTION VOLONTAIREMENT PAUVRE
--   docs/database-design.md range les « notes d'incident sensibles » parmi les
--   données à chiffrer, docs/observability.md interdit le « contenu sensible
--   d'incident » dans les journaux et docs/privacy-rgpd.md exclut les données de
--   santé et les détails sur les victimes. Un jeu de démonstration réaliste
--   contiendrait exactement ce qu'aucun de ces documents ne veut voir circuler.
--   La description se limite donc au fait technique : un organe mécanique, un
--   véhicule immobilisé, une consigne. Aucune personne, aucune blessure, aucun
--   lieu.
--
-- CONSÉQUENCE SUR L'ÉTAT DE LA MISSION
--   La mission reste IN_TRANSIT. Le point ouvert est décrit dans l'en-tête du
--   bloc 011 : docs/seed-data.md demande une mission « en transit » porteuse
--   d'un incident, ce qui n'est vrai que si déclarer un incident ne fait pas
--   basculer la mission automatiquement. Arbitrage lot 6.
-- =============================================================================

INSERT INTO public.incidents (
  id,
  mission_id,
  reported_by,
  type,
  severity,
  description,
  status,
  created_at,
  resolved_at
)
VALUES
  (
    '0000000d-0000-4000-8000-000000000001',
    '0000000b-0000-4000-8000-000000000001',
    '00000002-0000-4000-8000-000000000004',
    'MECHANICAL_FAILURE',
    'MEDIUM',
    'Panne mécanique simulée : perte de pression hydraulique signalée pendant le transport. Véhicule à l''arrêt, acheminement suspendu dans l''attente d''une consigne.',
    'REPORTED',
    '2026-07-20 11:05:00+00',
    NULL
  )
ON CONFLICT (id) DO NOTHING;

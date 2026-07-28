-- =============================================================================
-- 007 — Points de rassemblement
--
-- @titre: Points de rassemblement
-- @lot: 3
-- @story: US-032
-- @tables: meeting_points
-- @requiert-blocs: 001
-- @etat: inactif
--
-- Bloc PRÉPARÉ, INACTIF au lot 0 : la table `meeting_points` n'existe pas
-- encore.
--
-- Contenu : le « Point de rassemblement Nord » nommé par la demande A dans
-- docs/seed-data.md, et un point Sud pour que les missions du bloc 010 ne
-- convergent pas toutes au même endroit.
--
-- POSITIONS — MÊME RÈGLE QUE POUR LES RESSOURCES
--   Une décimale, environ 11 km. `precise_location` porte ici la MÊME valeur
--   approximative que `public_approximate_location`, et c'est délibéré : le jeu
--   de démonstration ne détient aucune position exacte. La colonne existe pour
--   que la mécanique d'autorisation du lot 7 (US-081, « afficher un point exact
--   après affectation ») ait quelque chose à protéger, pas pour héberger un
--   lieu vrai. Un point de rassemblement réel est une information opérationnelle
--   sensible : docs/functional-specification.md interdit d'exposer la position
--   des équipes, et un dépôt public n'est pas l'endroit où la stocker.
--
--   Conséquence à connaître : une démonstration de la carte montrera un point
--   « exact » qui ne l'est pas. C'est le comportement voulu. Le contrôle
--   d'accès reste démontrable, la fuite de position ne l'est pas — et c'est
--   exactement ce que l'on veut d'un jeu de démonstration.
--
-- CONSIGNES
--   `instructions` reste générique. docs/functional-specification.md interdit au
--   public les axes tactiques et les fréquences radio ; un jeu de démonstration
--   qui en inventerait de plausibles apprendrait aux utilisateurs à en saisir.
-- =============================================================================

INSERT INTO public.meeting_points (
  id,
  organization_id,
  name,
  instructions,
  precise_location,
  public_approximate_location,
  active,
  valid_from,
  valid_until
)
VALUES
  (
    '00000007-0000-4000-8000-000000000001',
    '00000001-0000-4000-8000-000000000001',
    'Point de rassemblement Nord',
    'Se présenter au responsable de site, moteur coupé. Attendre la consigne avant tout déplacement.',
    ST_SetSRID(ST_MakePoint(6.1, 43.6), 4326)::geography,
    ST_SetSRID(ST_MakePoint(6.1, 43.6), 4326)::geography,
    true,
    '2026-07-18 06:00:00+00',
    NULL
  ),
  (
    '00000007-0000-4000-8000-000000000002',
    '00000001-0000-4000-8000-000000000001',
    'Point de rassemblement Sud',
    'Accès par la voie de service. Stationner en épi, laisser le passage libre pour les secours.',
    ST_SetSRID(ST_MakePoint(6.0, 43.3), 4326)::geography,
    ST_SetSRID(ST_MakePoint(6.0, 43.3), 4326)::geography,
    true,
    '2026-07-18 06:00:00+00',
    NULL
  )
ON CONFLICT (id) DO NOTHING;

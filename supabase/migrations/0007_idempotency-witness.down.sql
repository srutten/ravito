-- =============================================================================
-- Retour arrière de 0007 — Table témoin
--
-- Sans réserve : la table ne porte aucune donnée métier, seulement des lignes
-- écrites par les tests d'intégration du lot 0. Sa suppression est d'ailleurs
-- programmée au lot 5.
-- =============================================================================

DROP TABLE IF EXISTS public.idempotency_witness;

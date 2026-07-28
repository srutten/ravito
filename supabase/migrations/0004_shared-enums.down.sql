-- =============================================================================
-- Retour arrière de 0004 — Types énumérés partagés
--
-- Volontairement sans `CASCADE` : tant qu'une colonne d'un lot suivant utilise
-- l'un de ces types, PostgreSQL refuse la suppression. Un `CASCADE`
-- supprimerait la colonne de statut elle-même, donc l'état métier des
-- demandes, des ressources et des missions. Le retour arrière doit être
-- déroulé dans l'ordre inverse des migrations.
-- =============================================================================

DROP TYPE IF EXISTS public.mission_status;
DROP TYPE IF EXISTS public.offer_status;
DROP TYPE IF EXISTS public.resource_status;
DROP TYPE IF EXISTS public.operational_request_status;

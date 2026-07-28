-- =============================================================================
-- Retour arrière de 0009 — Types énumérés du domaine identité
--
-- Volontairement sans `CASCADE`, comme 0004 : tant qu'une colonne les utilise,
-- PostgreSQL refuse la suppression. Un `CASCADE` supprimerait la colonne
-- `status` de `user_profiles`, donc la trace d'une suspension de compte — la
-- mesure de réponse à incident de docs/security.md. Le retour arrière doit être
-- déroulé dans l'ordre inverse des migrations : 0013, 0012, 0011, 0010, puis
-- seulement 0009.
-- =============================================================================

DROP TYPE IF EXISTS public.user_profile_status;
DROP TYPE IF EXISTS public.user_verification_level;

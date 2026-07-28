-- =============================================================================
-- Retour arrière de 0003 — Fonction `updated_at`
--
-- Volontairement sans `CASCADE` : si un déclencheur d'une table encore
-- présente dépend de la fonction, PostgreSQL refuse la suppression. C'est le
-- comportement recherché — il faut d'abord dérouler les migrations qui ont
-- attaché le déclencheur. Un `CASCADE` détruirait ces déclencheurs en silence
-- et laisserait des tables dont `updated_at` cesserait d'être maintenu sans
-- qu'aucune erreur ne le signale.
-- =============================================================================

DROP FUNCTION IF EXISTS public.set_updated_at();

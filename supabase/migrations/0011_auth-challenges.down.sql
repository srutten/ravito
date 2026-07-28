-- =============================================================================
-- Retour arrière de 0011 — Table `auth_challenges`
--
-- Sans réserve particulière : la table ne porte que des codes de connexion à
-- durée de vie courte, tous hachés. Sa suppression n'efface aucune preuve — les
-- connexions réussies sont tracées dans `audit_logs`, qui n'est pas concerné —
-- et n'interrompt aucune mission. Les codes en circulation deviennent
-- inutilisables, ce qui est le comportement attendu d'un retour arrière du
-- mécanisme de connexion.
--
-- Sans `CASCADE` : aucun objet d'un lot ultérieur ne doit dépendre de cette
-- table. Si PostgreSQL refuse, c'est qu'un tel objet existe, et il faut dérouler
-- son retour arrière d'abord.
-- =============================================================================

DROP TABLE IF EXISTS public.auth_challenges;

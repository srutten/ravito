-- =============================================================================
-- Retour arrière de 0012 — Table `auth_attempts`
--
-- Point à connaître avant de l'exécuter : supprimer cette table LÈVE TOUS LES
-- BLOCAGES en cours. Si le retour arrière est déclenché pendant une campagne de
-- tentatives, celle-ci reprend immédiatement sans limite. Ce n'est pas une
-- raison de refuser la suppression — un garde-fou qui bloquerait sur la
-- présence de compteurs empêcherait tout retour arrière dès la première
-- tentative enregistrée, y compris en développement — mais c'en est une pour ne
-- pas la déclencher en réaction à un incident de sécurité.
--
-- Aucune donnée personnelle n'est perdue : la table ne contient que des
-- empreintes et des compteurs.
--
-- Sans `CASCADE`, comme les autres retours arrière du dépôt.
-- =============================================================================

DROP TABLE IF EXISTS public.auth_attempts;

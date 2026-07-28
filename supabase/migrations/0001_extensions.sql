-- =============================================================================
-- 0001 — Extensions requises par le socle
-- Lot 0 · socle transverse
--
-- Objet   : activer les seules extensions dont le produit a besoin.
--           PostGIS pour les positions approximatives et la recherche de
--           proximité (ADR-002), pgcrypto pour la génération d'UUID.
-- Source  : docs/architecture.md, docs/database-design.md, docs/decision-log.md
--
-- Stratégie de retour : aucun fichier `.down.sql`.
--   Le retour arrière est techniquement possible (`DROP EXTENSION postgis`)
--   mais jamais souhaitable : la suppression cascaderait sur toutes les
--   colonnes géographiques des lots suivants, donc sur des données
--   opérationnelles. La compatibilité descendante est assurée autrement :
--   une extension activée est inerte pour une version antérieure du code, qui
--   ignore simplement les types qu'elle n'utilise pas. Revenir en arrière
--   consiste donc à laisser les extensions en place.
--
-- Droits requis : cette migration est la seule à exiger un compte capable de
--   créer une extension (PostGIS n'est pas une extension `trusted`). Sur une
--   instance managée où `CREATE EXTENSION` est refusé, les extensions doivent
--   être pré-provisionnées par l'hébergeur avant le premier déploiement.
-- =============================================================================

-- PostGIS : types `geography`/`geometry` et index GiST des positions.
-- L'index géospatial exigé par docs/database-design.md est créé par le lot qui
-- introduit la colonne concernée, pas ici.
CREATE EXTENSION IF NOT EXISTS postgis;

-- pgcrypto : garantit `gen_random_uuid()` quelle que soit la version cible.
-- La fonction est native depuis PostgreSQL 13, mais la cible de déploiement
-- n'est pas figée (docs/deployment.md) : l'extension rend la valeur par défaut
-- des clés primaires indépendante de la version du serveur. Aucune autre
-- fonction de pgcrypto n'est utilisée par le socle ; le chiffrement des données
-- sensibles reste applicatif, conformément à docs/database-design.md, afin que
-- les clés ne transitent jamais par le serveur de base.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Aucun `COMMENT ON EXTENSION` ici : commenter une extension exige d'en être
-- propriétaire, ce qui n'est pas le cas sur une instance managée où elle est
-- pré-provisionnée. Le fichier de migration étant immuable après fusion
-- (CLAUDE.md), il ne doit contenir aucune instruction dont le succès dépend du
-- compte utilisé.

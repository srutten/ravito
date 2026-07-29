-- =============================================================================
-- 0015 — Table `organizations`
-- Lot 1 · identité et organisations
--
-- Objet   : porter l'entité `Organization` de docs/domain-model.md, c'est-à-dire
--           la structure au nom de laquelle une demande est publiée et un moyen
--           engagé. C'est l'objet dont docs/threat-model.md redoute
--           l'usurpation : « un attaquant tente de publier une demande pour
--           attirer des citoyens ». Le contrôle central contre ce scénario est
--           la vérification humaine (ADR-004), et cette table est ce qu'elle
--           vérifie.
-- Source  : docs/domain-model.md (champs), docs/permissions.md (validation
--           préalable aux actions sensibles), docs/api-contract.md
--           (`ORGANIZATION_NOT_VERIFIED`, `VERSION_CONFLICT`, file
--           d'administration), docs/database-design.md (conventions, index),
--           docs/seed-data.md, backlog/epics-and-stories.md (US-012, US-013).
-- Retour  : supabase/migrations/0015_organizations.down.sql
--
-- ---------------------------------------------------------------------------
-- CE QUE LA TABLE NE PORTE PAS
-- ---------------------------------------------------------------------------
-- Ni adresse postale, ni contact nominatif, ni champ libre de commentaire.
-- docs/privacy-rgpd.md impose la minimisation, et un champ libre attaché à une
-- organisation est le réceptacle naturel d'une donnée personnelle saisie par
-- erreur — un nom de dirigeant, un numéro direct — que docs/permissions.md
-- range parmi les données sensibles. Le contact opérationnel d'une mission est
-- porté par la mission, au plus près de son besoin et de sa durée de vie.
-- Le commentaire de décision exigé par US-013 appartient au journal d'audit,
-- où il est daté, attribué et inaltérable, et non à une colonne réécrite à
-- chaque nouvelle décision.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Raison sociale ou dénomination affichée. Aucune unicité : deux structures
  -- distinctes peuvent légitimement porter le même nom, et le refuser
  -- empêcherait la seconde de se déclarer. L'identité qui doit être unique est
  -- le numéro d'immatriculation, ci-dessous.
  name text NOT NULL
    CONSTRAINT organizations_name_length
    CHECK (char_length(btrim(name)) BETWEEN 2 AND 160)
    CONSTRAINT organizations_name_trimmed
    CHECK (name = btrim(name)),

  type public.organization_type NOT NULL,

  -- --- Immatriculation ---------------------------------------------------------
  -- NOT NULL, et ce n'est pas une commodité : un administrateur plateforme qui
  -- valide une organisation (US-013) doit pouvoir confronter la déclaration à
  -- un registre public. Sans identifiant, il ne lui reste que le nom, que
  -- n'importe qui peut recopier — soit exactement l'usurpation d'organisation
  -- de docs/threat-model.md. Une colonne facultative aurait de surcroît rendu
  -- l'unicité inopérante : PostgreSQL considère deux NULL comme distincts, si
  -- bien qu'un nombre illimité d'organisations non identifiées auraient pu
  -- coexister, ce qui est précisément le doublon que la contrainte évite.
  --
  -- La forme STOCKÉE reste celle que l'utilisateur a saisie, séparateurs
  -- compris : un SIRET se lit par groupes, et normaliser l'affichage
  -- appauvrirait la vérification humaine. C'est la forme NORMALISÉE, calculée
  -- ci-dessous, qui porte l'unicité.
  registration_number text NOT NULL
    CONSTRAINT organizations_registration_number_shape
    CHECK (
      registration_number = btrim(registration_number)
      AND char_length(registration_number) BETWEEN 4 AND 64
      AND registration_number ~ '^[0-9A-Za-z][0-9A-Za-z ./-]*[0-9A-Za-z]$'
    ),

  -- Forme normalisée : majuscules, séparateurs retirés. Colonne GÉNÉRÉE, donc
  -- calculée par le serveur et jamais fournie par l'appelant. C'est le point
  -- important : si la normalisation était faite côté application, deux chemins
  -- d'écriture — une route, une reprise de données, une console — pourraient
  -- normaliser différemment, et l'unicité ne porterait plus sur la même chose
  -- selon l'origine de la ligne. Ici, « 123 456 789 00012 », « 123-456-789
  -- 00012 » et « 12345678900012 » donnent la même valeur, donc le même conflit.
  registration_number_normalized text
    GENERATED ALWAYS AS (upper(regexp_replace(registration_number, '[^0-9A-Za-z]', '', 'g'))) STORED
    CONSTRAINT organizations_registration_number_normalized_length
    CHECK (char_length(registration_number_normalized) BETWEEN 4 AND 64),

  -- --- Périmètre territorial ----------------------------------------------------
  -- Code de territoire en majuscules, du type « 2A » ou « ZZ-DEMO-01 ». Le
  -- format exact n'est arrêté par aucun document ; la contrainte borne la forme
  -- sans présumer du référentiel, pour qu'un lot ultérieur puisse le fixer sans
  -- reprise de données.
  --
  -- NULL est accepté : une organisation nationale n'a pas de périmètre
  -- territorial, et docs/permissions.md ne fait du périmètre une condition que
  -- « si activé ». Conséquence à connaître pour le lot qui activera le filtrage
  -- territorial : un filtre `territory_code = ...` exclut silencieusement les
  -- lignes NULL. Ce lot devra décider s'il les inclut ou rend la colonne
  -- obligatoire, et l'inscrire dans docs/decision-log.md.
  territory_code text
    CONSTRAINT organizations_territory_code_format
    CHECK (territory_code IS NULL OR territory_code ~ '^[0-9A-Z][0-9A-Z-]{0,15}$'),

  -- --- Vérification et cycle de vie ---------------------------------------------
  -- La valeur par défaut est `PENDING`, conformément au critère « statut en
  -- attente » d'US-012. Elle est portée par le SCHÉMA et non par le code
  -- appelant : une organisation créée par une reprise de données ou par une
  -- console ne doit pas pouvoir naître vérifiée. Passer à `VERIFIED` est une
  -- décision d'administrateur plateforme (US-013), auditée.
  verification_status public.organization_verification_status NOT NULL DEFAULT 'PENDING',

  status public.organization_status NOT NULL DEFAULT 'ACTIVE',

  -- --- Verrouillage optimiste ----------------------------------------------------
  -- docs/domain-model.md : « Version positive pour verrouillage optimiste ».
  -- La contrainte est SQL et non applicative : une version nulle ou négative
  -- rendrait `expectedVersion` inexploitable et ferait échouer silencieusement
  -- la détection de `VERSION_CONFLICT` de docs/api-contract.md.
  --
  -- Contrat pour le code : toute modification incrémente `version` dans la même
  -- instruction `UPDATE` que le changement, avec `WHERE version = $expected`.
  -- Un incrément par déclencheur serait plus commode mais rendrait indétectable
  -- l'écriture concurrente : deux transactions liraient la même version, toutes
  -- deux écriraient, et le déclencheur incrémenterait deux fois sans que
  -- personne ne soit averti d'avoir écrasé l'autre.
  version integer NOT NULL DEFAULT 1
    CONSTRAINT organizations_version_positive CHECK (version > 0),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.organizations IS
  'Structures au nom desquelles une demande est publiée ou un moyen engagé. '
  'La vérification (US-013) est le contrôle central contre l''usurpation '
  'décrite par docs/threat-model.md.';
COMMENT ON COLUMN public.organizations.registration_number IS
  'Immatriculation telle que saisie, séparateurs compris. L''unicité porte sur '
  'la forme normalisée, pas sur celle-ci.';
COMMENT ON COLUMN public.organizations.registration_number_normalized IS
  'Forme normalisée calculée par le serveur : majuscules, caractères non '
  'alphanumériques retirés. Porte l''unicité. Jamais fournie par l''appelant.';
COMMENT ON COLUMN public.organizations.territory_code IS
  'Code de territoire en majuscules. NULL pour une organisation sans périmètre '
  'territorial déclaré : un filtre par égalité exclut alors la ligne.';
COMMENT ON COLUMN public.organizations.verification_status IS
  'PENDING par défaut (US-012). Seule VERIFIED ouvre les actions sensibles ; '
  'toute autre valeur doit produire ORGANIZATION_NOT_VERIFIED.';
COMMENT ON COLUMN public.organizations.status IS
  'Cycle de vie administratif, indépendant de la vérification. Une organisation '
  'peut être VERIFIED et SUSPENDED, ou PENDING et ACTIVE.';
COMMENT ON COLUMN public.organizations.version IS
  'Verrouillage optimiste. Incrémentée par l''UPDATE lui-même, avec '
  'WHERE version = expectedVersion. Jamais par un déclencheur.';

-- Le déclencheur partagé de 0003 impose `updated_at` côté serveur : une valeur
-- fournie par l'application serait falsifiable et divergerait d'un poste à
-- l'autre.
CREATE OR REPLACE TRIGGER organizations_set_updated_at
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- --- Unicité de l'immatriculation normalisée ---------------------------------
-- Index unique plutôt que contrainte `UNIQUE` en ligne : la convention de
-- nommage de supabase/README.md impose le préfixe `uq_`, qu'une contrainte en
-- ligne ne permet pas de choisir sans la nommer séparément.
--
-- L'unicité est GLOBALE, y compris pour les organisations rejetées ou closes.
-- Restreindre l'index aux organisations actives aurait permis de recréer une
-- organisation sous une immatriculation déjà refusée, ce qui contournerait la
-- décision de l'administrateur en une seconde déclaration.
CREATE UNIQUE INDEX IF NOT EXISTS uq_organizations_registration_number
  ON public.organizations (registration_number_normalized);

COMMENT ON INDEX public.uq_organizations_registration_number IS
  'Unicité de l''immatriculation normalisée. Globale : couvre aussi les '
  'organisations rejetées et closes, pour qu''un refus ne se contourne pas.';

-- --- File d'administration ----------------------------------------------------
-- docs/screens.md écran 10 (« organisations en attente ») et
-- `GET /api/v1/admin/organizations/pending`.
--
-- Index PARTIEL, restreint aux organisations qui ne sont pas vérifiées : c'est
-- exactement la population de la file, et elle est minoritaire par
-- construction, comme celle de `idx_user_profiles_status` (0010). Un index
-- complet aurait indexé la quasi-totalité de la table pour ne jamais être
-- choisi sur la valeur majoritaire.
--
-- `created_at` ASC en seconde position : une file d'attente se traite du plus
-- ancien au plus récent. L'ordre inverse laisserait indéfiniment au fond de la
-- file les dossiers les plus anciens, c'est-à-dire ceux qui attendent le plus.
CREATE INDEX IF NOT EXISTS idx_organizations_verification_status
  ON public.organizations (verification_status, created_at)
  WHERE verification_status <> 'VERIFIED';

COMMENT ON INDEX public.idx_organizations_verification_status IS
  'File d''administration : organisations en attente ou rejetées, plus '
  'anciennes d''abord. Partiel, la valeur VERIFIED étant majoritaire.';

-- --- Périmètre territorial -----------------------------------------------------
-- Exigé par docs/database-design.md (« index sur les statuts », filtrage) et
-- par la sélection des organisations d'un territoire. Index complet et non
-- partiel : un index B-tree indexe les NULL, la même structure sert donc aussi
-- au recensement des organisations sans périmètre déclaré, que l'administration
-- devra pouvoir lister.
CREATE INDEX IF NOT EXISTS idx_organizations_territory_code
  ON public.organizations (territory_code);

COMMENT ON INDEX public.idx_organizations_territory_code IS
  'Filtrage par périmètre territorial. Indexe aussi les lignes sans territoire.';

-- --- Droits ------------------------------------------------------------------
-- Pas de `DELETE`, au même régime que `user_profiles` (0010) : la fermeture
-- d'une organisation est un statut (`CLOSED`), pas une suppression. Une
-- suppression physique emporterait les adhésions en cascade et ferait perdre le
-- lien des lignes d'audit déjà écrites, c'est-à-dire la preuve de ce qui a été
-- publié en son nom.
--
-- `registration_number_normalized` étant une colonne générée, PostgreSQL refuse
-- de lui-même toute écriture directe : aucun droit particulier n'est à révoquer.
GRANT SELECT, INSERT, UPDATE ON public.organizations TO fire_support_app;
REVOKE DELETE, TRUNCATE ON public.organizations FROM fire_support_app;

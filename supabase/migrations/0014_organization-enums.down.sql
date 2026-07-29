-- =============================================================================
-- Retour arrière de 0014 — Types énumérés du domaine organisations
--
-- Volontairement sans `CASCADE`, comme 0004 et 0009 : tant qu'une colonne les
-- utilise, PostgreSQL refuse la suppression, et c'est le comportement recherché.
-- Un `CASCADE` supprimerait les colonnes `role` et `status` de
-- `organization_members`, c'est-à-dire l'appartenance et le rôle sur lesquels
-- repose toute la matrice de docs/permissions.md, sans rien dire.
--
-- Le retour arrière doit être déroulé dans l'ordre INVERSE des migrations :
-- 0017, 0016, 0015, puis seulement 0014. Vérifié en conditions réelles :
-- 0014.down sur une base intacte échoue sur « cannot drop type
-- organization_member_status because other objects depend on it », premier type
-- de la liste ci-dessous.
-- =============================================================================

-- LES CINQ SUPPRESSIONS, LE CONTRÔLE ET LE RETRAIT DE LA LIGNE SONT DANS UN SEUL BLOC, DONC
-- INDISSOCIABLES. CE N'EST PAS LE MONTAGE DE `0005_outbox.down.sql`, et la nuance mérite d'être
-- écrite : `0005` est en DEUX blocs — contrôle et `DROP TABLE` dans le premier, contrôle et retrait
-- de la ligne dans le second. Cette forme conditionnelle suffit à un fichier qui défait UN objet ;
-- reportée telle quelle sur un fichier qui en défait plusieurs, elle laisse un refus au milieu de la
-- liste détruire les suivants. Un fichier multi-objets exige le bloc UNIQUE ci-dessous.
--
-- POURQUOI. Séparés — un `DROP` par énoncé, le contrôle en `DO` à la fin — `psql -f` les dissocie :
-- il envoie chaque énoncé séparément, en autocommit, et sans `-v ON_ERROR_STOP=1` il POURSUIT après
-- un refus. Un `DROP` refusé AU MILIEU de la liste laissait donc les suivants s'exécuter, et les
-- types encore libres partaient RÉELLEMENT. Le contrôle final voyait le reliquat, refusait, et
-- CONSERVAIT la ligne de suivi — sur un schéma désormais amputé. La ligne devenait fausse dans
-- l'autre sens : elle affirmait 0014 appliquée alors que deux de ses cinq types avaient disparu.
-- Mesuré, dans cet ordre : `db:status` annonçait « Aucune anomalie » sur une base cassée, puis
-- `db:migrate` échouait en 42704 — « type public.organization_member_role does not exist » — sans
-- pouvoir réparer. Seule la destruction totale de la base levait cet état, là où un retrait
-- INCONDITIONNEL de la ligne, lui, laissait `db:migrate` tout remonter. C'était donc échanger un
-- état incohérent transitoire et AUTO-RÉPARABLE contre un état incohérent PERMANENT : le troisième
-- versant du défaut, nommé dans `supabase/README.md`, « Dérouler un retour arrière ».
--
-- Réunis ici, un refus annule le bloc entier : aucun type n'est détruit, la ligne reste, et elle dit
-- enfin vrai. La propriété tient du FICHIER, jamais de la façon de l'invoquer.
--
-- LE CONTRÔLE DES CINQ TYPES EST CONSERVÉ, mais il ne garde PAS ce qu'on serait tenté de lui prêter.
-- L'atomicité le rend inatteignable depuis ce fichier : il parcourt le MÊME tableau littéral que les
-- `DROP` ci-dessus, donc après leur succès `to_regtype` vaut nécessairement `NULL`. Ce qui subsiste
-- est plus étroit : il n'attrape qu'une divergence entre les DEUX listes de CE fichier — un type
-- retiré des `DROP` et laissé dans le contrôle. Il ne voit RIEN de la migration 0014 elle-même : un
-- sixième type créé là-bas et absent des deux listes survivrait au retour arrière, et la ligne
-- partirait quand même. Mesuré. Ajouter un type à 0014 impose donc de l'ajouter ICI, aux DEUX
-- endroits, et aucun mécanisme ne le rappellera.
--
-- Le test d'existence de la table de suivi couvre une base montée hors moteur : il n'y a alors rien
-- à retirer.
DO $$
DECLARE
  reste text;
BEGIN
  DROP TYPE IF EXISTS public.organization_member_status;
  DROP TYPE IF EXISTS public.organization_member_role;
  DROP TYPE IF EXISTS public.organization_status;
  DROP TYPE IF EXISTS public.organization_verification_status;
  DROP TYPE IF EXISTS public.organization_type;

  FOREACH reste IN ARRAY ARRAY[
    'public.organization_member_status',
    'public.organization_member_role',
    'public.organization_status',
    'public.organization_verification_status',
    'public.organization_type'
  ] LOOP
    IF to_regtype(reste) IS NOT NULL THEN
      RAISE EXCEPTION
        'Retour arrière 0014 incomplet : le type % existe encore. Le bloc entier est ANNULÉ, aucun '
        'type supprimé, et la ligne 0014 de public.schema_migrations est CONSERVÉE : elle dit vrai.',
        reste
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END LOOP;

  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM public.schema_migrations WHERE version = '0014';
  END IF;
END
$$;

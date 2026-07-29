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

-- LES DEUX SUPPRESSIONS, LE CONTRÔLE ET LE RETRAIT DE LA LIGNE SONT DANS UN SEUL BLOC, DONC
-- INDISSOCIABLES. CE N'EST PAS LE MONTAGE DE `0005_outbox.down.sql`, et la nuance mérite d'être
-- écrite : `0005` est en DEUX blocs — contrôle et `DROP TABLE` dans le premier, contrôle et retrait
-- de la ligne dans le second. Cette forme conditionnelle suffit à un fichier qui défait UN objet ;
-- reportée telle quelle sur un fichier qui en défait plusieurs, elle laisse un refus au milieu de la
-- liste détruire les suivants. Un fichier multi-objets exige le bloc UNIQUE ci-dessous.
--
-- POURQUOI. Séparés — un `DROP` par énoncé, le contrôle en `DO` à la fin — `psql -f` les dissocie :
-- il envoie chaque énoncé séparément, en autocommit, et sans `-v ON_ERROR_STOP=1` il POURSUIT après
-- un refus. Un `DROP` refusé laisse alors le suivant s'exécuter, et un type encore libre part
-- RÉELLEMENT. Le contrôle final voit le reliquat, refuse, et CONSERVE la ligne de suivi — sur un
-- schéma désormais amputé. La ligne est alors fausse dans l'autre sens : elle affirme 0009 appliquée
-- alors que l'un de ses deux types a disparu. `db:status` annonce « Aucune anomalie » sur une base
-- cassée, et `db:migrate` ne peut pas réparer, puisqu'il n'a rien à réappliquer tant que la ligne
-- est là. Seule la destruction totale de la base lève cet état, là où un retrait INCONDITIONNEL de
-- la ligne, lui, laisse `db:migrate` tout remonter : c'est échanger un état incohérent transitoire
-- et AUTO-RÉPARABLE contre un état incohérent PERMANENT — le troisième versant du défaut, nommé
-- dans `supabase/README.md`, « Dérouler un retour arrière ». Mesuré sur 0004 et sur 0014.
--
-- CE FICHIER-CI N'EST PAS ENCORE ATTEIGNABLE, et c'est la seule raison pour laquelle il ne figure
-- pas dans les mesures : ses deux types sont portés par la MÊME table, `user_profiles`, donc ils
-- sont refusés ensemble ou libérés ensemble. Le montage est reporté quand même, parce que cette
-- immunité ne tient qu'à une coïncidence du schéma actuel : il suffirait qu'une migration future
-- utilise `user_verification_level` sur une autre table pour que le refus partiel devienne
-- possible, et rien n'avertirait au moment de l'écrire.
--
-- Réunis ici, un refus annule le bloc entier : aucun type n'est détruit, la ligne reste, et elle dit
-- enfin vrai. La propriété tient du FICHIER, jamais de la façon de l'invoquer.
--
-- LE CONTRÔLE DES DEUX TYPES EST CONSERVÉ, mais il ne garde PAS ce qu'on serait tenté de lui prêter.
-- L'atomicité le rend inatteignable depuis ce fichier : il parcourt le MÊME tableau littéral que les
-- `DROP` ci-dessus, donc après leur succès `to_regtype` vaut nécessairement `NULL`. Ce qui subsiste
-- est plus étroit : il n'attrape qu'une divergence entre les DEUX listes de CE fichier — un type
-- retiré des `DROP` et laissé dans le contrôle. Il ne voit RIEN de la migration 0009 elle-même : un
-- type créé là-bas et absent des deux listes survivrait au retour arrière, et la ligne partirait
-- quand même. Mesuré sur 0004. Ajouter un type à 0009 impose donc de l'ajouter ICI, aux DEUX
-- endroits, et aucun mécanisme ne le rappellera.
--
-- Le test d'existence de la table de suivi couvre une base montée hors moteur : il n'y a alors rien
-- à retirer.
DO $$
DECLARE
  reste text;
BEGIN
  DROP TYPE IF EXISTS public.user_profile_status;
  DROP TYPE IF EXISTS public.user_verification_level;

  FOREACH reste IN ARRAY ARRAY[
    'public.user_profile_status',
    'public.user_verification_level'
  ] LOOP
    IF to_regtype(reste) IS NOT NULL THEN
      RAISE EXCEPTION
        'Retour arrière 0009 incomplet : le type % existe encore. Le bloc entier est ANNULÉ, aucun '
        'type supprimé, et la ligne 0009 de public.schema_migrations est CONSERVÉE : elle dit vrai.',
        reste
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END LOOP;

  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM public.schema_migrations WHERE version = '0009';
  END IF;
END
$$;

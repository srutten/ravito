-- =============================================================================
-- Retour arrière de 0004 — Types énumérés partagés
--
-- Volontairement sans `CASCADE` : tant qu'une colonne d'un lot suivant utilise
-- l'un de ces types, PostgreSQL refuse la suppression. Un `CASCADE`
-- supprimerait la colonne de statut elle-même, donc l'état métier des
-- demandes, des ressources et des missions. Le retour arrière doit être
-- déroulé dans l'ordre inverse des migrations.
-- =============================================================================

-- LES QUATRE SUPPRESSIONS, LE CONTRÔLE ET LE RETRAIT DE LA LIGNE SONT DANS UN SEUL BLOC, DONC
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
-- l'autre sens : elle affirmait 0004 appliquée alors qu'une partie de ses types avait disparu.
-- `db:status` annonçait alors « Aucune anomalie » sur une base cassée, et `db:migrate` ne pouvait
-- pas réparer — il n'avait rien à réappliquer, puisque la ligne était là. Seule la destruction
-- totale de la base levait cet état, là où un retrait INCONDITIONNEL de la ligne, lui, laissait
-- `db:migrate` tout remonter. C'était donc échanger un état incohérent transitoire et
-- AUTO-RÉPARABLE contre un état incohérent PERMANENT : le troisième versant du défaut, nommé dans
-- `supabase/README.md`, « Dérouler un retour arrière ».
--
-- CE FICHIER EST CELUI OÙ LE DÉFAUT MORDAIT LE PLUS TÔT, et il n'exigeait aucun montage : mesuré
-- sur une base à jour, sans rien dérouler d'autre. `mission_status` est porté par
-- `idempotency_witness.status` (0007) et il est le PREMIER de la liste ; les trois autres ne sont
-- portés par aucune colonne du lot 0. Sous l'ancienne forme, un opérateur qui jouait ce seul fichier
-- se voyait refuser `mission_status` — puis `offer_status`, `resource_status` et
-- `operational_request_status` DISPARAISSAIENT, le contrôle final refusait, la ligne 0004 restait,
-- et `db:status` rendait « en attente : aucune, dérives : 0, manquantes : 0 » sur un schéma amputé
-- de trois types. `db:migrate` n'avait alors rien à réappliquer : le dommage était permanent ET
-- invisible. Le lot 5 aurait aggravé le cas, pas créé.
--
-- Réunis ici, un refus annule le bloc entier : aucun type n'est détruit, la ligne reste, et elle dit
-- enfin vrai. La propriété tient du FICHIER, jamais de la façon de l'invoquer.
--
-- LE CONTRÔLE DES QUATRE TYPES EST CONSERVÉ, mais il ne garde PAS ce qu'on serait tenté de lui
-- prêter. L'atomicité le rend inatteignable depuis ce fichier : il parcourt le MÊME tableau littéral
-- que les `DROP` ci-dessus, donc après leur succès `to_regtype` vaut nécessairement `NULL`. Ce qui
-- subsiste est plus étroit : il n'attrape qu'une divergence entre les DEUX listes de CE fichier — un
-- type retiré des `DROP` et laissé dans le contrôle. Il ne voit RIEN de la migration 0004 elle-même :
-- un type créé là-bas et absent des deux listes survivrait au retour arrière, et la ligne partirait
-- quand même. Mesuré. Ajouter un type à 0004 impose donc de l'ajouter ICI, aux DEUX endroits, et
-- aucun mécanisme ne le rappellera.
--
-- Le test d'existence de la table de suivi couvre une base montée hors moteur : il n'y a alors rien
-- à retirer.
DO $$
DECLARE
  reste text;
BEGIN
  DROP TYPE IF EXISTS public.mission_status;
  DROP TYPE IF EXISTS public.offer_status;
  DROP TYPE IF EXISTS public.resource_status;
  DROP TYPE IF EXISTS public.operational_request_status;

  FOREACH reste IN ARRAY ARRAY[
    'public.mission_status',
    'public.offer_status',
    'public.resource_status',
    'public.operational_request_status'
  ] LOOP
    IF to_regtype(reste) IS NOT NULL THEN
      RAISE EXCEPTION
        'Retour arrière 0004 incomplet : le type % existe encore. Le bloc entier est ANNULÉ, aucun '
        'type supprimé, et la ligne 0004 de public.schema_migrations est CONSERVÉE : elle dit vrai.',
        reste
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END LOOP;

  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    DELETE FROM public.schema_migrations WHERE version = '0004';
  END IF;
END
$$;

# Migrations de base de données

Ce répertoire contient le schéma d'Appui Feux, sous forme de migrations SQL
numérotées appliquées dans l'ordre. Il est la seule source de vérité du schéma :
aucune modification faite à la main sur une base n'est légitime.

Documents de référence : `docs/database-design.md`, `docs/domain-model.md`,
`docs/state-machines.md`, `docs/architecture.md`, `docs/security.md`,
`docs/privacy-rgpd.md`, `docs/operations.md`.

---

## Règle d'immuabilité

> **Un fichier de migration fusionné ne se modifie plus.** (`CLAUDE.md`)

Ni pour corriger une faute de frappe dans un commentaire, ni pour « juste
ajouter une colonne oubliée ». Une base déjà migrée a exécuté l'ancien contenu ;
si le fichier change, les deux environnements divergent en silence, et la
divergence ne se voit qu'au premier comportement inexplicable en production.

Cette règle n'est pas déclarative : le moteur de migration enregistre l'empreinte
SHA-256 de chaque fichier appliqué dans `schema_migrations`. Une empreinte qui ne
correspond plus fait **échouer** `db:migrate` et `db:status`. Un fichier fusionné
qui doit être corrigé donne lieu à une nouvelle migration, jamais à une retouche.

L'empreinte est calculée sur le contenu **normalisé** : fins de ligne ramenées à
`LF`, espaces de fin de ligne supprimés. Sans cette normalisation, un poste
Windows configuré en `core.autocrlf=true` produirait une empreinte différente de
celle de la CI, et la protection se déclencherait sur un dépôt pourtant sain — un
faux positif à répétition finit toujours par être contourné.

---

## Convention de nommage

```text
supabase/migrations/NNNN_nom-en-kebab-case.sql        migration, appliquée dans l'ordre de NNNN
supabase/migrations/NNNN_nom-en-kebab-case.down.sql   retour arrière, facultatif
```

- `NNNN` sur quatre chiffres, sans trou volontaire.
- Un seul changement cohérent par migration (`docs/database-design.md`).
- Noms SQL en `snake_case`, identifiants UUID, horodatages en `timestamptz` UTC.
- Index : `idx_<table>_<objet>` pour un index simple, `uq_<table>_<objet>` pour un
  index unique.
- Contraintes nommées explicitement (`<table>_<colonne>_<règle>`) : un nom généré
  automatiquement change d'une base à l'autre et rend le message d'erreur
  inexploitable côté application.

### Deux points d'attention pour le moteur de migration

1. **`*.down.sql` n'est pas une migration.** Un moteur qui liste `*.sql`
   naïvement appliquerait les retours arrière comme des migrations, dans
   l'ordre alphabétique, juste après la migration correspondante. Les fichiers
   de retour doivent être exclus de la liste des migrations à appliquer.
2. **Un fichier ne se découpe pas naïvement sur les points-virgules.** Les
   migrations contiennent des blocs `DO $$ ... $$` et des corps de fonctions qui
   incluent leurs propres `;`. Le moteur du dépôt envoie donc chaque fichier au
   serveur d'un seul tenant. `psql`, lui, découpe — mais il traverse
   correctement commentaires, chaînes et blocs entre signes dollar ; ce qu'il ne
   fait pas, c'est envoyer le tout dans une seule transaction, et c'est un point
   qui compte pour les retours arrière (voir plus bas).

---

## Table de suivi

`schema_migrations` est créée par le **moteur de migration**, pas par une
migration. Une migration qui créerait la table dont dépend le moteur produirait
un cycle : il faut lire la table pour savoir s'il faut l'appliquer.

| Colonne | Type | Rôle |
|---|---|---|
| `version` | `text` (clé primaire) | préfixe `NNNN` |
| `name` | `text` | nom du fichier |
| `checksum` | `text` | empreinte SHA-256 du contenu normalisé |
| `applied_at` | `timestamptz` | instant d'application |
| `execution_ms` | `integer` | durée, pour repérer une migration qui dérive |

Garanties attendues du moteur :

- **une transaction par migration**, avec l'enregistrement dans
  `schema_migrations` dans la même transaction. Une migration à moitié appliquée
  et non enregistrée laisse une base dans un état que ni le rejeu ni le retour
  arrière ne savent rattraper ;
- **verrou consultatif** pendant l'application, pour que deux déploiements
  simultanés ne s'appliquent pas les mêmes migrations en parallèle ;
- **échec sur dérive d'empreinte** et sur migration appliquée mais absente du
  dépôt. Le second cas signale une base plus avancée que le code — typiquement
  un retour arrière du code sans retour arrière du schéma.

L'empreinte n'est calculée que sur les migrations. Les `*.down.sql` en sont
**exclus** (`scripts/db/lib/migration-runner.ts`, `listMigrationFiles`) : la règle
d'immuabilité ne les couvre pas, et ils restent donc corrigibles après fusion.

---

## Dérouler un retour arrière

Un `.down.sql` défait ses objets **et retire sa propre ligne de
`public.schema_migrations` dans le même geste indivisible, et seulement s'ils ont
réellement disparu**. Les deux gestes vont ensemble : le moteur ne connaît l'état
du schéma que par cette table, et un écart dans un sens comme dans l'autre lui
fait décrire une base qui n'existe pas.

**Ce que ce comportement empêche.** Tant que la ligne survivait à la suppression
des objets, le retour arrière était une **porte à sens unique** : les tables
avaient disparu, `npm run db:status` affichait « La base est à jour »,
`npm run db:migrate` ne faisait rien, et l'outil de diagnostic officiel affirmait
le contraire de la réalité. Il fallait alors un `DELETE` tapé à la main sur la
table de suivi — c'est-à-dire deviner un mécanisme qu'aucun fichier ne décrivait,
au pire moment pour le faire.

**Le défaut symétrique, qu'il ne faut pas fabriquer en corrigeant celui-là.**
Retirer la ligne *inconditionnellement* démonte l'autre versant : un retour
arrière **refusé** — ordre inverse non respecté, dépendance encore en place —
laisse les objets intacts et perd quand même sa ligne. `db:status` annonce alors
« En attente » une migration dont le schéma est complet, et la réparation ne tient
plus qu'à l'idempotence du fichier, que rien ne garantit. Les deux versants
doivent être fermés ensemble.

**Le troisième versant, celui qu'on fabrique en fermant les deux premiers.**
Conditionner le retrait ne suffit pas quand un fichier défait **plusieurs**
objets : `0004` (quatre types), `0009` (deux), `0014` (cinq). Découpé en un
`DROP` par énoncé, le fichier laisse `psql -f` poursuivre après un refus — les
objets encore libres partent **réellement**, le contrôle final voit le reliquat,
refuse, et **conserve** la ligne. Elle ment alors dans l'autre sens : elle
affirme la migration appliquée sur un schéma amputé. C'est le pire des trois
états, parce que c'est **le seul qui ne se répare pas** — `db:status` annonce
« Aucune anomalie », `db:migrate` n'a rien à réappliquer tant que la ligne est
là, et `db:reset`, c'est-à-dire la destruction totale, devient le seul recours.
Le deuxième versant, lui, était transitoire et auto-réparable : un retrait
inconditionnel laissait `db:migrate` tout remonter. Fermer les deux premiers
versants sans celui-ci revient donc à échanger un défaut réparable contre un
défaut coinçant.

Mesuré sur bases jetables, dans les deux sens :

- `0004.down` **sur une base à jour, sans rien dérouler d'autre** — le geste le
  plus banal. `mission_status`, premier de la liste, est porté par
  `idempotency_witness.status` (`0007`) : il est refusé, puis `offer_status`,
  `resource_status` et `operational_request_status` **disparaissent**. Ligne
  `0004` conservée, et `db:status` rend « en attente : aucune, dérives : 0,
  manquantes : 0 » sur un schéma amputé de trois types ;
- `0014.down` joué après `0017` et `0016` : `organization_member_status` et
  `organization_member_role` **détruits**, ligne `0014` conservée, puis
  `db:migrate` en `42704`, `type "public.organization_member_role" does not
  exist`.

**Ce qui le ferme : l'atomicité, pas l'ordre.** Les suppressions sont dans le
**même bloc `DO`** que le contrôle et le retrait, dans les trois fichiers
multi-objets comme dans `0005` pour sa table. Un refus annule le bloc entier :
rien n'est détruit, la ligne reste, et elle dit enfin vrai. Les trois versants
sont fermés ensemble, et aucun ne l'est par la façon d'invoquer le fichier.

**Ne recopiez pas « le montage de `0005` » sans regarder lequel.** `0005` compte
**deux** blocs : contrôle et `DROP TABLE` dans le premier, contrôle et retrait de
la ligne dans le second. Cette forme conditionnelle suffit à un fichier qui défait
un seul objet. Reportée telle quelle sur un fichier qui en défait plusieurs, elle
laisse un refus au milieu de la liste détruire les suivants — c'est exactement la
régression décrite plus haut. Un fichier multi-objets exige le bloc **unique**.

Quatre propriétés de ce retrait, qui ne sont pas des détails.

- **Il est CONDITIONNÉ à la disparition réelle des objets, vérifiée dans le même
  bloc que lui.** Sa position en fin de fichier n'y suffit pas, et croire le
  contraire est l'erreur exacte que ce paragraphe corrige : `psql -f` découpe le
  fichier et envoie **chaque énoncé séparément, en autocommit**, et sans
  `-v ON_ERROR_STOP=1` il **poursuit** après un refus. La ligne d'un retour
  arrière refusé partait donc quand même. Chaque `.down.sql` teste désormais
  `to_regclass` / `to_regtype` / `to_regprocedure` sur ses propres objets et lève
  `object_not_in_prerequisite_state` (`55000`) s'il en reste un. La propriété
  tient du **fichier**, jamais de la façon de l'invoquer.
- **Il est ATOMIQUE avec les suppressions qu'il valide**, dans le même bloc `DO`
  qu'elles. C'est ce que le paragraphe ci-dessus établit, et c'est indispensable
  dès qu'un fichier défait plus d'un objet : sans cela, le contrôle constate un
  dégât qu'il ne peut plus annuler, et le refuser ne fait que figer la base dans
  cet état. Un fichier à objet unique n'a pas besoin de ce montage — un `DROP`
  unique passe ou ne passe pas — mais `0005` l'emploie quand même, parce que son
  garde-fou compte des messages avant de supprimer la table.
- **L'atomicité du FICHIER ENTIER, elle, n'est pas héritée : elle vient de
  `--single-transaction`.** Le bloc `DO` rend indivisible ce qu'il contient, pas
  la suite des blocs d'un fichier qui en compte plusieurs. Un fichier envoyé d'un
  seul tenant — ce que fait le moteur du dépôt, pas `psql -f` — est exécuté dans
  une transaction implicite. Avec `psql`, sans cette option, un `Ctrl-C`, un
  délai de garde ou une coupure entre deux blocs laisse un demi-état. L'option de
  la commande ci-dessous n'est donc pas un confort : elle **fait partie de la
  procédure**, au même titre que `-v ON_ERROR_STOP=1`.
- **Il est tolérant.** Il est gardé par un test d'existence de la table de suivi :
  un retour arrière joué sur une base montée à la main, hors moteur, n'échoue
  pas — il n'y a simplement rien à retirer.

### Procédure

Sauvegarde vérifiée d'abord (`docs/operations.md`) : un retour arrière de schéma
détruit des données, et la structure seule est réversible.

Le dépôt ne fournit **aucune commande de retour arrière**. Chaque fichier se joue
à la main, un par un, ce qui oblige à constater le résultat de chacun avant de
passer au suivant.

1. Dérouler dans l'ordre **strictement inverse** des numéros, en s'arrêtant au
   premier refus :

```bash
psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 --single-transaction -q \
  -f supabase/migrations/0017_idempotency-keys.down.sql
```

**Les deux options sont des conditions de correction, pas des raffinements.**
`-v ON_ERROR_STOP=1` arrête au premier refus, sans quoi `psql` enchaîne les
énoncés suivants sur un état qu'il vient d'échouer à produire, et n'affiche le
problème qu'au milieu d'un flot d'erreurs en cascade. `--single-transaction`
donne au fichier l'atomicité que son découpage lui retire. Les fichiers du dépôt
sont écrits pour rester **corrects même sans elles** — c'est la raison du bloc de
contrôle décrit plus haut — mais les omettre transforme un refus lisible en une
suite d'erreurs à interpréter, au pire moment pour le faire.

Un refus n'est pas une panne : sans `CASCADE`, PostgreSQL rend
`2BP01 dependent_objects_still_exist` tant qu'un objet d'un lot supérieur dépend
de ce qui doit disparaître. Dérouler le lot supérieur d'abord.

Avec `-v ON_ERROR_STOP=1`, `psql` s'arrête là et c'est le seul message affiché.
Sans lui, le fichier en produit un second — `55000
object_not_in_prerequisite_state` — qui nomme l'objet resté en place et rappelle
que **la ligne de suivi a été conservée**. Ce second refus n'est pas une panne
supplémentaire : c'est le fichier qui se refuse à lui-même de démonter la table
de suivi d'un schéma intact. Les deux messages ensemble décrivent une base
cohérente, pas une base à réparer.

Les trois fichiers multi-objets — `0004`, `0009`, `0014` — n'affichent, eux,
**qu'un seul message**, quelle que soit l'invocation : leur bloc unique s'arrête
au premier `DROP` refusé, et tout ce qu'il avait fait avant est annulé avec lui.
L'absence du second message y est donc la marque du bon fonctionnement, et non
d'un contrôle qui manque.

2. Vérifier, à chaque fichier ou au moins à la fin :

```bash
npm run db:status
```

Les migrations déroulées doivent **réapparaître dans « En attente »**, et les
rubriques « Dérives d'empreinte » et « Appliquées mais absentes du dépôt » rester
à zéro. Un « La base est à jour » après un retour arrière est le symptôme exact du
défaut que ce mécanisme corrige : ne pas passer outre.

3. Remonter, si la descente était provisoire :

```bash
npm run db:migrate
```

`db:migrate` réapplique exactement les migrations déroulées, dans l'ordre, et
réenregistre leur empreinte. La structure revient à l'identique ; **les données,
elles, ne reviennent pas**.

L'aller-retour du lot organisations est éprouvé sur base jetable par
`tests/integration/db-rollback.test.ts` : descente dans l'ordre documenté, absence
de table, de type énuméré et de droit résiduels, migrations de nouveau signalées
en attente, remontée, comparaison structurelle du schéma avant et après, refus du
sens interdit, et refus d'une garde d'autorisation privée de sa table. Le fichier
rejoue les retours arrière **dans les deux formes d'invocation** : d'un seul
tenant, et découpés énoncé par énoncé en autocommit comme le fait `psql -f` par
défaut. C'est cette seconde forme qui éprouve les propriétés ci-dessus là où
elles peuvent être fausses.

Le **refus partiel** a son propre révélateur dans ce fichier : `0014` joué après
`0017` et `0016` mais **avant** `0015`, c'est-à-dire la seule situation où
PostgreSQL refuse un `DROP` au milieu de la liste. Il constate les trois choses
qui distinguent les trois versants — aucun type détruit, ligne de suivi
conservée, et surtout **base encore réparable par `npm run db:migrate`**. Seul le
troisième constat sépare une base cohérente d'une base coincée : les deux
premiers restaient vrais dans l'état que la correction précédente fabriquait.

---

## Migrations du socle (lot 0)

| N° | Objet | Retour arrière |
|---|---|---|
| `0001` | Extensions PostGIS et pgcrypto | note en tête, pas de `.down.sql` |
| `0002` | Rôle applicatif sans droit de schéma, durcissement de `public` | note en tête, pas de `.down.sql` |
| `0003` | Fonction partagée `set_updated_at()` | `.down.sql` |
| `0004` | Types énumérés des machines à états | `.down.sql`, quatre types en bloc unique |
| `0005` | Table `outbox` | `.down.sql`, avec garde-fou |
| `0006` | Journal `audit_logs`, immuable | note en tête, pas de `.down.sql` |
| `0007` | Table témoin d'idempotence et d'anti-double affectation | `.down.sql` |

### Stratégie de retour

`docs/database-design.md` demande des migrations réversibles « lorsque
possible ». Trois migrations n'en fournissent pas, et ce n'est pas un oubli :

- **`0001` — extensions.** `DROP EXTENSION postgis` cascaderait sur toutes les
  colonnes géographiques, donc sur des données opérationnelles. Une extension
  laissée en place est inerte pour une version antérieure du code.
- **`0002` — rôle.** Un rôle est global à l'instance PostgreSQL, partagé par
  toutes les bases. Le supprimer couperait l'application encore déployée. Le
  retour arrière compatible est de **révoquer les droits**, pas de supprimer le
  compte.
- **`0006` — journal d'audit.** Supprimer la table détruirait la preuve, c'est-à-dire
  exactement ce que le journal existe pour empêcher. Un retour arrière capable
  d'effacer l'audit serait une porte dérobée en une commande pour quiconque
  obtient le compte de migration. La table est purement additive : une version
  antérieure du code l'ignore.

Quand un `.down.sql` existe, il est écrit **sans `CASCADE`**. Si un objet d'un lot
ultérieur dépend de ce qui doit disparaître, PostgreSQL refuse, et c'est le
comportement recherché : il faut dérouler les retours arrière dans l'ordre
inverse. Un `CASCADE` supprimerait les dépendances en silence — typiquement la
colonne `status` d'une table, donc l'état métier des missions.

Il retire aussi sa ligne de `public.schema_migrations`, **et seulement si ses
objets ont réellement disparu** : voir « Dérouler un retour arrière » plus haut,
qui vaut pour les trois lots.

`0004_shared-enums.down.sql` défait **quatre** types et emploie donc le montage
en bloc unique décrit plus haut. Il en avait le besoin le plus immédiat des trois
fichiers multi-objets : `mission_status` est le premier de sa liste et il est
porté par `idempotency_witness.status` (`0007`), si bien que le simple fait de
jouer ce fichier sur une base à jour faisait disparaître les trois autres types
avant que le contrôle final ne refuse — sans qu'aucune commande du dépôt ne le
signale ensuite.

`0005_outbox.down.sql` va plus loin et **refuse la suppression tant qu'il reste
des messages non traités** : un retour arrière ne doit pas faire disparaître sans
bruit une notification due à un intervenant engagé. Le comptage et le
`DROP TABLE` sont **dans un seul bloc `DO`, donc indissociables**, et l'ordre des
deux n'y suffisait pas : séparés en deux énoncés, `psql` les dissociait — il les
envoie séparément et poursuit après un refus — et la table partait malgré le
refus, avec ses messages non envoyés. Un garde-fou qui se contourne par la façon
d'invoquer le fichier ne garde rien. Pour forcer, drainer ou exporter la file
d'abord :

```sql
\copy (SELECT * FROM public.outbox WHERE processed_at IS NULL) TO 'outbox-en-attente.csv' CSV HEADER
```

---

## Comptes SQL

Deux comptes distincts, conformément à `docs/security.md` (réduire l'impact d'un
compte compromis).

| Compte | Usage | Droits |
|---|---|---|
| compte de migration | applique les migrations, purges de rétention | propriétaire du schéma |
| `fire_support_app` | trafic applicatif | `USAGE` sur `public`, plus les droits accordés table par table |

`fire_support_app` n'est ni superutilisateur, ni créateur de base ou de rôle, et
n'a **aucun droit de création dans le schéma**. Une injection SQL réussie ne peut
donc pas y installer de fonction ni de table durable.

Le refus par défaut de `docs/permissions.md` s'applique aussi aux comptes
techniques : **aucun `ALTER DEFAULT PRIVILEGES` n'accorde de droit large**. Une
table créée par un lot futur est invisible pour l'application tant que sa
migration n'a pas écrit son `GRANT` explicite. Oublier un droit provoque une
erreur immédiate et visible ; un droit accordé en trop ne se remarque jamais.

Droits en vigueur à la fin du lot 0 :

| Table | `fire_support_app` |
|---|---|
| `outbox` | `SELECT`, `INSERT`, `UPDATE` |
| `audit_logs` | `SELECT`, `INSERT` |
| `idempotency_witness` | aucun |

### Attribution du mot de passe applicatif

Le rôle est créé `NOLOGIN` et **sans mot de passe** : une migration est un
fichier versionné, un secret n'y a pas sa place (`CLAUDE.md`). Ouvrir la
connexion est une étape d'exploitation, exécutée hors du dépôt.

En interactif, méthode à privilégier — `\password` calcule le vérificateur SCRAM
côté client, le mot de passe en clair ne quitte jamais le poste et n'apparaît
donc ni dans les journaux du serveur, ni dans `pg_stat_statements` :

```text
psql "$DATABASE_MIGRATION_URL"
ALTER ROLE fire_support_app LOGIN;
\password fire_support_app
```

En script, sans interaction — `\getenv` lit la variable d'environnement sans la
faire transiter par la ligne de commande, où `ps` la rendrait visible à tout
utilisateur de la machine :

```text
\getenv app_password APPUI_FEUX_APP_DB_PASSWORD
ALTER ROLE fire_support_app LOGIN;
ALTER ROLE fire_support_app PASSWORD :'app_password';
```

Cette seconde forme envoie le mot de passe en clair au serveur : elle n'est
acceptable que si `log_statement` n'inclut pas les DDL, ou derrière un
gestionnaire de secrets qui déclenche une rotation. Rotation, séparation par
environnement et interdiction de partage : `docs/security.md`.

Le mot de passe local de développement vit dans `.env.local`, ignoré par git. Il
n'est jamais recopié dans `.env.example`, ni dans un message d'erreur, ni dans un
journal : la chaîne de connexion affichée par les scripts est toujours caviardée.

---

## Rétention et purge

`docs/privacy-rgpd.md` impose une limitation de conservation, et
`docs/operations.md` une maintenance périodique. Les deux tables du socle
grossissent indéfiniment sans purge. Le socle prépare la purge mais ne
l'exécute pas : les durées doivent être validées juridiquement avant d'être
inscrites dans un script (`docs/privacy-rgpd.md`, avertissement final).

### `outbox`

Éligibles : les messages traités, c'est-à-dire `processed_at IS NOT NULL`.
`idx_outbox_processed_at` couvre la sélection.

```sql
DELETE FROM public.outbox
WHERE processed_at IS NOT NULL
  AND processed_at < now() - interval '30 days';
```

L'application **n'a pas** le droit `DELETE` sur `outbox` : la purge est une tâche
d'exploitation exécutée avec le compte de migration. Séparer les deux évite qu'un
défaut de drainage se traduise par un effacement irréversible de messages jamais
envoyés.

### `audit_logs`

La table est append-only : `UPDATE`, `DELETE` et `TRUNCATE` sont refusés par un
déclencheur, pour tout le monde, **y compris le superutilisateur**. C'est
volontaire — les droits SQL ne protègent que du rôle auquel on a pensé, alors
qu'un déclencheur s'applique aussi à un rôle ajouté plus tard ou à un `GRANT ALL`
accidentel.

#### Convention de casse de `target_type` et `action`

Les deux colonnes sont contraintes au format `^[A-Z][A-Z0-9_]{2,63}$`, donc en
majuscules avec séparateur bas. Ce point mérite d'être signalé parce qu'il **ne
suit pas** la casse des entités du modèle de domaine : `docs/domain-model.md`
nomme les entités `Organization`, `Resource`, `Mission`, `OperationalRequest`,
en casse Pascal.

Écrire `'Resource'` dans `target_type` échoue donc sur la contrainte, avec un
message qui ne dit pas pourquoi. Il faut écrire `RESOURCE`.

La raison de ce choix : `target_type` et `action` sont des **codes stables
destinés à être filtrés, agrégés et comparés**, au même titre que les codes
d'erreur de `docs/api-contract.md` que `docs/coding-standards.md` impose en
majuscules. Une valeur en casse Pascal invite à la dérive — `Resource`,
`resource`, `RESOURCE` finiraient par coexister dans la même colonne et à
casser tout filtrage. La contrainte rend la dérive impossible plutôt que
déconseillée.

Valeurs en usage à ce jour :

```text
MEETING_POINT   MISSION   OFFER   OPERATIONAL_REQUEST
ORGANIZATION    OUTBOX_MESSAGE    PLATFORM   RESOURCE_DOCUMENT
```

Correspondance à retenir : entité `OperationalRequest` du modèle de domaine
donne `OPERATIONAL_REQUEST` dans `target_type`.

La purge de rétention est la seule exception, et elle doit se déclarer :

```sql
SET LOCAL appui_feux.audit_purge = 'on';
DELETE FROM public.audit_logs
WHERE occurred_at < now() - interval '5 years';
```

Trois propriétés de ce mécanisme :

- un `DELETE` ordinaire, y compris tapé à la main en console, échoue ;
- `UPDATE` et `TRUNCATE` restent refusés **même** avec le paramètre posé : une
  purge de rétention est sélective par ancienneté, jamais totale, et une
  réécriture n'est jamais une purge ;
- poser le paramètre ne suffit pas, il faut aussi détenir le droit `DELETE`, que
  le compte applicatif n'a pas. Les deux verrous sont indépendants.

Toute purge doit être précédée d'une sauvegarde vérifiée (`docs/operations.md`) :
c'est la seule opération du produit qui détruit de la preuve.

**Limite connue, à ne pas se cacher.** Le déclencheur protège le contenu contre
le DML, pas la table contre le DDL. `DROP TABLE public.audit_logs`, ou le
`DROP SCHEMA public CASCADE` que pratique `db:reset`, emportent le journal sans
que le déclencheur ait son mot à dire — PostgreSQL n'offre aucun moyen d'y
opposer un déclencheur au niveau d'une table. Ce qui protège réellement du DDL
est ailleurs : le compte applicatif n'a aucun droit de schéma (`0002`), et
`db:reset` doit refuser de s'exécuter hors `APP_ENV` local ou test, au même titre
que le seed. Les deux verrous de la table couvrent la menace réaliste — un compte
applicatif compromis — et non un compte de migration compromis, qui relève de la
gestion des secrets et de la sauvegarde.

---

## Point ouvert à arbitrer avant le lot 5 : portée de `client_event_id`

**Les deux documents de conception se contredisent.**

- `docs/domain-model.md` : « `clientEventId` unique par acteur **ou** mission ».
- `docs/database-design.md` : « index unique sur `client_event_id` », donc une
  portée globale.

Une portée par acteur accepte que deux acteurs présentent le même identifiant ;
une portée globale la refuse. Les deux ne peuvent pas être vrais.

**Ce qui est fait, et pourquoi.** Le socle implémente la portée **globale**, la
plus stricte, dans `0007_idempotency-witness.sql`. Le sens de l'évolution n'est
pas symétrique :

- global → par acteur est un **relâchement** : toutes les lignes existantes
  satisfont déjà la nouvelle contrainte, la migration ne peut pas échouer ;
- par acteur → global est un **durcissement** : si deux acteurs ont déjà réutilisé
  le même identifiant, la création de l'index unique échoue, en production, et il
  faut arbitrer quelles lignes historiques modifier.

Commencer strict laisse les deux portes ouvertes ; commencer permissif en ferme
une. **Ce n'est pas un arbitrage, c'est un report** : la décision appartient au
lot 5 et doit être inscrite dans `docs/decision-log.md`, avec correction de l'un
des deux documents.

**Coût d'un passage ultérieur à une portée par acteur**

- *Schéma* : faible. `CREATE UNIQUE INDEX CONCURRENTLY` sur
  `(actor_user_id, client_event_id)` puis `DROP INDEX CONCURRENTLY` sur l'ancien,
  sans verrouiller la table, sans reprise de données.
- *Code* : la détection de rejeu porte sur un couple. Un acteur système n'ayant
  pas d'`actor_user_id`, il faut une valeur sentinelle ou un index partiel
  supplémentaire : PostgreSQL considère deux `NULL` comme distincts, et
  l'unicité disparaîtrait exactement là où elle protégeait le plus.
- *Sécurité* : la protection contre un rejeu par un acteur **différent** est
  perdue. Cas concret : un coordinateur rejoue la requête d'un contributeur
  captée sur le réseau. Portée globale, le rejeu est absorbé ; portée par acteur,
  il produit un second effet.

**Une difficulté supplémentaire que les documents ne signalent pas.**
`docs/api-contract.md` attache un `clientEventId` à des mutations qui écrivent
dans des **tables différentes** : soumission de proposition, acceptation,
transition de mission, déclaration d'incident. Un index unique par table ne rend
donc pas l'identifiant globalement unique — il le rend unique *par table*. Une
portée réellement globale suppose un **registre central d'idempotence** : une
table unique où chaque mutation critique réserve son identifiant avant d'agir.
La table témoin démontre la faisabilité d'un tel registre, puisqu'elle est
précisément une table unique et transverse.

Trois options à départager :

| Option | Ce qu'elle garantit | Ce qu'elle coûte |
|---|---|---|
| (a) registre central `idempotency_keys` | unicité réellement globale | une écriture supplémentaire par mutation critique |
| (b) index unique par table | simple, aucun coût | unicité seulement locale ; le document ne dit pas laquelle il décrit |
| (c) portée par acteur | conforme à `docs/domain-model.md` | perte de la protection contre le rejeu inter-acteurs |

---

## Table témoin `idempotency_witness`

**Table provisoire, supprimée par la migration du lot 5.** Elle n'est pas
utilisable par le code applicatif, et aucun `GRANT` ne lui est accordé.

Elle existe parce que les deux garanties les plus critiques du produit ne peuvent
pas être vérifiées applicativement sans fenêtre de concurrence : deux
transactions simultanées liront toutes deux « aucune mission en cours » avant que
l'une n'écrive. Seule une contrainte d'unicité tranche, et il vaut mieux le
prouver au lot 0 que le découvrir au lot 5. Elle porte donc :

- `uq_idempotency_witness_client_event_id` — unicité globale de `client_event_id` ;
- `uq_idempotency_witness_active_resource` — index unique partiel
  `WHERE status NOT IN ('COMPLETED', 'CANCELLED')`, transcription directe de la
  règle critique de `docs/state-machines.md`.

`INCIDENT` **n'est pas** un état terminal : `docs/state-machines.md` autorise
`INCIDENT → RETURNING`, `→ COMPLETED` et `→ CANCELLED`. Une ressource dont la
mission est en incident reste engagée et ne peut pas en recevoir une seconde.

Le lot 5 reprend ces deux index sur `missions` et `mission_events`, puis supprime
la table témoin dans la même migration.

---

## Appliquer et vérifier

```bash
npm run db:up        # démarre le conteneur PostgreSQL local
npm run db:migrate   # applique les migrations en attente
npm run db:status    # appliquées, en attente, dérives, manquantes
npm run db:reset     # recrée le schéma public et rejoue tout
npm run db:seed      # jeu de démonstration, refusé hors APP_ENV local ou test
```

`db:reset` supprime et recrée le schéma `public`, ce qui **supprime aussi
PostGIS**, installé dans ce schéma. C'est sans conséquence : `0001` le réinstalle
au rejeu. En revanche, le compte utilisé par `db:reset` doit pouvoir créer une
extension — `0001` est la seule migration à l'exiger, PostGIS n'étant pas une
extension `trusted`.

Le seed n'est jamais appliqué en production (`backlog/release-checklist.md`,
« seed absent de production »). Le refus est câblé dans le script, pas confié à
la discipline de l'exploitant.

### Vérifier une migration avant de la proposer

`docs/database-design.md` exige un test sur base vide **et** sur base existante.
Sur une base jetable, pour ne laisser aucun état parasite :

```bash
docker exec appui-feux-db psql -U fire_support -d postgres \
  -c "DROP DATABASE IF EXISTS fire_support_probe;" \
  -c "CREATE DATABASE fire_support_probe TEMPLATE template1;"

for f in supabase/migrations/*.sql; do
  case "$f" in *.down.sql) continue ;; esac   # les retours arrière ne s'appliquent pas
  docker exec -i appui-feux-db psql -U fire_support -d fire_support_probe \
    -v ON_ERROR_STOP=1 --single-transaction -q -f - < "$f"
done
```

Rejouer la même boucle une seconde fois : les migrations sont idempotentes
(`IF NOT EXISTS`, `CREATE OR REPLACE`, test d'existence explicite pour les types
énumérés, que `CREATE TYPE` ne sait pas faire). Seuls des `NOTICE` doivent
apparaître. Cette idempotence est une ceinture, pas la protection principale :
c'est `schema_migrations` qui empêche un second passage.

Pour vérifier les droits du compte applicatif sans lui attribuer de mot de
passe, `SET ROLE` suffit — un superutilisateur qui prend le rôle perd ses
privilèges pour la session :

```sql
SET ROLE fire_support_app;
-- doit échouer : permission denied for schema public
CREATE TABLE public.tentative (id int);
RESET ROLE;
```

### Sauvegarde et restauration

Fréquence, rétention, chiffrement, séparation des accès et preuve du test de
restauration : `docs/operations.md`. Une purge de rétention et un retour arrière
de schéma ne s'exécutent jamais sans sauvegarde vérifiée préalable.

---

## Migrations du lot 1 — identité

| N° | Objet | Retour arrière |
|---|---|---|
| `0008` | Extension `citext` | note en tête, pas de `.down.sql` |
| `0009` | Types énumérés du domaine identité | `.down.sql`, deux types en bloc unique |
| `0010` | Table `user_profiles` | `.down.sql`, avec avertissement |
| `0011` | Table `auth_challenges` (codes à usage unique) | `.down.sql` |
| `0012` | Table `auth_attempts` (limitation de tentatives) | `.down.sql` |
| `0013` | Table `sessions` | `.down.sql`, avec procédure d'export |

### Stratégie de retour

`0008` ne fournit pas de retour arrière, pour la raison exacte de `0001` :
`DROP EXTENSION citext` cascaderait sur `user_profiles.email`, donc sur
l'identifiant de connexion de tous les comptes. Une extension laissée en place
est inerte pour une version antérieure du code.

Les cinq autres en fournissent un, **sans `CASCADE`**, et ils doivent être
déroulés dans l'ordre inverse : `0013`, `0012`, `0011`, `0010`, `0009` — et,
depuis le lot organisations, seulement après `0017` à `0014`. Commande et
vérification : « Dérouler un retour arrière ». Tout autre ordre est refusé par
PostgreSQL, et c'est le comportement recherché. Vérifié en conditions réelles :

- `0009.down` avant `0010.down` → `cannot drop type user_profile_status because
  other objects depend on it` ;
- `0010.down` avant `0011.down` et `0013.down` → `cannot drop table
  user_profiles because other objects depend on it`.

Deux effets de bord à connaître avant de déclencher un retour arrière :

- `0012.down` **lève tous les blocages en cours**. Ne pas le déclencher en
  réaction à une campagne de tentatives, elle reprendrait sans limite.
- `0013.down` **déconnecte tout le monde** — c'est le sens sûr — mais efface
  aussi la trace des sessions ayant existé. Si une analyse d'incident est en
  cours, exporter d'abord ; la commande est dans l'en-tête du fichier, et elle
  exclut volontairement `token_hash`.

### Droits en vigueur à la fin du lot 1

| Table | `fire_support_app` |
|---|---|
| `user_profiles` | `SELECT`, `INSERT`, `UPDATE` |
| `auth_challenges` | `SELECT`, `INSERT`, `UPDATE` |
| `auth_attempts` | `SELECT`, `INSERT`, `UPDATE` |
| `sessions` | `SELECT`, `INSERT`, `UPDATE` |

**Aucun `DELETE` nulle part**, et l'omission est délibérée dans les quatre cas :

- `user_profiles` — la clôture d'un compte est un statut (`CLOSED`), pas une
  suppression. Une suppression physique emporterait en cascade les sessions et
  les défis, et ferait perdre le lien des lignes d'audit déjà écrites ;
- `sessions` — la déconnexion est un marquage (`revoked_at`). `DELETE` offrirait
  à un compte applicatif compromis le moyen d'effacer la trace des sessions
  qu'il a ouvertes, c'est-à-dire ce qui permet de constater l'intrusion ;
- `auth_attempts` — supprimer un compteur revient à lever un blocage. La levée
  normale est l'écoulement du temps ;
- `auth_challenges` — la purge par ancienneté est une tâche d'exploitation, au
  même régime que celle d'`outbox`.

### Convention d'empreinte des quatre colonnes hachées

Cinq colonnes du lot 1 sont contraintes au format `^[0-9a-f]{64}$` :
`auth_challenges.identifier_hash`, `auth_challenges.code_hash`,
`auth_attempts.subject_hash`, `sessions.token_hash`, `sessions.ip_hash`. La
contrainte interdit structurellement d'y écrire la valeur en clair — « 482913 »
et « 192.168.1.1 » ne satisfont pas le motif — exactement comme
`audit_logs.ip_hash` du lot 0.

**Ce que la contrainte ne dit pas, et qui relève du code.** Un condensé de
64 caractères hexadécimaux peut être un SHA-256 nu comme un HMAC-SHA-256 ; SQL
ne les distingue pas. Or les deux ne protègent pas la même chose :

| Colonne | Entropie de la valeur d'origine | Algorithme exigé |
|---|---|---|
| `identifier_hash` | un courriel, un téléphone : devinable par dictionnaire | **HMAC**-SHA-256, secret hors base |
| `code_hash` | six chiffres : un million de possibilités | **HMAC**-SHA-256, secret hors base |
| `subject_hash` | un identifiant, une IPv4 : quatre milliards au plus | **HMAC**-SHA-256, secret hors base |
| `token_hash` | jeton tiré au hasard sur ≥ 128 bits | SHA-256 nu suffisant |
| `ip_hash` | une adresse IP | **HMAC**-SHA-256, secret hors base |

Un condensé nu d'une valeur à faible entropie s'inverse par énumération
exhaustive en quelques secondes : il ne protège rien. Le secret doit venir du
gestionnaire de secrets (`docs/security.md`), jamais de la base — sans quoi le
vol d'une sauvegarde rendrait la clé avec les empreintes.

`subject_hash` porte une exigence supplémentaire : le texte haché doit être
**préfixé par un marqueur de dimension** (`identifier:`, `source:`, `pair:`).
Sans préfixe, deux dimensions différentes pourraient produire la même empreinte
et partager un compteur, et un sujet serait bloqué par les tentatives d'un
autre.

### Valeurs de `target_type` ajoutées par le lot 1

La convention de casse décrite plus haut s'applique sans changement : majuscules
et séparateur bas, `^[A-Z][A-Z0-9_]{2,63}$`. Écrire `'UserProfile'` échoue.

```text
AUTH_CHALLENGE   SESSION   USER_PROFILE
```

Correspondance à retenir : l'entité `UserProfile` de `docs/domain-model.md`
donne `USER_PROFILE` dans `target_type`.

### Rétention et purge des tables du lot 1

Trois tables croissent sans limite naturelle. Comme pour `outbox` et
`audit_logs`, les requêtes sont préparées mais **les durées restent à valider
juridiquement** (`docs/privacy-rgpd.md`, avertissement final), et la purge
s'exécute avec le compte de migration, jamais avec le compte applicatif.

`auth_challenges` est la table qui grossit le plus vite : une ligne par demande
de code, y compris pour les identifiants inconnus, donc y compris pour chaque
tentative d'un robot. `idx_auth_challenges_expires_at` couvre la sélection.

```sql
DELETE FROM public.auth_challenges
WHERE expires_at < now() - interval '30 days';
```

`auth_attempts` : les compteurs dormants, dont la fenêtre est écoulée depuis
longtemps et qui ne bloquent plus personne. `idx_auth_attempts_window_started_at`
couvre la sélection.

```sql
DELETE FROM public.auth_attempts
WHERE window_started_at < now() - interval '30 days'
  AND (blocked_until IS NULL OR blocked_until < now());
```

`sessions` : les sessions expirées depuis longtemps.
`idx_sessions_expires_at` couvre la sélection. À ne pas confondre avec la
révocation, qui n'efface rien.

```sql
DELETE FROM public.sessions
WHERE expires_at < now() - interval '90 days';
```

### Ce qui rend une session valide

Quatre conditions, toutes nécessaires, à vérifier côté serveur à chaque requête :

```sql
   sessions.revoked_at IS NULL
AND sessions.expires_at > now()
AND (user_profiles.sessions_revoked_at IS NULL
     OR sessions.issued_at > user_profiles.sessions_revoked_at)
AND user_profiles.status = 'ACTIVE'
```

La révocation globale s'appuie sur `user_profiles.sessions_revoked_at` : une
seule écriture coupe tous les accès d'un compte, sans parcourir ni mettre à jour
la table des sessions. La comparaison est **stricte** — une session émise à
l'instant exact de la révocation est invalide, parce que dans le doute on coupe.
Corollaire pour le code : `sessions.issued_at` ne doit **jamais** être réavancé,
sinon une session révoquée globalement redeviendrait valide en se rafraîchissant
elle-même. Prolonger une session consiste à repousser `expires_at`.

La quatrième condition porte sur une autre table et c'est celle qu'on oublie.
L'omettre laisserait une session ouverte survivre à la suspension du compte,
c'est-à-dire à la première mesure de réponse à incident de `docs/security.md`.
`docs/permissions.md` en fait un cas de test obligatoire, « accès après
suspension ».

### Point ouvert : l'adhésion suspendue ne coupe pas encore l'accès

`docs/permissions.md` exige qu'une adhésion suspendue coupe l'accès. Cette
**cinquième condition n'est pas réalisable au lot 1** : `organization_members`
n'existe pas encore (US-012 et US-014). Le lot qui crée la table doit ajouter la
condition à la liste ci-dessus et la couvrir par un test d'accès dédié. Tant que
ce n'est pas fait, seule la suspension du **compte** coupe l'accès, pas la
suspension d'une **adhésion**.

> **Point clos par les migrations `0014` à `0017`.** La table existe désormais.
> La cinquième condition, sa formulation exacte et le contrat de non-mise en
> cache sont dans « Ce qui rend un rôle effectif », plus bas.

---

## Migrations du lot 1 — organisations

| N° | Objet | Retour arrière |
|---|---|---|
| `0014` | Types énumérés du domaine organisations | `.down.sql`, cinq types en bloc unique |
| `0015` | Table `organizations` | `.down.sql`, avec avertissement |
| `0016` | Table `organization_members` | `.down.sql`, avec procédure d'export |
| `0017` | Registre central d'idempotence `idempotency_keys` | `.down.sql`, avec avertissement |

### Vocabulaire arrêté — valeurs à employer telles quelles

Cinq types énumérés sont créés par `0014`. Ils sont la référence unique : la
règle de `0004` s'applique sans exception, **aucune colonne de statut ne doit
être déclarée en `text` avec une contrainte `CHECK`**.

| Type PostgreSQL | Valeurs |
|---|---|
| `organization_type` | `OPERATIONAL_SERVICE`, `LOCAL_AUTHORITY`, `COMPANY`, `ASSOCIATION`, `FARM` |
| `organization_verification_status` | `PENDING`, `VERIFIED`, `REJECTED` |
| `organization_status` | `ACTIVE`, `SUSPENDED`, `CLOSED` |
| `organization_member_role` | `CONTRIBUTOR`, `COORDINATOR`, `ORG_ADMIN`, `PLATFORM_ADMIN`, `OBSERVER` |
| `organization_member_status` | `INVITED`, `ACTIVE`, `SUSPENDED`, `REVOKED` |

Trois précisions qui évitent une erreur silencieuse.

1. **`organization_type` est plus large que les exemples qui l'ont inspiré.**
   `docs/seed-data.md` cite un « service incendie territorial » et une
   « commune » ; le référentiel retient `OPERATIONAL_SERVICE` et
   `LOCAL_AUTHORITY`, qui les contiennent. Écrire `FIRE_SERVICE` ou
   `MUNICIPALITY` échoue — c'est exactement l'écart que les blocs de seed
   préparés au lot 0 portaient, et qu'il a fallu corriger à leur activation.
2. **`verification_status` et `status` sont deux axes indépendants.** Le
   premier répond à « cette structure est-elle celle qu'elle prétend être ? »,
   le second à « ce compte d'organisation est-il utilisable ? ». Une
   organisation en attente de vérification est `verification_status = 'PENDING'`
   et `status = 'ACTIVE'` : son administrateur peut travailler, mais toute
   action sensible lui est refusée par `ORGANIZATION_NOT_VERIFIED`. Écrire
   `'PENDING'` dans `status` échoue, la valeur n'existe pas dans ce type.
3. **L'ordre de `organization_member_role` n'est PAS une hiérarchie.** Il suit
   l'ordre de `docs/permissions.md`, où `OBSERVER` figure en dernier alors
   qu'il est le rôle le moins capable. Une garde écrite
   `role >= 'ORG_ADMIN'` accorderait donc à un observateur les droits d'un
   administrateur d'organisation. Les gardes énumèrent les rôles autorisés,
   action par action ; elles ne comparent jamais l'ordre du type. C'est la
   différence avec `user_verification_level` de `0009`, dont l'ordre est
   volontairement significatif.

### Colonnes de `organizations`

`id`, `name`, `type`, `registration_number`, `registration_number_normalized`,
`territory_code`, `verification_status`, `status`, `version`, `created_at`,
`updated_at`.

- `registration_number` est stocké **tel qu'il a été saisi**, séparateurs
  compris : un numéro d'immatriculation se lit par groupes, et normaliser
  l'affichage appauvrirait la vérification humaine d'US-013.
- `registration_number_normalized` est une colonne **générée par le serveur**
  (majuscules, caractères non alphanumériques retirés). C'est elle qui porte
  l'unicité, et elle **refuse toute écriture directe** : `INSERT` ou `UPDATE`
  qui la mentionne échoue avec `cannot insert a non-DEFAULT value into column`.
  Ce n'est pas une commodité : une normalisation faite côté application
  divergerait entre une route, une reprise de données et une console, et
  l'unicité ne porterait plus sur la même chose selon l'origine de la ligne.
  `123 456 789 00012` et `123-456-789/00012` sont donc le même numéro.
- `version` est contrainte `> 0`. Le contrat pour le code est explicite :
  l'incrément appartient à l'`UPDATE` lui-même, avec
  `WHERE version = $expectedVersion`. Un incrément par déclencheur rendrait
  l'écriture concurrente indétectable, et `VERSION_CONFLICT` ne serait jamais
  levé.
- `territory_code` accepte `NULL`, pour une organisation sans périmètre
  déclaré. Conséquence à connaître : un filtre `territory_code = ...` exclut
  ces lignes. Le lot qui activera le filtrage territorial de
  `docs/permissions.md` devra décider s'il les inclut ou rend la colonne
  obligatoire, et l'inscrire dans `docs/decision-log.md`.

### Colonnes de `organization_members`

`organization_id`, `user_id`, `role`, `status`, `valid_from`, `valid_until`,
`created_at`, `updated_at`.

**Pas de colonne `id`.** La clé primaire est composite,
`(organization_id, user_id)`, et la conséquence est voulue : une personne
détient **au plus un rôle par organisation**. Deux adhésions concurrentes
auraient obligé chaque garde à choisir entre elles, et le choix le plus naturel
— retenir la plus permissive — aurait transformé une adhésion oubliée en
élévation de privilèges silencieuse. Appartenir à **plusieurs** organisations
reste possible, avec des rôles et des statuts différents ; c'est le cas que le
bloc de seed `003` installe volontairement.

### Ce qui rend un rôle effectif

Trois conditions, toutes nécessaires, **relues à chaque requête** :

```sql
   organization_members.status = 'ACTIVE'
AND organization_members.valid_from <= now()
AND (organization_members.valid_until IS NULL
     OR organization_members.valid_until > now())
```

C'est la **cinquième condition** annoncée par la section « Ce qui rend une
session valide », et le point ouvert laissé par US-010 est ainsi clos. Trois
propriétés de cette formulation, qui ne sont pas des détails :

- `valid_from <= now()` — une adhésion datée du futur n'ouvre rien. Sans cette
  borne, préparer une adhésion à l'avance l'activerait aussitôt ;
- `valid_until > now()`, comparaison **stricte** — à la seconde exacte de
  l'échéance, l'adhésion est déjà close. Même choix que `sessions_revoked_at` :
  dans le doute, on coupe ;
- `status = 'ACTIVE'`, **énuméré et non « différent de SUSPENDED »**. Une valeur
  ajoutée plus tard au type serait alors refusée par défaut.

L'expiration est portée par des **données**, pas par une tâche de fond : une
adhésion cesse d'ouvrir l'accès à l'instant dit, même si aucun traitement ne
tourne. Un travail périodique qui basculerait le statut laisserait l'accès
ouvert entre l'échéance et son prochain passage.

**Aucun cache.** `docs/architecture.md` interdit de cacher les autorisations
critiques, et la raison est directe : un rôle mis en cache survivrait à sa
propre suspension pendant la durée du cache, c'est-à-dire pendant la fenêtre
exacte que la suspension existe pour fermer. Le coût réel est une lecture sur la
clé primaire de `organization_members`.

**Deux gardes, pas une.** L'adhésion dit ce que la personne peut faire ; elle ne
dit pas si l'organisation a le droit d'agir. Une action sensible exige aussi
`organizations.verification_status = 'VERIFIED'` — sinon
`ORGANIZATION_NOT_VERIFIED` — et `organizations.status = 'ACTIVE'`. Le jeu de
démonstration porte précisément ce cas : l'administrateur de « Travaux Publics
Horizon » a une adhésion parfaitement valide dans une organisation qui ne l'est
pas encore.

### Index du lot

| Index | Objet |
|---|---|
| `uq_organizations_registration_number` | unicité de l'immatriculation **normalisée**, globale — elle couvre aussi les organisations rejetées et closes, pour qu'un refus ne se contourne pas par une seconde déclaration |
| `idx_organizations_verification_status` | file d'administration (`écran 10`, `GET /admin/organizations/pending`) — partiel `WHERE verification_status <> 'VERIFIED'`, trié `created_at` croissant : une file se traite du plus ancien au plus récent |
| `idx_organizations_territory_code` | filtrage territorial ; complet, donc indexe aussi les lignes sans territoire |
| `organization_members_pkey` | `(organization_id, user_id)` — sert aussi le listage des membres d'une organisation |
| `idx_organization_members_user_status` | `(user_id, status)` — résolution du rôle à chaque requête |
| `uq_idempotency_keys_client_event_id` | unicité globale de `client_event_id` |
| `idx_idempotency_keys_created_at` | sélection de la purge par ancienneté |

**Aucun index supplémentaire sur `organization_members(organization_id)`**, et
l'absence est délibérée : l'index unique qui porte la clé primaire a cette
colonne en tête et couvre déjà ce sens de lecture. En créer un second serait un
doublon — coût d'écriture à chaque mutation, aucun gain de lecture.

### Registre central d'idempotence `idempotency_keys`

`0017` livre la table dont `docs/api-contract.md` a besoin pour
`IDEMPOTENCY_CONFLICT` : `id`, `client_event_id`, `operation`, `actor_user_id`,
`request_fingerprint`, `target_type`, `target_id`, `result`, `created_at`,
`updated_at`.

**À ne pas confondre avec `idempotency_witness`** (`0007`), qui reste une table
témoin sans aucun `GRANT`, interdite au code applicatif et supprimée par la
migration du lot 5. Les deux coexistent ; l'application n'écrit que dans
`idempotency_keys`.

Séquence attendue, dans **une seule** transaction :

1. `INSERT` de la réservation ; `23505` signifie « déjà vu » ;
2. la mutation métier, l'audit et l'écriture dans `outbox` ;
3. `UPDATE` de la ligne réservée avec la cible produite et la réponse à rejouer.

Sur `23505`, relire la ligne existante :

- `request_fingerprint` **identique** — rejeu légitime, renvoyer `result` sans
  nouvel effet ;
- `request_fingerprint` **différent** — deux requêtes distinctes présentent la
  même clé, c'est `IDEMPOTENCY_CONFLICT`. Rejouer la première réponse serait
  pire que refuser : l'appelant croirait sa seconde demande satisfaite alors
  qu'elle n'a rien produit.

Ce que le registre ferme. `src/infrastructure/audit/audit-log.ts` détectait un
rejeu en relisant le journal d'audit, faute de registre, et documentait sa
limite : « deux rejeux strictement simultanés ne se voient pas l'un l'autre ».
Une réservation par insertion supprime cette fenêtre — la seconde transaction se
bloque sur l'index unique jusqu'à ce que la première tranche.

#### La portée de `client_event_id` reste un point ouvert

`0017` **ne tranche pas** la contradiction décrite plus haut. Il applique la
portée **globale** de `0007`, par cohérence et pour la même raison d'asymétrie :
global vers par acteur est un relâchement qui ne peut pas échouer, l'inverse est
un durcissement qui échoue en production. La décision appartient toujours au
lot 5 et doit être inscrite dans `docs/decision-log.md`, avec correction de l'un
des deux documents de conception.

Deux choix de schéma servent uniquement à garder ce report peu coûteux :

- la clé primaire est une colonne de substitution, **pas** `client_event_id` :
  une clé primaire ne se remplace pas sans verrou exclusif, alors qu'un index
  unique ordinaire se remplace à chaud par
  `CREATE UNIQUE INDEX CONCURRENTLY` puis `DROP INDEX CONCURRENTLY` ;
- `actor_user_id` est **déjà stocké** bien qu'il n'entre pas dans l'unicité : la
  colonne serait irremplissable rétroactivement le jour où l'index en aurait
  besoin.

Le registre lui-même est l'option (a) du tableau des trois options, rendue
**disponible** et non imposée : si le lot 5 retient la portée par acteur, la
table reste correcte, seul son index unique change.

### Convention d'empreinte, valeur ajoutée par ce lot

`idempotency_keys.request_fingerprint` rejoint les cinq colonnes contraintes au
format `^[0-9a-f]{64}$`, et il relève du même régime que `identifier_hash` ou
`code_hash` :

| Colonne | Entropie de la valeur d'origine | Algorithme exigé |
|---|---|---|
| `request_fingerprint` | un corps de requête : un nom, un type pris dans cinq valeurs, un numéro à format connu | **HMAC**-SHA-256, secret hors base |

Un condensé nu d'un corps de requête s'inverse par énumération : il révélerait
exactement le contenu que la colonne existe pour ne pas stocker. Le secret vient
du gestionnaire de secrets (`docs/security.md`), jamais de la base.

### Valeurs de `target_type` ajoutées par ce lot

La convention de casse ne change pas : majuscules et séparateur bas,
`^[A-Z][A-Z0-9_]{2,63}$`. Écrire `'Organization'` échoue, avec un message qui ne
dit pas pourquoi.

```text
ORGANIZATION   ORGANIZATION_MEMBER
```

`ORGANIZATION` figurait déjà dans les valeurs en usage du lot 0.
`ORGANIZATION_MEMBER` est nouveau : l'entité `OrganizationMember` de
`docs/domain-model.md` donne `ORGANIZATION_MEMBER`, jamais `OrganizationMember`
ni `ORGANIZATION-MEMBER`.

Les mêmes codes servent à `outbox.aggregate_type`, dont la contrainte de forme
est identique.

### Droits en vigueur à la fin du lot organisations

| Table | `fire_support_app` |
|---|---|
| `organizations` | `SELECT`, `INSERT`, `UPDATE` |
| `organization_members` | `SELECT`, `INSERT`, `UPDATE` |
| `idempotency_keys` | `SELECT`, `INSERT`, `UPDATE` |

**Aucun `DELETE` nulle part**, et l'omission est délibérée dans les trois cas :

- `organizations` — la fermeture est un statut (`CLOSED`). Une suppression
  physique emporterait les adhésions et ferait perdre le lien des lignes d'audit
  déjà écrites, c'est-à-dire la preuve de ce qui a été publié au nom de
  l'organisation ;
- `organization_members` — retirer quelqu'un est un changement de statut
  (`REVOKED`) ou la pose d'un terme (`valid_until`). Les lignes d'audit portent
  `actor_organization_id` : effacer l'adhésion supprimerait le seul moyen de
  reconstituer à quel titre la personne agissait, et donnerait à un compte
  applicatif compromis le moyen d'effacer la trace de l'appartenance dont il
  s'est servi ;
- `idempotency_keys` — effacer une clé rend la commande correspondante
  **rejouable**, donc offre à un compte compromis le moyen de faire produire
  deux fois le même effet à une commande interceptée.

### Rétention et purge de `idempotency_keys`

Le registre croît d'une ligne par mutation critique et n'a aucune limite
naturelle. Comme pour les autres tables, la requête est préparée mais **la durée
reste à valider juridiquement** (`docs/privacy-rgpd.md`), et la purge s'exécute
avec le compte de migration. `idx_idempotency_keys_created_at` couvre la
sélection.

```sql
DELETE FROM public.idempotency_keys
WHERE created_at < now() - interval '90 days';
```

**Point de vigilance, à ne pas se cacher.** Purger une clé rend sa commande
rejouable. La fenêtre de rétention doit donc dépasser largement celle du mode
dégradé de `docs/offline-mode.md`, où une action peut rester en file locale sur
un téléphone hors réseau pendant plusieurs jours. Une purge trop agressive ne se
manifesterait pas par une erreur, mais par un second effet produit au retour du
réseau — exactement ce que l'idempotence existe pour empêcher.

### Stratégie de retour

Les quatre migrations fournissent un retour arrière, **sans `CASCADE`**, et ils
doivent être déroulés dans l'ordre inverse : `0017`, `0016`, `0015`, `0014`,
puis seulement `0013` et suivants. La procédure complète — commande, ordre,
vérification par `npm run db:status`, remontée par `npm run db:migrate` — est dans
« Dérouler un retour arrière ». Après ces quatre fichiers, `db:status` doit
signaler `0014` à `0017` **en attente** ; s'il annonce « La base est à jour », le
schéma et la table de suivi ont divergé et il ne faut rien déployer par-dessus.

Tout autre ordre est refusé par PostgreSQL, et c'est le comportement recherché.
Vérifié en conditions réelles :

- `0015.down` avant `0016.down` → `cannot drop table organizations because other
  objects depend on it` ;
- `0014.down` avant `0016.down` et `0015.down` → `cannot drop type
  organization_member_status because other objects depend on it`. **Un seul
  message**, et non cinq : le bloc unique s'arrête au premier type refusé, et les
  suppressions qu'il avait déjà faites sont annulées avec lui ;
- `0010.down` tant que `organization_members` existe → `cannot drop table
  user_profiles because other objects depend on it`, qui **cite désormais aussi**
  `organization_members_user_id_fkey` à côté des contraintes de `sessions` et de
  `auth_challenges`. La chaîne de retour du lot identité s'est allongée d'un
  cran.

Trois effets de bord à connaître avant de déclencher un retour arrière :

- `0015.down` **détruit des organisations**, et avec elles la trace des
  vérifications déjà prononcées. Les lignes d'`audit_logs` portant
  `target_type = 'ORGANIZATION'` survivent, elles — le journal ne référence
  aucune table par clé étrangère — et désigneront des identifiants sans ligne
  correspondante, ce qui est le comportement voulu ;
- `0016.down` **supprime tous les rôles**. Aucun rôle n'étant écrit ailleurs
  dans le schéma, plus personne n'est coordinateur ni administrateur. Les
  sessions ouvertes restent valides, elles ne dépendent pas de cette table :
  toute garde qui interroge l'appartenance doit alors **refuser**, par refus par
  défaut. C'est le sens sûr, et il faut le vérifier plutôt que l'espérer — une
  couche d'autorisation qui laisserait passer faute de table transformerait ce
  retour arrière en ouverture générale. La commande d'export de l'historique des
  mandats est dans l'en-tête du fichier ;
- `0017.down` **rend rejouable toute commande déjà exécutée**. Sur une base
  portant du trafic réel, la voie est un déploiement en plusieurs étapes.

### Blocs de seed activés par ce lot

`001_organizations.sql` et `003_organization-members.sql` étaient écrits et
inactifs depuis le lot 0 ; ils se sont activés d'eux-mêmes dès que `0015` et
`0016` ont créé leurs tables, sans qu'une ligne de `scripts/db/seed.ts` change.
Leur contenu a dû être **réaligné sur le schéma livré**, et les écarts corrigés
méritent d'être connus, parce qu'ils sont représentatifs de ce que produit un
bloc préparé avant que son vocabulaire n'existe :

| Bloc | Écart | Correction |
|---|---|---|
| `001` | `type = 'FIRE_SERVICE'` | `OPERATIONAL_SERVICE` |
| `001` | `type = 'MUNICIPALITY'` | `LOCAL_AUTHORITY` |
| `001` | `status = 'PENDING'` — valeur **inexistante** dans `organization_status`, confusion entre l'axe vérification et l'axe cycle de vie | `status = 'ACTIVE'`, la mise en attente restant portée par `verification_status` |
| `003` | colonne `id` — la table n'en a pas, sa clé est composite | colonne retirée |
| `003` | `ON CONFLICT (id)` — ne désignait plus aucune contrainte, la **seconde** exécution du seed aurait échoué | `ON CONFLICT (organization_id, user_id)` |

L'en-tête `@etat` des deux blocs passe de `inactif` à `actif`. Le tableau
d'état de `supabase/seed/README.md` doit être mis à jour en conséquence :
`001` et `003` ne sont plus « préparé » mais « actif ».

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
2. **Un fichier ne se découpe pas sur les points-virgules.** Les migrations
   contiennent des blocs `DO $$ ... $$` et des corps de fonctions qui incluent
   leurs propres `;`. Le fichier doit être envoyé au serveur d'un seul tenant.

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

---

## Migrations du socle (lot 0)

| N° | Objet | Retour arrière |
|---|---|---|
| `0001` | Extensions PostGIS et pgcrypto | note en tête, pas de `.down.sql` |
| `0002` | Rôle applicatif sans droit de schéma, durcissement de `public` | note en tête, pas de `.down.sql` |
| `0003` | Fonction partagée `set_updated_at()` | `.down.sql` |
| `0004` | Types énumérés des machines à états | `.down.sql` |
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

`0005_outbox.down.sql` va plus loin et **refuse la suppression tant qu'il reste
des messages non traités** : un retour arrière ne doit pas faire disparaître sans
bruit une notification due à un intervenant engagé. Pour forcer, drainer ou
exporter la file d'abord :

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
| `0009` | Types énumérés du domaine identité | `.down.sql` |
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
déroulés dans l'ordre inverse : `0013`, `0012`, `0011`, `0010`, `0009`. Tout
autre ordre est refusé par PostgreSQL, et c'est le comportement recherché.
Vérifié en conditions réelles :

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

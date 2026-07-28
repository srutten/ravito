# Jeu de données de démonstration

Ce répertoire contient le jeu décrit par `docs/seed-data.md`, découpé en blocs
numérotés. Il est chargé par `npm run db:seed`
(`scripts/db/seed.ts`).

Documents de référence : `docs/seed-data.md`, `docs/database-design.md`,
`docs/domain-model.md`, `docs/state-machines.md`, `docs/privacy-rgpd.md`,
`docs/security.md`, `backlog/release-checklist.md`.

---

## Ce que ce jeu charge aujourd'hui, et ce qu'il ne charge pas encore

`docs/seed-data.md` décrit un jeu complet : quatre organisations, six
utilisateurs, huit ressources, trois demandes, quatre propositions, trois
missions dans des états différents, un incident, des documents valides et
expirés. **La plupart de ces tables n'existent pas encore** : elles arrivent aux
lots 1 à 6.

Les quatorze blocs sont pourtant tous écrits. Ceux dont les tables manquent sont
**ignorés et annoncés**, avec le lot et la story qui les activeront. Ils
s'exécuteront d'eux-mêmes, sans qu'une ligne de `scripts/db/seed.ts` change, le
jour où la migration correspondante aura créé leurs tables.

| N° | Bloc | Tables | Lot | Stories | État au lot 0 |
|---|---|---|---|---|---|
| `001` | Organisations | `organizations` | 1 | US-012, US-013 | préparé |
| `002` | Profils utilisateur | `user_profiles` | 1 | US-010 | préparé |
| `003` | Appartenances | `organization_members` | 1 | US-014 | préparé |
| `004` | Catégories de ressources | `resource_categories` | 2 | US-020 | préparé |
| `005` | Ressources | `resources` | 2 | US-020, US-021 | préparé |
| `006` | Documents de ressource | `resource_documents` | 2 | US-022 | préparé |
| `007` | Points de rassemblement | `meeting_points` | 3 | US-032 | préparé |
| `008` | Demandes et exigences | `operational_requests`, `request_requirements` | 3 | US-030, US-031, US-033 | préparé |
| `009` | Propositions | `offers` | 4 | US-041, US-043 | préparé |
| `010` | Missions | `missions` | 5 | US-050 → US-056 | préparé |
| `011` | Événements de mission | `mission_events` | 6 | US-052 → US-056 | préparé |
| `012` | Incident | `incidents` | 6 | US-060, US-061 | préparé |
| `013` | File de notifications | `outbox` | 0 | US-002 | **actif** |
| `014` | Journal d'audit | `audit_logs` | 0 | US-002, US-090 | **actif** |

Les blocs `013` et `014` sont actifs dès maintenant parce que `outbox` et
`audit_logs` existent depuis le socle, et surtout parce que ces deux tables ne
portent **aucune clé étrangère** — décision explicite de `0005_outbox.sql` et de
`0006_audit-logs.sql`. Leurs lignes désignent déjà les identifiants fixes des
missions, demandes et propositions des blocs préparés : le jour où ces blocs
s'activent, la file et le journal décrivent exactement leurs objets, sans
qu'une seule ligne d'ici ait à changer.

---

## Convention de fichiers

```text
supabase/seed/NNN_nom-en-kebab-case.sql
```

`NNN` sur **trois** chiffres, volontairement différent des quatre chiffres des
migrations : un fichier de ce répertoire n'est pas une migration et ne doit
jamais être déplacé dans `supabase/migrations`.

Chaque fichier porte un en-tête déclaratif, lu par `seed.ts` dans les
commentaires de tête et **eux seuls** — la lecture s'arrête à la première ligne
de SQL, si bien qu'une chaîne contenant `@` plus bas ne peut pas être prise pour
une déclaration.

```sql
-- @titre: Organisations
-- @lot: 1
-- @story: US-012, US-013
-- @tables: organizations
-- @requiert-blocs: aucun
-- @etat: inactif
```

| Clé | Rôle |
|---|---|
| `@titre` | libellé affiché dans le compte rendu |
| `@lot` | lot du plan d'implémentation qui crée les tables |
| `@story` | stories du backlog qui l'activeront |
| `@tables` | tables de `public` alimentées ; **toutes** doivent exister |
| `@requiert-blocs` | blocs à charger avant, pour les clés étrangères ; `aucun` sinon |
| `@etat` | `actif` ou `inactif` — **documentation, ne décide de rien** |

Les six clés sont obligatoires. Un en-tête incomplet, un numéro en double ou un
nom de fichier non conforme font **échouer** la commande. Ignorer un tel fichier
en silence produirait exactement la démonstration trompeuse que ce dispositif
cherche à éviter.

Un bloc ne contient **ni `BEGIN`, ni `COMMIT`, ni `ROLLBACK`** : `seed.ts`
exécute chaque bloc dans sa propre transaction, et une transaction imbriquée
romprait l'annulation en cas d'échec. La commande refuse un fichier qui en
contient.

---

## Détection, et non supposition

`seed.ts` ne décide pas d'exécuter un bloc à partir de son numéro de lot ni de
sa déclaration `@etat`. Il lit les tables réellement présentes dans `pg_class`
et compare :

- **une table de `@tables` manque** → bloc ignoré, motif affiché avec le lot et
  la story ;
- **un bloc de `@requiert-blocs` a été ignoré** → bloc ignoré à son tour, sans
  quoi l'insertion produirait une violation de clé étrangère, ou pire, des
  lignes orphelines si la contrainte manquait ;
- **sinon** → bloc exécuté.

La clé `@etat` sert uniquement à un contrôle de cohérence : lorsqu'elle
contredit la réalité de la base, la commande le signale sans bloquer. C'est le
symptôme d'un fichier dont l'en-tête n'a pas été mis à jour quand son lot a
livré ses tables.

### Quand votre lot livre ses tables

1. Lancez `npm run db:migrate` puis `npm run db:seed`.
2. Si le bloc passe, mettez son en-tête à `@etat: actif` — la commande vous le
   rappellera de toute façon.
3. S'il échoue, le message nomme le fichier, le code PostgreSQL, la colonne en
   cause, le lot et la story. **C'est au lot qui livre la table de mettre le
   bloc à jour**, pas au moteur de l'ignorer : un bloc silencieusement écarté
   priverait la démonstration de la moitié de son contenu sans que personne ne
   s'en aperçoive. Les valeurs des colonnes non documentées (`type`,
   `verification_status`, `priority`, …) sont des hypothèses lisibles signalées
   comme telles en tête de chaque fichier ; la migration fait foi.

---

## Rejouabilité

Deux exécutions consécutives aboutissent au même état, sans doublon ni violation
de contrainte. Trois moyens, aucun effacement :

1. **Identifiants fixes.** Chaque entité porte un UUID constant et manifestement
   synthétique, dont le premier groupe identifie le type :

   | Préfixe | Entité | Préfixe | Entité |
   |---|---|---|---|
   | `00000001` | organisation | `00000009` | exigence de demande |
   | `00000002` | profil utilisateur | `0000000a` | proposition |
   | `00000003` | appartenance | `0000000b` | mission |
   | `00000004` | catégorie | `0000000c` | événement de mission |
   | `00000005` | ressource | `0000000d` | incident |
   | `00000006` | document | `0000000e` | message d'outbox |
   | `00000007` | point de rassemblement | `0000000f` | ligne d'audit |
   | `00000008` | demande | `000000ce` | `client_event_id` |

   Ils sont greppables : `grep -rn 0000000b-0000-4000-8000-000000000001` retrouve
   la mission en transit dans tous les blocs qui la mentionnent.

2. **`ON CONFLICT (id) DO NOTHING`** partout, sauf `outbox`.

3. **`ON CONFLICT (id) DO UPDATE … WHERE … IS DISTINCT FROM …`** pour `outbox`
   seulement. Cette forme fait deux choses qu'un `DO NOTHING` ne fait pas : elle
   ramène une ligne modifiée à la main à l'état déclaré, et elle n'écrit **rien**
   quand la ligne est déjà conforme. Sans la clause `WHERE`, chaque exécution
   déclencherait `outbox_set_updated_at` et ferait avancer `updated_at` : deux
   exécutions ne produiraient plus le même état.

Le compte rendu affiche le nombre de lignes réellement écrites par bloc. **Une
seconde exécution affiche `0` partout** — c'est la preuve observable de la
rejouabilité, pas une déclaration.

### Le piège : `audit_logs` ne se vide pas

Un seed rendu rejouable « à la manière habituelle », c'est-à-dire en vidant les
tables avant de les remplir, **échoue** ici en `42501`. `0006_audit-logs.sql`
verrouille l'immuabilité deux fois, par les droits SQL et par un déclencheur qui
s'applique même au superutilisateur :

| Tentative | Résultat réel |
|---|---|
| `DELETE` sous le compte applicatif | `permission denied for table audit_logs` |
| `TRUNCATE` | refusé par `audit_logs_reject_truncate` |
| `ON CONFLICT … DO UPDATE` | `Le journal d'audit est immuable : opération UPDATE refusée` |
| `ON CONFLICT … DO NOTHING` | accepté — aucune ligne existante n'est touchée |

Pour qu'un seed destructif fonctionne, il faudrait lui accorder le droit
d'effacer un journal d'audit. C'est précisément ce que cette migration existe
pour empêcher. Le jeu s'en passe.

**Corollaire assumé** : modifier une ligne d'un bloc déjà chargé n'aligne pas la
base, sauf pour `outbox`. Il faut passer par `npm run db:reset`, qui supprime le
schéma.

---

## Refus par défaut

`scripts/db/seed.ts` appelle `assertSeedAllowed` **avant** de résoudre la cible,
avant d'ouvrir la connexion et donc avant toute écriture. Seules les valeurs
`local` et `test` de `APP_ENV` autorisent le chargement ; absente, vide ou
inconnue, elle l'interdit. C'est la mise en œuvre du point « seed absent de
production » de `backlog/release-checklist.md` — un contrôle, et non un
avertissement.

```text
$ APP_ENV=production npm run db:seed
Commande « db:seed » refusée : APP_ENV vaut « production », or seules les valeurs
local ou test sont autorisées. Le jeu de démonstration crée des organisations,
des utilisateurs et des missions fictifs : il ne doit jamais être chargé ailleurs
que sur un poste de développement ou une base de test jetable.
   [code de sortie 1]
```

Aucune connexion n'est ouverte : la ligne « Cible : … » n'apparaît pas.

### Compte utilisé

Le seed se connecte avec le **compte applicatif** (`DATABASE_URL`), jamais avec
le compte de migration. Charger des données avec un compte disposant des droits
de schéma masquerait un `GRANT` oublié dans une migration : le jeu passerait en
développement et l'application échouerait en recette. Vérifié : les blocs `013`
et `014` s'exécutent intégralement sous `fire_support_app`, qui n'a ni droit de
schéma ni privilège de superutilisateur.

---

## Règles de données

Aucune donnée réelle. Aucune personne réelle, aucun contact réel, aucun document
réel, aucune position réelle.

| Catégorie | Règle appliquée |
|---|---|
| Personnes | les six personnages de `docs/seed-data.md`, tels quels |
| Téléphones | plage `06 39 98 00 00` – `06 39 98 99 99`, réservée à la fiction par l'ARCEP |
| Courriels | domaine `example.org`, réservé par la RFC 2606 |
| Adresses IP | jamais stockées ; `ip_hash` est calculé par `sha256()` sur la plage de documentation `192.0.2.0/24` (RFC 5737) |
| Coordonnées | **une décimale**, soit environ 11 km : une zone, jamais un lieu |
| Position précise | `precise_location_encrypted` reste `NULL` ; les points de rassemblement portent la même valeur approximative que leur position publique |
| Documents | `storage_key` désigne un objet inexistant ; aucun fichier n'est déposé |
| Immatriculations | préfixe `FICTIF-`, incompatible avec la forme d'un SIRET |
| Territoires | préfixe `ZZ`, non attribué |
| Incident | le mot « simulée » figure dans la description elle-même |

### Deux points d'attention pour le scan de secrets

1. **Numéros de téléphone.** Une règle interdisant les numéros complets
   signalera les valeurs de `002_user-profiles.sql` et `010_missions.sql`. Elle
   doit inscrire le préfixe `063998` en liste d'exception : ces numéros
   n'aboutissent chez aucun abonné, et leur présence est précisément ce qui
   garantit qu'aucun numéro réel n'a été utilisé.
2. **Coordonnées.** Aucune valeur ne dépasse une décimale. Une règle qui
   cherche une position à pleine précision ne trouvera rien ici, et c'est
   voulu : `docs/security.md` demande le masquage des coordonnées, et un dépôt
   n'est pas l'endroit où stocker un point de rassemblement réel.

Conséquence à connaître : une démonstration de la carte montrera un point
« exact » qui ne l'est pas. Le contrôle d'accès à la position reste
démontrable ; la fuite de position, non. C'est exactement ce que l'on attend
d'un jeu de démonstration.

---

## Écarts assumés par rapport à `docs/seed-data.md`

Le document attribue un statut à chacune des huit ressources **et** demande
trois missions dans des états différents. Les deux listes ne sont pas
simultanément satisfiables : une ressource engagée dans une mission non
terminale ne peut pas être « disponible ». `docs/state-machines.md` l'emporte,
conformément à l'ordre de la source de vérité de `CLAUDE.md` (machines à états
avant critères d'acceptation). Deux écarts sur huit, tous deux commentés dans
`005_resources.sql` :

| Ressource | Document | Jeu | Raison |
|---|---|---|---|
| Tracteur avec lame | disponible | `ON_SITE` | il porte la mission arrivée |
| Pompe haut débit | réservée | `RESERVED` sans mission | les trois missions du jeu sont déjà attribuées |

Les six autres statuts, les trois statuts de demande et les trois états de
mission sont conformes au document.

**Règle critique respectée par construction** : les trois missions portent trois
ressources distinctes, et la seule dont la mission pourrait être doublée est
terminale. L'index unique partiel `one_active_mission_per_resource` de
`docs/database-design.md` accepte donc ce jeu tel quel. Si une modification
future le fait échouer sur une violation d'unicité, ce n'est pas l'index qu'il
faut assouplir : c'est le jeu qui est devenu faux.

---

## Points ouverts signalés, non tranchés

1. **`PLATFORM_ADMIN` : porté par l'appartenance ou par le profil ?**
   `docs/permissions.md` le liste parmi les rôles sans dire où il vit. Un rôle
   dont la portée est la plateforme, rattaché à une organisation, est
   contradictoire. Posé sur l'appartenance dans `003`, à trancher au lot 1.
2. **`Resource` a deux colonnes de statut** (`status`, `availability_status`)
   pour une seule liste d'états. Lecture retenue dans `005` : l'une est l'état
   opérationnel constaté, l'autre la disponibilité déclarée par le
   propriétaire. À confirmer au lot 2.
3. **Un incident fait-il basculer la mission ?** `docs/seed-data.md` demande une
   mission « en transit » porteuse d'un incident ; `docs/state-machines.md`
   prévoit `IN_TRANSIT → INCIDENT` sans retour. Les deux ne sont vrais ensemble
   que si la déclaration n'entraîne pas la transition automatiquement. C'est la
   lecture retenue, cohérente avec « ne pas automatiser une décision
   opérationnelle critique ». À trancher au lot 6.
4. **Deux transitions du parcours nominal n'ont pas de nom d'événement.**
   `docs/state-machines.md` nomme sept événements pour neuf transitions :
   `HANDED_OVER → ACTIVE` et `ACTIVE → RETURNING` n'apparaissent donc pas dans
   `011`. La table `mission_events` ne restitue pas tout l'historique, ce qui
   affaiblit la valeur de preuve attendue par `docs/security.md`. À traiter au
   lot 6.

---

## Effet de bord à connaître : `0005_outbox.down.sql`

Le bloc `013` laisse volontairement **un message non traité** (`processed_at IS
NULL`, trois tentatives en échec). Une file bloquée est un cas que
`docs/observability.md` demande de savoir alerter et `docs/operations.md` de
savoir diagnostiquer ; sans elle, le tableau de bord des files serait toujours
vert en démonstration.

Conséquence : après un `db:seed`, `0005_outbox.down.sql` **refuse** de
s'exécuter, son garde-fou étant justement de ne pas supprimer une table
contenant des messages non envoyés. C'est le garde-fou qui fonctionne, pas un
défaut. Sur un poste de développement, `npm run db:reset` remet tout à plat sans
avoir à drainer quoi que ce soit.

---

## Utilisation

```bash
npm run db:up        # démarre la base locale
npm run db:migrate   # applique les migrations
npm run db:seed      # charge le jeu de démonstration
npm run db:seed      # une seconde fois : 0 ligne écrite partout
npm run db:reset     # supprime le schéma, rejoue les migrations, sans données
```

`db:seed` retourne `0` lorsque tous les blocs exécutables ont été chargés, y
compris s'il en a ignoré — l'ignorance d'un bloc dont les tables n'existent pas
est le fonctionnement normal à ce stade du projet, pas une anomalie. Il retourne
`1` sur un refus d'environnement, une base non migrée, un fichier non conforme
ou un bloc en échec.

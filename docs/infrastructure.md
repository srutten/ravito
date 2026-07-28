# Infrastructure

Ce document décrit l'infrastructure cible d'Appui Feux : ce qui est décrit en code, ce qui coûte
combien, comment on l'amorce, comment on l'applique, comment on revient en arrière, ce qui est
exposé et ce qui ne l'est pas.

Il complète `docs/deployment.md`, qui reste la référence du pipeline et de la procédure de
livraison, et `docs/architecture.md`, qui reste la référence de la structure applicative.

## Statut

**Aucune ressource n'est appliquée à ce jour.** Le code Terraform de `infra/` est écrit, formaté et
validé hors ligne. Il n'a jamais été planifié ni appliqué sur le compte Scaleway. Aucun serveur,
aucun volume, aucun seau, aucun enregistrement DNS n'a été créé par ce dépôt.

Ce qui existe réellement sur le compte, et qui n'a pas été créé par ce code :

- le projet Scaleway dédié `appui-feux`, identifiant `a4c4edc6-56a9-462e-beee-a657f84d6271` ;
- trois noms de domaine actifs, en renouvellement automatique, expirant le 27 juillet 2027 :
  `appuifeux.fr`, `appuifeux.eu`, `firesupport.eu` ;
- les zones DNS correspondantes, actives.

Le code d'infrastructure consomme ces éléments, il ne les recrée pas.

## Cadre

| Élément | Valeur |
|---|---|
| Fournisseur | Scaleway |
| Région | `fr-par` |
| Zone | `fr-par-1` |
| Projet | `appui-feux` (`a4c4edc6-56a9-462e-beee-a657f84d6271`) |
| Outil | Terraform 1.14.7, version épinglée dans `infra/versions.tf` |

La région `fr-par` satisfait l'exigence d'hébergement en région européenne du `README.md` et la
mesure « hébergement adapté » de `docs/privacy-rgpd.md`.

OpenTofu n'est pas installé sur le poste de référence. La chaîne outillée est Terraform ; toute
commande de ce document est une commande Terraform.

## Architecture cible des trois environnements

### Vue d'ensemble

```text
              appuifeux.fr         preprod.appuifeux.fr    pr-<n>.dev.appuifeux.fr
                    |                        |                        |
               IP flexible              IP flexible            point d'entrée
                    |                        |              Serverless Containers
          +---------+---------+    +---------+---------+              |
          | instance fr-par-1 |    | instance fr-par-1 |     conteneur sans état
          | proxy TLS         |    | proxy TLS         |   mise à l'échelle à zéro
          | application       |    | application       |              |
          | PostGIS           |    | PostGIS           |              |
          +---------+---------+    +---------+---------+              |
                    |                        |                        |
            volume de données        volume de données    base de preview partagée
                (séparé)                 (séparé)          une base logique par PR
```

`appuifeux.eu` et `firesupport.eu` ne portent aucun environnement : leurs enregistrements pointent
vers l'environnement de production, qui répond par une redirection permanente vers `appuifeux.fr`.

### Production

- Exécution sur une instance, pas en serverless : la base est co-hébergée et une base a besoin d'un
  processus permanent et d'un disque.
- Application et PostGIS en conteneurs sur la même instance.
- Volume de données séparé du volume système, afin que la base survive au remplacement de
  l'instance.
- IP flexible attachée, pour que le remplacement de l'instance ne change pas l'adresse publique et
  n'impose pas d'attendre la propagation DNS.
- Domaine : `appuifeux.fr`.

### Préproduction

Même forme que la production, dimensionnement plus modeste, données fictives. C'est l'environnement
où la procédure d'application, la migration et le rollback sont éprouvés avant d'être joués en
production. Domaine : `preprod.appuifeux.fr`.

### Preview

- Un environnement par pull request, sur Serverless Containers, avec mise à l'échelle jusqu'à zéro :
  une pull request inactive ne consomme pas de calcul.
- Un conteneur serverless est sans état et ne peut pas héberger de base de données : le stockage
  disparaît avec l'instance de conteneur. La base de preview est donc portée par une instance
  distincte, partagée entre toutes les pull requests, avec **une base de données logique par pull
  request**, créée avec l'environnement et détruite avec lui.
- Domaine : `pr-<numéro>.dev.appuifeux.fr`.
- Données strictement fictives. Aucune donnée réelle ne transite hors production.

### Ce qui distingue les trois environnements

| | Preview | Préproduction | Production |
|---|---|---|---|
| Exécution | Serverless Containers | Instance | Instance |
| Mise à l'échelle à zéro | oui | non | non |
| Base de données | base logique dédiée sur une instance PostGIS partagée | PostGIS sur l'instance | PostGIS sur l'instance |
| Durée de vie | celle de la pull request | permanente | permanente |
| Données | fictives | fictives | réelles |
| Sauvegarde attendue | aucune | souhaitable | obligatoire |
| Domaine | `pr-<n>.dev.appuifeux.fr` | `preprod.appuifeux.fr` | `appuifeux.fr` |
| Destruction | automatique à la fermeture de la pull request | jamais sans décision | jamais sans décision |

## Nommage et étiquetage

Les étiquettes Scaleway sont des chaînes libres, pas des couples clé-valeur typés. La convention
retenue encode donc la clé dans la chaîne :

```text
project=appui-feux
environment=production | preproduction | preview
managed-by=terraform
```

Toute ressource porte ces trois étiquettes. Objectif : une ressource sans `managed-by=terraform`
dans le projet `appui-feux` est, par construction, soit une ressource d'amorçage documentée ici,
soit une ressource orpheline à supprimer. Le coût est imputable par environnement au moyen de
l'étiquette `environment`.

Les seaux Object Storage suivent le préfixe `appui-feux-` et sont tous privés :

| Seau | Rôle | Créé par |
|---|---|---|
| `appui-feux-tfstate` | état Terraform distant | amorçage manuel, hors Terraform |
| `appui-feux-<env>-documents` | documents applicatifs (US-022) | Terraform |
| `appui-feux-<env>-backups` | sauvegardes de base, chiffrées | Terraform |

Les trois usages sont dans trois seaux distincts. Un accès en lecture au seau de documents ne donne
donc ni l'état de l'infrastructure, ni les sauvegardes.

## Coût mensuel par environnement

### Tarifs constatés

Ces cinq tarifs ont été relevés sur le compte. Ce sont les seuls chiffres constatés de ce document.

| Élément | Tarif |
|---|---|
| Instance DEV1-S | 6,55 EUR/mois |
| Instance DEV1-M | 14,74 EUR/mois |
| Instance DEV1-L | 31,27 EUR/mois |
| Instance PLAY2-MICRO | 40,21 EUR/mois |
| Stockage bloc | 0,0993 EUR/Go/mois |

Ces tarifs sont ceux affichés par le fournisseur, hors remise et hors engagement. La facturation
réelle est horaire ; le montant mensuel correspond à une ressource allumée en continu.

### Dimensionnement retenu par défaut

Le type d'instance et la taille du volume sont des variables Terraform. Les valeurs ci-dessous sont
les valeurs par défaut, pas des contraintes.

| Environnement | Instance | Volume de données |
|---|---|---|
| Préproduction | DEV1-S | 20 Go |
| Production | DEV1-L | 40 Go |
| Preview (base partagée) | DEV1-S | 10 Go |

### Coût mensuel

| Environnement | Instance | Volume de données | Sous-total constaté |
|---|---|---|---|
| Préproduction | DEV1-S, 6,55 | 20 Go, 1,99 | **8,54 EUR/mois** |
| Production | DEV1-L, 31,27 | 40 Go, 3,97 | **35,24 EUR/mois** |
| Preview | DEV1-S, 6,55 | 10 Go, 0,99 | **7,54 EUR/mois** |
| **Total** | | | **51,32 EUR/mois** |

### Ce que ce total ne contient pas

Le total ci-dessus est un **plancher**, pas une prévision de facture. Les postes suivants n'ont pas
de tarif relevé et ne sont donc pas chiffrés :

- IP flexible, une par environnement à instance (production, préproduction, et la base de preview
  si elle doit être jointe depuis l'extérieur) ;
- Object Storage : seau d'état, seaux de documents, seaux de sauvegardes, en volume stocké comme en
  requêtes ;
- Serverless Containers pour les previews : facturation à la consommation, donc proche de zéro à
  l'arrêt mais non nulle dès qu'une pull request est active ;
- Container Registry : stockage des images, qui croît à chaque déploiement si aucune politique de
  purge n'est posée ;
- trafic sortant ;
- renouvellement annuel des trois noms de domaine, déjà engagé jusqu'au 27 juillet 2027.

Deux avertissements de sincérité :

1. **La mise à l'échelle à zéro des previews ne rend pas les previews gratuites.** Elle supprime le
   coût du calcul entre deux utilisations, mais l'instance qui porte la base de preview partagée
   tourne en continu et est facturée en continu, qu'il y ait zéro ou dix pull requests ouvertes.
2. **Le volume système n'est pas compté** : il est supposé inclus dans le tarif de l'instance pour
   la gamme DEV1. Ce point n'a pas été vérifié sur une facture réelle, faute d'application. Si le
   volume système est facturé séparément, chaque environnement coûte davantage.

Le premier relevé de facture réelle devra être comparé à ce tableau et le tableau corrigé. Tant
qu'aucune ressource n'est appliquée, aucun montant n'est facturé.

## Amorçage de l'état distant

L'état Terraform est distant, stocké dans le seau `appui-feux-tfstate`, sur l'Object Storage
Scaleway compatible S3. Il n'est jamais commité.

**Terraform ne peut pas créer le stockage de son propre état.** Au premier `terraform init`, le
backend doit déjà exister ; s'il n'existe pas, l'initialisation échoue avant même d'avoir un état où
enregistrer la création du seau. Le seau d'état est donc créé une seule fois, à la main, hors
Terraform, et n'est géré par aucun module.

Procédure d'amorçage, **non exécutée à ce jour** :

1. Créer le seau `appui-feux-tfstate` dans le projet `appui-feux`, région `fr-par`, en visibilité
   **privée**, depuis la console Scaleway ou la CLI `scw`.
2. Activer la gestion de versions sur ce seau. C'est le seul filet contre un état corrompu ou
   écrasé : sans versions, un état perdu impose de réimporter chaque ressource à la main.
3. Vérifier que le seau n'est accessible ni en lecture ni en écriture publique.
4. Exporter les identifiants dans l'environnement du poste, jamais dans un fichier du dépôt.
5. Lancer `terraform init` dans le répertoire de l'environnement visé, avec la clé d'état propre à
   cet environnement.

Un seul seau porte les trois états, sous trois clés distinctes :

```text
appui-feux-tfstate/preproduction/terraform.tfstate
appui-feux-tfstate/production/terraform.tfstate
appui-feux-tfstate/preview/terraform.tfstate
```

Conséquence assumée : une erreur d'`-backend-config` fait pointer un environnement sur l'état d'un
autre. La commande d'initialisation est donc toujours écrite en entier, jamais rejouée de mémoire.

### Verrouillage

Scaleway ne propose pas d'équivalent de DynamoDB. Le verrouillage repose donc sur le fichier de
verrou natif du backend S3 de Terraform, activé par `use_lockfile`.

**Point à vérifier avant la première application** : ce mécanisme suppose que l'Object Storage
Scaleway honore les écritures conditionnelles. Tant que ce point n'est pas vérifié sur le compte, il
faut considérer que deux applications simultanées peuvent corrompre l'état, et donc n'appliquer
qu'à un seul endroit à la fois. Ce risque est théorique aujourd'hui, puisque personne n'applique.

## Procédure d'application, environnement par environnement

Ces commandes **ne doivent pas être exécutées aujourd'hui**. Elles décrivent la procédure du jour où
le fondateur décidera d'appliquer.

### Ordre imposé

1. **Préproduction** en premier. C'est l'environnement où l'on découvre ce qui ne marche pas.
2. **Preview** ensuite, une fois la forme de l'instance et de la base validée en préproduction.
3. **Production** en dernier, et seulement après un `plan` vide rejoué sur la préproduction, preuve
   d'idempotence.

### Étapes, pour un environnement donné

```bash
# 1. Identifiants dans l'environnement du shell, jamais dans un fichier.
export SCW_ACCESS_KEY=...
export SCW_SECRET_KEY=...
export SCW_DEFAULT_PROJECT_ID=a4c4edc6-56a9-462e-beee-a657f84d6271
export AWS_ACCESS_KEY_ID="$SCW_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$SCW_SECRET_KEY"

# 2. Initialisation, avec la clé d'état de cet environnement et pas d'un autre.
cd infra/environments/preproduction
terraform init -backend-config="key=preproduction/terraform.tfstate"

# 3. Plan écrit dans un fichier, pour que ce qui est appliqué soit ce qui a été lu.
terraform plan -out=plan.tfplan

# 4. Lecture du plan par un humain. Toute destruction non attendue arrête la procédure.

# 5. Application du plan lu, pas d'un plan recalculé.
terraform apply plan.tfplan

# 6. Preuve d'idempotence : un second plan doit être vide.
terraform plan
```

Le fichier `plan.tfplan` contient la configuration résolue et ne doit jamais être commité ni
transmis par un canal non maîtrisé.

### Après la première application

Ce que Terraform ne fait pas et qui reste à faire à la main, faute de chaîne de déploiement :

- installer et configurer le proxy de terminaison TLS sur l'instance ;
- obtenir le certificat ;
- déposer et démarrer les conteneurs applicatif et PostGIS ;
- exécuter les migrations ;
- installer la sauvegarde.

Aucune de ces étapes n'est scriptée dans cette itération. Voir « Ce qui n'est pas couvert ».

## Rollback

La procédure de `docs/deployment.md` distingue trois objets qui ne reviennent pas en arrière de la
même façon. Les confondre est la première cause d'aggravation d'un incident.

### 1. Rollback applicatif

Redéployer l'image précédente, désignée par son empreinte de commit. L'infrastructure n'est pas
touchée : l'instance, le volume, l'IP et le DNS restent en place. C'est le rollback le plus rapide
et celui qu'il faut tenter en premier.

Prérequis non encore réunis : le registre d'images n'existe pas et aucune image n'est construite.

### 2. Rollback de schéma

Il n'y en a pas. La règle de `docs/deployment.md` et de `docs/database-design.md` est que les
migrations sont compatibles avec la version précédente de l'application et que les migrations
destructives sont étalées sur plusieurs déploiements. C'est cette compatibilité ascendante qui rend
le rollback applicatif possible sans toucher à la base.

Si une migration non compatible atteint la production malgré cette règle, il n'existe pas de retour
propre : la seule issue est la restauration d'une sauvegarde, avec perte des écritures postérieures.
Cette restauration n'est ni scriptée ni testée à ce jour. Voir US-111 et US-112.

### 3. Rollback d'infrastructure

Revenir au commit précédent de `infra/`, puis `plan` et `apply`. **Cette opération est la plus
dangereuse des trois** : un retour en arrière sur du code d'infrastructure peut planifier la
destruction d'un volume de données ou d'un seau, c'est-à-dire détruire ce que le rollback était
censé sauver.

Mesures :

- `prevent_destroy` sur le volume de données, sur l'IP flexible et sur les seaux ;
- lecture intégrale du plan avant application, et arrêt de la procédure à la première ligne
  `destroy` non attendue ;
- en cas de doute, ne rien appliquer et basculer la plateforme en lecture seule.

### Mesures d'accompagnement

- Interrupteur de lecture seule : `PLATFORM_READ_ONLY` est déjà déclaré dans `.env.example` et
  décrit dans `docs/feature-flags.md`. C'est le moyen le moins destructif de figer la situation
  pendant qu'on décide.
- Interrupteurs `DISABLE_NEW_MISSIONS` et `DISABLE_NEW_REQUESTS` pour arrêter l'arrivée de nouvelles
  affectations sans couper la consultation des missions en cours.
- Procédure alternative de `docs/operations.md` : téléphone, SMS, radio institutionnelle, fiche
  imprimable, liste des points de rassemblement. Pendant une panne, c'est elle qui tient le service,
  pas la plateforme.

### Responsable

`docs/deployment.md` exige un responsable identifié pour le rollback. **Il ne l'est pas.** Le
fondateur est aujourd'hui la seule personne du projet et donc, de fait, le responsable unique, sans
suppléant et sans astreinte. Ce point doit être tranché avant le pilote : une procédure de rollback
dont le seul détenteur est indisponible n'est pas une procédure.

## Modèle de menaces de l'infrastructure

Ce modèle complète `docs/threat-model.md`, qui traite les menaces applicatives. Il ne traite que la
couche d'hébergement.

### Ce qui est exposé sur l'Internet public

| Exposition | Justification | Restriction |
|---|---|---|
| 443/tcp sur les instances production et préproduction | c'est le service | TLS, aucune alternative en clair |
| 80/tcp sur les mêmes instances | validation ACME du certificat et redirection permanente vers 443 | aucune donnée servie en clair |
| 22/tcp administration | il faut pouvoir intervenir sur une instance | clé uniquement, jamais de mot de passe, source restreinte aux adresses d'administration déclarées |
| Point d'entrée des Serverless Containers de preview | c'est le service de preview | géré par le fournisseur, TLS, données fictives uniquement |
| Enregistrements DNS | ils doivent être publics pour être résolus | ils révèlent les adresses IP des environnements, ce qui est inévitable et accepté |

### Ce qui n'est pas exposé

| Ressource | Règle |
|---|---|
| PostgreSQL et PostGIS, port 5432 | **jamais de règle entrante publique.** La base écoute sur l'interface privée de l'instance. L'application la joint localement. |
| Seau d'état Terraform | privé, aucune lecture publique |
| Seau de sauvegardes | privé, chiffré, accès distinct de celui de la base |
| Seau de documents applicatifs | privé, accès uniquement par URL signée à durée limitée, conformément à `docs/security.md` |
| Registre d'images | privé |

Le principe est celui de `docs/security.md` : refus par défaut. Un groupe de sécurité s'ouvre par
une règle explicite, justifiée en commentaire dans le code. Toute règle sans justification est une
anomalie de revue.

### Scénarios

**Compromission de la clé d'administration SSH.** L'attaquant obtient l'instance, donc
l'application, donc la base, donc les documents montés, dans le même mouvement : la co-localisation
de la base et de l'application supprime tout cloisonnement. Contrôles : clé uniquement, source
restreinte, pas de mot de passe, rotation, et surtout un seau de sauvegarde dont les identifiants ne
sont pas ceux de l'instance, pour qu'une compromission de l'instance ne permette pas d'effacer aussi
les sauvegardes. Ce dernier point est une exigence de conception, pas encore une réalisation.

**Compromission de la clé d'API de déploiement.** Voir la section dédiée ci-dessous.

**Seau rendu public par erreur.** Conséquence directe : fuite de documents professionnels de
contributeurs, c'est-à-dire de données à caractère personnel. Contrôles : visibilité privée déclarée
dans le code, jamais dans la console ; revue du plan avant application ; aucun objet servi sans URL
signée.

**Saturation ou déni de service.** L'infrastructure est une instance unique par environnement. Une
saturation applicative ou réseau met le service à terre sans mécanisme de report. Contrôles côté
application : limitation de requêtes, dégradation gracieuse, lecture seule. Côté infrastructure, la
protection anti-déni de service du fournisseur n'a pas été vérifiée et aucun mécanisme de mise à
l'échelle n'est prévu. À traiter avant ouverture publique, pas avant le pilote restreint.

**Environnement de preview utilisé comme point d'entrée.** Un environnement de preview exécute du
code issu d'une branche non fusionnée. Il ne doit donc jamais partager d'identifiant, de seau ni de
base avec la production. La séparation est structurelle : projet de seaux distincts, base de preview
distincte, données fictives.

### Point ouvert à trancher avant la première application

Un conteneur serverless de preview doit joindre la base de preview, qui est sur une instance. Si
l'intégration au réseau privé n'est pas disponible ou n'est pas retenue, la seule alternative est
d'exposer publiquement le port de la base de preview, filtré par adresse source, ce qui contredit la
règle « la base n'est jamais exposée sur l'Internet public ».

Ce point ne concerne que l'environnement de preview, dont les données sont fictives, et il n'a
aucun effet tant que rien n'est appliqué. Il doit être arbitré explicitement, et non contourné au
moment de la première application.

## Le point de défaillance unique de la base auto-hébergée

Le fondateur a arrêté d'auto-héberger PostGIS en conteneur sur l'instance plutôt que de prendre
l'offre managée. Cette décision n'est pas rediscutée ici. Ce qui suit décrit ce qu'elle implique, ni
plus ni moins.

### Ce que l'offre managée fournissait et qui devient notre charge

Sauvegarde quotidienne chiffrée, rétention appliquée, restauration à un instant donné, supervision
de la base, correctifs de sécurité du moteur, et la preuve que tout cela fonctionne. En
auto-hébergé, chacun de ces éléments devient du code à écrire, à exécuter et à vérifier.

### Ce que le point de défaillance unique signifie concrètement

L'application, le moteur PostGIS, les données opérationnelles et le journal d'audit vivent sur une
seule instance, dans une seule zone, `fr-par-1`. Il n'y a ni réplique, ni bascule, ni redondance de
zone.

- **Perte de l'instance** : le volume de données est séparé du volume système, il survit donc au
  remplacement de l'instance et peut être rattaché à une nouvelle instance. La remise en service
  reste entièrement manuelle et sa durée n'a jamais été mesurée. Personne ne peut aujourd'hui
  annoncer un délai de rétablissement.
- **Perte ou corruption du volume de données** : sans sauvegarde, la perte est définitive. Un
  `DROP TABLE`, une migration erronée ou un `terraform destroy` mal ciblé se propagent
  instantanément au volume. La durabilité d'un volume bloc protège d'une panne matérielle ; elle
  ne protège d'aucune erreur humaine ni d'aucun acte malveillant. **Un volume n'est pas une
  sauvegarde.**
- **Le journal d'audit est sur le même volume que les données qu'il atteste.** C'est la conséquence
  la plus sérieuse. `docs/security.md` et `CLAUDE.md` font de la trace d'audit une preuve
  exploitable ; une preuve qui disparaît en même temps que ce qu'elle prouve n'a pas la valeur qu'on
  lui prête.

### Ce que cela veut dire pour un service de soutien à la sécurité civile

Il faut le dire sans dramatiser : la plateforme ne remplace ni les services d'urgence ni la chaîne
de commandement, et `docs/operations.md` impose une procédure alternative — téléphone, SMS, radio
institutionnelle, fiche imprimable, liste des points de rassemblement. Une indisponibilité
d'Appui Feux ne stoppe pas une opération de secours.

Il faut aussi le dire sans minimiser : une indisponibilité pendant un épisode de feu fait perdre la
visibilité sur les missions en cours, c'est-à-dire sur des moyens matériels déjà engagés vers un
point de rassemblement, avec des personnes en route. Le repli sur la procédure alternative n'est pas
gratuit ; il suppose que quelqu'un dispose d'une copie exploitable de l'état des missions au moment
de la panne. Cette copie n'existe pas aujourd'hui.

### Ce qui doit être en place avant le pilote

1. **Sauvegarde quotidienne au minimum, chiffrée, vers le seau de sauvegarde**, avec des
   identifiants distincts de ceux de l'instance, et une alerte en cas d'échec — l'alerte
   « sauvegarde échouée » est déjà listée dans `docs/observability.md`. Story US-111.
2. **Test de restauration sur une base vierge, avec durée mesurée et preuve conservée.** Une
   sauvegarde jamais restaurée est une hypothèse, pas une sauvegarde. Story US-112, exigence
   reprise dans `backlog/release-checklist.md`.
3. **Objectifs annoncés de perte de données maximale et de délai de rétablissement.** Une sauvegarde
   quotidienne signifie qu'on accepte de perdre jusqu'à vingt-quatre heures d'affectations. Pendant
   un épisode de feu, c'est trop : il faut soit une fréquence intra-journalière, soit un archivage
   continu des journaux de transaction. Le chiffre doit être écrit et assumé, pas subi.
4. **Runbook « instance perdue »** dans `docs/operations.md` : reconstruction de l'instance,
   rattachement du volume, redémarrage des conteneurs, vérification des missions en cours.
   Story US-113.
5. **Protection contre la destruction accidentelle** : `prevent_destroy` sur le volume de données,
   l'IP flexible et les seaux, et séparation des accès entre la base et le dépôt de sauvegarde.
6. **Procédure alternative réellement disponible** : imprimée ou accessible hors ligne, puisqu'elle
   est le seul recours pendant l'indisponibilité.

Tant que les points 1 et 2 n'existent pas, l'auto-hébergement est une décision dont le coût a été
reporté, pas évité. Le choix reste défendable pour un MVP à faible volume avec des données fictives.
Il ne l'est pas pour un pilote portant des missions réelles.

## Clé d'API de déploiement

La clé d'API retenue par le fondateur est la clé existante, qui porte sur toute l'organisation et
sert déjà à d'autres projets : une chaîne de déploiement compromise atteindrait donc ces autres
projets.

Ce point est sans effet tant qu'aucune ressource n'est appliquée et qu'aucune chaîne de déploiement
n'existe. Il doit être tranché avant la première application. La décision appartient au fondateur.

Pour mémoire, le critère d'acceptation 3 de US-004 demande une clé dédiée au déploiement, restreinte
au projet `appui-feux` ; il n'est donc pas satisfait en l'état.

## Ce qui n'est pas couvert

Section obligatoire. Elle liste ce que cette itération ne livre pas et la story qui en porte la
charge.

| Manque | Conséquence | Story |
|---|---|---|
| **Aucune ressource n'est appliquée.** Le code n'a jamais été planifié ni appliqué. | Rien n'est prouvé : ni la validité des identifiants de ressources, ni l'idempotence, ni l'existence réelle du service. Le code est une intention vérifiée syntaxiquement, pas une infrastructure. | US-004 |
| Le seau d'état n'existe pas et l'état distant n'a jamais été initialisé. Le verrouillage n'est pas vérifié. | `terraform init` échouera tant que l'amorçage manuel n'aura pas été fait. | US-004 |
| **Aucune chaîne de déploiement automatisée.** Aucun fichier sous `.github/` n'est créé : hors périmètre explicite de cette itération. | Les critères de pipeline, de preview automatique par pull request, de destruction automatique à la fermeture, de migration en étape distincte et d'ordre des étapes ne sont pas satisfaits. Le critère de sortie du lot 0 — « une PR de test est déployée en preview » — n'est pas atteint. | US-004, US-003 |
| Aucune image conteneur, aucun `Dockerfile`, aucun registre alimenté. | Rien à déployer, et pas de rollback applicatif possible faute d'image précédente. | US-004 |
| **Les sauvegardes ne sont pas scriptées.** Le seau de sauvegarde et sa politique de cycle de vie sont prévus dans le code ; le script qui écrit dedans n'existe pas. | Un seau de sauvegarde vide ne sauvegarde rien. | US-111 |
| **La restauration n'est pas testée**, aucune preuve de test n'existe. | La capacité à revenir en arrière après une perte de données est une hypothèse. | US-112 |
| **Les smoke tests n'existent pas.** | Un déploiement ne peut pas être validé automatiquement, et l'échec ne peut pas déclencher de rollback. | US-114 |
| Aucune supervision de l'instance, aucune alerte, aucun tableau de bord d'infrastructure. | Une panne, un disque plein ou une sauvegarde échouée sont découverts par un utilisateur. | US-110 |
| Aucun runbook d'infrastructure : instance perdue, volume saturé, certificat expiré. | Une intervention en situation dégradée repose sur l'improvisation. | US-113 |
| Le provisionnement de l'instance n'est pas fourni : proxy TLS, certificat, démarrage des conteneurs, exécution des migrations. | Une instance créée par Terraform ne sert rien. Le critère de TLS de bout en bout n'est pas démontrable. | US-004 |
| La redirection de `appuifeux.eu` et `firesupport.eu` est portée par le proxy, pas par le DNS. Le DNS ne sait que pointer. | Tant que le proxy n'est pas provisionné, les enregistrements pointent vers un service qui ne redirige pas. | US-004 |
| Les migrations ne sont pas exécutables : les scripts `db:migrate`, `db:status`, `db:reset`, `db:seed` sont déclarés mais livrés par une autre story. | L'étape de migration du pipeline n'a rien à appeler. | US-002 |
| Le rollback est écrit mais **jamais testé**, et **son responsable n'est pas identifié**. | Une procédure non jouée n'est pas une procédure. | US-004 |
| La clé d'API de déploiement n'est pas dédiée ni restreinte au projet. | Voir la section précédente. | US-004 |

## Références

- `docs/deployment.md` : environnements, pipeline, migration de production, rollback, smoke tests.
- `docs/architecture.md` : monolithe modulaire, services externes, résilience.
- `docs/security.md` : secrets, sécurité API, protection des données.
- `docs/operations.md` : sauvegarde, continuité, runbooks.
- `docs/observability.md` : alertes attendues, dont l'échec de sauvegarde.
- `docs/database-design.md` : exigences de sauvegarde et de migration.
- `docs/privacy-rgpd.md` : hébergement adapté, données de test anonymisées.
- `backlog/implementation-plan.md` : critère de sortie du lot 0.
- `backlog/release-checklist.md` : section Données, sauvegarde et restauration testée.
- `infra/README.md` : mode d'emploi et commandes.

# Environnement de prévisualisation

> ## AUCUNE RESSOURCE N'EST APPLIQUÉE À CE JOUR
>
> Ce code est écrit, formaté et validé hors ligne. Il n'a **jamais** été planifié ni appliqué sur le
> compte Scaleway. **Rien n'est facturé.** La décision d'appliquer appartient au fondateur.

Domaines servis : **`pr-<numéro>.dev.appuifeux.fr`**, un par pull request.

## Pourquoi un conteneur serverless ne peut pas héberger la base

C'est la contrainte qui structure tout cet environnement.

Un Serverless Container est **sans état**. Sa mise à l'échelle jusqu'à zéro — la raison même de le
choisir pour des prévisualisations — signifie que le fournisseur arrête la dernière instance quand
plus personne ne l'appelle et en démarre une neuve à la requête suivante. Le stockage local est
éphémère et disparaît avec l'instance ; aucun volume persistant ne peut y être attaché.

Un cluster PostgreSQL est l'exact inverse : un processus permanent qui détient un verrou sur un
répertoire de données et doit survivre au redémarrage. Faire tourner PostGIS dans le conteneur de
prévisualisation reviendrait à perdre la base entre deux consultations de la pull request, et à
corrompre le répertoire de données dès que deux instances démarreraient en parallèle sous la charge.

D'où le montage retenu : **une instance dédiée, allumée en continu, partagée entre toutes les pull
requests, avec une base de données logique par pull request**, créée avec l'environnement et
supprimée avec lui.

## Ce que contient cet environnement

### Socle partagé, permanent

| Ressource | Détail |
|---|---|
| Réseau privé | `scaleway_vpc_private_network`, seul chemin entre les conteneurs et la base |
| Hôte de base | instance `DEV1-S`, zone `fr-par-1`, image `ubuntu_noble` |
| Volume de données | 10 Go, séparé du volume système, porte toutes les bases logiques |
| Groupe de sécurité | **aucun port public** : ni 80, ni 443, ni 5432. SSH fermé par défaut |
| Espace de noms | `scaleway_container_namespace`, unité de facturation et de quota |
| Seau documents | `appui-feux-preview-documents`, privé, chiffré |
| Seau sauvegardes | `appui-feux-preview-sauvegardes`, créé par le module, **volontairement inutilisé** |

### Par pull request déclarée

| Ressource | Détail |
|---|---|
| Conteneur | `min_scale = 0`, rattaché au réseau privé, HTTP redirigé vers HTTPS |
| Enregistrement DNS | `CNAME` `pr-<n>.dev.appuifeux.fr` vers le point d'accès natif du conteneur |
| Liaison de domaine | `scaleway_container_domain`, qui déclenche la délivrance du certificat TLS |

La liste `preview_environments` est **vide par défaut** : appliquer crée le socle partagé et rien
d'autre. Ajouter une entrée crée une prévisualisation complète ; retirer l'entrée la détruit.

## La base de preview n'est pas exposée sur l'Internet public

`../../../docs/infrastructure.md` signalait un point ouvert : « un conteneur serverless de preview
doit joindre la base de preview ; sans intégration au réseau privé, la seule alternative est une
exposition publique filtrée, ce qui contredit la règle ».

**Ce point est tranché sans contourner la règle.** Le fournisseur `scaleway/scaleway` 2.79.0 expose
`private_network_id` aussi bien sur `scaleway_container` que sur `scaleway_instance_server`. Le
conteneur et l'hôte de base sont rattachés au même réseau privé, et le groupe de sécurité de la base
n'ouvre **aucun** port entrant sur l'interface publique.

Réserve honnête : cette intégration est vérifiée sur la documentation du fournisseur à la version
épinglée, **pas en exécution**. Elle n'a jamais été appliquée ni observée sur le compte.

Seconde barrière obligatoire, hors Terraform : un groupe de sécurité Scaleway ne filtre que
l'interface **publique**. PostGIS doit être configuré pour n'écouter que sur l'adresse privée, avec
un `pg_hba.conf` n'autorisant que le sous-réseau privé. La sortie `database_private_ips` donne
l'adresse ; `private_network_ipv4_subnet` permet de fixer le sous-réseau à l'avance pour écrire ce
fichier avant de connaître les adresses attribuées.

## Ce qui diffère des deux autres environnements

| Axe | Preview | Préproduction | Production |
|---|---|---|---|
| Exécution de l'application | **Serverless Containers** | instance | instance |
| Mise à l'échelle à zéro | **oui** | non | non |
| Base | logique dédiée sur une instance **partagée** | sur l'instance | sur l'instance |
| Durée de vie | celle de la pull request | permanente | permanente |
| Données | fictives | fictives | réelles |
| Sauvegarde | **aucune attendue**, seau vide | 7 jours | 35 jours |
| `force_destroy` des seaux | **true** | false | false |
| Ports publics de l'hôte de base | **aucun** | 80, 443 | 80, 443 |
| Destruction | fait partie du cycle normal | sur décision | jamais sans décision |

`force_destroy = true` est la seule occurrence dans les trois environnements : conséquence à
connaître, un `terraform destroy` supprimera les seaux **même remplis**. C'est voulu ici, cela ne le
serait nulle part ailleurs.

## Ce que cet environnement coûte

Tarifs relevés sur le compte le 2026-07-27.

| Poste | Calcul | Montant |
|---|---|---|
| Instance `DEV1-S` de la base partagée | | 6,55 EUR/mois |
| Volume de données 10 Go | 10 × 0,0993 | 0,99 EUR/mois |
| **Sous-total constaté** | | **7,54 EUR/mois** |

**Ce montant est facturé en continu, même avec zéro pull request ouverte.** La mise à l'échelle à
zéro annule le coût du *calcul* des conteneurs, pas celui de la machine qui porte la base. C'est le
prix incompressible du choix serverless pour l'application.

Ne sont pas chiffrés, faute de tarif relevé : les Serverless Containers eux-mêmes (facturation à la
consommation, proche de zéro au repos mais non nulle dès qu'une pull request est consultée), l'IP
flexible, l'Object Storage, le trafic sortant, le registre d'images.

Deux garde-fous bornent la dérive : `container_max_scale` est plafonné à 5, et `min_scale` est limité
à 0 ou 1 par une validation — au-delà, une prévisualisation serait facturée en continu et perdrait sa
raison d'être. La sortie `open_preview_count` sert de compteur : une valeur qui ne redescend jamais
signale des pull requests fermées jamais nettoyées.

## Comment l'appliquer, le jour où la décision sera prise

Ordre imposé : préproduction d'abord, **preview ensuite**, production en dernier.

Prérequis : le seau d'état `appui-feux-tfstate` doit avoir été amorcé à la main (voir
`../../README.md`).

```bash
# 1. Identifiants dans le shell, jamais dans un fichier du dépôt.
export SCW_ACCESS_KEY=...
export SCW_SECRET_KEY=...
export AWS_ACCESS_KEY_ID="$SCW_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$SCW_SECRET_KEY"

# 2. Le seul secret de cet environnement, par l'environnement du shell.
export TF_VAR_preview_database_password="$(...gestionnaire de secrets...)"

# 3. Variables non secrètes propres au poste.
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars

# 4. Initialisation, avec la clé d'état de CET environnement.
terraform init -backend-config="key=preview/terraform.tfstate"

# 5. Plan écrit dans un fichier, lu intégralement, puis appliqué.
terraform plan -out=plan.tfplan
terraform apply plan.tfplan
```

### Ouvrir une prévisualisation

1. construire l'image et la pousser au registre — **n'existe pas** (US-004) ;
2. créer la base logique : `CREATE DATABASE appui_feux_pr_42` — **hors Terraform**, voir plus bas ;
3. exécuter les migrations sur cette base — scripts livrés par US-002, **non disponibles** ;
4. ajouter l'entrée dans `preview_environments`, puis `terraform apply` ;
5. publier `terraform output preview_urls` en commentaire de la pull request — **manuel**.

### Fermer une prévisualisation

1. retirer l'entrée de `preview_environments`, puis `terraform apply` : le conteneur, son
   enregistrement DNS et sa liaison de domaine sont détruits ;
2. `DROP DATABASE appui_feux_pr_42` — **hors Terraform**.

Les deux étapes devraient être déclenchées par la chaîne de déploiement à l'ouverture et à la
fermeture de la pull request. **Cette chaîne n'existe pas** : aucun fichier n'est écrit sous
`.github/`, hors périmètre explicite de cette itération.

## Vérification hors ligne, autorisée aujourd'hui

```bash
terraform fmt -recursive -check
terraform init -backend=false
terraform validate
```

## Ce que Terraform ne fait pas ici, et pourquoi

- **Il ne crée pas les bases logiques.** Terraform ne parle pas SQL sans un fournisseur PostgreSQL,
  qui exigerait des identifiants de base et une connexion au cluster dès le `plan`, depuis le poste
  ou depuis la chaîne de déploiement. `CREATE DATABASE` et `DROP DATABASE` relèvent donc du
  déploiement. Le nom est déterministe — sortie `preview_database_names` — pour que la chaîne puisse
  le recalculer sans lire l'état.
- **Il ne crée pas le registre d'images.** Le registre sert tous les environnements et appartient à
  la chaîne de construction : le placer dans l'état de la seule preview en ferait une ressource
  partagée qu'un `destroy` de preview emporterait. Il n'existe aujourd'hui ni `Dockerfile` ni image.
- **Il ne provisionne pas l'hôte de base** : formatage et montage du volume, installation de PostGIS,
  liaison à l'adresse privée, `pg_hba.conf`, création du compte `appui_preview` et de ses droits.
  Le cloisonnement entre pull requests dépend de ces droits.
- **Il ne détruit rien automatiquement à la fermeture d'une pull request.** Le mécanisme existe
  — retirer l'entrée et appliquer — mais rien ne le déclenche.

## Références

- `../../README.md` : amorçage de l'état distant, commandes autorisées et interdites.
- `../../../docs/infrastructure.md` : architecture, coûts, modèle de menaces, point ouvert du réseau
  privé de preview.
- `../../../docs/deployment.md` : pipeline, environnements, rollback.
- `../../../backlog/implementation-plan.md` : critère de sortie du lot 0, « une PR de test est
  déployée en preview » — **non atteint** faute de chaîne de déploiement.

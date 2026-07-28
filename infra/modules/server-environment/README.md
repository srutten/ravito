# Module `server-environment`

Un environnement Appui Feux servi par une instance Scaleway : adresse IP
flexible, groupe de sécurité en refus par défaut, volume système, volume de
données séparé, enregistrement DNS dans une zone existante.

Ce module sert **la production et la préproduction**. Les prévisualisations ne
l'utilisent pas : elles reposent sur des Serverless Containers, qui se réduisent
à zéro et ne coûtent rien au repos.

## Ce que le module crée

| Ressource Terraform                  | Rôle                                                        |
| ------------------------------------ | ----------------------------------------------------------- |
| `scaleway_instance_ip`               | Adresse IPv4 flexible, réservée indépendamment de la machine |
| `scaleway_instance_security_group`   | Filtrage réseau, entrant en refus par défaut                 |
| `scaleway_block_volume`              | Volume de données, distinct du volume système                |
| `scaleway_instance_server`           | Instance, volume système jetable, cloud-init de durcissement |
| `scaleway_domain_record`             | Enregistrement A dans une zone **déjà existante**            |
| `scaleway_instance_ip_reverse_dns`   | Enregistrement PTR cohérent avec le nom direct               |

## Ce que le module ne crée jamais

- **La zone DNS.** Les zones `appuifeux.fr`, `appuifeux.eu` et `firesupport.eu`
  existent, sont actives et en renouvellement automatique. `scaleway_domain_zone`
  n'est pas utilisé : recréer une zone effacerait les enregistrements existants,
  dont ceux de messagerie et de validation de domaine.
- **Le seau d'état Terraform.** Il est amorcé à la main, hors Terraform. Voir
  `infra/backend.tf` et `infra/README.md`.
- **Les seaux de documents et de sauvegardes.** Ils relèvent du module
  `object-storage`.
- **La base de données.** PostGIS est auto-hébergé dans un conteneur sur
  l'instance. Terraform fournit le volume, pas le service.

## Décisions de conception

### Refus par défaut, et justification de chaque ouverture

`inbound_default_policy = "drop"`. Tout ce qui n'est pas listé est jeté.

| Port | Ouvert par défaut  | Justification                                                        |
| ---- | ------------------ | -------------------------------------------------------------------- |
| 22   | non, liste vide    | Administration par clé, depuis des plages nominatives uniquement      |
| 80   | oui                | Validation ACME HTTP-01 et redirection permanente vers HTTPS          |
| 443  | oui                | Seul point d'entrée applicatif                                        |
| ICMP | non                | Utile en diagnostic, mais facilite la cartographie du parc            |
| 5432 | **jamais**         | La base n'est pas exposée sur l'Internet public                       |

`admin_ssh_cidrs` vaut `[]` par défaut : sans décision explicite, aucun accès
SSH n'est ouvert depuis l'Internet. Une validation refuse `0.0.0.0/0`.
`additional_inbound_rules` refuse le port 5432.

### La base n'est jamais exposée

Un groupe de sécurité Scaleway ne filtre que l'interface **publique** ; le
trafic d'un réseau privé n'y est pas soumis. La protection repose donc sur deux
barrières indépendantes :

1. aucune règle entrante n'ouvre le port PostgreSQL — garanti par le code ;
2. PostGIS doit être configuré pour n'écouter que sur la boucle locale ou sur
   l'adresse privée de l'instance, avec un `pg_hba.conf` qui refuse tout réseau
   non privé — **relève du provisionnement, hors Terraform**.

La sortie `private_ips` fournit l'adresse sur laquelle lier le service.

### Accès administrateur par clé, jamais par mot de passe

Le cloud-init généré positionne `ssh_pwauth: false`, `disable_root: true` et
`lock_passwd: true` sur le compte d'administration. Seules des clés publiques
sont acceptées. Une clé publique n'est pas un secret et peut figurer dans un
fichier de variables ; aucune clé privée ni mot de passe ne doit apparaître dans
le dépôt.

### Volume de données séparé

Le volume système est jetable : il ne porte que le système et des images de
conteneurs, qui se reconstruisent. Il est marqué `delete_on_termination = true`.

Le volume de données est une **ressource indépendante**. Remplacer l'instance,
changer d'image ou migrer de type ne le touche pas.

`prevent_destroy` n'a pas été utilisé : Terraform refuse une variable à cet
endroit (vérifié, message « Variables may not be used here »), et une valeur
littérale `true` rendrait impossible le démantèlement légitime de la
préproduction. La protection passe plutôt par `enable_server_protection`, à
positionner à `true` en production.

### Étiquetage

Toute ressource porte au minimum :

```text
projet=appui-feux
environnement=production|preproduction
gestion=terraform
module=server-environment
```

Le volume de données porte en plus `role=donnees-postgis`. Ces étiquettes
rendent le coût imputable et font ressortir une ressource orpheline lors d'une
revue de facture.

### Valeurs par défaut

Le principe est : **le moins coûteux et le moins ouvert possible**. Une erreur
d'inattention doit produire une machine modeste et fermée.

| Variable                 | Défaut          | Pourquoi                                                       |
| ------------------------ | --------------- | -------------------------------------------------------------- |
| `server_type`            | `DEV1-S`        | 6,55 EUR/mois, le type le plus modeste                          |
| `image`                  | `ubuntu_noble`  | Ubuntu 24.04 LTS, support long, étiquette vérifiée sur l'API    |
| `data_volume_size_in_gb` | `20`            | ~1,99 EUR/mois à 0,0993 EUR/Go/mois ; s'agrandit, ne réduit pas |
| `data_volume_iops`       | `5000`          | Option d'entrée de gamme, suffisante pour le MVP                |
| `dns_ttl`                | `300`           | Bascule possible en quelques minutes pendant un incident        |
| `admin_ssh_cidrs`        | `[]`            | Pas d'accès SSH sans décision explicite                         |
| `block_outbound_smtp`    | `true`          | Empêche l'usage de l'instance comme relais de pourriel          |

Tarifs relevés le 2026-07-27 : `DEV1-S` 6,55 — `DEV1-M` 14,74 — `DEV1-L` 31,27
— `PLAY2-MICRO` 40,21 EUR/mois. Stockage bloc 0,0993 EUR/Go/mois.

Recommandations par environnement :

- **préproduction** : `DEV1-S`. Un jeu de données anonymisé et une base de
  démonstration n'ont pas besoin de plus.
- **production** : `DEV1-L`. L'instance porte l'application, PostGIS et un proxy
  TLS ; 8 Go laissent de la marge au cache de PostgreSQL. `PLAY2-MICRO` est plus
  cher pour moins de mémoire, il n'est pas retenu.

## Entrées

### Obligatoires

| Nom                | Type     | Description                                        |
| ------------------ | -------- | -------------------------------------------------- |
| `environment`      | `string` | `production` ou `preproduction`                    |
| `project_id`       | `string` | Projet Scaleway dédié                              |
| `dns_record_name`  | `string` | Nom dans la zone ; chaîne vide pour l'apex         |

### Facultatives

| Nom                        | Type           | Défaut          |
| -------------------------- | -------------- | --------------- |
| `application_name`         | `string`       | `appui-feux`    |
| `zone`                     | `string`       | `null`          |
| `server_type`              | `string`       | `DEV1-S`        |
| `image`                    | `string`       | `ubuntu_noble`  |
| `root_volume_type`         | `string`       | `null`          |
| `root_volume_size_in_gb`   | `number`       | `null`          |
| `root_volume_iops`         | `number`       | `null`          |
| `enable_server_protection` | `bool`         | `false`         |
| `data_volume_size_in_gb`   | `number`       | `20`            |
| `data_volume_iops`         | `number`       | `5000`          |
| `admin_user_name`          | `string`       | `appui`         |
| `ssh_authorized_keys`      | `list(string)` | `[]`            |
| `cloud_init`               | `string`       | `null`          |
| `admin_ssh_cidrs`          | `list(string)` | `[]`            |
| `ssh_port`                 | `number`       | `22`            |
| `enable_http_ingress`      | `bool`         | `true`          |
| `enable_https_ingress`     | `bool`         | `true`          |
| `icmp_ingress_cidrs`       | `list(string)` | `[]`            |
| `outbound_default_policy`  | `string`       | `accept`        |
| `block_outbound_smtp`      | `bool`         | `true`          |
| `additional_inbound_rules` | `list(object)` | `[]`            |
| `private_network_id`       | `string`       | `null`          |
| `dns_zone`                 | `string`       | `appuifeux.fr`  |
| `create_dns_record`        | `bool`         | `true`          |
| `dns_ttl`                  | `number`       | `300`           |
| `enable_reverse_dns`       | `bool`         | `true`          |
| `additional_tags`          | `list(string)` | `[]`            |

`root_volume_type` accepte `l_ssd` ou `sbs_volume`. Laissé à `null`, la valeur
associée au type d'instance s'applique, ce qui est toujours valide. Un volume
local (`l_ssd`) impose sa taille : ne renseigner `root_volume_size_in_gb` que
si le type retenu l'autorise.

## Sorties

| Nom                      | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| `server_id`              | Identifiant zoné de l'instance                            |
| `server_name`            | Nom dans la console                                       |
| `server_type`            | Type réellement appliqué                                  |
| `public_ipv4_address`    | Adresse IPv4 flexible                                     |
| `public_ipv4_id`         | Identifiant de l'adresse, survit au remplacement          |
| `private_ips`            | Adresses privées ; c'est là que PostGIS doit écouter      |
| `security_group_id`      | Identifiant du groupe de sécurité                         |
| `data_volume_id`         | Volume portant la base, à citer dans le runbook           |
| `data_volume_size_in_gb` | Taille effective, pour le suivi de coût                   |
| `fqdn`                   | Nom pleinement qualifié servi                             |
| `dns_record_id`          | Identifiant de l'enregistrement A, ou `null`              |
| `tags`                   | Étiquettes appliquées                                     |
| `ssh_command`            | Commande de connexion, pour le runbook                    |

Aucune sortie ne contient de secret.

## Ce qui manque encore

Ce module s'arrête à l'infrastructure. Les éléments suivants sont
**identifiés, non couverts**, et doivent l'être avant toute mise en service
réelle.

### Sauvegarde — US-111

Le choix d'auto-héberger PostGIS transfère entièrement la sauvegarde sur nous.
Le module `object-storage` fournit le seau chiffré et la politique de rétention.
Restent à écrire :

- le script de sauvegarde (`pg_dump` logique et/ou `pg_basebackup` physique),
  sa planification et sa journalisation ;
- le dépôt vers Object Storage avec une clé d'API applicative **restreinte à
  l'écriture** sur le seul seau de sauvegardes, distincte de la clé de
  déploiement ;
- le chiffrement côté client si la confidentialité doit survivre à une
  compromission du compte de stockage ;
- le **test de restauration** et sa preuve, exigés par
  `backlog/release-checklist.md` et `docs/operations.md` ;
- la supervision de l'âge de la dernière sauvegarde réussie : une sauvegarde
  qui échoue en silence est pire que pas de sauvegarde.

### Provisionnement de la machine

- Formatage et montage du volume de données, et garantie qu'il ne sera **jamais**
  reformaté au redémarrage.
- Installation du moteur de conteneurs, de PostGIS et du proxy TLS.
- Liaison de PostgreSQL à la boucle locale ou à l'adresse privée, et
  `pg_hba.conf` refusant tout réseau non privé.
- Obtention et renouvellement automatique du certificat TLS.

### Exploitation

- Sonde de supervision et alertes, alignées sur `docs/observability.md`.
- Correctifs de sécurité du système au-delà du premier démarrage.
- Procédure de bascule en lecture seule, exigée par les runbooks de
  `docs/operations.md`.
- Chaîne de déploiement automatisée : hors périmètre de cette itération, aucun
  fichier n'est écrit sous `.github/`.

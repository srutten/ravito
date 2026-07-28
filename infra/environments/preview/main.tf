# ---------------------------------------------------------------------------
# Appui Feux — composition de l'environnement de PRÉVISUALISATION
#
# AVERTISSEMENT : AUCUNE RESSOURCE N'EST APPLIQUÉE À CE JOUR. Ce fichier est
# écrit, formaté et validé hors ligne. Il n'a jamais été planifié ni appliqué
# sur le compte Scaleway. Rien n'est facturé.
#
# ---------------------------------------------------------------------------
# POURQUOI UN CONTENEUR SERVERLESS NE PEUT PAS HÉBERGER LA BASE
# ---------------------------------------------------------------------------
#
# C'est la contrainte qui structure tout ce fichier, elle mérite d'être écrite
# en toutes lettres.
#
# Un Serverless Container est SANS ÉTAT. Sa mise à l'échelle jusqu'à zéro — la
# raison même de le choisir pour des prévisualisations — signifie que le
# fournisseur arrête la dernière instance du conteneur quand plus personne ne
# l'appelle, et en démarre une neuve à la requête suivante. Le stockage local du
# conteneur est éphémère et disparaît avec l'instance ; il n'existe aucun moyen
# d'y attacher un volume persistant. Un cluster PostgreSQL, lui, est exactement
# l'inverse : un processus permanent qui détient un verrou sur un répertoire de
# données et qui doit survivre au redémarrage. Faire tourner PostGIS dans le
# conteneur de prévisualisation reviendrait à perdre la base entre deux
# consultations de la pull request, et à corrompre le répertoire de données dès
# que deux instances démarreraient en parallèle sous la charge.
#
# La base de prévisualisation est donc portée par une INSTANCE dédiée, allumée
# en continu, PARTAGÉE entre toutes les pull requests, avec UNE BASE DE DONNÉES
# LOGIQUE PAR PULL REQUEST, créée avec l'environnement et supprimée avec lui.
#
# Conséquence de coût, à ne pas escamoter : la mise à l'échelle à zéro rend le
# CALCUL des previews quasi gratuit au repos, elle ne rend pas les previews
# gratuites. L'instance qui porte la base tourne et se facture en continu, qu'il
# y ait zéro ou dix pull requests ouvertes.
#
# ---------------------------------------------------------------------------
# La base de preview n'est pas exposée sur l'Internet public
# ---------------------------------------------------------------------------
#
# docs/infrastructure.md signalait un point ouvert : « un conteneur serverless
# de preview doit joindre la base de preview ; sans intégration au réseau privé,
# la seule alternative est une exposition publique filtrée, ce qui contredit la
# règle ». Ce point est tranché ici SANS contourner la règle : le fournisseur
# scaleway/scaleway 2.79.0 expose « private_network_id » aussi bien sur
# scaleway_container que sur scaleway_instance_server. Le conteneur et
# l'instance de base sont donc rattachés au MÊME réseau privé, et le groupe de
# sécurité de la base n'ouvre AUCUN port entrant sur l'interface publique.
#
# Réserve honnête : cette intégration n'a jamais été appliquée ni observée sur
# le compte. Elle est vérifiée sur la documentation du fournisseur à la version
# épinglée, pas en exécution.
#
# ---------------------------------------------------------------------------
# Ce que cette composition NE fait pas
# ---------------------------------------------------------------------------
#
#   — elle ne crée PAS la base logique d'une pull request. Terraform ne parle
#     pas SQL sans un fournisseur PostgreSQL, qui exigerait des identifiants de
#     base au moment du plan et une connexion au cluster depuis le poste. La
#     création (CREATE DATABASE) et la suppression (DROP DATABASE) relèvent de
#     la chaîne de déploiement, hors périmètre de cette itération. Le nom
#     attendu est déterministe : voir la sortie « preview_database_names ».
#   — elle ne crée PAS le registre d'images. Le registre sert TOUS les
#     environnements et appartient à la chaîne de construction : le placer dans
#     l'état d'un seul environnement en ferait une ressource partagée détruite
#     par un « destroy » de preview. Il n'existe aujourd'hui ni Dockerfile ni
#     image (US-004).
#   — elle ne DÉTRUIT rien automatiquement à la fermeture d'une pull request :
#     retirer l'entrée de « preview_environments » et appliquer suffit à
#     détruire le conteneur, son enregistrement DNS et sa liaison de domaine,
#     mais c'est la chaîne de déploiement qui devrait le faire, et elle n'existe
#     pas (aucun fichier n'est écrit sous .github/, hors périmètre).
# ---------------------------------------------------------------------------

terraform {
  required_version = "~> 1.14"

  required_providers {
    # Version épinglée exactement, identique au socle et aux deux modules.
    scaleway = {
      source  = "scaleway/scaleway"
      version = "2.79.0"
    }
  }

  # -------------------------------------------------------------------------
  # État distant, configuration PARTIELLE
  #
  #   terraform init -backend-config="key=preview/terraform.tfstate"
  # -------------------------------------------------------------------------
  backend "s3" {
    bucket = "appui-feux-tfstate"
    region = "fr-par"

    endpoints = {
      s3 = "https://s3.fr-par.scw.cloud"
    }

    # Vérifications propres à AWS, sans objet face à une implémentation S3
    # tierce, et qui feraient échouer l'initialisation.
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true

    use_path_style = true
    encrypt        = true

    # Verrou natif du backend S3, non vérifié sur Object Storage Scaleway.
    # C'est ici que le risque est le plus concret : plusieurs pull requests
    # peuvent vouloir appliquer en même temps. Tant que le verrou n'est pas
    # constaté, une seule application à la fois.
    use_lockfile = true
  }
}

# ---------------------------------------------------------------------------
# Fournisseur
#
# Aucun identifiant ici. La clé d'API est lue dans l'environnement d'exécution.
# ---------------------------------------------------------------------------
provider "scaleway" {
  region     = var.region
  zone       = var.zone
  project_id = var.project_id

  organization_id = var.organization_id
}

locals {
  name_prefix = "${var.application_name}-preview"

  # Étiquetage. Ces ressources n'appartiennent à aucun module : la convention du
  # socle est reproduite à l'identique pour qu'une revue de facture filtre de la
  # même façon partout, et qu'une ressource orpheline saute aux yeux.
  common_tags = concat(
    [
      "projet=${var.application_name}",
      "environnement=preview",
      "gestion=terraform",
      "composition=preview",
      "donnees=fictives",
    ],
    var.additional_tags,
  )

  # Indexation par numéro de pull request. La clé est une chaîne : c'est elle
  # qu'on lit dans le plan, et c'est elle qui apparaît dans les noms.
  preview_environments = {
    for preview in var.preview_environments :
    tostring(preview.pull_request_number) => preview
  }

  # Nom de la base logique d'une pull request. Déterministe, pour que la chaîne
  # de déploiement puisse le recalculer sans lire l'état Terraform. Les tirets
  # sont proscrits dans un identifiant PostgreSQL non cité.
  database_name_prefix = replace(var.application_name, "-", "_")

  preview_database_names = {
    for key, preview in local.preview_environments :
    key => coalesce(preview.database_name, "${local.database_name_prefix}_pr_${key}")
  }

  # Adresse à laquelle joindre la base depuis les conteneurs. On retient la
  # première adresse privée IPv4 de l'instance : les adresses privées sont
  # remontées en IPv4 et en IPv6 mélangées, et une URL PostgreSQL avec une
  # adresse IPv6 nue exigerait des crochets, source d'erreur silencieuse.
  # « preview_database_host » permet de forcer une valeur, par exemple un nom
  # interne, sans toucher au code.
  database_private_ipv4_addresses = [
    for private_ip in scaleway_instance_server.preview_database.private_ips :
    private_ip.address if !strcontains(private_ip.address, ":")
  ]

  database_host = (
    var.preview_database_host != null && var.preview_database_host != ""
    ? var.preview_database_host
    : try(local.database_private_ipv4_addresses[0], "")
  )

  # Nom pleinement qualifié d'une prévisualisation : pr-<numéro>.dev.appuifeux.fr
  preview_record_names = {
    for key, preview in local.preview_environments :
    key => "pr-${key}.${var.preview_subdomain}"
  }

  # Durcissement minimal de l'hôte de base, appliqué au premier démarrage.
  # Identique à celui du module server-environment : pas d'authentification par
  # mot de passe, pas de connexion root, compte d'administration par clé.
  #
  # L'installation de PostGIS, le formatage et le montage du volume de données
  # et la liaison du service à l'adresse privée relèvent du provisionnement, pas
  # de Terraform.
  database_cloud_init = join("\n", [
    "#cloud-config",
    yamlencode({
      disable_root    = true
      ssh_pwauth      = false
      package_update  = true
      package_upgrade = true
      users = [
        {
          name                = var.admin_user_name
          groups              = ["sudo"]
          shell               = "/bin/bash"
          sudo                = "ALL=(ALL) NOPASSWD:ALL"
          lock_passwd         = true
          ssh_authorized_keys = var.ssh_authorized_keys
        },
      ]
    }),
  ])

  # Tarifs relevés sur le compte le 2026-07-27. Seuls chiffres constatés.
  instance_monthly_price_eur = {
    "DEV1-S"      = 6.55
    "DEV1-M"      = 14.74
    "DEV1-L"      = 31.27
    "PLAY2-MICRO" = 40.21
  }

  block_storage_monthly_price_eur_per_gb = 0.0993

  instance_price_eur = lookup(local.instance_monthly_price_eur, var.database_server_type, null)

  estimated_monthly_cost_eur = (
    local.instance_price_eur == null
    ? null
    : local.instance_price_eur + var.database_volume_size_in_gb * local.block_storage_monthly_price_eur_per_gb
  )
}

# ---------------------------------------------------------------------------
# Réseau privé
#
# Il porte le seul trafic qui n'a pas le droit de passer par l'Internet : celui
# entre les conteneurs de prévisualisation et la base partagée. Aucun
# identifiant de VPC n'est précisé, le VPC par défaut du projet dédié est donc
# utilisé — le projet ne contient que cette plateforme, il n'y a rien à isoler
# de plus.
# ---------------------------------------------------------------------------
resource "scaleway_vpc_private_network" "preview" {
  name       = "${local.name_prefix}-reseau-prive"
  project_id = var.project_id
  region     = var.region
  tags       = local.common_tags

  # Sous-réseau IPv4 explicite si l'on veut des adresses prévisibles, par
  # exemple pour écrire un pg_hba.conf sans découvrir l'adresse après coup.
  dynamic "ipv4_subnet" {
    for_each = var.private_network_ipv4_subnet == null ? [] : [var.private_network_ipv4_subnet]

    content {
      subnet = ipv4_subnet.value
    }
  }
}

# ---------------------------------------------------------------------------
# Hôte de la base de prévisualisation — adresse IP
#
# Une adresse publique est attachée bien qu'aucun port entrant ne soit ouvert :
# sans elle, l'instance ne peut pas récupérer ses correctifs de sécurité ni
# télécharger l'image de PostGIS. Le filtrage entrant reste en refus total.
# ---------------------------------------------------------------------------
resource "scaleway_instance_ip" "preview_database" {
  type       = "routed_ipv4"
  zone       = var.zone
  project_id = var.project_id
}

# ---------------------------------------------------------------------------
# Hôte de la base de prévisualisation — groupe de sécurité
#
# C'est le groupe le plus fermé des trois environnements, et c'est normal : cet
# hôte ne sert AUCUN service au public. Ni 80, ni 443, ni 5432. Le seul trafic
# légitime arrive par le réseau privé.
#
# Rappel de la limite du modèle Scaleway : un groupe de sécurité ne filtre que
# l'interface PUBLIQUE. Le trafic du réseau privé n'y est pas soumis, ce qui est
# précisément ce qu'on veut ici, mais cela déplace la responsabilité : PostGIS
# doit être configuré pour n'écouter que sur l'adresse privée, avec un
# pg_hba.conf qui n'autorise que le sous-réseau privé. Cela relève du
# provisionnement, hors Terraform.
# ---------------------------------------------------------------------------
resource "scaleway_instance_security_group" "preview_database" {
  name        = "${local.name_prefix}-base-sg"
  description = "Appui Feux preview : hote de base, aucun port public"
  zone        = var.zone
  project_id  = var.project_id
  tags        = local.common_tags

  stateful = true

  # Refus total en entrée. Aucune règle d'ouverture n'est écrite ci-dessous en
  # dehors de l'administration, elle-même vide par défaut.
  inbound_default_policy = "drop"

  # Sortie ouverte : correctifs de sécurité, téléchargement des images.
  outbound_default_policy = "accept"

  # Blocage du SMTP sortant. Cet hôte n'a aucune raison d'envoyer du courriel ;
  # le blocage limite l'intérêt de la machine pour un attaquant.
  enable_default_security = true

  # Administration par clé, depuis des plages nominatives. Liste vide par
  # défaut : sans décision explicite, l'hôte de base n'est joignable par
  # personne depuis l'Internet.
  dynamic "inbound_rule" {
    for_each = var.admin_ssh_cidrs

    content {
      action   = "accept"
      protocol = "TCP"
      port     = var.ssh_port
      ip_range = inbound_rule.value
    }
  }
}

# ---------------------------------------------------------------------------
# Hôte de la base de prévisualisation — volume de données
#
# Séparé du volume système pour la même raison qu'ailleurs : l'hôte peut être
# remplacé sans emporter les bases logiques des pull requests ouvertes. Dix
# gigaoctets suffisent, les données sont fictives et volontairement réduites.
# ---------------------------------------------------------------------------
resource "scaleway_block_volume" "preview_database" {
  name       = "${local.name_prefix}-base-donnees"
  zone       = var.zone
  project_id = var.project_id
  size_in_gb = var.database_volume_size_in_gb
  iops       = var.database_volume_iops

  tags = concat(local.common_tags, ["role=donnees-postgis-partagees"])

  lifecycle {
    # Après une restauration, le volume est recréé à partir d'un instantané ;
    # sans cette exception, le plan suivant voudrait revenir au volume d'origine.
    ignore_changes = [snapshot_id]
  }
}

# ---------------------------------------------------------------------------
# Hôte de la base de prévisualisation — instance
#
# Cette instance n'utilise PAS le module server-environment, pour deux raisons
# indépendantes :
#
#   1. le module refuse explicitement environment = "preview" — sa validation
#      dit « les previews utilisent des Serverless Containers », ce qui est vrai
#      de l'application mais pas de sa base ;
#   2. le profil réseau est fondamentalement différent : pas de port 80, pas de
#      port 443, pas d'enregistrement DNS public, pas de DNS inverse. Réutiliser
#      le module imposerait de désactiver la moitié de ce qu'il apporte, et de
#      l'étiqueter comme un environnement qu'il n'est pas.
#
# La duplication porte sur quatre ressources et est assumée. Si un troisième
# hôte de ce type apparaissait, il faudrait en faire un module « database-host »
# plutôt que de recopier une troisième fois.
# ---------------------------------------------------------------------------
resource "scaleway_instance_server" "preview_database" {
  name       = "${local.name_prefix}-base"
  type       = var.database_server_type
  image      = var.database_image
  zone       = var.zone
  project_id = var.project_id
  tags       = concat(local.common_tags, ["role=base-partagee"])

  security_group_id = scaleway_instance_security_group.preview_database.id
  ip_id             = scaleway_instance_ip.preview_database.id

  # Protection désactivée : l'environnement de prévisualisation est jetable par
  # construction, ses données sont fictives et sa reconstruction doit rester
  # possible sans intervention manuelle.
  protected = false

  root_volume {
    delete_on_termination = true
  }

  additional_volume_ids = [scaleway_block_volume.preview_database.id]

  user_data = {
    "cloud-init" = local.database_cloud_init
  }

  # Rattachement au réseau privé : c'est par là, et uniquement par là, que les
  # conteneurs de prévisualisation joignent la base.
  private_network {
    pn_id = scaleway_vpc_private_network.preview.id
  }
}

# ---------------------------------------------------------------------------
# Espace de noms des Serverless Containers
#
# Un seul espace pour toutes les prévisualisations : c'est l'unité de
# facturation et de quota, et elle survit aux pull requests qui vont et
# viennent.
# ---------------------------------------------------------------------------
resource "scaleway_container_namespace" "preview" {
  name        = "${local.name_prefix}-conteneurs"
  description = "Appui Feux : previsualisations de pull requests"
  project_id  = var.project_id
  tags        = local.common_tags
}

# ---------------------------------------------------------------------------
# Conteneur d'une pull request
#
# La liste « preview_environments » est VIDE par défaut : appliquer cet
# environnement crée le socle partagé — réseau privé, hôte de base, espace de
# noms, seaux — et rien d'autre. Chaque entrée ajoutée crée une prévisualisation
# complète ; chaque entrée retirée la détruit, avec son enregistrement DNS et sa
# liaison de domaine. C'est le mécanisme de destruction attendu à la fermeture
# d'une pull request ; il devrait être piloté par la chaîne de déploiement, qui
# n'existe pas dans cette itération.
# ---------------------------------------------------------------------------
resource "scaleway_container" "preview" {
  for_each = local.preview_environments

  name         = "${var.application_name}-pr-${each.key}"
  description  = "Previsualisation de la pull request ${each.key}"
  namespace_id = scaleway_container_namespace.preview.id
  tags         = concat(local.common_tags, ["pull-request=${each.key}"])

  # Image applicative, construite par la chaîne de déploiement et désignée par
  # l'empreinte du commit. Aucune image n'existe aujourd'hui.
  image = each.value.image
  port  = var.container_port

  # « registry_sha256 » force un redéploiement lorsque l'image change sans que
  # son adresse change, ce qui est le cas d'une étiquette mutable.
  registry_sha256 = each.value.registry_sha256

  # Mise à l'échelle JUSQU'À ZÉRO : une pull request que personne ne consulte ne
  # consomme aucun calcul. C'est la raison d'être du choix serverless ici.
  min_scale = each.value.min_scale
  max_scale = coalesce(each.value.max_scale, var.container_max_scale)

  # Le couple mémoire/vCPU n'est pas libre chez Scaleway : 1024 Mo correspond à
  # 560 milli-vCPU. Un couple incohérent est refusé par l'API.
  cpu_limit          = var.container_cpu_limit
  memory_limit_bytes = var.container_memory_limit_bytes

  privacy  = var.container_privacy
  protocol = "http1"

  # Redirection permanente de HTTP vers HTTPS. docs/security.md impose TLS ;
  # une prévisualisation ne fait pas exception, ne serait-ce que pour ne pas
  # prendre l'habitude inverse.
  https_connections_only = true

  # Rattachement au réseau privé de la base. C'est ce qui permet de ne JAMAIS
  # exposer PostgreSQL sur l'Internet public, y compris en prévisualisation.
  private_network_id = scaleway_vpc_private_network.preview.id

  # Variables non secrètes. Le nom de la base logique est transmis pour que
  # l'application n'ait pas à le deviner, et le drapeau d'environnement rend le
  # bandeau « données fictives » possible côté interface.
  environment_variables = merge(
    {
      APP_ENVIRONMENT     = "preview"
      PULL_REQUEST_NUMBER = each.key
      DATABASE_NAME       = local.preview_database_names[each.key]
      PUBLIC_BASE_URL     = "https://${local.preview_record_names[each.key]}.${var.dns_zone}"
      STORAGE_ENDPOINT    = module.storage.s3_endpoint
      STORAGE_BUCKET      = module.storage.documents_bucket_name
    },
    var.container_environment_variables,
    each.value.environment_variables,
  )

  # -------------------------------------------------------------------------
  # Variables secrètes
  #
  # AUCUNE VALEUR N'EST ÉCRITE DANS LE DÉPÔT. « preview_database_password » n'a
  # pas de valeur par défaut et n'apparaît dans aucun fichier .example : elle
  # est fournie au moment de l'application par la variable d'environnement
  # TF_VAR_preview_database_password, alimentée depuis le gestionnaire de
  # secrets, conformément à docs/security.md.
  #
  # Si le mot de passe n'est pas fourni, aucune URL de base n'est transmise : le
  # conteneur démarre et échoue proprement au premier accès, plutôt que de se
  # connecter à une base inattendue.
  #
  # À savoir avant d'appliquer : ces valeurs sont stockées dans l'état
  # Terraform. C'est l'une des raisons pour lesquelles le seau d'état est privé
  # et séparé.
  # -------------------------------------------------------------------------
  secret_environment_variables = var.preview_database_password == null ? {} : {
    DATABASE_URL = format(
      "postgresql://%s:%s@%s:%d/%s",
      var.preview_database_user,
      urlencode(var.preview_database_password),
      local.database_host,
      var.preview_database_port,
      local.preview_database_names[each.key],
    )
  }
}

# ---------------------------------------------------------------------------
# Enregistrement DNS d'une pull request
#
# pr-<numéro>.dev.appuifeux.fr, en CNAME vers le point d'accès natif du
# conteneur. La zone appuifeux.fr existe déjà : on n'y écrit que des
# enregistrements, on ne la recrée jamais.
#
# Il n'existe pas de zone « dev.appuifeux.fr » séparée, et il n'en est pas créé :
# « pr-42.dev » est un simple nom dans la zone principale.
# ---------------------------------------------------------------------------
resource "scaleway_domain_record" "preview" {
  for_each = local.preview_environments

  dns_zone = var.dns_zone
  name     = local.preview_record_names[each.key]
  type     = "CNAME"

  # Le point final est significatif dans un CNAME : sans lui, le résolveur
  # ajouterait la zone au nom cible.
  data = format("%s.", trimprefix(scaleway_container.preview[each.key].public_endpoint, "https://"))

  # Durée de vie courte : une prévisualisation apparaît et disparaît avec sa
  # pull request, un cache long laisserait des noms qui pointent dans le vide.
  ttl = var.dns_ttl
}

# ---------------------------------------------------------------------------
# Liaison du nom personnalisé au conteneur
#
# Scaleway vérifie que le CNAME existe et pointe bien vers le conteneur avant
# d'accepter la liaison, et c'est lui qui délivre le certificat TLS du nom
# personnalisé. L'ordre est donc imposé : enregistrement DNS d'abord.
# ---------------------------------------------------------------------------
resource "scaleway_container_domain" "preview" {
  for_each = local.preview_environments

  container_id = scaleway_container.preview[each.key].id
  hostname     = "${local.preview_record_names[each.key]}.${var.dns_zone}"

  depends_on = [scaleway_domain_record.preview]
}

# ---------------------------------------------------------------------------
# Seaux privés de prévisualisation
#
# Strictement séparés de ceux de production et de préproduction. Une
# prévisualisation exécute du code issu d'une branche NON FUSIONNÉE : elle ne
# doit partager ni identifiant, ni seau, ni base avec un environnement qui porte
# des données réelles.
#
# Le module crée toujours deux seaux, documents et sauvegardes. Le seau de
# sauvegardes restera VIDE ici : aucune sauvegarde n'est attendue d'un
# environnement jetable dont les données sont fictives. Sa rétention est réglée
# au minimum accepté par le module. Un seau vide ne coûte que ses requêtes.
# ---------------------------------------------------------------------------
module "storage" {
  source = "../../modules/object-storage"

  application_name = var.application_name
  environment      = "preview"
  project_id       = var.project_id
  region           = var.region

  backup_retention_days                       = var.backup_retention_days
  documents_noncurrent_version_retention_days = var.documents_noncurrent_version_retention_days

  # true, contrairement aux deux autres environnements. C'est le seul
  # environnement réellement jetable : ses données sont fictives et sa
  # destruction fait partie de son cycle de vie normal. Un « terraform destroy »
  # supprimera donc les seaux MÊME REMPLIS. C'est voulu ici, cela ne le serait
  # nulle part ailleurs.
  force_destroy = var.force_destroy

  additional_tags = merge(var.additional_bucket_tags, { donnees = "fictives" })
}

# ---------------------------------------------------------------------------
# Sorties
#
# Aucune sortie ne contient de secret. L'URL de base de données n'est pas
# exposée : elle contient un mot de passe.
# ---------------------------------------------------------------------------

output "preview_urls" {
  description = "URL publique de chaque prévisualisation, indexée par numéro de pull request. C'est ce lien qui serait publié en commentaire de la pull request."
  value       = { for key, record_name in local.preview_record_names : key => "https://${record_name}.${var.dns_zone}" }
}

output "container_endpoints" {
  description = "Point d'accès natif de chaque conteneur, avant liaison du nom personnalisé. Utile pour diagnostiquer un problème de DNS ou de certificat."
  value       = { for key, container in scaleway_container.preview : key => container.public_endpoint }
}

output "container_namespace_id" {
  description = "Identifiant régional de l'espace de noms des conteneurs. Unité de facturation et de quota des prévisualisations."
  value       = scaleway_container_namespace.preview.id
}

output "private_network_id" {
  description = "Identifiant du réseau privé qui relie les conteneurs à la base partagée. Aucun autre chemin n'existe entre eux."
  value       = scaleway_vpc_private_network.preview.id
}

output "database_server_id" {
  description = "Identifiant zoné de l'instance qui porte la base de prévisualisation partagée."
  value       = scaleway_instance_server.preview_database.id
}

output "database_private_ips" {
  description = <<-EOT
    Adresses privées de l'hôte de base. C'est sur l'adresse IPv4 de cette liste
    que PostGIS doit écouter, et c'est ce sous-réseau, et lui seul, que doit
    autoriser pg_hba.conf. L'hôte n'a aucun port ouvert sur l'Internet.
  EOT
  value       = scaleway_instance_server.preview_database.private_ips
}

output "database_volume_id" {
  description = "Identifiant du volume qui porte les bases logiques de prévisualisation."
  value       = scaleway_block_volume.preview_database.id
}

output "preview_database_names" {
  description = <<-EOT
    Nom de la base logique attendue pour chaque pull request.

    Terraform ne crée PAS ces bases : il ne parle pas SQL sans un fournisseur
    PostgreSQL, qui exigerait une connexion au cluster dès le plan. Le CREATE
    DATABASE à l'ouverture et le DROP DATABASE à la fermeture relèvent de la
    chaîne de déploiement. Le nom est déterministe pour qu'elle puisse le
    recalculer sans lire l'état.
  EOT
  value       = local.preview_database_names
}

output "documents_bucket_name" {
  description = "Seau des documents de prévisualisation. Séparé de celui de production : une branche non fusionnée n'accède à aucune donnée réelle."
  value       = module.storage.documents_bucket_name
}

output "backups_bucket_name" {
  description = "Seau de sauvegardes créé par le module mais volontairement INUTILISÉ en prévisualisation : aucune sauvegarde n'est attendue d'un environnement jetable."
  value       = module.storage.backups_bucket_name
}

output "storage_endpoint" {
  description = "Point d'accès S3 régional. Correspond à la variable d'environnement STORAGE_ENDPOINT."
  value       = module.storage.s3_endpoint
}

output "estimated_monthly_cost_eur" {
  description = <<-EOT
    Coût mensuel PLANCHER du socle partagé, en euros : instance de base plus
    volume, aux tarifs relevés le 2026-07-27.

    Ce montant est facturé EN CONTINU, y compris quand aucune pull request n'est
    ouverte : la mise à l'échelle à zéro annule le coût du calcul des
    conteneurs, pas celui de l'instance qui porte la base. Le coût des
    conteneurs eux-mêmes, à la consommation, n'est pas chiffré ici faute de
    tarif relevé.

    Restitué en chaîne à deux décimales : la somme en virgule flottante produit
    sinon une traîne de décimales qui rend la lecture du plan pénible.
  EOT
  value       = local.estimated_monthly_cost_eur == null ? null : format("%.2f", local.estimated_monthly_cost_eur)
}

output "open_preview_count" {
  description = "Nombre de prévisualisations déclarées. Une valeur qui ne redescend jamais est le signe que des pull requests fermées n'ont pas été nettoyées."
  value       = length(local.preview_environments)
}

output "tags" {
  description = "Étiquettes appliquées aux ressources de calcul de cet environnement."
  value       = local.common_tags
}

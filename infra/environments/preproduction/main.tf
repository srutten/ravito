# ---------------------------------------------------------------------------
# Appui Feux — composition de l'environnement de PRÉPRODUCTION
#
# AVERTISSEMENT : AUCUNE RESSOURCE N'EST APPLIQUÉE À CE JOUR. Ce fichier est
# écrit, formaté et validé hors ligne. Il n'a jamais été planifié ni appliqué
# sur le compte Scaleway. Rien n'est facturé.
#
# « Préproduction » ici et « staging » dans docs/deployment.md désignent le même
# environnement.
#
# ---------------------------------------------------------------------------
# Pourquoi ce répertoire redéclare le socle
# ---------------------------------------------------------------------------
#
# Chaque environnement est un module RACINE autonome : son propre état, sa
# propre configuration de fournisseur, sa propre clé d'objet dans le seau d'état
# commun. Terraform n'a aucun mécanisme d'inclusion entre modules racines : les
# fichiers infra/versions.tf, infra/providers.tf, infra/backend.tf et
# infra/variables.tf ne sont donc PAS hérités ici. Ils font référence, ce
# répertoire les reproduit.
#
# ---------------------------------------------------------------------------
# Ce que contient la préproduction, et en quoi elle diffère de la production
# ---------------------------------------------------------------------------
#
#   Même FORME que la production — instance, PostGIS auto-hébergé, volume de
#   données séparé, IP flexible, proxy TLS — pour que ce qui est éprouvé ici
#   soit représentatif de ce qui sera joué là-bas. Un environnement de
#   répétition qui ne ressemble pas à la production ne prouve rien.
#
#   Ce qui change, et pourquoi :
#
#   Dimensionnement  DEV1-S au lieu de DEV1-L, 20 Go au lieu de 40. Un jeu de
#                    données anonymisé et quelques comptes de test n'ont pas
#                    besoin de plus. Écart de coût : environ 27 EUR/mois.
#   Données          FICTIVES et anonymisées, conformément à la mesure
#                    « données de test anonymisées » de docs/privacy-rgpd.md.
#                    Aucune donnée réelle ne descend de la production.
#   Protection       protection Scaleway de l'instance DÉSACTIVÉE. C'est
#                    volontaire : la préproduction doit rester démontable et
#                    reconstructible sans intervention manuelle. C'est même son
#                    intérêt principal — c'est ici qu'on éprouve la procédure
#                    d'application, la migration et le rollback.
#   Sauvegardes      rétention de 7 jours au lieu de 35. docs/infrastructure.md
#                    qualifie la sauvegarde de préproduction de « souhaitable »,
#                    pas d'obligatoire : conserver un mois de sauvegardes de
#                    données fictives serait une dépense sans contrepartie.
#   Haute dispo.     AUCUNE, et aucune n'est visée. Instance unique, zone
#                    unique, pas de réplique, pas de bascule. Une indisponibilité
#                    de la préproduction n'a aucun effet sur le service.
#   Domaine          preprod.appuifeux.fr, sous-domaine de la zone principale.
#                    Aucun domaine secondaire ne pointe ici.
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
  # « key » est fourni à l'initialisation :
  #
  #   terraform init -backend-config="key=preproduction/terraform.tfstate"
  #
  # Un seul seau porte les trois états sous trois clés distinctes ; un « apply »
  # de préproduction ne peut donc pas écraser l'état de production. La commande
  # s'écrit toujours en entier, jamais de mémoire : une erreur de clé ferait
  # pointer cet environnement sur l'état d'un autre.
  #
  # L'absence de « key » permet aussi la validation hors ligne, sans identifiant.
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

    # Verrou natif du backend S3 : Scaleway ne propose pas d'équivalent de
    # DynamoDB. Le bon fonctionnement des écritures conditionnelles sur Object
    # Storage Scaleway n'a PAS été vérifié sur le compte.
    use_lockfile = true
  }
}

# ---------------------------------------------------------------------------
# Fournisseur
#
# Aucun identifiant ici. La clé d'API est lue dans l'environnement d'exécution
# (SCW_ACCESS_KEY, SCW_SECRET_KEY), jamais dans un fichier du dépôt.
# ---------------------------------------------------------------------------
provider "scaleway" {
  region     = var.region
  zone       = var.zone
  project_id = var.project_id

  organization_id = var.organization_id
}

locals {
  # Tarifs relevés sur le compte le 2026-07-27. Seuls chiffres constatés.
  instance_monthly_price_eur = {
    "DEV1-S"      = 6.55
    "DEV1-M"      = 14.74
    "DEV1-L"      = 31.27
    "PLAY2-MICRO" = 40.21
  }

  block_storage_monthly_price_eur_per_gb = 0.0993

  instance_price_eur = lookup(local.instance_monthly_price_eur, var.server_type, null)

  estimated_monthly_cost_eur = (
    local.instance_price_eur == null
    ? null
    : local.instance_price_eur + var.data_volume_size_in_gb * local.block_storage_monthly_price_eur_per_gb
  )
}

# ---------------------------------------------------------------------------
# Instance de préproduction, volume de données, groupe de sécurité, IP, DNS
# ---------------------------------------------------------------------------
module "server" {
  source = "../../modules/server-environment"

  application_name = var.application_name
  environment      = "preproduction"
  project_id       = var.project_id
  zone             = var.zone

  # DEV1-S : le type le plus modeste, 6,55 EUR/mois. Suffisant pour un jeu de
  # données anonymisé, quelques comptes de test et les parcours end-to-end.
  server_type = var.server_type

  # Volume de données séparé, comme en production. Ce n'est pas la donnée qui le
  # justifie ici — elle est fictive — mais la fidélité de la répétition : on
  # veut éprouver la même procédure de remplacement d'instance qu'en production.
  data_volume_size_in_gb = var.data_volume_size_in_gb
  data_volume_iops       = var.data_volume_iops

  # DÉSACTIVÉE, à l'inverse de la production. La préproduction doit pouvoir être
  # démontée et reconstruite sans intervention manuelle : c'est ce qui permet de
  # rejouer la procédure d'application de bout en bout.
  enable_server_protection = false

  admin_user_name     = var.admin_user_name
  ssh_authorized_keys = var.ssh_authorized_keys
  admin_ssh_cidrs     = var.admin_ssh_cidrs
  ssh_port            = var.ssh_port

  # 80 pour la validation ACME et la redirection permanente, 443 pour le
  # service. Le port de la base n'est jamais ouvert, même en préproduction :
  # prendre l'habitude ici, c'est ne pas la perdre en production.
  enable_http_ingress  = true
  enable_https_ingress = true

  # preprod.appuifeux.fr, sous-domaine de la zone principale déjà existante.
  dns_zone        = var.dns_zone
  dns_record_name = var.dns_record_name
  dns_ttl         = var.dns_ttl

  additional_tags = concat(var.additional_tags, ["donnees=fictives"])
}

# ---------------------------------------------------------------------------
# Seaux privés : documents applicatifs et sauvegardes
#
# Les mêmes seaux qu'en production, pour que le code applicatif rencontre la
# même forme de stockage. Ils sont DISTINCTS de ceux de production : une clé de
# préproduction ne doit jamais pouvoir lire un document réel.
# ---------------------------------------------------------------------------
module "storage" {
  source = "../../modules/object-storage"

  application_name = var.application_name
  environment      = "preproduction"
  project_id       = var.project_id
  region           = var.region

  # Sept jours, contre trente-cinq en production. C'est le minimum accepté par
  # le module. Sauvegarder des données fictives plus longtemps serait une
  # dépense sans contrepartie ; ne pas les sauvegarder du tout priverait de la
  # possibilité d'éprouver la restauration ici avant de la jouer en production.
  backup_retention_days = var.backup_retention_days

  # Sept jours également : rattraper une erreur de manipulation pendant une
  # session de test, sans conserver de traîne.
  documents_noncurrent_version_retention_days = var.documents_noncurrent_version_retention_days

  # false par défaut, MÊME EN PRÉPRODUCTION. Les données y sont fictives, mais
  # un seau vidé par erreur coûte quand même le temps de reconstituer le jeu de
  # test. Passer cette variable à true est un acte explicite, au moment du
  # démantèlement, et il se lit dans le plan.
  force_destroy = var.force_destroy

  additional_tags = merge(var.additional_bucket_tags, { donnees = "fictives" })
}

# ---------------------------------------------------------------------------
# Sorties
#
# Aucune sortie ne contient de secret.
# ---------------------------------------------------------------------------

output "fqdn" {
  description = "Nom pleinement qualifié servi par la préproduction."
  value       = module.server.fqdn
}

output "public_ipv4_address" {
  description = "Adresse IPv4 flexible de la préproduction."
  value       = module.server.public_ipv4_address
}

output "server_id" {
  description = "Identifiant zoné de l'instance de préproduction."
  value       = module.server.server_id
}

output "server_type" {
  description = "Type commercial réellement appliqué. Sert à vérifier que la préproduction n'a pas dérivé vers une machine de production."
  value       = module.server.server_type
}

output "data_volume_id" {
  description = "Identifiant du volume qui porte la base PostGIS de préproduction."
  value       = module.server.data_volume_id
}

output "private_ips" {
  description = "Adresses privées de l'instance. C'est là, ou sur la boucle locale, que PostGIS doit écouter."
  value       = module.server.private_ips
}

output "ssh_command" {
  description = "Commande de connexion administrateur, pour le runbook."
  value       = module.server.ssh_command
}

output "documents_bucket_name" {
  description = "Seau des documents de préproduction, distinct de celui de production."
  value       = module.storage.documents_bucket_name
}

output "backups_bucket_name" {
  description = "Seau des sauvegardes de préproduction, distinct de celui de production."
  value       = module.storage.backups_bucket_name
}

output "storage_endpoint" {
  description = "Point d'accès S3 régional. Correspond à la variable d'environnement STORAGE_ENDPOINT."
  value       = module.storage.s3_endpoint
}

output "estimated_monthly_cost_eur" {
  description = <<-EOT
    Coût mensuel PLANCHER de cet environnement, en euros : instance plus volume
    de données, aux tarifs relevés le 2026-07-27. Vaut null si le type
    d'instance ne figure pas dans les tarifs relevés.

    Ne contient pas : IP flexible, Object Storage, trafic sortant. Si cette
    valeur dépasse celle de la production, c'est une anomalie.

    Restitué en chaîne à deux décimales : la somme en virgule flottante produit
    sinon une traîne de décimales qui rend la lecture du plan pénible.
  EOT
  value       = local.estimated_monthly_cost_eur == null ? null : format("%.2f", local.estimated_monthly_cost_eur)
}

output "tags" {
  description = "Étiquettes appliquées aux ressources de calcul."
  value       = module.server.tags
}

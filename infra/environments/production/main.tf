# ---------------------------------------------------------------------------
# Appui Feux — composition de l'environnement de PRODUCTION
#
# AVERTISSEMENT : AUCUNE RESSOURCE N'EST APPLIQUÉE À CE JOUR. Ce fichier est
# écrit, formaté et validé hors ligne. Il n'a jamais été planifié ni appliqué
# sur le compte Scaleway. Rien n'est facturé. La décision d'appliquer appartient
# au fondateur ; la procédure figure dans README.md et dans
# ../../../docs/infrastructure.md.
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
# répertoire les reproduit. Toute montée de version du fournisseur se fait dans
# les quatre emplacements en une seule fois, dans une seule relecture.
#
# ---------------------------------------------------------------------------
# Ce que contient la production, et en quoi elle diffère des deux autres
# ---------------------------------------------------------------------------
#
#   Exécution        instance dédiée, jamais serverless : PostGIS est
#                    auto-hébergé et une base a besoin d'un processus permanent
#                    et d'un disque.
#   Dimensionnement  DEV1-L, plus large que la préproduction. L'instance porte
#                    l'application Next.js, PostGIS et un proxy TLS.
#   Volume           40 Go, séparé du volume système, pour que la base survive
#                    au remplacement de l'instance.
#   Protection       protection Scaleway de l'instance ACTIVÉE, seaux non
#                    destructibles tant qu'ils contiennent des objets.
#   Sauvegardes      seau chiffré dédié, rétention de 35 jours. Le script qui
#                    écrit dedans n'existe pas encore (US-111).
#   Accès            aucune plage SSH ouverte par défaut ; l'ouverture est un
#                    acte explicite, tracé dans terraform.tfvars.
#   Données          RÉELLES. C'est le seul environnement dans ce cas, et c'est
#                    ce qui justifie tout ce qui précède.
#   Domaines         appuifeux.fr à l'apex ; appuifeux.eu et firesupport.eu
#                    pointent ici pour être redirigés par le proxy.
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
  # « key » est volontairement absent : il est fourni à l'initialisation, ce qui
  # garantit qu'un « apply » de préproduction ne peut pas écraser l'état de
  # production.
  #
  #   terraform init -backend-config="key=production/terraform.tfstate"
  #
  # L'absence de « key » permet aussi la validation hors ligne, sans le moindre
  # identifiant :
  #
  #   terraform init -backend=false && terraform validate
  #
  # Le seau appui-feux-tfstate n'est créé par aucun Terraform : il est amorcé à
  # la main, une seule fois. Voir infra/README.md.
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

    # Verrou natif du backend S3, sans base externe : Scaleway ne propose pas
    # d'équivalent de DynamoDB. Le bon fonctionnement des écritures
    # conditionnelles sur Object Storage Scaleway n'a PAS été vérifié sur le
    # compte, faute d'amorçage. Tant que ce point n'est pas constaté, on
    # n'applique qu'à un seul endroit à la fois.
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
  # -------------------------------------------------------------------------
  # Estimation de coût, exposée en sortie
  #
  # Tarifs relevés sur le compte le 2026-07-27. Ce sont les seuls chiffres
  # constatés ; tout le reste est non chiffré, faute de tarif relevé.
  # L'estimation apparaît dans les sorties pour qu'une dérive de dimensionnement
  # soit visible au moment de la relecture du plan, et pas à la facture.
  # -------------------------------------------------------------------------
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

  # -------------------------------------------------------------------------
  # Enregistrements de redirection
  #
  # appuifeux.eu et firesupport.eu ne portent aucun environnement : ils
  # protègent la marque et rattrapent une faute de frappe. Le DNS ne sait que
  # POINTER ; la redirection permanente vers appuifeux.fr est servie par le
  # proxy TLS de l'instance, qui n'est pas encore provisionné. Tant qu'il ne
  # l'est pas, ces noms résolvent vers un service qui ne redirige pas.
  #
  # Chaque nom déclaré ici est un nom de plus à couvrir par le certificat TLS :
  # la valeur par défaut se limite donc à l'apex.
  # -------------------------------------------------------------------------
  redirect_records = {
    for pair in setproduct(var.alternate_dns_zones, var.redirect_record_names) :
    "${pair[0]}|${pair[1]}" => {
      dns_zone = pair[0]
      name     = pair[1]
    }
  }
}

# ---------------------------------------------------------------------------
# Instance de production, volume de données, groupe de sécurité, IP, DNS
# ---------------------------------------------------------------------------
module "server" {
  source = "../../modules/server-environment"

  application_name = var.application_name
  environment      = "production"
  project_id       = var.project_id
  zone             = var.zone

  # DEV1-L : l'instance porte l'application, PostGIS et le proxy TLS. Huit
  # gigaoctets laissent de la marge au cache de PostgreSQL. PLAY2-MICRO coûte
  # plus cher pour moins de mémoire, il n'est pas retenu.
  server_type = var.server_type

  # Volume de données séparé du volume système. C'est la contrepartie directe du
  # choix d'auto-héberger PostGIS : le volume système est jetable, celui-ci
  # porte le cluster et doit survivre au remplacement de l'instance.
  data_volume_size_in_gb = var.data_volume_size_in_gb
  data_volume_iops       = var.data_volume_iops

  # Valeur littérale, jamais une variable : en production, la protection
  # Scaleway contre la suppression de l'instance ne se désactive pas depuis un
  # fichier de variables. La désactiver doit exiger une modification de code,
  # relue.
  enable_server_protection = true

  # Accès administrateur par clé uniquement. La liste des plages est vide par
  # défaut : sans décision explicite, aucun accès SSH n'est ouvert depuis
  # l'Internet, et l'administration passe par la console Scaleway.
  admin_user_name     = var.admin_user_name
  ssh_authorized_keys = var.ssh_authorized_keys
  admin_ssh_cidrs     = var.admin_ssh_cidrs
  ssh_port            = var.ssh_port

  # 80 pour la validation ACME et la redirection permanente, 443 pour le
  # service. Rien d'autre. Le port de la base n'est jamais ouvert : le module
  # refuse d'ailleurs une règle sur 5432.
  enable_http_ingress  = true
  enable_https_ingress = true

  # Production à l'apex de la zone principale : appuifeux.fr.
  dns_zone        = var.dns_zone
  dns_record_name = ""
  dns_ttl         = var.dns_ttl

  additional_tags = concat(var.additional_tags, ["donnees=reelles"])
}

# ---------------------------------------------------------------------------
# Seaux privés : documents applicatifs et sauvegardes
# ---------------------------------------------------------------------------
module "storage" {
  source = "../../modules/object-storage"

  application_name = var.application_name
  environment      = "production"
  project_id       = var.project_id
  region           = var.region

  # Rétention des sauvegardes. Trente-cinq jours : un cycle mensuel complet plus
  # une marge. Le seau et sa politique existent ; le script qui écrit dedans
  # n'existe pas encore (US-111), et la restauration n'a jamais été testée
  # (US-112). Un seau de sauvegarde vide ne sauvegarde rien.
  backup_retention_days = var.backup_retention_days

  # Versions obsolètes de documents. Trente jours : assez pour rattraper une
  # suppression accidentelle, assez court pour qu'un effacement demandé au titre
  # du RGPD soit réellement honoré.
  documents_noncurrent_version_retention_days = var.documents_noncurrent_version_retention_days

  # false, et cela doit le rester : un « terraform destroy » distrait ne doit
  # pas emporter les pièces justificatives de toutes les organisations ni
  # l'historique des sauvegardes. La suppression d'un seau non vide échoue,
  # c'est le comportement voulu.
  force_destroy = false

  additional_tags = merge(var.additional_bucket_tags, { donnees = "reelles" })
}

# ---------------------------------------------------------------------------
# Domaines secondaires
#
# Les zones appuifeux.eu et firesupport.eu existent déjà, sont actives et en
# renouvellement automatique. On n'y crée QUE des enregistrements ; la zone
# elle-même n'est jamais recréée, ce qui effacerait les enregistrements de
# messagerie et de validation de domaine.
# ---------------------------------------------------------------------------
resource "scaleway_domain_record" "redirections" {
  for_each = local.redirect_records

  dns_zone = each.value.dns_zone
  name     = each.value.name
  type     = "A"

  # Même adresse que la production : c'est le proxy TLS qui distinguera les noms
  # et répondra par une redirection permanente vers appuifeux.fr.
  data = module.server.public_ipv4_address

  ttl = var.dns_ttl
}

# ---------------------------------------------------------------------------
# Sorties
#
# Aucune sortie ne contient de secret. Ce sont des références de ressources et
# des points d'accès ; sans clé d'API valide, ils ne donnent accès à rien.
# ---------------------------------------------------------------------------

output "fqdn" {
  description = "Nom pleinement qualifié servi par la production."
  value       = module.server.fqdn
}

output "public_ipv4_address" {
  description = "Adresse IPv4 flexible de la production. À inscrire dans une supervision externe ou dans un filtrage tiers."
  value       = module.server.public_ipv4_address
}

output "server_id" {
  description = "Identifiant zoné de l'instance de production."
  value       = module.server.server_id
}

output "server_type" {
  description = "Type commercial réellement appliqué. Sert à repérer une dérive de dimensionnement."
  value       = module.server.server_type
}

output "data_volume_id" {
  description = "Identifiant du volume qui porte la base PostGIS. À citer dans le runbook de restauration : c'est ce volume, et lui seul, qui contient les données."
  value       = module.server.data_volume_id
}

output "private_ips" {
  description = "Adresses privées de l'instance. C'est sur l'une d'elles, ou sur la boucle locale, que PostGIS doit écouter ; jamais sur l'adresse publique."
  value       = module.server.private_ips
}

output "ssh_command" {
  description = "Commande de connexion administrateur, pour le runbook. N'aboutit que si la plage d'appel figure dans admin_ssh_cidrs."
  value       = module.server.ssh_command
}

output "documents_bucket_name" {
  description = "Seau des documents applicatifs. Correspond à la variable d'environnement STORAGE_BUCKET."
  value       = module.storage.documents_bucket_name
}

output "backups_bucket_name" {
  description = "Seau des sauvegardes. À reprendre dans le script de US-111 et dans le runbook de restauration."
  value       = module.storage.backups_bucket_name
}

output "storage_endpoint" {
  description = "Point d'accès S3 régional. Correspond à la variable d'environnement STORAGE_ENDPOINT."
  value       = module.storage.s3_endpoint
}

output "redirect_fqdns" {
  description = "Noms des domaines secondaires pointant vers la production. La redirection permanente est servie par le proxy TLS, pas par le DNS."
  value       = [for record in scaleway_domain_record.redirections : record.name == "" ? record.dns_zone : "${record.name}.${record.dns_zone}"]
}

output "estimated_monthly_cost_eur" {
  description = <<-EOT
    Coût mensuel PLANCHER de cet environnement, en euros : instance plus volume
    de données, aux tarifs relevés le 2026-07-27. Vaut null si le type
    d'instance ne figure pas dans les tarifs relevés.

    Ne contient pas : IP flexible, Object Storage (état, documents,
    sauvegardes), trafic sortant, registre d'images, renouvellement des noms de
    domaine. Le premier relevé de facture devra être comparé à cette valeur.

    Restitué en chaîne à deux décimales : la somme en virgule flottante produit
    sinon une traîne de décimales qui rend la lecture du plan pénible.
  EOT
  value       = local.estimated_monthly_cost_eur == null ? null : format("%.2f", local.estimated_monthly_cost_eur)
}

output "tags" {
  description = "Étiquettes appliquées aux ressources de calcul. Filtre de revue de facture et de chasse aux ressources orphelines."
  value       = module.server.tags
}

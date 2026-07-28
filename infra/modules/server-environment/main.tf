# ---------------------------------------------------------------------------
# Module « server-environment »
#
# Un environnement complet servi par une instance Scaleway : adresse IP
# flexible, groupe de sécurité en refus par défaut, volume système, volume de
# données séparé, enregistrement DNS dans une zone existante.
#
# Ce module sert la production et la préproduction. Les prévisualisations
# n'utilisent PAS ce module : elles reposent sur des Serverless Containers, qui
# se réduisent à zéro et ne coûtent rien au repos.
#
# Choix structurant assumé : PostGIS est AUTO-HÉBERGÉ dans un conteneur sur
# cette instance, l'offre managée n'est pas utilisée. Les conséquences directes
# sont traitées ici :
#   — le volume de données est une ressource DISTINCTE du volume système, pour
#     que la base survive au remplacement de l'instance ;
#   — la base n'est jamais exposée sur l'Internet public : aucune règle
#     entrante n'ouvre 5432, et le service doit écouter sur l'interface privée
#     ou sur la boucle locale ;
#   — la sauvegarde nous incombe entièrement. Elle n'est PAS traitée ici : le
#     seau chiffré et sa rétention sont fournis par le module object-storage,
#     le script de sauvegarde relève de US-111. Voir README.md du module.
# ---------------------------------------------------------------------------

terraform {
  required_version = "~> 1.14"

  required_providers {
    # Même version exacte qu'à la racine (infra/versions.tf). Un module privé
    # de mono-dépôt n'a aucune raison de dériver du socle : si la version monte,
    # elle monte partout, en une seule fois, dans une seule relecture.
    scaleway = {
      source  = "scaleway/scaleway"
      version = "2.79.0"
    }
  }
}

locals {
  # Préfixe unique de nommage. Il rend une ressource orpheline immédiatement
  # identifiable dans la console : « appui-feux-production-... ».
  name_prefix = "${var.application_name}-${var.environment}"

  # Étiquetage. Toute ressource porte au minimum de quoi la rattacher au projet
  # et à son environnement, afin que le coût soit imputable et qu'une ressource
  # oubliée saute aux yeux lors d'une revue de facture.
  common_tags = concat(
    [
      "projet=${var.application_name}",
      "environnement=${var.environment}",
      "gestion=terraform",
      "module=server-environment",
    ],
    var.additional_tags,
  )

  # Nom pleinement qualifié servi par cette instance. Une chaîne vide dans
  # dns_record_name désigne l'apex de la zone (appuifeux.fr).
  fqdn = var.dns_record_name == "" ? var.dns_zone : "${var.dns_record_name}.${var.dns_zone}"

  # Durcissement minimal appliqué au premier démarrage.
  #
  # docs/security.md impose un accès administrateur par clé. On désactive donc
  # explicitement l'authentification SSH par mot de passe et la connexion root,
  # et on verrouille le mot de passe du compte d'administration : même si un
  # mot de passe était positionné plus tard, il ne permettrait pas d'ouvrir une
  # session.
  #
  # Ce cloud-init reste volontairement minimal. L'installation du moteur de
  # conteneurs, le formatage et le montage du volume de données, le déploiement
  # de PostGIS et du reverse proxy TLS relèvent de la couche de provisionnement,
  # pas de Terraform. Un environnement peut fournir son propre contenu via la
  # variable cloud_init.
  generated_cloud_init = join("\n", [
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

  cloud_init = coalesce(var.cloud_init, local.generated_cloud_init)
}

# ---------------------------------------------------------------------------
# Adresse IP flexible
#
# Réservée séparément de l'instance : elle survit à un remplacement de machine,
# ce qui évite d'attendre la propagation DNS pendant un incident. Type
# « routed_ipv4 », le seul modèle d'adressage encore proposé pour les nouvelles
# instances.
# ---------------------------------------------------------------------------
resource "scaleway_instance_ip" "main" {
  type       = "routed_ipv4"
  zone       = var.zone
  project_id = var.project_id
}

# ---------------------------------------------------------------------------
# Groupe de sécurité — refus par défaut en entrée
#
# Principe repris de docs/security.md : « refus par défaut ». Tout ce qui n'est
# pas explicitement autorisé ci-dessous est jeté. Chaque ouverture est motivée.
#
# Attention, limite du modèle Scaleway : un groupe de sécurité ne filtre que le
# trafic de l'interface PUBLIQUE. Le trafic échangé sur un réseau privé n'est
# pas filtré ici. La protection de la base repose donc sur deux barrières
# indépendantes :
#   1. aucune règle entrante n'ouvre le port PostgreSQL sur l'interface
#      publique ;
#   2. le service PostGIS doit être configuré pour n'écouter que sur la boucle
#      locale ou sur l'adresse privée de l'instance (listen_addresses), et son
#      pg_hba.conf doit refuser tout réseau non privé.
# La seconde barrière relève du provisionnement, elle est rappelée dans le
# README du module.
# ---------------------------------------------------------------------------
resource "scaleway_instance_security_group" "main" {
  name        = "${local.name_prefix}-sg"
  description = "Appui Feux ${var.environment} : entrant en refus par defaut"
  zone        = var.zone
  project_id  = var.project_id
  tags        = local.common_tags

  # Groupe à état : les réponses à une connexion sortante légitime reviennent
  # sans qu'il faille ouvrir un port en entrée.
  stateful = true

  # Refus par défaut en entrée. C'est la règle qui protège la base.
  inbound_default_policy = "drop"

  # Sortie ouverte par défaut. L'instance doit pouvoir joindre : les dépôts de
  # paquets pour ses correctifs de sécurité, l'autorité de certification ACME
  # pour renouveler TLS, Object Storage pour déposer ses sauvegardes, les
  # fournisseurs de courriel, de SMS et d'observabilité. Un filtrage sortant
  # nominatif serait plus strict mais casserait au premier changement d'adresse
  # d'un fournisseur, en pleine opération. Le paramètre reste ajustable.
  outbound_default_policy = var.outbound_default_policy

  # Blocage SMTP sortant (25, 465, 587) par la protection intégrée de Scaleway.
  # La plateforme envoie ses courriels par l'API HTTP d'un fournisseur, jamais
  # en SMTP direct : ce blocage ne gêne rien et limite fortement l'intérêt de
  # l'instance pour un attaquant qui voudrait en faire un relais de pourriel.
  enable_default_security = var.block_outbound_smtp

  # Règles supplémentaires en PREMIER. L'ordre compte : une règle de rejet
  # ciblée (adresse abusive, balayage) doit être évaluée avant les
  # autorisations générales qui suivent.
  dynamic "inbound_rule" {
    for_each = var.additional_inbound_rules

    content {
      action     = inbound_rule.value.action
      protocol   = inbound_rule.value.protocol
      port       = inbound_rule.value.port
      port_range = inbound_rule.value.port_range
      ip_range   = inbound_rule.value.ip_range
    }
  }

  # SSH, uniquement depuis des plages nominatives.
  #
  # La valeur par défaut de admin_ssh_cidrs est une liste VIDE : sans décision
  # explicite, l'administration à distance n'est pas ouverte du tout. Ouvrir 22
  # au monde entier sur une machine qui héberge la base serait le raccourci le
  # plus coûteux du projet.
  dynamic "inbound_rule" {
    for_each = var.admin_ssh_cidrs

    content {
      action   = "accept"
      protocol = "TCP"
      port     = var.ssh_port
      ip_range = inbound_rule.value
    }
  }

  # HTTP. Ouvert non pas pour servir l'application — docs/security.md impose
  # TLS — mais pour deux usages précis : la validation ACME HTTP-01 qui délivre
  # et renouvelle le certificat, et la redirection permanente vers HTTPS.
  dynamic "inbound_rule" {
    for_each = var.enable_http_ingress ? [1] : []

    content {
      action   = "accept"
      protocol = "TCP"
      port     = 80
      ip_range = "0.0.0.0/0"
    }
  }

  # HTTPS. Seul point d'entrée applicatif réel.
  dynamic "inbound_rule" {
    for_each = var.enable_https_ingress ? [1] : []

    content {
      action   = "accept"
      protocol = "TCP"
      port     = 443
      ip_range = "0.0.0.0/0"
    }
  }

  # ICMP. Fermé par défaut. Utile en diagnostic d'astreinte, mais il facilite
  # aussi la cartographie du parc par un tiers : on l'ouvre à la demande, et de
  # préférence aux seules plages d'administration.
  dynamic "inbound_rule" {
    for_each = var.icmp_ingress_cidrs

    content {
      action   = "accept"
      protocol = "ICMP"
      ip_range = inbound_rule.value
    }
  }
}

# ---------------------------------------------------------------------------
# Volume de données — SÉPARÉ du volume système
#
# C'est la contrepartie directe du choix d'auto-héberger PostGIS. Le volume
# système est jetable : on peut remplacer l'instance, changer d'image, migrer
# de type. Le volume de données porte le cluster PostgreSQL et ne doit jamais
# être recréé par mégarde.
#
# Remarque : « prevent_destroy » n'accepte pas de variable (vérifié :
# « terraform validate » rejette « Variables may not be used here »), on ne peut
# donc pas rendre la protection paramétrable proprement. La garantie repose
# plutôt sur trois éléments :
#   — le volume est une ressource indépendante : remplacer l'instance ne le
#     touche pas ;
#   — le volume système est marqué delete_on_termination, celui-ci ne l'est
#     pas ;
#   — enable_server_protection active la protection Scaleway de l'instance en
#     production, ce qui fait échouer toute suppression accidentelle.
# ---------------------------------------------------------------------------
resource "scaleway_block_volume" "data" {
  name       = "${local.name_prefix}-donnees"
  zone       = var.zone
  project_id = var.project_id
  size_in_gb = var.data_volume_size_in_gb

  # Débit d'entrées-sorties. 5000 IOPS est l'option d'entrée de gamme du
  # stockage bloc ; elle suffit très largement à la charge d'un MVP de
  # coordination logistique, dont les écritures sont rares et courtes.
  iops = var.data_volume_iops

  tags = concat(local.common_tags, ["role=donnees-postgis"])

  lifecycle {
    # Après une restauration, le volume est recréé à partir d'un instantané.
    # Sans cette exception, le plan suivant voudrait revenir au volume vierge
    # d'origine et détruirait la base tout juste restaurée.
    ignore_changes = [snapshot_id]
  }
}

# ---------------------------------------------------------------------------
# Instance
# ---------------------------------------------------------------------------
resource "scaleway_instance_server" "main" {
  name       = local.name_prefix
  type       = var.server_type
  image      = var.image
  zone       = var.zone
  project_id = var.project_id
  tags       = local.common_tags

  security_group_id = scaleway_instance_security_group.main.id
  ip_id             = scaleway_instance_ip.main.id

  # Protection Scaleway contre la suppression. À activer en production : elle
  # transforme une erreur de manipulation en simple message d'erreur.
  protected = var.enable_server_protection

  # Volume système. Jetable par construction : il ne contient que le système et
  # les images de conteneurs, qui se reconstruisent. Toute donnée durable vit
  # sur le volume de données.
  root_volume {
    volume_type           = var.root_volume_type
    size_in_gb            = var.root_volume_size_in_gb
    sbs_iops              = var.root_volume_iops
    delete_on_termination = true
  }

  additional_volume_ids = [scaleway_block_volume.data.id]

  user_data = {
    "cloud-init" = local.cloud_init
  }

  # Rattachement optionnel à un réseau privé. Utile pour que les Serverless
  # Containers de prévisualisation joignent la base partagée sans jamais passer
  # par l'Internet public.
  dynamic "private_network" {
    for_each = var.private_network_id == null ? [] : [var.private_network_id]

    content {
      pn_id = private_network.value
    }
  }
}

# ---------------------------------------------------------------------------
# DNS
#
# La zone existe déjà chez Scaleway, elle est active et en renouvellement
# automatique. On n'utilise donc JAMAIS « scaleway_domain_zone » : recréer la
# zone effacerait les enregistrements existants, dont ceux de messagerie et de
# validation de domaine. On se contente d'ajouter un enregistrement A.
# ---------------------------------------------------------------------------
resource "scaleway_domain_record" "main" {
  count = var.create_dns_record ? 1 : 0

  dns_zone = var.dns_zone
  name     = var.dns_record_name
  type     = "A"

  # L'adresse est prise sur l'IP flexible, pas sur l'instance : elle est connue
  # avant même que la machine ait démarré, et elle ne change pas si la machine
  # est remplacée.
  data = scaleway_instance_ip.main.address

  # Durée de vie courte. En astreinte, on veut pouvoir basculer le trafic vers
  # une machine de secours ou une page de maintenance en quelques minutes, pas
  # attendre une heure la fin d'un cache de résolveur.
  ttl = var.dns_ttl
}

# ---------------------------------------------------------------------------
# DNS inverse
#
# Un enregistrement PTR cohérent avec le nom direct est un prérequis courant
# pour la réputation d'une adresse. Il est créé après l'enregistrement A, sans
# quoi Scaleway refuse la demande : le nom inverse doit déjà résoudre vers
# l'adresse.
# ---------------------------------------------------------------------------
resource "scaleway_instance_ip_reverse_dns" "main" {
  count = var.create_dns_record && var.enable_reverse_dns ? 1 : 0

  ip_id   = scaleway_instance_ip.main.id
  reverse = local.fqdn
  zone    = var.zone

  depends_on = [scaleway_domain_record.main]
}

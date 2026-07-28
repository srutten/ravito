# ---------------------------------------------------------------------------
# Module « server-environment » — entrées
#
# Les valeurs par défaut sont choisies pour être les MOINS coûteuses et les
# MOINS ouvertes possibles. Un environnement qui a besoin de plus le demande
# explicitement : une erreur d'inattention doit produire une machine modeste et
# fermée, jamais une machine large et ouverte.
# ---------------------------------------------------------------------------

# --- Identité et localisation ----------------------------------------------

variable "application_name" {
  description = "Nom court de l'application, utilisé comme préfixe de nommage et comme étiquette « projet »."
  type        = string
  default     = "appui-feux"
}

variable "environment" {
  description = <<-EOT
    Environnement servi par cette instance. Seuls production et preproduction
    sont acceptés : les prévisualisations passent par des Serverless Containers
    et n'utilisent pas ce module.
  EOT
  type        = string

  validation {
    condition     = contains(["production", "preproduction"], var.environment)
    error_message = "Ce module ne sert que production et preproduction ; les previews utilisent des Serverless Containers."
  }
}

variable "project_id" {
  description = "Identifiant du projet Scaleway dédié dans lequel créer les ressources."
  type        = string
}

variable "zone" {
  description = <<-EOT
    Zone de disponibilité des ressources zonées. Laisser à null pour hériter de
    la zone configurée sur le fournisseur.
  EOT
  type        = string
  default     = null
}

# --- Instance ---------------------------------------------------------------

variable "server_type" {
  description = <<-EOT
    Type commercial de l'instance.

    Par défaut DEV1-S, le type le plus modeste : un environnement doit demander
    explicitement une machine plus large, et donc en assumer le coût.

    Tarifs relevés le 2026-07-27, hors stockage bloc :
      DEV1-S       6,55 EUR/mois   2 vCPU,  2 Go
      DEV1-M      14,74 EUR/mois   3 vCPU,  4 Go
      DEV1-L      31,27 EUR/mois   4 vCPU,  8 Go
      PLAY2-MICRO 40,21 EUR/mois

    Recommandations :
      — préproduction : DEV1-S suffit pour une base de démonstration et un jeu
        de données anonymisé ;
      — production : DEV1-L. L'instance porte à la fois l'application Next.js,
        PostGIS auto-hébergé et un proxy TLS ; 8 Go laissent de la marge au
        cache de PostgreSQL. PLAY2-MICRO est plus cher pour moins de mémoire,
        il n'est pas retenu.
  EOT
  type        = string
  default     = "DEV1-S"
}

variable "image" {
  description = <<-EOT
    Étiquette d'image de base. « ubuntu_noble » correspond à Ubuntu 24.04 LTS :
    support de longue durée, moteur de conteneurs à jour dans les dépôts.
    Étiquette vérifiée sur l'API publique du marketplace Scaleway.
  EOT
  type        = string
  default     = "ubuntu_noble"
}

variable "root_volume_type" {
  description = <<-EOT
    Type du volume système : « l_ssd » (stockage local, dimension imposée par
    le type d'instance) ou « sbs_volume » (stockage bloc). Laisser à null pour
    retenir la valeur par défaut associée au type d'instance, qui est toujours
    valide.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.root_volume_type == null || contains(["l_ssd", "sbs_volume"], coalesce(var.root_volume_type, "l_ssd"))
    error_message = "Le type de volume système doit valoir l_ssd ou sbs_volume."
  }
}

variable "root_volume_size_in_gb" {
  description = <<-EOT
    Taille du volume système. Laisser à null pour retenir la taille imposée par
    le type d'instance ; c'est obligatoire pour un volume local, dont la taille
    n'est pas libre.
  EOT
  type        = number
  default     = null
}

variable "root_volume_iops" {
  description = <<-EOT
    Débit d'entrées-sorties du volume système, uniquement pertinent lorsque
    root_volume_type vaut « sbs_volume ». Laisser à null sinon.
  EOT
  type        = number
  default     = null
}

variable "enable_server_protection" {
  description = <<-EOT
    Active la protection Scaleway contre la suppression de l'instance. À
    positionner à true en production : l'instance héberge la base, sa
    suppression accidentelle serait un incident majeur.
  EOT
  type        = bool
  default     = false
}

# --- Volume de données ------------------------------------------------------

variable "data_volume_size_in_gb" {
  description = <<-EOT
    Taille du volume de données, distinct du volume système, qui porte le
    cluster PostGIS. 20 Go par défaut, soit environ 1,99 EUR/mois au tarif
    relevé de 0,0993 EUR/Go/mois. Le volume s'agrandit sans interruption ; il
    ne se réduit pas, donc on ne surdimensionne pas par précaution.
  EOT
  type        = number
  default     = 20

  validation {
    condition     = var.data_volume_size_in_gb >= 10
    error_message = "Le volume de données doit faire au moins 10 Go."
  }
}

variable "data_volume_iops" {
  description = "Débit d'entrées-sorties du volume de données. 5000 est l'option d'entrée de gamme et suffit à la charge du MVP."
  type        = number
  default     = 5000
}

# --- Accès administrateur ---------------------------------------------------

variable "admin_user_name" {
  description = "Compte d'administration créé par cloud-init. La connexion root directe est désactivée."
  type        = string
  default     = "appui"
}

variable "ssh_authorized_keys" {
  description = <<-EOT
    Clés publiques SSH autorisées pour le compte d'administration. Ce sont des
    clés PUBLIQUES : elles ne sont pas des secrets et peuvent figurer dans un
    fichier de variables. Aucune clé privée, aucun mot de passe ne doit jamais
    apparaître dans ce dépôt.
  EOT
  type        = list(string)
  default     = []
}

variable "cloud_init" {
  description = <<-EOT
    Contenu cloud-init complet, s'il faut remplacer celui généré par le module.
    Laisser à null pour utiliser le durcissement minimal intégré : pas
    d'authentification par mot de passe, pas de connexion root, compte
    d'administration par clé.
  EOT
  type        = string
  default     = null
}

# --- Réseau -----------------------------------------------------------------

variable "admin_ssh_cidrs" {
  description = <<-EOT
    Plages d'adresses autorisées à ouvrir une session SSH.

    Liste VIDE par défaut, et c'est délibéré : sans décision explicite, aucun
    accès SSH n'est ouvert depuis l'Internet. L'administration passe alors par
    la console Scaleway ou par un rebond dédié. N'inscrire ici que des plages
    nominatives et stables ; ne jamais y mettre 0.0.0.0/0.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = !contains(var.admin_ssh_cidrs, "0.0.0.0/0")
    error_message = "Ouvrir SSH au monde entier est interdit : indiquer des plages nominatives."
  }
}

variable "ssh_port" {
  description = "Port d'écoute du service SSH. Le changer ne protège de rien à lui seul, mais réduit le bruit des balayages automatisés."
  type        = number
  default     = 22
}

variable "enable_http_ingress" {
  description = <<-EOT
    Ouvre le port 80. Nécessaire à la validation ACME HTTP-01 et à la
    redirection permanente vers HTTPS. Aucun contenu applicatif n'y est servi.
  EOT
  type        = bool
  default     = true
}

variable "enable_https_ingress" {
  description = "Ouvre le port 443, seul point d'entrée applicatif réel."
  type        = bool
  default     = true
}

variable "icmp_ingress_cidrs" {
  description = <<-EOT
    Plages autorisées à envoyer de l'ICMP. Vide par défaut : le diagnostic
    réseau est utile en astreinte mais facilite aussi la cartographie du parc.
    Restreindre aux plages d'administration si besoin.
  EOT
  type        = list(string)
  default     = []
}

variable "outbound_default_policy" {
  description = <<-EOT
    Politique sortante par défaut. « accept » permet à l'instance de récupérer
    ses correctifs de sécurité, de renouveler son certificat TLS, de déposer
    ses sauvegardes et de joindre les fournisseurs de courriel, de SMS et
    d'observabilité. Un passage à « drop » impose de déclarer chaque
    destination dans additional_inbound_rules côté sortant, ce que ce module ne
    gère pas encore.
  EOT
  type        = string
  default     = "accept"

  validation {
    condition     = contains(["accept", "drop"], var.outbound_default_policy)
    error_message = "La politique sortante doit valoir accept ou drop."
  }
}

variable "block_outbound_smtp" {
  description = <<-EOT
    Active la protection intégrée de Scaleway qui bloque le SMTP sortant (25,
    465, 587). La plateforme envoie ses courriels par API HTTP : ce blocage ne
    gêne rien et empêche de transformer une instance compromise en relais de
    pourriel. À ne désactiver que si un envoi SMTP direct devient nécessaire.
  EOT
  type        = bool
  default     = true
}

variable "additional_inbound_rules" {
  description = <<-EOT
    Règles entrantes supplémentaires, évaluées AVANT les autorisations
    standard. C'est l'emplacement prévu pour un rejet ciblé (adresse abusive,
    balayage insistant) ou pour une ouverture temporaire justifiée.

    Rappel : n'ouvrir ici ni 5432 ni aucun port de base de données. La base
    n'est jamais joignable depuis l'Internet public.
  EOT
  type = list(object({
    action     = optional(string, "accept")
    protocol   = optional(string, "TCP")
    port       = optional(number)
    port_range = optional(string)
    ip_range   = optional(string)
  }))
  default = []

  validation {
    condition = alltrue([
      for rule in var.additional_inbound_rules :
      !(rule.port == 5432 || try(rule.port_range, null) == "5432-5432")
    ])
    error_message = "Le port PostgreSQL ne doit jamais être ouvert sur l'interface publique."
  }
}

variable "private_network_id" {
  description = <<-EOT
    Identifiant d'un réseau privé auquel rattacher l'instance. Laisser à null
    pour ne pas en attacher. Sert notamment à ce que les Serverless Containers
    de prévisualisation joignent la base partagée sans passer par l'Internet.
  EOT
  type        = string
  default     = null
}

# --- DNS --------------------------------------------------------------------

variable "dns_zone" {
  description = <<-EOT
    Zone DNS DÉJÀ EXISTANTE dans laquelle écrire l'enregistrement. Le module ne
    crée jamais la zone.
  EOT
  type        = string
  default     = "appuifeux.fr"
}

variable "dns_record_name" {
  description = <<-EOT
    Nom de l'enregistrement dans la zone. Chaîne vide pour l'apex.
    Production : "" (appuifeux.fr). Préproduction : "preprod".
  EOT
  type        = string
}

variable "create_dns_record" {
  description = "Crée l'enregistrement A. À désactiver si le nom est déjà géré ailleurs, par exemple derrière un service de périphérie."
  type        = bool
  default     = true
}

variable "dns_ttl" {
  description = <<-EOT
    Durée de vie de l'enregistrement, en secondes. 300 par défaut : en
    astreinte, on veut pouvoir basculer vers une machine de secours ou une page
    de maintenance en quelques minutes.
  EOT
  type        = number
  default     = 300

  validation {
    condition     = var.dns_ttl >= 60 && var.dns_ttl <= 86400
    error_message = "La durée de vie doit être comprise entre 60 et 86400 secondes."
  }
}

variable "enable_reverse_dns" {
  description = "Configure l'enregistrement PTR de l'adresse vers le nom direct. Sans effet si create_dns_record vaut false."
  type        = bool
  default     = true
}

# --- Étiquetage -------------------------------------------------------------

variable "additional_tags" {
  description = "Étiquettes supplémentaires, au format « clé=valeur », ajoutées au socle projet / environnement / gestion."
  type        = list(string)
  default     = []
}

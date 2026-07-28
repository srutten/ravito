# ---------------------------------------------------------------------------
# Environnement de PRODUCTION — variables
#
# Aucune de ces variables ne porte de secret. Les identifiants d'organisation et
# de projet sont des références publiques, pas des jetons d'authentification ;
# les clés SSH déclarées ici sont des clés PUBLIQUES. La clé d'API Scaleway est
# lue dans l'environnement d'exécution, jamais dans un fichier.
#
# Les valeurs par défaut sont celles de la production réelle : elles sont plus
# larges et plus protégées que celles des deux autres environnements, et c'est
# assumé, parce que c'est le seul environnement qui porte des données réelles.
# ---------------------------------------------------------------------------

# --- Compte, projet, localisation ------------------------------------------

variable "application_name" {
  description = "Nom court de l'application. Préfixe de nommage et valeur de l'étiquette « projet »."
  type        = string
  default     = "appui-feux"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$", var.application_name))
    error_message = "Le nom d'application doit être en minuscules, chiffres et tirets, de 3 à 32 caractères."
  }
}

variable "organization_id" {
  description = "Identifiant de l'organisation Scaleway propriétaire."
  type        = string
  default     = "d31d71bd-97b1-4867-8a59-16428422d55c"

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.organization_id))
    error_message = "L'identifiant d'organisation doit être un UUID."
  }
}

variable "project_id" {
  description = <<-EOT
    Identifiant du projet Scaleway DÉDIÉ « appui-feux ». Jamais le projet par
    défaut de l'organisation : il mélangerait les ressources de la plateforme
    avec tout le reste, rendrait la facturation inimputable et empêcherait de
    restreindre une clé d'API au seul périmètre du produit.
  EOT
  type        = string
  default     = "a4c4edc6-56a9-462e-beee-a657f84d6271"

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.project_id))
    error_message = "L'identifiant de projet doit être un UUID."
  }

  validation {
    condition     = var.project_id != "d31d71bd-97b1-4867-8a59-16428422d55c"
    error_message = "Le projet par défaut de l'organisation est interdit : utiliser le projet dédié appui-feux."
  }
}

variable "region" {
  description = "Région Scaleway. Restreinte aux régions européennes : le README du dépôt et docs/privacy-rgpd.md imposent un hébergement européen."
  type        = string
  default     = "fr-par"

  validation {
    condition     = contains(["fr-par", "nl-ams", "pl-waw"], var.region)
    error_message = "La région doit être européenne : fr-par, nl-ams ou pl-waw."
  }
}

variable "zone" {
  description = "Zone de disponibilité des ressources zonées : instance, volumes, adresse IP, groupe de sécurité."
  type        = string
  default     = "fr-par-1"

  validation {
    condition     = can(regex("^(fr-par|nl-ams|pl-waw)-[1-3]$", var.zone))
    error_message = "La zone doit appartenir à une région européenne, par exemple fr-par-1."
  }
}

# --- Dimensionnement --------------------------------------------------------

variable "server_type" {
  description = <<-EOT
    Type commercial de l'instance de production.

    DEV1-L par défaut, soit 31,27 EUR/mois au tarif relevé le 2026-07-27.
    L'instance porte l'application Next.js, PostGIS auto-hébergé et un proxy
    TLS ; 8 Go de mémoire laissent de la marge au cache de PostgreSQL.
    PLAY2-MICRO coûte 40,21 EUR/mois pour moins de mémoire : il n'est pas
    retenu.

    C'est la différence de dimensionnement assumée avec la préproduction, qui
    tourne en DEV1-S.
  EOT
  type        = string
  default     = "DEV1-L"
}

variable "data_volume_size_in_gb" {
  description = <<-EOT
    Taille du volume de données, distinct du volume système, qui porte le
    cluster PostGIS. 40 Go, soit environ 3,97 EUR/mois à 0,0993 EUR/Go/mois.
    Un volume bloc s'agrandit sans interruption mais ne se réduit pas : on ne
    surdimensionne pas par précaution.
  EOT
  type        = number
  default     = 40

  validation {
    condition     = var.data_volume_size_in_gb >= 20
    error_message = "En production, un volume de données inférieur à 20 Go est trop juste pour une base et ses journaux."
  }
}

variable "data_volume_iops" {
  description = "Débit d'entrées-sorties du volume de données. 5000 est l'option d'entrée de gamme et suffit à la charge du MVP."
  type        = number
  default     = 5000
}

# --- Accès administrateur ---------------------------------------------------

variable "admin_user_name" {
  description = "Compte d'administration créé par cloud-init. La connexion root directe est désactivée, l'authentification par mot de passe aussi."
  type        = string
  default     = "appui"
}

variable "ssh_authorized_keys" {
  description = <<-EOT
    Clés PUBLIQUES SSH autorisées pour le compte d'administration. Une clé
    publique n'est pas un secret. Aucune clé privée, aucun mot de passe ne doit
    jamais figurer dans ce dépôt ni dans un fichier de variables.
  EOT
  type        = list(string)
  default     = []
}

variable "admin_ssh_cidrs" {
  description = <<-EOT
    Plages d'adresses autorisées à ouvrir une session SSH sur la production.

    Liste VIDE par défaut, et c'est délibéré : sans décision explicite, aucun
    accès SSH n'est ouvert depuis l'Internet sur la machine qui héberge la base
    et le journal d'audit. N'y inscrire que des plages nominatives et stables.
    Le module refuse 0.0.0.0/0.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = !contains(var.admin_ssh_cidrs, "0.0.0.0/0")
    error_message = "Ouvrir SSH au monde entier sur la production est interdit : indiquer des plages nominatives."
  }
}

variable "ssh_port" {
  description = "Port d'écoute du service SSH. Le changer ne protège de rien à lui seul, mais réduit le bruit des balayages automatisés."
  type        = number
  default     = 22
}

# --- Noms de domaine --------------------------------------------------------

variable "dns_zone" {
  description = <<-EOT
    Zone DNS principale, DÉJÀ EXISTANTE et gérée chez Scaleway. Le code n'y
    écrit que des enregistrements ; il ne crée jamais la zone. La production est
    servie à l'apex de cette zone.
  EOT
  type        = string
  default     = "appuifeux.fr"
}

variable "alternate_dns_zones" {
  description = <<-EOT
    Domaines secondaires, actifs et gérés chez Scaleway, qui pointent vers la
    production pour y être redirigés. Ils protègent la marque et rattrapent une
    faute de frappe ; aucun contenu ne leur est propre.
  EOT
  type        = list(string)
  default     = ["appuifeux.eu", "firesupport.eu"]
}

variable "redirect_record_names" {
  description = <<-EOT
    Noms créés dans chaque domaine secondaire. Chaîne vide pour l'apex.

    Par défaut, l'apex seul : chaque nom supplémentaire est un nom de plus à
    couvrir par le certificat TLS du proxy, donc une cause de plus d'échec de
    renouvellement. Ajouter « www » est un choix conscient, pas un réflexe.
  EOT
  type        = list(string)
  default     = [""]
}

variable "dns_ttl" {
  description = <<-EOT
    Durée de vie des enregistrements, en secondes. 300 par défaut : en
    astreinte, on veut pouvoir basculer vers une machine de secours ou une page
    de maintenance en quelques minutes, pas attendre l'expiration d'un cache de
    résolveur.
  EOT
  type        = number
  default     = 300

  validation {
    condition     = var.dns_ttl >= 60 && var.dns_ttl <= 86400
    error_message = "La durée de vie doit être comprise entre 60 et 86400 secondes."
  }
}

# --- Stockage objet ---------------------------------------------------------

variable "backup_retention_days" {
  description = <<-EOT
    Conservation d'une sauvegarde de production avant suppression automatique.

    35 jours : un cycle mensuel complet plus une marge. Une conservation
    illimitée coûte cher et contrevient à la limitation de conservation de
    docs/privacy-rgpd.md. Cette durée est indicative et doit être confirmée par
    la gouvernance.
  EOT
  type        = number
  default     = 35

  validation {
    condition     = var.backup_retention_days >= 14
    error_message = "En production, une rétention de sauvegarde inférieure à 14 jours ne couvre pas un incident découvert tardivement."
  }
}

variable "documents_noncurrent_version_retention_days" {
  description = <<-EOT
    Conservation d'une version obsolète de document, après écrasement ou
    suppression. 30 jours : assez pour rattraper une erreur, assez court pour
    qu'une demande d'effacement au titre du RGPD soit réellement honorée. Le
    versionnage protège de l'erreur, il ne doit pas devenir un archivage
    clandestin.
  EOT
  type        = number
  default     = 30
}

# --- Étiquetage -------------------------------------------------------------

variable "additional_tags" {
  description = <<-EOT
    Étiquettes supplémentaires des ressources de CALCUL, au format
    « clé=valeur ». Scaleway attend ici une liste de chaînes.
  EOT
  type        = list(string)
  default     = []
}

variable "additional_bucket_tags" {
  description = <<-EOT
    Étiquettes supplémentaires des SEAUX Object Storage.

    Deux variables plutôt qu'une, parce que Scaleway n'a pas le même typage des
    deux côtés : les ressources de calcul attendent une liste de chaînes, les
    seaux attendent un dictionnaire clé/valeur. Les fusionner produirait une
    erreur de type au premier « validate ».
  EOT
  type        = map(string)
  default     = {}
}

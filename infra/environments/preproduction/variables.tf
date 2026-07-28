# ---------------------------------------------------------------------------
# Environnement de PRÉPRODUCTION — variables
#
# Aucune de ces variables ne porte de secret. Les clés SSH déclarées ici sont
# des clés PUBLIQUES ; la clé d'API Scaleway est lue dans l'environnement
# d'exécution, jamais dans un fichier.
#
# Les valeurs par défaut sont volontairement MODESTES. Une erreur d'inattention
# doit produire un environnement petit et fermé, pas une seconde production.
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
    défaut de l'organisation : il rendrait la facturation inimputable et
    empêcherait de restreindre une clé d'API au seul périmètre du produit.
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
  description = "Région Scaleway, restreinte aux régions européennes. La préproduction héberge des données fictives mais reste soumise à la même exigence."
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
    Type commercial de l'instance de préproduction.

    DEV1-S par défaut, le type le plus modeste : 6,55 EUR/mois au tarif relevé
    le 2026-07-27, contre 31,27 pour le DEV1-L de production. Un jeu de données
    anonymisé, quelques comptes de test et les parcours end-to-end n'ont pas
    besoin de davantage.

    Une validation refuse les types plus chers que le DEV1-M : si la
    préproduction a réellement besoin d'une machine de production, c'est une
    décision de code, relue, pas une ligne dans un fichier de variables.
  EOT
  type        = string
  default     = "DEV1-S"

  validation {
    condition     = contains(["DEV1-S", "DEV1-M"], var.server_type)
    error_message = "La préproduction reste modeste : DEV1-S ou DEV1-M. Un besoin supérieur se justifie et se relit dans le code."
  }
}

variable "data_volume_size_in_gb" {
  description = <<-EOT
    Taille du volume de données, distinct du volume système. 20 Go, soit environ
    1,99 EUR/mois à 0,0993 EUR/Go/mois. Deux fois moins qu'en production : les
    données sont fictives et leur volume est maîtrisé par le jeu de seed.
  EOT
  type        = number
  default     = 20

  validation {
    condition     = var.data_volume_size_in_gb >= 10 && var.data_volume_size_in_gb <= 40
    error_message = "Le volume de préproduction doit rester compris entre 10 et 40 Go : au-delà, c'est un coût sans contrepartie."
  }
}

variable "data_volume_iops" {
  description = "Débit d'entrées-sorties du volume de données. 5000 est l'option d'entrée de gamme."
  type        = number
  default     = 5000
}

# --- Accès administrateur ---------------------------------------------------

variable "admin_user_name" {
  description = "Compte d'administration créé par cloud-init. Connexion root directe et authentification par mot de passe désactivées."
  type        = string
  default     = "appui"
}

variable "ssh_authorized_keys" {
  description = <<-EOT
    Clés PUBLIQUES SSH autorisées. Une clé publique n'est pas un secret. Aucune
    clé privée, aucun mot de passe ne doit figurer dans ce dépôt.
  EOT
  type        = list(string)
  default     = []
}

variable "admin_ssh_cidrs" {
  description = <<-EOT
    Plages autorisées à ouvrir une session SSH. Vide par défaut : même en
    préproduction, aucun accès n'est ouvert sans décision explicite. Une machine
    de préproduction accessible au monde entier est un point d'entrée vers le
    même projet Scaleway que la production.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = !contains(var.admin_ssh_cidrs, "0.0.0.0/0")
    error_message = "Ouvrir SSH au monde entier est interdit, y compris en préproduction : indiquer des plages nominatives."
  }
}

variable "ssh_port" {
  description = "Port d'écoute du service SSH."
  type        = number
  default     = 22
}

# --- Noms de domaine --------------------------------------------------------

variable "dns_zone" {
  description = "Zone DNS principale, DÉJÀ EXISTANTE. Le code n'y écrit que des enregistrements ; il ne crée jamais la zone."
  type        = string
  default     = "appuifeux.fr"
}

variable "dns_record_name" {
  description = <<-EOT
    Nom de l'enregistrement dans la zone : « preprod », donc
    preprod.appuifeux.fr. Ne jamais mettre la chaîne vide ici : elle désignerait
    l'apex, c'est-à-dire la production.
  EOT
  type        = string
  default     = "preprod"

  validation {
    condition     = var.dns_record_name != ""
    error_message = "La préproduction ne s'installe pas à l'apex de la zone : ce nom est celui de la production."
  }
}

variable "dns_ttl" {
  description = "Durée de vie des enregistrements, en secondes."
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
    Conservation d'une sauvegarde de préproduction. 7 jours, contre 35 en
    production : c'est le minimum accepté par le module. La sauvegarde de
    préproduction est « souhaitable », pas obligatoire (docs/infrastructure.md) ;
    elle sert surtout à éprouver la restauration ici avant de la jouer là-bas.
  EOT
  type        = number
  default     = 7
}

variable "documents_noncurrent_version_retention_days" {
  description = "Conservation d'une version obsolète de document. 7 jours : rattraper une erreur de manipulation en session de test, sans traîne."
  type        = number
  default     = 7
}

variable "force_destroy" {
  description = <<-EOT
    Autorise la suppression d'un seau encore rempli.

    false par défaut, MÊME ICI. Les données sont fictives, mais un seau vidé par
    erreur coûte le temps de reconstituer le jeu de test. Passer cette variable
    à true est un acte explicite, au moment du démantèlement, et il se lit dans
    le plan.
  EOT
  type        = bool
  default     = false
}

# --- Étiquetage -------------------------------------------------------------

variable "additional_tags" {
  description = "Étiquettes supplémentaires des ressources de CALCUL, au format « clé=valeur ». Scaleway attend ici une liste de chaînes."
  type        = list(string)
  default     = []
}

variable "additional_bucket_tags" {
  description = <<-EOT
    Étiquettes supplémentaires des SEAUX Object Storage. Variable distincte de
    la précédente parce que Scaleway n'a pas le même typage des deux côtés :
    liste de chaînes pour le calcul, dictionnaire clé/valeur pour les seaux.
  EOT
  type        = map(string)
  default     = {}
}

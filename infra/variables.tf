# ---------------------------------------------------------------------------
# Appui Feux — socle Terraform : variables communes
#
# Ces variables constituent le contrat partagé par les trois environnements.
# Elles décrivent QUI (organisation, projet), OÙ (région, zone, domaine) et
# SOUS QUEL NOM les ressources sont créées. Tout ce qui varie réellement d'un
# environnement à l'autre (taille d'instance, rétention, ouverture réseau) est
# déclaré dans environments/<environnement>/variables.tf, pas ici.
#
# Aucune de ces variables ne porte de secret. Les identifiants d'organisation
# et de projet sont des références publiques, pas des jetons d'authentification.
# ---------------------------------------------------------------------------

variable "application_name" {
  description = <<-EOT
    Nom court de l'application. Sert de préfixe à toutes les ressources et de
    valeur d'étiquette « projet ». Volontairement en minuscules et sans accent :
    il finit dans des noms de seaux Object Storage, qui n'acceptent que
    [a-z0-9.-].
  EOT
  type        = string
  default     = "appui-feux"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$", var.application_name))
    error_message = "Le nom d'application doit être en minuscules, chiffres et tirets, de 3 à 32 caractères."
  }
}

variable "environment" {
  description = <<-EOT
    Environnement cible. La liste est fermée : une faute de frappe créerait un
    jeu de ressources parallèle, facturé et invisible dans les tableaux de bord.
  EOT
  type        = string

  validation {
    condition     = contains(["production", "preproduction", "preview"], var.environment)
    error_message = "L'environnement doit valoir production, preproduction ou preview."
  }
}

variable "organization_id" {
  description = <<-EOT
    Identifiant de l'organisation Scaleway propriétaire. Sert de valeur par
    défaut aux ressources qui ne sont pas rattachées à un projet.
  EOT
  type        = string
  default     = "d31d71bd-97b1-4867-8a59-16428422d55c"

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.organization_id))
    error_message = "L'identifiant d'organisation doit être un UUID."
  }
}

variable "project_id" {
  description = <<-EOT
    Identifiant du projet Scaleway DÉDIÉ « appui-feux ». Ne jamais utiliser le
    projet par défaut de l'organisation : il mélangerait les ressources de la
    plateforme avec tout le reste, rendrait la facturation inimputable et
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
  description = <<-EOT
    Région Scaleway. Restreinte aux régions européennes : le README du dépôt et
    docs/privacy-rgpd.md imposent un hébergement européen, et la plateforme
    traite des données d'identité, de localisation et des documents
    professionnels.
  EOT
  type        = string
  default     = "fr-par"

  validation {
    # fr-par (Paris), nl-ams (Amsterdam), pl-waw (Varsovie) sont les trois
    # régions Scaleway situées dans l'Union européenne.
    condition     = contains(["fr-par", "nl-ams", "pl-waw"], var.region)
    error_message = "La région doit être européenne : fr-par, nl-ams ou pl-waw."
  }
}

variable "zone" {
  description = <<-EOT
    Zone de disponibilité pour les ressources zonées (instances, volumes, IP,
    groupes de sécurité). Par défaut fr-par-1, cohérente avec la région fr-par.
  EOT
  type        = string
  default     = "fr-par-1"

  validation {
    condition     = can(regex("^(fr-par|nl-ams|pl-waw)-[1-3]$", var.zone))
    error_message = "La zone doit appartenir à une région européenne, par exemple fr-par-1."
  }
}

variable "dns_zone" {
  description = <<-EOT
    Zone DNS principale, DÉJÀ EXISTANTE et gérée chez Scaleway. Le code ne crée
    jamais la zone : il n'y écrit que des enregistrements. Le domaine et sa zone
    sont actifs, en renouvellement automatique, jusqu'au 2027-07-27.

    Découpage retenu :
      appuifeux.fr                  production
      preprod.appuifeux.fr          préproduction
      pr-<numéro>.dev.appuifeux.fr  prévisualisations
  EOT
  type        = string
  default     = "appuifeux.fr"
}

variable "alternate_dns_zones" {
  description = <<-EOT
    Domaines secondaires, également actifs et gérés chez Scaleway, qui
    redirigent vers la zone principale. Ils ne servent qu'à protéger la marque
    et à rattraper une faute de frappe ; aucun contenu n'y est servi.
  EOT
  type        = list(string)
  default     = ["appuifeux.eu", "firesupport.eu"]
}

variable "additional_tags" {
  description = <<-EOT
    Étiquettes supplémentaires appliquées à toutes les ressources, au-delà du
    socle « projet / environnement / gestion » ajouté automatiquement par les
    modules. Format attendu : « clé=valeur ». Sert par exemple à rattacher une
    campagne, un lot du plan d'implémentation ou un responsable.
  EOT
  type        = list(string)
  default     = []
}

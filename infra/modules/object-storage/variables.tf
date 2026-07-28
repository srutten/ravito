# ---------------------------------------------------------------------------
# Module « object-storage » — entrées
#
# Aucune de ces variables ne porte de secret. Les clés d'accès au stockage ne
# transitent jamais par Terraform : elles sont créées hors Terraform et
# déposées dans le gestionnaire de secrets, conformément à docs/security.md.
# ---------------------------------------------------------------------------

# --- Identité et localisation ----------------------------------------------

variable "application_name" {
  description = <<-EOT
    Nom court de l'application, utilisé comme préfixe des noms de seaux. Doit
    rester en minuscules sans accent : Object Storage n'accepte que [a-z0-9.-]
    dans un nom de seau.
  EOT
  type        = string
  default     = "appui-feux"
}

variable "environment" {
  description = "Environnement auquel appartiennent les seaux : production, preproduction ou preview."
  type        = string

  validation {
    condition     = contains(["production", "preproduction", "preview"], var.environment)
    error_message = "L'environnement doit valoir production, preproduction ou preview."
  }
}

variable "project_id" {
  description = <<-EOT
    Identifiant du projet Scaleway dédié. Il est répété sur CHAQUE ressource
    fille du seau (liste de contrôle d'accès, chiffrement, politique) : l'API S3
    est portée par le projet, et une ressource fille créée sur le projet par
    défaut se solderait par un refus 403.
  EOT
  type        = string
}

variable "region" {
  description = <<-EOT
    Région du stockage. Laisser à null pour hériter du fournisseur. Doit rester
    européenne : le README du dépôt et docs/privacy-rgpd.md l'imposent, et les
    documents stockés sont des pièces professionnelles nominatives.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.region == null || contains(["fr-par", "nl-ams", "pl-waw"], coalesce(var.region, "fr-par"))
    error_message = "La région doit être européenne : fr-par, nl-ams ou pl-waw."
  }
}

# --- Nommage ----------------------------------------------------------------

variable "documents_bucket_name" {
  description = <<-EOT
    Nom explicite du seau de documents. Laisser à null pour le nom calculé
    « <application>-<environnement>-documents ».
  EOT
  type        = string
  default     = null
}

variable "backups_bucket_name" {
  description = <<-EOT
    Nom explicite du seau de sauvegardes. Laisser à null pour le nom calculé
    « <application>-<environnement>-sauvegardes ».
  EOT
  type        = string
  default     = null
}

variable "bucket_name_suffix" {
  description = <<-EOT
    Suffixe ajouté aux noms calculés. Sert à désambiguïser si le nom naturel est
    déjà pris, sans avoir à renommer l'ensemble.
  EOT
  type        = string
  default     = null
}

# --- Cycle de vie et rétention ---------------------------------------------

variable "backup_retention_days" {
  description = <<-EOT
    Nombre de jours de conservation d'une sauvegarde avant suppression
    automatique.

    35 jours par défaut : un mois complet plus une marge, ce qui permet de
    remonter au-delà du cycle mensuel d'exploitation sans conserver un
    historique indéfini. Une conservation illimitée coûte cher et contrevient à
    la limitation de conservation de docs/privacy-rgpd.md.

    Cette durée est indicative et doit être confirmée par la gouvernance, comme
    le rappelle docs/privacy-rgpd.md.
  EOT
  type        = number
  default     = 35

  validation {
    condition     = var.backup_retention_days >= 7
    error_message = "Une rétention de sauvegarde inférieure à 7 jours ne couvre même pas un week-end prolongé suivi d'un incident."
  }
}

variable "backup_glacier_transition_days" {
  description = <<-EOT
    Nombre de jours avant bascule d'une sauvegarde vers la classe froide
    GLACIER. null par défaut, donc désactivé : avec une rétention de 35 jours,
    l'archivage n'apporte presque rien et allonge le délai de restauration
    pendant un incident. À n'activer que si la rétention devient longue.
  EOT
  type        = number
  default     = null

  validation {
    condition     = var.backup_glacier_transition_days == null || coalesce(var.backup_glacier_transition_days, 1) >= 1
    error_message = "Le délai avant archivage doit valoir au moins 1 jour."
  }
}

variable "backups_noncurrent_version_retention_days" {
  description = <<-EOT
    Durée de conservation d'une version obsolète de sauvegarde, après
    écrasement. 7 jours : de quoi détecter et corriger un écrasement malveillant
    ou accidentel, sans doubler durablement le volume facturé.
  EOT
  type        = number
  default     = 7
}

variable "documents_noncurrent_version_retention_days" {
  description = <<-EOT
    Durée de conservation d'une version obsolète de document.

    30 jours : assez pour rattraper une suppression accidentelle, assez court
    pour qu'une demande d'effacement au titre du RGPD soit réellement honorée
    dans un délai raisonnable. Le versionnage protège de l'erreur, il ne doit
    pas devenir un archivage clandestin.
  EOT
  type        = number
  default     = 30

  validation {
    condition     = var.documents_noncurrent_version_retention_days <= 90
    error_message = "Conserver une version obsolète plus de 90 jours contredit la limitation de conservation ; justifier auprès de la gouvernance avant d'augmenter."
  }
}

variable "abort_incomplete_multipart_upload_days" {
  description = <<-EOT
    Délai après lequel un téléversement fragmenté abandonné est nettoyé. Un
    fragment orphelin reste facturé indéfiniment et n'est visible dans aucune
    liste d'objets : c'est une fuite de coût silencieuse.
  EOT
  type        = number
  default     = 7
}

# --- Chiffrement ------------------------------------------------------------

variable "sse_algorithm" {
  description = <<-EOT
    Algorithme de chiffrement au repos appliqué par défaut aux objets.

    « AES256 » : chiffrement géré par le fournisseur, sans clé à administrer.
    C'est la valeur par défaut, retenue parce qu'elle ne crée aucune dépendance
    opérationnelle supplémentaire et aucun risque de perte de clé.

    « aws:kms » : chiffrement par une clé du gestionnaire de clés Scaleway.
    Plus fort en séparation des rôles, mais exige d'administrer la clé, sa
    rotation et sa sauvegarde. Perdre la clé, c'est perdre les sauvegardes.
  EOT
  type        = string
  default     = "AES256"

  validation {
    condition     = contains(["AES256", "aws:kms"], var.sse_algorithm)
    error_message = "L'algorithme doit valoir AES256 ou aws:kms."
  }
}

variable "sse_kms_key_id" {
  description = "Identifiant de la clé du gestionnaire de clés. Obligatoire lorsque sse_algorithm vaut aws:kms, à laisser null sinon."
  type        = string
  default     = null
}

# --- Garde-fous -------------------------------------------------------------

variable "force_destroy" {
  description = <<-EOT
    Autorise la suppression d'un seau encore rempli.

    false par défaut, et cela doit le rester en production : un « terraform
    destroy » distrait ne doit pas emporter les pièces justificatives de toutes
    les organisations ni l'historique complet des sauvegardes.
  EOT
  type        = bool
  default     = false
}

variable "backups_object_lock_enabled" {
  description = <<-EOT
    Crée le seau de sauvegardes avec le verrouillage d'objet activé.

    ATTENTION : ce réglage n'existe qu'À LA CRÉATION. L'activer ensuite impose
    de recréer le seau. C'est la seule protection réelle contre un rançongiciel
    qui disposerait de la clé d'écriture.

    false par défaut parce que la configuration de rétention associée n'est pas
    posée par ce module : rendre des objets irrévocables engage la gouvernance
    et le budget. À arbitrer avant la mise en service réelle.
  EOT
  type        = bool
  default     = false
}

variable "enable_bucket_policy" {
  description = <<-EOT
    Pose une politique de seau restreignant l'accès au projet propriétaire.

    false par défaut. Une politique de seau Scaleway est exclusive : dès qu'elle
    existe, tout principal qui n'y figure pas est refusé, y compris celui qui
    l'a posée. Une politique erronée peut rendre le seau inaccessible et exiger
    l'intervention du support. À n'activer qu'au moment où l'on délègue
    réellement un accès nominatif à une application IAM tierce.
  EOT
  type        = bool
  default     = false
}

# --- Étiquetage -------------------------------------------------------------

variable "additional_tags" {
  description = <<-EOT
    Étiquettes supplémentaires, ajoutées au socle projet / environnement /
    gestion. Object Storage attend un dictionnaire clé/valeur, contrairement aux
    ressources de calcul qui attendent une liste de chaînes.
  EOT
  type        = map(string)
  default     = {}
}

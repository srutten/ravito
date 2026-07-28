# ---------------------------------------------------------------------------
# Environnement de PRÉVISUALISATION — variables
#
# Une seule variable de ce fichier porte une valeur sensible :
# « preview_database_password ». Elle n'a AUCUNE valeur par défaut, n'apparaît
# dans aucun fichier .example, et se fournit exclusivement par la variable
# d'environnement TF_VAR_preview_database_password, alimentée depuis le
# gestionnaire de secrets. Tout le reste est public par nature.
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
    défaut de l'organisation.
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
  description = "Région Scaleway, restreinte aux régions européennes. Les données de prévisualisation sont fictives, l'exigence d'hébergement européen s'applique quand même."
  type        = string
  default     = "fr-par"

  validation {
    condition     = contains(["fr-par", "nl-ams", "pl-waw"], var.region)
    error_message = "La région doit être européenne : fr-par, nl-ams ou pl-waw."
  }
}

variable "zone" {
  description = "Zone de disponibilité de l'hôte de base et de ses volumes."
  type        = string
  default     = "fr-par-1"

  validation {
    condition     = can(regex("^(fr-par|nl-ams|pl-waw)-[1-3]$", var.zone))
    error_message = "La zone doit appartenir à une région européenne, par exemple fr-par-1."
  }
}

# --- Prévisualisations déclarées -------------------------------------------

variable "preview_environments" {
  description = <<-EOT
    Prévisualisations à maintenir, une entrée par pull request ouverte.

    VIDE par défaut : appliquer cet environnement crée le socle partagé — réseau
    privé, hôte de base, espace de noms de conteneurs, seaux — et rien d'autre.

    Ajouter une entrée crée une prévisualisation complète : conteneur,
    enregistrement DNS pr-<numéro>.dev.appuifeux.fr, liaison du nom
    personnalisé. Retirer l'entrée détruit les trois. C'est le mécanisme de
    destruction attendu à la fermeture d'une pull request ; il devrait être
    piloté par la chaîne de déploiement, qui n'existe pas dans cette itération.

    Champs :
      pull_request_number    numéro de la pull request, sert de clé et de nom
      image                  adresse complète de l'image applicative, désignée
                             par l'empreinte du commit
      database_name          nom de la base logique ; calculé si absent
      registry_sha256        empreinte de l'image, force un redéploiement quand
                             l'étiquette est mutable
      min_scale              0 par défaut : mise à l'échelle jusqu'à zéro
      max_scale              plafond propre à cette pull request
      environment_variables  variables NON SECRÈTES supplémentaires
  EOT
  type = list(object({
    pull_request_number   = number
    image                 = string
    database_name         = optional(string)
    registry_sha256       = optional(string)
    min_scale             = optional(number, 0)
    max_scale             = optional(number)
    environment_variables = optional(map(string), {})
  }))
  default = []

  validation {
    condition = length(distinct([
      for preview in var.preview_environments : preview.pull_request_number
    ])) == length(var.preview_environments)
    error_message = "Deux entrées portent le même numéro de pull request : les noms de conteneur et les enregistrements DNS entreraient en collision."
  }

  validation {
    condition = alltrue([
      for preview in var.preview_environments :
      preview.pull_request_number > 0
    ])
    error_message = "Le numéro de pull request doit être un entier positif : il devient un nom DNS public."
  }

  validation {
    condition = alltrue([
      for preview in var.preview_environments :
      coalesce(preview.min_scale, 0) >= 0 && coalesce(preview.min_scale, 0) <= 1
    ])
    error_message = "min_scale doit valoir 0 ou 1 : au-delà, la prévisualisation est facturée en continu et perd sa raison d'être."
  }

  validation {
    condition = alltrue([
      for preview in var.preview_environments :
      preview.database_name == null || can(regex("^[a-z_][a-z0-9_]{0,62}$", coalesce(preview.database_name, "x")))
    ])
    error_message = "Un nom de base PostgreSQL non cité doit être en minuscules, chiffres et tirets bas, et commencer par une lettre ou un tiret bas."
  }
}

# --- Conteneurs -------------------------------------------------------------

variable "container_port" {
  description = "Port d'écoute de l'application dans le conteneur. 3000 est le port par défaut de Next.js."
  type        = number
  default     = 3000
}

variable "container_cpu_limit" {
  description = <<-EOT
    Calcul alloué à chaque instance de conteneur, en milli-vCPU.

    560 va de pair avec 1024 Mo de mémoire : le couple mémoire/vCPU n'est pas
    libre chez Scaleway et un couple incohérent est refusé par l'API. Les
    correspondances publiées sont 128 Mo/70m, 256/140m, 512/280m, 1024/560m,
    2048/1120m, 3072/1680m, 4096/2240m.
  EOT
  type        = number
  default     = 560
}

variable "container_memory_limit_bytes" {
  description = "Mémoire allouée à chaque instance de conteneur, en octets. 1073741824 vaut 1024 Mo, à apparier avec 560 milli-vCPU."
  type        = number
  default     = 1073741824
}

variable "container_max_scale" {
  description = <<-EOT
    Plafond d'instances simultanées par prévisualisation, si l'entrée ne le
    précise pas. Deux suffisent : une prévisualisation sert une relecture, pas
    une charge réelle, et un plafond bas borne la facture en cas de boucle de
    requêtes ou de robot d'indexation.
  EOT
  type        = number
  default     = 2

  validation {
    condition     = var.container_max_scale >= 1 && var.container_max_scale <= 5
    error_message = "Le plafond doit rester compris entre 1 et 5 : une prévisualisation n'a pas à absorber une charge réelle."
  }
}

variable "container_privacy" {
  description = <<-EOT
    Mode d'accès au conteneur.

    « public » par défaut : le lien publié dans la pull request s'ouvre d'un
    clic, ce qui est la condition pour qu'une relecture ait lieu. Le compromis
    est réel et il est assumé : l'URL est devinable, elle expose du code issu
    d'une branche non fusionnée, et le service est atteignable par n'importe
    quel robot. Il est acceptable parce que les données sont strictement
    fictives et que l'environnement est isolé de la production.

    « private » exige un jeton IAM à chaque requête : plus sûr, mais le lien
    seul ne suffit plus et la relecture devient laborieuse.
  EOT
  type        = string
  default     = "public"

  validation {
    condition     = contains(["public", "private"], var.container_privacy)
    error_message = "Le mode d'accès doit valoir public ou private."
  }
}

variable "container_environment_variables" {
  description = <<-EOT
    Variables d'environnement NON SECRÈTES appliquées à toutes les
    prévisualisations. Aucun secret ici : elles sont lisibles par quiconque a
    accès à la console, et elles figurent en clair dans l'état.
  EOT
  type        = map(string)
  default     = {}
}

# --- Base de prévisualisation partagée -------------------------------------

variable "database_server_type" {
  description = <<-EOT
    Type de l'instance qui porte la base de prévisualisation partagée.

    DEV1-S, le type le plus modeste : 6,55 EUR/mois au tarif relevé le
    2026-07-27. Cette machine ne sert que PostGIS et un jeu de données fictif
    réduit.

    Elle est facturée EN CONTINU, y compris quand aucune pull request n'est
    ouverte : c'est le coût incompressible du choix serverless pour
    l'application, puisqu'un conteneur sans état ne peut pas héberger de base.
  EOT
  type        = string
  default     = "DEV1-S"

  validation {
    condition     = contains(["DEV1-S", "DEV1-M"], var.database_server_type)
    error_message = "La base de prévisualisation reste modeste : DEV1-S ou DEV1-M."
  }
}

variable "database_image" {
  description = "Étiquette d'image de base de l'hôte. « ubuntu_noble » correspond à Ubuntu 24.04 LTS, comme les deux autres environnements."
  type        = string
  default     = "ubuntu_noble"
}

variable "database_volume_size_in_gb" {
  description = <<-EOT
    Volume de données de l'hôte de base, séparé du volume système. 10 Go, soit
    environ 0,99 EUR/mois à 0,0993 EUR/Go/mois. Il porte toutes les bases
    logiques des pull requests ouvertes ; les jeux de données sont fictifs et
    volontairement réduits.
  EOT
  type        = number
  default     = 10

  validation {
    condition     = var.database_volume_size_in_gb >= 10 && var.database_volume_size_in_gb <= 40
    error_message = "Le volume de prévisualisation doit rester compris entre 10 et 40 Go."
  }
}

variable "database_volume_iops" {
  description = "Débit d'entrées-sorties du volume de données. 5000 est l'option d'entrée de gamme."
  type        = number
  default     = 5000
}

variable "preview_database_user" {
  description = <<-EOT
    Compte PostgreSQL utilisé par les prévisualisations. Ce n'est pas un secret,
    seulement un identifiant. Il ne doit disposer d'aucun droit sur les bases des
    autres pull requests : le cloisonnement entre prévisualisations dépend de ce
    point, qui relève du provisionnement de la base.
  EOT
  type        = string
  default     = "appui_preview"
}

variable "preview_database_password" {
  description = <<-EOT
    Mot de passe du compte PostgreSQL de prévisualisation.

    AUCUNE VALEUR PAR DÉFAUT, et cette variable n'apparaît dans aucun fichier
    .example. Elle se fournit exclusivement par l'environnement :

        export TF_VAR_preview_database_password="$(...gestionnaire de secrets...)"

    Ne jamais l'écrire dans terraform.tfvars, même localement : le fichier finit
    par être copié, sauvegardé ou joint à un message.

    À savoir : la valeur est stockée dans l'état Terraform, comme toute variable
    consommée par une ressource. C'est l'une des raisons pour lesquelles le seau
    d'état est privé et séparé des autres.

    Si elle n'est pas fournie, aucune URL de base n'est transmise aux
    conteneurs : ils échouent proprement au premier accès plutôt que de se
    connecter à une base inattendue.
  EOT
  type        = string
  sensitive   = true
  default     = null
}

variable "preview_database_host" {
  description = <<-EOT
    Adresse à laquelle les conteneurs joignent la base. Laisser à null pour
    utiliser la première adresse privée IPv4 de l'hôte, ce qui est le cas
    normal. Cette variable n'existe que pour forcer un nom interne stable sans
    modifier le code.

    Ne JAMAIS y mettre une adresse publique : la base n'est pas exposée sur
    l'Internet, et ce n'est pas négociable en prévisualisation non plus.
  EOT
  type        = string
  default     = null
}

variable "preview_database_port" {
  description = "Port d'écoute de PostgreSQL sur l'interface privée. Ce port n'est ouvert sur aucune interface publique."
  type        = number
  default     = 5432
}

variable "private_network_ipv4_subnet" {
  description = <<-EOT
    Sous-réseau IPv4 du réseau privé, au format CIDR. Laisser à null pour
    laisser Scaleway l'attribuer. Le fixer rend les adresses prévisibles, ce qui
    permet d'écrire le pg_hba.conf de la base avant de connaître l'adresse
    réellement attribuée.
  EOT
  type        = string
  default     = null
}

# --- Accès administrateur à l'hôte de base ---------------------------------

variable "admin_user_name" {
  description = "Compte d'administration créé par cloud-init sur l'hôte de base. Connexion root directe et authentification par mot de passe désactivées."
  type        = string
  default     = "appui"
}

variable "ssh_authorized_keys" {
  description = "Clés PUBLIQUES SSH autorisées sur l'hôte de base. Une clé publique n'est pas un secret ; une clé privée ne doit jamais figurer dans ce dépôt."
  type        = list(string)
  default     = []
}

variable "admin_ssh_cidrs" {
  description = <<-EOT
    Plages autorisées à ouvrir une session SSH sur l'hôte de base. Vide par
    défaut : cet hôte ne sert aucun service au public et n'a aucune raison
    d'être joignable depuis l'Internet.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = !contains(var.admin_ssh_cidrs, "0.0.0.0/0")
    error_message = "Ouvrir SSH au monde entier est interdit : indiquer des plages nominatives."
  }
}

variable "ssh_port" {
  description = "Port d'écoute du service SSH de l'hôte de base."
  type        = number
  default     = 22
}

# --- Noms de domaine --------------------------------------------------------

variable "dns_zone" {
  description = "Zone DNS principale, DÉJÀ EXISTANTE. Le code n'y écrit que des enregistrements ; il ne crée jamais la zone."
  type        = string
  default     = "appuifeux.fr"
}

variable "preview_subdomain" {
  description = <<-EOT
    Étage intermédiaire des noms de prévisualisation :
    pr-<numéro>.<preview_subdomain>.<dns_zone>, soit pr-42.dev.appuifeux.fr.

    Aucune zone « dev.appuifeux.fr » n'est créée : « pr-42.dev » est un simple
    nom dans la zone principale. Cet étage isole visuellement les noms jetables
    des noms de service, ce qui rend une prévisualisation oubliée repérable.
  EOT
  type        = string
  default     = "dev"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,30}$", var.preview_subdomain))
    error_message = "L'étage de prévisualisation doit être un libellé DNS valide, en minuscules."
  }
}

variable "dns_ttl" {
  description = <<-EOT
    Durée de vie des enregistrements de prévisualisation, en secondes. 300 :
    une prévisualisation apparaît et disparaît avec sa pull request, un cache
    long laisserait des noms pointant dans le vide.
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
    Rétention du seau de sauvegardes, réglée au minimum accepté par le module.

    Ce seau restera VIDE en prévisualisation : aucune sauvegarde n'est attendue
    d'un environnement jetable dont les données sont fictives. Le module le crée
    systématiquement ; un seau vide ne coûte que ses requêtes.
  EOT
  type        = number
  default     = 7
}

variable "documents_noncurrent_version_retention_days" {
  description = "Conservation d'une version obsolète de document. 7 jours : le temps d'une relecture de pull request, pas davantage."
  type        = number
  default     = 7
}

variable "force_destroy" {
  description = <<-EOT
    Autorise la suppression d'un seau encore rempli.

    true par défaut, à l'inverse des deux autres environnements. C'est le seul
    environnement réellement jetable : ses données sont strictement fictives et
    sa destruction fait partie de son cycle de vie normal. Conséquence à
    connaître : un « terraform destroy » supprimera les seaux MÊME REMPLIS.
  EOT
  type        = bool
  default     = true
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

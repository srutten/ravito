# ---------------------------------------------------------------------------
# Module « object-storage »
#
# Deux seaux PRIVÉS et DISTINCTS pour un environnement :
#
#   documents    pièces justificatives des ressources et des organisations,
#                lues et écrites par l'application via des URL signées ;
#   sauvegardes  dépôt des sauvegardes de la base PostGIS auto-hébergée.
#
# Un troisième seau existe, celui de l'ÉTAT Terraform. Il n'est PAS géré ici :
# il faudrait déjà un état distant pour l'enregistrer. Il est amorcé à la main,
# une seule fois, hors Terraform. Voir infra/backend.tf et infra/README.md.
#
# Pourquoi trois seaux et non un seul avec des préfixes :
#   — l'état contient des valeurs sensibles et ne doit être lisible que par les
#     personnes qui déploient ;
#   — le seau de documents est manipulé en permanence par l'application, avec
#     une clé applicative qui ne doit jamais pouvoir toucher au reste ;
#   — le seau de sauvegardes doit survivre à la compromission de l'un des deux
#     autres, donc porter des accès à part.
# Cette séparation matérialise l'exigence « séparation des accès » de
# docs/operations.md et « stockage séparé » de docs/security.md.
#
# ---------------------------------------------------------------------------
# CE QUI MANQUE — à traiter dans US-111, volontairement hors de ce module
# ---------------------------------------------------------------------------
#
#   — le script de sauvegarde lui-même (pg_dump ou pg_basebackup), sa
#     planification, sa journalisation ;
#   — une application IAM dédiée et sa clé d'API restreinte à l'ÉCRITURE sur le
#     seul seau de sauvegardes. Elle n'est pas créée ici parce qu'une clé
#     produite par Terraform atterrit en clair dans l'état ; elle doit être
#     créée hors Terraform et déposée dans le gestionnaire de secrets ;
#   — le chiffrement CÔTÉ CLIENT des sauvegardes, si la confidentialité doit
#     survivre à une compromission du compte de stockage. Le chiffrement
#     configuré ici est côté serveur : il protège du vol de disque, pas d'un
#     accès légitime détourné ;
#   — le TEST DE RESTAURATION et sa preuve, exigés par
#     backlog/release-checklist.md et docs/operations.md ;
#   — la supervision de l'âge de la dernière sauvegarde réussie ;
#   — le verrouillage d'objet (WORM). Le seau de sauvegardes peut être créé avec
#     object_lock_enabled, mais la configuration de rétention associée
#     (scaleway_object_bucket_lock_configuration) n'est pas posée ici : elle
#     rend les objets irrévocables et doit être décidée avec la gouvernance.
# ---------------------------------------------------------------------------

terraform {
  required_version = "~> 1.14"

  required_providers {
    # Même version exacte qu'à la racine (infra/versions.tf).
    scaleway = {
      source  = "scaleway/scaleway"
      version = "2.79.0"
    }
  }
}

locals {
  name_prefix = "${var.application_name}-${var.environment}"

  # Les noms de seaux doivent être uniques ; le suffixe permet de désambiguïser
  # si le nom naturel est déjà pris.
  name_suffix = var.bucket_name_suffix == null ? "" : "-${var.bucket_name_suffix}"

  documents_bucket_name = coalesce(var.documents_bucket_name, "${local.name_prefix}-documents${local.name_suffix}")
  backups_bucket_name   = coalesce(var.backups_bucket_name, "${local.name_prefix}-sauvegardes${local.name_suffix}")

  # Étiquetage. Contrairement aux ressources de calcul, dont les étiquettes sont
  # une liste de chaînes, Object Storage attend un dictionnaire clé/valeur.
  common_tags = merge(
    {
      projet        = var.application_name
      environnement = var.environment
      gestion       = "terraform"
      module        = "object-storage"
    },
    var.additional_tags,
  )
}

# ---------------------------------------------------------------------------
# Seau des documents
#
# Contient des documents professionnels : attestations, cartes grises,
# habilitations. docs/security.md impose qu'aucun ne soit accessible
# publiquement et que le téléchargement passe par une URL signée à durée de vie
# courte, produite par l'application. Le seau est donc strictement privé.
# ---------------------------------------------------------------------------
resource "scaleway_object_bucket" "documents" {
  name       = local.documents_bucket_name
  region     = var.region
  project_id = var.project_id
  tags       = local.common_tags

  # false : un « terraform destroy » distrait ne doit pas emporter les pièces
  # justificatives de toutes les organisations. La suppression d'un seau non
  # vide est alors refusée, ce qui est le comportement voulu.
  force_destroy = var.force_destroy

  # Versionnage. Protège d'une suppression ou d'un écrasement accidentel, et
  # d'un effacement malveillant par un compte applicatif compromis.
  #
  # Contrepartie RGPD : une version antérieure survit à la suppression demandée
  # par une personne concernée. C'est pourquoi la règle de cycle de vie
  # ci-dessous purge les versions obsolètes dans un délai borné et court. La
  # rétention métier des documents, elle, est pilotée par l'application selon
  # docs/privacy-rgpd.md, pas par une règle de seau aveugle : un seau ne sait
  # pas distinguer un document expiré d'un document encore opposable.
  versioning {
    enabled = true
  }

  lifecycle_rule {
    id      = "hygiene-documents"
    enabled = true

    # Un téléversement fragmenté abandonné reste facturé indéfiniment. On le
    # nettoie systématiquement.
    abort_incomplete_multipart_upload_days = var.abort_incomplete_multipart_upload_days

    noncurrent_version_expiration {
      noncurrent_days = var.documents_noncurrent_version_retention_days
    }
  }
}

resource "scaleway_object_bucket_acl" "documents" {
  bucket     = scaleway_object_bucket.documents.id
  region     = var.region
  project_id = var.project_id

  # « private » : seul le propriétaire du seau a accès. Aucune lecture anonyme,
  # aucune lecture par « tout utilisateur authentifié ».
  acl = "private"
}

resource "scaleway_object_bucket_server_side_encryption_configuration" "documents" {
  bucket     = scaleway_object_bucket.documents.name
  region     = var.region
  project_id = var.project_id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.sse_algorithm
      kms_master_key_id = var.sse_kms_key_id
    }

    # Pertinent uniquement en mode KMS : réduit le nombre d'appels au service
    # de gestion de clés, donc son coût.
    bucket_key_enabled = var.sse_algorithm == "aws:kms"
  }
}

# ---------------------------------------------------------------------------
# Seau des sauvegardes
#
# Le choix d'auto-héberger PostGIS transfère la sauvegarde sur nous. Ce seau en
# est le réceptacle. Il est distinct de celui des documents pour qu'une clé
# applicative compromise ne donne pas accès à l'historique complet de la base.
# ---------------------------------------------------------------------------
resource "scaleway_object_bucket" "backups" {
  name       = local.backups_bucket_name
  region     = var.region
  project_id = var.project_id
  tags       = merge(local.common_tags, { role = "sauvegardes" })

  force_destroy = var.force_destroy

  # Verrouillage d'objet. Désactivé par défaut, mais l'option n'est réglable
  # qu'À LA CRÉATION : l'activer plus tard impose de recréer le seau. C'est la
  # seule protection réelle contre un rançongiciel qui disposerait de la clé
  # d'écriture. À arbitrer avec la gouvernance avant la mise en service.
  object_lock_enabled = var.backups_object_lock_enabled

  # Versionnage non paramétrable et toujours actif : c'est un prérequis du
  # verrouillage d'objet, et cela empêche qu'un écrasement remplace une
  # sauvegarde saine par une sauvegarde corrompue.
  versioning {
    enabled = true
  }

  lifecycle_rule {
    id      = "retention-sauvegardes"
    enabled = true

    abort_incomplete_multipart_upload_days = var.abort_incomplete_multipart_upload_days

    # Rétention. Une sauvegarde conservée indéfiniment coûte cher et devient un
    # risque au regard de la limitation de conservation de docs/privacy-rgpd.md.
    expiration {
      days = var.backup_retention_days
    }

    # Archivage optionnel vers une classe froide. À n'activer que si la
    # rétention est longue : la restauration depuis GLACIER n'est pas immédiate,
    # ce qui allonge d'autant le délai de reprise pendant un incident.
    dynamic "transition" {
      for_each = var.backup_glacier_transition_days == null ? [] : [var.backup_glacier_transition_days]

      content {
        days          = transition.value
        storage_class = "GLACIER"
      }
    }

    noncurrent_version_expiration {
      noncurrent_days = var.backups_noncurrent_version_retention_days
    }
  }
}

resource "scaleway_object_bucket_acl" "backups" {
  bucket     = scaleway_object_bucket.backups.id
  region     = var.region
  project_id = var.project_id

  acl = "private"
}

resource "scaleway_object_bucket_server_side_encryption_configuration" "backups" {
  bucket     = scaleway_object_bucket.backups.name
  region     = var.region
  project_id = var.project_id

  # Chiffrement au repos exigé par docs/operations.md pour les sauvegardes.
  # Attention à ce qu'il protège réellement : le support physique et le vol de
  # disque. Il ne protège PAS d'un accès légitime détourné, pour lequel il faut
  # un chiffrement côté client — voir « ce qui manque » en tête de fichier.
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.sse_algorithm
      kms_master_key_id = var.sse_kms_key_id
    }

    bucket_key_enabled = var.sse_algorithm == "aws:kms"
  }
}

# ---------------------------------------------------------------------------
# Politiques de seau — OPTIONNELLES, désactivées par défaut
#
# AVERTISSEMENT. Une politique de seau Scaleway est exclusive : dès qu'elle
# existe, tout principal qui n'y figure pas est refusé, y compris celui qui l'a
# posée. Une politique erronée peut rendre le seau inaccessible et exiger
# l'intervention du support. Elle n'est donc PAS activée par défaut.
#
# La politique générée ci-dessous est la forme la plus sûre : elle n'accorde
# l'accès qu'au projet propriétaire, qui est déjà le seul à en disposer. Elle
# n'apporte de valeur que le jour où l'on délègue un accès nominatif à une
# application IAM tierce ; elle sert alors de point de départ explicite.
# ---------------------------------------------------------------------------
resource "scaleway_object_bucket_policy" "documents" {
  count = var.enable_bucket_policy ? 1 : 0

  bucket     = scaleway_object_bucket.documents.id
  project_id = var.project_id

  policy = jsonencode({
    Version = "2023-04-17"
    Id      = "${local.documents_bucket_name}-politique"
    Statement = [
      {
        Sid       = "AccesReserveAuProjetProprietaire"
        Effect    = "Allow"
        Principal = { SCW = "project_id:${var.project_id}" }
        Action    = ["s3:*"]
        Resource = [
          scaleway_object_bucket.documents.name,
          "${scaleway_object_bucket.documents.name}/*",
        ]
      },
    ]
  })
}

resource "scaleway_object_bucket_policy" "backups" {
  count = var.enable_bucket_policy ? 1 : 0

  bucket     = scaleway_object_bucket.backups.id
  project_id = var.project_id

  policy = jsonencode({
    Version = "2023-04-17"
    Id      = "${local.backups_bucket_name}-politique"
    Statement = [
      {
        Sid       = "AccesReserveAuProjetProprietaire"
        Effect    = "Allow"
        Principal = { SCW = "project_id:${var.project_id}" }
        Action    = ["s3:*"]
        Resource = [
          scaleway_object_bucket.backups.name,
          "${scaleway_object_bucket.backups.name}/*",
        ]
      },
    ]
  })
}

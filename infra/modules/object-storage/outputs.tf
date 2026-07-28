# ---------------------------------------------------------------------------
# Module « object-storage » — sorties
#
# Aucune sortie ne contient de secret. Un nom de seau et un point d'accès ne
# sont pas des identifiants d'authentification : sans clé d'API valide, ils ne
# donnent accès à rien, les deux seaux étant strictement privés.
#
# Les variables d'environnement STORAGE_ACCESS_KEY et STORAGE_SECRET_KEY
# attendues par l'application (voir docs/deployment.md) ne sont volontairement
# PAS produites ici : une clé créée par Terraform figurerait en clair dans
# l'état. Elle est créée hors Terraform et déposée dans le gestionnaire de
# secrets.
# ---------------------------------------------------------------------------

output "documents_bucket_name" {
  description = "Nom du seau de documents. Correspond à la variable d'environnement STORAGE_BUCKET de l'application."
  value       = scaleway_object_bucket.documents.name
}

output "documents_bucket_id" {
  description = "Identifiant régional du seau de documents, au format {region}/{nom}."
  value       = scaleway_object_bucket.documents.id
}

output "documents_bucket_endpoint" {
  description = "Point d'accès du seau de documents."
  value       = scaleway_object_bucket.documents.endpoint
}

output "backups_bucket_name" {
  description = "Nom du seau de sauvegardes. À reprendre dans le script de sauvegarde de US-111 et dans le runbook de restauration."
  value       = scaleway_object_bucket.backups.name
}

output "backups_bucket_id" {
  description = "Identifiant régional du seau de sauvegardes, au format {region}/{nom}."
  value       = scaleway_object_bucket.backups.id
}

output "backups_bucket_endpoint" {
  description = "Point d'accès du seau de sauvegardes."
  value       = scaleway_object_bucket.backups.endpoint
}

output "region" {
  description = "Région effective des deux seaux. Sert à vérifier que l'hébergement reste européen."
  value       = scaleway_object_bucket.documents.region
}

output "s3_endpoint" {
  description = <<-EOT
    Point d'accès S3 régional, à renseigner dans la variable d'environnement
    STORAGE_ENDPOINT de l'application (voir docs/deployment.md).
  EOT
  value       = "https://s3.${scaleway_object_bucket.documents.region}.scw.cloud"
}

output "backup_retention_days" {
  description = <<-EOT
    Rétention réellement appliquée aux sauvegardes. Exposée pour que le runbook
    et la fiche de conformité citent la valeur en vigueur plutôt qu'une valeur
    recopiée qui finirait par diverger.
  EOT
  value       = var.backup_retention_days
}

output "encryption_algorithm" {
  description = "Algorithme de chiffrement au repos appliqué par défaut aux objets des deux seaux."
  value       = var.sse_algorithm
}

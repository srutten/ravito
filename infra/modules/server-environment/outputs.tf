# ---------------------------------------------------------------------------
# Module « server-environment » — sorties
#
# Aucune sortie ne contient de secret. Les identifiants exposés ici sont des
# références de ressources, pas des jetons d'authentification. Les seuls
# secrets du système (clé d'API de déploiement, clé applicative Object Storage,
# mot de passe PostgreSQL) ne sont ni produits ni manipulés par ce module.
# ---------------------------------------------------------------------------

output "server_id" {
  description = "Identifiant zoné de l'instance, au format {zone}/{uuid}."
  value       = scaleway_instance_server.main.id
}

output "server_name" {
  description = "Nom de l'instance dans la console Scaleway."
  value       = scaleway_instance_server.main.name
}

output "server_type" {
  description = "Type commercial réellement appliqué. Utile pour vérifier qu'un environnement n'a pas dérivé vers une machine plus chère."
  value       = scaleway_instance_server.main.type
}

output "public_ipv4_address" {
  description = "Adresse IPv4 flexible attachée à l'instance. C'est la valeur à inscrire dans un filtrage tiers ou dans une supervision externe."
  value       = scaleway_instance_ip.main.address
}

output "public_ipv4_id" {
  description = "Identifiant zoné de l'adresse IP flexible. Elle survit au remplacement de l'instance."
  value       = scaleway_instance_ip.main.id
}

output "private_ips" {
  description = <<-EOT
    Adresses privées de l'instance, telles que remontées par le fournisseur.
    C'est sur l'une d'elles que PostGIS doit écouter lorsqu'un réseau privé est
    attaché ; jamais sur l'adresse publique.
  EOT
  value       = scaleway_instance_server.main.private_ips
}

output "security_group_id" {
  description = "Identifiant zoné du groupe de sécurité, pour audit ou pour rattacher une ressource complémentaire."
  value       = scaleway_instance_security_group.main.id
}

output "data_volume_id" {
  description = <<-EOT
    Identifiant zoné du volume de données. À reprendre dans la procédure de
    sauvegarde et dans le runbook de restauration : c'est ce volume, et lui
    seul, qui porte la base.
  EOT
  value       = scaleway_block_volume.data.id
}

output "data_volume_size_in_gb" {
  description = "Taille effective du volume de données, utile au suivi de coût et à la supervision du taux de remplissage."
  value       = scaleway_block_volume.data.size_in_gb
}

output "fqdn" {
  description = "Nom pleinement qualifié servi par cet environnement."
  value       = local.fqdn
}

output "dns_record_id" {
  description = "Identifiant de l'enregistrement A, ou null si la gestion du nom a été déléguée ailleurs."
  value       = var.create_dns_record ? scaleway_domain_record.main[0].id : null
}

output "tags" {
  description = "Étiquettes appliquées aux ressources du module. Sert de filtre lors d'une revue de facture ou d'une chasse aux ressources orphelines."
  value       = local.common_tags
}

output "ssh_command" {
  description = <<-EOT
    Commande de connexion administrateur, pour le runbook. Elle n'aboutit que
    si la plage d'appel figure dans admin_ssh_cidrs et si la clé publique
    correspondante a été déclarée.
  EOT
  value       = "ssh -p ${var.ssh_port} ${var.admin_user_name}@${scaleway_instance_ip.main.address}"
}

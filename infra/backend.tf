# ---------------------------------------------------------------------------
# Appui Feux — socle Terraform : état distant
#
# L'état Terraform décrit l'intégralité de l'infrastructure. Il est stocké sur
# Scaleway Object Storage, dont l'API est compatible S3, dans un seau PRIVÉ,
# DISTINCT du seau de documents et du seau de sauvegardes.
#
# Pourquoi trois seaux séparés et non un seul avec des préfixes :
#   — l'état contient des valeurs sensibles en clair (identifiants de
#     ressources, éventuels attributs marqués « sensitive ») ; il ne doit être
#     lisible que par les personnes qui déploient ;
#   — le seau de documents est lu et écrit par l'application en production, avec
#     une clé applicative ; cette clé ne doit jamais pouvoir toucher à l'état ;
#   — le seau de sauvegardes doit pouvoir survivre à une compromission de la
#     chaîne de déploiement, donc porter une politique d'accès distincte.
#
# ---------------------------------------------------------------------------
# AMORÇAGE — à lire avant tout « terraform init »
# ---------------------------------------------------------------------------
#
# Le seau d'état ne peut pas être créé par ce Terraform : il faudrait déjà un
# état distant pour l'enregistrer. C'est le problème classique de l'œuf et de
# la poule. Il est donc créé UNE SEULE FOIS, à la main, hors Terraform, puis
# considéré comme une dépendance externe. La procédure détaillée
# (commandes exactes, nommage, versionnage, restriction d'accès) est décrite
# dans infra/README.md ; elle n'est volontairement pas dupliquée ici pour
# éviter deux vérités divergentes.
#
# Points non négociables pour ce seau, quelle que soit la procédure :
#   — visibilité privée ;
#   — versionnage activé, afin de pouvoir revenir à un état antérieur après une
#     manipulation malheureuse ;
#   — région européenne (fr-par), conformément à l'exigence d'hébergement du
#     README du dépôt et à docs/privacy-rgpd.md ;
#   — clé d'API dédiée au déploiement, jamais la clé applicative.
#
# ---------------------------------------------------------------------------
# CONFIGURATION PARTIELLE
# ---------------------------------------------------------------------------
#
# Le bloc ci-dessous est volontairement INCOMPLET : « key » n'est pas
# renseigné. C'est une « configuration partielle » au sens Terraform. Deux
# conséquences voulues :
#
#   1. la validation hors ligne reste possible sans le moindre identifiant :
#          terraform init -backend=false
#          terraform validate
#      « -backend=false » demande à Terraform de ne pas initialiser l'état
#      distant ; aucun appel réseau vers Object Storage n'est effectué ;
#
#   2. chaque environnement fournit SA PROPRE clé d'objet au moment de
#      l'initialisation réelle. Un seul seau, des clés distinctes : un « apply »
#      de préproduction ne peut pas écraser l'état de production.
#
#          terraform init -backend-config="key=preproduction/terraform.tfstate"
#          terraform init -backend-config="key=production/terraform.tfstate"
#          terraform init -backend-config="key=preview/terraform.tfstate"
#
# Le nom du seau, lui, est fixé ici : ce n'est pas un secret, et le laisser à la
# main de l'opérateur ouvrirait la porte à un état déposé dans un seau
# quelconque, hors sauvegarde et hors surveillance.
#
# Les identifiants d'accès ne figurent PAS dans le dépôt. Ils sont lus dans
# l'environnement (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, alimentés depuis
# la clé d'API Scaleway de déploiement). Aucun secret n'est versionné.
# ---------------------------------------------------------------------------

terraform {
  backend "s3" {
    # Seau d'état, privé, versionné, amorcé à la main. Distinct du seau de
    # documents et du seau de sauvegardes, qui sont créés par le module
    # object-storage.
    bucket = "appui-feux-tfstate"

    # Région européenne. Object Storage Scaleway expose une API compatible S3 ;
    # « region » est ici le nom de région Scaleway, pas une région AWS.
    region = "fr-par"

    # Point d'accès S3 de Scaleway pour la région de Paris.
    endpoints = {
      s3 = "https://s3.fr-par.scw.cloud"
    }

    # Les quatre options suivantes désactivent des vérifications propres à AWS
    # qui n'ont aucun sens face à une implémentation S3 tierce et qui feraient
    # échouer l'initialisation.
    #
    # skip_credentials_validation : pas d'appel STS, Scaleway n'expose pas STS.
    skip_credentials_validation = true
    # skip_region_validation : « fr-par » n'est pas une région AWS connue.
    skip_region_validation = true
    # skip_requesting_account_id : pas de notion de compte AWS.
    skip_requesting_account_id = true
    # skip_metadata_api_check : le poste n'est pas une instance EC2, inutile
    # d'interroger un service de métadonnées inexistant (et d'attendre son
    # expiration de délai à chaque commande).
    skip_metadata_api_check = true
    # skip_s3_checksum : les sommes de contrôle additionnelles envoyées par le
    # client AWS ne sont pas toutes acceptées par les API S3 compatibles.
    skip_s3_checksum = true

    # Adressage par chemin (https://<hote>/<seau>) plutôt que par sous-domaine.
    # C'est la forme recommandée par le guide « backend » du fournisseur
    # Scaleway ; elle évite tout aléa de résolution DNS générique.
    use_path_style = true

    # Chiffrement au repos de l'objet d'état, côté serveur.
    encrypt = true

    # Verrouillage natif S3 : Terraform écrit un fichier de verrou avec un
    # en-tête « If-None-Match », ce qui interdit deux « apply » simultanés.
    # Scaleway Object Storage prend en charge les écritures conditionnelles
    # depuis mai 2026 (guide « backend » du fournisseur scaleway/scaleway,
    # version 2.79.0), le verrouillage fonctionne donc sans base externe.
    # Si l'amorçage remonte une erreur sur ce point, il faut le constater
    # explicitement et le tracer, pas le désactiver en silence : sans verrou,
    # deux déploiements concurrents peuvent corrompre l'état.
    use_lockfile = true

    # key = fourni par -backend-config, propre à chaque environnement
  }
}

# ---------------------------------------------------------------------------
# Appui Feux — socle Terraform : configuration du fournisseur
#
# AUCUN identifiant ne figure ici, ni en clair, ni dans une variable munie
# d'une valeur par défaut. Conformément à docs/security.md (« aucun secret dans
# les exemples », « séparation par environnement »), la clé d'API Scaleway est
# lue exclusivement dans l'environnement d'exécution :
#
#     SCW_ACCESS_KEY      clé d'accès de l'application IAM de déploiement
#     SCW_SECRET_KEY      clé secrète associée
#
# Ces deux variables ne sont jamais écrites dans un fichier du dépôt. Le
# fichier .gitignore exclut déjà *.tfvars, .env et .terraform/.
#
# Le fournisseur accepte aussi le fichier de configuration partagé
# ~/.config/scw/config.yaml. Sur un poste de développement c'est acceptable ;
# dans une chaîne de déploiement, on privilégie les variables d'environnement,
# qui sont éphémères et n'atterrissent pas sur un disque.
# ---------------------------------------------------------------------------

provider "scaleway" {
  # Région et zone européennes : exigence explicite du README du dépôt et de
  # docs/privacy-rgpd.md (« hébergement adapté »). Les valeurs par défaut sont
  # définies dans variables.tf et contraintes à des régions européennes.
  region = var.region
  zone   = var.zone

  # Projet DÉDIÉ « appui-feux », jamais le projet par défaut de l'organisation.
  # Un projet dédié isole les ressources, les clés d'API et la facturation ;
  # une ressource orpheline se repère immédiatement.
  project_id = var.project_id

  # Organisation propriétaire. Utile pour les ressources qui ne sont pas
  # rattachées à un projet (clés SSH IAM, politiques IAM).
  organization_id = var.organization_id
}

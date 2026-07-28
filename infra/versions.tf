# ---------------------------------------------------------------------------
# Appui Feux — socle Terraform : versions
#
# Ce fichier fige les versions pour qu'un plan produit aujourd'hui reste
# reproductible dans six mois. Une plateforme d'appui aux opérations incendie
# ne doit jamais voir son infrastructure changer de comportement parce qu'un
# fournisseur a été publié pendant la nuit.
#
# Toute montée de version est un acte volontaire : elle se fait dans une
# branche dédiée, se relit et se trace dans docs/decision-log.md.
# ---------------------------------------------------------------------------

terraform {
  # Terraform 1.14 est la version réellement installée sur le poste de travail
  # (vérifié : « terraform version » renvoie v1.14.7). La contrainte accepte
  # les correctifs et les versions mineures ultérieures de la branche 1.x mais
  # interdit un passage automatique en 2.x, qui serait une rupture.
  #
  # Remarque : OpenTofu n'est pas installé et n'est pas visé. Le code reste
  # néanmoins compatible avec les deux moteurs, aucune fonctionnalité
  # propriétaire n'est utilisée.
  required_version = "~> 1.14"

  required_providers {
    # Version épinglée de façon stricte, pas de plage ouverte.
    #
    # Version retenue : 2.79.0. Vérifiée le 2026-07-28 sur le registre public
    # https://registry.terraform.io/v1/providers/scaleway/scaleway
    # (champ « version »), puis confirmée localement par « terraform providers »
    # après un « terraform init -backend=false » : le moteur a bien résolu
    # registry.terraform.io/scaleway/scaleway v2.79.0.
    scaleway = {
      source  = "scaleway/scaleway"
      version = "2.79.0"
    }
  }
}

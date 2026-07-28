# Infrastructure Terraform — Appui Feux

> ## AVERTISSEMENT
>
> ## AUCUNE RESSOURCE N'EST APPLIQUÉE À CE JOUR
>
> Le code de ce répertoire est **écrit et validé hors ligne**. Il n'a **jamais** été planifié ni
> appliqué sur le compte Scaleway. Aucun serveur, aucun volume, aucune IP, aucun seau, aucun
> enregistrement DNS n'a été créé par ce dépôt. **Rien n'est facturé.**
>
> `terraform plan`, `terraform apply` et `terraform destroy` ne doivent pas être exécutés dans
> cette itération. La décision d'appliquer appartient au fondateur.

Documentation complète : [`../docs/infrastructure.md`](../docs/infrastructure.md).

## Prérequis

| Élément | Valeur |
|---|---|
| Terraform | 1.14.7, installé sur le poste de référence. Version épinglée dans `versions.tf`. |
| OpenTofu | non installé, non utilisé |
| Fournisseur | Scaleway, version épinglée dans `versions.tf` |
| Région et zone | `fr-par`, `fr-par-1` |
| Projet Scaleway | `appui-feux`, `a4c4edc6-56a9-462e-beee-a657f84d6271` |

Les identifiants ne sont **jamais** écrits dans un fichier du dépôt. Ils sont passés par variables
d'environnement du shell :

```bash
export SCW_ACCESS_KEY=...
export SCW_SECRET_KEY=...
export SCW_DEFAULT_PROJECT_ID=a4c4edc6-56a9-462e-beee-a657f84d6271
export SCW_DEFAULT_REGION=fr-par
export SCW_DEFAULT_ZONE=fr-par-1

# Le backend d'état parle S3 : il lit les variables AWS, avec les mêmes clés Scaleway.
export AWS_ACCESS_KEY_ID="$SCW_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$SCW_SECRET_KEY"
```

## Arborescence

```text
infra/
  README.md                     ce fichier
  versions.tf                   version de Terraform et du fournisseur, épinglées
  backend.tf                    état distant sur Object Storage, compatible S3
  providers.tf                  configuration du fournisseur
  variables.tf                  variables communes
  modules/
    server-environment/         instance, groupe de sécurité, volume, IP, enregistrement DNS
    object-storage/             seaux privés : documents, sauvegardes
  environments/
    preproduction/
    production/
    preview/
```

Chaque environnement est un module racine avec son propre état. Le seau d'état est commun, les clés
sont distinctes : `preproduction/`, `production/`, `preview/`.

## Commandes autorisées aujourd'hui

Elles n'ont besoin d'aucun identifiant, ne joignent pas le compte Scaleway et ne créent rien.

```bash
# Format. Le dépôt doit passer sans modification.
terraform fmt -recursive -check

# Initialisation hors ligne, sans backend distant.
terraform init -backend=false

# Validation syntaxique et cohérence des références.
terraform validate
```

À exécuter dans chaque module racine : `environments/preproduction`, `environments/production`,
`environments/preview`.

## Commandes interdites aujourd'hui

| Commande | Raison |
|---|---|
| `terraform plan` | exige des identifiants et interroge le compte |
| `terraform apply` | crée des ressources facturées |
| `terraform destroy` | détruit des ressources |
| tout appel à l'API Scaleway en création, modification ou suppression | même raison |

## Amorçage de l'état distant

**Terraform ne peut pas créer le stockage de son propre état.** Le seau `appui-feux-tfstate` doit
exister **avant** le premier `terraform init`, sinon l'initialisation échoue avant d'avoir un état
où consigner quoi que ce soit.

Procédure, **non exécutée à ce jour**, à faire une seule fois, à la main, hors Terraform :

1. créer le seau `appui-feux-tfstate` dans le projet `appui-feux`, région `fr-par`, **privé** ;
2. activer la gestion de versions sur ce seau, seul filet contre un état écrasé ;
3. vérifier l'absence de tout accès public en lecture comme en écriture ;
4. exporter les identifiants dans le shell, comme ci-dessus ;
5. initialiser l'environnement visé avec sa clé d'état :

```bash
cd environments/preproduction
terraform init -backend-config="key=preproduction/terraform.tfstate"
```

Le seau d'état n'est géré par aucun module de ce répertoire : il est volontairement hors du cycle de
vie de Terraform.

## Procédure d'application, le jour où elle sera décidée

Ordre imposé : **préproduction**, puis **preview**, puis **production**.

```bash
cd environments/preproduction
terraform init -backend-config="key=preproduction/terraform.tfstate"
terraform plan -out=plan.tfplan
# lecture du plan par un humain, ligne à ligne
terraform apply plan.tfplan
terraform plan            # doit être vide : preuve d'idempotence
```

Le fichier `plan.tfplan` contient la configuration résolue : il n'est ni commité, ni transmis.

## Avertissements

- **Aucun secret dans ce répertoire.** Ni clé, ni mot de passe, ni jeton, y compris dans les
  fichiers `terraform.tfvars.example`. Un secret exposé par erreur est réputé compromis : il se fait
  tourner, on ne se contente pas de réécrire l'historique.
- **`terraform.tfvars` n'est jamais commité.** Seuls les fichiers `.example` le sont.
- **L'état n'est jamais commité.** Il contient des valeurs sensibles en clair.
- **La base de données n'est jamais exposée sur l'Internet public.** Elle écoute sur l'interface
  privée de l'instance. Aucune règle entrante ne doit ouvrir 5432. Ouvrir une règle est un acte
  volontaire, justifié en commentaire dans le code, et relu.
- **L'accès administrateur se fait par clé.** Jamais par mot de passe, jamais en `root` par mot de
  passe.
- **Les zones DNS existent déjà** pour `appuifeux.fr`, `appuifeux.eu` et `firesupport.eu`. Le code
  crée des enregistrements dans ces zones ; il ne doit jamais tenter de recréer une zone.
- **Lire le plan avant d'appliquer.** Une ligne `destroy` sur un volume de données ou sur un seau
  arrête la procédure, sans exception.
- **Un seul point d'application à la fois.** Le verrouillage de l'état repose sur le fichier de
  verrou natif du backend S3 ; son bon fonctionnement sur l'Object Storage Scaleway n'a pas été
  vérifié.
- **Les sauvegardes ne sont pas scriptées** (US-111) et **la restauration n'est pas testée**
  (US-112). Le seau de sauvegarde prévu par ce code est un réceptacle vide tant que ces deux stories
  ne sont pas livrées.
- **Aucune chaîne de déploiement automatisée n'est fournie** : aucun fichier n'est créé sous
  `.github/`, hors périmètre explicite de cette itération.

## Coûts

Le tableau des coûts mensuels par environnement, avec la distinction entre tarifs constatés et
postes non chiffrés, est dans [`../docs/infrastructure.md`](../docs/infrastructure.md).

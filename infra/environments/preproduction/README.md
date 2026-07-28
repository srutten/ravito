# Environnement de préproduction

> ## AUCUNE RESSOURCE N'EST APPLIQUÉE À CE JOUR
>
> Ce code est écrit, formaté et validé hors ligne. Il n'a **jamais** été planifié ni appliqué sur le
> compte Scaleway. **Rien n'est facturé.** La décision d'appliquer appartient au fondateur.

Domaine servi : **`preprod.appuifeux.fr`**.

« Préproduction » ici et « staging » dans `../../../docs/deployment.md` désignent le même
environnement.

## Ce que contient cet environnement

| Ressource | Détail |
|---|---|
| Instance | `DEV1-S`, zone `fr-par-1`, image `ubuntu_noble` |
| Volume de données | 20 Go, **séparé** du volume système, porte le cluster PostGIS |
| IP flexible | `routed_ipv4` |
| Groupe de sécurité | entrant en **refus par défaut** ; 80 et 443 ouverts, SSH fermé par défaut |
| Enregistrement DNS | `A` sur `preprod.appuifeux.fr`, TTL 300, plus le PTR inverse |
| Seau documents | `appui-feux-preproduction-documents`, privé, chiffré, versionné |
| Seau sauvegardes | `appui-feux-preproduction-sauvegardes`, privé, chiffré, rétention 7 jours |

Les seaux sont **distincts** de ceux de production : une clé de préproduction ne doit jamais pouvoir
lire un document réel.

## Pourquoi la même forme que la production

Instance, PostGIS auto-hébergé, volume de données séparé, IP flexible, proxy TLS : la préproduction
reproduit la **forme** de la production. Un environnement de répétition qui ne lui ressemble pas ne
prouve rien. C'est ici que la procédure d'application, la migration de schéma et le rollback sont
éprouvés avant d'être joués en production — c'est l'ordre imposé par `../../README.md`.

## Ce qui diffère, et pourquoi

| Axe | Préproduction | Production | Raison |
|---|---|---|---|
| Instance | `DEV1-S` | `DEV1-L` | données fictives et charge de test ; écart d'environ 27 EUR/mois |
| Volume | 20 Go | 40 Go | le volume est piloté par le jeu de seed, pas par l'usage réel |
| Données | **fictives, anonymisées** | réelles | mesure « données de test anonymisées » de `docs/privacy-rgpd.md` |
| Protection de l'instance | **désactivée** | activée | l'environnement doit rester démontable et reconstructible |
| Rétention des sauvegardes | 7 jours | 35 jours | sauvegarde « souhaitable », pas obligatoire |
| Versions obsolètes de documents | 7 jours | 30 jours | pas de traîne sur un jeu de test |
| Haute disponibilité | **aucune** | aucune | ni l'une ni l'autre n'en a ; ici c'est sans conséquence |
| Domaines secondaires | aucun | `appuifeux.eu`, `firesupport.eu` | la préproduction n'est pas une marque |

Deux garde-fous sont posés dans `variables.tf` pour empêcher la dérive silencieuse :

- `server_type` n'accepte que `DEV1-S` ou `DEV1-M` — une préproduction de la taille de la production
  se justifie dans le code, relu, pas dans un fichier de variables non versionné ;
- `dns_record_name` refuse la chaîne vide — elle désignerait l'apex, c'est-à-dire la production.

`force_destroy` reste à `false` par défaut **même ici** : les données sont fictives, mais un seau
vidé par erreur coûte le temps de reconstituer le jeu de test.

## Ce que cet environnement coûte

Tarifs relevés sur le compte le 2026-07-27.

| Poste | Calcul | Montant |
|---|---|---|
| Instance `DEV1-S` | | 6,55 EUR/mois |
| Volume de données 20 Go | 20 × 0,0993 | 1,99 EUR/mois |
| **Sous-total constaté** | | **8,54 EUR/mois** |

**C'est un plancher, pas une prévision de facture.** Ne sont pas chiffrés, faute de tarif relevé :
IP flexible, Object Storage, trafic sortant. La sortie `estimated_monthly_cost_eur` recalcule ce
plancher à chaque plan.

## Comment l'appliquer, le jour où la décision sera prise

**La préproduction s'applique en premier**, avant preview et avant production. C'est l'environnement
où l'on découvre ce qui ne marche pas.

Prérequis : le seau d'état `appui-feux-tfstate` doit avoir été amorcé à la main (voir
`../../README.md`). Sans lui, `terraform init` échoue.

```bash
# 1. Identifiants dans le shell, jamais dans un fichier du dépôt.
export SCW_ACCESS_KEY=...
export SCW_SECRET_KEY=...
export AWS_ACCESS_KEY_ID="$SCW_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$SCW_SECRET_KEY"

# 2. Variables non secrètes propres au poste.
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars      # clés publiques SSH, plages d'administration

# 3. Initialisation, avec la clé d'état de CET environnement.
terraform init -backend-config="key=preproduction/terraform.tfstate"

# 4. Plan écrit dans un fichier.
terraform plan -out=plan.tfplan

# 5. Lecture intégrale du plan par un humain.

# 6. Application du plan lu, pas d'un plan recalculé.
terraform apply plan.tfplan

# 7. Preuve d'idempotence : ce plan doit être vide.
#    Tant qu'il ne l'est pas, la production ne s'applique pas.
terraform plan
```

## Démantèlement

C'est le seul environnement à instance qu'on peut légitimement démonter et reconstruire. La
procédure est volontairement en deux temps :

```bash
# 1. Autoriser explicitement la suppression des seaux encore remplis.
#    Cette ligne se lit dans le plan.
echo 'force_destroy = true' >> terraform.tfvars
terraform apply

# 2. Détruire.
terraform destroy
```

Le volume de données part avec. C'est voulu ici, ce ne le serait pas en production.

## Vérification hors ligne, autorisée aujourd'hui

```bash
terraform fmt -recursive -check
terraform init -backend=false
terraform validate
```

## Ce que Terraform ne fait pas ici

Identique à la production, et pour les mêmes raisons : formatage et montage du volume, moteur de
conteneurs, PostGIS lié à l'interface privée avec un `pg_hba.conf` restrictif, proxy TLS et
certificat, dépôt et démarrage des conteneurs, exécution des migrations, sauvegarde (US-111) et test
de restauration (US-112). Aucune de ces étapes n'est scriptée dans cette itération.

Le groupe de sécurité ne filtre que l'interface **publique** : la non-exposition de PostGIS repose
aussi sur sa configuration d'écoute, qui relève du provisionnement.

## Références

- `../../README.md` : amorçage de l'état distant, commandes autorisées et interdites.
- `../../../docs/infrastructure.md` : architecture, coûts, modèle de menaces, limites assumées.
- `../../../docs/deployment.md` : pipeline, migration, rollback, smoke tests.
- `../../../docs/privacy-rgpd.md` : données de test anonymisées.

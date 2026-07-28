# Environnement de production

> ## AUCUNE RESSOURCE N'EST APPLIQUÉE À CE JOUR
>
> Ce code est écrit, formaté et validé hors ligne. Il n'a **jamais** été planifié ni appliqué sur le
> compte Scaleway. Aucun serveur, aucun volume, aucune IP, aucun seau, aucun enregistrement DNS n'a
> été créé. **Rien n'est facturé.** La décision d'appliquer appartient au fondateur.

Domaine servi : **`appuifeux.fr`** (apex). `appuifeux.eu` et `firesupport.eu` pointent ici pour être
redirigés.

## Ce que contient cet environnement

| Ressource | Détail |
|---|---|
| Instance | `DEV1-L`, zone `fr-par-1`, image `ubuntu_noble` |
| Volume de données | 40 Go, **séparé** du volume système, porte le cluster PostGIS |
| IP flexible | `routed_ipv4`, survit au remplacement de l'instance |
| Groupe de sécurité | entrant en **refus par défaut** ; 80 et 443 ouverts, SSH fermé par défaut |
| Enregistrement DNS | `A` à l'apex de `appuifeux.fr`, TTL 300, plus le PTR inverse |
| Redirections | `A` à l'apex de `appuifeux.eu` et `firesupport.eu`, vers la même adresse |
| Seau documents | `appui-feux-production-documents`, privé, chiffré, versionné |
| Seau sauvegardes | `appui-feux-production-sauvegardes`, privé, chiffré, rétention 35 jours |

L'application Next.js, PostGIS et le proxy TLS tournent en conteneurs **sur cette instance**.
Terraform fournit la machine, le disque et le réseau ; il ne provisionne rien à l'intérieur.

## Ce qui distingue la production des deux autres environnements

| Axe | Production | Préproduction | Preview |
|---|---|---|---|
| Dimensionnement | `DEV1-L`, 40 Go | `DEV1-S`, 20 Go | `DEV1-S`, 10 Go pour la base partagée |
| Données | **réelles** | fictives | fictives |
| Protection de l'instance | activée, **valeur littérale dans le code** | désactivée | désactivée |
| Destruction des seaux | refusée si non vides | refusée si non vides | autorisée, environnement jetable |
| Rétention des sauvegardes | 35 jours | 7 jours | 7 jours, seau inutilisé |
| Haute disponibilité | **aucune**, instance unique en zone unique | aucune | sans objet |

La protection de l'instance est écrite en dur (`enable_server_protection = true`), pas exposée en
variable : la désactiver doit exiger une modification de code relue, pas une ligne dans un fichier de
variables non versionné.

**Il n'y a pas de haute disponibilité.** Une seule instance, une seule zone, pas de réplique, pas de
bascule. C'est une décision assumée pour un MVP ; ses conséquences sont détaillées dans
`../../../docs/infrastructure.md`, section « Le point de défaillance unique de la base auto-hébergée ».

## Ce que cet environnement coûte

Tarifs relevés sur le compte le 2026-07-27.

| Poste | Calcul | Montant |
|---|---|---|
| Instance `DEV1-L` | | 31,27 EUR/mois |
| Volume de données 40 Go | 40 × 0,0993 | 3,97 EUR/mois |
| **Sous-total constaté** | | **35,24 EUR/mois** |

**C'est un plancher, pas une prévision de facture.** Ne sont pas chiffrés, faute de tarif relevé :
IP flexible, Object Storage (documents, sauvegardes, état), trafic sortant, registre d'images,
renouvellement des noms de domaine (déjà engagé jusqu'au 27 juillet 2027). Le volume système est
supposé inclus dans le tarif de l'instance : ce point n'a pas été vérifié sur une facture réelle.

La sortie `estimated_monthly_cost_eur` recalcule ce plancher à chaque plan : une dérive de
dimensionnement devient visible à la relecture du plan, pas à la facture.

## Comment l'appliquer, le jour où la décision sera prise

Ordre imposé : **préproduction d'abord**, puis preview, puis production. La production ne s'applique
qu'après un second `plan` vide sur la préproduction, qui prouve l'idempotence.

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
terraform init -backend-config="key=production/terraform.tfstate"

# 4. Plan écrit dans un fichier, pour appliquer exactement ce qui a été lu.
terraform plan -out=plan.tfplan

# 5. Lecture intégrale du plan par un humain.
#    Toute ligne « destroy » sur le volume de données ou sur un seau
#    ARRÊTE la procédure. Sans exception.

# 6. Application du plan lu, pas d'un plan recalculé.
terraform apply plan.tfplan

# 7. Preuve d'idempotence : ce plan doit être vide.
terraform plan
```

`plan.tfplan` contient la configuration résolue : il n'est ni commité, ni transmis par un canal non
maîtrisé.

## Vérification hors ligne, autorisée aujourd'hui

Aucune de ces commandes ne joint le compte Scaleway ni ne crée quoi que ce soit.

```bash
terraform fmt -recursive -check
terraform init -backend=false
terraform validate
```

## Ce que Terraform ne fait pas ici

Une instance créée par ce code ne sert rien tant que les étapes suivantes n'ont pas été faites, et
aucune n'est scriptée dans cette itération :

- formater et monter le volume de données, et garantir qu'il ne sera jamais reformaté au démarrage ;
- installer le moteur de conteneurs, PostGIS et le proxy TLS ;
- lier PostgreSQL à la boucle locale ou à l'adresse privée, avec un `pg_hba.conf` qui refuse tout
  réseau non privé — le groupe de sécurité ne filtre que l'interface **publique**, c'est la seconde
  barrière obligatoire ;
- obtenir et renouveler le certificat TLS, y compris pour les domaines secondaires ;
- faire servir par le proxy la **redirection permanente** de `appuifeux.eu` et `firesupport.eu` vers
  `appuifeux.fr` : le DNS ne sait que pointer ;
- déposer et démarrer les conteneurs, exécuter les migrations ;
- installer la sauvegarde (US-111) et la tester (US-112).

`prevent_destroy` n'est pas posé sur le volume de données ni sur les seaux : Terraform refuse une
variable à cet endroit, et la ressource appartient au module, pas à cette composition. La protection
repose donc sur `enable_server_protection = true`, sur `force_destroy = false` pour les seaux, et sur
la lecture du plan.

## Références

- `../../README.md` : amorçage de l'état distant, commandes autorisées et interdites.
- `../../../docs/infrastructure.md` : architecture, coûts, modèle de menaces, limites assumées.
- `../../../docs/deployment.md` : pipeline, migration de production, rollback, smoke tests.
- `../../../docs/operations.md` : sauvegarde, continuité, runbooks.

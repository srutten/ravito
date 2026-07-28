# Déploiement

## Environnements

### Local

- base locale ou projet de développement ;
- courriels interceptés ;
- SMS simulés ;
- stockage fictif ;
- données seed.

### Staging

- configuration proche de la production ;
- données fictives ;
- comptes de test ;
- tests e2e ;
- revue métier.

### Production

- région européenne ;
- sauvegardes ;
- observabilité ;
- MFA ;
- secrets dédiés ;
- accès restreints.

## Pipeline

```text
checkout
→ install
→ lint
→ typecheck
→ unit tests
→ integration tests
→ build
→ migration validation
→ security scans
→ preview
→ e2e
→ approval
→ production migration
→ deploy
→ smoke tests
```

## Variables d'environnement

Documenter sans valeur :

```text
DATABASE_URL
AUTH_SECRET
STORAGE_ENDPOINT
STORAGE_BUCKET
STORAGE_ACCESS_KEY
STORAGE_SECRET_KEY
EMAIL_PROVIDER_KEY
SMS_PROVIDER_KEY
MAP_STYLE_URL
OBSERVABILITY_DSN
FEATURE_FLAGS_SOURCE
```

## Migration production

1. sauvegarde ;
2. vérification ;
3. migration compatible ;
4. déploiement ;
5. smoke test ;
6. surveillance ;
7. rollback si nécessaire.

## Rollback

Prévoir :

- version précédente de l'application ;
- migrations non destructives ;
- flags ;
- lecture seule ;
- procédure documentée ;
- responsable identifié.

## Smoke tests

- connexion ;
- lecture du dashboard ;
- création d'une ressource de test ;
- création d'une demande de test ;
- suppression des données de test ;
- vérification de l'audit ;
- vérification de la file.

## Livraison

Chaque version possède :

- numéro ;
- changelog ;
- migrations ;
- flags ;
- risques ;
- procédure de retour ;
- validation métier.

## Infrastructure d'hébergement

Le détail complet — architecture, amorçage de l'état distant, procédure d'application, modèle de
menaces, limites assumées — est dans `docs/infrastructure.md`. Cette section n'en donne que ce qui
est nécessaire au déploiement.

### Statut

**Aucune ressource n'est appliquée à ce jour.** Le code Terraform de `infra/` est écrit, formaté et
validé hors ligne ; il n'a jamais été planifié ni appliqué. Le pipeline décrit plus haut n'est pas
automatisé : aucune chaîne de déploiement n'existe dans cette itération.

En conséquence, le critère de sortie du lot 0 de `backlog/implementation-plan.md` — « une PR de test
est déployée en preview » — **n'est pas atteint**.

### Correspondance avec les environnements de ce document

| Environnement de ce document | Réalisation | Domaine |
|---|---|---|
| Local | Docker Compose, PostgreSQL 17 avec PostGIS | `localhost:3000` |
| Staging | instance Scaleway `fr-par-1`, application et PostGIS conteneurisés | `preprod.appuifeux.fr` |
| Production | instance Scaleway `fr-par-1`, application et PostGIS conteneurisés | `appuifeux.fr` |
| Preview | Serverless Containers, mise à l'échelle à zéro, base logique dédiée sur une instance PostGIS partagée | `pr-<numéro>.dev.appuifeux.fr` |

`appuifeux.eu` et `firesupport.eu` redirigent vers `appuifeux.fr`. La région `fr-par` satisfait
l'exigence de région européenne.

Le terme « staging » de ce document et le terme « préproduction » de `docs/infrastructure.md`
désignent le même environnement.

## Coût mensuel par environnement

Tarifs constatés sur le compte, en euros par mois :

| Élément | Tarif |
|---|---|
| Instance DEV1-S | 6,55 |
| Instance DEV1-M | 14,74 |
| Instance DEV1-L | 31,27 |
| Instance PLAY2-MICRO | 40,21 |
| Stockage bloc | 0,0993 par Go |

Coût par environnement, avec le dimensionnement par défaut :

| Environnement | Instance | Volume de données | Sous-total constaté |
|---|---|---|---|
| Préproduction | DEV1-S, 6,55 | 20 Go, 1,99 | 8,54 |
| Production | DEV1-L, 31,27 | 40 Go, 3,97 | 35,24 |
| Preview, base partagée | DEV1-S, 6,55 | 10 Go, 0,99 | 7,54 |
| **Total** | | | **51,32** |

Ce total est un **plancher, pas une prévision de facture**. Les postes suivants n'ont pas de tarif
relevé et ne sont donc pas chiffrés : IP flexibles, Object Storage (état, documents, sauvegardes),
Serverless Containers, Container Registry, trafic sortant, renouvellement des noms de domaine.

Deux points de sincérité :

- la mise à l'échelle à zéro des previews supprime le coût du calcul entre deux utilisations, mais
  l'instance qui porte la base de preview partagée tourne et est facturée en continu, y compris
  lorsqu'aucune pull request n'est ouverte ;
- le volume système est supposé inclus dans le tarif de l'instance ; ce point n'a pas été vérifié
  sur une facture réelle, faute d'application.

Le premier relevé de facture devra être comparé à ce tableau, et le tableau corrigé.

## Rollback — précisions d'infrastructure

La section « Rollback » ci-dessus reste la référence. Trois objets reviennent en arrière
différemment, et les confondre aggrave l'incident :

1. **Application** : redéployer l'image précédente, désignée par empreinte de commit.
   L'infrastructure n'est pas touchée. C'est la voie à tenter en premier. Elle suppose un registre
   d'images, qui n'existe pas encore.
2. **Schéma** : il n'y a pas de retour arrière. Les migrations sont compatibles avec la version
   précédente de l'application, et les migrations destructives sont étalées sur plusieurs
   déploiements. C'est cette compatibilité qui rend le rollback applicatif possible. Si une
   migration non compatible atteint la production, la seule issue est la restauration d'une
   sauvegarde, avec perte des écritures postérieures — restauration ni scriptée ni testée à ce jour.
3. **Infrastructure** : revenir au commit précédent de `infra/`, puis planifier et appliquer. C'est
   la voie la plus dangereuse, car un retour arrière peut planifier la destruction d'un volume de
   données ou d'un seau. Le plan est lu intégralement ; toute ligne `destroy` non attendue arrête la
   procédure.

Mesures d'accompagnement disponibles sans rien détruire : `PLATFORM_READ_ONLY`,
`DISABLE_NEW_MISSIONS`, `DISABLE_NEW_REQUESTS`, et la procédure alternative de `docs/operations.md`.

**Responsable du rollback : non identifié.** Ce document l'exige. Le fondateur est aujourd'hui seul,
sans suppléant ni astreinte. Le point doit être tranché avant le pilote.

## Limites connues de la chaîne de déploiement

À l'issue de cette itération, les éléments suivants n'existent pas et sont portés par les stories
indiquées :

- chaîne de déploiement automatisée, previews par pull request, destruction à la fermeture,
  migration en étape distincte, ordre du pipeline — US-004, US-003 ;
- image conteneur et registre d'images — US-004 ;
- provisionnement de l'instance : proxy TLS, certificat, démarrage des conteneurs — US-004 ;
- scripts de migration `db:migrate`, `db:status`, `db:reset`, `db:seed` — US-002 ;
- sauvegardes scriptées — US-111 ;
- restauration testée avec preuve conservée — US-112 ;
- smoke tests de la section correspondante de ce document — US-114 ;
- supervision et alertes d'infrastructure — US-110 ;
- runbooks d'infrastructure — US-113.

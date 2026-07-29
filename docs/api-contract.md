# Contrat API

## Principes

- API JSON versionnée sous `/api/v1`.
- Authentification obligatoire sauf routes publiques explicites.
- Validation stricte.
- Erreurs normalisées.
- Idempotence pour les mutations critiques.
- Pagination par curseur.
- Horodatages ISO 8601 UTC.
- Pas de données sensibles dans les messages d'erreur.

## Format d'erreur

```json
{
  "error": {
    "code": "RESOURCE_ALREADY_ASSIGNED",
    "message": "La ressource n'est plus disponible.",
    "requestId": "req_123",
    "details": {}
  }
}
```

## Authentification

Cinq routes couvrent US-010. Elles appliquent ADR-015 (code à usage unique, aucun mot de passe),
ADR-016 (aucun rôle déclaré par le client) et ADR-017 (session opaque côté serveur).

| Route | Méthode | Accès | Objet |
|---|---|---|---|
| `/api/v1/auth/codes` | POST | publique | demander un code à usage unique |
| `/api/v1/auth/sessions` | POST | publique | échanger un code contre une session |
| `/api/v1/auth/sessions/current` | GET | session requise | lire la session courante |
| `/api/v1/auth/sessions/current` | DELETE | session requise | se déconnecter |
| `/api/v1/auth/sessions/commands/revoke-all` | POST | session requise | révoquer toutes ses sessions |

### Règles communes

- Aucune de ces routes n'accepte de mot de passe, ni en entrée, ni en option.
- Aucun rôle, aucun identifiant d'organisation n'est accepté en entrée. Le rôle est résolu côté
  serveur à partir du compte.
- La session est portée par un cookie `HttpOnly`. Aucun jeton n'apparaît dans un corps de réponse
  ni n'est lisible par le JavaScript de la page.
- Les réponses ne sont jamais mises en cache.
- Les corps de requête sont en `application/json`. Toute méthode non sûre exige une origine
  reconnue, en complément de `SameSite`.
- Ces routes ne sont pas soumises à `PLATFORM_READ_ONLY`. Le mode lecture seule existe pour
  protéger la plateforme pendant un incident ; interdire la connexion à ce moment-là empêcherait
  les coordinateurs de consulter les missions en cours, ce qui aggraverait l'incident au lieu de
  le contenir.

### Neutralité des réponses

Critère 7 de US-010. Un code inexistant, expiré, déjà consommé ou erroné produit une réponse
strictement identique : même code `AUTHENTICATION_FAILED`, même message, même statut `401`, même
`details` vide. Le serveur exécute le même travail dans les quatre cas, y compris lorsqu'il sait
déjà que la tentative échouera : l'empreinte du code fourni est toujours calculée et les mêmes
accès à la base sont toujours effectués, afin que la durée de réponse ne trahisse rien.

De la même façon, `POST /api/v1/auth/codes` répond `202` avec un corps de même forme, que
l'identifiant corresponde ou non à un compte. Un défi est créé dans les deux cas, avec la même
durée de vie et le même compteur de tentatives. Seul l'envoi diffère, et il est asynchrone, donc
invisible dans la réponse.

La limitation de tentatives est appliquée à l'identifiant normalisé et à l'adresse d'appel, avec
les mêmes seuils pour un identifiant connu et pour un identifiant inconnu. Un compteur qui ne
s'appliquerait qu'aux comptes existants serait lui-même un oracle d'énumération.

Conséquence de test : les quatre cas d'échec sont comparés champ à champ, `requestId` exclu, et la
neutralité de durée se vérifie sur une distribution de mesures, jamais sur une exécution unique.

### Idempotence de ces routes

Le principe général du contrat impose un `clientEventId` sur les mutations critiques.
`POST /api/v1/auth/codes` et `POST /api/v1/auth/sessions` en sont exemptées volontairement. Une clé
d'idempotence suppose de mémoriser la réponse produite et de la rejouer sur présentation de la même
clé ; or la réponse d'une ouverture de session est l'octroi d'une session. Quiconque connaîtrait la
clé obtiendrait un second octroi. La protection contre le rejeu vient d'ailleurs : le code est
consommé une seule fois, par une mise à jour conditionnelle exécutée dans la même transaction que
la création de la session.

### Demander un code à usage unique

```http
POST /api/v1/auth/codes
```

```json
{
  "identifier": "prenom.nom@exemple.fr"
}
```

`identifier` est une adresse de courriel de 254 caractères au maximum, normalisée côté serveur.
Le canal d'envoi est déduit de l'identifiant par le serveur et n'est jamais choisi par le client.
Un numéro de téléphone est refusé par `VALIDATION_ERROR` tant que le canal SMS n'est pas livré :
accepter une saisie dont la plateforme ne fera rien produirait une attente sans fin et sans
explication.

Réponse `202 Accepted` :

```json
{
  "challengeId": "uuid",
  "codeLength": 6,
  "expiresInSeconds": 600,
  "resendAvailableInSeconds": 60
}
```

Les trois valeurs numériques sont des constantes de la plateforme, identiques pour tout appelant.
Elles alimentent le compte à rebours de l'interface sans rien dire du compte visé. `challengeId`
est un identifiant opaque : il ne contient pas l'identifiant saisi et ne permet pas de le déduire.

Erreurs : `VALIDATION_ERROR`, `RATE_LIMITED`.

L'échec d'envoi ne modifie pas la réponse. Il est repris par la file d'envoi et suivi par les
alertes d'exploitation.

### Ouvrir une session

```http
POST /api/v1/auth/sessions
```

```json
{
  "challengeId": "uuid",
  "code": "000000"
}
```

Réponse `201 Created` :

```json
{
  "user": {
    "id": "uuid",
    "displayName": "Camille D.",
    "preferredLanguage": "fr"
  },
  "session": {
    "expiresAt": "2026-07-28T04:30:00Z",
    "absoluteExpiresAt": "2026-08-03T16:30:00Z"
  },
  "nextStep": "READY",
  "redirectPath": "/apres-connexion"
}
```

Le cookie de session est posé par l'en-tête `Set-Cookie` de cette réponse.

`session.expiresAt` est la fin de la fenêtre d'inactivité, `session.absoluteExpiresAt` la fin de vie
maximale, indépendante de l'activité.

`nextStep` vaut `READY` dans US-010. La valeur `MFA_REQUIRED` est réservée à US-011 et n'est jamais
émise par cette version : l'encart de l'écran 2 annonce le second facteur, il ne le fournit pas.

`redirectPath` est calculé par le serveur, jamais choisi par le client (ADR-016). Dans US-010 il
désigne toujours une page d'attente, les tableaux de bord par rôle relevant des lots suivants.
C'est le point d'extension prévu : US-014 y branche la résolution du rôle et de l'appartenance sans
changer le contrat.

La réponse ne porte ni rôle, ni organisation. `OrganizationMember` n'existe pas encore ; exposer un
champ vide laisserait croire qu'il est renseigné.

Erreurs :

- `VALIDATION_ERROR` — corps mal formé. La validation ne porte que sur la forme et ne consulte
  jamais l'état stocké : elle ne peut donc pas distinguer un compte d'un autre.
- `AUTHENTICATION_FAILED` — code inexistant, expiré, déjà consommé, erroné, ou défi dont les
  tentatives sont épuisées. Réponse identique dans tous ces cas.
- `FORBIDDEN` — compte suspendu. Cette distinction n'est faite qu'après vérification réussie du
  code, donc après que l'appelant a prouvé qu'il contrôle le canal : elle n'ouvre aucune
  énumération. Un compte suspendu doit savoir qu'il l'est, sans quoi il ne peut pas demander sa
  réactivation.
- `RATE_LIMITED`.

Effets : consommation du défi et création de la session dans une seule transaction, puis écriture
d'audit `USER_SIGNED_IN`. Les tentatives échouées alimentent les métriques et le journal technique,
sans écriture d'audit nominative : un appelant non authentifié ne doit pas pouvoir faire grossir la
table de preuve à volonté. Le blocage d'un compte après tentatives répétées est audité par
`SIGN_IN_BLOCKED`.

### Lire la session courante

```http
GET /api/v1/auth/sessions/current
```

Réponse `200` :

```json
{
  "user": {
    "id": "uuid",
    "displayName": "Camille D.",
    "preferredLanguage": "fr"
  },
  "session": {
    "issuedAt": "2026-07-27T16:30:00Z",
    "expiresAt": "2026-07-28T04:30:00Z",
    "absoluteExpiresAt": "2026-08-03T16:30:00Z"
  }
}
```

Erreurs : `UNAUTHENTICATED` lorsque le cookie est absent, inconnu, expiré ou révoqué. Ces quatre
cas partagent une réponse unique : la validité d'un identifiant de session n'est pas une
information que la plateforme confirme.

### Se déconnecter

```http
DELETE /api/v1/auth/sessions/current
```

Sans corps. Réponse `204 No Content`, y compris lorsque aucune session valide n'est présentée. Une
déconnexion ne doit jamais échouer : répondre `401` laisserait une session vivante sur un poste
partagé au motif que l'appelant n'a pas su prouver qu'elle lui appartenait, soit l'inverse du
service rendu. Le cookie est effacé dans tous les cas.

Effets : la session présentée est marquée révoquée, les autres sessions du compte ne sont pas
touchées. Audit `USER_SIGNED_OUT` lorsqu'une session existait.

### Révoquer toutes ses sessions

```http
POST /api/v1/auth/sessions/commands/revoke-all
```

```json
{
  "clientEventId": "uuid"
}
```

Réponse `200` :

```json
{
  "revokedCount": 3
}
```

La session courante est comprise dans la révocation : l'appelant est déconnecté par sa propre
commande et le cookie est effacé par la réponse. C'est la mise en œuvre côté utilisateur de la
révocation immédiate exigée au critère 11 ; la révocation par un administrateur relève de US-093 et
l'interrupteur global `FORCE_SESSION_REVOCATION` de `docs/feature-flags.md`.

Un rejeu portant le même `clientEventId` renvoie la réponse initiale sans nouvel effet.

Erreurs : `UNAUTHENTICATED`, `VALIDATION_ERROR`, `RATE_LIMITED`.

Effets : révocation et écriture d'audit `USER_SESSIONS_REVOKED` dans une seule transaction, avec le
nombre de sessions concernées.

## Organisations

Trois routes couvrent US-012 et ouvrent US-014. Elles appliquent ADR-019 (colonne `version` sur
`organizations`), ADR-020 (écriture dans l'outbox à l'intérieur de la transaction) et ADR-021
(adhésion résolue à chaque requête, sans mise en cache).

| Route | Méthode | Accès | Objet |
|---|---|---|---|
| `/api/v1/organizations` | POST | session requise | créer une organisation en attente de validation |
| `/api/v1/organizations/{organizationId}` | GET | membre ou admin plateforme | lire une organisation |
| `/api/v1/organizations/{organizationId}` | PATCH | `ORG_ADMIN` ou admin plateforme | modifier une organisation |

### Règles communes

- Aucune de ces routes n'est publique. `ENABLE_PUBLIC_REGISTRATION` ne les gouverne pas : ce flag
  ouvre la création d'un compte, pas celle d'une organisation. Une organisation se crée depuis un
  compte déjà authentifié, et c'est ce qui donne à chaque structure un responsable identifiable.
- Aucun rôle, aucun statut n'est accepté en entrée. `verificationStatus`, `status`, `version` et le
  rôle du créateur sont posés par le serveur. C'est ADR-016 appliqué au-delà de la connexion : une
  organisation qui se déclarerait « VERIFIED » à la création rendrait la validation décorative,
  alors que l'usurpation d'organisation figure parmi les menaces prioritaires de
  `docs/security.md`.
- L'appartenance et le rôle sont relus à chaque requête, dans la transaction qui décide (ADR-021).
  Une adhésion suspendue ferme l'accès dès la requête suivante, sans attendre l'expiration d'un
  cache.
- `POST` et `PATCH` sont soumises à `PLATFORM_READ_ONLY` et répondent alors `503`. `GET` reste
  disponible. L'exemption consentie aux routes d'authentification ne s'étend pas ici : pendant un
  incident, consulter une organisation peut être nécessaire, en créer ou en renommer une ne l'est
  jamais.
- Les corps sont en `application/json`, toute méthode non sûre exige une origine reconnue, et aucune
  réponse n'est mise en cache. Ces trois règles sont celles déjà appliquées aux routes
  d'authentification.

### Vocabulaire

Trois colonnes qualitatives, trois axes distincts, à ne pas confondre.

| Champ | Valeurs | Ce qu'il décrit |
|---|---|---|
| `type` | `OPERATIONAL_SERVICE`, `LOCAL_AUTHORITY`, `COMPANY`, `ASSOCIATION`, `FARM` | la nature de la structure |
| `verificationStatus` | `PENDING`, `VERIFIED`, `REJECTED` | la décision de confiance d'un admin plateforme |
| `status` | `ACTIVE`, `SUSPENDED`, `CLOSED` | le cycle de vie de la fiche |

Les valeurs sont celles des types énumérés de `0014_organization-enums.sql`, qui font foi. Deux
d'entre elles sont plus larges que l'exemple qui les a inspirées : `OPERATIONAL_SERVICE` couvre un
service d'incendie comme un service technique ou une unité de sécurité civile, et `LOCAL_AUTHORITY`
couvre une commune comme un groupement, un département ou une région. Aucun de ces trois ensembles
n'est ordonné : `verificationStatus` se compare par égalité à `VERIFIED`, jamais par `>=`,
`REJECTED` n'étant pas « plus vérifié » que `VERIFIED`.

`PENDING` n'appartient qu'à `verificationStatus`. Une organisation qui vient d'être créée est
`ACTIVE` et `PENDING` : elle existe, son administrateur peut s'y connecter et la corriger, et elle
ne peut rien publier tant que la validation n'a pas eu lieu (`ORGANIZATION_NOT_VERIFIED`). Porter
l'attente dans les deux colonnes ferait dériver l'une des deux au premier changement d'état, et rien
ne dirait alors laquelle fait foi. Les deux axes sont indépendants jusqu'au bout : une organisation
peut être `VERIFIED` et `SUSPENDED`.

L'objet `membership` renvoyé par ces routes porte deux vocabulaires de plus, eux aussi fermés :

| Champ | Valeurs |
|---|---|
| `membership.role` | `CONTRIBUTOR`, `COORDINATOR`, `ORG_ADMIN`, `PLATFORM_ADMIN`, `OBSERVER` |
| `membership.status` | `INVITED`, `ACTIVE`, `SUSPENDED`, `REVOKED` |

Ce sont les cinq rôles de `docs/permissions.md`, et leur ordre de déclaration n'est pas une
hiérarchie : `OBSERVER` est déclaré en dernier et reste le rôle le moins capable. Une garde
d'autorisation énumère les rôles admis pour une action, elle ne les compare jamais. Une seule valeur
de `membership.status` ouvre un accès, `ACTIVE` : une invitation en attente n'est pas une
appartenance. Une personne détient au plus un rôle par organisation, la clé de l'adhésion étant le
couple organisation et utilisateur ; c'est ce qui rend la question « que peut faire cette personne
ici ? » décidable par une seule lecture.

Champs de saisie :

- `name` — obligatoire, 2 à 160 caractères, sans espace en tête ni en fin. Aucune unicité : deux
  structures distinctes peuvent légitimement porter le même nom, et le refuser empêcherait la
  seconde de se déclarer.
- `type` — obligatoire, une des cinq valeurs ci-dessus, sans valeur par défaut.
- `registrationNumber` — obligatoire, 4 à 64 caractères, lettres, chiffres, espace, point, barre
  oblique et tiret, le premier et le dernier caractère étant alphanumériques. Conservé tel qu'il a
  été saisi ; l'unicité porte sur sa forme normalisée.
- `territoryCode` — facultatif, 1 à 16 caractères, majuscules, chiffres et tirets, le premier étant
  alphanumérique. Il porte le périmètre territorial de `docs/permissions.md`. Absent, il signifie
  « aucun périmètre déclaré », cas d'une organisation nationale.

Le format de `registrationNumber` n'est **pas** celui d'un SIRET, et ce n'est pas un oubli. Une
association n'a pas toujours de numéro à quatorze chiffres, une collectivité étrangère n'est pas
inscrite au même registre, et un service opérationnel ne l'est pas là où l'est une entreprise. Une
contrainte calquée sur un seul registre exclurait des structures légitimes et, effet plus insidieux,
obligerait les jeux de test à porter des numéros réels, ce que `docs/test-plan.md` et
`docs/privacy-rgpd.md` interdisent : le préfixe `FICTIF-` du jeu de démonstration doit rester
acceptable par le schéma. Le champ reste néanmoins **obligatoire**, parce qu'un administrateur
plateforme qui valide une organisation doit pouvoir confronter la déclaration à un registre public ;
sans identifiant, il ne lui resterait que le nom, que n'importe qui peut recopier — soit exactement
l'usurpation d'organisation de `docs/threat-model.md`.

L'unicité porte sur la forme normalisée du numéro, calculée par le serveur : passage en majuscules
et retrait des séparateurs. « 123 456 789 00012 », « 123-456-789 00012 » et « 12345678900012 »
désignent donc la même structure et entrent en conflit. La normalisation n'est jamais faite par
l'appelant : deux chemins d'écriture normaliseraient tôt ou tard différemment, et l'unicité ne
porterait plus sur la même chose selon l'origine de la ligne.

L'unicité est globale et couvre aussi les organisations rejetées ou closes : la restreindre aux
organisations actives permettrait de redéclarer une immatriculation déjà refusée, donc de contourner
la décision d'un administrateur en une seconde déclaration. Un doublon est refusé par
`VALIDATION_ERROR` avec `details.fields: ["registrationNumber"]`. La réponse ne nomme jamais la
structure qui détient déjà le numéro : l'appelant apprend que sa saisie est refusée, pas qui est en
face.

### Créer une organisation

```http
POST /api/v1/organizations
```

```json
{
  "name": "Exploitation agricole Martin",
  "type": "FARM",
  "registrationNumber": "FICTIF-ORG-0003",
  "territoryCode": "ZZ-DEMO-02",
  "clientEventId": "uuid"
}
```

Réponse `201 Created` :

```json
{
  "organization": {
    "id": "uuid",
    "name": "Exploitation agricole Martin",
    "type": "FARM",
    "registrationNumber": "FICTIF-ORG-0003",
    "territoryCode": "ZZ-DEMO-02",
    "verificationStatus": "PENDING",
    "status": "ACTIVE",
    "version": 1,
    "createdAt": "2026-07-28T09:12:00Z",
    "updatedAt": "2026-07-28T09:12:00Z"
  },
  "membership": {
    "role": "ORG_ADMIN",
    "status": "ACTIVE",
    "validFrom": "2026-07-28T09:12:00Z",
    "validUntil": null
  },
  "nextStep": "AWAITING_VERIFICATION"
}
```

`clientEventId` est **obligatoire**. C'est la mutation où l'idempotence ne peut venir de rien
d'autre : une création n'a pas de version à comparer, et rien dans le corps ne désigne l'objet visé
puisqu'il n'existe pas encore. Sans cette clé, un double appui sur le bouton, une reprise après
coupure ou un rejeu de la file locale de `docs/offline-mode.md` produiraient deux organisations
jumelles, dont l'une resterait dans la file de validation sans que personne sache laquelle fait foi.
Deux effets pour une seule commande : exactement ce que `CLAUDE.md` interdit.

Un rejeu portant le même `clientEventId` renvoie la réponse initiale à l'identique, statut `201`
compris. Le client qui a perdu la première réponse n'a pas à distinguer deux cas. Le même
`clientEventId` présenté avec un corps différent est refusé par `IDEMPOTENCY_CONFLICT` : la clé
désigne une intention, la réutiliser pour une autre intention est une erreur de programmation, pas
une reprise. Les deux cas se distinguent par l'empreinte de la requête conservée dans le registre
`idempotency_keys` (`0017_idempotency-keys.sql`), jamais par le corps lui-même, qui n'est pas
stocké.

Le chemin de rejeu ne pose **aucune** garde d'adhésion, et cette absence fait partie du contrat.
Une première version en posait une, au motif que le critère 12 de US-010 vaut partout où des
données d'organisation sont rendues ; elle refusait un rejeu légitime lors d'un double appui
simultané. `valid_from` de l'adhésion reçoit le `now()` de la transaction gagnante, c'est-à-dire
son instant de **début** ; la transaction perdante, démarrée au même moment, évalue
`valid_from <= now()` avec son propre instant de début, souvent antérieur. Elle voyait donc
l'adhésion comme « pas encore commencée » et répondait `NOT_FOUND` sur une organisation qui venait
d'être créée pour l'appelant lui-même. Retirer la garde tient la promesse ci-dessus au sens
strict au lieu de la contredire en silence : un rejeu n'est pas une consultation, c'est l'écho
d'une commande déjà exécutée par cet acteur, et l'acteur entre dans l'empreinte — un tiers reçoit
`IDEMPOTENCY_CONFLICT` avant d'atteindre ce chemin. Le critère 12 reste appliqué là où il porte,
sur la lecture et sur la modification. L'effet, lui, n'a jamais dépendu de cette garde : une seule
organisation, un seul message d'outbox.

Précision sur « à l'identique » : la réponse rejouée est **reconstruite** à partir de
l'organisation et de l'adhésion telles qu'elles sont au moment du rejeu, le registre ne conservant
que des identifiants et une version. Si l'organisation a été modifiée entre la création et le
rejeu, le rejeu rend donc son état courant, et l'écart se constate sur `version`. C'est le
comportement voulu — rendre un état périmé induirait le client en erreur — mais il est écrit ici
plutôt que sous-entendu.

Erreurs : `UNAUTHENTICATED`, `VALIDATION_ERROR`, `IDEMPOTENCY_CONFLICT`, `RATE_LIMITED`,
`PLATFORM_READ_ONLY`.

Effets, dans une seule transaction :

1. réservation du `clientEventId` dans le registre d'idempotence, opération `ORGANIZATION_CREATE`,
   **avant** tout autre effet : réserver après agir laisserait la fenêtre que la réservation existe
   pour fermer ;
2. création de l'organisation : `verificationStatus` à `PENDING`, `status` à `ACTIVE`, `version`
   à 1 ;
3. création de l'adhésion du créateur, rôle `ORG_ADMIN`, statut `ACTIVE` ;
4. audit `ORGANIZATION_CREATED` sur la cible `ORGANIZATION`, puis `ORGANIZATION_MEMBER_ADDED` sur la
   cible `ORGANIZATION_MEMBER` ;
5. message d'outbox `ORGANIZATION_SUBMITTED`, agrégat `ORGANIZATION`, destiné à la file de
   validation des administrateurs plateforme ;
6. inscription de la cible produite et de la réponse à rejouer sur la ligne réservée à l'étape 1.

Le créateur devient administrateur de l'organisation qu'il crée, sans que le client puisse le
demander ni le refuser. Une organisation sans administrateur serait une fiche que personne ne peut
corriger, donc une entrée définitivement bloquée dans la file de validation.

### Lire une organisation

```http
GET /api/v1/organizations/{organizationId}
```

Réponse `200` : le même objet `organization` que ci-dessus, accompagné de l'adhésion du seul
appelant.

```json
{
  "organization": { "...": "identique à la réponse de création" },
  "membership": {
    "role": "CONTRIBUTOR",
    "status": "ACTIVE",
    "validFrom": "2026-07-19T08:00:00Z",
    "validUntil": null
  }
}
```

`membership` décrit l'appelant, et lui seul. La liste des membres relève d'US-014 : l'exposer ici
ferait de la lecture d'une organisation la liste de ses coordinateurs, alors que les identités des
coordinateurs sont un actif de `docs/threat-model.md`. Un appelant admis au seul titre de sa
fonction d'administrateur plateforme, sans adhésion à l'organisation lue, reçoit `membership` à
`null` : le champ dit ce que l'appelant est dans cette organisation, pas ce qui lui donne accès.

Point ouvert, hérité et non tranché par ce lot. `docs/permissions.md` range `PLATFORM_ADMIN` parmi
les rôles, et le type énuméré des adhésions le reprend, si bien qu'un rôle dont la portée est la
plateforme se trouve rattaché à une organisation — le jeu de démonstration le signale déjà
(`supabase/seed/003_organization-members.sql`). Tant que l'arbitrage n'a pas eu lieu, ce contrat
tient les deux chemins pour distincts : la fonction d'administrateur plateforme donne l'accès,
l'adhésion décrit l'appartenance, et rien n'oblige les deux à coïncider.

Erreurs : `UNAUTHENTICATED`, `NOT_FOUND`, `RATE_LIMITED`.

Un appelant qui n'est ni membre ni administrateur plateforme reçoit `NOT_FOUND`, et non `FORBIDDEN`.
Répondre `403` confirmerait que l'identifiant désigne une organisation existante, ce qui ferait de
la route un oracle d'existence. Le journal technique, lui, conserve le motif réel — un refus
d'autorisation, compté parmi les métriques de `docs/observability.md` — afin que l'exploitation
distingue les deux cas que l'appelant ne distingue pas.

#### Le motif réel conservé au journal technique

La phrase ci-dessus est une promesse, et voici sa mise en œuvre. Chaque refus prononcé par les
gardes d'organisation écrit une ligne de journal au niveau `warn`, de message
`acces a une organisation refuse`, portant `module`, `organizationId`, `errorCode` et surtout
`reason` — le motif réel, celui que la réponse tait.

| `reason` | Cause exacte | Code rendu, lecture | Code rendu, modification |
|---|---|---|---|
| `ORGANIZATION_ABSENT` | l'identifiant ne désigne aucune organisation, qu'il soit un UUID inconnu ou un segment de chemin qui n'est même pas un UUID | `NOT_FOUND` | `NOT_FOUND` |
| `MEMBERSHIP_ABSENT` | l'organisation existe, l'appelant n'y a aucune adhésion | `NOT_FOUND` | `NOT_FOUND` |
| `MEMBERSHIP_INVITED` | adhésion préparée, jamais acceptée | `NOT_FOUND` | `FORBIDDEN` |
| `MEMBERSHIP_SUSPENDED` | adhésion coupée après incident, réversible | `NOT_FOUND` | `FORBIDDEN` |
| `MEMBERSHIP_REVOKED` | adhésion retirée définitivement | `NOT_FOUND` | `FORBIDDEN` |
| `MEMBERSHIP_NOT_YET_OPEN` | adhésion active dont `validFrom` est encore à venir | `NOT_FOUND` | `FORBIDDEN` |
| `MEMBERSHIP_EXPIRED` | adhésion active dont `validUntil` est passée | `NOT_FOUND` | `FORBIDDEN` |
| `MEMBERSHIP_OUT_OF_WINDOW` | fenêtre close sans que la borne franchie soit déterminable | `NOT_FOUND` | `FORBIDDEN` |
| `ROLE_NOT_ALLOWED` | adhésion effective, mais rôle non admis pour cette action | — | `FORBIDDEN` |

Trois propriétés font tenir l'échange, et elles sont éprouvées ensemble par
`tests/integration/organizations-refus-journal.test.ts` :

1. **la réponse ne distingue rien** — deux causes distinctes rendent le même statut et le même
   corps, octet pour octet, `requestId` mis à part ;
2. **le journal distingue tout** — deux causes distinctes portent deux `reason` différents, dans la
   même requête ;
3. **la ligne ne nomme jamais la structure** — ni `name`, ni `registrationNumber` sous aucune de ses
   graphies, ni `territoryCode`, ni aucune coordonnée du demandeur. Seul `organizationId` y figure :
   il est opaque, l'appelant vient de le fournir, et `docs/observability.md` le range parmi les
   champs attendus. Sans lui, un balayage de mille identifiants serait indiscernable d'un lien mort
   rechargé mille fois. Un journal qui recopierait le nom ou le numéro rouvrirait côté exploitation
   l'oracle que la réponse ferme côté client, au profit de rôles auxquels l'application refuse
   précisément cette information.

Le niveau est `warn`, et le choix est contraint. `error` ferait remonter un refus comme une panne et
noierait les vraies. `info` serait pire : la ligne de sortie de requête est déjà émise en `warn`
pour tout 4xx, si bien qu'un déploiement réglé sur `warn` conserverait le refus et perdrait son
motif — la situation même que ce contrat interdit, avec en plus l'apparence d'être outillé. Aucune
ligne n'est écrite lorsque l'accès est accordé : le volume ajouté en fonctionnement normal est nul.

Deux chemins échappaient à cette promesse, et l'inventaire est désormais tenu ici plutôt qu'affirmé
en bloc.

- **`PATCH` sur un identifiant inconnu** — l'existence était éprouvée par la commande de domaine
  avant que la garde ne soit consultée, et ce refus-là ne passait par aucun motif. Il passe
  maintenant par `denyOrganizationAccess`, comme en lecture.
- **Identifiant de chemin qui n'est pas un UUID** — refusé par la validation, donc avant même la
  transaction, et sans la moindre ligne. C'était le trou le plus coûteux : un balayage mené avec
  des identifiants mal formés ne produisait RIEN, alors que le même balayage en UUID bien formés
  était compté une fois par tentative. La métrique « refus d'autorisation » sous-comptait par
  construction, et l'alerte était aveugle à la forme de balayage la moins coûteuse à mener. Ce
  refus écrit désormais lui aussi son motif, avec `organizationId` valant le marqueur constant
  `(non conforme)` : le segment reçu n'est JAMAIS recopié au journal, sous peine d'en faire un
  miroir de texte arbitraire choisi par l'appelant. Le motif reste `ORGANIZATION_ABSENT`, qui est
  exact — un segment mal formé ne désigne aucune organisation ; un motif distinct
  `ORGANIZATION_ID_MALFORMED` serait plus fin et suppose d'ouvrir le vocabulaire du module
  d'autorisation.

Reste hors du dispositif, et le contrat l'assume plutôt que de prétendre l'exhaustivité :
l'organisation non `ACTIVE` (voir « Modifier une organisation » ci-dessous), refusée par
`FORBIDDEN` sans motif propre parce qu'aucune existence n'y est dissimulée — l'appelant en est
membre. Le jour où cette garde devra alimenter la métrique, elle réclamera un motif au vocabulaire,
`ORGANIZATION_NOT_ACTIVE`, et l'`organizationId` que son appelant détient déjà.

**Le travail effectué est le même dans les deux branches.** Sur `GET` comme sur `PATCH`,
l'organisation est lue ET l'accès résolu AVANT que l'absence soit éprouvée. Ce n'est pas une
élégance : éprouver l'absence d'abord épargnerait deux requêtes au cas « identifiant inconnu » et
les ferait payer au cas « existe, mais l'appelant n'y est rien ». Les corps sont identiques au bit
près, les durées ne le seraient pas, et aucune comparaison d'octets ne verrait cet écart —
l'oracle d'existence fermé par la porte se rouvrirait par la durée.

### Modifier une organisation

```http
PATCH /api/v1/organizations/{organizationId}
```

```json
{
  "name": "Exploitation agricole Martin et Fils",
  "territoryCode": "ZZ-DEMO-02",
  "expectedVersion": 1
}
```

Au moins un champ modifiable doit être présent : `name`, `type`, `registrationNumber`,
`territoryCode`. Un corps qui ne porterait que `expectedVersion` est refusé par `VALIDATION_ERROR` ;
une requête sans effet qui répondrait `200` laisserait croire à une modification appliquée.

`expectedVersion` est **obligatoire**. Deux administrateurs de la même organisation qui corrigent la
même fiche depuis deux postes ne se voient pas l'un l'autre. Sans version attendue, le dernier
écrivain gagne et la modification de l'autre disparaît sans message ni trace côté appelant. Sur des
champs qui portent l'identité de la structure, cet écrasement silencieux n'est pas une gêne
d'ergonomie : c'est une fiche qui affiche autre chose que ce que son administrateur croit avoir
enregistré, et sur laquelle un administrateur plateforme fondera pourtant sa décision.

La version attendue doit être exactement la version courante. À défaut, `VERSION_CONFLICT`, et rien
n'est écrit. L'écran recharge alors et affiche l'état réel : c'est l'état « conflit de version »
exigé de tous les écrans par `docs/screens.md`.

Réponse `200` : l'objet `organization` complet, `version` incrémentée de un.

Erreurs : `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `VERSION_CONFLICT`,
`RATE_LIMITED`, `PLATFORM_READ_ONLY`.

- `FORBIDDEN` — l'appelant est membre mais n'est pas `ORG_ADMIN`, ou son adhésion n'est pas active,
  ou elle est hors de sa fenêtre de validité, ou l'organisation n'est pas `ACTIVE`. La distinction
  avec `NOT_FOUND` est assumée : à ce stade l'appelant sait déjà que l'organisation existe,
  puisqu'il en est membre.
- `NOT_FOUND` — l'appelant n'est ni membre ni administrateur plateforme. Même règle qu'en lecture.

Les quatre causes de `FORBIDDEN` réunies dans le premier point ne se corrigent pas de la même
façon : accorder un rôle, réactiver une adhésion, en repousser l'échéance ou rouvrir l'organisation.
La réponse ne les distingue pas ; le journal technique, lui, les sépare par le champ `reason` décrit
plus haut. La seule exception est l'organisation non `ACTIVE`, qui relève d'une garde portant sur
l'état de la structure et non sur l'adhésion : elle n'a pas de motif propre, et n'en a pas besoin —
aucune existence n'y est dissimulée, puisque l'appelant en est membre.

#### Modifier un champ d'identité annule la vérification

Modifier `name`, `type` ou `registrationNumber` d'une organisation `VERIFIED` la ramène à `PENDING`
et la replace dans la file de validation, dans la même transaction.

Sans cette règle, la validation serait contournable en deux appels : faire valider une exploitation
agricole, puis la renommer « Service incendie territorial ». L'usurpation d'organisation est l'une
des menaces prioritaires de `docs/security.md`, et un état « validée » qui survit au changement de
nom la rend triviale. `territoryCode` est volontairement exclu de cette liste : il décrit un
périmètre d'action, pas une identité, et le soumettre à revalidation dissuaderait de le corriger.

Effets, dans une seule transaction :

1. mise à jour conditionnée par la version attendue, puis incrément de `version` ;
2. audit `ORGANIZATION_UPDATED` sur la cible `ORGANIZATION`, `before` et `after` réduits aux seuls
   champs modifiés ;
3. lorsque la vérification retombe, audit `ORGANIZATION_VERIFICATION_RESET` et message d'outbox
   `ORGANIZATION_SUBMITTED`, comme à la création.

### Idempotence et concurrence : deux clés pour deux problèmes

`clientEventId` répond à « cette commande a-t-elle déjà été exécutée ? ». `expectedVersion` répond à
« l'objet est-il encore tel que l'appelant l'a lu ? ». Les deux questions sont indépendantes, et
chaque route porte celle qui a un sens pour elle.

| Clé | Création | Modification |
|---|---|---|
| `clientEventId` | obligatoire | absent |
| `expectedVersion` | sans objet, l'agrégat n'existe pas encore | obligatoire |

La création s'appuie sur le registre central `idempotency_keys` : la clé est réservée avant d'agir,
dans la transaction de la mutation, et son unicité est aujourd'hui **globale**, toutes opérations et
tous acteurs confondus. Deux rejeux strictement simultanés ne produisent donc pas deux effets : le
second se heurte à l'unicité et relit la ligne du premier. La portée elle-même reste un point ouvert
du corpus, arbitré au plus tard au lot 5 (`supabase/README.md`, « portée de `client_event_id` ») ;
le contrat n'en dépend pas, une portée par acteur ne changeant ni les corps ni les codes d'erreur.

Limite assumée, à ne pas se cacher. Une modification dont la réponse s'est perdue en route n'est pas
rejouable : la seconde tentative présente une version devenue périmée et reçoit `VERSION_CONFLICT`.
L'invariant de `CLAUDE.md` tient — une même commande n'a produit qu'un seul effet — mais l'appelant
reçoit un conflit alors que personne ne lui a rien pris. L'écran doit donc traiter ce cas en
rechargeant et en affichant l'état courant, où il retrouvera sa propre modification, plutôt qu'en
laissant croire qu'un tiers est intervenu.

Écart connu : le schéma partagé `expectedVersionSchema` de `src/validation/common.ts` accepte zéro,
alors que la première version d'une organisation est un (ADR-019). Un `expectedVersion` à zéro est
donc syntaxiquement valide et sémantiquement impossible : il produit `VERSION_CONFLICT` et jamais
`VALIDATION_ERROR`. L'écart est signalé plutôt que corrigé en silence, le schéma étant partagé par
des agrégats dont la première version n'est pas encore arbitrée.

### File des organisations en attente

La route est déjà déclarée dans la section « Administration » de ce document. Sa forme est précisée
ici parce que l'écran 10 de `docs/screens.md` en dépend.

```http
GET /api/v1/admin/organizations/pending?cursor=...
```

Réservée au rôle `PLATFORM_ADMIN` (`docs/permissions.md`, « Valider une organisation »). Tout autre
appelant reçoit `FORBIDDEN` : ici, contrairement à la lecture d'une organisation, il n'y a aucune
existence à dissimuler, seulement une fonction à refuser.

Réponse `200` :

```json
{
  "items": [
    {
      "id": "uuid",
      "name": "Travaux Publics Horizon",
      "type": "COMPANY",
      "registrationNumber": "FICTIF-ORG-0004",
      "territoryCode": "ZZ-DEMO-02",
      "createdAt": "2026-07-18T08:00:00Z",
      "requestedBy": { "displayName": "David C." }
    }
  ],
  "nextCursor": null
}
```

Les éléments sont rendus du plus ancien au plus récent. Une file de validation triée par nouveauté
laisse au fond celles que personne n'a traitées, c'est-à-dire précisément celles qui attendent
depuis le plus longtemps.

`requestedBy` ne porte que le nom d'affichage. Ni courriel, ni téléphone : la minimisation de
`docs/privacy-rgpd.md` vaut pour un écran d'administration comme pour les autres, et vérifier un
numéro d'immatriculation ne suppose pas de joindre le demandeur.

La commande `POST /api/v1/admin/organizations/{organizationId}/commands/verify` relève d'US-013 et
n'est pas livrée ici. La file existe donc avant la décision qu'elle prépare : c'est délibéré, elle
rend visible ce qui attend plutôt que de le laisser invisible jusqu'au lot suivant.

## Ressources

### Créer une ressource

```http
POST /api/v1/resources
```

```json
{
  "categoryId": "uuid",
  "name": "Citerne 12 m3",
  "description": "Citerne agricole tractée",
  "capacity": 12,
  "capacityUnit": "M3",
  "requiresOperator": true,
  "mobilizationRadiusKm": 50
}
```

### Lister les ressources

```http
GET /api/v1/resources?status=AVAILABLE&categoryId=uuid&cursor=...
```

### Modifier une ressource

```http
PATCH /api/v1/resources/{resourceId}
```

## Demandes

### Créer

```http
POST /api/v1/requests
```

### Publier

```http
POST /api/v1/requests/{requestId}/commands/publish
```

```json
{
  "clientEventId": "uuid",
  "expectedVersion": 3
}
```

### Lister

```http
GET /api/v1/requests?status=PUBLISHED&territoryCode=...
```

## Propositions

### Soumettre

```http
POST /api/v1/requests/{requestId}/offers
```

```json
{
  "resourceId": "uuid",
  "estimatedArrivalAt": "2026-07-27T15:30:00Z",
  "operatorIncluded": true,
  "comment": "Disponible immédiatement",
  "clientEventId": "uuid"
}
```

### Retirer

```http
POST /api/v1/offers/{offerId}/commands/withdraw
```

## Missions

### Affecter

```http
POST /api/v1/offers/{offerId}/commands/accept
```

```json
{
  "clientEventId": "uuid",
  "expectedOfferVersion": 2,
  "expectedResourceVersion": 5,
  "meetingPointId": "uuid"
}
```

### Transition

```http
POST /api/v1/missions/{missionId}/transitions
```

```json
{
  "transition": "CONFIRM_DEPARTURE",
  "clientEventId": "uuid",
  "expectedVersion": 4,
  "comment": "Départ confirmé"
}
```

### Lire une mission

```http
GET /api/v1/missions/{missionId}
```

La réponse dépend du rôle et de la relation avec la mission.

## Incidents

```http
POST /api/v1/missions/{missionId}/incidents
```

```json
{
  "type": "VEHICLE_BREAKDOWN",
  "severity": "HIGH",
  "description": "Immobilisation sur l'axe prévu",
  "clientEventId": "uuid"
}
```

## Notifications

```http
GET /api/v1/notifications
POST /api/v1/notifications/{notificationId}/acknowledge
```

## Administration

```http
GET  /api/v1/admin/organizations/pending
POST /api/v1/admin/organizations/{organizationId}/commands/verify
POST /api/v1/admin/users/{userId}/commands/suspend
POST /api/v1/admin/platform/commands/enable-read-only
```

## Codes d'erreur principaux

- `UNAUTHENTICATED`
- `AUTHENTICATION_FAILED`
- `FORBIDDEN`
- `ORGANIZATION_NOT_VERIFIED`
- `INVALID_TRANSITION`
- `VERSION_CONFLICT`
- `IDEMPOTENCY_CONFLICT`
- `RESOURCE_UNAVAILABLE`
- `RESOURCE_ALREADY_ASSIGNED`
- `DOCUMENT_EXPIRED`
- `MEETING_POINT_REQUIRED`
- `REQUEST_EXPIRED`
- `RATE_LIMITED`
- `PLATFORM_READ_ONLY`

### Codes de transport

Les codes ci-dessus décrivent des refus métier. Sept autres codes sont produits par l'enveloppe des
routes, avant tout traitement, et sont communs à toutes les routes. Ils sont documentés ici parce
que les routes d'organisation les renvoient et qu'un code renvoyé sans être décrit n'est pas un
contrat.

- `VALIDATION_ERROR` — corps ou paramètre mal formé. `details.fields` nomme les champs fautifs, sans
  jamais reprendre les valeurs reçues.
- `NOT_FOUND` — objet inexistant, ou dont l'existence n'est pas confirmée à cet appelant.
- `METHOD_NOT_ALLOWED`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE` — requête non conforme au
  transport attendu.
- `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE` — défaillance côté plateforme, message neutre.

Divergence connue, à trancher. `AUTHENTICATION_FAILED`, employé plus haut par la section
« Authentification », ne figure pas dans `ERROR_CODES` de `src/application/errors.ts` : le code
livré émet `UNAUTHENTICATED` pour les quatre cas d'échec d'un code à usage unique. La neutralité
exigée par le critère 7 de US-010 est préservée, les quatre cas partageant bien une réponse unique,
mais cette réponse n'est pas celle qu'annonce ce document. Deux issues possibles, l'une ou l'autre,
jamais les deux : ajouter le code au catalogue, ou aligner ce document sur `UNAUTHENTICATED`.

# Observabilité

## Objectifs

- Détecter les pannes.
- Diagnostiquer les erreurs.
- Mesurer les parcours.
- Identifier les abus.
- Conserver des traces sans exposer de données sensibles.

## Logs

Inclure :

- niveau ;
- horodatage ;
- environnement ;
- service ;
- route ;
- requestId ;
- userId pseudonymisé — **cible non atteinte, voir « État réel du champ `userId` » ci-dessous** ;
- organizationId ;
- code d'erreur ;
- durée ;
- motif de refus (`reason`), sur les seules lignes de refus d'autorisation.

Exclure :

- mots de passe ;
- jetons ;
- documents ;
- position exacte ;
- téléphone complet ;
- contenu sensible d'incident ;
- nom d'organisation, numéro d'immatriculation, code territorial.

### Refus d'autorisation

`docs/api-contract.md` ferme volontairement l'oracle d'existence : un appelant qui n'est pas membre
d'une organisation reçoit la même réponse, octet pour octet, qu'un appelant dont l'identifiant ne
désigne rien. La contrepartie de cette fermeture est ici, et c'est elle qui rend la métrique et
l'alerte constructibles.

Chaque refus prononcé par les gardes d'organisation écrit **une ligne, au niveau `warn`**, de
message `acces a une organisation refuse` :

```json
{
  "level": "warn",
  "module": "organizations",
  "organizationId": "…",
  "errorCode": "NOT_FOUND",
  "reason": "MEMBERSHIP_REVOKED",
  "msg": "acces a une organisation refuse"
}
```

Motifs émis : `ORGANIZATION_ABSENT`, `MEMBERSHIP_ABSENT`, `MEMBERSHIP_INVITED`,
`MEMBERSHIP_SUSPENDED`, `MEMBERSHIP_REVOKED`, `MEMBERSHIP_NOT_YET_OPEN`, `MEMBERSHIP_EXPIRED`,
`MEMBERSHIP_OUT_OF_WINDOW`, `ROLE_NOT_ALLOWED`. Le tableau complet, avec le code rendu à l'appelant
dans chaque cas, est dans `docs/api-contract.md`.

Trois chemins produisent cette ligne : la lecture, la modification, et la validation de
l'identifiant de chemin. Ce dernier cas — un segment qui n'est même pas un UUID — porte
`ORGANIZATION_ABSENT` et un `organizationId` valant le marqueur constant `(non conforme)`. Le
segment reçu n'est jamais recopié : il est choisi par l'appelant, de longueur non bornée, et le
journal d'exploitation n'a pas à en devenir le miroir. Le marqueur regroupe de lui-même les
balayages mal formés en une seule ligne de tableau de bord, et les distingue des balayages menés en
UUID valides.

Pourquoi `warn` et pas `info` : la ligne de sortie de requête est déjà émise en `warn` pour tout
4xx. Un motif journalisé en dessous disparaîtrait de tout déploiement réglé sur `warn`, qui
conserverait alors les refus sans leur cause — c'est-à-dire la situation d'avant, avec en plus
l'apparence d'être outillé. Aucune ligne n'est écrite quand l'accès est accordé. La même règle vaut
pour toute ligne de motif accompagnant un refus : le conflit de version de `PATCH`, qui produit un
409, est journalisé en `warn` et non en `info`, par le même raisonnement.

Ce que l'exploitation peut en construire :

- **compter les refus** par `reason`, sans relire ni interpréter les journaux applicatifs ;
- **séparer les causes entre elles** : une rafale d'`ORGANIZATION_ABSENT` est un balayage
  d'identifiants ; une rafale de `MEMBERSHIP_REVOKED` est un onglet resté ouvert après une
  révocation ; une rafale de `MEMBERSHIP_NOT_YET_OPEN` est une prise de fonction datée de travers,
  donc un incident d'exploitation. Le `reason` suffit à ces trois lectures — c'est pour cela qu'il
  y a plusieurs motifs et non un « REFUSÉ » unique ;
- **mesurer le rapport** entre refus et requêtes servies, par route.

Ce que la ligne ne porte jamais : ni le nom de l'organisation, ni son numéro d'immatriculation sous
aucune graphie, ni son code territorial, ni aucune coordonnée. `organizationId` y figure seul, parce
qu'un identifiant opaque que l'appelant vient de fournir est ce qui permet de distinguer mille
identifiants balayés d'un lien mort rechargé mille fois. Un journal qui recopierait le nom ou le
numéro rouvrirait côté exploitation l'oracle que la réponse ferme côté client.

### État réel du champ `userId` — dette explicite

**Aucune ligne émise par la plateforme ne porte aujourd'hui `userId`, et aucune analyse ne doit être
fondée dessus.** Le champ est déclaré (`RequestContext.userIdHash`), la fonction de pseudonymisation
existe et est testée (`pseudonymizeUserId`), le journaliseur sait l'écrire
(`buildRequestBindings`) — mais **rien ne le renseigne** : `defineRoute` construit le contexte avant
que la session soit résolue, et `defineAuthenticatedRoute`, qui la résout, ne complète pas le
contexte.

Ce que cela coûte, précisément : deux rafales d'`ORGANIZATION_ABSENT` de même volume — l'une venue
d'un compte unique qui balaye des identifiants, l'autre de mille utilisateurs légitimes tombant sur
un lien mort — sont aujourd'hui **indiscernables**. Le `reason` et l'`organizationId` séparent les
causes techniques, ils ne séparent pas les auteurs. Toute procédure d'astreinte écrite comme si
`userId` était disponible enverrait l'astreinte chercher un champ qui n'existe pas.

Ce qu'il faut pour lever la dette, et rien de plus : renseigner `userIdHash` dès la session résolue,
dans `defineAuthenticatedRoute` (`app/api/v1/auth/_shared/auth-route.ts`), le contexte étant
complété plutôt que reconstruit. Le rendu de page serveur restera à traiter séparément : il
n'ouvre aucun contexte de requête, donc ses lignes ne portent ni `requestId`, ni `route`, ni
`method` — et n'en porteront pas davantage `userId` par ce seul correctif.

## Métriques

- taux d'erreur ;
- latence ;
- disponibilité ;
- nombre de demandes ;
- propositions ;
- affectations ;
- transitions ;
- conflits ;
- notifications échouées ;
- profondeur de file ;
- connexions ;
- refus d'autorisation — source : les lignes `acces a une organisation refuse`, ventilées par
  `reason`.

## Alertes

- taux d'erreur élevé ;
- impossibilité d'affecter ;
- base indisponible ;
- file bloquée ;
- SMS en échec ;
- hausse d'accès refusés — déclenchée sur la métrique ci-dessus ; le `reason` accompagne l'alerte,
  faute de quoi l'astreinte ne saurait pas si elle est réveillée pour une attaque ou pour une
  révocation de masse. Le `reason` ne dit pas QUI : tant que `userId` n'est renseigné nulle part
  (voir « État réel du champ `userId` »), l'astreinte ne peut pas distinguer un compte unique qui
  balaye de mille comptes tombant sur un lien mort ;
- uploads suspects ;
- saturation ;
- sauvegarde échouée.

## Traces

Tracer les opérations critiques :

```text
request
→ authorization
→ transaction
→ audit
→ outbox
→ notification
```

## Tableaux de bord

- santé technique ;
- activité opérationnelle ;
- sécurité ;
- notifications ;
- base de données ;
- files.

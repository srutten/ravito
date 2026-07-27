# Spécification fonctionnelle

## Parcours 1 — Déclarer une ressource

Le contributeur :

1. crée son compte ;
2. complète son profil ;
3. crée une ressource ;
4. fournit les caractéristiques ;
5. ajoute les documents requis ;
6. choisit sa zone de disponibilité ;
7. active ou désactive sa disponibilité.

### Données minimales

- catégorie ;
- nom court ;
- description ;
- capacité ;
- dimensions utiles si nécessaires ;
- type de carburant ;
- besoin d'un opérateur ;
- localisation habituelle approximative ;
- rayon de mobilisation ;
- disponibilité ;
- photo facultative ;
- documents selon catégorie.

## Parcours 2 — Publier un besoin

Le coordinateur :

1. sélectionne une organisation ;
2. choisit une catégorie ;
3. indique quantité et contraintes ;
4. sélectionne un point de rassemblement ;
5. définit le niveau de priorité ;
6. précise le délai ;
7. publie la demande.

### Informations interdites au public

- position exacte du front ;
- position des équipes ;
- axes tactiques ;
- identités non nécessaires ;
- fréquence radio ;
- données personnelles des victimes.

## Parcours 3 — Proposer une ressource

Le contributeur reçoit une alerte ou consulte les besoins compatibles.

Il peut :

- vérifier les contraintes ;
- sélectionner une ressource ;
- proposer un délai d'arrivée ;
- indiquer la présence d'un opérateur ;
- ajouter un commentaire ;
- retirer la proposition tant qu'elle n'est pas acceptée.

## Parcours 4 — Affecter une ressource

Le coordinateur :

1. compare les propositions ;
2. vérifie les documents ;
3. choisit une proposition ;
4. confirme le point de rassemblement ;
5. génère la mission ;
6. déclenche les notifications.

Une ressource ne peut être affectée qu'à une mission active à la fois.

## Parcours 5 — Suivre l'acheminement

Le contributeur peut confirmer :

- mission acceptée ;
- départ ;
- arrivée au point de rassemblement ;
- remise de la ressource ;
- retour ou restitution.

Le coordinateur peut :

- confirmer l'arrivée ;
- signaler un retard ;
- modifier un point de contact ;
- déclarer un incident ;
- annuler selon les règles autorisées.

## Parcours 6 — Clôturer

La clôture comprend :

- date de fin ;
- état de restitution ;
- commentaire ;
- incident éventuel ;
- confirmation du coordinateur ;
- confirmation du contributeur, si disponible.

## Administration

L'administrateur peut :

- valider une organisation ;
- suspendre un compte ;
- révoquer des sessions ;
- gérer les catégories ;
- masquer une ressource ;
- consulter les audits ;
- placer la plateforme en lecture seule ;
- désactiver de nouvelles missions.

## Règles d'interface

- Mobile-first.
- Boutons d'action critiques larges et explicites.
- Confirmation pour les annulations.
- Pas d'action critique cachée dans un menu ambigu.
- Statut toujours visible.
- Heure et fuseau clairement affichés.
- Messages d'erreur avec action de reprise.
- Possibilité d'appeler le contact opérationnel.
- Indicateur de connexion réseau.

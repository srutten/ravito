# Journal de décisions d'architecture

## ADR-001 — Monolithe modulaire

Décision : utiliser une seule application déployable.

Raison : vitesse, simplicité, transactions, observabilité.

Conséquence : séparation logique stricte nécessaire.

## ADR-002 — PostgreSQL et PostGIS

Décision : base relationnelle avec géospatial.

Raison : cohérence, transactions et recherche de proximité.

## ADR-003 — REST versionné

Décision : API REST sous `/api/v1`.

Raison : simplicité et compatibilité.

## ADR-004 — Validation humaine

Décision : le moteur propose, un coordinateur décide.

Raison : sécurité et responsabilité.

## ADR-005 — Position approximative par défaut

Décision : toute vue non affectée utilise une position dégradée.

Raison : protection opérationnelle.

## ADR-006 — Outbox pour notifications

Décision : planifier les notifications via événements persistés.

Raison : éviter les notifications sans transaction ou les pertes.

## ADR-007 — Hors ligne limité

Décision : consultation et file locale uniquement.

Raison : réduire la complexité et les risques du MVP.

## ADR-008 — Événements de mission immuables

Décision : chronologie append-only.

Raison : audit, diagnostic et preuve.

## ADR-009 — Biome comme outil unique de lint et de format

Décision : utiliser Biome pour le lint et le format, à la place du couple ESLint et Prettier.

Raison : une seule dépendance au lieu de deux, une seule configuration, un seul mode d'échec en CI. Applique la contrainte de `CLAUDE.md` de ne pas ajouter de dépendance sans justification.

Conséquence : les règles disponibles sont celles de Biome. Un besoin de règle absente doit être traité par une revue ou un test, pas par la réintroduction d'ESLint sans nouvelle décision. Le format de référence est fixé dans `biome.json` : guillemets simples, points-virgules, largeur 100 colonnes, indentation de 2 espaces, virgule finale.

## ADR-010 — TypeScript 5.9.3 pour le lot 0

Décision : figer TypeScript en 5.9.3 alors que la version courante publiée est 7.0.2.

Raison : dé-risquer le lot 0 en s'appuyant sur une chaîne d'outils éprouvée. Next, Vitest et Biome sont validés avec cette version, et le lot 0 ne doit pas absorber en plus une migration de compilateur.

Conséquence : dette technique explicite. Un spike de migration vers TypeScript 7 doit être instruit avant le lot 3, avec évaluation de la compatibilité du plugin Next, des options strictes déjà activées et du temps de compilation. Tant que le spike n'a pas conclu, la version ne change pas.

## ADR-011 — CSS Modules et jetons de design en variables CSS

Décision : construire l'interface avec les CSS Modules de Next et des jetons de design déclarés en variables CSS natives, sans framework CSS.

Raison : parcimonie des dépendances, conformément à `CLAUDE.md`. Le besoin du MVP est un design system minimal, pas une bibliothèque générique.

Conséquence : le design system est écrit à la main. Les contrastes, les tailles de cibles tactiles et les états d'interface décrits dans `docs/screens.md` doivent être vérifiés explicitement, sans filet fourni par un framework.

## ADR-012 — npm comme gestionnaire de paquets

Décision : utiliser npm, avec `package-lock.json` versionné.

Raison : c'est le gestionnaire imposé par les commandes attendues dans `CLAUDE.md`. Il est disponible avec Node 24 sans installation supplémentaire, ce qui simplifie la procédure de démarrage sur un poste vierge et la configuration de la CI.

Conséquence : toute commande de documentation, de CI et de runbook s'écrit en npm. Changer de gestionnaire supposerait une nouvelle décision et la mise à jour de `CLAUDE.md`.

## ADR-013 — Racine du dépôt git sur `fire-support-platform`

Décision : placer la racine du dépôt git au niveau du répertoire `fire-support-platform`.

Raison : c'est le niveau où `CLAUDE.md` attend `app`, `src`, `tests`, `docs` et `supabase`. Une racine placée plus haut ferait diverger les chemins documentés, les alias `@/` et les chemins de la CI.

Conséquence : les chemins cités dans la documentation, dans `tsconfig.json` et dans les configurations de test sont relatifs à cette racine. Aucun fichier du produit ne vit au-dessus.

## ADR-014 — Refus par défaut câblé dans le routeur API dès le lot 0

Décision : toute route de l'API qui n'est pas déclarée publique de façon explicite répond `UNAUTHENTICATED`, dès le lot 0, avant même que l'authentification existe.

Raison : le principe de refus par défaut de `docs/permissions.md` ne doit pas attendre l'existence de l'authentification pour être structurellement vrai. Une route ajoutée pendant le lot 1 doit être fermée par construction, et non par la vigilance de son auteur.

Conséquence : ouvrir une route est un acte volontaire et traçable, jamais un effet de bord. Le lot 1 remplace le refus systématique par une vérification de session réelle, sans modifier le principe ni le code d'erreur exposé. Le format de réponse suit `docs/api-contract.md`.

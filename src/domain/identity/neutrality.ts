import { setTimeout as delay } from 'node:timers/promises';

/**
 * Neutralité de durée des commandes publiques (critère 7 de US-010).
 *
 * UNE DIFFÉRENCE DE DURÉE EST UNE FUITE. Deux réponses identiques au champ près ne
 * suffisent pas : si la demande de code pour une adresse inconnue revient
 * systématiquement plus vite que pour une adresse connue, il suffit de chronométrer une
 * liste d'adresses pour cartographier les comptes, et la première menace de
 * `docs/threat-model.md` — le compte coordinateur compromis — commence par là.
 *
 * TROIS MESURES, DANS CET ORDRE D'IMPORTANCE.
 *
 * 1. Faire le même travail. Les commandes exécutent les mêmes requêtes, dans le même
 *    ordre, qu'un compte existe ou non : un défi est créé dans les deux cas, la lecture
 *    du profil a lieu dans les deux cas. C'est la seule mesure qui tienne quelle que soit
 *    la charge.
 * 2. Ne jamais attendre l'envoi. C'est le seul travail qui diffère réellement, et il
 *    coûte des dizaines de millisecondes : il est sorti du chemin de réponse.
 * 3. Ce plancher, qui absorbe le résidu.
 *
 * CE QUE LE PLANCHER NE FAIT PAS. Il n'égalise rien au-delà de lui-même : si une branche
 * dépassait le plancher parce que la base est lente, l'écart redeviendrait mesurable. Il
 * ne remplace donc pas la première mesure, il la complète. Ajouter un délai ALÉATOIRE
 * serait pire qu'inutile : le bruit s'élimine en moyennant sur assez de mesures, alors
 * qu'un plancher déterministe supprime la différence au lieu de la masquer.
 */

/**
 * Exécute `run` en garantissant une durée minimale, que l'exécution réussisse ou lève.
 *
 * Le rattrapage s'applique aussi au chemin d'erreur, et c'est indispensable : une
 * demande de code refusée d'emblée reviendrait sinon en une fraction du temps d'une
 * demande acceptée.
 */
export async function withMinimumDuration<T>(minimumMs: number, run: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    const remaining = minimumMs - (performance.now() - startedAt);
    if (remaining > 0) {
      await delay(remaining);
    }
  }
}

import { describe, expect, it } from 'vitest';
import { formatAge } from '../../app/(app)/administration/organisations-en-attente/pending-organizations-list';

/**
 * Ancienneté d'une ligne de la file d'administration, écrite EN TOUTES LETTRES (US-012,
 * `docs/screens.md` écran 10).
 *
 * POURQUOI CE FICHIER EXISTE. `docs/screens.md` range l'ancienneté parmi les exigences
 * d'accessibilité : « chaque ligne affiche donc l'ancienneté en toutes lettres — en attente depuis
 * 3 jours — et non par une pastille de couleur ». Une information portée par du texte doit dire
 * vrai, sans quoi elle est pire qu'une pastille : elle est crue. Or la fonction qui la met en forme
 * porte TROIS bornes — l'heure, le jour, et le pluriel de chacune — qu'aucun test n'atteignait, et
 * qu'un parcours de bout en bout n'atteint qu'au prix d'organisations datées à la main. Une
 * inversion de borne afficherait « 1 jour » à une structure qui attend depuis trois semaines, et
 * la file de validation — triée de la plus ancienne à la plus récente précisément pour que les
 * plus anciennes passent devant — mentirait sur ce qui justifie son ordre.
 *
 * LES LIBELLÉS ATTENDUS SONT RECOPIÉS À LA MAIN, jamais importés de `src/i18n/fr.ts`. Les
 * comparer au catalogue que la fonction emploie pour les produire n'éprouverait rien : le test
 * passerait quel que soit le texte rendu, y compris vide. C'est la règle déjà appliquée par
 * `tests/e2e/organizations.spec.ts`.
 *
 * L'INSTANT DE RÉFÉRENCE EST FOURNI, JAMAIS LU DE L'HORLOGE. `formatAge` reçoit son « maintenant »
 * en second paramètre — l'écran lui passe l'heure du dernier chargement abouti — et c'est ce qui
 * rend ces bornes observables sans truquer le temps ni rendre le verdict dépendant de la minute où
 * la suite tourne.
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Instant de référence arbitraire mais FIXE : un test daté d'aujourd'hui vieillirait. */
const NOW = new Date('2026-07-15T12:00:00.000Z');

/** Ancienneté demandée à la fonction, exprimée en millisecondes écoulées depuis le dépôt. */
function ageOf(elapsedMilliseconds: number): string {
  return formatAge(new Date(NOW.getTime() - elapsedMilliseconds), NOW);
}

describe('anciennete d une organisation en attente, en toutes lettres', () => {
  describe('sous l heure', () => {
    it('dit « moins d une heure » pour un dépôt à l instant même', () => {
      expect(ageOf(0)).toBe("moins d'une heure");
    });

    it('dit encore « moins d une heure » une milliseconde avant l heure pleine', () => {
      // BORNE HAUTE DE LA PREMIÈRE TRANCHE. Un `<=` posé ici ferait basculer l'heure pleine dans
      // cette tranche, et une organisation déposée il y a exactement une heure serait annoncée
      // comme déposée à l'instant.
      expect(ageOf(HOUR - 1)).toBe("moins d'une heure");
    });

    it('ne compte pas les minutes : trente-neuf minutes restent « moins d une heure »', () => {
      // Choix de conception, pas approximation : une valeur qui changerait à chaque rendu ferait
      // douter de la fraîcheur de tout le reste de l'écran.
      expect(ageOf(39 * MINUTE)).toBe("moins d'une heure");
    });
  });

  describe('en heures', () => {
    it('bascule sur « 1 heure » à l heure pleine, au singulier et sans nombre en double', () => {
      // PREMIÈRE BORNE. Un `<` changé en `<=` sur la tranche précédente rendrait « moins d'une
      // heure » ici, et une file d'attente d'une heure passerait pour instantanée.
      expect(ageOf(HOUR)).toBe('1 heure');
    });

    it('reste « 1 heure » une milliseconde avant la deuxième heure', () => {
      expect(ageOf(2 * HOUR - 1)).toBe('1 heure');
    });

    it('passe au pluriel dès la deuxième heure', () => {
      // Le singulier est rendu par un libellé ENTIER (« 1 heure ») et le pluriel par un nombre
      // suivi d'un libellé (« 2 heures ») : intervertir les deux produirait « 2 » ou « 1 heures ».
      expect(ageOf(2 * HOUR)).toBe('2 heures');
    });

    it('compte en heures jusqu à la veille du jour plein', () => {
      expect(ageOf(23 * HOUR)).toBe('23 heures');
      expect(ageOf(DAY - 1)).toBe('23 heures');
    });
  });

  describe('en jours', () => {
    it('bascule sur « 1 jour » au jour plein', () => {
      // SECONDE BORNE. Un `<=` sur la tranche des heures rendrait ici « 24 heures », forme qu'un
      // écran de file de validation n'emploie jamais.
      expect(ageOf(DAY)).toBe('1 jour');
    });

    it('reste « 1 jour » une milliseconde avant le deuxième jour', () => {
      expect(ageOf(2 * DAY - 1)).toBe('1 jour');
    });

    it('passe au pluriel dès le deuxième jour', () => {
      expect(ageOf(2 * DAY)).toBe('2 jours');
    });

    it('dit « 21 jours » à une organisation qui attend depuis trois semaines, jamais « 1 jour »', () => {
      // LE CAS QUI MOTIVE CE FICHIER. Une inversion de borne — jour et heure échangés, ou
      // `days <= 1` élargi — annoncerait « 1 jour » à une structure oubliée depuis trois semaines.
      // Personne ne remonterait la file pour vérifier : l'écran est cru sur parole.
      expect(ageOf(21 * DAY)).toBe('21 jours');
    });

    it('ne plafonne à aucune valeur : une attente d un an se dit en jours', () => {
      // Pas de « 99+ » ni de « plus d un mois » : `docs/screens.md` interdit à cet écran de
      // masquer l'ampleur de ce qu'il signale, compteur comme ancienneté.
      expect(ageOf(365 * DAY)).toBe('365 jours');
    });
  });

  describe('horloges désaccordées', () => {
    /*
     * CE QUE CETTE ASSERTION VAUT, ET CE QU'ELLE NE VAUT PAS — dit ici plutôt que laissé croire.
     *
     * `createdAt` vient de PostgreSQL, `now` de l'horloge du NAVIGATEUR : les deux peuvent diverger,
     * et une organisation déposée « dans le futur » n'est pas une hypothèse d'école. Le code borne
     * l'écart à zéro (`Math.max`). Cette borne est aujourd'hui INOBSERVABLE par la valeur rendue :
     * une durée négative tombe de toute façon sous l'heure, et retirer `Math.max` ne changerait
     * rien à ce que ce test lit. Elle le deviendrait dès que la première tranche compterait des
     * minutes — l'écran afficherait alors « -12 minutes ». L'assertion est donc un garde-fou
     * DÉCLARÉ, pas une preuve de la borne ; elle est signalée comme telle plutôt que comptée pour
     * ce qu'elle n'est pas.
     */
    it("n'annonce jamais une ancienneté négative quand l horloge du poste avance", () => {
      expect(ageOf(-3 * HOUR)).toBe("moins d'une heure");
      expect(ageOf(-21 * DAY)).toBe("moins d'une heure");
    });
  });
});

import { WarningTriangleIcon } from '@/components/ui/icons';
import styles from './emergency-notice.module.css';

/**
 * Bandeau de non-signalement, présent sur toutes les pages publiques.
 *
 * Le libellé est celui de la maquette de référence et de la Definition of Done de la story : il
 * est repris mot pour mot et ne doit pas être reformulé sans arbitrage produit.
 *
 * Accessibilité : la consigne est une région nommée, donc repérable dans la liste des points de
 * repère d'un lecteur d'écran, et un préfixe textuel annonce sa nature. Le triangle est
 * décoratif : rien n'est porté par la seule couleur ni par la seule icône.
 *
 * Ce n'est pas une région dynamique : `role="alert"` interromprait la lecture à chaque
 * chargement de page sans qu'aucun événement ne le justifie.
 */

// À déplacer dans `src/i18n/fr.ts` lorsque ce fichier sera dans le périmètre. Le catalogue livré
// au lot 0 porte une formulation différente sous `ui.home.emergencyNotice`, à réconcilier.
const EMERGENCY_NOTICE =
  'Ne pas utiliser cette application pour signaler un incendie. Appeler le 18 ou le 112 en urgence.';

const REGION_LABEL = 'Consigne de sécurité';
const SCREEN_READER_PREFIX = 'Avertissement important :';

export function EmergencyNotice() {
  return (
    <section className={styles.notice} aria-label={REGION_LABEL}>
      <p className={styles.inner}>
        <WarningTriangleIcon className={styles.icon} width={22} height={22} />
        <span>
          <span className="visually-hidden">{SCREEN_READER_PREFIX} </span>
          {EMERGENCY_NOTICE}
        </span>
      </p>
    </section>
  );
}

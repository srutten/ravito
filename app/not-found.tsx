import type { Metadata } from 'next';
import { StatePage } from '@/components/layout/state-page';
import { LinkButton } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { ArrowLeftIcon } from '@/components/ui/icons';

/** Page introuvable. Aucun détail technique, aucune indication sur ce qui existe par ailleurs. */

// À déplacer dans `src/i18n/fr.ts` lorsque ce fichier sera dans le périmètre.
const NOT_FOUND_TITLE = 'Page introuvable';
const NOT_FOUND_DESCRIPTION = "La page demandée n'existe pas ou n'est plus disponible.";
const BACK_TO_HOME = "Retour à l'accueil";

export const metadata: Metadata = {
  title: NOT_FOUND_TITLE,
};

export default function NotFound() {
  return (
    <StatePage>
      <ErrorState
        variant="notFound"
        titleLevel={1}
        title={NOT_FOUND_TITLE}
        description={NOT_FOUND_DESCRIPTION}
        action={
          <LinkButton href="/" variant="secondary" icon={<ArrowLeftIcon width={20} height={20} />}>
            {BACK_TO_HOME}
          </LinkButton>
        }
      />
    </StatePage>
  );
}

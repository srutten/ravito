'use client';

// Composant client : une frontière d'erreur React doit vivre dans le navigateur pour intercepter
// l'exception et exposer une reprise.

import { StatePage } from '@/components/layout/state-page';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { RefreshIcon } from '@/components/ui/icons';
import { messages } from '@/i18n/fr';

/**
 * État transverse « erreur ».
 *
 * La propriété `error` fournie par Next n'est volontairement pas lue : ni son message, ni sa
 * pile, ni son empreinte ne sont affichés (docs/security.md, messages d'erreur neutres). Le
 * détail réel reste dans les journaux serveur.
 */

// À déplacer dans `src/i18n/fr.ts` lorsque ce fichier sera dans le périmètre.
const ERROR_DESCRIPTION =
  "L'affichage de cette page a échoué. Réessayez ; si le problème persiste, revenez plus tard.";

export default function ErrorBoundaryPage({ reset }: { readonly reset: () => void }) {
  return (
    <StatePage>
      <ErrorState
        variant="error"
        titleLevel={1}
        description={ERROR_DESCRIPTION}
        live
        action={
          <Button variant="primary" icon={<RefreshIcon width={20} height={20} />} onClick={reset}>
            {messages.ui.states.retry}
          </Button>
        }
      />
    </StatePage>
  );
}

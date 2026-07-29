import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentSession } from '@/authorization';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { messages } from '@/i18n/fr';
import { CreateOrganizationForm } from './create-organization-form';

/**
 * Création d'une organisation (docs/screens.md, écran 11).
 *
 * COMPOSANT SERVEUR. Seul le formulaire est un composant client, pour les raisons écrites en
 * tête de `create-organization-form.tsx`. Textes, encart et contrôle de session sont rendus
 * ici : rien de tout cela ne dépend du navigateur, et l'alourdir en JavaScript pénaliserait
 * des utilisateurs qui sont, par construction, sur un téléphone et parfois en réseau dégradé.
 *
 * LE CONTRÔLE DE SESSION EST RÉPÉTÉ ICI, alors que la coquille `(app)` le fait déjà. Ce n'est
 * pas une redondance décorative : une mise en page de Next n'est pas réévaluée à chaque
 * navigation entre pages qui la partagent, et surtout une protection qui ne vivrait que dans
 * un fichier de mise en page disparaîtrait le jour où cette page serait déplacée d'un groupe
 * de routage à un autre. Le contrôle qui compte vraiment reste ailleurs : la route
 * `POST /api/v1/organizations` refuse d'elle-même, et c'est elle qu'un appel direct rencontre.
 *
 * CE FORMULAIRE EST OUVERT À TOUT COMPTE AUTHENTIFIÉ, et n'est pas gouverné par
 * `ENABLE_PUBLIC_REGISTRATION` : ce flag ouvre la création d'un COMPTE, pas celle d'une
 * organisation. Une organisation se crée depuis un compte déjà authentifié, et c'est ce qui
 * donne à chaque structure un responsable identifiable.
 */

export const dynamic = 'force-dynamic';

const SIGN_IN_PATH = '/connexion';

const labels = messages.ui.createOrganization;

export const metadata: Metadata = {
  title: labels.pageTitle,
  description: labels.pageDescription,
};

export default async function NouvelleOrganisationPage() {
  const session = await getCurrentSession();
  if (session === null) {
    redirect(SIGN_IN_PATH);
  }

  return (
    <>
      <PageHeader
        eyebrow={messages.ui.organizationDetail.eyebrow}
        title={labels.pageTitle}
        description={labels.pageDescription}
      />

      <Card padding="large" tone="raised">
        <CreateOrganizationForm />
      </Card>

      {/*
        Ce que le formulaire ne demande pas est dit à l'écran, et pas seulement absent du
        formulaire : une personne qui cherche où déclarer son rôle ou joindre un justificatif
        doit apprendre que ce n'est pas un oubli (ADR-016, docs/screens.md écran 11).
      */}
      <Alert tone="info" title={labels.notAskedTitle}>
        {labels.notAsked}
      </Alert>
    </>
  );
}

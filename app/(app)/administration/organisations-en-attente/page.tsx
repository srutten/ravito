import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentSession } from '@/authorization';
import { Alert } from '@/components/ui/alert';
import { ErrorState } from '@/components/ui/error-state';
import { PageHeader } from '@/components/ui/page-header';
import { isPlatformAdministrator } from '@/domain/organizations';
import { messages } from '@/i18n/fr';
import { PendingOrganizationsList } from './pending-organizations-list';

/**
 * Écran d'administration, premier élément : la file des organisations en attente
 * (`docs/screens.md`, écran 10 ; `docs/permissions.md`, « Valider une organisation »).
 *
 * L'ÉCRAN ENTIER EST REFUSÉ À QUI N'EST PAS ADMINISTRATEUR PLATEFORME, pas seulement la file.
 * `docs/screens.md` l'écrit ainsi : « masquer la file en laissant l'écran ouvert poserait la
 * question de ce que l'appelant peut encore y faire ». Le refus est rendu comme un état
 * d'écran, avec un titre de niveau 1, et non comme un encart au milieu d'un tableau de bord.
 *
 * CE CONTRÔLE N'EST PAS LA PROTECTION DES DONNÉES. La route
 * `GET /api/v1/admin/organizations/pending` refait le même contrôle, dans la transaction qui
 * lit, et c'est elle qu'un appel direct rencontre. Le contrôle d'ici évite d'ouvrir un écran
 * qui n'afficherait qu'un refus — et, accessoirement, d'apprendre à quiconque qu'une file
 * existe.
 *
 * LA FONCTION EST RELUE À CHAQUE REQUÊTE (ADR-021), avec ses conditions d'effectivité : une
 * adhésion `PLATFORM_ADMIN` suspendue, expirée ou portée par une organisation elle-même
 * suspendue ferme cet écran dès la navigation suivante, sans attendre l'expiration de la
 * session.
 */

export const dynamic = 'force-dynamic';

const SIGN_IN_PATH = '/connexion';

const labels = messages.ui.pendingOrganizations;

export const metadata: Metadata = {
  title: labels.pageTitle,
  description: labels.pageDescription,
};

export default async function OrganisationsEnAttentePage() {
  const session = await getCurrentSession();
  if (session === null) {
    redirect(SIGN_IN_PATH);
  }

  if (!(await isPlatformAdministrator(session.userId))) {
    return (
      <div data-testid="ecran-administration-refuse">
        <ErrorState variant="permissionDenied" titleLevel={1} />
      </div>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow={labels.eyebrow}
        title={labels.pageTitle}
        description={labels.pageDescription}
      />

      <PendingOrganizationsList />

      {/*
        La file existe avant la décision qu'elle prépare. Le dire évite qu'un administrateur
        cherche un bouton de validation qui n'est pas encore livré et conclue à une panne.
      */}
      <Alert tone="info" title={labels.noDecisionTitle}>
        {labels.noDecisionBody}
      </Alert>
    </>
  );
}

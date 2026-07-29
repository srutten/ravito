import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { isAppError } from '@/application/errors';
import { getCurrentSession } from '@/authorization';
import { Alert } from '@/components/ui/alert';
import { BulletList } from '@/components/ui/bullet-list';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import type {
  MembershipView,
  OrganizationStatus,
  OrganizationVerificationStatus,
  OrganizationView,
} from '@/domain/organizations';
import { isPlatformAdministrator, readOrganization } from '@/domain/organizations';
import { messages } from '@/i18n/fr';
import styles from './organization-detail.module.css';
import { OrganizationIdentityForm } from './organization-identity-form';

/**
 * Fiche d'une organisation.
 *
 * L'ÉTAT « EN ATTENTE » EST AFFICHÉ ET EXPLICITE. C'est un critère de SÉCURITÉ, pas de
 * confort : une personne qui vient de créer son organisation ne doit pas croire que cette
 * création lui a ouvert des droits. `docs/api-contract.md` le dit sans détour — une
 * organisation qui vient d'être créée est `ACTIVE` et `PENDING`, elle existe, son
 * administrateur peut la corriger, et elle ne peut RIEN publier tant que la validation n'a pas
 * eu lieu. L'écran distingue donc en toutes lettres ce qui est déjà possible de ce qui ne
 * l'est pas encore, plutôt que de le laisser deviner à une pastille de couleur — ce que la
 * section Accessibilité de `docs/screens.md` interdit par ailleurs.
 *
 * AUCUN DÉLAI DE TRAITEMENT N'EST AFFICHÉ. Aucune règle du produit n'en garantit un, et un
 * délai annoncé puis dépassé est pire qu'une absence de délai.
 *
 * `NOT_FOUND` MÈNE À LA PAGE INTROUVABLE, ET C'EST LA MÊME RÉPONSE POUR DEUX CAS : identifiant
 * qui ne désigne rien, et organisation que l'appelant n'a pas le droit de voir. C'est
 * exactement ce que fait la route de lecture, et pour la même raison — une page qui
 * distinguerait les deux ferait de l'interface l'oracle d'existence que l'API refuse d'être.
 *
 * LE FORMULAIRE DE MODIFICATION EST MASQUÉ À QUI NE PEUT PAS L'UTILISER, et ce masquage n'est
 * PAS un contrôle d'accès : la route `PATCH` refuse d'elle-même, dans la transaction qui
 * écrit. Le calcul ci-dessous est délibérément grossier — il ne rejoue pas la fenêtre de
 * validité de l'adhésion, dont la seule évaluation qui fasse foi est celle du serveur, sur son
 * horloge, dans sa transaction.
 */

export const dynamic = 'force-dynamic';

const SIGN_IN_PATH = '/connexion';

const labels = messages.ui.organizationDetail;
const vocabulary = messages.ui.organizations;

/**
 * Horodatages rendus côté serveur, dans un fuseau choisi et non dans celui de la machine qui
 * rend la page.
 */
const DATE_FORMAT = new Intl.DateTimeFormat('fr-FR', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'Europe/Paris',
});

const VERIFICATION_TONES: Readonly<Record<OrganizationVerificationStatus, StatusTone>> = {
  PENDING: 'warning',
  VERIFIED: 'success',
  REJECTED: 'danger',
};

const STATUS_TONES: Readonly<Record<OrganizationStatus, StatusTone>> = {
  ACTIVE: 'success',
  SUSPENDED: 'warning',
  CLOSED: 'neutral',
};

export const metadata: Metadata = {
  title: labels.eyebrow,
};

interface PageProps {
  readonly params: Promise<{ readonly organizationId: string }>;
}

function formatInstant(instant: Date): string {
  return DATE_FORMAT.format(instant);
}

/** Ligne d'une liste de définitions. Le libellé est toujours écrit, jamais sous-entendu. */
function DefinitionRow({
  term,
  children,
  testId,
}: {
  readonly term: string;
  readonly children: ReactNode;
  readonly testId?: string | undefined;
}) {
  return (
    <div className={styles.definitionRow}>
      <dt className={styles.term}>{term}</dt>
      <dd className={styles.value} {...(testId !== undefined ? { 'data-testid': testId } : {})}>
        {children}
      </dd>
    </div>
  );
}

/**
 * Bandeau d'état de validation.
 *
 * Il est rendu AVANT la fiche, pas après : l'information qui conditionne tout ce que la
 * personne peut faire ne se lit pas en bas d'écran.
 */
function VerificationNotice({ organization }: { readonly organization: OrganizationView }) {
  if (organization.verificationStatus === 'PENDING') {
    return (
      <div data-testid="bandeau-validation-en-attente">
        <Alert tone="warning" title={labels.pendingTitle}>
          <p>{labels.pendingBody}</p>
          <p className={styles.noticeSubtitle}>{labels.pendingAllowedTitle}</p>
          <BulletList items={[...labels.pendingAllowed]} />
          <p className={styles.noticeSubtitle}>{labels.pendingBlockedTitle}</p>
          <BulletList items={[...labels.pendingBlocked]} />
        </Alert>
      </div>
    );
  }
  if (organization.verificationStatus === 'REJECTED') {
    return (
      <div data-testid="bandeau-validation-refusee">
        <Alert tone="danger" title={labels.rejectedTitle}>
          {labels.rejectedBody}
        </Alert>
      </div>
    );
  }
  return (
    <div data-testid="bandeau-validation-acquise">
      <Alert tone="success" title={labels.verifiedTitle}>
        {labels.verifiedBody}
      </Alert>
    </div>
  );
}

function LifecycleNotice({ status }: { readonly status: OrganizationStatus }) {
  if (status === 'SUSPENDED') {
    return (
      <div data-testid="bandeau-fiche-suspendue">
        <Alert tone="danger" title={labels.suspendedTitle}>
          {labels.suspendedBody}
        </Alert>
      </div>
    );
  }
  if (status === 'CLOSED') {
    return (
      <div data-testid="bandeau-fiche-fermee">
        <Alert tone="warning" title={labels.closedTitle}>
          {labels.closedBody}
        </Alert>
      </div>
    );
  }
  return null;
}

function MembershipCard({ membership }: { readonly membership: MembershipView | null }) {
  if (membership === null) {
    return (
      <Card title={labels.membershipTitle} titleLevel={2}>
        <p className={styles.mutedText} data-testid="adhesion-absente">
          {labels.membershipNone}
        </p>
      </Card>
    );
  }
  return (
    <Card title={labels.membershipTitle} titleLevel={2}>
      <dl className={styles.definitions} data-testid="adhesion-appelant">
        <DefinitionRow term={labels.membershipRoleLabel} testId="adhesion-role">
          {vocabulary.roles[membership.role]}
        </DefinitionRow>
        <DefinitionRow term={labels.membershipStatusLabel} testId="adhesion-statut">
          {vocabulary.memberStatuses[membership.status]}
        </DefinitionRow>
        <DefinitionRow term={labels.membershipValidFromLabel}>
          <time dateTime={membership.validFrom.toISOString()}>
            {formatInstant(membership.validFrom)}
          </time>
        </DefinitionRow>
        {membership.validUntil !== null ? (
          <DefinitionRow term={labels.membershipValidUntilLabel}>
            <time dateTime={membership.validUntil.toISOString()}>
              {formatInstant(membership.validUntil)}
            </time>
          </DefinitionRow>
        ) : null}
      </dl>
    </Card>
  );
}

export default async function OrganisationPage({ params }: PageProps) {
  const session = await getCurrentSession();
  if (session === null) {
    redirect(SIGN_IN_PATH);
  }

  const { organizationId } = await params;

  let organization: OrganizationView;
  let membership: MembershipView | null;
  try {
    const result = await readOrganization({
      actorUserId: session.userId,
      organizationId,
    });
    organization = result.organization;
    membership = result.membership;
  } catch (error) {
    if (isAppError(error) && error.code === 'NOT_FOUND') {
      notFound();
    }
    throw error;
  }

  const isAdministrator = await isPlatformAdministrator(session.userId);
  const isOrganizationAdmin =
    membership !== null && membership.role === 'ORG_ADMIN' && membership.status === 'ACTIVE';
  const canEdit = organization.status === 'ACTIVE' && (isAdministrator || isOrganizationAdmin);
  const isMemberWithoutEdit = membership !== null && !isOrganizationAdmin && !isAdministrator;

  return (
    <>
      <PageHeader eyebrow={labels.eyebrow} title={organization.name} />

      <VerificationNotice organization={organization} />
      <LifecycleNotice status={organization.status} />

      <Card title={labels.stateTitle} titleLevel={2}>
        <div className={styles.badges}>
          {/*
            L'état est écrit en toutes lettres dans la pastille elle-même : le point coloré de
            `StatusBadge` est décoratif, et rien n'est porté par la seule couleur.
          */}
          <StatusBadge
            label={`${vocabulary.verificationStatusLabel} : ${vocabulary.verificationStatuses[organization.verificationStatus]}`}
            tone={VERIFICATION_TONES[organization.verificationStatus]}
          />
          <StatusBadge
            label={`${vocabulary.statusLabel} : ${vocabulary.statuses[organization.status]}`}
            tone={STATUS_TONES[organization.status]}
          />
        </div>
      </Card>

      <Card title={labels.identityTitle} titleLevel={2}>
        <dl className={styles.definitions} data-testid="identite-organisation">
          <DefinitionRow term={vocabulary.nameLabel} testId="organisation-nom">
            {organization.name}
          </DefinitionRow>
          <DefinitionRow term={vocabulary.typeLabel} testId="organisation-type">
            {vocabulary.types[organization.type]}
          </DefinitionRow>
          {/*
            Rendu TEL QU'IL A ÉTÉ SAISI, séparateurs compris : c'est sous cette forme qu'un
            administrateur le confronte à un registre public.
          */}
          <DefinitionRow
            term={vocabulary.registrationNumberLabel}
            testId="organisation-immatriculation"
          >
            {organization.registrationNumber}
          </DefinitionRow>
          <DefinitionRow term={vocabulary.territoryCodeLabel} testId="organisation-territoire">
            {organization.territoryCode ?? vocabulary.noTerritory}
          </DefinitionRow>
          <DefinitionRow term={vocabulary.createdAtLabel}>
            <time dateTime={organization.createdAt.toISOString()}>
              {formatInstant(organization.createdAt)}
            </time>
          </DefinitionRow>
          <DefinitionRow term={vocabulary.updatedAtLabel}>
            <time dateTime={organization.updatedAt.toISOString()}>
              {formatInstant(organization.updatedAt)}
            </time>
          </DefinitionRow>
          <DefinitionRow term={vocabulary.versionLabel} testId="organisation-version">
            {String(organization.version)}
          </DefinitionRow>
        </dl>
      </Card>

      <MembershipCard membership={membership} />

      {canEdit ? (
        <Card
          title={labels.editTitle}
          description={labels.editDescription}
          titleLevel={2}
          padding="large"
        >
          {/*
            LA CLÉ EST LA VERSION. Elle remonte le formulaire à chaque écriture aboutie et après
            un conflit de version : le champ `expectedVersion` désigne alors toujours l'état
            réellement affiché, et jamais celui d'un rendu précédent.
          */}
          <OrganizationIdentityForm
            key={organization.version}
            organizationId={organization.id}
            name={organization.name}
            type={organization.type}
            registrationNumber={organization.registrationNumber}
            territoryCode={organization.territoryCode}
            version={organization.version}
          />
        </Card>
      ) : null}

      {isMemberWithoutEdit ? (
        <p className={styles.mutedText} data-testid="modification-refusee">
          {labels.editForbidden}
        </p>
      ) : null}
    </>
  );
}

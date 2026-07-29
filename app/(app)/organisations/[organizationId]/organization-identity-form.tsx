'use client';

/*
 * COMPOSANT CLIENT.
 *
 * Trois besoins imposent le navigateur : l'état « action en cours » qui verrouille le bouton,
 * les messages rattachés aux champs, et le CONFLIT DE VERSION — état transverse exigé de tout
 * écran de modification par `docs/screens.md`, qui demande de recharger et d'afficher l'état
 * réel plutôt que de laisser croire qu'un tiers a écrasé quelque chose.
 *
 * `expectedVersion` VIENT DU SERVEUR ET N'EST JAMAIS RECALCULÉ ICI. Le composant est remonté à
 * chaque changement de version, par une clé posée sur lui dans la page : une version conservée
 * après un rechargement viserait un état que la fiche n'a plus, et la modification suivante
 * échouerait sans que rien à l'écran ne l'explique.
 *
 * CE COMPOSANT NE DÉCIDE RIEN. Il n'existe ici aucune règle d'autorisation : la route `PATCH`
 * refuse d'elle-même un appelant qui n'est pas administrateur de l'organisation, dont
 * l'adhésion n'est plus active, ou dont l'organisation n'est plus `ACTIVE`. Masquer ce
 * formulaire n'est pas un contrôle d'accès, c'est une politesse d'interface (CLAUDE.md).
 */

import { useRouter } from 'next/navigation';
import { type FormEvent, useCallback, useRef, useState } from 'react';
import { z } from 'zod';
import { Alert, type AlertTone } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DocumentIcon, InboxIcon, ShieldIcon } from '@/components/ui/icons';
import { SelectField } from '@/components/ui/select-field';
import { TextField } from '@/components/ui/text-field';
// `types` et non l'index du module : l'index exporte les commandes, donc le pilote PostgreSQL,
// qui n'a rien à faire dans le paquet du navigateur. Voir `create-organization-form.tsx`.
import type { OrganizationType } from '@/domain/organizations/types';
import { ORGANIZATION_TYPES } from '@/domain/organizations/types';
import { messages } from '@/i18n/fr';
import styles from './organization-detail.module.css';

const ORGANIZATIONS_API_PREFIX = '/api/v1/organizations/';
const SIGN_IN_PATH = '/connexion';

const NAME_FIELD_ID = 'organisation-modification-nom';
const TYPE_FIELD_ID = 'organisation-modification-type';
const REGISTRATION_FIELD_ID = 'organisation-modification-immatriculation';
const TERRITORY_FIELD_ID = 'organisation-modification-territoire';

const labels = messages.ui.organizationDetail;
const createLabels = messages.ui.createOrganization;
const vocabulary = messages.ui.organizations;

/** Bornes et formes de `docs/api-contract.md`. Contrôles de confort : le serveur tranche. */
const REGISTRATION_NUMBER_PATTERN = /^[0-9A-Za-z][0-9A-Za-z ./-]*[0-9A-Za-z]$/;
const TERRITORY_CODE_PATTERN = /^[0-9A-Z][0-9A-Z-]{0,15}$/;
const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 160;
const REGISTRATION_MIN_LENGTH = 4;
const REGISTRATION_MAX_LENGTH = 64;
const TERRITORY_MAX_LENGTH = 16;

const updateResponseSchema = z.object({
  verificationReset: z.boolean(),
});

const failureResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

type FieldName = 'name' | 'type' | 'registrationNumber' | 'territoryCode';
type FieldErrors = Partial<Record<FieldName, string>>;

interface Notice {
  readonly tone: AlertTone;
  readonly title: string;
  readonly body: string;
}

export interface OrganizationIdentityFormProps {
  readonly organizationId: string;
  readonly name: string;
  readonly type: OrganizationType;
  readonly registrationNumber: string;
  readonly territoryCode: string | null;
  readonly version: number;
}

const TYPE_OPTIONS = ORGANIZATION_TYPES.map((value) => ({
  value,
  label: vocabulary.typeChoices[value],
}));

export function OrganizationIdentityForm({
  organizationId,
  name: initialName,
  type: initialType,
  registrationNumber: initialRegistrationNumber,
  territoryCode: initialTerritoryCode,
  version,
}: OrganizationIdentityFormProps) {
  const router = useRouter();

  const [name, setName] = useState(initialName);
  const [type, setType] = useState<string>(initialType);
  const [registrationNumber, setRegistrationNumber] = useState(initialRegistrationNumber);
  const [territoryCode, setTerritoryCode] = useState(initialTerritoryCode ?? '');

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const typeSelectRef = useRef<HTMLSelectElement>(null);
  const registrationInputRef = useRef<HTMLInputElement>(null);
  const territoryInputRef = useRef<HTMLInputElement>(null);

  const focusField = useCallback((field: FieldName): void => {
    if (field === 'name') {
      nameInputRef.current?.focus();
      return;
    }
    if (field === 'type') {
      typeSelectRef.current?.focus();
      return;
    }
    if (field === 'registrationNumber') {
      registrationInputRef.current?.focus();
      return;
    }
    territoryInputRef.current?.focus();
  }, []);

  /**
   * Corps de la requête : les SEULS champs modifiés.
   *
   * LA PRÉSENCE D'UNE CLÉ VAUT DEMANDE, y compris à `null`. C'est ainsi qu'un périmètre
   * territorial se RETIRE : vider le champ envoie `territoryCode: null`, tandis qu'un champ
   * inchangé n'est pas envoyé du tout. Envoyer systématiquement les quatre champs ferait
   * retomber la vérification d'une organisation validée au premier enregistrement, même si rien
   * n'avait changé — le serveur ne compare pas les valeurs, il applique ce qu'on lui demande.
   */
  const buildChanges = useCallback((): Record<string, unknown> | null => {
    const changes: Record<string, unknown> = {};
    const trimmedName = name.trim();
    if (trimmedName !== initialName) {
      changes.name = trimmedName;
    }
    if (type !== initialType) {
      changes.type = type;
    }
    const trimmedRegistration = registrationNumber.trim();
    if (trimmedRegistration !== initialRegistrationNumber) {
      changes.registrationNumber = trimmedRegistration;
    }
    const trimmedTerritory = territoryCode.trim();
    const currentTerritory = initialTerritoryCode ?? '';
    if (trimmedTerritory !== currentTerritory) {
      changes.territoryCode = trimmedTerritory.length === 0 ? null : trimmedTerritory;
    }
    return Object.keys(changes).length === 0 ? null : changes;
  }, [
    initialName,
    initialRegistrationNumber,
    initialTerritoryCode,
    initialType,
    name,
    registrationNumber,
    territoryCode,
    type,
  ]);

  const collectLocalErrors = useCallback((): FieldErrors => {
    const errors: FieldErrors = {};
    const trimmedName = name.trim();
    if (trimmedName.length < NAME_MIN_LENGTH || trimmedName.length > NAME_MAX_LENGTH) {
      errors.name = createLabels.fieldErrors.name;
    }
    if (type === '') {
      errors.type = createLabels.fieldErrors.type;
    }
    const trimmedRegistration = registrationNumber.trim();
    if (
      trimmedRegistration.length < REGISTRATION_MIN_LENGTH ||
      trimmedRegistration.length > REGISTRATION_MAX_LENGTH ||
      !REGISTRATION_NUMBER_PATTERN.test(trimmedRegistration)
    ) {
      errors.registrationNumber = createLabels.fieldErrors.registrationNumber;
    }
    const trimmedTerritory = territoryCode.trim();
    if (
      trimmedTerritory.length > 0 &&
      (trimmedTerritory.length > TERRITORY_MAX_LENGTH ||
        !TERRITORY_CODE_PATTERN.test(trimmedTerritory))
    ) {
      errors.territoryCode = createLabels.fieldErrors.territoryCode;
    }
    return errors;
  }, [name, registrationNumber, territoryCode, type]);

  const submit = useCallback(
    async (changes: Record<string, unknown>): Promise<void> => {
      setIsBusy(true);
      setNotice(null);
      setFieldErrors({});

      let response: Response;
      try {
        response = await fetch(`${ORGANIZATIONS_API_PREFIX}${organizationId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...changes, expectedVersion: version }),
          credentials: 'same-origin',
          cache: 'no-store',
        });
      } catch {
        setIsBusy(false);
        setNotice({
          tone: 'warning',
          title: messages.ui.states.networkUnavailable,
          body: messages.ui.states.retry,
        });
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      setIsBusy(false);

      if (!response.ok) {
        const parsed = failureResponseSchema.safeParse(payload);
        if (!parsed.success) {
          setNotice({
            tone: 'danger',
            title: messages.ui.states.error,
            body: messages.ui.states.retry,
          });
          return;
        }
        const { code, message, details } = parsed.data.error;

        if (code === 'UNAUTHENTICATED') {
          router.replace(SIGN_IN_PATH);
          return;
        }

        if (code === 'VERSION_CONFLICT') {
          // L'écran recharge et affiche l'état réel, comme l'exige docs/screens.md. Le
          // rechargement remonte ce composant avec la version courante : la personne retrouve
          // la fiche telle qu'elle est, puis recommence sa modification en connaissance de
          // cause. Rien n'a été écrit.
          setNotice({
            tone: 'warning',
            title: labels.versionConflictTitle,
            body: labels.versionConflictBody,
          });
          router.refresh();
          return;
        }

        if (code === 'VALIDATION_ERROR') {
          const rawFields = details?.fields;
          const fields = Array.isArray(rawFields)
            ? rawFields.filter((field): field is string => typeof field === 'string')
            : [];
          const errors: FieldErrors = {};
          if (fields.includes('name')) {
            errors.name = createLabels.fieldErrors.name;
          }
          if (fields.includes('type')) {
            errors.type = createLabels.fieldErrors.type;
          }
          if (fields.includes('registrationNumber')) {
            errors.registrationNumber = createLabels.fieldErrors.registrationNumber;
          }
          if (fields.includes('territoryCode')) {
            errors.territoryCode = createLabels.fieldErrors.territoryCode;
          }
          setFieldErrors(errors);
          const first: FieldName | undefined = (
            ['name', 'type', 'registrationNumber', 'territoryCode'] as const
          ).find((field) => errors[field] !== undefined);
          if (first !== undefined) {
            focusField(first);
            return;
          }
          setNotice({
            tone: 'danger',
            title: createLabels.failureTitle,
            body: createLabels.fieldErrors.root,
          });
          return;
        }

        // `FORBIDDEN`, `NOT_FOUND`, `PLATFORM_READ_ONLY`, `RATE_LIMITED` : le libellé du
        // serveur est déjà neutre et français, il est affiché tel quel plutôt que remplacé par
        // un échec générique qui n'apprendrait rien.
        setNotice({ tone: 'danger', title: createLabels.failureTitle, body: message });
        return;
      }

      const parsed = updateResponseSchema.safeParse(payload);
      const verificationReset = parsed.success && parsed.data.verificationReset;
      setNotice(
        verificationReset
          ? {
              tone: 'warning',
              title: labels.editVerificationResetTitle,
              body: labels.editVerificationResetBody,
            }
          : { tone: 'success', title: labels.editSuccessTitle, body: labels.editSuccessBody },
      );
      // La fiche est rendue par le serveur : c'est lui qui affiche l'état réel après écriture,
      // et non un état reconstitué côté navigateur à partir de ce qu'on croit avoir envoyé.
      router.refresh();
    },
    [focusField, organizationId, router, version],
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (isBusy) {
      return;
    }
    const localErrors = collectLocalErrors();
    if (Object.keys(localErrors).length > 0) {
      setFieldErrors(localErrors);
      const first: FieldName | undefined = (
        ['name', 'type', 'registrationNumber', 'territoryCode'] as const
      ).find((field) => localErrors[field] !== undefined);
      if (first !== undefined) {
        focusField(first);
      }
      return;
    }
    const changes = buildChanges();
    if (changes === null) {
      // Une requête sans effet qui répondrait « enregistré » laisserait croire à une
      // modification appliquée. Le serveur la refuse aussi ; le dire ici évite l'aller-retour.
      setNotice({
        tone: 'info',
        title: labels.editTitle,
        body: labels.editNoChange,
      });
      return;
    }
    void submit(changes);
  }

  return (
    <form
      className={styles.form}
      onSubmit={handleSubmit}
      method="post"
      noValidate
      aria-label={labels.editFormLabel}
      data-testid="formulaire-modification-organisation"
    >
      {notice !== null ? (
        <div data-testid="message-modification-organisation">
          <Alert tone={notice.tone} title={notice.title} live>
            {notice.body}
          </Alert>
        </div>
      ) : null}

      <TextField
        id={NAME_FIELD_ID}
        name="name"
        label={vocabulary.nameLabel}
        value={name}
        onChange={setName}
        {...(fieldErrors.name !== undefined ? { error: fieldErrors.name } : {})}
        maxLength={NAME_MAX_LENGTH}
        required
        disabled={isBusy}
        inputRef={nameInputRef}
        icon={<InboxIcon width={22} height={22} />}
        testId="champ-modification-nom"
      />

      <SelectField
        id={TYPE_FIELD_ID}
        name="type"
        label={vocabulary.typeLabel}
        value={type}
        onChange={setType}
        options={TYPE_OPTIONS}
        placeholder={createLabels.typePlaceholder}
        {...(fieldErrors.type !== undefined ? { error: fieldErrors.type } : {})}
        required
        disabled={isBusy}
        selectRef={typeSelectRef}
        icon={<ShieldIcon width={22} height={22} />}
        testId="champ-modification-type"
      />

      <TextField
        id={REGISTRATION_FIELD_ID}
        name="registrationNumber"
        label={vocabulary.registrationNumberLabel}
        value={registrationNumber}
        onChange={setRegistrationNumber}
        {...(fieldErrors.registrationNumber !== undefined
          ? { error: fieldErrors.registrationNumber }
          : {})}
        maxLength={REGISTRATION_MAX_LENGTH}
        required
        disabled={isBusy}
        inputRef={registrationInputRef}
        icon={<DocumentIcon width={22} height={22} />}
        testId="champ-modification-immatriculation"
      />

      <TextField
        id={TERRITORY_FIELD_ID}
        name="territoryCode"
        label={vocabulary.territoryCodeLabel}
        value={territoryCode}
        onChange={setTerritoryCode}
        hint={createLabels.territoryCodeHint}
        {...(fieldErrors.territoryCode !== undefined ? { error: fieldErrors.territoryCode } : {})}
        maxLength={TERRITORY_MAX_LENGTH}
        disabled={isBusy}
        inputRef={territoryInputRef}
        icon={<ShieldIcon width={22} height={22} />}
        testId="champ-modification-code-territorial"
      />

      <div data-testid="action-modifier-organisation">
        <Button type="submit" variant="primary" fullWidth busy={isBusy} disabled={isBusy}>
          {isBusy ? labels.editSubmitBusy : labels.editSubmit}
        </Button>
      </div>
    </form>
  );
}

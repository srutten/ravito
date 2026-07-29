'use client';

/*
 * COMPOSANT CLIENT, ET IL DOIT L'ÊTRE.
 *
 * Quatre besoins imposent le navigateur, et aucun ne se règle côté serveur.
 *
 * 1. LA CLÉ D'IDEMPOTENCE. `docs/screens.md`, écran 11 : « l'identifiant d'idempotence est tiré
 *    au premier affichage du formulaire, une fois, et conservé tant que la saisie dure ». Tirée
 *    côté serveur, elle changerait à chaque rendu, et deux soumissions de la même intention
 *    porteraient deux clés — c'est-à-dire deux organisations jumelles, dont l'une resterait dans
 *    la file de validation sans que personne sache laquelle fait foi.
 * 2. L'ÉTAT « ACTION EN COURS ». Le bouton se verrouille pendant l'appel, pour que le double
 *    appui soit impossible AVANT même que l'idempotence ait à jouer.
 * 3. LES MESSAGES RATTACHÉS AUX CHAMPS. Le serveur renvoie les champs fautifs ; il faut les
 *    replacer sur les champs concernés et y ramener le focus.
 * 4. L'ÉTAT « RÉSEAU INDISPONIBLE ». Il se mesure au moment de l'appel, et la saisie doit
 *    survivre à l'échec, clé d'idempotence comprise.
 *
 * CE COMPOSANT NE DÉCIDE RIEN. Les contrôles locaux ci-dessous sont de CONFORT : ils évitent un
 * aller-retour pour une faute évidente. Le verdict qui fait foi est celui du serveur, qui
 * revalide la saisie entière, refuse les clés inconnues et tranche l'unicité du numéro par une
 * contrainte de base. Aucune règle métier ne vit ici, et aucun champ d'état — ni rôle, ni
 * `verificationStatus`, ni `version` — n'est envoyé : ils sont posés par le serveur (ADR-016).
 */

import { useRouter } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Alert, type AlertTone } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DocumentIcon, InboxIcon, ShieldIcon } from '@/components/ui/icons';
import { SelectField } from '@/components/ui/select-field';
import { TextField } from '@/components/ui/text-field';
// LE VOCABULAIRE FERMÉ VIENT DE `types`, PAS DE L'INDEX DU MODULE, et l'écart n'est pas
// cosmétique : l'index exporte les commandes, qui atteignent le pilote PostgreSQL et
// `node:async_hooks`. Importé depuis un composant client, il ferait entrer tout le domaine dans
// le paquet du navigateur — le rendant au mieux inconstructible, au pire porteur de code serveur.
// `types.ts` ne contient que des constantes et des types.
import { ORGANIZATION_TYPES } from '@/domain/organizations/types';
import { messages } from '@/i18n/fr';
import styles from './create-organization-form.module.css';

const CREATE_PATH = '/api/v1/organizations';
const SIGN_IN_PATH = '/connexion';
const ORGANIZATION_PATH_PREFIX = '/organisations/';

const NAME_FIELD_ID = 'organisation-nom';
const TYPE_FIELD_ID = 'organisation-type';
const REGISTRATION_FIELD_ID = 'organisation-immatriculation';
const TERRITORY_FIELD_ID = 'organisation-territoire';

const labels = messages.ui.createOrganization;
const vocabulary = messages.ui.organizations;

/**
 * Bornes et formes recopiées de `docs/api-contract.md` et des contraintes de
 * `0015_organizations.sql`. Elles ne remplacent PAS la validation serveur : elles lui évitent
 * un aller-retour. Le jour où les deux divergeraient, c'est le serveur qui a raison — et une
 * règle locale plus stricte que la sienne refuserait une saisie qu'il accepte, ce qui est le
 * sens sûr pour un contrôle de confort.
 */
const REGISTRATION_NUMBER_PATTERN = /^[0-9A-Za-z][0-9A-Za-z ./-]*[0-9A-Za-z]$/;
const TERRITORY_CODE_PATTERN = /^[0-9A-Z][0-9A-Z-]{0,15}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 160;
const REGISTRATION_MIN_LENGTH = 4;
const REGISTRATION_MAX_LENGTH = 64;
const TERRITORY_MAX_LENGTH = 16;

/**
 * La réponse de l'API est validée avant usage, comme toute entrée externe. Le serveur est de
 * confiance, la couche de transport ne l'est pas : un intermédiaire, une page d'erreur de
 * mandataire ou un décalage de version produiraient une forme inattendue, et une redirection
 * serait alors construite sur un identifiant qui n'en est pas un.
 */
const createResponseSchema = z.object({
  organization: z.object({ id: z.string().regex(UUID_PATTERN) }),
});

const failureResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

type PostOutcome =
  | { readonly kind: 'SUCCESS'; readonly payload: unknown }
  | {
      readonly kind: 'FAILURE';
      readonly code: string;
      readonly message: string;
      readonly details: Record<string, unknown>;
    }
  /** Le réseau n'a pas répondu : l'appel n'a jamais atteint le serveur. */
  | { readonly kind: 'OFFLINE' }
  /** Une réponse est arrivée mais elle est inexploitable. */
  | { readonly kind: 'UNREADABLE' };

type FieldName = 'name' | 'type' | 'registrationNumber' | 'territoryCode';
type FieldErrors = Partial<Record<FieldName, string>>;

interface Notice {
  readonly tone: AlertTone;
  readonly title: string;
  readonly body: string;
}

/**
 * Clé d'idempotence.
 *
 * `crypto.randomUUID` n'existe que dans un contexte sécurisé : sur un téléphone qui atteint un
 * poste de développement par son adresse de réseau local, en clair, il est absent. Le repli
 * tire les mêmes 122 bits d'aléa par `getRandomValues`, disponible partout, et compose un UUID
 * de version 4 conforme — le schéma serveur n'accepte rien d'autre.
 */
function createClientEventId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

async function postJson(path: string, body: unknown): Promise<PostOutcome> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      // `application/json` est exigé par le contrat et bloque au passage la soumission d'un
      // formulaire inter-site, qui ne sait produire que trois autres types de contenu.
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return { kind: 'OFFLINE' };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { kind: 'UNREADABLE' };
  }

  if (response.ok) {
    return { kind: 'SUCCESS', payload };
  }
  const parsed = failureResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return { kind: 'UNREADABLE' };
  }
  return {
    kind: 'FAILURE',
    code: parsed.data.error.code,
    message: parsed.data.error.message,
    details: parsed.data.error.details ?? {},
  };
}

function readFailedFields(details: Record<string, unknown>): readonly string[] {
  const fields = details.fields;
  if (!Array.isArray(fields)) {
    return [];
  }
  return fields.filter((field): field is string => typeof field === 'string');
}

const TYPE_OPTIONS = ORGANIZATION_TYPES.map((value) => ({
  value,
  label: vocabulary.typeChoices[value],
}));

export function CreateOrganizationForm() {
  const router = useRouter();

  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [registrationNumber, setRegistrationNumber] = useState('');
  const [territoryCode, setTerritoryCode] = useState('');

  /**
   * TIRÉE UNE FOIS, PAR L'INITIALISEUR PARESSEUX DE `useState`, et non par un effet : un effet
   * s'exécute APRÈS le premier rendu, ce qui laisserait une fenêtre où le formulaire est
   * affiché sans clé. Elle survit à toutes les erreurs de validation — l'intention est la même
   * — et n'est renouvelée qu'après une création aboutie, sans quoi la personne ne pourrait pas
   * créer une deuxième organisation.
   */
  const [clientEventId, setClientEventId] = useState(() => createClientEventId());

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isDone, setIsDone] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const typeSelectRef = useRef<HTMLSelectElement>(null);
  const registrationInputRef = useRef<HTMLInputElement>(null);
  const territoryInputRef = useRef<HTMLInputElement>(null);

  /**
   * VERROU JUSQU'À L'HYDRATATION. Entre l'affichage du formulaire et le moment où React reprend
   * la main, `onSubmit` n'existe pas encore : une touche Entrée déclencherait la soumission
   * NATIVE. La spécification HTML est explicite — si le bouton par défaut d'un formulaire est
   * désactivé, la soumission implicite n'a pas lieu. `method="post"` reste en filet : même
   * soumise nativement, la saisie ne partirait pas dans l'URL, donc ni dans l'historique, ni
   * dans les journaux d'accès, ni dans l'en-tête `Referer` des requêtes suivantes.
   */
  useEffect(() => {
    setIsHydrated(true);
  }, []);

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
   * Contrôles locaux de CONFORT, dans l'ordre du formulaire. Ils collectent toutes les fautes
   * en une passe, comme le fait le serveur : un formulaire qui n'en signale qu'une à la fois se
   * corrige en autant d'allers-retours qu'il compte d'erreurs.
   */
  const collectLocalErrors = useCallback((): FieldErrors => {
    const errors: FieldErrors = {};
    const trimmedName = name.trim();
    if (trimmedName.length < NAME_MIN_LENGTH || trimmedName.length > NAME_MAX_LENGTH) {
      errors.name = labels.fieldErrors.name;
    }
    if (type === '') {
      errors.type = labels.fieldErrors.type;
    }
    const trimmedRegistration = registrationNumber.trim();
    if (
      trimmedRegistration.length < REGISTRATION_MIN_LENGTH ||
      trimmedRegistration.length > REGISTRATION_MAX_LENGTH ||
      !REGISTRATION_NUMBER_PATTERN.test(trimmedRegistration)
    ) {
      errors.registrationNumber = labels.fieldErrors.registrationNumber;
    }
    const trimmedTerritory = territoryCode.trim();
    if (
      trimmedTerritory.length > 0 &&
      (trimmedTerritory.length > TERRITORY_MAX_LENGTH ||
        !TERRITORY_CODE_PATTERN.test(trimmedTerritory))
    ) {
      errors.territoryCode = labels.fieldErrors.territoryCode;
    }
    return errors;
  }, [name, type, registrationNumber, territoryCode]);

  const applyFailure = useCallback(
    (outcome: PostOutcome): void => {
      if (outcome.kind === 'OFFLINE') {
        // La saisie et la clé d'idempotence sont conservées : une reprise portera la même clé et
        // ne créera qu'une organisation, même si la première tentative avait en réalité abouti.
        setNotice({
          tone: 'warning',
          title: messages.ui.states.networkUnavailable,
          body: messages.ui.states.retry,
        });
        return;
      }
      if (outcome.kind === 'UNREADABLE') {
        setNotice({ tone: 'danger', title: labels.failureTitle, body: messages.ui.states.error });
        return;
      }
      if (outcome.kind !== 'FAILURE') {
        return;
      }

      if (outcome.code === 'VALIDATION_ERROR') {
        const fields = readFailedFields(outcome.details);
        const errors: FieldErrors = {};
        if (fields.includes('name')) {
          errors.name = labels.fieldErrors.name;
        }
        if (fields.includes('type')) {
          errors.type = labels.fieldErrors.type;
        }
        if (fields.includes('registrationNumber')) {
          // MÊME MESSAGE POUR UNE FORME INVALIDE ET POUR UN DOUBLON, parce que le serveur renvoie
          // le même code sur le même champ dans les deux cas. Distinguer ici rétablirait côté
          // navigateur l'oracle d'énumération que le serveur refuse d'ouvrir : il suffirait
          // d'essayer des numéros pour savoir lesquels sont déjà enregistrés.
          errors.registrationNumber = labels.fieldErrors.registrationNumber;
        }
        if (fields.includes('territoryCode')) {
          errors.territoryCode = labels.fieldErrors.territoryCode;
        }
        setFieldErrors(errors);
        if (Object.keys(errors).length === 0) {
          const body = fields.includes('clientEventId')
            ? labels.fieldErrors.clientEventId
            : labels.fieldErrors.root;
          setNotice({ tone: 'danger', title: labels.failureTitle, body });
          return;
        }
        const first: FieldName | undefined = (
          ['name', 'type', 'registrationNumber', 'territoryCode'] as const
        ).find((field) => errors[field] !== undefined);
        if (first !== undefined) {
          focusField(first);
        }
        return;
      }

      // Session perdue en cours de saisie : l'écran de connexion prend la main, comme l'exige
      // docs/screens.md. La saisie est perdue, et c'est le moindre mal — la conserver
      // supposerait de l'écrire quelque part hors de la session qui l'a autorisée.
      if (outcome.code === 'UNAUTHENTICATED') {
        router.replace(SIGN_IN_PATH);
        return;
      }

      // `PLATFORM_READ_ONLY` et `RATE_LIMITED` sont affichés TELS QUELS : docs/screens.md exige
      // que le mode lecture seule soit dit, et non travesti en échec générique. Le catalogue de
      // messages du serveur porte déjà des libellés français neutres.
      setNotice({ tone: 'danger', title: labels.failureTitle, body: outcome.message });
    },
    [focusField, router],
  );

  const submit = useCallback(async (): Promise<void> => {
    setIsBusy(true);
    setNotice(null);
    setFieldErrors({});

    const outcome = await postJson(CREATE_PATH, {
      name: name.trim(),
      type,
      registrationNumber: registrationNumber.trim(),
      // ABSENT plutôt que vide lorsque aucun périmètre n'est déclaré : le contrat traite
      // l'absence comme « aucun périmètre », et une chaîne vide serait une valeur invalide.
      ...(territoryCode.trim().length > 0 ? { territoryCode: territoryCode.trim() } : {}),
      clientEventId,
    });

    if (outcome.kind !== 'SUCCESS') {
      setIsBusy(false);
      applyFailure(outcome);
      return;
    }

    const parsed = createResponseSchema.safeParse(outcome.payload);
    if (!parsed.success) {
      setIsBusy(false);
      applyFailure({ kind: 'UNREADABLE' });
      return;
    }

    // Le verrou reste posé : la navigation est engagée, plus aucune action ne doit partir.
    setIsDone(true);
    setNotice({ tone: 'success', title: labels.successTitle, body: labels.successBody });
    // Nouvelle clé : sans cela, une seconde création depuis le même écran rejouerait la
    // première et renverrait l'organisation déjà créée.
    setClientEventId(createClientEventId());
    router.replace(`${ORGANIZATION_PATH_PREFIX}${parsed.data.organization.id}`);
  }, [applyFailure, clientEventId, name, registrationNumber, router, territoryCode, type]);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (isBusy || isDone) {
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
    void submit();
  }

  const isLocked = isBusy || isDone || !isHydrated;

  return (
    <form
      className={styles.form}
      onSubmit={handleSubmit}
      method="post"
      // La validation native est désactivée : ses bulles ne sont ni traduisibles, ni associées
      // aux messages de champ décrits par docs/screens.md.
      noValidate
      aria-label={labels.formLabel}
      data-testid="formulaire-creation-organisation"
    >
      {notice !== null ? (
        <div data-testid="message-creation-organisation">
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
        placeholder={labels.namePlaceholder}
        hint={labels.nameHint}
        {...(fieldErrors.name !== undefined ? { error: fieldErrors.name } : {})}
        maxLength={NAME_MAX_LENGTH}
        required
        disabled={isBusy || isDone}
        inputRef={nameInputRef}
        icon={<InboxIcon width={22} height={22} />}
        testId="champ-nom-organisation"
      />

      <SelectField
        id={TYPE_FIELD_ID}
        name="type"
        label={vocabulary.typeLabel}
        value={type}
        onChange={setType}
        options={TYPE_OPTIONS}
        placeholder={labels.typePlaceholder}
        hint={labels.typeHint}
        {...(fieldErrors.type !== undefined ? { error: fieldErrors.type } : {})}
        required
        disabled={isBusy || isDone}
        selectRef={typeSelectRef}
        icon={<ShieldIcon width={22} height={22} />}
        testId="champ-type-organisation"
      />

      <TextField
        id={REGISTRATION_FIELD_ID}
        name="registrationNumber"
        label={vocabulary.registrationNumberLabel}
        value={registrationNumber}
        onChange={setRegistrationNumber}
        placeholder={labels.registrationNumberPlaceholder}
        hint={labels.registrationNumberHint}
        {...(fieldErrors.registrationNumber !== undefined
          ? { error: fieldErrors.registrationNumber }
          : {})}
        maxLength={REGISTRATION_MAX_LENGTH}
        required
        disabled={isBusy || isDone}
        inputRef={registrationInputRef}
        icon={<DocumentIcon width={22} height={22} />}
        testId="champ-immatriculation"
      />

      <TextField
        id={TERRITORY_FIELD_ID}
        name="territoryCode"
        label={vocabulary.territoryCodeLabel}
        value={territoryCode}
        // AUCUNE CONVERSION DE CASSE AUTOMATIQUE : le serveur refuse « zz-demo-01 » plutôt que
        // de le réécrire, parce qu'il inscrit cette valeur dans le journal d'audit et qu'une
        // majuscule posée à l'insu de l'appelant rendrait deux saisies indiscernables dans la
        // preuve. L'écran ne peut donc pas être plus tolérant que lui sans mentir.
        onChange={setTerritoryCode}
        placeholder={labels.territoryCodePlaceholder}
        hint={labels.territoryCodeHint}
        {...(fieldErrors.territoryCode !== undefined ? { error: fieldErrors.territoryCode } : {})}
        maxLength={TERRITORY_MAX_LENGTH}
        disabled={isBusy || isDone}
        inputRef={territoryInputRef}
        icon={<ShieldIcon width={22} height={22} />}
        testId="champ-code-territorial"
      />

      <div data-testid="action-creer-organisation">
        <Button type="submit" variant="primary" fullWidth busy={isBusy} disabled={isLocked}>
          {isBusy ? labels.submitBusy : labels.submit}
        </Button>
      </div>
    </form>
  );
}

import { z } from 'zod';
import { AppError } from '@/application/errors';
import { denyOrganizationAccess } from '@/authorization/organization-access';
import type { OrganizationType } from '@/domain/organizations/types';
import { ORGANIZATION_TYPES } from '@/domain/organizations/types';
import { clientEventIdSchema, expectedVersionSchema, uuidSchema } from '@/validation/common';

/**
 * Validation des entrées du module organisations.
 *
 * TROIS PROPRIÉTÉS, ET CHACUNE RÉPOND À UN DÉFAUT PRÉCIS.
 *
 * 1. LES BORNES SONT CELLES DU SCHÉMA, recopiées depuis `0015_organizations.sql`. Toute
 *    contrainte SQL non doublée ici remonterait sous forme de `23514`, converti en
 *    `INTERNAL_ERROR` par l'enveloppe, c'est-à-dire un 500 pour une faute de saisie. La
 *    plus facile à oublier est la longueur de la forme NORMALISÉE du numéro
 *    d'immatriculation : « 1.2/3 » fait cinq caractères bruts et deux normalisés, il
 *    passe la borne visible et échoue sur l'invisible. LA RÈGLE EST PLUS LARGE QUE LES
 *    CONTRAINTES : elle porte sur tout ce que la base refuse, y compris ce qu'aucune
 *    contrainte n'exprime — l'octet nul, que l'encodage `UTF8` rejette avant tout `CHECK`
 *    (`NUL_CHARACTER` ci-dessous).
 * 2. TOUTES LES FAUTES SONT COLLECTÉES avant de lever, comme le fait `src/config/env.ts`
 *    pour la configuration. Un formulaire qui ne signale qu'un champ à la fois se corrige
 *    en autant d'allers-retours qu'il compte d'erreurs.
 * 3. AUCUNE VALEUR REÇUE NE RESSORT. `details.fields` ne porte que des noms de champs, et
 *    seulement ceux du contrat : un nom de clé inventé par l'appelant n'est jamais
 *    renvoyé tel quel, faute de quoi la réponse d'erreur deviendrait un miroir de texte
 *    arbitraire.
 *
 * CE QUI N'EST PAS ACCEPTÉ EN ENTRÉE, et l'omission est le contrôle lui-même :
 * `verificationStatus`, `status`, `version`, `id` et le rôle du créateur. Ils sont posés
 * par le serveur (ADR-016). Une clé inconnue est REFUSÉE plutôt qu'ignorée — un client qui
 * enverrait `"verificationStatus": "VERIFIED"` et recevrait `201` croirait avoir été
 * entendu, et c'est précisément l'usurpation d'organisation de `docs/threat-model.md` qui
 * se glisserait dans cette croyance.
 */

/** Champs modifiables par `PATCH`, dans l'ordre du contrat. */
const MUTABLE_FIELDS = ['name', 'type', 'registrationNumber', 'territoryCode'] as const;
type MutableField = (typeof MUTABLE_FIELDS)[number];

/**
 * Champs dont la modification annule la vérification (`docs/api-contract.md`).
 * `territoryCode` en est volontairement exclu : il décrit un périmètre d'action, pas une
 * identité, et le soumettre à revalidation dissuaderait de le corriger.
 */
const IDENTITY_FIELDS: readonly MutableField[] = ['name', 'type', 'registrationNumber'];

const CREATE_FIELDS = [...MUTABLE_FIELDS, 'clientEventId'] as const;
const UPDATE_FIELDS = [...MUTABLE_FIELDS, 'expectedVersion'] as const;

/** Nom de champ sûr à renvoyer : borné, sans ponctuation, donc sans réflexion possible. */
const SAFE_FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const UNKNOWN_FIELD_LABEL = '(inconnu)';

/**
 * Forme brute du numéro, recopiée de `organizations_registration_number_shape`.
 *
 * Ce n'est PAS un format de SIRET, et ce n'est pas un oubli : une association n'a pas
 * toujours de numéro à quatorze chiffres, une collectivité étrangère n'est pas inscrite au
 * même registre, et le préfixe `FICTIF-` du jeu de démonstration doit rester acceptable
 * (`docs/privacy-rgpd.md`, `docs/test-plan.md` : aucune donnée réelle en test).
 */
const REGISTRATION_NUMBER_PATTERN = /^[0-9A-Za-z][0-9A-Za-z ./-]*[0-9A-Za-z]$/;

/** Forme du code de territoire, recopiée de `organizations_territory_code_format`. */
const TERRITORY_CODE_PATTERN = /^[0-9A-Z][0-9A-Z-]{0,15}$/;

const MIN_NORMALIZED_REGISTRATION_LENGTH = 4;

/**
 * Caractère que PostgreSQL ne sait stocker dans AUCUNE colonne textuelle.
 *
 * Ce n'est pas une borne recopiée du schéma, et c'est pourquoi il est déclaré à part : l'octet
 * nul est refusé par l'ENCODAGE lui-même — le pilote rend `22021 invalid byte sequence for
 * encoding "UTF8": 0x00`, avant même qu'une contrainte `CHECK` ait la parole. Aucune migration ne
 * peut donc l'autoriser, et aucune évolution du schéma ne rendra ce refus caduc.
 *
 * Un corps portant un nom qui contient cet octet est du JSON parfaitement valide : la saisie est
 * ORDINAIRE, elle n'a rien d'une attaque, et sans ce refus elle traversait la validation pour
 * échouer à l'écriture, c'est-à-dire un 500 rendu à une faute de frappe. C'est exactement
 * l'inverse du premier invariant du module.
 *
 * SEUL `name` EN A BESOIN. `REGISTRATION_NUMBER_PATTERN` et `TERRITORY_CODE_PATTERN` énumèrent
 * les caractères admis, si bien que l'octet nul y est déjà écarté par la forme ; `name` ne porte
 * aucune expression régulière, et ne doit pas en porter — un nom d'organisation s'écrit dans
 * toutes les langues, ponctuation comprise.
 */
const NUL_CHARACTER = '\u0000';

/**
 * Ce que porte `organizationId` au journal lorsque l'identifiant reçu n'en est pas un.
 *
 * VALEUR CONSTANTE, JAMAIS LA VALEUR REÇUE. Recopier le segment de chemin ferait du journal
 * d'exploitation un miroir de texte arbitraire, de longueur non bornée et choisie par
 * l'appelant — la faute même que `src/application/api-route.ts` refuse sur `x-request-id`.
 * Le marqueur est reconnaissable d'un coup d'œil, ne peut désigner aucune organisation réelle,
 * et regroupe de lui-même les balayages mal formés en une seule ligne de tableau de bord.
 */
const MALFORMED_ORGANIZATION_ID = '(non conforme)';

/** Bornes recopiées de `0015_organizations.sql`, comptées comme la base les compte. */
const NAME_MIN_CHARACTERS = 2;
const NAME_MAX_CHARACTERS = 160;
const REGISTRATION_MIN_CHARACTERS = 4;
const REGISTRATION_MAX_CHARACTERS = 64;
const TERRITORY_MIN_CHARACTERS = 1;
const TERRITORY_MAX_CHARACTERS = 16;

/**
 * Longueur en CARACTÈRES, au sens de `char_length` de PostgreSQL.
 *
 * POURQUOI PAS `.min()` ET `.max()` DE ZOD. Ils comptent des unités UTF-16 : un caractère
 * hors du plan multilingue de base — n'importe quel émoji, une lettre mathématique — y vaut
 * DEUX, quand `char_length` en compte UN. Un nom d'un seul émoji passait donc `min(2)` et
 * violait `organizations_name_length` : une saisie ordinaire produisait un 500, et la ligne
 * refusée partait tout entière dans les journaux d'exploitation par le champ `detail` de
 * l'erreur du pilote, numéro d'immatriculation compris.
 *
 * LA PROPRIÉTÉ RÉTABLIE, et c'est elle qu'il faut préserver plutôt que ces trois appels :
 * ce que la validation accepte, la base l'accepte. Une contrainte SQL ne doit jamais être
 * la première à refuser une saisie.
 */
function characterLength(value: string): number {
  // L'itérateur de chaîne parcourt les POINTS DE CODE : une paire de substituts compte pour
  // un, exactement comme `char_length`.
  return [...value].length;
}

/**
 * Forme normalisée du numéro d'immatriculation.
 *
 * ATTENTION : cette fonction ne sert QU'À VALIDER une longueur. La valeur stockée est
 * calculée par la colonne générée de `0015_organizations.sql`, jamais par l'application.
 * Le jour où les deux divergeraient, c'est la base qui aurait raison — mais la validation
 * refuserait alors une saisie que la base accepte, ce qui est le sens sûr. Normaliser ici
 * pour ÉCRIRE serait l'erreur : deux chemins d'écriture normaliseraient tôt ou tard
 * différemment, et l'unicité ne porterait plus sur la même chose selon l'origine.
 */
function normalizeRegistrationNumber(value: string): string {
  return value.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

const nameSchema = z
  .string({ message: "Nom d'organisation attendu." })
  .trim()
  // Refusé AVANT les bornes, parce que ce refus n'est pas de la même nature qu'elles : les
  // bornes recopient une contrainte du schéma, celui-ci recopie une limite de l'encodage, que
  // `.trim()` ne retire pas et qu'aucune longueur ne rattrape.
  .refine((value) => !value.includes(NUL_CHARACTER), {
    message: "Nom d'organisation porteur d'un caractère interdit.",
  })
  .refine((value) => characterLength(value) >= NAME_MIN_CHARACTERS, {
    message: "Nom d'organisation trop court.",
  })
  .refine((value) => characterLength(value) <= NAME_MAX_CHARACTERS, {
    message: "Nom d'organisation trop long.",
  });

const typeSchema = z.enum(ORGANIZATION_TYPES, { message: "Nature d'organisation non reconnue." });

/**
 * Numéro d'immatriculation.
 *
 * Le comptage en caractères y est REDONDANT AUJOURD'HUI, et c'est délibéré : la classe
 * autorisée par `REGISTRATION_NUMBER_PATTERN` est purement ASCII, si bien que les deux
 * unités de mesure y coïncident. Cette coïncidence tient à l'expression régulière, pas à la
 * borne ; le jour où elle s'ouvrira aux lettres accentuées — l'en-tête du motif annonce
 * qu'une collectivité étrangère n'est pas inscrite au même registre — l'écart réapparaîtrait
 * en silence. La borne est donc exprimée dans l'unité de la contrainte SQL, une fois pour
 * toutes.
 */
const registrationNumberSchema = z
  .string({ message: "Numéro d'immatriculation attendu." })
  .trim()
  .refine((value) => characterLength(value) >= REGISTRATION_MIN_CHARACTERS, {
    message: "Numéro d'immatriculation trop court.",
  })
  .refine((value) => characterLength(value) <= REGISTRATION_MAX_CHARACTERS, {
    message: "Numéro d'immatriculation trop long.",
  })
  .regex(REGISTRATION_NUMBER_PATTERN, {
    message: "Numéro d'immatriculation de forme invalide.",
  })
  .refine(
    (value) => normalizeRegistrationNumber(value).length >= MIN_NORMALIZED_REGISTRATION_LENGTH,
    { message: "Numéro d'immatriculation trop court une fois les séparateurs retirés." },
  );

/**
 * Code de territoire, en majuscules. Aucune conversion de casse n'est appliquée : le
 * serveur ne réécrit pas en silence une valeur qu'il réaffichera et qu'il inscrira dans
 * `before`/`after` du journal d'audit. Un refus explicite dit ce qui est attendu ; une
 * majuscule posée à l'insu de l'appelant rend « zz-01 » et « ZZ-01 » indiscernables dans
 * la preuve.
 */
const territoryCodeSchema = z
  .string({ message: 'Code de territoire attendu.' })
  .trim()
  .refine((value) => characterLength(value) >= TERRITORY_MIN_CHARACTERS, {
    message: 'Code de territoire vide.',
  })
  .refine((value) => characterLength(value) <= TERRITORY_MAX_CHARACTERS, {
    message: 'Code de territoire trop long.',
  })
  .regex(TERRITORY_CODE_PATTERN, {
    message: 'Code de territoire de forme invalide : majuscules, chiffres et tirets.',
  });

/** Corps de requête : un objet JSON, ni tableau, ni valeur simple. */
const payloadSchema = z.record(z.string(), z.unknown(), {
  message: 'Corps de requête JSON attendu.',
});

export interface CanonicalCreateOrganization {
  readonly name: string;
  readonly type: OrganizationType;
  readonly registrationNumber: string;
  readonly territoryCode: string | null;
  readonly clientEventId: string;
}

export interface CanonicalOrganizationChanges {
  readonly name?: string;
  readonly type?: OrganizationType;
  readonly registrationNumber?: string;
  /** Présent lorsque le retrait ou le changement est demandé ; `null` retire le périmètre. */
  readonly territoryCode?: string | null;
}

export interface CanonicalUpdateOrganization {
  readonly expectedVersion: number;
  readonly changes: CanonicalOrganizationChanges;
  /** Vrai lorsqu'au moins un champ d'identité change, donc que la vérification retombe. */
  readonly touchesIdentity: boolean;
}

/** Collecteur de fautes : une seule réponse énumère tous les champs à corriger. */
class FieldCollector {
  private readonly fields = new Set<string>();

  reject(field: string): void {
    this.fields.add(SAFE_FIELD_NAME_PATTERN.test(field) ? field : UNKNOWN_FIELD_LABEL);
  }

  /** Valide une valeur, ou retient le champ. Renvoie `undefined` en cas d'échec. */
  parse<T>(field: string, schema: z.ZodType<T>, value: unknown): T | undefined {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      this.reject(field);
      return undefined;
    }
    return parsed.data;
  }

  assertEmpty(): void {
    if (this.fields.size > 0) {
      throw new AppError('VALIDATION_ERROR', { details: { fields: [...this.fields].sort() } });
    }
  }
}

function readPayloadObject(payload: unknown, collector: FieldCollector): Record<string, unknown> {
  if (Array.isArray(payload)) {
    collector.reject('(racine)');
    collector.assertEmpty();
  }
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    collector.reject('(racine)');
    collector.assertEmpty();
  }
  return parsed.success ? parsed.data : {};
}

function rejectUnknownFields(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  collector: FieldCollector,
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      collector.reject(key);
    }
  }
}

/**
 * Identifiant d'organisation issu du chemin.
 *
 * Validé comme n'importe quelle entrée externe : un segment de chemin est fourni par
 * l'appelant au même titre qu'un champ de corps. Sans cette validation, une valeur non
 * conforme atteindrait le pilote PostgreSQL et produirait un `22P02` converti en 500,
 * là où la réponse juste est `404` — l'objet n'existe pas.
 *
 * CE REFUS ÉCRIT SON MOTIF, comme tous les autres refus d'accès à une organisation. Il ne le
 * faisait pas, et l'omission était mesurable : un balayage mené avec des identifiants qui ne
 * sont pas des UUID ne produisait AUCUNE ligne, quand le même balayage en UUID bien formés en
 * produisait une par tentative. La métrique « refus d'autorisation » de `docs/observability.md`
 * sous-comptait donc par construction, et l'alerte était aveugle au balayage le moins coûteux à
 * mener — celui qui n'a même pas besoin de tirer des UUID valides.
 *
 * LE MOTIF EST `ORGANIZATION_ABSENT`, et c'est exact plutôt que commode : un segment qui n'est
 * pas un UUID ne désigne aucune organisation, ce que le vocabulaire de
 * `src/authorization/organization-access.ts` énonce mot pour mot. Les deux cas restent
 * séparables au tableau de bord par la valeur d'`organizationId`, qui vaut ici un marqueur
 * constant. Un motif distinct — `ORGANIZATION_ID_MALFORMED` — serait plus fin ; il suppose
 * d'ouvrir le vocabulaire, ce qui relève du module d'autorisation et non d'ici.
 */
export function parseOrganizationId(raw: unknown): string {
  const parsed = uuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw denyOrganizationAccess(MALFORMED_ORGANIZATION_ID, 'ORGANIZATION_ABSENT', 'NOT_FOUND');
  }
  return parsed.data;
}

/** Corps d'une création d'organisation. `clientEventId` est obligatoire. */
export function parseCreateOrganizationPayload(payload: unknown): CanonicalCreateOrganization {
  const collector = new FieldCollector();
  const raw = readPayloadObject(payload, collector);
  rejectUnknownFields(raw, CREATE_FIELDS, collector);

  const name = collector.parse('name', nameSchema, raw.name);
  const type = collector.parse('type', typeSchema, raw.type);
  const registrationNumber = collector.parse(
    'registrationNumber',
    registrationNumberSchema,
    raw.registrationNumber,
  );
  // Facultatif : absent ou `null` signifient tous deux « aucun périmètre déclaré », cas
  // d'une organisation nationale (`0015_organizations.sql`).
  const territoryProvided =
    Object.hasOwn(raw, 'territoryCode') && raw.territoryCode !== null && raw.territoryCode !== '';
  const territoryCode = territoryProvided
    ? collector.parse('territoryCode', territoryCodeSchema, raw.territoryCode)
    : null;
  const clientEventId = collector.parse('clientEventId', clientEventIdSchema, raw.clientEventId);

  collector.assertEmpty();
  if (
    name === undefined ||
    type === undefined ||
    registrationNumber === undefined ||
    clientEventId === undefined ||
    territoryCode === undefined
  ) {
    // Inatteignable : `assertEmpty` a déjà levé. La garde existe pour le typage, et pour
    // qu'un remaniement qui casserait l'invariant échoue bruyamment plutôt que d'écrire
    // `undefined` en base.
    throw new AppError('VALIDATION_ERROR', { details: { fields: ['(racine)'] } });
  }

  return { name, type, registrationNumber, territoryCode, clientEventId };
}

/**
 * Corps d'une modification.
 *
 * LA PRÉSENCE DE LA CLÉ VAUT DEMANDE, y compris à `null`. C'est la seule façon d'exprimer
 * le retrait d'un `territoryCode` : `undefined` et « absent » se confondent une fois passés
 * par un type TypeScript, `null` et « absent » non.
 *
 * `expectedVersion` est OBLIGATOIRE, et un corps qui ne porterait que lui est refusé : une
 * requête sans effet qui répondrait `200` laisserait croire à une modification appliquée.
 *
 * ÉCART CONNU, hérité et signalé plutôt que corrigé en silence : `expectedVersionSchema`
 * accepte zéro, alors que la première version d'une organisation est un (ADR-019). Un
 * `expectedVersion` à zéro est donc syntaxiquement valide et sémantiquement impossible ; il
 * produit `VERSION_CONFLICT` et jamais `VALIDATION_ERROR`. Le schéma est partagé par des
 * agrégats dont la première version n'est pas encore arbitrée.
 */
export function parseUpdateOrganizationPayload(payload: unknown): CanonicalUpdateOrganization {
  const collector = new FieldCollector();
  const raw = readPayloadObject(payload, collector);
  rejectUnknownFields(raw, UPDATE_FIELDS, collector);

  const expectedVersion = collector.parse(
    'expectedVersion',
    expectedVersionSchema,
    raw.expectedVersion,
  );

  let changes: CanonicalOrganizationChanges = {};
  let present = 0;

  if (Object.hasOwn(raw, 'name')) {
    present += 1;
    const value = collector.parse('name', nameSchema, raw.name);
    if (value !== undefined) {
      changes = { ...changes, name: value };
    }
  }
  if (Object.hasOwn(raw, 'type')) {
    present += 1;
    const value = collector.parse('type', typeSchema, raw.type);
    if (value !== undefined) {
      changes = { ...changes, type: value };
    }
  }
  if (Object.hasOwn(raw, 'registrationNumber')) {
    present += 1;
    const value = collector.parse(
      'registrationNumber',
      registrationNumberSchema,
      raw.registrationNumber,
    );
    if (value !== undefined) {
      changes = { ...changes, registrationNumber: value };
    }
  }
  if (Object.hasOwn(raw, 'territoryCode')) {
    present += 1;
    if (raw.territoryCode === null) {
      changes = { ...changes, territoryCode: null };
    } else {
      const value = collector.parse('territoryCode', territoryCodeSchema, raw.territoryCode);
      if (value !== undefined) {
        changes = { ...changes, territoryCode: value };
      }
    }
  }

  if (present === 0) {
    collector.reject('(racine)');
  }

  collector.assertEmpty();
  if (expectedVersion === undefined) {
    throw new AppError('VALIDATION_ERROR', { details: { fields: ['expectedVersion'] } });
  }

  const touchesIdentity = IDENTITY_FIELDS.some((field) => Object.hasOwn(changes, field));
  return { expectedVersion, changes, touchesIdentity };
}

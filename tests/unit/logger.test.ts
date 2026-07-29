import { Writable } from 'node:stream';
import { DatabaseError } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfigCache } from '@/config/env';
import { createLogger, getRequestLogger, logger } from '@/observability/logger';
import type { RequestContext } from '@/observability/request-context';
import { pseudonymizeUserId, runWithRequestContext } from '@/observability/request-context';

/**
 * Journalisation (docs/observability.md, US-001 critère 11).
 *
 * Deux exigences opposées cohabitent : la ligne de journal doit porter de quoi diagnostiquer une
 * panne, et ne jamais porter de quoi compromettre une personne. Le test négatif de rédaction est
 * le plus important de ce fichier.
 */

const VALID_DATABASE_URL = 'postgresql://utilisateur:motdepasse-fictif@localhost:5432/appui_feux';
const FIXED_INSTANT = new Date('2026-07-27T10:20:30.000Z');

/** Destination en mémoire : aucune écriture sur la sortie standard, aucune dépendance réseau. */
class MemoryDestination extends Writable {
  private readonly chunks: string[] = [];

  override _write(chunk: unknown, _encoding: string, callback: () => void): void {
    this.chunks.push(String(chunk));
    callback();
  }

  get raw(): string {
    return this.chunks.join('');
  }

  get lines(): Record<string, unknown>[] {
    return this.raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  /** Première ligne écrite. Échoue explicitement si rien n'a été journalisé. */
  get firstLine(): Record<string, unknown> {
    const [line] = this.lines;
    if (line === undefined) {
      throw new Error('aucune ligne de journal produite');
    }
    return line;
  }
}

/**
 * Valeurs sentinelles. Aucune n'est réelle : ce sont des marqueurs conçus pour être recherchés
 * dans la sortie du journal. Aucune ne doit y figurer.
 */
const SENTINELS = {
  password: 'sentinelle-mot-de-passe-Z9X8',
  motDePasse: 'sentinelle-mot-de-passe-francais-C7V6',
  token: 'sentinelle-jeton-B5N4',
  accessToken: 'sentinelle-jeton-acces-M3L2',
  authorization: 'sentinelle-autorisation-K1J0',
  cookie: 'sentinelle-cookie-H9G8',
  setCookie: 'sentinelle-cookie-pose-F7D6',
  preciseLocation: 'sentinelle-position-precise-S5A4',
  exactLocation: 'sentinelle-position-exacte-Q3W2',
  phone: 'sentinelle-telephone-E1R0',
  contactPhone: 'sentinelle-telephone-contact-T9Y8',
  storageKey: 'sentinelle-cle-stockage-U7I6',
  storageSecretKey: 'sentinelle-cle-secrete-stockage-O5P4',
  incidentDescription: 'sentinelle-description-incident-A3S2',
  documents: 'sentinelle-document-D1F0',
  secret: 'sentinelle-secret-G9H8',
} as const;

function sensitivePayload(): Record<string, unknown> {
  return {
    // Champs légitimes, qui doivent survivre.
    requestId: 'req_11111111-2222-4333-8444-555555555555',
    route: '/api/v1/missions/:id',
    // Champs interdits, à plat.
    password: SENTINELS.password,
    token: SENTINELS.token,
    authorization: `Bearer ${SENTINELS.authorization}`,
    cookie: `session=${SENTINELS.cookie}`,
    preciseLocation: { latitude: SENTINELS.preciseLocation, longitude: 'sentinelle-longitude' },
    phone: SENTINELS.phone,
    storageKey: SENTINELS.storageKey,
    // Champs interdits, imbriqués et sous des écritures différentes.
    req: {
      headers: {
        authorization: `Bearer ${SENTINELS.authorization}`,
        cookie: `session=${SENTINELS.cookie}`,
        'set-cookie': SENTINELS.setCookie,
      },
    },
    utilisateur: {
      motDePasse: SENTINELS.motDePasse,
      contactPhone: SENTINELS.contactPhone,
      profil: { exact_location: SENTINELS.exactLocation, ACCESS_TOKEN: SENTINELS.accessToken },
    },
    documents: [{ storageKey: SENTINELS.documents }],
    incident: { incidentDescription: SENTINELS.incidentDescription },
    configuration: { storageSecretKey: SENTINELS.storageSecretKey, secret: SENTINELS.secret },
  };
}

/**
 * Sentinelles de l'erreur du pilote PostgreSQL. Elles sont placées dans les champs LIBRES de
 * l'erreur, ceux que le serveur remplit avec le contenu de la ligne refusée. Aucune ne doit
 * survivre à la sérialisation, quel que soit le champ qui la porte.
 */
const DRIVER_SENTINELS = {
  detail: 'SENTINELLE-LIGNE-4F2A9C',
  hint: 'SENTINELLE-CONSEIL-6A9F0B',
  where: 'SENTINELLE-CONTEXTE-8B1D7E',
  internalQuery: 'SENTINELLE-REQUETE-2E5C3F',
  message: 'SENTINELLE-MESSAGE-1C8E4D',
  future: 'SENTINELLE-CHAMP-FUTUR-3D7B2A',
} as const;

/**
 * Erreur du pilote, construite avec LA CLASSE DU PILOTE et remplie exactement comme le fait
 * son analyseur de protocole (`pg-protocol`, `parseErrorMessage`).
 *
 * POURQUOI PAS UNE DOUBLURE MAISON. Ce qui fait fuir cette erreur n'est pas sa forme
 * apparente mais le fait que ses dix-huit champs soient des propriétés PROPRES et
 * ÉNUMÉRABLES, donc recopiées par tout sérialiseur. Une doublure écrite à la main pourrait
 * oublier ce détail, et le test passerait alors sans rien éprouver. Les valeurs reprennent
 * une violation réelle de `organizations_name_length` relevée sur le conteneur de
 * développement, `detail` compris — c'est bien la ligne entière que PostgreSQL y met.
 */
function driverFailure(): DatabaseError {
  const failure = new DatabaseError(
    `new row for relation "organizations" violates check constraint "organizations_name_length" ${DRIVER_SENTINELS.message}`,
    421,
    'error',
  );
  failure.severity = 'ERROR';
  failure.code = '23514';
  failure.detail = `Failing row contains (f10ce8dd-b935-4741-ad57-5e08be5617c1, A, FARM, ${DRIVER_SENTINELS.detail}, SENTINELLELIGNE4F2A9C, null, PENDING, ACTIVE, 1).`;
  failure.hint = DRIVER_SENTINELS.hint;
  failure.where = `PL/pgSQL function ${DRIVER_SENTINELS.where}`;
  failure.internalQuery = `insert into public.organizations values ('${DRIVER_SENTINELS.internalQuery}')`;
  failure.position = '42';
  failure.schema = 'public';
  failure.table = 'organizations';
  failure.column = 'name';
  failure.dataType = 'text';
  failure.constraint = 'organizations_name_length';
  failure.file = 'execMain.c';
  failure.line = '2034';
  failure.routine = 'ExecConstraints';
  return failure;
}

/**
 * Copie d'une erreur du pilote dans un OBJET SIMPLE, telle qu'un intermédiaire — pooler,
 * couche de relais, sérialisation entre processus — la produit. Elle n'est pas une `Error`,
 * mais `pino-std-serializers` la traite comme telle dès qu'elle porte un `message` : posée en
 * cause, elle est fondue dans le texte exactement comme la vraie.
 */
function relayedDriverFailure(
  severity: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    code: '23505',
    severity,
    message: `duplicate key value violates unique constraint ${DRIVER_SENTINELS.message}`,
    detail: `Key (registration_number_normalized)=(${DRIVER_SENTINELS.detail}) already exists.`,
    where: `PL/pgSQL function ${DRIVER_SENTINELS.where}`,
    ...extra,
  };
}

/** Objet journalisé sous la clé `err`. Échoue explicitement plutôt que de rendre vide. */
function errorFieldOf(line: Record<string, unknown>): Record<string, unknown> {
  const serialized = line.err;
  if (typeof serialized !== 'object' || serialized === null || Array.isArray(serialized)) {
    throw new Error('la ligne de journal ne porte aucun objet sous la cle err');
  }
  return serialized as Record<string, unknown>;
}

/** Objet imbriqué d'une ligne de journal. Échoue explicitement plutôt que de rendre vide. */
function nestedObjectOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`la ligne de journal ne porte aucun objet sous ${label}`);
  }
  return value as Record<string, unknown>;
}

/** Vérifie qu'aucune sentinelle de champ libre du pilote ne figure dans la sortie. */
function expectNoDriverSentinel(output: string, où: string): void {
  for (const [field, sentinel] of Object.entries(DRIVER_SENTINELS)) {
    if (field === 'future') {
      continue;
    }
    expect(output, `le champ ${field} ${où} a fuité dans le journal`).not.toContain(sentinel);
  }
}

describe('createLogger', () => {
  const initialEnvironment = { ...process.env };
  let destination: MemoryDestination;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_INSTANT);
    resetServerConfigCache();
    process.env.APP_ENV = 'staging';
    process.env.APP_VERSION = '1.2.3-test';
    process.env.LOG_LEVEL = 'trace';
    process.env.DATABASE_URL = VALID_DATABASE_URL;
    process.env.AUTH_SECRET = 'secret-de-test-fictif-de-plus-de-32-caracteres';
    destination = new MemoryDestination();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetServerConfigCache();
    for (const key of Object.keys(process.env)) {
      if (!(key in initialEnvironment)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, initialEnvironment);
  });

  it('porte les champs obligatoires de docs/observability.md', () => {
    const testLogger = createLogger({ destination });

    testLogger.info(
      {
        requestId: 'req_11111111-2222-4333-8444-555555555555',
        route: '/api/v1/requests/:id',
        method: 'POST',
        userId: pseudonymizeUserId('utilisateur-fictif-001'),
        organizationId: 'org-fictive-001',
        errorCode: 'VERSION_CONFLICT',
        durationMs: 42,
        status: 409,
      },
      'requête refusée',
    );

    const line = destination.firstLine;
    expect(line.level).toBe('info');
    expect(line.time).toBe(FIXED_INSTANT.toISOString());
    expect(line.service).toBe('fire-support-platform');
    expect(line.environment).toBe('staging');
    expect(line.version).toBe('1.2.3-test');
    expect(line.route).toBe('/api/v1/requests/:id');
    expect(line.method).toBe('POST');
    expect(line.requestId).toBe('req_11111111-2222-4333-8444-555555555555');
    expect(line.organizationId).toBe('org-fictive-001');
    expect(line.errorCode).toBe('VERSION_CONFLICT');
    expect(line.durationMs).toBe(42);
    expect(line.msg).toBe('requête refusée');
  });

  it('journalise le niveau en toutes lettres et l horodatage en ISO 8601 UTC', () => {
    const testLogger = createLogger({ destination });

    testLogger.error({ errorCode: 'INTERNAL_ERROR' }, 'panne');

    const line = destination.firstLine;
    expect(line.level).toBe('error');
    expect(String(line.time)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('ne journalise aucune valeur sensible, à plat comme en profondeur', () => {
    const testLogger = createLogger({ destination });

    testLogger.info(sensitivePayload(), 'requête traitée');

    const output = destination.raw;
    for (const [name, sentinel] of Object.entries(SENTINELS)) {
      expect(output, `la valeur du champ ${name} a fuité dans le journal`).not.toContain(sentinel);
    }
    expect(output).toContain('[REDACTED]');
    // Les champs de diagnostic, eux, restent lisibles.
    expect(output).toContain('req_11111111-2222-4333-8444-555555555555');
    expect(output).toContain('/api/v1/missions/:id');
  });

  it('rédige aussi les champs sensibles portés par une exception', () => {
    const testLogger = createLogger({ destination });
    const failure: Error & { accessToken?: string; contactPhone?: string } = new Error(
      'échec de rafraîchissement de session',
    );
    failure.accessToken = SENTINELS.accessToken;
    failure.contactPhone = SENTINELS.contactPhone;

    testLogger.error({ err: failure, errorCode: 'INTERNAL_ERROR' }, 'erreur non identifiée');

    const output = destination.raw;
    expect(output).not.toContain(SENTINELS.accessToken);
    expect(output).not.toContain(SENTINELS.contactPhone);
    expect(output).toContain('échec de rafraîchissement de session');
  });

  it('rédige un champ sensible enfoui sous plusieurs niveaux et dans un tableau', () => {
    const testLogger = createLogger({ destination });

    testLogger.info(
      {
        niveau1: {
          niveau2: {
            niveau3: [{ niveau4: { password: SENTINELS.password, phone: SENTINELS.phone } }],
          },
        },
      },
      'structure profonde',
    );

    const output = destination.raw;
    expect(output).not.toContain(SENTINELS.password);
    expect(output).not.toContain(SENTINELS.phone);
    expect(output).toContain('[REDACTED]');
  });

  it('n écrit aucun champ libre d une erreur du pilote PostgreSQL', () => {
    // LE DÉFAUT QUE CE TEST FERME. Une erreur du pilote non reconnue au plus près de
    // l'écriture remonte jusqu'à `toErrorBody`, qui la journalise sous `err` au niveau
    // `error`. Le champ `detail` vaut alors « Failing row contains (...) » : la ligne
    // entière, numéro d'immatriculation compris. La rédaction par nom de clé ne pouvait rien
    // y faire — la fuite est dans le CONTENU d'une chaîne libre, pas dans un nom de champ.
    const testLogger = createLogger({ destination });

    testLogger.error(
      { err: driverFailure(), errorCode: 'INTERNAL_ERROR' },
      'erreur non identifiée convertie en erreur interne',
    );

    const output = destination.raw;
    for (const [field, sentinel] of Object.entries(DRIVER_SENTINELS)) {
      if (field === 'future') {
        continue;
      }
      expect(output, `le champ ${field} de l erreur du pilote a fuité`).not.toContain(sentinel);
    }
    // Le test doit voir ce qu'il prétend surveiller : sans cette ligne, une clé `err`
    // absente rendrait toutes les recherches ci-dessus vraies pour la mauvaise raison.
    expect(output).toContain('erreur non identifiée convertie en erreur interne');
  });

  it('conserve les champs de diagnostic, et eux seuls', () => {
    // L'ÉPURATION N'EST PAS UNE SUPPRESSION. Sans code, contrainte, table ni routine, une
    // panne de base devient indiagnosticable et le correctif se paie en heures d'exploitation.
    const testLogger = createLogger({ destination });

    testLogger.error({ err: driverFailure() }, 'écriture refusée par la base');

    const serialized = errorFieldOf(destination.firstLine);
    expect(serialized.code).toBe('23514');
    expect(serialized.severity).toBe('ERROR');
    expect(serialized.constraint).toBe('organizations_name_length');
    expect(serialized.schema).toBe('public');
    expect(serialized.table).toBe('organizations');
    expect(serialized.column).toBe('name');
    expect(serialized.dataType).toBe('text');
    expect(serialized.routine).toBe('ExecConstraints');
    expect(serialized.file).toBe('execMain.c');
    expect(serialized.line).toBe('2034');

    // Les champs porteurs de valeurs ont disparu, y compris le message et la pile — dont la
    // première ligne EST le message du serveur.
    for (const field of ['detail', 'hint', 'where', 'internalQuery', 'position', 'stack']) {
      expect(serialized[field], `le champ ${field} aurait du etre ecarte`).toBeUndefined();
    }
    expect(serialized.type).toBe('PostgresError');
    expect(String(serialized.message)).toContain('champs porteurs de valeurs écartés');
  });

  it('écarte un champ que le pilote ajouterait à sa prochaine version', () => {
    // C'EST LA DIFFÉRENCE ENTRE UNE LISTE D'AUTORISATION ET UNE LISTE D'EXCLUSION, et donc
    // le seul test que la seconde ne passerait pas : ce champ n'existe dans aucune version
    // du pilote, personne n'aurait pu penser à l'interdire, et il ne doit pas ressortir.
    const testLogger = createLogger({ destination });
    const failure = Object.assign(driverFailure(), {
      rowSnapshot: DRIVER_SENTINELS.future,
    });

    testLogger.error({ err: failure }, 'écriture refusée par la base');

    expect(destination.raw).not.toContain(DRIVER_SENTINELS.future);
    expect(errorFieldOf(destination.firstLine).rowSnapshot).toBeUndefined();
  });

  it('épure aussi une erreur du pilote posée sous une clé quelconque', () => {
    // Le sérialiseur d'erreur ne regarde que `err` et `error`. Une erreur du pilote jointe à
    // un objet de contexte, ou imbriquée dans une exception applicative, échapperait à lui
    // seul : l'épuration est donc appliquée par la rédaction récursive, à toute profondeur.
    const testLogger = createLogger({ destination });

    testLogger.warn(
      { module: 'organizations', contexte: { tentative: 2, cause: driverFailure() } },
      'écriture rejouée',
    );

    const output = destination.raw;
    expect(output).not.toContain(DRIVER_SENTINELS.detail);
    expect(output).not.toContain(DRIVER_SENTINELS.internalQuery);
    // La ligne reste exploitable : le contexte légitime et le diagnostic survivent.
    expect(output).toContain('"tentative":2');
    expect(output).toContain('organizations_name_length');
  });

  it('épure une erreur du pilote posée en CAUSE, dans le message comme dans la pile', () => {
    // LE DÉFAUT QUE CE TEST FERME. `pino.stdSerializers.err` n'écarte pas la chaîne de
    // causes : il l'APLATIT EN TEXTE, dans `message` (« a: b ») et dans `stack`
    // (« ... caused by: ... »), et il retire ensuite la clé `cause` de la recopie structurée.
    // La rédaction récursive ne voyait donc plus que deux chaînes libres, où la ligne refusée
    // par la base figurait DEUX FOIS. Or `cause` est la façon standard d'imbriquer une
    // exception : la convention de `postgres-errors.ts` — ne jamais l'attacher — n'engageait
    // qu'un module, et `auth-route.ts` en attache déjà.
    const testLogger = createLogger({ destination });
    const applicative = new Error('echec applicatif de creation d organisation', {
      cause: driverFailure(),
    });

    testLogger.error({ err: applicative, errorCode: 'INTERNAL_ERROR' }, 'message fixe');

    expectNoDriverSentinel(destination.raw, 'de la cause');
    const serialized = errorFieldOf(destination.firstLine);
    // Le message de l'exception applicative n'a PAS absorbé celui du serveur, et la pile ne
    // porte plus de section « caused by ».
    expect(serialized.message).toBe('echec applicatif de creation d organisation');
    // La pile est bien celle de l'exception, et non une chaîne vide qui rendrait la ligne
    // suivante vraie sans rien éprouver.
    expect(String(serialized.stack)).toContain('echec applicatif de creation d organisation');
    expect(String(serialized.stack)).not.toContain('caused by');
    // La cause reste exploitable, mais épurée : c'est la contrepartie de la fermeture.
    const cause = nestedObjectOf(serialized.cause, 'err.cause');
    expect(cause.type).toBe('PostgresError');
    expect(cause.code).toBe('23514');
    expect(cause.constraint).toBe('organizations_name_length');
    for (const field of ['detail', 'hint', 'where', 'internalQuery', 'stack']) {
      expect(cause[field], `le champ ${field} de la cause aurait du etre ecarte`).toBeUndefined();
    }
  });

  it('épure une erreur du pilote enfouie au fond d une chaîne de causes', () => {
    // La correction ne doit pas valoir pour la seule profondeur 1 : chaque maillon redescend
    // dans la même épuration, sinon il suffirait d'une exception intermédiaire pour rouvrir
    // le canal.
    const testLogger = createLogger({ destination });
    const profond = new Error('niveau 1', {
      cause: new Error('niveau 2', {
        cause: new Error('niveau 3', { cause: driverFailure() }),
      }),
    });

    testLogger.error({ err: profond }, 'message fixe');

    expectNoDriverSentinel(destination.raw, 'de la cause profonde');
    const premier = nestedObjectOf(errorFieldOf(destination.firstLine).cause, 'err.cause');
    const deuxieme = nestedObjectOf(premier.cause, 'err.cause.cause');
    const troisieme = nestedObjectOf(deuxieme.cause, 'err.cause.cause.cause');
    expect(premier.message).toBe('niveau 2');
    expect(deuxieme.message).toBe('niveau 3');
    expect(troisieme.type).toBe('PostgresError');
  });

  it('épure une cause qui n est pas une instance d Error', () => {
    // `pino-std-serializers` fond dans le texte TOUT objet portant un `message` de type
    // chaîne, pas seulement les `Error`. Une erreur du pilote recopiée dans un objet simple
    // par un intermédiaire suit donc le même chemin, et doit être arrêtée de la même façon.
    const testLogger = createLogger({ destination });
    const relayee = new Error('echec relaye par le pooler', {
      cause: relayedDriverFailure('ERROR'),
    });

    testLogger.error({ err: relayee }, 'message fixe');

    expectNoDriverSentinel(destination.raw, 'de la cause relayee');
    const serialized = errorFieldOf(destination.firstLine);
    expect(serialized.message).toBe('echec relaye par le pooler');
    expect(nestedObjectOf(serialized.cause, 'err.cause').type).toBe('PostgresError');
  });

  it('épure une erreur du pilote portée par un membre d une AggregateError', () => {
    // Même aplatissement, autre porte : `pino.stdSerializers.err` sérialise chaque membre de
    // `errors`, donc fond aussi LEURS causes dans du texte.
    const testLogger = createLogger({ destination });
    const lot = new AggregateError(
      [new Error('membre en echec', { cause: driverFailure() })],
      'plusieurs ecritures ont echoue',
    );

    testLogger.error({ err: lot }, 'message fixe');

    expectNoDriverSentinel(destination.raw, 'du membre agrege');
    const membres = errorFieldOf(destination.firstLine).aggregateErrors;
    expect(Array.isArray(membres)).toBe(true);
    const premier = nestedObjectOf((membres as unknown[])[0], 'err.aggregateErrors[0]');
    expect(premier.message).toBe('membre en echec');
    expect(nestedObjectOf(premier.cause, 'err.aggregateErrors[0].cause').type).toBe(
      'PostgresError',
    );
  });

  it('conserve une cause ordinaire, structurée plutôt que fondue dans le texte', () => {
    // GARDE-FOU CONTRE L'EXCÈS INVERSE, deuxième volet : détacher la chaîne de causes ne doit
    // pas la faire disparaître, sans quoi le diagnostic d'une panne ordinaire y perdrait.
    const testLogger = createLogger({ destination });
    const failure = new Error('ecriture de session impossible', {
      cause: new Error('connexion au pool epuisee'),
    });

    testLogger.error({ err: failure }, 'panne');

    const serialized = errorFieldOf(destination.firstLine);
    expect(serialized.message).toBe('ecriture de session impossible');
    const cause = nestedObjectOf(serialized.cause, 'err.cause');
    expect(cause.type).toBe('Error');
    expect(cause.message).toBe('connexion au pool epuisee');
    expect(String(cause.stack)).toContain('Error');
  });

  it('laisse intacte l exception d origine, cause comprise', () => {
    // L'épuration travaille sur une COPIE. Une exception journalisée continue de circuler
    // dans le code appelant : la mutiler ici priverait de sa cause tout ce qui la rattrape.
    const testLogger = createLogger({ destination });
    const origine = driverFailure();
    const failure = new Error('echec applicatif', { cause: origine });

    testLogger.error({ err: failure }, 'panne');

    expect(failure.cause).toBe(origine);
    expect(origine.detail).toContain(DRIVER_SENTINELS.detail);
  });

  it('ne boucle pas sur une chaîne de causes circulaire', () => {
    const testLogger = createLogger({ destination });
    const premier: Error & { cause?: unknown } = new Error('premier');
    const second = new Error('second', { cause: premier });
    premier.cause = second;

    testLogger.error({ err: premier }, 'panne');

    const cause = nestedObjectOf(errorFieldOf(destination.firstLine).cause, 'err.cause');
    expect(cause.message).toBe('second');
    expect(cause.cause).toBe('[CIRCULAR]');
  });

  it('laisse intact un objet applicatif portant un code et une gravité', () => {
    // LE DÉFAUT QUE CE TEST FERME. La reconnaissance se contentait d'un `code` de cinq
    // caractères alphanumériques et d'une gravité en chaîne. Or `docs/domain-model.md` porte
    // `Incident.severity` et `docs/api-contract.md` en montre un exemple : une ligne décrivant
    // un incident était remplacée par un objet AFFIRMANT être une erreur du pilote. Ce n'est
    // pas une ligne appauvrie, c'est une ligne fausse — un exploitant y lit une panne de base.
    const testLogger = createLogger({ destination });

    testLogger.warn(
      {
        module: 'incidents',
        incident: {
          code: 'FEU01',
          severity: 'HIGH',
          missionId: 'mis_11111111-2222-4333-8444-555555555555',
          reportedByOrganizationId: 'org-fictive-003',
        },
      },
      'incident signalé sur une mission',
    );

    const incident = nestedObjectOf(destination.firstLine.incident, 'incident');
    expect(incident.code).toBe('FEU01');
    expect(incident.severity).toBe('HIGH');
    expect(incident.missionId).toBe('mis_11111111-2222-4333-8444-555555555555');
    expect(incident.reportedByOrganizationId).toBe('org-fictive-003');
    expect(incident.type).toBeUndefined();
    expect(destination.raw).not.toContain('PostgresError');
  });

  it('reconnaît une erreur du pilote par la gravité du moteur SEULE', () => {
    // CONTRE-ÉPREUVE DU RESSERREMENT. Une erreur relayée dans un objet simple n'a ni
    // `routine` ni `file` ; c'est le vocabulaire de gravité du moteur qui doit la trancher,
    // sans quoi le resserrement rouvrirait la fuite qu'il est censé accompagner.
    const testLogger = createLogger({ destination });

    testLogger.error({ err: relayedDriverFailure('ERROR') }, 'ecriture refusee par le relais');

    expectNoDriverSentinel(destination.raw, 'de l erreur relayee');
    const serialized = errorFieldOf(destination.firstLine);
    expect(serialized.type).toBe('PostgresError');
    expect(serialized.code).toBe('23505');
    expect(serialized.detail).toBeUndefined();
  });

  it('reconnaît une erreur du pilote d un serveur localisé par un champ du protocole', () => {
    // Le champ `severity` est LOCALISÉ par PostgreSQL : sur une installation francophone il
    // vaut « ERREUR », hors de tout vocabulaire anglais. C'est alors `routine`, que seul le
    // protocole du moteur produit, qui tranche. Exiger les DEUX critères publierait ici la
    // ligne refusée.
    const testLogger = createLogger({ destination });

    testLogger.error(
      { err: relayedDriverFailure('ERREUR', { routine: 'ExecConstraints' }) },
      'ecriture refusee par un serveur francophone',
    );

    expectNoDriverSentinel(destination.raw, 'de l erreur localisee');
    const serialized = errorFieldOf(destination.firstLine);
    expect(serialized.type).toBe('PostgresError');
    expect(serialized.severity).toBe('ERREUR');
    expect(serialized.routine).toBe('ExecConstraints');
    expect(serialized.detail).toBeUndefined();
  });

  it('interdit au message du serveur de devenir le msg de la ligne', () => {
    // LE DÉFAUT QUE CE TEST FERME. `msg` est calculé par pino AVANT les sérialiseurs et les
    // formateurs : un appel sans message explicite recopiait le `message` de l'erreur, texte
    // libre du serveur, hors de portée de toute épuration. Deux formes d'appel le
    // produisaient ; aucun site d'appel ne les emploie, mais rien ne les empêchait.
    const testLogger = createLogger({ destination });

    testLogger.error(driverFailure());
    testLogger.error({ err: driverFailure() });
    // Un second argument `undefined` n'est pas un message : pino retombe sur la dérivation.
    // Mesuré : `quick-format-unescaped` rend `undefined` tel quel.
    testLogger.error({ err: driverFailure() }, undefined);

    expectNoDriverSentinel(destination.raw, 'du message principal');
    const lines = destination.lines;
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(String(line.msg)).toContain('champs porteurs de valeurs écartés');
      expect(errorFieldOf(line).type).toBe('PostgresError');
    }
  });

  it('n invente pas de message quand l appelant en fournit un', () => {
    // GARDE-FOU CONTRE L'EXCÈS INVERSE : la garde ne doit mordre que là où pino s'apprêtait à
    // fabriquer un message depuis l'erreur.
    const testLogger = createLogger({ destination });

    testLogger.error(driverFailure(), 'ecriture refusee par la base');
    testLogger.error(new Error('connexion au pool epuisee'));
    testLogger.info({ err: driverFailure(), msg: 'message porte par l objet' });

    const [premiere, deuxieme, troisieme] = destination.lines;
    expect(premiere?.msg).toBe('ecriture refusee par la base');
    expect(deuxieme?.msg).toBe('connexion au pool epuisee');
    expect(troisieme?.msg).toBe('message porte par l objet');
    expectNoDriverSentinel(destination.raw, 'du message principal');
  });

  it('applique la garde du message aux journaux enfants', () => {
    // `getRequestLogger()` ne rend que des enfants du journal racine : une garde posée sur le
    // seul parent ne couvrirait aucune ligne de requête.
    const testLogger = createLogger({ destination }).child({ module: 'organizations' });

    testLogger.error(driverFailure());

    const line = destination.firstLine;
    expect(line.module).toBe('organizations');
    expect(String(line.msg)).toContain('champs porteurs de valeurs écartés');
    expectNoDriverSentinel(destination.raw, 'du message principal d un enfant');
  });

  it('ne touche pas au message d une exception ordinaire', () => {
    // GARDE-FOU CONTRE L'EXCÈS INVERSE. Si l'épuration mordait sur les exceptions
    // applicatives, chaque panne deviendrait muette et le remède serait pire que le mal.
    const testLogger = createLogger({ destination });

    testLogger.error({ err: new Error('connexion au pool épuisée') }, 'panne');

    const serialized = errorFieldOf(destination.firstLine);
    expect(serialized.message).toBe('connexion au pool épuisée');
    expect(String(serialized.stack)).toContain('Error');
    expect(serialized.type).toBe('Error');
  });

  it('respecte le niveau demandé', () => {
    const testLogger = createLogger({ level: 'warn', destination });

    testLogger.debug('ligne de mise au point');
    testLogger.warn('ligne d avertissement');

    expect(destination.lines).toHaveLength(1);
    expect(destination.firstLine.level).toBe('warn');
  });
});

describe('getRequestLogger', () => {
  const context: RequestContext = {
    requestId: 'req_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    route: '/api/v1/missions/:id',
    method: 'PATCH',
    startedAt: 0,
    userIdHash: pseudonymizeUserId('utilisateur-fictif-002'),
    organizationId: 'org-fictive-002',
  };

  it('enrichit le journal des champs de la requête courante', () => {
    const bindings = runWithRequestContext(context, () => getRequestLogger().bindings());

    expect(bindings.requestId).toBe(context.requestId);
    expect(bindings.route).toBe(context.route);
    expect(bindings.method).toBe(context.method);
    expect(bindings.userId).toBe(context.userIdHash);
    expect(bindings.organizationId).toBe(context.organizationId);
  });

  it('ne journalise jamais l identifiant utilisateur en clair', () => {
    const bindings = runWithRequestContext(context, () => getRequestLogger().bindings());

    expect(JSON.stringify(bindings)).not.toContain('utilisateur-fictif-002');
    expect(String(bindings.userId)).toMatch(/^usr_[0-9a-f]{32}$/);
  });

  it('rend le journal racine hors de toute requête', () => {
    expect(getRequestLogger()).toBe(logger);
  });

  it('réutilise le même journal enfant pour un même contexte', () => {
    const [first, second] = runWithRequestContext(context, () => [
      getRequestLogger(),
      getRequestLogger(),
    ]);

    expect(second).toBe(first);
  });
});

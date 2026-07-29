import { afterEach, describe, expect, it } from 'vitest';
import type { AppError } from '@/application/errors';
import { isAppError } from '@/application/errors';
import {
  assertPlatformWritable,
  INITIAL_MEMBER_ROLE,
  ORGANIZATION_CREATE_OPERATION,
  ORGANIZATION_UPDATE_ROLES,
} from '@/domain/organizations/policy';
import {
  ORGANIZATION_MEMBER_ROLES,
  ORGANIZATION_STATUSES,
  ORGANIZATION_TYPES,
  ORGANIZATION_VERIFICATION_STATUSES,
} from '@/domain/organizations/types';
import { toOrganizationView } from '@/domain/organizations/views';

/**
 * Constantes de politique et projection vers le contrat (US-012).
 *
 * DEUX MODULES, DEUX RISQUES DISTINCTS, éprouvés ensemble parce qu'aucun des deux ne touche
 * la base et qu'ils décident tous deux de ce qui SORT du serveur.
 *
 * `policy.ts` porte la garde de lecture seule. Un interrupteur de sécurité qui laisserait
 * passer une écriture pendant un incident ne se verrait qu'au moment où il compte, c'est-à
 * -dire trop tard. Ces tests l'actionnent dans les deux sens, sans base et sans route.
 *
 * `views.ts` décide ce qu'un client voit d'une ligne `organizations`. Le contrôle utile
 * n'est pas « les champs attendus sont présents » — un ajout accidentel passerait — mais
 * « les champs présents sont EXACTEMENT ceux du contrat ». La colonne
 * `registration_number_normalized` porte l'unicité : l'exposer inviterait un client à la
 * recalculer, donc à diverger de la définition de la colonne générée, et l'unicité ne
 * porterait plus sur la même chose selon l'origine de l'écriture.
 */

const initialEnvironment = { ...process.env };

function captureRefusal(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    if (isAppError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error('l appel aurait du etre refuse');
}

describe('assertPlatformWritable', () => {
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in initialEnvironment)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, initialEnvironment);
  });

  it('laisse passer en mode normal', () => {
    delete process.env.PLATFORM_READ_ONLY;

    expect(() => {
      assertPlatformWritable();
    }).not.toThrow();
  });

  it('refuse par PLATFORM_READ_ONLY, avec le statut 503 du contrat', () => {
    // 503 et non 403 : la plateforme n'est pas en train de refuser CET appelant, elle est
    // indisponible en écriture pour tout le monde. Un client peut réessayer plus tard, ce
    // qu'un 403 lui dirait de ne pas faire.
    process.env.PLATFORM_READ_ONLY = 'true';

    const error = captureRefusal(() => {
      assertPlatformWritable();
    });

    expect(error.code).toBe('PLATFORM_READ_ONLY');
    expect(error.httpStatus).toBe(503);
    expect(error.details).toStrictEqual({});
  });

  it('reconnait les ecritures usuelles du vrai', () => {
    for (const value of ['true', 'TRUE', '1', ' on ', 'Yes']) {
      process.env.PLATFORM_READ_ONLY = value;
      expect(
        captureRefusal(() => {
          assertPlatformWritable();
        }).code,
        value,
      ).toBe('PLATFORM_READ_ONLY');
    }
  });

  it('reste ouvert pour toute valeur qui n est pas explicitement vraie', () => {
    // Refus par défaut à l'envers : c'est ici un interrupteur qui FERME. Une valeur illisible
    // ne doit donc pas fermer la plateforme par accident, sans quoi une faute de frappe dans
    // une variable d'environnement arrêterait toutes les écritures.
    for (const value of ['false', '', 'oui', 'vrai', '2', 'enabled']) {
      process.env.PLATFORM_READ_ONLY = value;
      expect(() => {
        assertPlatformWritable();
      }, value).not.toThrow();
    }
  });

  it('relit l interrupteur A CHAQUE APPEL, sans cache', () => {
    // Un interrupteur de sécurité mis en cache resterait ouvert pendant la durée du cache,
    // c'est-à-dire pendant la fenêtre exacte qu'il existe pour fermer. La bascule doit donc
    // se voir dès l'appel suivant, dans les deux sens.
    process.env.PLATFORM_READ_ONLY = 'true';
    expect(
      captureRefusal(() => {
        assertPlatformWritable();
      }).code,
    ).toBe('PLATFORM_READ_ONLY');

    process.env.PLATFORM_READ_ONLY = 'false';
    expect(() => {
      assertPlatformWritable();
    }).not.toThrow();

    process.env.PLATFORM_READ_ONLY = 'on';
    expect(
      captureRefusal(() => {
        assertPlatformWritable();
      }).code,
    ).toBe('PLATFORM_READ_ONLY');
  });
});

describe('constantes de politique', () => {
  it('respecte la forme d operation exigee par idempotency_keys', () => {
    // `idempotency_keys_operation_format` refuse tout ce qui sort de ce motif : une
    // constante mal formée ferait échouer la RÉSERVATION, donc la création entière, avec un
    // 500 dont rien n'indiquerait la cause.
    expect(ORGANIZATION_CREATE_OPERATION).toBe('ORGANIZATION_CREATE');
    expect(ORGANIZATION_CREATE_OPERATION).toMatch(/^[A-Z][A-Z0-9_]{2,63}$/);
  });

  it('fait du createur un administrateur de son organisation', () => {
    // Sans administrateur, la fiche serait une entrée que personne ne peut corriger, donc
    // bloquée pour toujours dans la file de validation. Le rôle est posé par le serveur, le
    // client ne le demande ni ne le refuse (ADR-016).
    expect(INITIAL_MEMBER_ROLE).toBe('ORG_ADMIN');
    expect(ORGANIZATION_MEMBER_ROLES).toContain(INITIAL_MEMBER_ROLE);
  });

  it('n admet QUE ORG_ADMIN a la modification d une fiche', () => {
    // LISTE ÉNUMÉRÉE, JAMAIS UNE COMPARAISON D'ORDRE. `OBSERVER` est déclaré EN DERNIER dans
    // le type énuméré et reste le rôle le MOINS capable : une garde écrite
    // `role >= 'ORG_ADMIN'` lui accorderait les droits d'un administrateur d'organisation.
    // Ce test parcourt donc les cinq rôles et vérifie les quatre exclusions, pas seulement
    // l'inclusion.
    expect([...ORGANIZATION_UPDATE_ROLES]).toStrictEqual(['ORG_ADMIN']);

    for (const role of ORGANIZATION_MEMBER_ROLES) {
      expect(ORGANIZATION_UPDATE_ROLES.includes(role), role).toBe(role === 'ORG_ADMIN');
    }
  });

  it('ne confond pas la fonction d administrateur plateforme avec une adhesion admise', () => {
    // `PLATFORM_ADMIN` est traité à part par `assertOrganizationRole`, parce que ce n'est pas
    // une adhésion à l'organisation modifiée. L'ajouter à cette liste ferait passer un
    // administrateur plateforme par le chemin des membres, et son absence d'adhésion
    // deviendrait alors un refus.
    expect(ORGANIZATION_UPDATE_ROLES).not.toContain('PLATFORM_ADMIN');
  });
});

describe('toOrganizationView', () => {
  const CREATED_AT = new Date('2026-07-20T08:30:00.000Z');
  const UPDATED_AT = new Date('2026-07-21T09:45:00.000Z');

  /** Les dix colonnes du contrat, et rien d'autre (`docs/api-contract.md`). */
  const CONTRACT_KEYS = [
    'createdAt',
    'id',
    'name',
    'registrationNumber',
    'status',
    'territoryCode',
    'type',
    'updatedAt',
    'verificationStatus',
    'version',
  ];

  /**
   * Ligne telle que la base la rend, AVEC les colonnes que le contrat ne porte pas. Les
   * ajouter est tout l'intérêt du test : une projection écrite par diffusion (`...row`)
   * passerait un contrôle qui se contenterait de vérifier la présence des dix champs.
   */
  const rowWithInternals = {
    id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    name: 'Exploitation agricole Martin',
    type: 'FARM',
    registration_number: 'FICTIF-ORG-0003',
    registration_number_normalized: 'FICTIFORG0003',
    territory_code: 'ZZ-DEMO-01',
    verification_status: 'PENDING',
    status: 'ACTIVE',
    version: 1,
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
  } as const;

  it('expose EXACTEMENT les dix champs du contrat', () => {
    const view = toOrganizationView(rowWithInternals);

    expect(Object.keys(view).sort()).toStrictEqual(CONTRACT_KEYS);
  });

  it('ne laisse sortir aucune colonne interne, ni sa valeur', () => {
    // `registration_number_normalized` porte l'unicité et n'est un détail que de la
    // contrainte. Le sérialiser une fois suffirait à ce qu'un client s'y adosse.
    const view = toOrganizationView(rowWithInternals);
    const serialized = JSON.stringify(view);

    expect(Object.hasOwn(view, 'registration_number_normalized')).toBe(false);
    expect(serialized).not.toContain('registration_number_normalized');
    expect(serialized).not.toContain('FICTIFORG0003');
    expect(serialized).not.toContain('registration_number');
    expect(serialized).not.toContain('territory_code');
  });

  it('reprend chaque valeur sans la reecrire', () => {
    const view = toOrganizationView(rowWithInternals);

    expect(view).toStrictEqual({
      id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      name: 'Exploitation agricole Martin',
      type: 'FARM',
      registrationNumber: 'FICTIF-ORG-0003',
      territoryCode: 'ZZ-DEMO-01',
      verificationStatus: 'PENDING',
      status: 'ACTIVE',
      version: 1,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
  });

  it('rend le numero TEL QU IL A ETE SAISI, separateurs compris', () => {
    // Un numéro d'immatriculation se lit par groupes : normaliser l'affichage appauvrirait
    // la confrontation humaine à un registre public, qui est tout l'objet d'US-013.
    const view = toOrganizationView({ ...rowWithInternals, registration_number: '123 456-789' });

    expect(view.registrationNumber).toBe('123 456-789');
  });

  it('conserve les horodatages sous forme de dates, non de chaines', () => {
    // La conversion en ISO 8601 appartient à la couche de transport. La faire ici priverait
    // le domaine de toute comparaison de dates, et deux conversions finiraient par différer.
    const view = toOrganizationView(rowWithInternals);

    expect(view.createdAt).toBeInstanceOf(Date);
    expect(view.updatedAt).toBeInstanceOf(Date);
    expect(view.createdAt.toISOString()).toBe('2026-07-20T08:30:00.000Z');
    expect(view.updatedAt.toISOString()).toBe('2026-07-21T09:45:00.000Z');
  });

  it('laisse passer un perimetre absent sans le remplacer par une chaine vide', () => {
    // `null` dit « aucun périmètre déclaré » ; une chaîne vide dirait « périmètre vide », que
    // le contrat n'admet pas et que l'écran afficherait comme un champ rempli.
    const view = toOrganizationView({ ...rowWithInternals, territory_code: null });

    expect(view.territoryCode).toBeNull();
  });

  it('projette les vocabulaires fermes sans les traduire', () => {
    // Les libellés français sont l'affaire de `src/i18n/fr.ts`. Traduire ici ferait du
    // contrat une chaîne d'affichage, que le client ne pourrait plus comparer.
    for (const type of ORGANIZATION_TYPES) {
      expect(toOrganizationView({ ...rowWithInternals, type }).type, type).toBe(type);
    }
    for (const verificationStatus of ORGANIZATION_VERIFICATION_STATUSES) {
      expect(
        toOrganizationView({ ...rowWithInternals, verification_status: verificationStatus })
          .verificationStatus,
        verificationStatus,
      ).toBe(verificationStatus);
    }
    for (const status of ORGANIZATION_STATUSES) {
      expect(toOrganizationView({ ...rowWithInternals, status }).status, status).toBe(status);
    }
  });

  it('rend un objet nouveau, distinct de la ligne recue', () => {
    // La ligne brute ne doit jamais être renvoyée telle quelle : une projection qui la
    // rendrait exposerait toute colonne ajoutée par une migration future, sans qu'aucun test
    // de contrat ne s'en aperçoive.
    const view = toOrganizationView(rowWithInternals);

    expect(view).not.toBe(rowWithInternals);
  });
});

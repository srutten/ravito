import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  getSessionCookieAttributes,
  getSessionCookieName,
  readSessionTokenFromCookieHeader,
  readSessionTokenFromRequest,
  SESSION_COOKIE_MAX_AGE_SECONDS,
} from '@/authorization/session-cookie';
import type { AppEnvironment } from '@/config/env';
import { resetServerConfigCache } from '@/config/env';
import { SESSION_ABSOLUTE_TTL_SECONDS } from '@/domain/identity/policy';

/**
 * Cookie de session (ADR-017, docs/security.md « Protection CSRF si cookies »).
 *
 * TROIS PROPRIÉTÉS SONT TESTÉES ICI, ET AUCUNE N'EST COSMÉTIQUE.
 *
 * 1. `HttpOnly` toujours, `Secure` et le préfixe `__Host-` partout sauf sur le poste local. Le
 *    préfixe fait refuser par le navigateur tout cookie de ce nom qui ne serait pas `Secure`, en
 *    `Path=/` et sans `Domain` : un sous-domaine compromis ne peut alors plus écraser la session
 *    du domaine principal.
 * 2. La lecture n'accepte QUE le nom de l'environnement courant. Accepter les deux noms « au cas
 *    où » permettrait de présenter en production un cookie sans préfixe, donc de contourner
 *    exactement la protection que le préfixe apporte.
 * 3. Une configuration illisible donne le réglage le plus strict. Le défaut sûr est de refuser un
 *    cookie, jamais d'en accepter un.
 */

const TOKEN = 'jeton-de-test-base64url_AZERTY-0123456789abcdefgh';
const initialEnvironment = { ...process.env };

function applyEnvironment(environment: AppEnvironment | undefined): void {
  resetServerConfigCache();
  if (environment === undefined) {
    delete process.env.APP_ENV;
  } else {
    process.env.APP_ENV = environment;
  }
  process.env.APP_VERSION = '0.0.0-test';
  process.env.LOG_LEVEL = 'error';
  process.env.DATABASE_URL = 'postgresql://utilisateur:motdepasse-fictif@localhost:5432/appui_feux';
  process.env.DATABASE_SSL = 'disable';
  process.env.AUTH_SECRET = 'secret-de-test-fictif-de-plus-de-32-caracteres';
}

function attributesOf(cookie: string): Set<string> {
  return new Set(
    cookie
      .split(';')
      .map((part) => part.trim())
      .slice(1),
  );
}

beforeEach(() => {
  applyEnvironment('local');
});

afterAll(() => {
  resetServerConfigCache();
  for (const key of Object.keys(process.env)) {
    if (!(key in initialEnvironment)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, initialEnvironment);
});

describe('nom du cookie', () => {
  it('reste sans préfixe sur le poste local, où le service est servi en clair', () => {
    // Le préfixe `__Host-` impose `Secure` : conservé en local, le navigateur rejetterait le
    // cookie en silence, et un rejet silencieux se diagnostique très mal.
    expect(getSessionCookieName()).toBe('appui_feux_session');
  });

  it('porte le préfixe __Host- dès que l environnement est déployé', () => {
    for (const environment of ['staging', 'production'] as const) {
      applyEnvironment(environment);
      expect(getSessionCookieName(), `environnement ${environment}`).toBe(
        '__Host-appui_feux_session',
      );
    }
  });

  it('choisit le réglage le plus strict quand la configuration est illisible', () => {
    applyEnvironment(undefined);

    expect(getSessionCookieName()).toBe('__Host-appui_feux_session');
    expect(getSessionCookieAttributes().secure).toBe(true);
  });
});

describe('buildSessionCookie', () => {
  it('pose un cookie HttpOnly, SameSite=Lax, sur tout le site', () => {
    const cookie = buildSessionCookie(TOKEN);

    expect(cookie.startsWith(`appui_feux_session=${TOKEN};`)).toBe(true);
    expect(attributesOf(cookie)).toStrictEqual(new Set(['Path=/', 'HttpOnly', 'SameSite=Lax']));
  });

  it('ajoute Secure hors du poste local', () => {
    applyEnvironment('production');
    const cookie = buildSessionCookie(TOKEN);

    expect(cookie.startsWith(`__Host-appui_feux_session=${TOKEN};`)).toBe(true);
    expect(attributesOf(cookie)).toStrictEqual(
      new Set(['Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure']),
    );
  });

  it('ne pose ni Max-Age ni Expires : le cookie est de session', () => {
    applyEnvironment('production');
    const cookie = buildSessionCookie(TOKEN);

    // La durée de vie qui fait foi est celle de la ligne en base, la seule qu'un administrateur
    // puisse raccourcir pendant un incident. Un cookie persistant survivrait à cette décision.
    expect(cookie).not.toContain('Max-Age');
    expect(cookie).not.toContain('Expires');
  });

  it('insère le jeton tel quel, sans échappement', () => {
    // Le jeton est en base64url : aucun caractère n'exige d'échappement. Un `encodeURIComponent`
    // rendrait lecture et écriture asymétriques si l'une des deux venait à l'oublier.
    expect(readSessionTokenFromCookieHeader(buildSessionCookie(TOKEN).split(';')[0] ?? '')).toBe(
      TOKEN,
    );
  });
});

describe('buildClearedSessionCookie', () => {
  it('efface avec les MÊMES attributs que la pose', () => {
    applyEnvironment('production');
    const posed = attributesOf(buildSessionCookie(TOKEN));
    const cleared = buildClearedSessionCookie();

    // Un navigateur n'efface un cookie que si le nom, le chemin et le domaine correspondent : un
    // effacement approximatif laisse la session vivante tout en affichant une déconnexion.
    expect(cleared.startsWith('__Host-appui_feux_session=;')).toBe(true);
    for (const attribute of posed) {
      expect(attributesOf(cleared), `attribut conservé : ${attribute}`).toContain(attribute);
    }
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  });

  it('ne contient aucun jeton', () => {
    expect(buildClearedSessionCookie()).not.toContain(TOKEN);
  });
});

describe('lecture du jeton', () => {
  it('retrouve le cookie au milieu des autres', () => {
    const header = `theme=sombre; appui_feux_session=${TOKEN}; consentement=1`;

    expect(readSessionTokenFromCookieHeader(header)).toBe(TOKEN);
  });

  it('rend undefined quand il n y a rien à lire', () => {
    expect(readSessionTokenFromCookieHeader(null)).toBeUndefined();
    expect(readSessionTokenFromCookieHeader('')).toBeUndefined();
    expect(readSessionTokenFromCookieHeader('theme=sombre')).toBeUndefined();
    expect(readSessionTokenFromCookieHeader('appui_feux_session=')).toBeUndefined();
    expect(readSessionTokenFromCookieHeader('=valeur-sans-nom')).toBeUndefined();
  });

  it('REFUSE en production un cookie dépourvu du préfixe __Host-', () => {
    applyEnvironment('production');

    // C'est le test négatif du préfixe : si la lecture acceptait les deux noms, un attaquant
    // maître d'un sous-domaine poserait un cookie sans préfixe et la protection ne servirait plus
    // à rien.
    expect(readSessionTokenFromCookieHeader(`appui_feux_session=${TOKEN}`)).toBeUndefined();
    expect(readSessionTokenFromCookieHeader(`__Host-appui_feux_session=${TOKEN}`)).toBe(TOKEN);
  });

  it('ne confond pas un cookie dont le nom commence pareil', () => {
    expect(
      readSessionTokenFromCookieHeader(`appui_feux_session_precedent=${TOKEN}`),
    ).toBeUndefined();
  });

  it('lit le jeton porté par une requête', () => {
    const request = new Request('https://appui-feux.exemple.test/api/v1/auth/sessions/current', {
      headers: { cookie: `appui_feux_session=${TOKEN}` },
    });

    expect(readSessionTokenFromRequest(request)).toBe(TOKEN);
    expect(
      readSessionTokenFromRequest(
        new Request('https://appui-feux.exemple.test/api/v1/auth/sessions/current'),
      ),
    ).toBeUndefined();
  });
});

describe('bornes exposées', () => {
  it('aligne la borne de conservation sur la durée de vie absolue de la session', () => {
    expect(SESSION_COOKIE_MAX_AGE_SECONDS).toBe(SESSION_ABSOLUTE_TTL_SECONDS);
    expect(SESSION_ABSOLUTE_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });
});

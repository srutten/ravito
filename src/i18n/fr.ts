import type { ErrorCode } from '@/application/errors';

/**
 * Catalogue des libellés français.
 *
 * Règles :
 * - un libellé d'erreur est neutre : il dit ce que l'utilisateur peut faire, jamais pourquoi le
 *   serveur a échoué, jamais quelle donnée existe (docs/security.md, messages d'erreur neutres) ;
 * - aucun libellé ne contient de donnée métier, d'identifiant technique ni de nom propre ;
 * - le vouvoiement est la règle, la ponctuation française aussi.
 */

/** Un libellé par code de `ERROR_CODES`. L'exhaustivité est vérifiée à la compilation. */
const errors: Readonly<Record<ErrorCode, string>> = {
  UNAUTHENTICATED: 'Vous devez vous connecter pour effectuer cette action.',
  FORBIDDEN: "Vous n'êtes pas autorisé à effectuer cette action.",
  ORGANIZATION_NOT_VERIFIED: "Votre organisation n'est pas encore validée.",
  INVALID_TRANSITION: "Cette action n'est pas possible dans l'état actuel.",
  VERSION_CONFLICT:
    'Ces données ont été modifiées depuis leur affichage. Rechargez la page puis recommencez.',
  IDEMPOTENCY_CONFLICT: 'Cette action a déjà été enregistrée avec des informations différentes.',
  RESOURCE_UNAVAILABLE: "La ressource n'est pas disponible.",
  RESOURCE_ALREADY_ASSIGNED: "La ressource n'est plus disponible.",
  DOCUMENT_EXPIRED: 'Un document requis est expiré.',
  MEETING_POINT_REQUIRED: 'Un point de rassemblement valide est requis.',
  REQUEST_EXPIRED: 'Cette demande est expirée.',
  RATE_LIMITED: 'Trop de tentatives. Réessayez dans quelques instants.',
  PLATFORM_READ_ONLY: 'La plateforme est temporairement en lecture seule.',
  VALIDATION_ERROR: 'Les informations envoyées sont incomplètes ou invalides.',
  NOT_FOUND: 'Élément introuvable.',
  METHOD_NOT_ALLOWED: "Cette méthode n'est pas autorisée sur cette adresse.",
  PAYLOAD_TOO_LARGE: 'Le contenu envoyé dépasse la taille autorisée.',
  UNSUPPORTED_MEDIA_TYPE: "Ce format de contenu n'est pas pris en charge.",
  INTERNAL_ERROR: 'Une erreur interne est survenue. Réessayez dans un instant.',
  SERVICE_UNAVAILABLE: 'Le service est temporairement indisponible.',
};

/** Libellés d'interface. Les états transverses viennent de docs/screens.md. */
const ui = {
  app: {
    name: 'Appui Feux',
    baseline: 'Coordination logistique des moyens civils en soutien aux opérations incendie.',
  },
  /** États transverses obligatoires sur chaque écran (docs/screens.md). */
  states: {
    loading: 'Chargement en cours...',
    loadingAriaLabel: 'Chargement en cours',
    empty: 'Aucun élément à afficher pour le moment.',
    error: 'Une erreur est survenue. Réessayez dans un instant.',
    permissionDenied: "Vous n'avez pas les droits nécessaires pour consulter cette page.",
    networkUnavailable:
      'Connexion indisponible. Les informations affichées peuvent être incomplètes.',
    staleData:
      'Ces informations datent de votre dernière connexion et ne sont peut-être plus à jour.',
    versionConflict:
      'Ces informations ont changé depuis leur affichage. Rechargez la page puis recommencez.',
    actionInProgress: 'Action en cours...',
    actionSucceeded: 'Action enregistrée.',
    retry: 'Réessayer',
    reload: 'Recharger la page',
  },
  /** Accueil public (docs/screens.md, écran 1). */
  home: {
    title: 'Appui Feux',
    subtitle:
      'Mobiliser des moyens civils vérifiés vers des points de rassemblement sécurisés, à la demande des coordinateurs habilités.',
    emergencyNoticeTitle: 'Ce service ne remplace pas les secours',
    emergencyNotice:
      "N'utilisez jamais cette plateforme pour signaler un incendie ni pour demander du secours. En cas d'urgence, appelez le 18 ou le 112.",
    purposeTitle: 'À quoi sert la plateforme',
    purpose:
      'Un coordinateur habilité publie un besoin logistique. Les contributeurs vérifiés proposent une ressource disponible. Le coordinateur affecte lui-même la ressource et suit son acheminement.',
    limitsTitle: 'Ce que la plateforme ne fait pas',
    limits: [
      "Aucun citoyen n'est dirigé vers un front de feu.",
      "Aucune affectation n'est décidée automatiquement : un coordinateur valide chaque engagement.",
      'Les positions précises et les informations tactiques ne sont jamais publiques.',
    ],
    signIn: 'Se connecter',
    terms: "Conditions d'utilisation",
    termsAriaLabel: "Consulter les conditions d'utilisation",
  },
  /**
   * Écran de connexion (docs/screens.md, écran 2 ; ADR-015 et ADR-016).
   *
   * Deux règles gouvernent ces libellés et aucune n'est négociable.
   *
   * 1. AUCUN LIBELLÉ NE DIT SI UN COMPTE EXISTE. « Si un compte correspond à cette adresse » est
   *    écrit ainsi parce que le serveur répond exactement pareil dans les deux cas (critère 7) :
   *    un texte affirmatif ferait mentir l'interface là où le serveur, lui, ne dit rien.
   * 2. UN SEUL MESSAGE POUR LES QUATRE ÉCHECS DE CODE. Code inexistant, expiré, déjà consommé ou
   *    erroné : `codeRejected` et rien d'autre. Distinguer ces cas dans l'interface rétablirait
   *    côté navigateur l'oracle que le serveur refuse d'ouvrir.
   */
  signIn: {
    pageTitle: 'Connexion',
    pageDescription:
      'Connectez-vous avec un code à usage unique envoyé sur votre adresse de courriel.',
    welcomeTitle: 'Bienvenue !',
    welcomeSubtitle: 'Connectez-vous pour accéder à la plateforme.',
    formLabel: 'Formulaire de connexion',

    identifierLabel: 'Adresse de courriel',
    identifierPlaceholder: 'prenom.nom@exemple.fr',
    identifierHint: "Aucun mot de passe n'est demandé : un code à usage unique vous est envoyé.",
    requestCode: 'Recevoir un code',

    codeStepTitle: 'Code envoyé',
    codeStepBody:
      "Si un compte correspond à cette adresse, un code à six chiffres vient d'y être envoyé. Il ne sert qu'une fois.",
    codeLabel: 'Code à usage unique',
    codeHint: 'Six chiffres, reçus par courriel.',
    codeExpiresIn: 'Ce code expire dans',
    codeExpired: 'Ce code a expiré. Demandez-en un nouveau.',
    submitCode: 'Se connecter',
    resendCode: 'Renvoyer un code',
    resendAvailableIn: 'Nouveau code possible dans',
    changeIdentifier: "Modifier l'adresse",

    successTitle: 'Connexion réussie',
    successBody: 'Redirection en cours...',

    blockedTitle: 'Trop de tentatives',
    blockedRetryIn: 'Nouvelle tentative possible dans',

    failureTitle: 'Connexion refusée',
    codeRejected:
      "Ce code est incorrect ou n'est plus valable. Vérifiez votre saisie, ou demandez un nouveau code.",
    accountUnavailable:
      'Ce compte ne peut pas être utilisé pour se connecter. Contactez un administrateur de la plateforme.',

    /**
     * Encart de la maquette. Il ANNONCE le second facteur, il ne le fournit pas : la dernière
     * phrase existe pour que l'écran n'ait pas l'air de promettre un parcours qui n'existe pas
     * (docs/screens.md, écran 2 ; le second facteur est livré par US-011).
     */
    mfaTitle: 'Authentification renforcée pour les rôles sensibles',
    mfaBody:
      "Une authentification multifacteur peut être requise selon votre rôle et le contexte. Elle n'est pas encore active : aucune étape supplémentaire ne vous est demandée aujourd'hui.",

    registrationQuestion: 'Nouveau sur Appui Feux ?',
    registrationLink: 'Créer un compte',

    scriptRequiredTitle: 'JavaScript est nécessaire pour se connecter',
    scriptRequired:
      'La connexion se fait en deux temps, depuis votre navigateur. Activez JavaScript pour ce site, puis rechargez la page.',

    /**
     * Motifs de refus de l'identifiant. Ils ne dépendent que de la FORME de la saisie et ne
     * disent rien de l'existence d'un compte : l'écran peut donc les afficher sans ouvrir
     * d'oracle (voir `IdentifierRejectionReason` dans le module d'identité).
     */
    identifierErrors: {
      IDENTIFIER_REQUIRED: 'Saisissez votre adresse de courriel.',
      IDENTIFIER_TOO_LONG: 'Cette adresse de courriel est trop longue.',
      IDENTIFIER_NOT_ASCII:
        'Cette adresse contient des caractères non pris en charge. Saisissez une adresse sans accent.',
      PHONE_CHANNEL_UNAVAILABLE:
        "L'envoi par SMS n'est pas encore disponible. Saisissez une adresse de courriel.",
      IDENTIFIER_MALFORMED: "Cette adresse de courriel n'est pas valide.",
    },
    codeError: 'Saisissez les six chiffres du code reçu.',
  },
  /**
   * Page d'attente après connexion (docs/api-contract.md, `redirectPath`).
   *
   * Elle dit l'état réel du compte et rien de plus. Les tableaux de bord par rôle relèvent des
   * lots suivants : présenter ici un tableau de bord vide laisserait croire à une panne de
   * chargement plutôt qu'à une fonctionnalité non livrée.
   */
  postSignIn: {
    pageTitle: 'Vous êtes connecté',
    description:
      'Votre session est ouverte. Les espaces de travail par rôle ne sont pas encore ouverts dans cette version.',
    accountTitle: 'Votre compte',
    displayNameLabel: 'Nom affiché',
    sessionTitle: 'Votre session',
    issuedAtLabel: 'Ouverte le',
    expiresAtLabel: 'Expire sans activité le',
    absoluteExpiresAtLabel: 'Expire au plus tard le',
    noticeTitle: 'Ce que cette version ne fournit pas encore',
    notice:
      "Les tableaux de bord par rôle, les organisations et l'authentification à deux facteurs arrivent dans les lots suivants. Aucune donnée opérationnelle n'est disponible pour le moment.",
    actionsTitle: 'Fermer vos sessions',
    signOut: 'Se déconnecter',
    revokeAll: 'Déconnecter tous mes appareils',
    revokeAllHint:
      "À utiliser si vous pensez qu'une autre personne a accès à votre compte : toutes vos sessions sont fermées, y compris celle-ci.",
    signedOutTitle: 'Déconnexion effectuée',
    revokedTitle: 'Sessions fermées',
    revokedBody: 'Toutes vos sessions ont été fermées. Reconnectez-vous pour continuer.',
  },
  /** Page de santé technique (docs/observability.md). */
  health: {
    title: 'État du service',
    description: 'Sonde technique destinée à la supervision. Aucune donnée métier ne figure ici.',
    statusLabel: 'Statut',
    statusOk: 'Opérationnel',
    statusDegraded: 'Dégradé',
    statusDown: 'Indisponible',
    environmentLabel: 'Environnement',
    versionLabel: 'Version',
    checkedAtLabel: 'Vérifié le',
    databaseLabel: 'Base de données',
    uptimeLabel: 'Durée de fonctionnement',
  },
} as const;

export const messages = { errors, ui } as const;

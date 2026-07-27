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

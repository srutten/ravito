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
    /*
     * Mis à jour au lot organisations : les organisations existent désormais et figurent
     * ci-dessus. Laisser la phrase d'origine ferait de cet écran une interface qui ment sur ce
     * qu'elle propose juste au-dessus.
     */
    notice:
      "Les tableaux de bord par rôle et l'authentification à deux facteurs arrivent dans les lots suivants. Aucune donnée opérationnelle n'est disponible pour le moment.",
    workspacesTitle: 'Ce que vous pouvez faire',
    workspacesDescription:
      'Déclarez la structure au nom de laquelle vous interviendrez. Elle devra être validée avant de pouvoir publier ou proposer quoi que ce soit.',
    actionsTitle: 'Fermer vos sessions',
    signOut: 'Se déconnecter',
    revokeAll: 'Déconnecter tous mes appareils',
    revokeAllHint:
      "À utiliser si vous pensez qu'une autre personne a accès à votre compte : toutes vos sessions sont fermées, y compris celle-ci.",
    signedOutTitle: 'Déconnexion effectuée',
    revokedTitle: 'Sessions fermées',
    revokedBody: 'Toutes vos sessions ont été fermées. Reconnectez-vous pour continuer.',
  },
  /**
   * Coquille des écrans connectés (docs/screens.md).
   *
   * La navigation ne montre que ce qui existe. Un lien vers un tableau de bord non livré
   * ferait de la coquille une promesse, et l'écran d'arrivée un échec.
   */
  appShell: {
    navigationLabel: 'Navigation principale',
    account: 'Mon compte',
    newOrganization: 'Créer une organisation',
    pendingOrganizations: 'Organisations en attente',
    adminSectionLabel: 'Administration de la plateforme',
  },
  /**
   * Vocabulaire fermé des organisations (docs/api-contract.md, section Vocabulaire).
   *
   * TROIS AXES DISTINCTS, À NE JAMAIS CONFONDRE DANS UN LIBELLÉ : la NATURE de la structure
   * (`type`), la DÉCISION DE CONFIANCE d'un administrateur plateforme (`verificationStatus`)
   * et le CYCLE DE VIE de la fiche (`status`). Une organisation peut être validée et
   * suspendue, ou en attente et active : un libellé qui mêlerait deux axes rendrait
   * indécidable lequel fait foi.
   *
   * AUCUN DE CES ENSEMBLES N'EST ORDONNÉ. `OBSERVER` est déclaré en dernier et reste le rôle
   * le moins capable ; `REJECTED` n'est pas « plus vérifié » que `VERIFIED`.
   */
  organizations: {
    /** Libellés courts, pour l'affichage d'une fiche ou d'une ligne de file. */
    types: {
      OPERATIONAL_SERVICE: 'Service opérationnel',
      LOCAL_AUTHORITY: 'Collectivité',
      COMPANY: 'Entreprise',
      ASSOCIATION: 'Association',
      FARM: 'Exploitation agricole',
    },
    /**
     * Libellés de choix, plus longs que les précédents et volontairement.
     *
     * docs/screens.md, écran 11 : « les libellés affichés disent l'étendue réelle de chaque
     * valeur plutôt que de reprendre le cas le plus fréquent ». Une personne qui déclare un
     * service technique municipal doit voir qu'il entre dans « service opérationnel », sans
     * quoi elle le classera en « collectivité » et l'administrateur validera une nature
     * fausse.
     */
    typeChoices: {
      OPERATIONAL_SERVICE: 'Service opérationnel : incendie, technique, sécurité civile',
      LOCAL_AUTHORITY: 'Collectivité : commune, groupement, département, région',
      COMPANY: 'Entreprise',
      ASSOCIATION: 'Association',
      FARM: 'Exploitation agricole',
    },
    verificationStatuses: {
      PENDING: 'En attente de validation',
      VERIFIED: 'Validée',
      REJECTED: 'Refusée',
    },
    statuses: {
      ACTIVE: 'Active',
      SUSPENDED: 'Suspendue',
      CLOSED: 'Fermée',
    },
    roles: {
      CONTRIBUTOR: 'Contributeur',
      COORDINATOR: 'Coordinateur',
      ORG_ADMIN: "Administrateur de l'organisation",
      PLATFORM_ADMIN: 'Administrateur de la plateforme',
      OBSERVER: 'Observateur',
    },
    memberStatuses: {
      INVITED: 'Invitation en attente',
      ACTIVE: 'Active',
      SUSPENDED: 'Suspendue',
      REVOKED: 'Révoquée',
    },
    /** Champs communs à la fiche, au formulaire et à la file. */
    nameLabel: 'Nom de la structure',
    typeLabel: 'Type de structure',
    registrationNumberLabel: "Numéro d'immatriculation",
    territoryCodeLabel: 'Périmètre territorial',
    verificationStatusLabel: 'Validation',
    statusLabel: 'État de la fiche',
    versionLabel: 'Version de la fiche',
    createdAtLabel: 'Déclarée le',
    updatedAtLabel: 'Modifiée le',
    /** L'absence de périmètre est une information, pas une case vide (docs/screens.md). */
    noTerritory: 'Aucun périmètre déclaré',
  },
  /**
   * Création d'une organisation (docs/screens.md, écran 11).
   *
   * DEUX RÈGLES GOUVERNENT CES LIBELLÉS.
   *
   * 1. L'ÉCRAN NE PROMET RIEN QU'IL NE TIENNE. Aucun délai de traitement n'est annoncé :
   *    aucune règle du produit n'en garantit un, et un délai annoncé puis dépassé est pire
   *    qu'une absence de délai.
   * 2. LE REFUS D'UN NUMÉRO NE NOMME JAMAIS LA STRUCTURE QUI LE DÉTIENT. Le serveur répond
   *    `VALIDATION_ERROR` sur le même champ pour une forme invalide et pour un doublon : le
   *    message couvre donc les deux sans distinguer, faute de quoi l'écran rétablirait
   *    l'oracle d'énumération que le serveur refuse d'ouvrir.
   */
  createOrganization: {
    pageTitle: 'Créer une organisation',
    pageDescription:
      'Déclarez la structure au nom de laquelle vous interviendrez. Elle devra être validée par un administrateur de la plateforme avant de pouvoir publier ou proposer quoi que ce soit.',
    formLabel: "Formulaire de création d'organisation",

    namePlaceholder: 'Exploitation agricole Martin',
    nameHint:
      'De 2 à 160 caractères. Deux structures distinctes peuvent porter le même nom : rien ne vous est refusé de ce fait.',

    typePlaceholder: 'Choisissez un type de structure',
    typeHint:
      "Aucun type n'est présélectionné : retenez celui qui décrit la nature de la structure, pas son activité du moment.",

    registrationNumberPlaceholder: 'FICTIF-ORG-0005',
    registrationNumberHint:
      "Obligatoire : c'est ce qu'un administrateur de la plateforme confronte à un registre public pour valider votre organisation. De 4 à 64 caractères. Les séparateurs que vous saisissez sont conservés à l'affichage.",

    territoryCodeHint:
      "Facultatif : majuscules, chiffres et tirets, 16 caractères au plus, par exemple 2A ou ZZ-DEMO-01. Laissez ce champ vide si la structure n'a pas de périmètre territorial.",
    territoryCodePlaceholder: 'ZZ-DEMO-01',

    submit: "Créer l'organisation",
    submitBusy: 'Création en cours...',

    notAskedTitle: 'Ce que ce formulaire ne demande pas',
    notAsked:
      "Ni votre rôle, ni l'état de validation, ni de pièce justificative. Vous devenez administrateur de l'organisation que vous créez, et son état de validation est posé par la plateforme, jamais par le formulaire.",

    successTitle: 'Organisation créée, en attente de validation',
    successBody: 'Ouverture de la fiche...',

    failureTitle: 'Création refusée',

    /**
     * Messages rattachés aux champs. Chacun dit ce qu'il faut corriger, jamais pourquoi le
     * serveur a refusé ni ce qu'il connaît par ailleurs.
     */
    fieldErrors: {
      name: 'Saisissez un nom de 2 à 160 caractères, sans espace au début ni à la fin.',
      type: 'Choisissez un type de structure dans la liste.',
      registrationNumber:
        "Ce numéro d'immatriculation est refusé : vérifiez sa forme, ou saisissez-en un autre s'il est déjà enregistré. Lettres, chiffres, espace, point, barre oblique et tiret, en commençant et en finissant par une lettre ou un chiffre.",
      territoryCode:
        'Code territorial invalide : majuscules, chiffres et tirets, 16 caractères au plus, en commençant par une lettre ou un chiffre.',
      clientEventId:
        "Cette demande n'a pas pu être identifiée. Rechargez la page, puis recommencez.",
      root: 'Les informations envoyées sont incomplètes ou invalides. Vérifiez chaque champ.',
    },
  },
  /**
   * Fiche d'une organisation.
   *
   * L'ÉTAT « EN ATTENTE » EST AFFICHÉ ET EXPLICITE, et c'est un critère de SÉCURITÉ, pas de
   * confort : une personne qui vient de créer son organisation ne doit pas croire que cette
   * création lui a ouvert des droits. La fiche distingue donc ce qui est déjà possible de ce
   * qui ne l'est pas encore, en toutes lettres, plutôt que par une pastille de couleur.
   */
  organizationDetail: {
    eyebrow: 'Organisation',
    identityTitle: 'Identité déclarée',
    stateTitle: 'État',
    membershipTitle: 'Votre rôle dans cette organisation',
    membershipRoleLabel: 'Rôle',
    membershipStatusLabel: 'Statut de votre adhésion',
    membershipValidFromLabel: 'Depuis le',
    membershipValidUntilLabel: "Jusqu'au",
    membershipNone:
      "Vous n'êtes pas membre de cette organisation. Vous la consultez au titre de votre fonction d'administrateur de la plateforme.",

    pendingTitle: 'Organisation en attente de validation',
    pendingBody:
      "Cette organisation existe et vous pouvez la corriger, mais elle n'est pas encore validée. Un administrateur de la plateforme doit confronter son numéro d'immatriculation à un registre public.",
    pendingAllowedTitle: 'Ce que vous pouvez déjà faire',
    pendingAllowed: ['Compléter et corriger cette fiche.'],
    pendingBlockedTitle: "Ce qui reste fermé tant que la validation n'a pas eu lieu",
    pendingBlocked: [
      'Publier une demande de moyens au nom de cette organisation.',
      'Proposer une ressource au nom de cette organisation.',
    ],

    rejectedTitle: 'Organisation refusée',
    rejectedBody:
      "Un administrateur de la plateforme a refusé cette déclaration. Corriger la fiche la replace en attente de validation ; il n'y a rien d'autre à faire depuis cet écran.",

    suspendedTitle: 'Fiche suspendue',
    suspendedBody:
      'Cette organisation est suspendue : sa fiche ne peut plus être modifiée. Contactez un administrateur de la plateforme.',
    closedTitle: 'Fiche fermée',
    closedBody: 'Cette organisation est fermée. Sa fiche est conservée en lecture seule.',

    verifiedTitle: 'Organisation validée',
    verifiedBody:
      "Cette organisation a été validée par un administrateur de la plateforme. Modifier son nom, son type ou son numéro d'immatriculation la replacerait en attente de validation.",

    editTitle: 'Modifier la fiche',
    editDescription:
      "Modifier le nom, le type ou le numéro d'immatriculation d'une organisation validée annule sa validation et la replace dans la file d'attente. Le périmètre territorial, lui, se corrige sans conséquence.",
    editFormLabel: "Formulaire de modification de l'organisation",
    editSubmit: 'Enregistrer les modifications',
    editSubmitBusy: 'Enregistrement en cours...',
    editNoChange: "Modifiez au moins un champ avant d'enregistrer.",
    editSuccessTitle: 'Modifications enregistrées',
    editSuccessBody: 'La fiche affiche désormais son état à jour.',
    editVerificationResetTitle: 'Validation annulée',
    editVerificationResetBody:
      "Un champ d'identité a changé : cette organisation retourne en attente de validation.",
    editForbidden:
      'Seul un administrateur de cette organisation peut modifier sa fiche. Vous pouvez la consulter.',
    versionConflictTitle: 'Fiche modifiée entre-temps',
    versionConflictBody:
      "Une autre personne a modifié cette fiche depuis son affichage. L'état réel est rechargé ci-dessus : vérifiez-le, puis recommencez votre modification.",
    reload: 'Recharger la fiche',
  },
  /**
   * File des organisations en attente (docs/screens.md, écran 10).
   *
   * LA FILE NE SE RAFRAÎCHIT PAS D'ELLE-MÊME. `ENABLE_REALTIME` vaut faux et aucun canal
   * temps réel n'est livré : l'écran affiche l'heure du dernier chargement et propose un
   * rafraîchissement manuel, plutôt qu'un indicateur de fraîcheur qu'aucun code ne mesure.
   */
  pendingOrganizations: {
    pageTitle: 'Organisations en attente',
    pageDescription:
      'File de validation des organisations déclarées, de la plus ancienne à la plus récente. Réservée aux administrateurs de la plateforme.',
    eyebrow: 'Administration',
    listLabel: 'Organisations en attente de validation',

    countOne: 'organisation en attente',
    countMany: 'organisations en attente',

    refresh: 'Rafraîchir la file',
    lastLoadedAt: 'Dernier chargement',
    lastLoadedUnknown: 'Aucun chargement abouti',

    emptyTitle: 'Aucune organisation en attente.',
    emptyDescription:
      "Toutes les organisations déclarées ont été traitées. Cet écran ne signale rien d'anormal.",

    submittedAtLabel: 'Déposée le',
    waitingSinceLabel: 'En attente depuis',
    requestedByLabel: 'Demandée par',
    requestedByUnknown: 'Demandeur non renseigné',

    loadMore: 'Afficher les organisations suivantes',

    staleTitle: 'Liste datée',
    staleBody:
      "Cette liste date de son dernier chargement abouti et n'est peut-être plus à jour. Rafraîchissez-la dès que la connexion revient.",

    noDecisionTitle: 'La validation arrive dans une version ultérieure',
    noDecisionBody:
      "Valider ou refuser une organisation n'est pas encore possible. Cette file rend visible ce qui attend, plutôt que de le laisser invisible.",

    /** Ancienneté écrite en toutes lettres, jamais par une pastille de couleur. */
    ageLessThanHour: "moins d'une heure",
    ageHourOne: '1 heure',
    ageHourMany: 'heures',
    ageDayOne: '1 jour',
    ageDayMany: 'jours',
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

import type { Metadata } from 'next';
import { ContentPage } from '@/components/layout/content-page';
import { Alert } from '@/components/ui/alert';
import { BulletList } from '@/components/ui/bullet-list';
import { Card } from '@/components/ui/card';
import { messages } from '@/i18n/fr';

/**
 * Conditions d'utilisation, contenu de cadrage.
 *
 * Le texte reprend les principes non négociables de README.md et de docs/product-scope.md. Il ne
 * décrit aucune procédure officielle de secours et n'énonce aucun engagement contractuel :
 * docs/privacy-rgpd.md rappelle que la base légale, les durées et les responsabilités doivent
 * être validées par un professionnel compétent avant toute mise en service réelle.
 */

// À déplacer dans `src/i18n/fr.ts` lorsque ce fichier sera dans le périmètre.
const DESCRIPTION = "Contenu de cadrage décrivant l'usage attendu de la plateforme et ses limites.";

const DRAFT_NOTICE_TITLE = 'Document de cadrage, non validé juridiquement';
const DRAFT_NOTICE_BODY =
  "Ce texte décrit l'intention du service. Il n'a pas été validé par un professionnel du droit " +
  'et ne constitue pas un engagement contractuel. Sa base légale, ses durées de conservation et ' +
  'les responsabilités associées doivent être arrêtées avant toute mise en service réelle.';

const PURPOSE_TITLE = 'Objet du service';
const PURPOSE_BODY =
  'La plateforme recense des moyens logistiques civils, permet à un coordinateur habilité de ' +
  'publier un besoin, à un contributeur de proposer une ressource, puis au coordinateur ' +
  "d'affecter cette ressource vers un point de rassemblement sécurisé.";

const LIMITS_TITLE = "Ce que le service n'est pas";
const LIMITS = [
  "La plateforme ne remplace ni les services d'urgence ni la chaîne de commandement.",
  'Elle ne sert jamais à signaler un incendie ni à demander du secours.',
  'Elle ne dirige aucun citoyen vers un front de feu.',
  'Elle ne décide aucune affectation automatiquement : un coordinateur valide chaque engagement.',
  "Elle ne publie ni position précise, ni information tactique, ni position d'équipe.",
] as const;

const COMMITMENTS_TITLE = 'Engagements attendus de la personne utilisatrice';
const COMMITMENTS = [
  'Fournir des informations exactes sur les moyens déclarés et leur disponibilité réelle.',
  "Respecter les consignes transmises par le coordinateur et ne pas s'en écarter.",
  "Ne pas diffuser hors de la plateforme les informations d'une mission.",
  'Signaler sans délai tout incident rencontré pendant un acheminement.',
  "Ne pas tenter d'accéder à des données qui ne relèvent pas de sa mission ni de son organisation.",
] as const;

const DATA_TITLE = 'Données personnelles';
const DATA_BODY =
  'Les données collectées se limitent à ce qui est nécessaire à la coordination : identité, ' +
  'moyen de contact, appartenance à une organisation, ressources déclarées et historique des ' +
  "missions. Les positions précises sont protégées et ne sont accessibles qu'en cas de besoin " +
  "légitime. Les demandes d'accès, de rectification et de suppression seront traitées selon la " +
  "procédure publiée avant l'ouverture du service.";

const AVAILABILITY_TITLE = 'Disponibilité';
const AVAILABILITY_BODY =
  'Le service peut être interrompu, limité en lecture seule ou dégradé sans préavis. Une ' +
  'procédure de coordination hors plateforme doit rester prévue par chaque organisation.';

export const metadata: Metadata = {
  title: messages.ui.home.terms,
  description: DESCRIPTION,
};

export default function TermsPage() {
  return (
    <ContentPage title={messages.ui.home.terms} description={DESCRIPTION}>
      <Alert tone="warning" title={DRAFT_NOTICE_TITLE}>
        {DRAFT_NOTICE_BODY}
      </Alert>

      <Card title={PURPOSE_TITLE} titleLevel={2}>
        <p>{PURPOSE_BODY}</p>
      </Card>

      <Card title={LIMITS_TITLE} titleLevel={2}>
        <BulletList items={LIMITS} />
      </Card>

      <Card title={COMMITMENTS_TITLE} titleLevel={2}>
        <BulletList items={COMMITMENTS} />
      </Card>

      <Card title={DATA_TITLE} titleLevel={2}>
        <p>{DATA_BODY}</p>
      </Card>

      <Card title={AVAILABILITY_TITLE} titleLevel={2}>
        <p>{AVAILABILITY_BODY}</p>
      </Card>
    </ContentPage>
  );
}

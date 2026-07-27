import type { Metadata } from 'next';
import { ContentPage } from '@/components/layout/content-page';
import { Alert } from '@/components/ui/alert';
import { BulletList } from '@/components/ui/bullet-list';
import { Card } from '@/components/ui/card';

/**
 * Parcours d'authentification, coquille du lot 0.
 *
 * Aucun champ, aucun bouton de connexion, aucune promesse : l'authentification est livrée par
 * les stories US-010 et US-011 du lot 1. La page dit exactement l'état réel du service.
 */

// À déplacer dans `src/i18n/fr.ts` lorsque ce fichier sera dans le périmètre.
const TITLE = 'Connexion';
const DESCRIPTION = "L'accès aux comptes n'est pas encore ouvert.";
const NOTICE_TITLE = 'Authentification pas encore disponible';
const NOTICE_BODY =
  "Le service d'authentification sera livré au lot 1. Aucun compte ne peut être créé ni utilisé " +
  'pour le moment, et aucun identifiant ne doit être saisi ailleurs au nom de cette plateforme.';
const NEXT_STEPS_TITLE = 'Ce qui est prévu';
const NEXT_STEPS = [
  'Connexion par courriel ou téléphone, avec code à usage unique.',
  'Authentification renforcée pour les rôles sensibles, coordinateurs et administrateurs.',
  'Le rôle est porté par le compte et vérifié par le serveur : il ne se choisit pas au moment de la connexion.',
] as const;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
};

export default function AuthenticationPage() {
  return (
    <ContentPage title={TITLE} description={DESCRIPTION}>
      <Alert tone="info" title={NOTICE_TITLE}>
        {NOTICE_BODY}
      </Alert>
      <Card title={NEXT_STEPS_TITLE} titleLevel={2}>
        <BulletList items={NEXT_STEPS} />
      </Card>
    </ContentPage>
  );
}

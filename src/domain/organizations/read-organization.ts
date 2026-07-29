import {
  assertOrganizationVisible,
  denyOrganizationAccess,
  resolveOrganizationAccess,
  toMembershipView,
} from '@/authorization/organization-access';
import type { ReadOrganizationInput, ReadOrganizationResult } from '@/domain/organizations/types';
import { parseOrganizationId } from '@/domain/organizations/validation';
import { toOrganizationView } from '@/domain/organizations/views';
import { withTransaction } from '@/infrastructure/identity/unit-of-work';
import { findOrganizationById } from '@/infrastructure/organizations/repository';

/**
 * Lecture d'une organisation.
 *
 * POURQUOI UNE TRANSACTION POUR UNE LECTURE. Trois énoncés décident ensemble : l'existence
 * de l'organisation, l'adhésion de l'appelant, sa fonction éventuelle d'administrateur
 * plateforme. Hors transaction, chacun verrait un instant différent et un `now()` différent
 * — une adhésion pourrait être jugée valide par le premier et expirée par le second, à
 * quelques millisecondes près, exactement sur la frontière où l'accès bascule. Une
 * transaction fige l'instant et l'instantané. Le coût est nul : aucune écriture, aucun
 * verrou.
 *
 * NOT_FOUND ET NON FORBIDDEN. Un appelant qui n'est ni membre effectif ni administrateur
 * plateforme reçoit la même réponse qu'un appelant dont l'identifiant ne désigne rien.
 * Répondre `403` confirmerait l'existence de l'organisation, ce qui ferait de la route un
 * oracle : parcourir des identifiants suffirait à dresser la liste des structures
 * enregistrées. Le journal technique conserve le motif réel — `ORGANIZATION_ABSENT` ici,
 * `MEMBERSHIP_*` dans la garde — pour que l'exploitation distingue les deux cas que
 * l'appelant ne distingue pas. C'est la contrepartie qui justifie de fermer l'oracle : sans
 * elle, l'alerte « hausse d'accès refusés » de `docs/observability.md` n'aurait pas de
 * source, et un balayage d'identifiants ressemblerait ligne pour ligne à un lien mort cliqué
 * par un utilisateur légitime.
 *
 * L'ORDRE DES DEUX REFUS N'IMPORTE PAS, puisqu'ils sont identiques : c'est précisément ce
 * qui rend la route non discriminante. La lecture de l'organisation est faite avant la
 * garde pour que le travail effectué soit le même dans les deux cas.
 *
 * `membership` DÉCRIT L'APPELANT, ET LUI SEUL. La liste des membres relève d'US-014 :
 * l'exposer ici ferait de la lecture d'une organisation la liste de ses coordinateurs,
 * alors que les identités des coordinateurs sont un actif de `docs/threat-model.md`. Un
 * appelant admis au seul titre de sa fonction d'administrateur plateforme, sans adhésion à
 * l'organisation lue, reçoit `null` : le champ dit ce que l'appelant EST dans cette
 * organisation, pas ce qui lui donne accès.
 *
 * PAS DE GARDE `PLATFORM_READ_ONLY` : le mode lecture seule ferme les mutations, il n'a
 * jamais fermé les consultations. Pendant un incident, consulter reste nécessaire.
 */
export async function readOrganization(
  input: ReadOrganizationInput,
): Promise<ReadOrganizationResult> {
  const organizationId = parseOrganizationId(input.organizationId);

  return withTransaction(async (tx) => {
    const organization = await findOrganizationById(tx, organizationId);
    const access = await resolveOrganizationAccess(tx, {
      userId: input.actorUserId,
      organizationId,
    });

    if (organization === undefined) {
      // Le motif part au journal, la réponse n'en dit rien : `denyOrganizationAccess` rend
      // exactement l'erreur que la garde ci-dessous lèverait, au même code et sans détail.
      throw denyOrganizationAccess(organizationId, 'ORGANIZATION_ABSENT', 'NOT_FOUND');
    }
    assertOrganizationVisible(access);

    return {
      organization: toOrganizationView(organization),
      membership: access.membership === null ? null : toMembershipView(access.membership),
    };
  });
}

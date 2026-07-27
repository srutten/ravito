# Sécurité applicative

## Objectifs

- Protéger les personnes.
- Préserver la chaîne de commandement.
- Empêcher les fausses demandes.
- Protéger les positions sensibles.
- Empêcher les doubles affectations.
- Maintenir une preuve exploitable.
- Réduire l'impact d'un compte compromis.

## Authentification

- MFA obligatoire pour coordinateurs et administrateurs.
- Sessions courtes pour les fonctions sensibles.
- Réauthentification avant certaines actions.
- Révocation globale.
- Protection contre le bourrage d'identifiants.
- Limitation de tentatives.

## Autorisation

- Refus par défaut.
- Vérification systématique côté serveur.
- Pas de confiance dans les données client.
- Filtrage par organisation.
- Tests d'accès inter-organisations.
- Vérification des relations avec mission et ressource.

## Protection des données

- TLS.
- Chiffrement des données sensibles.
- URLs temporaires pour documents.
- Aucun document accessible publiquement.
- Masquage des coordonnées.
- Rétention minimale.
- Pas de données sensibles dans les logs.

## Sécurité des fichiers

- Taille limitée.
- Types MIME autorisés.
- Vérification de signature du fichier.
- Nom généré côté serveur.
- Analyse antivirus si disponible.
- Stockage séparé.
- Téléchargement via URL signée.
- Interdiction d'exécution.

## Sécurité API

- Validation de schéma.
- Rate limiting.
- Protection CSRF si cookies.
- En-têtes de sécurité.
- CSP.
- CORS restrictif.
- Limite de taille de corps.
- Identifiant de requête.
- Messages d'erreur neutres.

## Audit

Journaliser :

- connexion sensible ;
- publication ;
- affectation ;
- transition ;
- lecture de position exacte ;
- téléchargement de document ;
- suspension ;
- changement de rôle ;
- activation du mode lecture seule.

## Secrets

- Stockage dans le gestionnaire de secrets.
- Séparation par environnement.
- Rotation.
- Aucun secret dans le navigateur.
- Aucun secret dans les exemples.
- Détection automatique dans la CI.

## Menaces prioritaires

- compte coordinateur compromis ;
- usurpation d'organisation ;
- scraping des ressources ;
- fuite de positions ;
- double affectation ;
- modification d'une mission ;
- spam de notifications ;
- dépôt de fichier malveillant ;
- élévation de privilèges ;
- déni de service.

## Réponse

- suspendre le compte ;
- révoquer les sessions ;
- désactiver les missions ;
- passer en lecture seule ;
- masquer les positions ;
- conserver les preuves ;
- notifier les responsables ;
- documenter l'incident.

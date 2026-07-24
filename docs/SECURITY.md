# Modèle de sécurité

## Menaces principales

1. plan LLM malveillant ou incorrect ;
2. page Web essayant de commander l’extension ;
3. action sensible exécutée sans accord ;
4. fuite de session sociale ;
5. double envoi après reprise ;
6. mauvaise identité de compte ;
7. changement d’interface produisant un clic erroné ;
8. compte limité par la plateforme ;
9. jeton API exposé ;
10. appareil compromis.

## Contrôles déjà présents

- protocole fermé et validation Zod ;
- `SEND_MESSAGE` obligatoirement marqué `requiresApproval` ;
- seconde vérification dans le service worker ;
- injection du content script uniquement depuis l’extension ;
- messages internes marqués `source: NEPTUNE_AGENT` ;
- protocoles de navigation limités à HTTP et HTTPS ;
- arrêt en présence de signaux CAPTCHA ou activité inhabituelle ;
- journal d’audit distant ;
- bouton d’arrêt local ;
- aucun stockage de cookies ou mots de passe ;
- secret du Worker conservé dans Cloudflare Secrets.

## Durcissements requis avant production

### Authentification

Le jeton global du MVP doit être remplacé par :

- authentification utilisateur Neptune ;
- jeton d’appareil court et rotatif ;
- signature des commandes ;
- révocation d’appareil ;
- contrôle d’organisation et de rôle.

### Validations

Une autorisation de production devra être liée à :

- utilisateur ;
- appareil ;
- compte social ;
- événement ;
- empreinte du message ;
- destinataires ou critères exacts ;
- quota ;
- fenêtre d’exécution ;
- version de l’adaptateur.

Toute divergence invalide l’autorisation.

### Protection des données

- hacher les identifiants sociaux lorsque leur valeur brute n’est pas utile ;
- définir une durée de conservation ;
- chiffrer les exports ;
- supprimer les captures inutiles ;
- gérer les refus et listes d’opposition ;
- limiter les données transmises au LLM.

### Adaptateurs sociaux

Avant Instagram ou LinkedIn :

- adaptateur spécialisé ;
- vérification du compte connecté avant chaque lot ;
- selectors accessibles et versionnés ;
- tests sur environnement isolé ;
- quota dur par compte ;
- arrêt sur avertissement, déconnexion ou interface inconnue ;
- aucune logique de CAPTCHA, furtivité ou contournement.

## Incident response

Un incident doit pouvoir déclencher :

1. désactivation du compte ou de l’appareil ;
2. révocation des jetons ;
3. interruption de toutes les missions ;
4. export des journaux ;
5. identification des destinataires affectés ;
6. correction de l’adaptateur ;
7. nouvelle validation avant reprise.

## Règle de publication

La version Chrome Web Store ne doit être soumise qu’après :

- audit des permissions ;
- politique de confidentialité ;
- tests E2E ;
- suppression des URL et secrets de test ;
- signature de version ;
- revue du comportement sur chaque domaine déclaré.

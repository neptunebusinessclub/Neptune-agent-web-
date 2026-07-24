# Architecture technique

## 1. Frontière de confiance

Le système est scindé en deux zones :

- **navigateur local** : conserve les sessions, lit la page et exécute les actions ;
- **Cloudflare** : prépare le plan, persiste l’état, gère les validations et centralise l’audit.

Les cookies, mots de passe et jetons de session des sites visités ne quittent jamais le navigateur.

## 2. Composants

### Extension Manifest V3

- `sidepanel.ts` : commande utilisateur, aperçu du plan, validation, suivi et arrêt ;
- `service-worker.ts` : contrôle des onglets et seconde barrière de sécurité ;
- `content-script.ts` : adaptateur DOM générique injecté uniquement dans l’onglet actif ;
- `static/manifest.json` : permissions minimales du MVP.

### Protocole partagé

`packages/protocol` définit les actions autorisées et leurs invariants :

```text
OPEN_URL
READ_PAGE
CLICK_ELEMENT
FILL_FIELD
ASK_APPROVAL
SEND_MESSAGE
WAIT
STOP_TASK
```

Un plan ne peut pas introduire une nouvelle capacité sans modification, revue et publication du code de l’extension.

### Worker Cloudflare

Le Worker expose :

```text
GET  /health
POST /v1/missions
GET  /v1/missions/:missionId
POST /v1/missions/:missionId/approvals
POST /v1/missions/:missionId/events
GET  /v1/realtime/:deviceId
```

### D1

D1 stocke :

- missions ;
- actions ordonnées ;
- validations et dates d’expiration ;
- événements d’audit ;
- liste d’opposition minimale.

### Durable Objects

Un Durable Object est associé à chaque `deviceId`. Il maintient le canal WebSocket et diffuse les événements de mission aux clients autorisés. Le MVP expose la fondation ; la side panel utilise encore les réponses HTTP directes.

## 3. Cycle d’une mission

```text
Commande utilisateur
→ création API
→ planner fermé
→ validation Zod
→ persistance D1
→ affichage du plan
→ validation humaine si nécessaire
→ exécution locale séquentielle
→ événement après chaque étape
→ clôture ou arrêt
```

## 4. Niveaux de risque

| Niveau | Exemples | Exécution |
|---|---|---|
| `read_only` | ouvrir, lire | automatique après lancement |
| `draft_write` | préparer un texte | plan visible, aucune émission |
| `external_write` | envoyer, publier | validation obligatoire |
| `sensitive` | paiement, suppression, permissions | bloqué par défaut dans le MVP |

## 5. Idempotence future

Pour les campagnes événementielles, toute action de contact devra utiliser une clé :

```text
channel + account_id + recipient_hash + event_id + campaign_type
```

La base devra refuser toute duplication de cette combinaison.

## 6. Intégration LLM prévue

Le fournisseur LLM sera placé derrière une interface :

```ts
interface PlannerProvider {
  plan(input: MissionContext): Promise<unknown>;
}
```

La sortie restera non fiable jusqu’à :

1. validation par `browserActionSchema` ;
2. contrôle du Policy Engine ;
3. vérification des domaines et permissions ;
4. validation humaine des écritures externes.

Le LLM ne reçoit pas les secrets du navigateur et ne produit jamais de code exécutable.

## 7. Intégration Neptune Event OS

Le futur événement `event.vote_closed` créera une campagne contenant :

- club et ville ;
- événement, date et capacité restante ;
- URL d’inscription ;
- compte social autorisé ;
- règles de ciblage ;
- plafond d’invitations.

Le moteur générera une mission distincte par appareil et compte social. Une inscription reçue devra annuler immédiatement les actions restantes pour ce destinataire.

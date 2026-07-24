# Neptune Agent Web

MVP d’un **agent navigateur contrôlé** pour Neptune : une extension Chrome/Edge Manifest V3 exécute localement des actions limitées, tandis qu’un moteur central Cloudflare prépare les missions, conserve leur état, gère les validations et journalise chaque étape.

## Ce qui est déjà livré

- monorepo TypeScript avec pnpm ;
- extension Chrome/Edge avec panneau latéral Neptune ;
- ouverture d’URL, lecture de page, clic, saisie et attente ;
- catalogue d’actions fermé et validé par Zod ;
- blocage local des communications externes sans autorisation ;
- détection de CAPTCHA, activité inhabituelle et avertissements de plateforme ;
- moteur Cloudflare Workers avec API Hono ;
- persistance Cloudflare D1 ;
- canal temps réel Durable Objects avec WebSocket Hibernation ;
- journal d’audit des missions et actions ;
- workflow de validation à durée limitée ;
- arrêt manuel immédiat ;
- tests des invariants de sécurité du protocole.

## Architecture

```text
Extension Chrome / Edge
  ├─ Side Panel : commande, plan, validation, journal
  ├─ Service Worker : politique locale et orchestration des onglets
  └─ Content Script : lecture et actions DOM autorisées
                  │
                  ▼
Cloudflare Worker API
  ├─ D1 : missions, actions, validations, audit
  ├─ Durable Object : canal temps réel par appareil
  └─ Planner fermé : actions JSON connues uniquement
```

Le LLM n’exécute jamais de JavaScript arbitraire dans le navigateur. Toute future intégration LLM devra produire le même protocole JSON, puis passer la validation de schéma et le moteur de règles.

## Pré-requis

- Node.js 22 ou plus récent ;
- pnpm 10 ;
- compte Cloudflare ;
- Chrome ou Edge 114+.

## Installation locale

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## Configurer Cloudflare

### 1. Se connecter

```bash
cd workers/api
pnpm exec wrangler login
```

### 2. Créer D1

```bash
pnpm exec wrangler d1 create neptune-agent-db
```

Copier l’identifiant retourné dans `workers/api/wrangler.jsonc` à la place de `REPLACE_WITH_D1_DATABASE_ID`.

### 3. Définir le secret API

Générer un jeton long et aléatoire, puis :

```bash
pnpm exec wrangler secret put AGENT_API_TOKEN
```

Pour le développement local, créer `workers/api/.dev.vars` :

```dotenv
AGENT_API_TOKEN=remplacer-par-un-secret-long-et-aleatoire
```

### 4. Appliquer la base

```bash
pnpm db:migrate:local
pnpm db:migrate:remote
```

### 5. Démarrer le moteur local

Depuis la racine :

```bash
pnpm dev:api
```

L’API locale répond sur `http://127.0.0.1:8787`.

## Installer l’extension de test

```bash
pnpm --filter @neptune/extension build
```

Puis dans Chrome :

1. ouvrir `chrome://extensions` ;
2. activer **Mode développeur** ;
3. cliquer sur **Charger l’extension non empaquetée** ;
4. sélectionner `apps/extension/dist` ;
5. ouvrir Neptune Agent depuis l’icône de l’extension ;
6. renseigner l’URL API et le même jeton dans **Configuration**.

Après installation, récupérer l’identifiant de l’extension et remplacer `REPLACE_WITH_EXTENSION_ID` dans `workers/api/wrangler.jsonc`.

## Scénario de test

1. Saisir : `Ouvre Le Bon Coin et lis la page d’accueil.`
2. Cliquer sur **Préparer la mission**.
3. Contrôler le plan.
4. Cliquer sur **Exécuter les actions autorisées**.
5. Vérifier le journal local et les entrées D1.

Une mission contenant les mots `message`, `inviter`, `prospect`, `followers` ou `abonnés` est automatiquement placée en validation humaine avant toute action externe.

## Commandes

| Commande | Rôle |
|---|---|
| `pnpm dev:api` | Lancer le Worker local |
| `pnpm dev:extension` | Reconstruire l’extension en continu |
| `pnpm build` | Construire tous les modules |
| `pnpm typecheck` | Vérifier TypeScript |
| `pnpm test` | Exécuter les tests |

## Limites actuelles du MVP

- le planner est déterministe, pas encore connecté à un LLM ;
- l’adaptateur Instagram spécialisé n’est pas encore livré ;
- `SEND_MESSAGE` ne fonctionne que lorsqu’un champ et un bouton d’envoi non ambigus sont détectés ;
- aucune logique de contournement, de CAPTCHA, de furtivité ou d’anti-détection n’est prévue ;
- aucune collecte massive de followers n’est implémentée ;
- la publication Chrome Web Store reste à réaliser après audit des permissions et tests.

## Règles non négociables

- aucune remontée de cookies, mots de passe ou sessions vers Cloudflare ;
- aucune action externe sans autorisation explicite et non expirée ;
- arrêt immédiat en présence d’un avertissement de plateforme ;
- aucune exécution de code distant dans l’extension ;
- journalisation de chaque action et de son résultat ;
- adaptateurs spécialisés versionnés avant l’usage Instagram ou LinkedIn en production.

Voir également :

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/SECURITY.md`](docs/SECURITY.md)
- [`docs/ROADMAP.md`](docs/ROADMAP.md)

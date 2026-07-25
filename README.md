# Neptune — Assistant navigateur agentique

Neptune est une **extension Chrome Manifest V3 autonome**. Le client installe un seul composant, puis configure l’assistant directement dans le panneau latéral : prénom, voix, niveau de confiance, moteur d’intelligence, mot d’activation et accès aux sites.

Aucun Runtime Windows, serveur local ou jeton technique Neptune n’est nécessaire.

## Version actuelle

```text
Neptune 1.2 Multi-LLM
```

Neptune fonctionne par cycles courts :

```text
Observer la page
→ décider de la prochaine petite étape
→ exécuter une action contrôlée
→ vérifier le résultat
→ adapter le plan
→ terminer ou demander une intervention
```

Chaque mission est limitée à **16 cycles et 48 actions**. Neptune détecte les observations répétées afin d’éviter de tourner en boucle.

## Expérience produit

Au premier lancement, Neptune guide l’utilisateur en sept étapes :

1. prénom d’usage ;
2. choix et pré-écoute de la voix ;
3. niveau de confiance ;
4. moteur d’intelligence local ou cloud ;
5. mot d’activation `Neptune` ou `OK Neptune` et test du microphone ;
6. autorisation de l’onglet de travail ;
7. première démonstration.

Après l’onboarding, le panneau affiche uniquement :

- l’hologramme Neptune et son état ;
- la conversation textuelle ou vocale ;
- la progression agentique ;
- les demandes d’autorisation ;
- les blocages et la reprise au checkpoint ;
- l’arrêt immédiat ;
- les réglages et le journal local.

## Hub d’intelligence

### Neptune automatique

Neptune tente d’abord l’intelligence locale intégrée de Chrome. Lorsqu’elle n’est pas disponible, il peut utiliser le modèle WebLLM local recommandé pour le poste.

### Chrome intégré

Chrome télécharge et gère son propre modèle lorsque l’API Prompt est disponible. Aucun choix technique ni clé API n’est demandé.

### Modèles Neptune Local

Le client choisit un profil compréhensible plutôt qu’un nom technique :

- **Neptune Essentiel** : commandes simples et poste modeste ;
- **Neptune Rapide** : navigation quotidienne ;
- **Neptune Équilibré** : meilleur raisonnement général ;
- **Neptune Avancé** : pages complexes ;
- **Neptune Expert Local** : poste performant.

Les modèles compatibles présents dans le catalogue WebLLM sont exécutés avec WebGPU dans un **Web Worker séparé**, afin de préserver la fluidité du panneau. Le téléchargement est affiché en temps réel et les fichiers sont conservés dans IndexedDB pour les utilisations suivantes.

Le moteur recommandé dépend des ressources déclarées par le navigateur. L’utilisateur conserve toujours le dernier mot.

### Mammouth AI

L’utilisateur peut connecter sa propre clé Mammouth AI. Neptune utilise l’API compatible OpenAI et le modèle choisi.

### API compatible OpenAI

L’utilisateur peut renseigner un endpoint HTTPS, un nom de modèle et sa clé API. Les clés sont chiffrées localement avec AES-GCM et ne sont jamais stockées dans le code source.

## Architecture

```text
Extension Chrome Neptune
├── Side Panel agentique
│   ├── onboarding
│   ├── conversation et voix
│   ├── hub multi-LLM
│   ├── boucle observer-décider-agir-vérifier
│   ├── checkpoints et reprise
│   ├── permissions et validations
│   └── journal local
├── Worker WebLLM
│   ├── téléchargement des modèles
│   ├── cache IndexedDB
│   └── génération WebGPU hors du thread d’interface
├── Service Worker
│   ├── onglet de travail dédié
│   ├── navigation et exécution du protocole
│   ├── délais d’action
│   └── politique de sécurité
├── Content Script
│   ├── lecture structurée enrichie
│   ├── Shadow DOM et iframes accessibles
│   ├── ciblage accessible
│   ├── clics, saisies, listes, clavier et scroll
│   └── détection des protections de plateforme
└── Stockage local/session
    ├── préférences et historique
    ├── clés API chiffrées
    ├── modèles et sélection locale
    └── mission et checkpoint courant
```

Le LLM ne peut pas envoyer de JavaScript arbitraire. Il produit un JSON limité aux actions connues :

- `OPEN_URL`
- `READ_PAGE`
- `CLICK_ELEMENT`
- `FILL_FIELD`
- `SELECT_OPTION`
- `PRESS_KEY`
- `SCROLL_PAGE`
- `WAIT_FOR_ELEMENT`
- `NAVIGATE_BACK`
- `SEND_MESSAGE`
- `WAIT`

Les actions sont normalisées et contrôlées avant exécution. Après une navigation, un clic important, un envoi ou un scroll, Neptune réobserve la page avant de continuer.

## Sécurité

Neptune refuse d’automatiser :

- paiements et achats ;
- virements, IBAN et cartes bancaires ;
- mots de passe, OTP et codes secrets ;
- suppressions de compte ;
- signatures et engagements contractuels ;
- contournements de CAPTCHA ou protections de plateforme.

`SEND_MESSAGE` exige toujours une autorisation explicite. Une autorisation ne vaut que pour l’action concernée. Les contrôles ambigus ne sont pas activés.

## Résilience

- chaque mission est persistée dans `chrome.storage.session` ;
- la fermeture du panneau transforme la mission en checkpoint reprenable ;
- une erreur de cible relance une observation et une nouvelle décision ;
- une vérification humaine ou une connexion manquante suspend la mission ;
- trois observations identiques consécutives déclenchent un arrêt anti-boucle ;
- une génération locale peut être interrompue ;
- le bouton **Arrêter** interrompt toute action suivante.

## Construire le produit

Pré-requis développeur : Node.js 22 et pnpm 10.

```bash
pnpm install --no-frozen-lockfile
pnpm typecheck
pnpm test
pnpm --filter @neptune/extension build
```

Le dossier installable est :

```text
apps/extension/dist
```

## Installer la version de recette

1. ouvrir `chrome://extensions` ;
2. activer **Mode développeur** ;
3. cliquer sur **Charger l’extension non empaquetée** ;
4. sélectionner `apps/extension/dist` ou le dossier extrait du ZIP ;
5. ouvrir Neptune depuis l’icône de l’extension ;
6. suivre l’onboarding affiché automatiquement.

## Artefact de recette

GitHub Actions produit :

```text
neptune-extension-multillm-v1.2.0.zip
```

Le ZIP contient le moteur WebLLM, mais pas les poids des modèles. Ceux-ci sont téléchargés uniquement après le choix de l’utilisateur. Cet artefact est destiné à la recette interne et à la préparation de la soumission Chrome Web Store.

## Recette minimale

- première ouverture : onboarding affiché, aucune configuration technique ;
- choix d’une voix et pré-écoute ;
- test du mot d’activation ;
- affichage du hub de modèles locaux ;
- recommandation visible ;
- téléchargement d’un modèle avec progression ;
- réouverture du panneau : modèle toujours signalé comme prêt ;
- fournisseur cloud configurable en alternative ;
- autorisation des sites accordée ;
- commande : `Ouvre Le Bon Coin, cherche un bureau à Toulouse et résume les résultats.` ;
- nouvel onglet Neptune créé ;
- plusieurs cycles observation/action visibles dans les détails ;
- erreur de cible : réobservation et adaptation sans repartir de zéro ;
- envoi externe bloqué jusqu’à validation ;
- CAPTCHA ou avertissement de plateforme : mission suspendue ;
- fermeture puis réouverture du panneau : checkpoint proposé ;
- arrêt immédiat : aucune action suivante exécutée.

## Limites assumées de la version 1.2

- le mot d’activation fonctionne tant que le panneau Neptune reste ouvert ;
- la reconnaissance et la synthèse vocales dépendent des services disponibles dans Chrome et le système ;
- les modèles WebLLM nécessitent WebGPU et suffisamment de mémoire ;
- l’intelligence Chrome intégrée dépend de la compatibilité Chrome et matérielle du poste ;
- aucun scraping massif ou envoi en volume n’est inclus ;
- aucune logique de furtivité ou d’anti-détection n’est développée ;
- une recette réelle sur les plateformes prioritaires reste nécessaire avant diffusion commerciale générale.

Voir également :

- [`docs/PRODUCTION_SCOPE.md`](docs/PRODUCTION_SCOPE.md)
- [`docs/SECURITY.md`](docs/SECURITY.md)
- [`apps/extension/static/privacy.html`](apps/extension/static/privacy.html)

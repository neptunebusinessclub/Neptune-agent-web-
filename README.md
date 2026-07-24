# Neptune — Assistant navigateur

Neptune est une **extension Chrome Manifest V3 autonome**. Le client installe un seul composant, puis configure l’assistant directement dans le panneau latéral : prénom, voix, niveau de confiance, intelligence locale ou cloud, mot d’activation et accès aux sites.

Aucun Runtime Windows, serveur local ou jeton technique Neptune n’est nécessaire.

## Expérience produit

Au premier lancement, Neptune guide l’utilisateur en sept étapes :

1. prénom d’usage ;
2. choix et pré-écoute de la voix ;
3. niveau de confiance ;
4. moteur d’intelligence ;
5. mot d’activation `Neptune` ou `OK Neptune` ;
6. autorisation de l’onglet de travail ;
7. première démonstration.

Après l’onboarding, le panneau affiche uniquement :

- l’hologramme Neptune et son état ;
- la conversation textuelle ou vocale ;
- les demandes d’autorisation ;
- les blocages et boutons de reprise ;
- l’arrêt immédiat ;
- un écran de réglages et un journal local.

## Intelligence

### Chrome AI local

Neptune utilise l’API Prompt intégrée à Chrome lorsque le poste est compatible. Chrome télécharge et gère le modèle local. Après installation, les échanges peuvent être traités sur l’ordinateur.

### Mammouth AI

L’utilisateur peut connecter sa propre clé Mammouth AI. Neptune utilise l’API compatible OpenAI et le modèle recommandé par défaut.

### API compatible OpenAI

L’utilisateur peut renseigner un endpoint HTTPS, un nom de modèle et sa clé API. Les clés sont chiffrées localement avec AES-GCM et ne sont jamais stockées dans le code source.

## Architecture

```text
Extension Chrome Neptune
├── Side Panel
│   ├── onboarding
│   ├── conversation et voix
│   ├── sélection du LLM
│   ├── permissions et validations
│   └── journal local
├── Service Worker
│   ├── onglet de travail dédié
│   ├── exécution du protocole d’actions
│   └── politique de sécurité
├── Content Script
│   ├── lecture structurée de page
│   ├── ciblage accessible
│   └── clics et saisies contrôlés
└── Stockage local
    ├── préférences et historique
    └── clés API chiffrées
```

Le LLM ne peut pas envoyer du JavaScript arbitraire. Il produit un plan JSON limité aux actions connues :

- `OPEN_URL`
- `READ_PAGE`
- `CLICK_ELEMENT`
- `FILL_FIELD`
- `SEND_MESSAGE`
- `WAIT`

Le plan est normalisé et contrôlé avant exécution.

## Sécurité

Neptune refuse d’automatiser :

- paiements et achats ;
- virements, IBAN et cartes bancaires ;
- mots de passe et codes secrets ;
- suppressions de compte ;
- signatures et engagements contractuels ;
- contournements de CAPTCHA ou protections de plateforme.

`SEND_MESSAGE` exige toujours une autorisation explicite. Les contrôles ambigus ne sont pas activés.

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

## Installer la version de test

1. ouvrir `chrome://extensions` ;
2. activer **Mode développeur** ;
3. cliquer sur **Charger l’extension non empaquetée** ;
4. sélectionner `apps/extension/dist` ;
5. ouvrir Neptune depuis l’icône de l’extension ;
6. suivre l’onboarding affiché automatiquement.

## Artefact de production

Après fusion dans `main`, GitHub Actions produit :

```text
neptune-extension-production-v1.0.0.zip
```

Cet artefact est prêt pour les tests de recette et la soumission Chrome Web Store. La publication publique nécessite encore le compte éditeur, les visuels de fiche, l’URL publique de confidentialité et la validation de Google.

## Recette minimale

- première ouverture : onboarding affiché, aucune configuration technique ;
- choix d’une voix et pré-écoute ;
- Chrome AI local ou fournisseur cloud configuré ;
- autorisation des sites accordée depuis l’onboarding ;
- commande : `Ouvre Le Bon Coin et lis la page d’accueil.` ;
- nouvel onglet Neptune créé ;
- page lue et résultat résumé dans la conversation ;
- envoi externe bloqué jusqu’à validation ;
- CAPTCHA ou avertissement de plateforme : mission suspendue ;
- arrêt immédiat : aucune action suivante exécutée.

## Limitations assumées de la version 1.0

- le mot d’activation fonctionne lorsque le panneau Neptune reste ouvert ;
- la reconnaissance vocale dépend du service disponible dans Chrome ;
- l’intelligence locale dépend de la compatibilité Chrome et matérielle du poste ;
- aucun scraping massif ou envoi en volume n’est inclus ;
- aucune logique de furtivité ou d’anti-détection n’est développée.

Voir également :

- [`docs/PRODUCTION_SCOPE.md`](docs/PRODUCTION_SCOPE.md)
- [`docs/SECURITY.md`](docs/SECURITY.md)
- [`apps/extension/static/privacy.html`](apps/extension/static/privacy.html)

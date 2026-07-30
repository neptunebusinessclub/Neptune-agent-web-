# Neptune 1.8 — Assistant navigateur avec Hermes intégré

Neptune est un assistant navigateur vocal et agentique pour Chrome. Depuis la version 1.8, **Hermes Agent est le cerveau principal géré par Neptune** : l’utilisateur ne renseigne aucune URL, clé API, variable CORS ou commande terminal.

## Produit livré

Le package Windows contient deux éléments :

```text
NeptuneSetup.exe
neptune-extension-managed-v1.8.0.zip
```

`NeptuneSetup.exe` s’exécute une seule fois et provisionne automatiquement :

- Hermes Agent officiel, dans une version épinglée ;
- llama.cpp pour l’inférence locale ;
- Qwen3-4B Q4_K_M comme modèle équilibré ;
- la mémoire et les compétences Hermes ;
- une clé locale aléatoire, invisible pour l’utilisateur ;
- le pont Native Messaging entre Chrome et le moteur local ;
- le démarrage automatique et la réparation du runtime.

Tous les services écoutent uniquement sur `127.0.0.1`.

## Expérience utilisateur

L’accueil reste limité à quatre étapes :

1. prénom d’usage ;
2. voix féminine ou masculine ;
3. test « Neptune » ou « OK Neptune » ;
4. préparation automatique de Hermes.

Aucun choix de fournisseur ni réglage technique n’est affiché pendant l’accueil.

Les fournisseurs alternatifs restent disponibles uniquement dans les paramètres avancés comme moteurs de secours.

## Voix françaises embarquées

Le ZIP Chrome contient directement :

- une voix féminine française Piper ;
- une voix masculine française Piper ;
- le phonétiseur WebAssembly ;
- ONNX Runtime Web ;
- le Worker de synthèse.

Le texte à prononcer et l’audio généré restent sur l’ordinateur. La voix Windows n’est pas utilisée dans le parcours normal.

## Cerveau Hermes géré

L’extension appelle un host Native Messaging à commandes fermées :

```text
ensure
status
repair
```

Le host ne reçoit aucune commande shell arbitraire. Il vérifie ou démarre le runtime déjà installé par Neptune, puis renvoie uniquement une connexion locale validée.

La boucle agentique suit :

```text
Observer
→ décider avec Hermes
→ agir dans Chrome
→ vérifier
→ adapter
→ terminer ou demander une intervention
```

Hermes apporte notamment :

- mémoire persistante ;
- compétences réutilisables ;
- recherche et outils locaux ;
- continuité de session ;
- planification adaptative.

Neptune conserve le contrôle des onglets, les validations humaines, la politique de sécurité et l’arrêt immédiat.

## Espace de travail adaptatif

Avant une mission navigateur, Neptune propose :

- **Prendre le relais ici** ;
- **Nouvel onglet** ;
- **Nouvelle fenêtre**.

Le choix recommandé dépend de la formulation de la demande et de la page active.

## Sécurité

Neptune refuse d’automatiser :

- paiements, achats et virements ;
- mots de passe, OTP, IBAN et cartes bancaires ;
- suppressions de compte ;
- signatures et engagements contractuels ;
- contournements de CAPTCHA ou protections de plateforme.

Les communications externes nécessitent toujours une autorisation explicite limitée à l’action concernée.

Le runtime géré applique également :

- services limités au loopback ;
- clé générée localement ;
- manifeste Native Messaging limité à l’identifiant fixe de Neptune ;
- vérification SHA-256 des téléchargements llama.cpp et Qwen ;
- versions de dépendances épinglées ;
- journaux locaux de diagnostic.

## Configuration minimale Windows

- Windows 10 ou 11 x64 ;
- Chrome 138 ou version ultérieure ;
- 16 Go de RAM minimum ;
- environ 6 Go d’espace disque libre ;
- connexion Internet lors de la première installation.

Le premier lancement télécharge environ 2,5 Go pour le modèle Qwen, ainsi que les dépendances Hermes et llama.cpp. Les usages suivants peuvent fonctionner localement.

## Installation

1. lancer `NeptuneSetup.exe` ;
2. attendre le message confirmant que Hermes est opérationnel ;
3. décompresser `neptune-extension-managed-v1.8.0.zip` dans un dossier permanent ;
4. ouvrir `chrome://extensions` ;
5. activer **Mode développeur** ;
6. cliquer sur **Charger l’extension non empaquetée** ;
7. sélectionner le dossier contenant directement `manifest.json`.

Aucune autre configuration n’est requise.

## Construction et validation

Pré-requis de développement : Node.js 22, pnpm 10.13.1 et Go 1.23.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm --filter @neptune/extension build
```

Sous Windows :

```powershell
powershell -ExecutionPolicy Bypass -File apps/managed-runtime/scripts/build-windows.ps1
```

La CI valide :

- TypeScript et tests unitaires ;
- extension chargée dans un véritable Chromium ;
- voix féminine et masculine ;
- persistance de l’arrêt ;
- scripts PowerShell ;
- tests Go ;
- protocole Native Messaging ;
- package Chrome ;
- `NeptuneSetup.exe` ;
- artefact Windows final réunissant les deux composants.

## Limites assumées

- la première distribution zéro configuration cible Windows x64 ;
- la compatibilité métier de chaque site doit être testée sur ses parcours réels ;
- aucun scraping massif, mécanisme de furtivité ou contournement de plateforme n’est inclus ;
- l’installateur n’est pas considéré comme publiquement distribuable tant qu’il n’est pas signé avec un certificat de signature de code.

Voir également :

- [`apps/managed-runtime/README.md`](apps/managed-runtime/README.md)
- [`docs/SECURITY.md`](docs/SECURITY.md)
- [`apps/extension/static/privacy.html`](apps/extension/static/privacy.html)

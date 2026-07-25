# Neptune — Assistant navigateur local et adaptatif

Neptune est une **extension Chrome Manifest V3 autonome**. Le client installe un seul composant. Aucun Runtime Windows, serveur local ou jeton technique Neptune n’est requis.

## Version actuelle

```text
Neptune 1.5 Experience
```

Cette version remplace le parcours technique des versions précédentes par une configuration courte et compréhensible.

## Accueil en quatre étapes

1. prénom d’usage ;
2. choix entre **Voix féminine** et **Voix masculine** ;
3. test préconfiguré avec `Neptune` ou `OK Neptune` ;
4. préparation automatique de **Neptune Équilibré**, le cerveau local par défaut.

Les modèles alternatifs, fournisseurs cloud, clés API et niveaux de contrôle restent accessibles dans **Paramètres avancés**. Ils ne sont plus exposés pendant l’accueil.

## Voix intégrées

Le package contient directement deux modèles vocaux français Piper et leur runtime WebAssembly :

- **Voix féminine** : naturelle, claire et chaleureuse ;
- **Voix masculine** : posée, profonde et professionnelle.

Aucune voix Windows n’est utilisée dans le parcours Neptune. Aucun modèle vocal n’est téléchargé lors du premier lancement. La synthèse s’effectue localement dans un Web Worker séparé.

Lorsque Neptune parle, l’écoute est mise en pause pour éviter l’auto-déclenchement. Le bouton **Arrêter** interrompt la parole, la génération en cours et les actions suivantes.

## Cerveau local par défaut

Neptune sélectionne automatiquement le profil local équilibré :

```text
Neptune Équilibré
Qwen2.5 1.5B Instruct — quantification locale WebLLM
```

Le modèle est préparé pendant la dernière étape d’accueil et conservé dans le cache local de Chrome. Le client n’a pas besoin de connaître son identifiant technique.

Les options suivantes restent disponibles dans les paramètres avancés :

- autres modèles WebLLM locaux ;
- intelligence intégrée de Chrome ;
- Mammouth AI ;
- API compatible OpenAI.

Les clés de fournisseurs cloud sont chiffrées localement avec AES-GCM.

## Intelligence adaptative

Neptune ne déroule pas un scénario complet à l’aveugle. Chaque mission suit une boucle courte :

```text
Observer la page
→ décider de la prochaine petite étape
→ agir
→ vérifier le résultat
→ adapter le plan
→ terminer ou demander une intervention
```

Chaque mission est limitée à **16 cycles et 48 actions**. Les observations répétées déclenchent une protection anti-boucle.

### Choix de l’espace de travail

Avant une mission navigateur, Neptune analyse la demande et propose le contexte le plus cohérent :

- **Prendre le relais ici** : utilise la page déjà ouverte ;
- **Nouvel onglet** : isole la mission sans perturber la navigation actuelle ;
- **Nouvelle fenêtre** : crée un espace entièrement dédié.

Les formulations explicites telles que « dans une nouvelle fenêtre » sont respectées. Lorsqu’une demande concerne « cette page » ou « cet onglet », Neptune recommande la prise de relais sur la page active.

## Interface

L’interface repose sur un seul moteur de rendu et un seul gestionnaire d’actions. Les anciennes surcouches DOM ont été retirées.

L’hologramme central est un **spectre audio circulaire**. Son amplitude, sa vitesse et son apparence évoluent selon l’état :

- prêt ;
- écoute ;
- réflexion ;
- exécution ;
- parole ;
- autorisation ;
- blocage ;
- erreur.

## Actions navigateur contrôlées

Le moteur accepte uniquement les actions prévues par le protocole :

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

Le modèle ne peut pas injecter de JavaScript arbitraire. Après une navigation, un clic important, un envoi ou un défilement, Neptune réobserve la page avant de continuer.

## Activation vocale

`Neptune` et `OK Neptune` sont préconfigurés. Lorsque Chrome reste ouvert, un document hors écran peut maintenir l’écoute après autorisation du microphone. Si aucune interface Neptune n’est visible, une fenêtre compacte peut recevoir la commande détectée.

La disponibilité réelle de la reconnaissance vocale dépend des capacités de Chrome sur le poste utilisé.

## Sécurité

Neptune refuse d’automatiser :

- paiements et achats ;
- virements, IBAN et cartes bancaires ;
- mots de passe, OTP et codes secrets ;
- suppressions de compte ;
- signatures et engagements contractuels ;
- contournements de CAPTCHA ou protections de plateforme.

`SEND_MESSAGE` exige une autorisation explicite. Une autorisation ne vaut que pour l’action concernée.

## Résilience

- mission persistée dans `chrome.storage.session` ;
- reprise au dernier checkpoint après fermeture ;
- réobservation après erreur de cible ;
- suspension sur authentification ou vérification humaine ;
- arrêt anti-boucle après stagnation ;
- interruption immédiate par **Arrêter**.

## Construire le produit

Pré-requis développeur : Node.js 22 et pnpm 10.

```bash
pnpm install --no-frozen-lockfile
pnpm typecheck
pnpm test
pnpm --filter @neptune/extension build
```

La construction vérifie et intègre les deux voix françaises et leur runtime dans :

```text
apps/extension/dist
```

## Installer la version de recette

1. ouvrir `chrome://extensions` ;
2. activer **Mode développeur** ;
3. cliquer sur **Charger l’extension non empaquetée** ;
4. sélectionner le dossier extrait contenant directement `manifest.json` ;
5. ouvrir Neptune depuis l’icône de l’extension ;
6. suivre les quatre étapes affichées.

## Artefact de recette

GitHub Actions produit :

```text
neptune-extension-experience-v1.5.0.zip
```

Le ZIP contient les deux voix, Piper, ONNX Runtime, WebLLM et l’interface Neptune. Seuls les poids du cerveau local sont préparés et mis en cache lors du premier accueil.

## Recette prioritaire

- écouter les deux voix sans accès à une voix système ;
- valider `Neptune` et `OK Neptune` ;
- vérifier que Neptune Équilibré se prépare automatiquement ;
- ouvrir les paramètres et constater que les fournisseurs sont uniquement dans la zone avancée ;
- tester : `Prends le relais sur cette page et résume-la.` ;
- tester : `Ouvre un nouvel onglet et cherche un bureau à Toulouse.` ;
- tester : `Ouvre une nouvelle fenêtre et cherche un hôtel à Montpellier.` ;
- tester l’autorisation d’un envoi externe ;
- tester l’arrêt immédiat ;
- fermer puis rouvrir le panneau et reprendre une mission au checkpoint.

## Limites de recette

- une validation réelle dans Chrome reste nécessaire avant diffusion commerciale générale ;
- les modèles WebLLM nécessitent WebGPU et suffisamment de mémoire ;
- la reconnaissance vocale dépend du service disponible dans Chrome ;
- aucun scraping massif, envoi en volume, mécanisme de furtivité ou contournement de plateforme n’est inclus.

Voir également :

- [`docs/PRODUCTION_SCOPE.md`](docs/PRODUCTION_SCOPE.md)
- [`docs/SECURITY.md`](docs/SECURITY.md)
- [`apps/extension/static/privacy.html`](apps/extension/static/privacy.html)

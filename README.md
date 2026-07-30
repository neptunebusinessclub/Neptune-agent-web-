# Neptune — Assistant navigateur local, vocal et adaptatif

Neptune est une **extension Chrome Manifest V3 autonome**. Le client installe un seul composant. Aucun Runtime Windows, serveur local ou jeton technique Neptune n’est requis.

## Version actuelle

```text
Neptune 1.6 Hardened
```

Cette version corrige les défauts bloquants constatés dans Neptune 1.5 et ajoute une recette automatique dans un véritable Chromium sous Linux et Windows.

## Accueil en quatre étapes

1. prénom d’usage ;
2. choix entre **Voix féminine** et **Voix masculine** ;
3. test préconfiguré avec `Neptune` ou `OK Neptune` ;
4. préparation automatique du cerveau local compatible avec le poste.

Les modèles alternatifs, fournisseurs cloud, clés API et niveaux de contrôle restent dans **Paramètres avancés**.

## Voix françaises embarquées

Le ZIP contient directement :

- une voix féminine française Piper ;
- une voix masculine française Piper ;
- le phonétiseur WebAssembly ;
- ONNX Runtime Web ;
- le Worker de synthèse.

Aucune voix Windows n’est utilisée dans le parcours normal. Au premier usage, Neptune copie les fichiers déjà contenus dans l’extension vers le stockage privé OPFS de Chrome, attend la fin réelle des écritures et vérifie leur taille avant l’inférence. Aucun téléchargement vocal externe n’est requis.

Les opérations Piper sont sérialisées afin d’éviter deux préparations concurrentes. La synthèse et la lecture disposent de délais maximaux et d’une récupération explicite. Le changement de voix réinitialise la session Piper pour éviter la réutilisation du modèle précédent.

## Cerveau local adaptatif

Neptune choisit automatiquement le modèle local le plus cohérent avec les ressources déclarées par le navigateur :

1. modèle recommandé pour le poste ;
2. Neptune Équilibré lorsque le poste le permet ;
3. profil rapide ;
4. profil léger ;
5. intelligence locale intégrée à Chrome lorsqu’elle est disponible.

L’état **Prêt** n’est affiché qu’après une véritable réponse d’inférence. Si aucun moteur local n’est compatible, Neptune l’indique clairement et laisse les fournisseurs externes dans les paramètres avancés.

## Boucle agentique

Chaque mission suit un cycle court :

```text
Observer
→ décider de la prochaine action
→ agir
→ vérifier
→ adapter
→ terminer ou demander une intervention
```

Une mission est limitée à **16 cycles et 48 actions**. La stagnation, les CAPTCHA, l’authentification manquante et les cibles ambiguës suspendent l’exécution.

## Espace de travail adaptatif

Avant une mission navigateur, Neptune propose :

- **Prendre le relais ici** pour la page actuelle ;
- **Nouvel onglet** pour isoler la mission ;
- **Nouvelle fenêtre** pour un espace entièrement dédié.

Les formulations explicites de l’utilisateur sont respectées.

## Résilience et arrêt

- mission et checkpoint conservés dans `chrome.storage.session` ;
- arrêt persistant dans `chrome.storage.session` ;
- contrôle de l’état avant et après chaque action ;
- reprise après fermeture du panneau ;
- réobservation après erreur de cible ;
- verrouillage par action plutôt qu’un verrou global de toute l’interface ;
- délais maximaux pour le Worker vocal, la synthèse et la lecture.

Le bouton **Arrêter** reste effectif après la terminaison et le redémarrage du service worker.

## Interface

L’interface utilise un seul moteur de rendu et un seul répartiteur d’actions. Aucun gestionnaire JavaScript inline n’est autorisé dans le package de production.

Le spectre circulaire est centré par un rayon géométrique explicite. Pendant la lecture audio, son amplitude reçoit les mesures d’un `AnalyserNode` Web Audio plutôt qu’une animation purement décorative.

## Sécurité

Neptune refuse d’automatiser :

- paiements, achats et virements ;
- mots de passe, OTP, IBAN et cartes bancaires ;
- suppressions de compte ;
- signatures et engagements contractuels ;
- contournements de CAPTCHA ou protections de plateforme.

`SEND_MESSAGE` exige une autorisation explicite limitée à l’action concernée.

## Construction reproductible

Pré-requis : Node.js 22 et pnpm 10.13.1.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm --filter @neptune/extension build
```

Le dépôt contient `pnpm-lock.yaml`. La CI refuse une installation dont le graphe de dépendances diffère du lockfile.

## Validation obligatoire

`pnpm test` :

1. construit l’extension finale ;
2. exécute les tests unitaires ;
3. installe un Chromium de test compatible avec les extensions non empaquetées ;
4. charge réellement Neptune ;
5. vérifie que **Continuer** s’active après la saisie du prénom ;
6. prépare et préécoute les voix féminine et masculine ;
7. refuse toute exception `ReferenceError`, erreur Worker ou dépendance `chrome.*` dans le Worker vocal ;
8. arrête une mission ;
9. termine le service worker ;
10. vérifie que l’arrêt reste persistant après son redémarrage.

La CI exécute cette recette sous **Ubuntu** et **Windows**. Elle inspecte également le ZIP final, ses ressources vocales, son manifeste, l’absence de source maps, d’anciens composants Runtime, de scripts inline et de dépendances vocales CDN.

## Installation de la version de recette

1. ouvrir `chrome://extensions` ;
2. supprimer une ancienne version de Neptune ;
3. activer **Mode développeur** ;
4. décompresser `neptune-extension-hardened-v1.6.0.zip` ;
5. cliquer sur **Charger l’extension non empaquetée** ;
6. sélectionner le dossier contenant directement `manifest.json` ;
7. ouvrir Neptune et suivre les quatre étapes.

## Limites assumées

- les modèles WebLLM nécessitent WebGPU et suffisamment de mémoire ;
- la reconnaissance vocale dépend des capacités disponibles dans Chrome ;
- la compatibilité métier de chaque plateforme web doit être validée sur ses comptes et parcours réels avant un déploiement commercial général ;
- aucun scraping massif, envoi en volume, mécanisme de furtivité ou contournement de plateforme n’est inclus.

Voir également :

- [`docs/PRODUCTION_SCOPE.md`](docs/PRODUCTION_SCOPE.md)
- [`docs/SECURITY.md`](docs/SECURITY.md)
- [`apps/extension/static/privacy.html`](apps/extension/static/privacy.html)

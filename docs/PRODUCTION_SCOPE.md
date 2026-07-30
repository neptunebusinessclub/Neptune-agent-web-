# Neptune 1.6 Hardened — périmètre de livraison

Neptune est livré comme une extension Chrome Manifest V3 autonome. Le client installe uniquement l’extension. Aucun Runtime Windows, serveur local ou jeton technique Neptune n’est requis.

## Fonctions livrées

- onboarding en quatre étapes ;
- prénom d’usage ;
- voix féminine et masculine françaises embarquées ;
- activation `Neptune` et `OK Neptune` préconfigurée ;
- cerveau local sélectionné selon les capacités du poste et validé par une inférence réelle ;
- fournisseurs alternatifs conservés dans les paramètres avancés ;
- conversation textuelle et vocale ;
- boucle agentique observer, décider, agir, vérifier et adapter ;
- choix contextuel entre page actuelle, nouvel onglet et nouvelle fenêtre ;
- navigation, lecture, clics, saisie, listes, clavier, défilement et attente contrôlés ;
- validation des communications externes ;
- checkpoints, protection anti-boucle et reprise après blocage ;
- arrêt persistant vérifié avant et après chaque action ;
- stockage local chiffré des clés fournisseur.

## Durcissement du runtime

- aucune dépendance `chrome.*` dans le Worker Piper ;
- ressources vocales et runtimes WebAssembly contenus dans le ZIP ;
- copie OPFS attendue et vérifiée ;
- opérations Piper sérialisées ;
- réinitialisation de session lors d’un changement de voix ;
- délais maximaux pour préparation, synthèse et lecture ;
- verrouillage par action plutôt qu’un verrou global ;
- aucun gestionnaire JavaScript inline ;
- construction portable Linux et Windows ;
- dépendances figées dans `pnpm-lock.yaml`.

## Validation automatique obligatoire

La livraison est bloquée si l’un des contrôles suivants échoue :

- typage TypeScript ;
- tests unitaires ;
- construction Manifest V3 ;
- inspection des fichiers du ZIP ;
- absence de source maps et d’anciens composants Runtime ;
- absence de CDN vocal et de `chrome.runtime` dans le Worker vocal ;
- test de l’onboarding dans un véritable Chromium ;
- activation du bouton Continuer après la saisie du prénom ;
- préécoute complète des deux voix ;
- absence d’exception console ;
- arrêt de mission conservé après redémarrage forcé du service worker ;
- recette équivalente sous Ubuntu et Windows.

## Limites assumées

- la reconnaissance vocale dépend des capacités disponibles dans Chrome ;
- WebLLM nécessite WebGPU et suffisamment de mémoire ;
- chaque plateforme web prioritaire doit faire l’objet d’une recette fonctionnelle avec ses comptes, parcours et règles réels avant déploiement commercial général ;
- Neptune ne contourne jamais les CAPTCHA, protections de plateforme ou restrictions de compte ;
- les paiements, suppressions, mots de passe, signatures et engagements contractuels ne sont jamais automatisés ;
- aucun scraping massif, envoi en volume ou mécanisme de furtivité n’est inclus.

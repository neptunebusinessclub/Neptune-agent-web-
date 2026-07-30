# Neptune Managed Hermes Runtime

Ce composant Windows transforme Hermes Agent en moteur géré par Neptune.

## Expérience utilisateur

1. l’utilisateur lance `NeptuneSetup.exe` une seule fois ;
2. l’installateur provisionne Hermes Agent, llama.cpp et Qwen3-4B ;
3. Neptune génère et protège lui-même la clé locale ;
4. Chrome communique avec `com.neptune.hermes` par Native Messaging ;
5. le moteur démarre et se répare sans URL, clé API, CORS ou terminal à configurer.

## Sécurité

- tous les services écoutent uniquement sur `127.0.0.1` ;
- l’origine Chrome autorisée est l’identifiant fixe de Neptune ;
- la clé Hermes est générée localement et limitée au compte Windows courant ;
- le host Native Messaging expose uniquement `ensure`, `status` et `repair` ;
- les téléchargements llama.cpp et Qwen sont contrôlés par SHA-256 ;
- Hermes est installé depuis une version officielle épinglée ;
- aucune commande arbitraire fournie par l’extension n’est exécutée.

## Ressources installées

```text
%LOCALAPPDATA%\Neptune\Hermes
├── NeptuneHermesHost.exe
├── start-runtime.ps1
├── connection.json
├── hermes-agent
├── hermes-home
├── llama
├── models
└── logs
```

Le modèle par défaut est `Qwen3-4B-Q4_K_M` avec un contexte de 65 536 jetons. Le poste doit disposer d’au moins 16 Go de RAM.

## Construction

Sous Windows avec Go 1.23+ :

```powershell
powershell -ExecutionPolicy Bypass -File apps/managed-runtime/scripts/build-windows.ps1
```

Artefacts :

- `apps/managed-runtime/dist/NeptuneSetup.exe`
- `apps/managed-runtime/dist/NeptuneHermesHost.exe`

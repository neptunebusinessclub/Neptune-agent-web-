# Neptune Runtime v0.3

## Livré dans ce lot

- coque produit desktop Tauri + React ;
- onboarding prénom, voix, confiance et intelligence ;
- interface conversationnelle client ;
- hologramme Neptune animé par états ;
- dictée système de secours ;
- galerie LM Studio, Ollama et fournisseurs cloud ;
- détection locale de LM Studio et Ollama ;
- appel conversationnel LM Studio/Ollama ;
- stockage des clés cloud dans le coffre du système via `keyring` ;
- paramètres wake word préparés ;
- séparation nette entre vue client et détails techniques.

## Non simulé

Les fonctions suivantes sont volontairement affichées comme non finalisées plutôt que prétendues opérationnelles :

- écoute permanente « Neptune » / « OK Neptune » ;
- moteur local sherpa-onnx ;
- voix Kokoro/Piper installables ;
- téléchargement guidé de modèles ;
- Native Messaging vers l’extension ;
- reprise conversationnelle automatique d’une mission navigateur bloquée.

## Développement local

### Prévisualisation frontend

```bash
pnpm install --no-frozen-lockfile
pnpm dev:runtime
```

### Application Windows Tauri

Prérequis : Rust, Microsoft C++ Build Tools et WebView2.

```bash
pnpm install --no-frozen-lockfile
pnpm desktop:runtime
```

## Moteurs locaux

### LM Studio

Neptune teste par défaut :

```text
http://127.0.0.1:1234/v1/models
```

Puis utilise l’endpoint compatible OpenAI :

```text
/v1/chat/completions
```

### Ollama

Neptune teste :

```text
http://127.0.0.1:11434/api/tags
```

Puis utilise :

```text
/api/chat
```

## Sécurité

- aucune clé cloud dans `localStorage`, D1 ou l’extension ;
- coffre natif Windows via `keyring` ;
- aucune transmission de cookies ou mots de passe ;
- les actions sensibles restent sous le contrôle du Policy Engine ;
- le frontend ne peut pas contourner les protections des plateformes.

## Prochain lot

1. Native Messaging entre Runtime et extension ;
2. moteur audio local sherpa-onnx ;
3. wake word local ;
4. TTS Kokoro/Piper avec catalogue et pré-écoute ;
5. téléchargement de modèles Ollama/LM Studio ;
6. gestion conversationnelle des blocages et checkpoints navigateur.

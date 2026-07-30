# Hermes Agent dans Neptune

Hermes Agent est un cerveau optionnel avancé. Neptune reste l’interface client, le moteur vocal et le contrôleur du navigateur local.

## Architecture

```text
Neptune Chrome
├── conversation et voix
├── validations humaines
├── planification navigateur locale prioritaire
├── actions dans l’onglet choisi
└── connexion sécurisée à Hermes
        ├── mémoire persistante
        ├── compétences
        ├── recherche et outils
        ├── délégation
        └── continuité de session
```

Les outils Hermes s’exécutent sur l’hôte Hermes. Ils ne contrôlent pas directement l’onglet Chrome de Neptune.

## Préparation de Hermes

Installez et configurez Hermes Agent depuis sa documentation officielle, puis ajoutez dans `~/.hermes/.env` :

```env
API_SERVER_ENABLED=true
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8642
API_SERVER_KEY=remplacez-par-une-cle-longue-et-aleatoire
API_SERVER_CORS_ORIGINS=chrome-extension://IDENTIFIANT_NEPTUNE
```

L’origine exacte à autoriser est affichée dans Neptune :

```text
Paramètres → Paramètres avancés → Hermes Agent → Configuration Hermes requise
```

Démarrez ensuite Hermes :

```bash
hermes gateway
```

Le serveur local attendu est :

```text
http://127.0.0.1:8642
```

## Connexion dans Neptune

1. Ouvrez **Paramètres**.
2. Ouvrez **Paramètres avancés**.
3. Dans **Fournisseur**, choisissez **Hermes Agent — mémoire et compétences**.
4. Laissez l’adresse locale proposée ou renseignez votre serveur HTTPS auto-hébergé.
5. Saisissez la valeur de `API_SERVER_KEY`.
6. Cliquez sur **Connecter Hermes**.

Neptune vérifie :

- `/health` ;
- `/v1/capabilities` ;
- `/v1/models` ;
- `/v1/skills` lorsque cette route est disponible.

La clé reste chiffrée dans le profil Chrome via AES-GCM.

## Continuité et mémoire

Neptune crée une identité de session Hermes persistante et transmet :

- `X-Hermes-Session-Id` pour la continuité conversationnelle ;
- `X-Hermes-Session-Key` pour le périmètre mémoire associé à Neptune.

Le bouton **Nouvelle session** renouvelle cette identité. Il ne supprime pas les mémoires déjà enregistrées par Hermes.

## Sécurité

- Gardez `API_SERVER_HOST=127.0.0.1` pour une installation locale.
- N’exposez pas Hermes sur Internet sans HTTPS, authentification et contrôle réseau.
- Ne configurez jamais `API_SERVER_CORS_ORIGINS=*` pour une installation disposant d’outils terminal ou navigateur.
- Neptune exige toujours ses propres validations avant une communication externe dans l’onglet local.
- Le planificateur navigateur local reste prioritaire, même lorsque Hermes est sélectionné.

## Serveur auto-hébergé

Une adresse distante doit utiliser HTTPS. Neptune demande alors une permission Chrome limitée à l’origine concernée.

Exemple :

```text
https://hermes.example.com
```

Le reverse proxy doit transmettre les en-têtes d’authentification et de session à Hermes.

## Diagnostic

### Hermes n’est pas détecté

Vérifiez :

```bash
hermes gateway
```

Puis ouvrez dans le navigateur local :

```text
http://127.0.0.1:8642/health
```

### Erreur CORS

La valeur `API_SERVER_CORS_ORIGINS` doit correspondre exactement à l’origine affichée par Neptune, sans barre oblique finale.

### Erreur d’authentification

La clé saisie dans Neptune doit être identique à `API_SERVER_KEY`.

### Les compétences ne sont pas listées

Mettez Hermes Agent à jour. Neptune reste capable de converser si `/v1/chat/completions` est disponible, même si `/v1/skills` ne l’est pas.

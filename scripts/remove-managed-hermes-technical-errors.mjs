import { readFile, writeFile } from "node:fs/promises";

const path = "apps/extension/src/hermes-client.ts";
let source = await readFile(path, "utf8");
const replacements = [
  [
    "Tu es le cerveau agentique optionnel de Neptune. Tu peux utiliser les compétences, la mémoire et les outils configurés dans Hermes.",
    "Tu es le cerveau agentique intégré de Neptune. Tu peux utiliser les compétences, la mémoire et les outils locaux de Hermes."
  ],
  [
    "La clé du serveur Hermes est absente ou trop courte. Configurez API_SERVER_KEY dans Hermes.",
    "La clé locale de Hermes intégré est indisponible. Utilisez Diagnostiquer et réparer Hermes dans Neptune."
  ],
  [
    "Hermes a refusé l’authentification. Vérifiez API_SERVER_KEY.",
    "Hermes intégré a perdu sa liaison sécurisée. Utilisez Diagnostiquer et réparer Hermes."
  ],
  [
    "L’API Hermes attendue n’est pas disponible. Mettez Hermes Agent à jour et activez API_SERVER_ENABLED.",
    "Le moteur Hermes intégré est incomplet ou incompatible. Utilisez Diagnostiquer et réparer Hermes."
  ],
  [
    "return new Error(`Connexion impossible à ${endpoint}. Vérifiez que « hermes gateway » est démarré et que API_SERVER_CORS_ORIGINS contient ${getNeptuneExtensionOrigin()}.`);",
    "return new Error(\"Hermes intégré ne répond pas. Neptune peut le redémarrer depuis Diagnostiquer et réparer Hermes.\");"
  ]
];
for (const [before, after] of replacements) {
  if (source.includes(after)) continue;
  if (!source.includes(before)) throw new Error(`Hermes technical error target missing: ${before.slice(0, 80)}`);
  source = source.replace(before, after);
}
await writeFile(path, source, "utf8");
console.log("Managed Hermes technical messages removed.");

import { readFile, writeFile } from "node:fs/promises";

const files = {
  app: "apps/extension/src/neptune-app.ts",
  manifest: "apps/extension/static/manifest.json",
  package: "apps/extension/package.json",
  product: "apps/extension/src/product-config.ts",
  entry: "apps/extension/src/sidepanel-entry.ts"
};

async function read(path) { return readFile(path, "utf8"); }
async function write(path, content) { await writeFile(path, content, "utf8"); }
function replaceExact(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`Managed Hermes migration target not found: ${label}`);
  return source.replace(before, after);
}
function replaceRegex(source, pattern, after, label) {
  if (pattern.test(source)) return source.replace(pattern, after);
  if (source.includes(after.slice(0, Math.min(80, after.length)))) return source;
  throw new Error(`Managed Hermes migration pattern not found: ${label}`);
}

let app = await read(files.app);
app = replaceExact(app,
`import { deleteSecret, loadSecret, saveSecret } from "./secure-storage";`,
`import { ensureManagedHermes, repairManagedHermes, type ManagedHermesProgress } from "./managed-hermes-runtime";\nimport { deleteSecret, loadSecret, saveSecret } from "./secure-storage";`,
"managed runtime import");

app = replaceExact(app,
`  providerId: "chrome-local",\n  endpoint: "https://api.mammouth.ai/v1",\n  model: BALANCED_LOCAL_MODEL_ID,`,
`  providerId: "hermes",\n  endpoint: "http://127.0.0.1:8642",\n  model: "Qwen3-4B-Q4_K_M",`,
"default managed provider");

app = replaceExact(app,
`      providerId: "chrome-local",\n      model: BALANCED_LOCAL_MODEL_ID,`,
`      providerId: "hermes",\n      endpoint: "http://127.0.0.1:8642",\n      model: "Qwen3-4B-Q4_K_M",`,
"migration managed provider");

app = replaceExact(app, `  await ensureBalancedSelection(migrate);`, `  await ensureManagedSelection(migrate);`, "initial selection");
app = replaceExact(app,
`  providerSecretSaved = Boolean(await loadSecret(preferences.providerId));`,
`  providerSecretSaved = preferences.providerId === "hermes" ? false : Boolean(await loadSecret(preferences.providerId));`,
"managed provider secret state");

app = replaceExact(app,
`      case "prepare-brain": await prepareBalancedBrain(); break;`,
`      case "prepare-brain": await prepareManagedBrain(); break;\n      case "repair-managed-hermes": await prepareManagedBrain(true); break;`,
"managed brain actions");

app = replaceExact(app,
`    if (preferences.onboardingStep === 3) void prepareBalancedBrain();`,
`    if (preferences.onboardingStep === 3) void prepareManagedBrain();`,
"onboarding automatic brain");
app = replaceExact(app,
`    await prepareBalancedBrain();\n    if ((brainState as ReadyState) !== "ready") return;`,
`    await prepareManagedBrain();\n    if ((brainState as ReadyState) !== "ready") return;`,
"onboarding managed readiness");

app = replaceRegex(app,
/async function ensureBalancedSelection\(force: boolean\): Promise<void> \{[\s\S]*?\n\}\n\nasync function refreshBrainState/,
`async function ensureManagedSelection(force: boolean): Promise<void> {\n  if (force || !["mammouth", "openai-compatible"].includes(preferences.providerId)) {\n    preferences.providerId = "hermes";\n    preferences.endpoint = "http://127.0.0.1:8642";\n    preferences.model = "Qwen3-4B-Q4_K_M";\n  }\n}\n\nasync function refreshBrainState`,
"managed selection function");

app = replaceRegex(app,
/async function refreshBrainState\(\): Promise<void> \{[\s\S]*?\n\}\n\nasync function prepareBalancedBrain/,
`async function refreshBrainState(): Promise<void> {\n  if (preferences.providerId === "hermes") {\n    brainState = "idle";\n    render();\n    void prepareManagedBrain();\n    return;\n  }\n  const status = await getChromeAiAvailability();\n  brainState = status === "available" ? "ready" : status === "unavailable" ? "error" : "idle";\n  if (status === "unavailable") brainError = "Le moteur local de secours n’est pas compatible avec ce poste.";\n  render();\n}\n\nasync function prepareManagedBrain(repair = false): Promise<void> {\n  if (brainState === "preparing") return;\n  if (preferences.providerId !== "hermes" && !repair) {\n    await prepareLocalFallbackBrain();\n    return;\n  }\n  brainState = "preparing";\n  brainProgress = 0;\n  brainError = "";\n  orbState = "thinking";\n  render();\n  try {\n    const progress = (state: ManagedHermesProgress) => {\n      brainProgress = state.progress;\n      transientWarning = state.detail;\n      render();\n    };\n    const connection = repair\n      ? await repairManagedHermes(progress, abortController?.signal)\n      : await ensureManagedHermes(progress, abortController?.signal);\n    preferences.providerId = "hermes";\n    preferences.endpoint = connection.endpoint;\n    preferences.model = connection.model;\n    await savePreferences();\n    brainState = "ready";\n    brainProgress = 100;\n    brainError = "";\n    transientWarning = "Hermes est prêt avec sa mémoire et ses compétences.";\n    orbState = "idle";\n    appendAudit("MANAGED_HERMES_READY", connection.model + " · runtime " + (connection.runtimeVersion ?? "intégré"));\n  } catch (error) {\n    brainState = "error";\n    orbState = "error";\n    brainError = errorMessage(error);\n    transientWarning = brainError;\n    appendAudit("MANAGED_HERMES_ERROR", brainError);\n  }\n  render();\n}\n\nasync function prepareLocalFallbackBrain`,
"managed brain preparation");

app = replaceRegex(app,
/async function ensureProviderReady\(\): Promise<ProviderConfig \| null> \{[\s\S]*?\n\}/,
`async function ensureProviderReady(): Promise<ProviderConfig | null> {\n  if (preferences.providerId === "hermes") {\n    try {\n      const connection = await ensureManagedHermes((state) => {\n        brainState = "preparing";\n        brainProgress = state.progress;\n        transientWarning = state.detail;\n        render();\n      }, abortController?.signal);\n      preferences.endpoint = connection.endpoint;\n      preferences.model = connection.model;\n      brainState = "ready";\n      brainProgress = 100;\n      await savePreferences();\n      return { id: "hermes", apiKey: connection.apiKey, endpoint: connection.endpoint, model: connection.model };\n    } catch (error) {\n      brainState = "error";\n      brainError = errorMessage(error);\n      transientWarning = brainError;\n      return null;\n    }\n  }\n  if (preferences.providerId === "chrome-local") {\n    const status = await getChromeAiAvailability();\n    if (status !== "available") await prepareLocalFallbackBrain();\n    if (brainState === "error") return null;\n    return { id: "chrome-local" };\n  }\n  const apiKey = await loadSecret(preferences.providerId);\n  if (!apiKey) return null;\n  return { id: preferences.providerId, apiKey, endpoint: preferences.endpoint, model: preferences.model };\n}`,
"managed provider readiness");

app = replaceExact(app,
`if (!provider) {\n    settingsOpen = true;\n    advancedOpen = true;\n    transientWarning = "Le cerveau de Neptune n’est pas prêt. Vérifiez les paramètres avancés.";`,
`if (!provider) {\n    settingsOpen = true;\n    advancedOpen = false;\n    transientWarning = brainError || "Le cerveau Hermes intégré n’est pas prêt. Lancez NeptuneSetup.exe ou utilisez Réparer Hermes.";`,
"managed unavailable message");

app = app.replaceAll(`void prepareBalancedBrain()`, `void prepareManagedBrain()`);
app = replaceExact(app,
`  const selectionLabel = catalog.find((model) => model.id === preferences.model)?.name ?? "Neptune Équilibré";`,
`  const selectionLabel = preferences.providerId === "hermes" ? "Hermes intégré" : catalog.find((model) => model.id === preferences.model)?.name ?? "Neptune local";`,
"settings brain label");

app = replaceRegex(app,
/function advancedSettingsMarkup\(\): string \{[\s\S]*?\n\}\n\nfunction providerFieldsMarkup/,
`function advancedSettingsMarkup(): string {\n  const catalog = getLocalModelCatalog();\n  const providerPanel = preferences.providerId === "hermes"\n    ? managedHermesSettingsMarkup()\n    : preferences.providerId !== "chrome-local"\n      ? providerFieldsMarkup()\n      : \`<div class="notice \${isWebGpuAvailable() ? "success" : "warning"}">\${isWebGpuAvailable() ? "WebGPU disponible pour le moteur local de secours." : "WebGPU indisponible : Hermes reste le moteur principal."}</div>\`;\n  return \`<div class="settings-section advanced"><h3>Intelligence avancée</h3><p>Hermes intégré est le cerveau par défaut. Ces réglages servent uniquement à choisir un moteur de secours.</p><div class="field"><label for="advanced-provider">Moteur de secours</label><select id="advanced-provider" class="select"><option value="hermes" \${preferences.providerId === "hermes" ? "selected" : ""}>Hermes intégré — recommandé</option><option value="chrome-local" \${preferences.providerId === "chrome-local" ? "selected" : ""}>Modèle navigateur local</option><option value="mammouth" \${preferences.providerId === "mammouth" ? "selected" : ""}>Mammouth AI</option><option value="openai-compatible" \${preferences.providerId === "openai-compatible" ? "selected" : ""}>API compatible OpenAI</option></select></div>\${preferences.providerId === "chrome-local" ? \`<div class="field"><label>Modèle local de secours</label><select class="select" id="advanced-local-model">\${catalog.map((model) => \`<option value="\${escapeAttribute(model.id)}" \${preferences.model === model.id ? "selected" : ""}>\${escapeHtml(model.name)}</option>\`).join("")}</select></div><button type="button" class="ghost-button" data-action="select-local-model" data-value="\${escapeAttribute(preferences.model)}">Utiliser ce modèle local</button>\` : ""}\${providerPanel}<div class="field"><label>Niveau de contrôle</label><div class="trust-grid">\${trustButton("prudent", "Prudent")}\${trustButton("assisted", "Collaborateur")}\${trustButton("controlled", "Autonome contrôlé")}</div></div></div>\`;\n}\n\nfunction managedHermesSettingsMarkup(): string {\n  return \`<div class="notice \${brainState === "ready" ? "success" : brainState === "error" ? "warning" : ""}"><strong>Hermes intégré</strong><br>\${brainState === "ready" ? "Mémoire, compétences et outils locaux opérationnels." : brainState === "preparing" ? \`Préparation en cours — \${brainProgress}%\` : escapeHtml(brainError || "Neptune démarre automatiquement Hermes lorsque nécessaire.")}</div><button type="button" class="ghost-button" data-action="repair-managed-hermes">Diagnostiquer et réparer Hermes</button>\`;\n}\n\nfunction providerFieldsMarkup`,
"advanced managed settings");

app = replaceRegex(app,
/function brainStatusMarkup\(\): string \{[\s\S]*?\n\}/,
`function brainStatusMarkup(): string {\n  if (brainState === "ready") return \`<div class="notice success">Hermes est prêt avec sa mémoire, ses compétences et ses outils locaux.</div>\`;\n  if (brainState === "preparing") return \`\${progressMarkup("Préparation automatique de Hermes", brainProgress)}<p class="preparation-note">Le premier démarrage peut prendre quelques minutes. Aucune clé ni configuration n’est demandée.</p>\`;\n  if (brainState === "error") return \`<div class="notice warning">\${escapeHtml(brainError || "Hermes n’a pas pu démarrer.")}</div><button type="button" class="primary-button wide-button" data-action="repair-managed-hermes">Installer ou réparer Hermes</button>\`;\n  return \`<button type="button" class="primary-button wide-button" data-action="prepare-brain">Démarrer Hermes</button>\`;\n}`,
"managed brain status");

app = replaceExact(app,
`  return ["Comment dois-je vous appeler ?", "Préférez-vous une voix féminine ou masculine ?", "Dites Neptune ou OK Neptune pour échanger avec moi.", "Je prépare mon cerveau local équilibré."][step] ?? "";`,
`  return ["Comment dois-je vous appeler ?", "Préférez-vous une voix féminine ou masculine ?", "Dites Neptune ou OK Neptune pour échanger avec moi.", "Je prépare Hermes, ma mémoire et mes compétences."][step] ?? "";`,
"managed onboarding speech");

app = replaceRegex(app,
/function brainLabel\(\): string \{[\s\S]*?\n\}/,
`function brainLabel(): string {\n  if (preferences.providerId === "hermes") return brainState === "ready" ? "Hermes intégré · local" : "Hermes se prépare";\n  if (preferences.providerId === "mammouth") return "Mammouth AI · secours";\n  if (preferences.providerId === "openai-compatible") return "API externe · secours";\n  return brainState === "ready" ? "Modèle navigateur · secours" : "Moteur de secours";\n}`,
"managed brain label");

app = app
  .replace(`CERVEAU LOCAL`, `HERMES INTÉGRÉ`)
  .replace(`Neptune Équilibré se prépare automatiquement`, `Hermes se prépare automatiquement`)
  .replace(`Le modèle local recommandé est choisi sans vous demander de comprendre des noms techniques. Les alternatives restent accessibles dans les paramètres avancés.`, `Neptune démarre automatiquement Hermes, sa mémoire et ses compétences. Aucune URL, clé API ou commande technique n’est demandée.`)
  .replace(`<span>Cerveau local équilibré</span>`, `<span>Hermes intégré</span>`);

await write(files.app, app);

const manifest = JSON.parse(await read(files.manifest));
manifest.version = "1.8.0";
manifest.version_name = "1.8 Hermes Integrated";
manifest.description = "Assistant navigateur vocal et adaptatif avec Hermes Agent intégré, mémoire locale et configuration automatique.";
manifest.permissions = [...new Set([...(manifest.permissions ?? []), "nativeMessaging"] )];
await write(files.manifest, `${JSON.stringify(manifest, null, 2)}\n`);

const packageJson = JSON.parse(await read(files.package));
packageJson.version = "1.8.0";
await write(files.package, `${JSON.stringify(packageJson, null, 2)}\n`);

let product = await read(files.product);
product = product.replace(`export const PRODUCT_VERSION = 17;`, `export const PRODUCT_VERSION = 18;`);
await write(files.product, product);

let entry = await read(files.entry);
entry = entry.replace(`import "./hermes-settings";\n`, "");
await write(files.entry, entry);

console.log("Managed Hermes refactor applied successfully.");

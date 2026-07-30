import { readFile, writeFile } from "node:fs/promises";

const path = "apps/extension/src/neptune-app.ts";
let source = await readFile(path, "utf8");
function replaceExact(before, after, label) {
  if (source.includes(after)) return;
  if (!source.includes(before)) throw new Error(`Managed Hermes product target not found: ${label}`);
  source = source.replace(before, after);
}

replaceExact(
`async function ensureManagedSelection(force: boolean): Promise<void> {
  if (force || !["mammouth", "openai-compatible"].includes(preferences.providerId)) {
    preferences.providerId = "hermes";
    preferences.endpoint = "http://127.0.0.1:8642";
    preferences.model = "Qwen3-4B-Q4_K_M";
  }
}`,
`async function ensureManagedSelection(force: boolean): Promise<void> {
  if (force || preferences.providerId === "hermes") {
    preferences.providerId = "hermes";
    preferences.endpoint = "http://127.0.0.1:8642";
    preferences.model = "Qwen3-4B-Q4_K_M";
  }
}`,
"preserve selected fallback provider"
);

replaceExact(
`async function refreshBrainState(): Promise<void> {
  if (preferences.providerId === "hermes") {
    brainState = "idle";
    render();
    void prepareManagedBrain();
    return;
  }
  const status = await getChromeAiAvailability();
  brainState = status === "available" ? "ready" : status === "unavailable" ? "error" : "idle";
  if (status === "unavailable") brainError = "Le moteur local de secours n’est pas compatible avec ce poste.";
  render();
}`,
`async function refreshBrainState(): Promise<void> {
  if (preferences.providerId === "hermes") {
    brainState = "idle";
    render();
    void prepareManagedBrain();
    return;
  }
  if (preferences.providerId === "chrome-local") {
    const status = await getChromeAiAvailability();
    brainState = status === "available" ? "ready" : status === "unavailable" ? "error" : "idle";
    if (status === "unavailable") brainError = "Le moteur navigateur de secours n’est pas compatible avec ce poste.";
    render();
    return;
  }
  providerSecretSaved = Boolean(await loadSecret(preferences.providerId));
  brainState = providerSecretSaved ? "ready" : "idle";
  brainError = providerSecretSaved ? "" : "La clé du moteur de secours n’est pas enregistrée.";
  render();
}`,
"external fallback readiness"
);

replaceExact(
`async function selectProvider(providerId: ProviderId): Promise<void> {
  preferences.providerId = providerId;
  if (providerId === "mammouth") {
    preferences.endpoint = "https://api.mammouth.ai/v1";
    preferences.model = preferences.model || "mammouth-recommended";
  }
  providerSecretSaved = Boolean(await loadSecret(providerId));
  await savePreferences();
  render();
}`,
`async function selectProvider(providerId: ProviderId): Promise<void> {
  preferences.providerId = providerId;
  brainError = "";
  if (providerId === "hermes") {
    preferences.endpoint = "http://127.0.0.1:8642";
    preferences.model = "Qwen3-4B-Q4_K_M";
    providerSecretSaved = false;
    brainState = "idle";
    await savePreferences();
    render();
    void prepareManagedBrain();
    return;
  }
  if (providerId === "chrome-local") {
    const selection = await getLocalModelSelection();
    preferences.model = selection.modelId || BALANCED_LOCAL_MODEL_ID;
    providerSecretSaved = false;
    brainState = "idle";
    await savePreferences();
    render();
    void refreshBrainState();
    return;
  }
  if (providerId === "mammouth") {
    preferences.endpoint = "https://api.mammouth.ai/v1";
    preferences.model = "mammouth-recommended";
  }
  providerSecretSaved = Boolean(await loadSecret(providerId));
  brainState = providerSecretSaved ? "ready" : "idle";
  await savePreferences();
  render();
}`,
"managed provider selection"
);

replaceExact(
`async function saveCurrentProviderSecret(): Promise<void> {
  if (preferences.providerId === "chrome-local") return;`,
`async function saveCurrentProviderSecret(): Promise<void> {
  if (["chrome-local", "hermes"].includes(preferences.providerId)) return;`,
"prevent managed key editing"
);

replaceExact(
`    await blockMission("Le moteur d’intelligence n’est plus disponible. Ouvrez les paramètres avancés, puis reprenez.");`,
`    await blockMission(brainError || "Hermes n’est plus disponible. Utilisez Diagnostiquer et réparer Hermes, puis reprenez au checkpoint.");`,
"managed mission recovery message"
);

replaceExact(
`    brainError = "Ce poste ne peut pas exécuter le cerveau local. Ouvrez les paramètres avancés pour connecter un fournisseur.";`,
`    brainError = "Le moteur navigateur de secours n’est pas compatible avec ce poste. Revenez à Hermes intégré ou choisissez un autre secours.";`,
"fallback error copy"
);

await writeFile(path, source, "utf8");
console.log("Managed Hermes product finalization applied.");

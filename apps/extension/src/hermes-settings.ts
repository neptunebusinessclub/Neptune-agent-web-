import {
  getHermesDefaultEndpoint,
  getNeptuneExtensionOrigin,
  hermesOriginPattern,
  resetHermesSession,
  testHermesConnection
} from "./hermes-client";
import { loadSecret, saveSecret } from "./secure-storage";

export {};

const PREFERENCES_KEY = "neptune.preferences.v2";
const CONNECTION_KEY = "neptune.hermes.connection.v1";
const HERMES_DOCS = "https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/api-server.md";
let mounting = false;
let renderScheduled = false;
let hermesSelected = false;
let connectionState: Record<string, unknown> = {};
let liveStatusTimer: number | undefined;

const observer = new MutationObserver(() => scheduleRefresh());
observer.observe(document.documentElement, { childList: true, subtree: true });
void initializeHermesUi();

window.addEventListener("neptune-hermes-status", (event) => {
  const detail = (event as CustomEvent<{ status?: string; detail?: string }>).detail;
  const status = detail?.status ?? "working";
  const text = detail?.detail ?? "Hermes travaille…";
  updateStatus(status, text);
  renderLiveHermesStatus(status, text);
});

document.addEventListener("change", (event) => {
  const select = event.target as HTMLSelectElement | null;
  if (select?.id !== "advanced-provider") return;
  hermesSelected = select.value === "hermes";
  scheduleRefresh();
  if (hermesSelected) window.setTimeout(() => void configureHermesFields(), 0);
});

document.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-hermes-action]");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  const action = button.dataset.hermesAction;
  if (action === "connect") void connectHermes(button);
  if (action === "reset-session") void resetHermesConversation(button);
  if (action === "copy-cors") void copyCorsSetting(button);
  if (action === "open-docs") void chrome.tabs.create({ url: HERMES_DOCS });
}, true);

async function initializeHermesUi(): Promise<void> {
  const stored = await chrome.storage.local.get([PREFERENCES_KEY, CONNECTION_KEY]);
  const preferences = isRecord(stored[PREFERENCES_KEY]) ? stored[PREFERENCES_KEY] : {};
  connectionState = isRecord(stored[CONNECTION_KEY]) ? stored[CONNECTION_KEY] : {};
  hermesSelected = preferences.providerId === "hermes";
  await mountHermesControls();
  refreshVisibleLabels();
}

function scheduleRefresh(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  queueMicrotask(() => {
    renderScheduled = false;
    refreshVisibleLabels();
    void mountHermesControls();
  });
}

async function mountHermesControls(): Promise<void> {
  if (mounting) return;
  const providerSelect = document.querySelector<HTMLSelectElement>("#advanced-provider");
  if (!providerSelect) return;
  mounting = true;
  try {
    if (!providerSelect.querySelector("option[value='hermes']")) {
      const option = document.createElement("option");
      option.value = "hermes";
      option.textContent = "Hermes Agent — mémoire et compétences";
      providerSelect.append(option);
    }

    const stored = await chrome.storage.local.get([PREFERENCES_KEY, CONNECTION_KEY]);
    const preferences = isRecord(stored[PREFERENCES_KEY]) ? stored[PREFERENCES_KEY] : {};
    connectionState = isRecord(stored[CONNECTION_KEY]) ? stored[CONNECTION_KEY] : connectionState;
    hermesSelected = preferences.providerId === "hermes";
    if (hermesSelected) providerSelect.value = "hermes";

    const advanced = providerSelect.closest<HTMLElement>(".settings-section.advanced");
    if (advanced && !document.getElementById("neptune-hermes-card")) {
      advanced.insertAdjacentHTML("beforeend", hermesCardMarkup(connectionState));
    }
    if (hermesSelected) await configureHermesFields(false);
    refreshVisibleLabels();
  } finally {
    mounting = false;
  }
}

function refreshVisibleLabels(): void {
  if (!hermesSelected) return;
  const composerBrain = document.querySelector<HTMLElement>(".composer-hint span:last-child");
  if (composerBrain) composerBrain.textContent = "Hermes Agent";
  const settingStatus = document.querySelector<HTMLElement>(".setting-status");
  const name = settingStatus?.querySelector<HTMLElement>("strong");
  const status = settingStatus?.querySelector<HTMLElement>("span");
  if (name) name.textContent = "Hermes Agent — mémoire et compétences";
  if (status) status.textContent = connectionState.status === "connected" ? "Connecté" : "À connecter";
}

function renderLiveHermesStatus(status: string, detail: string): void {
  document.documentElement.dataset.hermesStatus = status;
  window.clearTimeout(liveStatusTimer);
  const stage = document.querySelector<HTMLElement>(".conversation-stage");
  if (!stage) return;
  let element = document.getElementById("neptune-hermes-live-status");
  if (!element) {
    element = document.createElement("div");
    element.id = "neptune-hermes-live-status";
    element.className = "hermes-live-status";
    element.setAttribute("role", "status");
    element.setAttribute("aria-live", "polite");
    stage.prepend(element);
  }
  element.className = `hermes-live-status ${status}`;
  element.innerHTML = `<span class="hermes-live-pulse" aria-hidden="true"></span><strong>Hermes</strong><span>${escapeHtml(detail)}</span>`;

  if (["completed", "stopped"].includes(status)) {
    liveStatusTimer = window.setTimeout(() => {
      element?.remove();
      delete document.documentElement.dataset.hermesStatus;
    }, 1_600);
  } else if (status === "error") {
    liveStatusTimer = window.setTimeout(() => {
      element?.remove();
      delete document.documentElement.dataset.hermesStatus;
    }, 6_000);
  }
}

async function configureHermesFields(dispatch = true): Promise<void> {
  const endpoint = document.querySelector<HTMLInputElement>("#provider-endpoint");
  const model = document.querySelector<HTMLInputElement>("#provider-model");
  if (!endpoint || !model) return;
  const currentEndpoint = endpoint.value.trim();
  if (!currentEndpoint || /api\.mammouth\.ai/i.test(currentEndpoint)) endpoint.value = getHermesDefaultEndpoint();
  if (!model.value.trim() || model.value === "mammouth-recommended" || /Qwen|Llama|Phi/i.test(model.value)) model.value = "hermes-agent";
  if (dispatch) {
    endpoint.dispatchEvent(new Event("input", { bubbles: true }));
    model.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

async function connectHermes(button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  const original = button.textContent;
  button.textContent = "Connexion à Hermes…";
  updateStatus("connecting", "Détection du serveur Hermes…");

  try {
    const providerSelect = document.querySelector<HTMLSelectElement>("#advanced-provider");
    if (providerSelect && providerSelect.value !== "hermes") {
      providerSelect.value = "hermes";
      providerSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await delay(80);
    }
    hermesSelected = true;
    await configureHermesFields();

    const endpointInput = document.querySelector<HTMLInputElement>("#provider-endpoint");
    const modelInput = document.querySelector<HTMLInputElement>("#provider-model");
    const secretInput = document.querySelector<HTMLInputElement>("#provider-secret");
    const endpoint = endpointInput?.value.trim() || getHermesDefaultEndpoint();
    const model = modelInput?.value.trim() || "hermes-agent";
    const enteredKey = secretInput?.value.trim() || "";
    const storedKey = await loadSecret("hermes");
    const apiKey = enteredKey || storedKey;
    if (!apiKey) throw new Error("Saisissez la clé API_SERVER_KEY configurée dans Hermes.");

    await ensureHermesHostPermission(endpoint);
    const connection = await testHermesConnection({ endpoint, model, apiKey });
    if (enteredKey) await saveSecret("hermes", enteredKey);
    if (secretInput) secretInput.value = "";
    if (endpointInput) endpointInput.value = connection.endpoint;
    if (modelInput) modelInput.value = connection.model;
    endpointInput?.dispatchEvent(new Event("input", { bubbles: true }));
    modelInput?.dispatchEvent(new Event("input", { bubbles: true }));

    connectionState = {
      status: "connected",
      endpoint: connection.endpoint,
      model: connection.model,
      version: connection.version ?? "",
      skillsCount: connection.skillsCount,
      serverToolExecution: connection.capabilities.serverToolExecution,
      runs: connection.capabilities.runs,
      connectedAt: new Date().toISOString()
    };
    await chrome.storage.local.set({ [CONNECTION_KEY]: connectionState });
    updateStatus("connected", connectionSummary(connectionState));
    refreshVisibleLabels();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connexion Hermes impossible.";
    updateStatus("error", message);
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = original || "Connecter Hermes";
  }
}

async function resetHermesConversation(button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    await resetHermesSession();
    updateStatus("ready", "Nouvelle session Neptune–Hermes prête. Les mémoires enregistrées dans Hermes ne sont pas supprimées.");
  } finally {
    button.disabled = false;
  }
}

async function copyCorsSetting(button: HTMLButtonElement): Promise<void> {
  await navigator.clipboard.writeText(corsSetting());
  const original = button.textContent;
  button.textContent = "Ligne copiée";
  window.setTimeout(() => { button.textContent = original; }, 1_200);
}

async function ensureHermesHostPermission(endpoint: string): Promise<void> {
  const origins = [hermesOriginPattern(endpoint)];
  if (await chrome.permissions.contains({ origins })) return;
  const granted = await chrome.permissions.request({ origins });
  if (!granted) throw new Error("Chrome n’a pas autorisé Neptune à joindre ce serveur Hermes.");
}

function hermesCardMarkup(connection: Record<string, unknown>): string {
  const connected = connection.status === "connected";
  const summary = connected ? connectionSummary(connection) : "Hermes n’est pas encore connecté à Neptune.";
  return `<section id="neptune-hermes-card" class="hermes-card">
    <div class="hermes-card-head"><div><p class="eyebrow">CERVEAU ÉVOLUTIF</p><h3>Hermes Agent</h3></div><span class="hermes-badge ${connected ? "connected" : ""}">${connected ? "Connecté" : "Optionnel"}</span></div>
    <p>Hermes ajoute mémoire persistante, compétences réutilisables, recherche, délégation et outils serveur. Neptune conserve la voix, l’interface, les validations et le contrôle de votre navigateur.</p>
    <div class="notice warning"><strong>Architecture sécurisée :</strong> les outils Hermes s’exécutent sur la machine ou le serveur où Hermes est installé. Les actions dans votre onglet restent exécutées et validées par Neptune.</div>
    <div id="neptune-hermes-status" class="hermes-status ${connected ? "connected" : ""}">${escapeHtml(summary)}</div>
    <div class="hermes-actions"><button type="button" class="primary-button" data-hermes-action="connect">${connected ? "Vérifier la connexion" : "Connecter Hermes"}</button><button type="button" class="ghost-button" data-hermes-action="reset-session">Nouvelle session</button></div>
    <details class="hermes-setup"><summary>Configuration Hermes requise</summary><p>Dans <code>~/.hermes/.env</code>, activez l’API, définissez une clé et copiez exactement cette ligne, puis lancez <code>hermes gateway</code>.</p><code class="hermes-origin">${escapeHtml(corsSetting())}</code><div class="hermes-actions"><button type="button" class="ghost-button" data-hermes-action="copy-cors">Copier la ligne CORS</button><button type="button" class="ghost-button" data-hermes-action="open-docs">Documentation officielle</button></div></details>
  </section>`;
}

function corsSetting(): string {
  return `API_SERVER_CORS_ORIGINS=${getNeptuneExtensionOrigin()}`;
}

function updateStatus(status: string, detail: string): void {
  const element = document.getElementById("neptune-hermes-status");
  if (element) {
    element.className = `hermes-status ${status}`;
    element.textContent = detail;
  }
}

function connectionSummary(connection: Record<string, unknown>): string {
  const parts = ["Hermes connecté"];
  if (typeof connection.version === "string" && connection.version) parts.push(`version ${connection.version}`);
  if (typeof connection.model === "string" && connection.model) parts.push(`modèle ${connection.model}`);
  if (typeof connection.skillsCount === "number") parts.push(`${connection.skillsCount} compétence(s)`);
  if (connection.runs === true) parts.push("missions longues détectées");
  return `${parts.join(" · ")}.`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

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

const observer = new MutationObserver(() => void mountHermesControls());
observer.observe(document.documentElement, { childList: true, subtree: true });
void mountHermesControls();

window.addEventListener("neptune-hermes-status", (event) => {
  const detail = (event as CustomEvent<{ status?: string; detail?: string }>).detail;
  updateStatus(detail?.status ?? "working", detail?.detail ?? "Hermes travaille…");
});

document.addEventListener("change", (event) => {
  const select = event.target as HTMLSelectElement | null;
  if (select?.id !== "advanced-provider" || select.value !== "hermes") return;
  window.setTimeout(() => void configureHermesFields(), 0);
});

document.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-hermes-action]");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  const action = button.dataset.hermesAction;
  if (action === "connect") void connectHermes(button);
  if (action === "reset-session") void resetHermesConversation(button);
  if (action === "copy-origin") void copyOrigin(button);
  if (action === "open-docs") void chrome.tabs.create({ url: HERMES_DOCS });
}, true);

async function mountHermesControls(): Promise<void> {
  if (mounting) return;
  mounting = true;
  try {
    const providerSelect = document.querySelector<HTMLSelectElement>("#advanced-provider");
    if (!providerSelect) return;
    if (!providerSelect.querySelector("option[value='hermes']")) {
      const option = document.createElement("option");
      option.value = "hermes";
      option.textContent = "Hermes Agent — mémoire et compétences";
      providerSelect.append(option);
    }

    const stored = await chrome.storage.local.get([PREFERENCES_KEY, CONNECTION_KEY]);
    const preferences = isRecord(stored[PREFERENCES_KEY]) ? stored[PREFERENCES_KEY] : {};
    if (preferences.providerId === "hermes") providerSelect.value = "hermes";

    const advanced = providerSelect.closest<HTMLElement>(".settings-section.advanced");
    if (!advanced || document.getElementById("neptune-hermes-card")) return;
    const connection = isRecord(stored[CONNECTION_KEY]) ? stored[CONNECTION_KEY] : {};
    advanced.insertAdjacentHTML("beforeend", hermesCardMarkup(connection));

    if (preferences.providerId === "hermes") await configureHermesFields(false);
  } finally {
    mounting = false;
  }
}

async function configureHermesFields(dispatch = true): Promise<void> {
  const endpoint = document.querySelector<HTMLInputElement>("#provider-endpoint");
  const model = document.querySelector<HTMLInputElement>("#provider-model");
  if (!endpoint || !model) return;
  const currentEndpoint = endpoint.value.trim();
  if (!currentEndpoint || /api\.mammouth\.ai/i.test(currentEndpoint)) endpoint.value = getHermesDefaultEndpoint();
  if (!model.value.trim() || model.value === "mammouth-recommended") model.value = "hermes-agent";
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
    await configureHermesFields();

    const endpointInput = document.querySelector<HTMLInputElement>("#provider-endpoint");
    const modelInput = document.querySelector<HTMLInputElement>("#provider-model");
    const secretInput = document.querySelector<HTMLInputElement>("#provider-secret");
    const endpoint = endpointInput?.value.trim() || getHermesDefaultEndpoint();
    const model = modelInput?.value.trim() || "hermes-agent";
    const enteredKey = secretInput?.value.trim() || "";
    const apiKey = enteredKey || await loadSecret("hermes");
    if (enteredKey) await saveSecret("hermes", enteredKey);
    if (!apiKey) throw new Error("Saisissez la clé API_SERVER_KEY configurée dans Hermes.");

    await ensureHermesHostPermission(endpoint);
    const connection = await testHermesConnection({ endpoint, model, apiKey });
    endpointInput && (endpointInput.value = connection.endpoint);
    modelInput && (modelInput.value = connection.model);
    endpointInput?.dispatchEvent(new Event("input", { bubbles: true }));
    modelInput?.dispatchEvent(new Event("input", { bubbles: true }));

    const snapshot = {
      status: "connected",
      endpoint: connection.endpoint,
      model: connection.model,
      version: connection.version ?? "",
      skillsCount: connection.skillsCount,
      serverToolExecution: connection.capabilities.serverToolExecution,
      runs: connection.capabilities.runs,
      connectedAt: new Date().toISOString()
    };
    await chrome.storage.local.set({ [CONNECTION_KEY]: snapshot });
    updateStatus("connected", connectionSummary(snapshot));
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
    updateStatus("ready", "Nouvelle mémoire de conversation Neptune–Hermes prête. Les mémoires gérées par Hermes ne sont pas supprimées.");
  } finally {
    button.disabled = false;
  }
}

async function copyOrigin(button: HTMLButtonElement): Promise<void> {
  await navigator.clipboard.writeText(getNeptuneExtensionOrigin());
  const original = button.textContent;
  button.textContent = "Copié";
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
    <details class="hermes-setup"><summary>Configuration Hermes requise</summary><p>Dans <code>~/.hermes/.env</code>, activez l’API, définissez une clé et autorisez exactement l’origine Neptune ci-dessous, puis lancez <code>hermes gateway</code>.</p><code class="hermes-origin">${escapeHtml(getNeptuneExtensionOrigin())}</code><div class="hermes-actions"><button type="button" class="ghost-button" data-hermes-action="copy-origin">Copier l’origine</button><button type="button" class="ghost-button" data-hermes-action="open-docs">Documentation officielle</button></div></details>
  </section>`;
}

function updateStatus(status: string, detail: string): void {
  const element = document.getElementById("neptune-hermes-status");
  if (!element) return;
  element.className = `hermes-status ${status}`;
  element.textContent = detail;
}

function connectionSummary(connection: Record<string, unknown>): string {
  const parts = ["Hermes connecté"];
  if (typeof connection.version === "string" && connection.version) parts.push(`version ${connection.version}`);
  if (typeof connection.model === "string" && connection.model) parts.push(`modèle ${connection.model}`);
  if (typeof connection.skillsCount === "number") parts.push(`${connection.skillsCount} compétence(s)`);
  if (connection.runs === true) parts.push("missions longues disponibles");
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

import {
  getLocalLanguageModelApi,
  getLocalModelCatalog,
  getLocalModelSelection,
  isWebGpuAvailable,
  saveLocalModelSelection,
  type LocalModelCard,
  type LocalModelSelection
} from "./local-model-runtime";

const PREFERENCES_KEY = "neptune.preferences.v2";
let selection: LocalModelSelection | null = null;
let progress = 0;
let progressText = "";
let preparing = false;
let scheduled = false;

void initializeModelHub();

async function initializeModelHub(): Promise<void> {
  selection = await getLocalModelSelection();
  installStyles();
  document.addEventListener("click", (event) => void handleModelHubClick(event), true);
  window.addEventListener("neptune-local-model-selection", (event) => {
    selection = (event as CustomEvent<LocalModelSelection>).detail;
    scheduleEnhance();
  });
  window.addEventListener("neptune-local-model-progress", (event) => {
    const detail = (event as CustomEvent<{ progress: number; text: string }>).detail;
    progress = Math.round(Math.max(0, Math.min(1, detail.progress)) * 100);
    progressText = detail.text;
    scheduleEnhance();
  });
  new MutationObserver(scheduleEnhance).observe(document.documentElement, { childList: true, subtree: true });
  scheduleEnhance();
}

function scheduleEnhance(): void {
  if (scheduled) return;
  scheduled = true;
  window.requestAnimationFrame(() => {
    scheduled = false;
    enhanceModelHub();
  });
}

function enhanceModelHub(): void {
  const providerButton = document.querySelector<HTMLElement>("[data-action='select-provider'][data-value='chrome-local']");
  if (!providerButton || !selection) return;
  providerButton.querySelector<HTMLElement>(".choice-title")!.textContent = "Neptune Local";
  const description = providerButton.querySelector<HTMLElement>(".choice-description");
  if (description) description.textContent = "Choisissez un modèle gratuit, téléchargé et exécuté directement dans Chrome.";
  const badge = providerButton.querySelector<HTMLElement>(".choice-badge");
  if (badge) badge.textContent = "GRATUIT";

  const existing = document.getElementById("neptune-model-hub");
  if (!providerButton.classList.contains("selected")) {
    existing?.remove();
    return;
  }

  const grid = providerButton.closest(".choice-grid");
  if (!grid) return;
  const html = modelHubMarkup();
  if (existing) {
    if (existing.innerHTML !== html) existing.innerHTML = html;
  } else {
    const section = document.createElement("section");
    section.id = "neptune-model-hub";
    section.className = "neptune-model-hub";
    section.innerHTML = html;
    grid.insertAdjacentElement("afterend", section);
  }

  const legacyButton = document.querySelector<HTMLButtonElement>("[data-action='prepare-local-ai']");
  if (legacyButton) {
    legacyButton.hidden = true;
    legacyButton.tabIndex = -1;
  }
  const legacyNotice = grid.parentElement?.querySelector<HTMLElement>(":scope > .notice:not(.neptune-hub-notice)");
  if (legacyNotice) legacyNotice.hidden = true;
  patchVisibleProviderLabels();
}

function modelHubMarkup(): string {
  if (!selection) return "";
  const catalog = getLocalModelCatalog();
  const webGpu = isWebGpuAvailable();
  const selectedCard = catalog.find((model) => model.id === selection?.modelId);
  const options = [
    engineCard("auto", "Neptune automatique", "Utilise l’intelligence intégrée de Chrome lorsqu’elle est disponible, sinon le modèle local recommandé.", "AUTO", selection.engine === "auto"),
    engineCard("chrome-native", "Chrome intégré", "Aucun choix technique : Chrome gère lui-même son modèle local.", "SIMPLE", selection.engine === "chrome-native"),
    ...catalog.map((model) => modelCard(model, selection?.engine === "webllm" && selection.modelId === model.id, webGpu))
  ].join("");
  const selectionLabel = selection.engine === "auto"
    ? "Sélection automatique"
    : selection.engine === "chrome-native"
      ? "Intelligence intégrée de Chrome"
      : selectedCard?.name ?? "Modèle local";
  const warning = webGpu
    ? "Les modèles sont téléchargés une seule fois puis conservés dans le stockage local de Chrome."
    : "WebGPU n’est pas disponible sur ce poste. Utilisez le mode automatique, Chrome intégré ou un moteur cloud.";

  return `<div class="neptune-hub-heading"><div><p class="eyebrow">BIBLIOTHÈQUE LOCALE</p><h3>Choisissez le cerveau de Neptune</h3></div><span class="neptune-hub-status">${escapeHtml(selectionLabel)}</span></div>
    <p class="neptune-hub-copy">Neptune recommande automatiquement le meilleur compromis selon votre ordinateur. Les modèles WebGPU restent sur votre appareil.</p>
    <div class="neptune-model-grid">${options}</div>
    <div class="notice neptune-hub-notice ${webGpu ? "success" : "warning"}">${escapeHtml(warning)}</div>
    ${preparing || progress > 0 ? `<div class="neptune-hub-progress"><div class="download-progress"><span style="width:${progress}%"></span></div><p>${escapeHtml(progressText || "Préparation du modèle local")} · ${progress}%</p></div>` : ""}
    <div class="inline-actions"><button class="primary-button" data-neptune-model-download ${preparing || (selection.engine === "webllm" && !webGpu) ? "disabled" : ""}>${preparing ? "Installation en cours…" : "Télécharger et activer"}</button></div>`;
}

function engineCard(
  engine: "auto" | "chrome-native",
  name: string,
  description: string,
  badge: string,
  selected: boolean
): string {
  return `<button class="neptune-model-card ${selected ? "selected" : ""}" data-neptune-engine="${engine}"><span class="choice-title-row"><span class="choice-title">${escapeHtml(name)}</span><span class="choice-badge">${escapeHtml(badge)}</span></span><span class="choice-description">${escapeHtml(description)}</span></button>`;
}

function modelCard(model: LocalModelCard, selected: boolean, webGpu: boolean): string {
  const memory = model.memoryGb ? ` · environ ${model.memoryGb.toLocaleString("fr-FR")} Go de mémoire graphique` : "";
  return `<button class="neptune-model-card ${selected ? "selected" : ""} ${webGpu ? "" : "disabled"}" data-neptune-model="${escapeAttribute(model.id)}" ${webGpu ? "" : "disabled"}><span class="choice-title-row"><span class="choice-title">${escapeHtml(model.name)}</span><span class="choice-badge ${model.recommended ? "recommended" : ""}">${model.recommended ? "RECOMMANDÉ" : escapeHtml(model.badge)}</span></span><span class="choice-description">${escapeHtml(model.description)}${escapeHtml(memory)}</span></button>`;
}

async function handleModelHubClick(event: Event): Promise<void> {
  const target = event.target as HTMLElement;
  const engineButton = target.closest<HTMLElement>("[data-neptune-engine]");
  if (engineButton) {
    event.preventDefault();
    event.stopPropagation();
    const engine = engineButton.dataset.neptuneEngine === "chrome-native" ? "chrome-native" : "auto";
    const current = selection ?? await getLocalModelSelection();
    selection = { ...current, engine };
    await saveSelectionAndPreference(selection);
    progress = 0;
    progressText = "";
    scheduleEnhance();
    return;
  }

  const modelButton = target.closest<HTMLElement>("[data-neptune-model]");
  if (modelButton) {
    event.preventDefault();
    event.stopPropagation();
    const modelId = modelButton.dataset.neptuneModel;
    if (!modelId) return;
    selection = { engine: "webllm", modelId };
    await saveSelectionAndPreference(selection);
    progress = 0;
    progressText = "";
    scheduleEnhance();
    return;
  }

  const downloadButton = target.closest<HTMLElement>("[data-neptune-model-download]");
  if (!downloadButton || preparing) return;
  event.preventDefault();
  event.stopPropagation();
  preparing = true;
  progress = 0;
  progressText = "Initialisation";
  scheduleEnhance();
  try {
    const api = getLocalLanguageModelApi();
    if (!api) throw new Error("Aucun moteur local compatible n’est disponible sur ce poste.");
    const session = await api.create({
      initialPrompts: [{ role: "system", content: "Tu es Neptune. Réponds uniquement : prêt." }],
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          progress = Math.round(event.loaded * 100);
          scheduleEnhance();
        });
      }
    });
    await session.prompt("Réponds uniquement : prêt");
    session.destroy();
    progress = 100;
    progressText = "Modèle prêt";
    await chrome.storage.local.set({ "neptune.local-model.ready.v1": selection?.modelId ?? "native" });
    const legacyButton = document.querySelector<HTMLButtonElement>("[data-action='prepare-local-ai']");
    if (legacyButton) {
      legacyButton.disabled = false;
      legacyButton.click();
    }
  } catch (error) {
    progressText = error instanceof Error ? error.message : "Le modèle local n’a pas pu être installé.";
    progress = 0;
    showHubError(progressText);
  } finally {
    preparing = false;
    scheduleEnhance();
  }
}

async function saveSelectionAndPreference(next: LocalModelSelection): Promise<void> {
  await saveLocalModelSelection(next);
  const stored = await chrome.storage.local.get(PREFERENCES_KEY);
  const preferences = stored[PREFERENCES_KEY] as Record<string, unknown> | undefined;
  if (preferences) {
    await chrome.storage.local.set({
      [PREFERENCES_KEY]: {
        ...preferences,
        providerId: "chrome-local",
        model: next.engine === "webllm" ? next.modelId : next.engine
      }
    });
  }
}

function patchVisibleProviderLabels(): void {
  const selectedModel = getLocalModelCatalog().find((model) => model.id === selection?.modelId);
  const label = selection?.engine === "webllm" ? selectedModel?.name : selection?.engine === "chrome-native" ? "Chrome intégré" : "Neptune automatique";
  for (const element of Array.from(document.querySelectorAll<HTMLElement>(".composer-hint span, .settings-section p"))) {
    if (/Chrome AI local|mammouth-recommended/i.test(element.textContent ?? "")) {
      element.textContent = (element.textContent ?? "").replace(/Chrome AI local(?:\s*·\s*\S+)?/i, label ?? "Neptune Local").replace(/mammouth-recommended/i, label ?? "Neptune Local");
    }
  }
}

function showHubError(message: string): void {
  const hub = document.getElementById("neptune-model-hub");
  if (!hub) return;
  const alert = document.createElement("div");
  alert.className = "notice warning neptune-hub-error";
  alert.textContent = message;
  hub.append(alert);
}

function installStyles(): void {
  if (document.getElementById("neptune-model-hub-styles")) return;
  const style = document.createElement("style");
  style.id = "neptune-model-hub-styles";
  style.textContent = `
    .neptune-model-hub{display:grid;gap:10px;margin-top:13px;padding:13px;border:1px solid rgba(92,181,255,.22);border-radius:18px;background:linear-gradient(145deg,rgba(32,93,181,.12),rgba(114,62,190,.09));text-align:left}
    .neptune-hub-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.neptune-hub-heading h3{margin-top:4px;font-size:15px}.neptune-hub-status{max-width:145px;padding:5px 8px;border-radius:999px;color:#a9f0d2;background:rgba(59,210,151,.1);font-size:8px;font-weight:900;text-align:center}
    .neptune-hub-copy{color:#9ba8c5;font-size:10px;line-height:1.5}.neptune-model-grid{display:grid;gap:8px}.neptune-model-card{display:grid;gap:5px;width:100%;padding:11px 12px;border:1px solid rgba(255,255,255,.08);border-radius:14px;color:#eef3ff;text-align:left;background:rgba(255,255,255,.035);transition:.18s ease}.neptune-model-card:hover:not(:disabled){border-color:rgba(83,188,255,.48);background:rgba(67,93,207,.1)}.neptune-model-card.selected{border-color:rgba(70,208,255,.72);box-shadow:0 0 0 2px rgba(67,122,255,.1),inset 0 0 25px rgba(61,96,222,.08)}.neptune-model-card.disabled{opacity:.42}.choice-badge.recommended{color:#8dffd1;background:rgba(44,222,149,.14)}
    .neptune-hub-progress p{margin-top:6px;color:#aebad5;font-size:9px}.neptune-hub-error{margin-top:0}
  `;
  document.head.append(style);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

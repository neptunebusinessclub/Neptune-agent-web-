import {
  LOCAL_VOICE_PREFIX,
  NEPTUNE_LOCAL_VOICES,
  fromLocalVoiceUri,
  getReadyLocalVoices,
  getSelectedLocalVoice,
  previewLocalVoice,
  setSelectedVoiceUri,
  stopLocalPlayback,
  toLocalVoiceUri
} from "./local-voice-runtime";

const PREFERENCES_KEY = "neptune.preferences.v2";
let selectedVoiceUri = "";
let readyVoiceIds = new Set<string>();
let preparingVoiceId = "";
let progress = 0;
let progressText = "";
let scheduled = false;

void initializeVoiceHub();

async function initializeVoiceHub(): Promise<void> {
  const [stored, ready] = await Promise.all([
    chrome.storage.local.get(PREFERENCES_KEY),
    getReadyLocalVoices()
  ]);
  const preferences = stored[PREFERENCES_KEY] as { voiceURI?: unknown } | undefined;
  selectedVoiceUri = typeof preferences?.voiceURI === "string" ? preferences.voiceURI : "";
  readyVoiceIds = new Set(ready);
  installStyles();

  document.addEventListener("click", (event) => void handleClick(event), true);
  document.addEventListener("change", handleChange, true);
  window.addEventListener("neptune-voice-selection", (event) => {
    const detail = (event as CustomEvent<{ voiceURI?: string }>).detail;
    selectedVoiceUri = detail.voiceURI ?? "";
    scheduleEnhance();
  });
  window.addEventListener("neptune-voice-ready", (event) => {
    const voiceId = (event as CustomEvent<{ voiceId?: string }>).detail.voiceId;
    if (voiceId) readyVoiceIds.add(voiceId);
    scheduleEnhance();
  });
  window.addEventListener("neptune-voice-progress", (event) => {
    const detail = (event as CustomEvent<{ progress?: number; text?: string; file?: string }>).detail;
    if (typeof detail.progress === "number") progress = Math.round(Math.max(0, Math.min(1, detail.progress)) * 100);
    progressText = detail.text || detail.file || "Téléchargement de la voix";
    scheduleEnhance();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const next = changes[PREFERENCES_KEY]?.newValue as { voiceURI?: unknown } | undefined;
    if (typeof next?.voiceURI === "string") {
      selectedVoiceUri = next.voiceURI;
      setSelectedVoiceUri(next.voiceURI);
      scheduleEnhance();
    }
  });

  new MutationObserver(scheduleEnhance).observe(document.documentElement, { subtree: true, childList: true });
  scheduleEnhance();
}

function scheduleEnhance(): void {
  if (scheduled) return;
  scheduled = true;
  window.requestAnimationFrame(() => {
    scheduled = false;
    enhanceVoiceHub();
  });
}

function enhanceVoiceHub(): void {
  enhanceOnboarding();
  enhanceSettings();
  patchVoiceLabels();
}

function enhanceOnboarding(): void {
  const previewButton = document.querySelector<HTMLElement>("[data-action='preview-voice']");
  if (!previewButton) {
    document.getElementById("neptune-local-voice-hub")?.remove();
    return;
  }
  const systemGrid = previewButton.closest<HTMLElement>(".choice-grid");
  if (!systemGrid) return;

  let hub = document.getElementById("neptune-local-voice-hub");
  if (!hub) {
    hub = document.createElement("section");
    hub.id = "neptune-local-voice-hub";
    hub.className = "neptune-local-voice-hub";
    systemGrid.insertAdjacentElement("beforebegin", hub);
  }
  const markup = localVoiceMarkup();
  if (hub.innerHTML !== markup) hub.innerHTML = markup;

  if (!systemGrid.previousElementSibling?.classList.contains("neptune-system-voice-label")) {
    const label = document.createElement("div");
    label.className = "neptune-system-voice-label";
    label.innerHTML = `<p class="eyebrow">VOIX DE L’ORDINATEUR</p><p>Disponibles immédiatement, sans téléchargement supplémentaire.</p>`;
    systemGrid.insertAdjacentElement("beforebegin", label);
  }

  for (const card of Array.from(systemGrid.querySelectorAll<HTMLElement>(".choice-card"))) {
    if (fromLocalVoiceUri(selectedVoiceUri)) card.classList.remove("selected");
  }
}

function localVoiceMarkup(): string {
  const selected = fromLocalVoiceUri(selectedVoiceUri);
  const cards = NEPTUNE_LOCAL_VOICES.map((voice) => {
    const ready = readyVoiceIds.has(voice.id);
    const isSelected = selected === voice.id;
    const status = ready ? "PRÊTE" : voice.recommended ? "RECOMMANDÉE" : voice.quality === "medium" ? "QUALITÉ+" : "LÉGÈRE";
    return `<article class="neptune-voice-card ${isSelected ? "selected" : ""}">
      <button class="neptune-voice-select" data-action="select-voice" data-value="${escapeAttribute(toLocalVoiceUri(voice.id))}" data-neptune-local-voice="${escapeAttribute(voice.id)}">
        <span class="choice-title-row"><span class="choice-title">${escapeHtml(voice.name)}</span><span class="choice-badge ${ready ? "ready" : voice.recommended ? "recommended" : ""}">${status}</span></span>
        <span class="choice-description">${escapeHtml(voice.style)} · Voix française open source Piper</span>
      </button>
      <div class="inline-actions"><button class="ghost-button" data-neptune-local-preview="${escapeAttribute(voice.id)}">${preparingVoiceId === voice.id ? "Préparation…" : ready ? "Pré-écouter" : "Télécharger et écouter"}</button></div>
    </article>`;
  }).join("");

  return `<div class="neptune-voice-heading"><div><p class="eyebrow">VOIX NEPTUNE LOCALES</p><h3>Choisissez ma personnalité vocale</h3></div><span class="neptune-local-badge">100 % LOCAL</span></div>
    <p class="neptune-voice-copy">Ces voix sont téléchargées uniquement après votre choix puis restent sur cet ordinateur.</p>
    <div class="neptune-local-voice-grid">${cards}</div>
    ${preparingVoiceId ? `<div class="neptune-voice-progress"><div class="download-progress"><span style="width:${progress}%"></span></div><p>${escapeHtml(progressText || "Préparation de la voix")} · ${progress}%</p></div>` : ""}`;
}

function enhanceSettings(): void {
  const select = document.querySelector<HTMLSelectElement>("#settings-voice");
  if (!select) return;
  for (const voice of NEPTUNE_LOCAL_VOICES) {
    const value = toLocalVoiceUri(voice.id);
    let option = Array.from(select.options).find((item) => item.value === value);
    if (!option) {
      option = document.createElement("option");
      option.value = value;
      option.textContent = `${voice.name} · Neptune Local${readyVoiceIds.has(voice.id) ? " · prête" : ""}`;
      select.insertAdjacentElement("afterbegin", option);
    }
    option.selected = selectedVoiceUri === value;
  }
}

async function handleClick(event: Event): Promise<void> {
  const target = event.target as HTMLElement;
  const localSelect = target.closest<HTMLElement>("[data-neptune-local-voice]");
  if (localSelect) {
    const voiceId = localSelect.dataset.neptuneLocalVoice;
    if (voiceId) {
      selectedVoiceUri = toLocalVoiceUri(voiceId);
      setSelectedVoiceUri(selectedVoiceUri);
      scheduleEnhance();
    }
    return;
  }

  const systemSelect = target.closest<HTMLElement>("[data-action='select-voice']");
  if (systemSelect && !systemSelect.dataset.value?.startsWith(LOCAL_VOICE_PREFIX)) {
    selectedVoiceUri = systemSelect.dataset.value ?? "";
    setSelectedVoiceUri(selectedVoiceUri);
    stopLocalPlayback();
    scheduleEnhance();
    return;
  }

  const preview = target.closest<HTMLElement>("[data-neptune-local-preview]");
  if (!preview || preparingVoiceId) return;
  event.preventDefault();
  event.stopPropagation();
  const voiceId = preview.dataset.neptuneLocalPreview;
  if (!voiceId) return;
  preparingVoiceId = voiceId;
  progress = 0;
  progressText = "Vérification de la voix";
  scheduleEnhance();
  try {
    await previewLocalVoice(voiceId, (nextProgress, detail) => {
      progress = Math.round(nextProgress * 100);
      progressText = friendlyProgress(detail);
      scheduleEnhance();
    });
    readyVoiceIds.add(voiceId);
    progress = 100;
    progressText = "Voix prête";
  } catch (error) {
    progress = 0;
    progressText = error instanceof Error ? error.message : "La voix n’a pas pu être préparée.";
    showVoiceError(progressText);
  } finally {
    preparingVoiceId = "";
    scheduleEnhance();
  }
}

function handleChange(event: Event): void {
  const select = event.target as HTMLSelectElement;
  if (select.id !== "settings-voice") return;
  selectedVoiceUri = select.value;
  setSelectedVoiceUri(select.value);
  if (!isLocalSelection(select.value)) stopLocalPlayback();
  scheduleEnhance();
}

function patchVoiceLabels(): void {
  const local = getSelectedLocalVoice() ?? NEPTUNE_LOCAL_VOICES.find((voice) => toLocalVoiceUri(voice.id) === selectedVoiceUri) ?? null;
  if (!local) return;
  for (const element of Array.from(document.querySelectorAll<HTMLElement>(".notice.success, .settings-section p"))) {
    const text = element.textContent ?? "";
    if (text.includes("Voix :") && !text.includes(local.name)) {
      element.textContent = text.replace(/Voix\s*:\s*[^·]+$/i, `Voix : ${local.name}`).replace(/Voix\s*:\s*[^·]+(?=\s*·)/i, `Voix : ${local.name}`);
    }
  }
}

function showVoiceError(message: string): void {
  const hub = document.getElementById("neptune-local-voice-hub");
  if (!hub) return;
  hub.querySelector(".neptune-voice-error")?.remove();
  const warning = document.createElement("div");
  warning.className = "notice warning neptune-voice-error";
  warning.textContent = message;
  hub.append(warning);
}

function friendlyProgress(detail: string): string {
  const normalized = detail.toLocaleLowerCase("fr-FR");
  if (normalized.includes("onnx")) return "Téléchargement du modèle vocal";
  if (normalized.includes("config")) return "Configuration de la voix";
  if (normalized.includes("wasm")) return "Préparation du moteur vocal";
  return detail || "Téléchargement de la voix";
}

function isLocalSelection(value: string): boolean {
  return value.startsWith(LOCAL_VOICE_PREFIX);
}

function installStyles(): void {
  if (document.getElementById("neptune-voice-hub-styles")) return;
  const style = document.createElement("style");
  style.id = "neptune-voice-hub-styles";
  style.textContent = `
    .neptune-local-voice-hub{display:grid;gap:11px;margin-bottom:14px;padding:14px;border:1px solid rgba(78,199,255,.24);border-radius:19px;background:linear-gradient(145deg,rgba(23,104,184,.13),rgba(137,52,190,.09));text-align:left}
    .neptune-voice-heading{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.neptune-voice-heading h3{margin-top:4px;font-size:15px}.neptune-local-badge{padding:5px 8px;border-radius:999px;color:#86f5c5;background:rgba(50,210,145,.12);font-size:8px;font-weight:900;white-space:nowrap}.neptune-voice-copy,.neptune-system-voice-label p:last-child{color:#9ca9c6;font-size:10px;line-height:1.5}.neptune-system-voice-label{display:grid;gap:3px;margin:14px 0 8px;text-align:left}
    .neptune-local-voice-grid{display:grid;gap:8px}.neptune-voice-card{display:grid;gap:5px;border:1px solid rgba(255,255,255,.08);border-radius:15px;background:rgba(255,255,255,.035);overflow:hidden;transition:.18s ease}.neptune-voice-card:hover{border-color:rgba(83,188,255,.45)}.neptune-voice-card.selected{border-color:rgba(76,215,255,.76);box-shadow:0 0 0 2px rgba(63,132,255,.11),inset 0 0 24px rgba(68,83,213,.09)}.neptune-voice-select{display:grid;gap:6px;width:100%;padding:12px 12px 5px;color:#eef3ff;text-align:left;background:transparent;border:0}.neptune-voice-card .inline-actions{padding:0 12px 10px}.choice-badge.ready{color:#88f5c8;background:rgba(50,210,145,.14)}.choice-badge.recommended{color:#a5d9ff;background:rgba(69,156,255,.14)}
    .neptune-voice-progress p{margin-top:6px;color:#aebad5;font-size:9px}.neptune-voice-error{margin-top:0}
  `;
  document.head.append(style);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

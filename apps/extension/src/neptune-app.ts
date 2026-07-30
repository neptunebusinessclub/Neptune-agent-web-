import type { BrowserAction } from "@neptune/protocol";
import {
  addHistory,
  canContinueMission,
  cloneAgentMission,
  createAgentMission,
  installDecision,
  isMissionStalled,
  markActionCompleted,
  markActionFailed,
  markActionStarted,
  missionProgress,
  recordObservation,
  type AgentMission,
  type AgentObservation
} from "./agent-core";
import { planAgentStep } from "./agent-intelligence";
import {
  askIntelligence,
  getChromeAiAvailability,
  isBrowserTask,
  type ProviderConfig,
  type ProviderId,
  type TrustLevel
} from "./intelligence";
import {
  getLocalLanguageModelApi,
  getLocalModelCatalog,
  getLocalModelSelection,
  isWebGpuAvailable,
  recommendModelId,
  saveLocalModelSelection,
  type LocalModelSelection
} from "./local-model-runtime";
import {
  prepareLocalVoice,
  previewLocalVoice,
  setSelectedVoiceUri,
  stopLocalPlayback
} from "./local-voice-runtime";
import { ensureManagedHermes, repairManagedHermes, type ManagedHermesProgress } from "./managed-hermes-runtime";
import { deleteSecret, loadSecret, saveSecret } from "./secure-storage";
import {
  BALANCED_LOCAL_MODEL_ID,
  PRODUCT_VERSION,
  PRODUCT_VOICES,
  inferWorkspaceMode,
  voiceForGender,
  type VoiceGender,
  type WorkspaceMode
} from "./product-config";

export {};

type Preferences = {
  productVersion: number;
  onboardingComplete: boolean;
  onboardingStep: number;
  preferredName: string;
  voiceGender: VoiceGender;
  voiceURI: string;
  trustLevel: TrustLevel;
  providerId: ProviderId;
  endpoint: string;
  model: string;
  wakeWordEnabled: boolean;
  wakeWord: "OK Neptune";
  siteAccessGranted: boolean;
  autoResumeVoice: boolean;
};

type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  tone: "normal" | "warning" | "permission";
  createdAt: string;
};

type AuditEntry = { id: string; type: string; detail: string; occurredAt: string };
type OrbState = "idle" | "listening" | "thinking" | "executing" | "speaking" | "permission" | "blocked" | "error";
type ReadyState = "idle" | "preparing" | "ready" | "error";

type BrowserError = { code: string; message: string; requiresHuman: boolean; retryable: boolean };
type RuntimeResponse<T = unknown> = { ok: boolean; result?: T; error?: BrowserError };
type PublicTab = { id?: number; url?: string; title?: string };
type WorkspacePrompt = {
  goal: string;
  recommended: WorkspaceMode;
  reason: string;
  activeTab: PublicTab | null;
};

type RecognitionResultEvent = Event & {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};
type RecognitionErrorEvent = Event & { error: string };
type RecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort?(): void;
};
type RecognitionConstructor = new () => RecognitionLike;

type NeptuneWindow = Window & {
  SpeechRecognition?: RecognitionConstructor;
  webkitSpeechRecognition?: RecognitionConstructor;
};

const STORAGE_PREFERENCES = "neptune.preferences.v2";
const STORAGE_MESSAGES = "neptune.messages.v2";
const STORAGE_AUDIT = "neptune.audit.v2";
const STORAGE_MISSION = "neptune.agent.mission.v2";
const ONBOARDING_LAST_STEP = 3;
const MAX_MESSAGES = 80;
const MAX_AUDIT = 240;
const HOST_ORIGINS = ["http://*/*", "https://*/*"];

const DEFAULT_PREFERENCES: Preferences = {
  productVersion: PRODUCT_VERSION,
  onboardingComplete: false,
  onboardingStep: 0,
  preferredName: "",
  voiceGender: "female",
  voiceURI: PRODUCT_VOICES.female.uri,
  trustLevel: "assisted",
  providerId: "hermes",
  endpoint: "http://127.0.0.1:8642",
  model: "Qwen3-4B-Q4_K_M",
  wakeWordEnabled: true,
  wakeWord: "OK Neptune",
  siteAccessGranted: false,
  autoResumeVoice: true
};

const app = requireElement<HTMLElement>("app");
let preferences = { ...DEFAULT_PREFERENCES };
let messages: ConversationMessage[] = [];
let audit: AuditEntry[] = [];
let mission: AgentMission | null = null;
let orbState: OrbState = "idle";
let draft = "";
let settingsOpen = false;
let advancedOpen = false;
let detailsOpen = false;
let busy = false;
let typing = false;
const pendingActions = new Set<string>();
let blockedMessage = "";
let transientWarning = "";
let workspacePrompt: WorkspacePrompt | null = null;
let voiceState: ReadyState = "idle";
let voiceProgress = 0;
let brainState: ReadyState = "idle";
let brainProgress = 0;
let brainError = "";
let activationTested = false;
let providerSecretSaved = false;
let secretDraft = "";
let abortController: AbortController | null = null;
let recognition: RecognitionLike | null = null;
let listeningWanted = false;
let recognitionRunning = false;
let recognitionPausedForSpeech = false;
let waitingForWakeCommand = false;

void initialize();

async function initialize(): Promise<void> {
  const [stored, session] = await Promise.all([
    chrome.storage.local.get([STORAGE_PREFERENCES, STORAGE_MESSAGES, STORAGE_AUDIT]),
    chrome.storage.session.get(STORAGE_MISSION)
  ]);
  const previous = stored[STORAGE_PREFERENCES] as Partial<Preferences> | undefined;
  const migrate = (previous?.productVersion ?? 0) < PRODUCT_VERSION;
  preferences = { ...DEFAULT_PREFERENCES, ...previous, productVersion: PRODUCT_VERSION };
  if (migrate) {
    const gender: VoiceGender = previous?.voiceGender === "male" ? "male" : "female";
    preferences = {
      ...preferences,
      onboardingComplete: false,
      onboardingStep: 0,
      voiceGender: gender,
      voiceURI: voiceForGender(gender).uri,
      providerId: "hermes",
      endpoint: "http://127.0.0.1:8642",
      model: "Qwen3-4B-Q4_K_M",
      wakeWordEnabled: true,
      wakeWord: "OK Neptune"
    };
  }
  messages = Array.isArray(stored[STORAGE_MESSAGES]) ? stored[STORAGE_MESSAGES] as ConversationMessage[] : [];
  audit = Array.isArray(stored[STORAGE_AUDIT]) ? stored[STORAGE_AUDIT] as AuditEntry[] : [];
  mission = isAgentMission(session[STORAGE_MISSION]) ? session[STORAGE_MISSION] as AgentMission : null;
  preferences.siteAccessGranted = await chrome.permissions.contains({ origins: HOST_ORIGINS });
  setSelectedVoiceUri(preferences.voiceURI);
  await ensureManagedSelection(migrate);
  providerSecretSaved = preferences.providerId === "hermes" ? false : Boolean(await loadSecret(preferences.providerId));
  bindEvents();
  await savePreferences();

  if (mission && ["running", "awaiting_approval"].includes(mission.status)) {
    mission.status = "blocked";
    mission.lastError = "La mission a été interrompue. Elle peut reprendre au dernier checkpoint.";
    blockedMessage = mission.lastError;
    await saveMission();
  } else if (mission?.status === "blocked") {
    blockedMessage = mission.lastError ?? "La mission attend votre intervention.";
  }

  render();
  if (!preferences.onboardingComplete && preferences.onboardingStep === 0) {
    void prepareSelectedVoice(false);
  }
  if (preferences.onboardingComplete) {
    void refreshBrainState();
    if (messages.length === 0) addMessage("assistant", `Bonjour ${preferences.preferredName || ""}. Donnez-moi un objectif : je choisirai avec vous le meilleur espace de travail.`);
  }
}

function bindEvents(): void {
  app.addEventListener("click", (event) => void dispatchClick(event));
  app.addEventListener("input", handleInput);
  app.addEventListener("change", handleInput);
  app.addEventListener("submit", (event) => {
    event.preventDefault();
    if ((event.target as HTMLElement).id === "composer") void submitMessage(draft);
  });
  app.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.target as HTMLElement).id === "preferred-name") {
      event.preventDefault();
      if (canContinueOnboarding()) void nextOnboardingStep();
    }
  });
  window.addEventListener("neptune-audio-level", (event) => {
    const level = Number((event as CustomEvent<{ level?: number }>).detail?.level ?? 0);
    document.documentElement.style.setProperty("--audio-level", String(Math.max(0, Math.min(1, level))));
  });
}

async function dispatchClick(event: Event): Promise<void> {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
  if (!button || button.disabled) return;
  event.preventDefault();
  const action = button.dataset.action ?? "";
  const value = button.dataset.value ?? "";
  const actionKey = `${action}:${value}`;
  if (pendingActions.has(actionKey)) return;
  pendingActions.add(actionKey);
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  transientWarning = "";
  try {
    switch (action) {
      case "onboarding-back":
        preferences.onboardingStep = Math.max(0, preferences.onboardingStep - 1);
        await savePreferences();
        render();
        break;
      case "onboarding-next": await nextOnboardingStep(); break;
      case "select-gender": await selectVoiceGender(value === "male" ? "male" : "female", true); break;
      case "preview-gender": await selectVoiceGender(value === "male" ? "male" : "female", true); break;
      case "test-activation": await testVoiceActivation(); break;
      case "send": await submitMessage(draft); break;
      case "toggle-micro": toggleListening(); break;
      case "open-settings": settingsOpen = true; render(); break;
      case "close-settings": settingsOpen = false; advancedOpen = false; render(); break;
      case "toggle-advanced": advancedOpen = !advancedOpen; render(); break;
      case "toggle-details": detailsOpen = !detailsOpen; render(); break;
      case "stop": await stopMission(); break;
      case "approve": await approveCurrentAction(); break;
      case "deny": await stopMission("Action refusée. La mission a été arrêtée."); break;
      case "resume": await resumeMission(); break;
      case "grant-and-resume":
        if (await requestSiteAccess()) await resumeMission();
        break;
      case "workspace-current": await beginWorkspaceMission("current-tab"); break;
      case "workspace-tab": await beginWorkspaceMission("new-tab"); break;
      case "workspace-window": await beginWorkspaceMission("new-window"); break;
      case "workspace-cancel": workspacePrompt = null; render(); break;
      case "select-trust": preferences.trustLevel = value as TrustLevel; await savePreferences(); render(); break;
      case "select-local-model": await selectAdvancedLocalModel(value); break;
      case "select-provider": await selectProvider(value as ProviderId); break;
      case "save-provider-secret": await saveCurrentProviderSecret(); break;
      case "delete-provider-secret":
        await deleteSecret(preferences.providerId);
        providerSecretSaved = false;
        secretDraft = "";
        render();
        break;
      case "test-provider": await testProvider(); break;
      case "prepare-brain": await prepareManagedBrain(); break;
      case "repair-managed-hermes": await prepareManagedBrain(true); break;
      case "retry-voice": await prepareSelectedVoice(true); break;
      case "clear-history":
        messages = [];
        await chrome.storage.local.set({ [STORAGE_MESSAGES]: messages });
        render();
        break;
      case "clear-audit":
        audit = [];
        await chrome.storage.local.set({ [STORAGE_AUDIT]: audit });
        render();
        break;
      case "reset-onboarding": await resetOnboarding(); break;
    }
  } catch (error) {
    transientWarning = errorMessage(error);
    orbState = "error";
    render();
  } finally {
    pendingActions.delete(actionKey);
    if (button.isConnected) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }
}

function handleInput(event: Event): void {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  switch (target.id) {
    case "preferred-name": {
      preferences.preferredName = target.value.slice(0, 80);
      const nextButton = app.querySelector<HTMLButtonElement>("button[data-action='onboarding-next']");
      if (nextButton) nextButton.disabled = preferences.preferredName.trim().length < 2;
      void savePreferences();
      break;
    }
    case "settings-name": preferences.preferredName = target.value.slice(0, 80); void savePreferences(); break;
    case "draft": draft = target.value.slice(0, 10_000); break;
    case "provider-endpoint": preferences.endpoint = target.value.slice(0, 500); break;
    case "provider-model": preferences.model = target.value.slice(0, 200); break;
    case "provider-secret": secretDraft = target.value.slice(0, 1_000); break;
    case "advanced-local-model": {
      const applyButton = app.querySelector<HTMLButtonElement>("button[data-action='select-local-model']");
      if (applyButton) applyButton.dataset.value = target.value;
      break;
    }
    case "advanced-provider": void selectProvider(target.value as ProviderId); break;
  }
}

async function nextOnboardingStep(): Promise<void> {
  const step = preferences.onboardingStep;
  if (step === 0 && preferences.preferredName.trim().length < 2) return;
  if (step === 1 && voiceState !== "ready") await prepareSelectedVoice(false);
  if (step === 2 && !activationTested) {
    transientWarning = "Dites « Neptune » ou « OK Neptune » pour valider l’activation vocale.";
    render();
    return;
  }
  if (step < ONBOARDING_LAST_STEP) {
    preferences.onboardingStep += 1;
    await savePreferences();
    render();
    if (preferences.onboardingStep === 3) void prepareManagedBrain();
    else speak(onboardingSpeech(preferences.onboardingStep));
    return;
  }
  if (brainState !== "ready") {
    await prepareManagedBrain();
    if ((brainState as ReadyState) !== "ready") return;
  }
  preferences.onboardingComplete = true;
  preferences.wakeWordEnabled = true;
  await savePreferences();
  addMessage("assistant", `Configuration terminée. ${preferences.preferredName}, donnez-moi simplement votre objectif.`);
  render();
  speak(`Configuration terminée. ${preferences.preferredName}, je suis prêt.`);
  startListening();
}

async function selectVoiceGender(gender: VoiceGender, preview: boolean): Promise<void> {
  preferences.voiceGender = gender;
  preferences.voiceURI = voiceForGender(gender).uri;
  setSelectedVoiceUri(preferences.voiceURI);
  await savePreferences();
  await prepareSelectedVoice(preview);
}

async function prepareSelectedVoice(preview: boolean): Promise<void> {
  const voice = voiceForGender(preferences.voiceGender);
  voiceState = "preparing";
  voiceProgress = 0;
  render();
  try {
    if (preview) {
      await previewLocalVoice(voice.id, (progress) => {
        voiceProgress = Math.round(progress * 100);
        render();
      });
    } else {
      await prepareLocalVoice(voice.id, (progress) => {
        voiceProgress = Math.round(progress * 100);
        render();
      });
    }
    voiceState = "ready";
    voiceProgress = 100;
    if (orbState === "error") orbState = "idle";
    transientWarning = "";
    appendAudit("VOICE_READY", voice.label);
  } catch (error) {
    voiceState = "error";
    orbState = "error";
    appendAudit("VOICE_ERROR", errorMessage(error));
    transientWarning = "La voix intégrée n’a pas pu démarrer. Rechargez Neptune ou utilisez Réessayer.";
  }
  render();
}

async function testVoiceActivation(): Promise<void> {
  preferences.wakeWordEnabled = true;
  await savePreferences();
  activationTested = false;
  startListening();
  orbState = "listening";
  transientWarning = "Dites maintenant « Neptune » ou « OK Neptune ».";
  render();
}

async function ensureManagedSelection(force: boolean): Promise<void> {
  if (force || preferences.providerId === "hermes") {
    preferences.providerId = "hermes";
    preferences.endpoint = "http://127.0.0.1:8642";
    preferences.model = "Qwen3-4B-Q4_K_M";
  }
}

async function refreshBrainState(): Promise<void> {
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
}

async function prepareManagedBrain(repair = false): Promise<void> {
  if (brainState === "preparing") return;
  if (preferences.providerId !== "hermes" && !repair) {
    await prepareLocalFallbackBrain();
    return;
  }
  brainState = "preparing";
  brainProgress = 0;
  brainError = "";
  orbState = "thinking";
  render();
  try {
    const progress = (state: ManagedHermesProgress) => {
      brainProgress = state.progress;
      transientWarning = state.detail;
      render();
    };
    const connection = repair
      ? await repairManagedHermes(progress, abortController?.signal)
      : await ensureManagedHermes(progress, abortController?.signal);
    preferences.providerId = "hermes";
    preferences.endpoint = connection.endpoint;
    preferences.model = connection.model;
    await savePreferences();
    brainState = "ready";
    brainProgress = 100;
    brainError = "";
    transientWarning = "Hermes est prêt avec sa mémoire et ses compétences.";
    orbState = "idle";
    appendAudit("MANAGED_HERMES_READY", connection.model + " · runtime " + (connection.runtimeVersion ?? "intégré"));
  } catch (error) {
    brainState = "error";
    orbState = "error";
    brainError = errorMessage(error);
    transientWarning = brainError;
    appendAudit("MANAGED_HERMES_ERROR", brainError);
  }
  render();
}

async function prepareLocalFallbackBrain(): Promise<void> {
  if (brainState === "preparing") return;
  brainState = "preparing";
  brainProgress = 0;
  brainError = "";
  render();

  const catalog = getLocalModelCatalog();
  const recommended = recommendModelId(catalog);
  const candidates = [...new Set([
    recommended,
    BALANCED_LOCAL_MODEL_ID,
    ...catalog.filter((model) => model.tier === "fast").map((model) => model.id),
    ...catalog.filter((model) => model.tier === "light").map((model) => model.id)
  ].filter(Boolean))];
  let lastError: unknown = null;

  for (const modelId of candidates) {
    try {
      await saveLocalModelSelection({ engine: "webllm", modelId });
      preferences.providerId = "chrome-local";
      preferences.model = modelId;
      await savePreferences();
      const api = getLocalLanguageModelApi();
      if (!api) throw new Error("Aucun moteur local compatible n’est disponible sur cet ordinateur.");
      const session = await api.create({
        initialPrompts: [{ role: "system", content: "Tu es Neptune. Réponds uniquement : prêt." }],
        monitor(monitor) {
          monitor.addEventListener("downloadprogress", (event) => {
            brainProgress = Math.round(Math.max(0, Math.min(1, event.loaded)) * 100);
            render();
          });
        }
      });
      await session.prompt("Réponds uniquement : prêt");
      session.destroy();
      brainProgress = 100;
      brainState = "ready";
      appendAudit("LOCAL_BRAIN_READY", modelId);
      render();
      return;
    } catch (error) {
      lastError = error;
      appendAudit("LOCAL_BRAIN_FALLBACK", `${modelId}: ${errorMessage(error)}`);
    }
  }

  const apiStatus = await getChromeAiAvailability();
  if (apiStatus === "available") {
    await saveLocalModelSelection({ engine: "chrome-native", modelId: recommended || BALANCED_LOCAL_MODEL_ID });
    brainState = "ready";
    brainProgress = 100;
    brainError = "Neptune utilise l’intelligence locale intégrée à Chrome.";
  } else {
    brainState = "error";
    orbState = "error";
    brainError = "Le moteur navigateur de secours n’est pas compatible avec ce poste. Revenez à Hermes intégré ou choisissez un autre secours.";
    appendAudit("LOCAL_BRAIN_ERROR", errorMessage(lastError));
  }
  render();
}

async function submitMessage(text: string): Promise<void> {
  const clean = text.trim();
  if (!clean || busy) return;
  draft = "";
  addMessage("user", clean);
  stopSpeaking();

  if (mission?.status === "blocked" && /^(continue|continuer|j'ai terminé|c'est fait|reprends|reprendre)/i.test(clean)) {
    await resumeMission();
    return;
  }

  const provider = await ensureProviderReady();
  if (!provider) {
    settingsOpen = true;
    advancedOpen = false;
    transientWarning = brainError || "Le cerveau Hermes intégré n’est pas prêt. Lancez NeptuneSetup.exe ou utilisez Réparer Hermes.";
    render();
    return;
  }

  if (isBrowserTask(clean)) {
    await proposeWorkspace(clean);
    return;
  }

  busy = true;
  typing = true;
  orbState = "thinking";
  abortController = new AbortController();
  render();
  try {
    const reply = await askIntelligence(provider, preferences.preferredName, messages.map((message) => ({
      role: message.role,
      content: message.text
    })), abortController.signal);
    typing = false;
    addMessage("assistant", reply);
    speak(reply);
  } catch (error) {
    typing = false;
    orbState = "error";
    addMessage("assistant", errorMessage(error), "warning");
  } finally {
    busy = false;
    abortController = null;
    if (!mission || ["completed", "stopped", "failed"].includes(mission.status)) orbState = "idle";
    render();
  }
}

async function ensureProviderReady(): Promise<ProviderConfig | null> {
  if (preferences.providerId === "hermes") {
    try {
      const connection = await ensureManagedHermes((state) => {
        brainState = "preparing";
        brainProgress = state.progress;
        transientWarning = state.detail;
        render();
      }, abortController?.signal);
      preferences.endpoint = connection.endpoint;
      preferences.model = connection.model;
      brainState = "ready";
      brainProgress = 100;
      await savePreferences();
      return { id: "hermes", apiKey: connection.apiKey, endpoint: connection.endpoint, model: connection.model };
    } catch (error) {
      brainState = "error";
      brainError = errorMessage(error);
      transientWarning = brainError;
      return null;
    }
  }
  if (preferences.providerId === "chrome-local") {
    const status = await getChromeAiAvailability();
    if (status !== "available") await prepareLocalFallbackBrain();
    if (brainState === "error") return null;
    return { id: "chrome-local" };
  }
  const apiKey = await loadSecret(preferences.providerId);
  if (!apiKey) return null;
  return { id: preferences.providerId, apiKey, endpoint: preferences.endpoint, model: preferences.model };
}

async function proposeWorkspace(goal: string): Promise<void> {
  const response = await sendRuntime<{ tab?: PublicTab | null }>({ type: "GET_ACTIVE_TAB" });
  const activeTab = response.ok ? response.result?.tab ?? null : null;
  const recommendation = inferWorkspaceMode(goal, activeTab?.url);
  workspacePrompt = { goal, recommended: recommendation.recommended, reason: recommendation.reason, activeTab };
  orbState = "permission";
  render();
}

async function beginWorkspaceMission(mode: WorkspaceMode): Promise<void> {
  const pending = workspacePrompt;
  if (!pending) return;
  if (!preferences.siteAccessGranted) {
    const granted = await requestSiteAccess();
    if (!granted) {
      transientWarning = "Chrome doit autoriser Neptune à agir sur les sites avant de commencer.";
      render();
      return;
    }
  }
  workspacePrompt = null;
  mission = createAgentMission(pending.goal);
  detailsOpen = true;
  blockedMessage = "";
  appendAudit("MISSION_STARTED", `${pending.goal} · ${mode}`);
  await saveMission();
  const started = await sendRuntime<{ tab?: PublicTab }>({ type: "START_MISSION", workspaceMode: mode });
  if (!started.ok) {
    await blockMission(describeBrowserError(started.error));
    return;
  }
  addMessage("assistant", workspaceStartMessage(mode));
  await advanceMission();
}

async function advanceMission(): Promise<void> {
  if (!mission || busy) return;
  const provider = await ensureProviderReady();
  if (!provider) {
    await blockMission(brainError || "Hermes n’est plus disponible. Utilisez Diagnostiquer et réparer Hermes, puis reprenez au checkpoint.");
    return;
  }
  busy = true;
  typing = true;
  abortController = new AbortController();
  orbState = "thinking";
  render();
  try {
    while (mission) {
      const continuation = canContinueMission(mission);
      if (!continuation.ok) {
        await blockMission(`Je m’arrête avant de tourner en boucle : ${continuation.reason}.`);
        return;
      }
      const observationResult = await observeCurrentPage();
      if (observationResult.error) {
        if (observationResult.error.requiresHuman) {
          await blockMission(describeBrowserError(observationResult.error));
          return;
        }
        mission = addHistory(mission, "error", observationResult.error.message);
        mission.lastError = observationResult.error.message;
      } else if (observationResult.observation) {
        mission = recordObservation(mission, observationResult.observation);
        if (mission.cycle >= 3 && isMissionStalled(mission)) {
          await blockMission("La page ne progresse plus malgré plusieurs tentatives. Effectuez l’étape bloquante, puis reprenez.");
          return;
        }
      }
      await saveMission();
      const decision = await planAgentStep(provider, preferences.preferredName, preferences.trustLevel, {
        goal: mission.goal,
        cycle: mission.cycle,
        remainingActions: mission.maxActions - mission.usedActions,
        ...(mission.lastObservation ? { observation: mission.lastObservation } : {}),
        history: mission.history,
        ...(mission.lastError ? { lastError: mission.lastError } : {})
      }, abortController.signal);
      typing = false;
      if (decision.done) {
        mission = addHistory(mission, "decision", decision.text || "Objectif atteint");
        mission.status = "completed";
        await saveMission();
        addMessage("assistant", decision.text || "Mission terminée.");
        speak(decision.text || "Mission terminée.");
        appendAudit("MISSION_COMPLETED", mission.goal);
        orbState = "idle";
        return;
      }
      if (decision.needsHuman) {
        await blockMission(decision.reason || decision.text || "Une intervention humaine est nécessaire.");
        return;
      }
      if (decision.actions.length === 0) {
        await blockMission(decision.text || "Je n’ai pas trouvé d’action suffisamment fiable pour continuer.");
        return;
      }
      mission = installDecision(mission, decision.actions, decision.text);
      await saveMission();
      render();
      const batch = await executeCurrentBatch();
      if (batch !== "continue") return;
      typing = true;
      orbState = "thinking";
      render();
    }
  } catch (error) {
    await blockMission(errorMessage(error));
  } finally {
    busy = false;
    typing = false;
    abortController = null;
    render();
  }
}

async function executeCurrentBatch(): Promise<"continue" | "paused" | "blocked"> {
  if (!mission) return "blocked";
  orbState = "executing";
  render();
  for (let index = mission.currentIndex; index < mission.actions.length; index += 1) {
    const action = mission.actions[index];
    if (!action) continue;
    mission.currentIndex = index;
    if (needsApproval(action) && mission.approvedActionId !== action.id) {
      action.status = "blocked";
      mission.status = "awaiting_approval";
      mission = addHistory(mission, "human", `Autorisation demandée : ${action.label}`);
      await saveMission();
      orbState = "permission";
      busy = false;
      typing = false;
      addMessage("assistant", `L’action « ${action.label} » nécessite votre autorisation.`, "permission");
      speak("Cette action nécessite votre autorisation.");
      render();
      return "paused";
    }
    mission = markActionStarted(mission, index);
    await saveMission();
    appendAudit("ACTION_STARTED", action.label);
    const response = await sendRuntime({
      type: "EXECUTE_ACTION",
      action: { ...action, status: "pending" },
      approved: mission.approvedActionId === action.id || !needsApproval(action)
    });
    if (!response.ok) {
      mission = markActionFailed(mission, index, response.error?.message ?? "Action échouée");
      await saveMission();
      appendAudit("ACTION_FAILED", `${action.label} · ${response.error?.message ?? "Erreur"}`);
      if (response.error?.requiresHuman || response.error?.retryable === false) {
        await blockMission(describeBrowserError(response.error));
        return "blocked";
      }
      mission.status = "running";
      mission.currentIndex = mission.actions.length;
      await saveMission();
      return "continue";
    }
    mission = markActionCompleted(mission, index, response.result ?? null);
    mission.status = "running";
    await saveMission();
    appendAudit("ACTION_COMPLETED", action.label);
    render();
    if (["OPEN_URL", "CLICK_ELEMENT", "SEND_MESSAGE", "NAVIGATE_BACK", "SCROLL_PAGE"].includes(action.type)) {
      mission.currentIndex = mission.actions.length;
      await saveMission();
      return "continue";
    }
  }
  return "continue";
}

async function observeCurrentPage(): Promise<{ observation?: AgentObservation; error?: BrowserError }> {
  const status = await sendRuntime<{ tab?: PublicTab }>({ type: "GET_WORK_TAB" });
  const url = status.result?.tab?.url;
  if (!status.ok) return { ...(status.error ? { error: status.error } : {}) };
  if (!url || !/^https?:\/\//i.test(url)) return {};
  const readAction: BrowserAction = {
    id: crypto.randomUUID(),
    type: "READ_PAGE",
    label: "Observer l’état actuel de la page",
    risk: "read_only",
    requiresApproval: false,
    status: "pending"
  };
  const response = await sendRuntime<AgentObservation>({ type: "EXECUTE_ACTION", action: readAction, approved: true });
  if (!response.ok) return { ...(response.error ? { error: response.error } : {}) };
  return response.result ? { observation: response.result } : {};
}

async function approveCurrentAction(): Promise<void> {
  if (!mission || mission.status !== "awaiting_approval") return;
  const action = mission.actions[mission.currentIndex];
  if (!action) return;
  mission.approvedActionId = action.id;
  mission.status = "running";
  action.status = "pending";
  mission = addHistory(mission, "human", `Autorisé : ${action.label}`);
  await saveMission();
  appendAudit("ACTION_APPROVED", action.label);
  busy = false;
  await advanceMission();
}

async function resumeMission(): Promise<void> {
  if (!mission) return;
  mission.status = "running";
  mission.lastError = undefined;
  blockedMessage = "";
  await saveMission();
  busy = false;
  await advanceMission();
}

async function blockMission(message: string): Promise<void> {
  if (!mission) return;
  mission.status = "blocked";
  mission.lastError = message;
  mission = addHistory(mission, "human", message);
  blockedMessage = message;
  await saveMission();
  busy = false;
  typing = false;
  orbState = "blocked";
  addMessage("assistant", message, "warning");
  speak(message);
  appendAudit("MISSION_BLOCKED", message);
  render();
}

async function stopMission(message = "Mission arrêtée. Aucune action suivante ne sera exécutée."): Promise<void> {
  abortController?.abort();
  await sendRuntime({ type: "STOP_MISSION" }).catch(() => ({ ok: false }));
  if (mission) {
    mission.status = "stopped";
    mission = addHistory(mission, "human", message);
    await saveMission();
  }
  workspacePrompt = null;
  busy = false;
  typing = false;
  blockedMessage = "";
  orbState = "idle";
  stopSpeaking();
  addMessage("assistant", message, "warning");
  appendAudit("MISSION_STOPPED", message);
  render();
}

function needsApproval(action: BrowserAction): boolean {
  if (action.requiresApproval || action.risk === "external_write" || action.risk === "sensitive") return true;
  return preferences.trustLevel === "prudent" && action.risk !== "read_only";
}

async function requestSiteAccess(): Promise<boolean> {
  const granted = await chrome.permissions.request({ origins: HOST_ORIGINS });
  preferences.siteAccessGranted = granted;
  await savePreferences();
  return granted;
}

function toggleListening(): void {
  if (listeningWanted) stopListening();
  else startListening();
}

function startListening(): void {
  const target = window as NeptuneWindow;
  const Recognition = target.SpeechRecognition ?? target.webkitSpeechRecognition;
  if (!Recognition) {
    transientWarning = "La reconnaissance vocale n’est pas disponible dans cette version de Chrome.";
    orbState = "error";
    render();
    return;
  }
  if (!recognition) {
    recognition = new Recognition();
    recognition.lang = "fr-FR";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => { recognitionRunning = true; orbState = "listening"; render(); };
    recognition.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result?.isFinal) handleTranscript(result[0]?.transcript ?? "");
      }
    };
    recognition.onerror = (event) => {
      if (!["aborted", "no-speech"].includes(event.error)) {
        transientWarning = voiceErrorMessage(event.error);
        orbState = "error";
        render();
      }
    };
    recognition.onend = () => {
      recognitionRunning = false;
      if (listeningWanted && !recognitionPausedForSpeech) window.setTimeout(restartRecognition, 350);
      else if (!recognitionPausedForSpeech) { orbState = "idle"; render(); }
    };
  }
  listeningWanted = true;
  restartRecognition();
}

function restartRecognition(): void {
  if (!recognition || recognitionRunning || !listeningWanted || recognitionPausedForSpeech) return;
  try { recognition.start(); }
  catch { window.setTimeout(() => { try { recognition?.start(); } catch { stopListening(); } }, 500); }
}

function handleTranscript(raw: string): void {
  const transcript = raw.trim();
  if (!transcript) return;
  const normalized = normalizeSpeech(transcript);
  const candidates = ["ok neptune", "neptune"];
  const detected = candidates.find((candidate) => normalized.includes(candidate));
  if (!detected && !waitingForWakeCommand) return;

  if (!preferences.onboardingComplete && preferences.onboardingStep === 2) {
    activationTested = true;
    transientWarning = "Activation vocale validée. Neptune vous entend correctement.";
    orbState = "speaking";
    render();
    speak("Je vous entends. L’activation vocale est prête.");
    return;
  }

  if (waitingForWakeCommand) {
    waitingForWakeCommand = false;
    void submitMessage(transcript);
    return;
  }
  const index = normalized.indexOf(detected!);
  const command = transcript.slice(Math.max(0, index + detected!.length)).replace(/^[,.:;!?\s-]+/, "").trim();
  if (command) void submitMessage(command);
  else {
    waitingForWakeCommand = true;
    speak("Je vous écoute.");
  }
}

function stopListening(): void {
  listeningWanted = false;
  waitingForWakeCommand = false;
  recognitionPausedForSpeech = false;
  if (recognitionRunning) recognition?.stop();
  recognition = null;
  recognitionRunning = false;
  if (orbState === "listening") orbState = "idle";
  render();
}

function speak(text: string): void {
  if (!text.trim()) return;
  speechSynthesis.cancel();
  const shouldResume = listeningWanted && preferences.autoResumeVoice;
  if (recognitionRunning) {
    recognitionPausedForSpeech = true;
    recognition?.stop();
  }
  const utterance = new SpeechSynthesisUtterance(text.slice(0, 1_800));
  utterance.lang = "fr-FR";
  utterance.rate = 1.02;
  utterance.pitch = 1;
  utterance.onstart = () => { orbState = "speaking"; render(); };
  utterance.onend = () => {
    recognitionPausedForSpeech = false;
    orbState = shouldResume ? "listening" : mission?.status === "blocked" ? "blocked" : "idle";
    render();
    if (shouldResume) window.setTimeout(restartRecognition, 250);
  };
  utterance.onerror = () => {
    recognitionPausedForSpeech = false;
    orbState = "idle";
    render();
    if (shouldResume) restartRecognition();
  };
  speechSynthesis.speak(utterance);
}

function stopSpeaking(): void {
  speechSynthesis.cancel();
  stopLocalPlayback(false);
  recognitionPausedForSpeech = false;
  if (orbState === "speaking") orbState = "idle";
}

async function selectAdvancedLocalModel(modelId: string): Promise<void> {
  if (!modelId) return;
  await saveLocalModelSelection({ engine: "webllm", modelId });
  preferences.providerId = "chrome-local";
  preferences.model = modelId;
  brainState = "idle";
  brainProgress = 0;
  await savePreferences();
  render();
}

async function selectProvider(providerId: ProviderId): Promise<void> {
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
}

async function saveCurrentProviderSecret(): Promise<void> {
  if (["chrome-local", "hermes"].includes(preferences.providerId)) return;
  if (secretDraft.trim().length < 8) throw new Error("La clé API paraît incomplète.");
  await saveSecret(preferences.providerId, secretDraft);
  secretDraft = "";
  providerSecretSaved = true;
  await savePreferences();
  appendAudit("PROVIDER_CONFIGURED", preferences.providerId);
  render();
}

async function testProvider(): Promise<void> {
  const provider = await ensureProviderReady();
  if (!provider) throw new Error("Le fournisseur n’est pas prêt.");
  busy = true;
  render();
  try {
    const answer = await askIntelligence(provider, preferences.preferredName, [{ role: "user", content: "Réponds uniquement : Neptune est prêt." }]);
    transientWarning = answer.slice(0, 240);
  } finally {
    busy = false;
    render();
  }
}

function render(): void {
  app.innerHTML = preferences.onboardingComplete ? renderAssistant() : renderOnboarding();
  window.requestAnimationFrame(() => {
    const conversation = document.getElementById("conversation");
    if (conversation) conversation.scrollTop = conversation.scrollHeight;
    animateSpectrum();
    if (!preferences.onboardingComplete && preferences.onboardingStep === 3 && brainState === "idle") void prepareManagedBrain();
  });
}

function renderOnboarding(): string {
  const step = preferences.onboardingStep;
  return `<section class="onboarding">
    <div class="progress">${Array.from({ length: ONBOARDING_LAST_STEP + 1 }, (_, index) => `<span class="${index <= step ? "active" : ""}"></span>`).join("")}</div>
    <div class="onboarding-body">${renderHologram(true)}<div class="onboarding-copy">${onboardingMarkup(step)}</div></div>
    ${transientWarning ? `<div class="notice ${orbState === "error" ? "warning" : "success"}">${escapeHtml(transientWarning)}</div>` : ""}
    <footer class="onboarding-actions"><button type="button" class="ghost-button" data-action="onboarding-back" ${step === 0 ? "disabled" : ""}>Retour</button><button type="button" class="primary-button" data-action="onboarding-next" ${canContinueOnboarding() ? "" : "disabled"}>${step === ONBOARDING_LAST_STEP ? "Commencer avec Neptune" : "Continuer"}</button></footer>
  </section>`;
}

function onboardingMarkup(step: number): string {
  if (step === 0) return `<p class="eyebrow">PREMIER ÉCHANGE</p><h2>Comment dois-je vous appeler ?</h2><p>Neptune personnalisera ses validations et ses interventions sans vous exposer de réglages techniques.</p><div class="field"><label for="preferred-name">Votre prénom</label><input id="preferred-name" class="input" value="${escapeAttribute(preferences.preferredName)}" placeholder="Johan" autofocus /></div>`;
  if (step === 1) return `<p class="eyebrow">VOIX INTÉGRÉE</p><h2>Préférez-vous une voix féminine ou masculine ?</h2><p>Les deux voix sont déjà incluses dans Neptune. Aucun téléchargement ni voix Windows par défaut.</p><div class="voice-pair">${voiceChoice("female")}${voiceChoice("male")}</div>${voiceState === "preparing" ? progressMarkup("Préparation de la voix intégrée", voiceProgress) : voiceState === "error" ? `<div class="notice warning">La voix n'a pas pu démarrer.</div><button type="button" class="primary-button wide-button" data-action="retry-voice">Réessayer la voix</button>` : ""}`;
  if (step === 2) return `<p class="eyebrow">ACTIVATION VOCALE</p><h2>Dites « Neptune » ou « OK Neptune »</h2><p>L’activation est déjà configurée. Ce test vérifie simplement que votre microphone vous entend correctement.</p><div class="wake-test ${activationTested ? "success" : ""}"><span class="wake-dot"></span><strong>${activationTested ? "Activation validée" : listeningWanted ? "Je vous écoute…" : "Prêt pour le test"}</strong></div><button type="button" class="primary-button wide-button" data-action="test-activation">${activationTested ? "Tester à nouveau" : "Tester maintenant"}</button>`;
  return `<p class="eyebrow">HERMES INTÉGRÉ</p><h2>Hermes se prépare automatiquement</h2><p>Neptune démarre automatiquement Hermes, sa mémoire et ses compétences. Aucune URL, clé API ou commande technique n’est demandée.</p>${brainStatusMarkup()}<div class="configuration-summary"><span>Voix ${preferences.voiceGender === "female" ? "féminine" : "masculine"}</span><span>Activation vocale prête</span><span>Hermes intégré</span></div>`;
}

function voiceChoice(gender: VoiceGender): string {
  const voice = voiceForGender(gender);
  const selected = preferences.voiceGender === gender;
  return `<article class="voice-choice ${selected ? "selected" : ""}"><button type="button" data-action="select-gender" data-value="${gender}"><span class="voice-symbol">${gender === "female" ? "F" : "M"}</span><strong>${voice.label}</strong><small>${voice.description}</small></button><button type="button" class="ghost-button" data-action="preview-gender" data-value="${gender}">Écouter</button></article>`;
}

function renderAssistant(): string {
  return `<section class="shell"><header class="topbar"><div class="brand-spectrum">${spectrumBars(18)}</div><div class="brand-copy"><p class="eyebrow">NEPTUNE</p><h1>Assistant navigateur</h1></div><button type="button" class="icon-button" data-action="open-settings" title="Réglages">⚙</button></header><section class="assistant"><div class="assistant-head"><span class="state-label">${stateLabel()}${mission ? ` · cycle ${mission.cycle}/${mission.maxCycles}` : ""}</span><div class="inline-actions"><button type="button" class="ghost-button" data-action="toggle-details">Mission</button><button type="button" class="danger-button" data-action="stop">Arrêter</button></div></div><div id="conversation" class="conversation-stage"><div class="hologram-sticky">${renderHologram(false)}</div><div class="messages">${messages.map(messageMarkup).join("")}${typing ? typingMarkup() : ""}</div>${workspacePrompt ? workspaceMarkup() : ""}${mission?.status === "awaiting_approval" ? approvalMarkup() : ""}${mission?.status === "blocked" ? blockedMarkup() : ""}${detailsOpen ? missionDetailsMarkup() : ""}${transientWarning ? `<div class="notice warning">${escapeHtml(transientWarning)}</div>` : ""}</div><div class="composer-wrap"><form id="composer" class="composer"><button type="button" class="micro-button ${listeningWanted ? "active" : ""}" data-action="toggle-micro" title="${listeningWanted ? "Arrêter l’écoute" : "Parler à Neptune"}"><span></span></button><textarea id="draft" placeholder="Écrivez ou dites votre objectif…" rows="2">${escapeHtml(draft)}</textarea><button type="submit" class="send-button" data-action="send" ${busy ? "disabled" : ""}>➤</button></form><div class="composer-hint"><span>${listeningWanted ? "Dites Neptune ou OK Neptune" : "Micro en pause"}</span><span>${brainLabel()}</span></div></div></section>${settingsOpen ? settingsMarkup() : ""}</section>`;
}

function renderHologram(full: boolean): string {
  return `<div class="neptune-hologram ${full ? "full" : "compact"} ${orbState}" data-spectrum-state="${orbState}" aria-label="Neptune ${stateLabel()}"><div class="spectrum-ring">${spectrumBars(full ? 64 : 48)}</div><div class="spectrum-aura"></div><div class="spectrum-core"><i></i><i></i><i></i></div></div>`;
}

function spectrumBars(count: number): string {
  return Array.from({ length: count }, (_, index) => `<i class="spectrum-bar" style="--i:${index};--count:${count};--seed:${(index * 17) % 23}"></i>`).join("");
}

function animateSpectrum(): void {
  for (const element of Array.from(document.querySelectorAll<HTMLElement>(".neptune-hologram"))) {
    element.dataset.spectrumState = orbState;
  }
}

function workspaceMarkup(): string {
  const prompt = workspacePrompt!;
  const activeTitle = prompt.activeTab?.title || prompt.activeTab?.url || "l’onglet actuel";
  return `<section class="intervention workspace"><p class="eyebrow">ESPACE DE TRAVAIL</p><strong>Où souhaitez-vous que je travaille ?</strong><p>${escapeHtml(prompt.reason)}</p><div class="workspace-current"><span>Page détectée</span><b>${escapeHtml(activeTitle)}</b></div><div class="workspace-grid"><button type="button" class="workspace-option ${prompt.recommended === "current-tab" ? "recommended" : ""}" data-action="workspace-current" ${prompt.activeTab?.url && /^https?:\/\//i.test(prompt.activeTab.url) ? "" : "disabled"}><strong>Prendre le relais ici</strong><small>J’utilise la page déjà ouverte</small></button><button type="button" class="workspace-option ${prompt.recommended === "new-tab" ? "recommended" : ""}" data-action="workspace-tab"><strong>Nouvel onglet</strong><small>Je sépare la mission du reste</small></button><button type="button" class="workspace-option ${prompt.recommended === "new-window" ? "recommended" : ""}" data-action="workspace-window"><strong>Nouvelle fenêtre</strong><small>Je crée un espace dédié</small></button></div><button type="button" class="ghost-button" data-action="workspace-cancel">Annuler</button></section>`;
}

function approvalMarkup(): string {
  const action = mission?.actions[mission.currentIndex];
  return `<section class="intervention permission"><strong>Autorisation requise</strong><p>${escapeHtml(action?.label ?? "Action externe")}</p><div class="inline-actions"><button type="button" class="primary-button" data-action="approve">Autoriser cette action</button><button type="button" class="secondary-button" data-action="deny">Refuser</button></div></section>`;
}

function blockedMarkup(): string {
  const permissionMissing = !preferences.siteAccessGranted;
  return `<section class="intervention blocked"><strong>Intervention nécessaire</strong><p>${escapeHtml(blockedMessage || mission?.lastError || "La mission est en pause.")}</p><div class="inline-actions">${permissionMissing ? `<button type="button" class="primary-button" data-action="grant-and-resume">Autoriser et reprendre</button>` : `<button type="button" class="primary-button" data-action="resume">Reprendre au checkpoint</button>`}<button type="button" class="secondary-button" data-action="deny">Arrêter</button></div></section>`;
}

function missionDetailsMarkup(): string {
  if (!mission) return `<section class="intervention"><strong>Détails de la mission</strong><p>Aucune mission en cours.</p></section>`;
  return `<section class="intervention"><strong>Détails de la mission</strong><p>${escapeHtml(mission.goal)}</p><div class="notice">Progression : ${missionProgress(mission)} % · ${mission.usedActions}/${mission.maxActions} actions</div><div class="audit-list">${mission.actions.map((action, index) => `<div class="audit-item"><time>${index + 1} · ${escapeHtml(action.status)}</time>${escapeHtml(action.label)}<br><small>${escapeHtml(action.type)}</small></div>`).join("")}${mission.history.slice(-8).reverse().map((entry) => `<div class="audit-item"><time>cycle ${entry.cycle} · ${escapeHtml(entry.type)}</time>${escapeHtml(entry.summary)}</div>`).join("")}</div></section>`;
}

function settingsMarkup(): string {
  const catalog = getLocalModelCatalog();
  const selectionLabel = preferences.providerId === "hermes" ? "Hermes intégré" : catalog.find((model) => model.id === preferences.model)?.name ?? "Neptune local";
  return `<div class="modal-backdrop"><section class="modal"><header class="modal-head"><div><p class="eyebrow">PRÉFÉRENCES</p><h2>Configurer Neptune</h2></div><button type="button" class="icon-button" data-action="close-settings">×</button></header><div class="settings-section"><h3>Expérience</h3><div class="field"><label for="settings-name">Votre prénom</label><input id="settings-name" class="input" value="${escapeAttribute(preferences.preferredName)}" /></div><div class="settings-voice-pair">${settingsVoiceButton("female")}${settingsVoiceButton("male")}</div><p>Activation : « Neptune » et « OK Neptune » sont déjà actifs.</p></div><div class="settings-section"><h3>Cerveau actuel</h3><div class="setting-status"><strong>${escapeHtml(selectionLabel)}</strong><span>${brainState === "ready" ? "Prêt localement" : brainState === "preparing" ? `Préparation ${brainProgress}%` : "À préparer"}</span></div><button type="button" class="ghost-button" data-action="toggle-advanced">${advancedOpen ? "Masquer les paramètres avancés" : "Paramètres avancés"}</button></div>${advancedOpen ? advancedSettingsMarkup() : ""}<div class="settings-section"><h3>Données locales</h3><p>${messages.length} message(s) et ${audit.length} événement(s) conservés dans ce profil Chrome.</p><div class="inline-actions"><button type="button" class="ghost-button" data-action="clear-history">Effacer la conversation</button><button type="button" class="ghost-button" data-action="clear-audit">Effacer le journal</button><button type="button" class="ghost-button" data-action="reset-onboarding">Relancer l’accueil</button></div></div></section></div>`;
}

function settingsVoiceButton(gender: VoiceGender): string {
  const voice = voiceForGender(gender);
  return `<button type="button" class="choice-card ${preferences.voiceGender === gender ? "selected" : ""}" data-action="select-gender" data-value="${gender}"><strong>${voice.label}</strong><small>${voice.description}</small></button>`;
}

function advancedSettingsMarkup(): string {
  const catalog = getLocalModelCatalog();
  const providerPanel = preferences.providerId === "hermes"
    ? managedHermesSettingsMarkup()
    : preferences.providerId !== "chrome-local"
      ? providerFieldsMarkup()
      : `<div class="notice ${isWebGpuAvailable() ? "success" : "warning"}">${isWebGpuAvailable() ? "WebGPU disponible pour le moteur local de secours." : "WebGPU indisponible : Hermes reste le moteur principal."}</div>`;
  return `<div class="settings-section advanced"><h3>Intelligence avancée</h3><p>Hermes intégré est le cerveau par défaut. Ces réglages servent uniquement à choisir un moteur de secours.</p><div class="field"><label for="advanced-provider">Moteur de secours</label><select id="advanced-provider" class="select"><option value="hermes" ${preferences.providerId === "hermes" ? "selected" : ""}>Hermes intégré — recommandé</option><option value="chrome-local" ${preferences.providerId === "chrome-local" ? "selected" : ""}>Modèle navigateur local</option><option value="mammouth" ${preferences.providerId === "mammouth" ? "selected" : ""}>Mammouth AI</option><option value="openai-compatible" ${preferences.providerId === "openai-compatible" ? "selected" : ""}>API compatible OpenAI</option></select></div>${preferences.providerId === "chrome-local" ? `<div class="field"><label>Modèle local de secours</label><select class="select" id="advanced-local-model">${catalog.map((model) => `<option value="${escapeAttribute(model.id)}" ${preferences.model === model.id ? "selected" : ""}>${escapeHtml(model.name)}</option>`).join("")}</select></div><button type="button" class="ghost-button" data-action="select-local-model" data-value="${escapeAttribute(preferences.model)}">Utiliser ce modèle local</button>` : ""}${providerPanel}<div class="field"><label>Niveau de contrôle</label><div class="trust-grid">${trustButton("prudent", "Prudent")}${trustButton("assisted", "Collaborateur")}${trustButton("controlled", "Autonome contrôlé")}</div></div></div>`;
}

function managedHermesSettingsMarkup(): string {
  return `<div class="notice ${brainState === "ready" ? "success" : brainState === "error" ? "warning" : ""}"><strong>Hermes intégré</strong><br>${brainState === "ready" ? "Mémoire, compétences et outils locaux opérationnels." : brainState === "preparing" ? `Préparation en cours — ${brainProgress}%` : escapeHtml(brainError || "Neptune démarre automatiquement Hermes lorsque nécessaire.")}</div><button type="button" class="ghost-button" data-action="repair-managed-hermes">Diagnostiquer et réparer Hermes</button>`;
}

function providerFieldsMarkup(): string {
  return `<div class="field"><label for="provider-endpoint">Adresse API</label><input id="provider-endpoint" class="input" value="${escapeAttribute(preferences.providerId === "mammouth" ? "https://api.mammouth.ai/v1" : preferences.endpoint)}" ${preferences.providerId === "mammouth" ? "readonly" : ""} /></div><div class="field"><label for="provider-model">Modèle</label><input id="provider-model" class="input" value="${escapeAttribute(preferences.model)}" /></div><div class="field"><label for="provider-secret">Clé API ${providerSecretSaved ? "— enregistrée" : ""}</label><input id="provider-secret" type="password" class="input" value="${escapeAttribute(secretDraft)}" /></div><div class="inline-actions"><button type="button" class="primary-button" data-action="save-provider-secret">Enregistrer</button><button type="button" class="ghost-button" data-action="test-provider">Tester</button>${providerSecretSaved ? `<button type="button" class="danger-button" data-action="delete-provider-secret">Supprimer</button>` : ""}</div>`;
}

function trustButton(level: TrustLevel, label: string): string {
  return `<button type="button" class="choice-card ${preferences.trustLevel === level ? "selected" : ""}" data-action="select-trust" data-value="${level}">${label}</button>`;
}

function brainStatusMarkup(): string {
  if (brainState === "ready") return `<div class="notice success">Hermes est prêt avec sa mémoire, ses compétences et ses outils locaux.</div>`;
  if (brainState === "preparing") return `${progressMarkup("Préparation automatique de Hermes", brainProgress)}<p class="preparation-note">Le premier démarrage peut prendre quelques minutes. Aucune clé ni configuration n’est demandée.</p>`;
  if (brainState === "error") return `<div class="notice warning">${escapeHtml(brainError || "Hermes n’a pas pu démarrer.")}</div><button type="button" class="primary-button wide-button" data-action="repair-managed-hermes">Installer ou réparer Hermes</button>`;
  return `<button type="button" class="primary-button wide-button" data-action="prepare-brain">Démarrer Hermes</button>`;
}

function progressMarkup(label: string, progress: number): string {
  return `<div class="preparation"><div class="preparation-row"><span>${escapeHtml(label)}</span><b>${progress}%</b></div><div class="download-progress"><span style="width:${progress}%"></span></div></div>`;
}

function messageMarkup(message: ConversationMessage): string {
  return `<article class="message ${message.role === "assistant" ? "neptune" : "user"} ${message.tone}"><span class="message-role">${message.role === "assistant" ? "Neptune" : escapeHtml(preferences.preferredName || "Vous")}</span>${escapeHtml(message.text).replace(/\n/g, "<br>")}</article>`;
}

function typingMarkup(): string {
  return `<article class="message neptune"><span class="message-role">Neptune</span><span class="typing"><i></i><i></i><i></i></span></article>`;
}

function canContinueOnboarding(): boolean {
  if (preferences.onboardingStep === 0) return preferences.preferredName.trim().length >= 2;
  if (preferences.onboardingStep === 1) return voiceState === "ready";
  if (preferences.onboardingStep === 2) return activationTested;
  if (preferences.onboardingStep === 3) return brainState === "ready";
  return true;
}

function stateLabel(): string {
  return ({ idle: "Prêt", listening: "À l’écoute", thinking: "Réflexion", executing: "Action en cours", speaking: "Neptune répond", permission: "Votre décision", blocked: "Intervention nécessaire", error: "À vérifier" } satisfies Record<OrbState, string>)[orbState];
}

function onboardingSpeech(step: number): string {
  return ["Comment dois-je vous appeler ?", "Préférez-vous une voix féminine ou masculine ?", "Dites Neptune ou OK Neptune pour échanger avec moi.", "Je prépare Hermes, ma mémoire et mes compétences."][step] ?? "";
}

function brainLabel(): string {
  if (preferences.providerId === "hermes") return brainState === "ready" ? "Hermes intégré · local" : "Hermes se prépare";
  if (preferences.providerId === "mammouth") return "Mammouth AI · secours";
  if (preferences.providerId === "openai-compatible") return "API externe · secours";
  return brainState === "ready" ? "Modèle navigateur · secours" : "Moteur de secours";
}

function workspaceStartMessage(mode: WorkspaceMode): string {
  if (mode === "current-tab") return "Je prends le relais sur la page actuelle. J’observe d’abord avant toute action.";
  if (mode === "new-window") return "J’ouvre une fenêtre dédiée et j’y exécute la mission étape par étape.";
  return "J’ouvre un nouvel onglet de travail et je vérifie chaque changement avant de continuer.";
}

function addMessage(role: ConversationMessage["role"], text: string, tone: ConversationMessage["tone"] = "normal"): void {
  if (!text.trim()) return;
  messages = [...messages, { id: crypto.randomUUID(), role, text: text.trim(), tone, createdAt: new Date().toISOString() }].slice(-MAX_MESSAGES);
  void chrome.storage.local.set({ [STORAGE_MESSAGES]: messages });
  render();
}

function appendAudit(type: string, detail: string): void {
  audit = [...audit, { id: crypto.randomUUID(), type, detail: detail.slice(0, 800), occurredAt: new Date().toISOString() }].slice(-MAX_AUDIT);
  void chrome.storage.local.set({ [STORAGE_AUDIT]: audit });
}

async function savePreferences(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_PREFERENCES]: preferences });
}

async function saveMission(): Promise<void> {
  if (mission) await chrome.storage.session.set({ [STORAGE_MISSION]: cloneAgentMission(mission) });
  else await chrome.storage.session.remove(STORAGE_MISSION);
}

async function resetOnboarding(): Promise<void> {
  stopListening();
  stopSpeaking();
  preferences = { ...preferences, onboardingComplete: false, onboardingStep: 0, productVersion: PRODUCT_VERSION };
  settingsOpen = false;
  advancedOpen = false;
  activationTested = false;
  await savePreferences();
  render();
  speak("Reprenons simplement. Comment dois-je vous appeler ?");
}

async function sendRuntime<T = unknown>(payload: Record<string, unknown>): Promise<RuntimeResponse<T>> {
  return chrome.runtime.sendMessage(payload) as Promise<RuntimeResponse<T>>;
}

function describeBrowserError(error?: BrowserError): string {
  if (!error) return "La mission s’est interrompue sans détail exploitable.";
  switch (error.code) {
    case "HUMAN_VERIFICATION": return "Le site demande une vérification humaine. Effectuez-la, puis reprenez au checkpoint.";
    case "AUTHENTICATION_REQUIRED": return "Le compte nécessaire n’est pas connecté. Connectez-vous, puis reprenez la mission.";
    case "PAGE_PERMISSION": return "Chrome a refusé l’accès à cette page. Vérifiez les autorisations, puis reprenez.";
    case "TARGET_NOT_FOUND": return "L’élément attendu n’est plus visible. Je vais réobserver la page et adapter le plan.";
    case "NAVIGATION_TIMEOUT": return "La page a mis trop de temps à répondre. Vérifiez l’espace de travail puis reprenez.";
    case "MISSION_STOPPED": return "La mission a été arrêtée.";
    default: return `J’ai rencontré un blocage : ${error.message}`;
  }
}

function voiceErrorMessage(error: string): string {
  const messagesByCode: Record<string, string> = {
    "not-allowed": "L’accès au microphone a été refusé. Autorisez le microphone dans Chrome.",
    "service-not-allowed": "Le service de reconnaissance vocale est bloqué par Chrome.",
    "audio-capture": "Aucun microphone n’est disponible.",
    network: "La reconnaissance vocale est momentanément indisponible."
  };
  return messagesByCode[error] ?? `Erreur de reconnaissance vocale : ${error}`;
}

function normalizeSpeech(value: string): string {
  return value.toLocaleLowerCase("fr-FR").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "Une erreur inattendue est survenue.";
}

function isAgentMission(value: unknown): value is AgentMission {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AgentMission>;
  return typeof record.id === "string" && typeof record.goal === "string" && Array.isArray(record.actions) && Array.isArray(record.history);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Élément #${id} introuvable`);
  return element as T;
}

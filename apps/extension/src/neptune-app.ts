import { missionProgress, type AgentMission } from "./agent-core";
import { askIntelligence, isBrowserTask, type ProviderConfig, type TrustLevel } from "./intelligence";
import {
  prepareLocalVoice,
  previewLocalVoice,
  setSelectedVoiceUri,
  stopLocalPlayback
} from "./local-voice-runtime";
import {
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
  providerId: "hermes";
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
type ManagedConnection = { endpoint: string; apiKey: string; model: string; runtimeVersion?: string };
type PublicTab = { id?: number; url?: string; title?: string };
type WorkspacePrompt = {
  goal: string;
  recommended: WorkspaceMode;
  reason: string;
  activeTab: PublicTab | null;
};
type AgentStartResult = { mission?: AgentMission; tab?: PublicTab; missionControl?: unknown };
type AgentStopResult = { mission?: AgentMission; missionControl?: unknown };

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
const STORAGE_MISSION = "neptune.agent.mission.v3";
const PENDING_TRANSCRIPT_KEY = "neptune.pendingVoiceTranscript.v1";
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
let detailsOpen = false;
let busy = false;
let typing = false;
let blockedMessage = "";
let transientNotice = "";
let workspacePrompt: WorkspacePrompt | null = null;
let voiceState: ReadyState = "idle";
let voiceProgress = 0;
let engineState: ReadyState = "idle";
let engineProgress = 0;
let engineError = "";
let activationTested = false;
let activationSkipped = false;
let abortController: AbortController | null = null;
let recognition: RecognitionLike | null = null;
let listeningWanted = false;
let recognitionRunning = false;
let recognitionPausedForSpeech = false;
let waitingForWakeCommand = false;
const pendingActions = new Set<string>();

void initialize();

async function initialize(): Promise<void> {
  const [stored, session] = await Promise.all([
    chrome.storage.local.get([STORAGE_PREFERENCES, STORAGE_MESSAGES, STORAGE_AUDIT, STORAGE_MISSION]),
    chrome.storage.session.get(PENDING_TRANSCRIPT_KEY)
  ]);

  const previous = stored[STORAGE_PREFERENCES] as Partial<Preferences> | undefined;
  preferences = {
    ...DEFAULT_PREFERENCES,
    ...previous,
    productVersion: PRODUCT_VERSION,
    providerId: "hermes"
  };
  if (!preferences.voiceURI) preferences.voiceURI = voiceForGender(preferences.voiceGender).uri;
  messages = normalizeMessages(stored[STORAGE_MESSAGES]);
  audit = normalizeAudit(stored[STORAGE_AUDIT]);
  mission = isAgentMission(stored[STORAGE_MISSION]) ? stored[STORAGE_MISSION] as AgentMission : null;
  blockedMessage = mission?.status === "blocked" ? mission.lastError ?? "La mission attend votre intervention." : "";
  preferences.siteAccessGranted = await chrome.permissions.contains({ origins: HOST_ORIGINS });
  setSelectedVoiceUri(preferences.voiceURI);

  bindEvents();
  await savePreferences();
  render();

  if (!preferences.onboardingComplete) {
    if (preferences.onboardingStep === 0) void prepareSelectedVoice(false);
    if (preferences.onboardingStep === ONBOARDING_LAST_STEP) void prepareEngine(false);
  } else {
    void refreshEngineState();
    void refreshMission();
    if (messages.length === 0) {
      addMessage("assistant", `Bonjour ${preferences.preferredName || ""}. Donnez-moi un objectif ; je peux le poursuivre même si vous fermez le panneau.`);
    }
    if (preferences.wakeWordEnabled) void enableBackgroundWake();
  }

  const pendingTranscript = typeof session[PENDING_TRANSCRIPT_KEY] === "string"
    ? session[PENDING_TRANSCRIPT_KEY].trim()
    : "";
  if (pendingTranscript) {
    await chrome.storage.session.remove(PENDING_TRANSCRIPT_KEY);
    window.setTimeout(() => void submitMessage(stripWakeWord(pendingTranscript)), 300);
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

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE_MISSION]) {
      const value = changes[STORAGE_MISSION].newValue;
      mission = isAgentMission(value) ? value : null;
      blockedMessage = mission?.status === "blocked" ? mission.lastError ?? "La mission attend votre intervention." : "";
      syncOrbWithMission();
    }
    if (changes[STORAGE_MESSAGES]) messages = normalizeMessages(changes[STORAGE_MESSAGES].newValue);
    if (changes[STORAGE_AUDIT]) audit = normalizeAudit(changes[STORAGE_AUDIT].newValue);
    render();
  });

  chrome.runtime.onMessage.addListener((message: Record<string, unknown>) => {
    if (message?.target !== "neptune-sidepanel") return false;
    if (message.type === "WAKE_TRANSCRIPT" && typeof message.transcript === "string") {
      void submitMessage(stripWakeWord(message.transcript));
    }
    if (message.type === "HERMES_STATUS") {
      engineState = message.phase === "ready" ? "ready" : "preparing";
      engineProgress = clampProgress(message.progress);
      transientNotice = typeof message.detail === "string" ? message.detail : "Préparation de Neptune…";
      render();
    }
    if (message.type === "AGENT_STATE_CHANGED" && isAgentMission(message.mission)) {
      mission = message.mission;
      syncOrbWithMission();
      render();
    }
    return false;
  });
}

async function dispatchClick(event: Event): Promise<void> {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
  if (!button || button.disabled) return;
  event.preventDefault();
  const action = button.dataset.action ?? "";
  const value = button.dataset.value ?? "";
  const key = `${action}:${value}`;
  if (pendingActions.has(key)) return;
  pendingActions.add(key);
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  transientNotice = "";

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
      case "retry-voice": await prepareSelectedVoice(true); break;
      case "test-activation": await testVoiceActivation(); break;
      case "skip-activation": await skipVoiceActivation(); break;
      case "send": await submitMessage(draft); break;
      case "toggle-micro": toggleListening(); break;
      case "open-settings": settingsOpen = true; render(); break;
      case "close-settings": settingsOpen = false; render(); break;
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
      case "workspace-cancel": workspacePrompt = null; orbState = "idle"; render(); break;
      case "select-trust":
        preferences.trustLevel = value as TrustLevel;
        await savePreferences();
        render();
        break;
      case "prepare-engine": await prepareEngine(false); break;
      case "repair-engine": await prepareEngine(true); break;
      case "toggle-background-wake":
        preferences.wakeWordEnabled = !preferences.wakeWordEnabled;
        await savePreferences();
        if (preferences.wakeWordEnabled) await enableBackgroundWake();
        else await sendRuntime({ type: "STOP_WAKE_LISTENER" });
        render();
        break;
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
    transientNotice = errorMessage(error);
    orbState = "error";
    render();
  } finally {
    pendingActions.delete(key);
    if (button.isConnected) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }
}

function handleInput(event: Event): void {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  switch (target.id) {
    case "preferred-name":
      preferences.preferredName = target.value.slice(0, 80);
      void savePreferences();
      updateOnboardingButton();
      break;
    case "settings-name":
      preferences.preferredName = target.value.slice(0, 80);
      void savePreferences();
      break;
    case "draft":
      draft = target.value.slice(0, 10_000);
      break;
  }
}

async function nextOnboardingStep(): Promise<void> {
  const step = preferences.onboardingStep;
  if (step === 0 && preferences.preferredName.trim().length < 2) return;
  if (step === 1 && voiceState === "idle") await prepareSelectedVoice(false);
  if (step === 2 && !activationTested && !activationSkipped) {
    transientNotice = "Testez le microphone ou choisissez Continuer sans activation vocale.";
    render();
    return;
  }

  if (step < ONBOARDARDING_LAST_STEP_SAFE()) {
    preferences.onboardingStep += 1;
    await savePreferences();
    render();
    if (preferences.onboardingStep === ONBOARDING_LAST_STEP) void prepareEngine(false);
    else speak(onboardingSpeech(preferences.onboardingStep));
    return;
  }

  if (engineState !== "ready") {
    await prepareEngine(false);
    if (engineState !== "ready") return;
  }
  preferences.onboardingComplete = true;
  preferences.wakeWordEnabled = !activationSkipped;
  await savePreferences();
  addMessage("assistant", `Configuration terminée. ${preferences.preferredName}, donnez-moi simplement votre objectif.`);
  orbState = "idle";
  render();
  speak(`Configuration terminée. ${preferences.preferredName}, je suis prêt.`);
  if (preferences.wakeWordEnabled) await enableBackgroundWake();
}

function ONBOARDARDING_LAST_STEP_SAFE(): number {
  return ONBOARDING_LAST_STEP;
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
    const progress = (value: number) => {
      voiceProgress = Math.round(value * 100);
      render();
    };
    if (preview) await previewLocalVoice(voice.id, progress);
    else await prepareLocalVoice(voice.id, progress);
    voiceState = "ready";
    voiceProgress = 100;
    transientNotice = "";
    appendAudit("VOICE_READY", voice.label);
  } catch (error) {
    voiceState = "error";
    transientNotice = "La voix locale n’a pas pu être préparée. Neptune restera utilisable au clavier.";
    appendAudit("VOICE_ERROR", errorMessage(error));
  }
  render();
}

async function testVoiceActivation(): Promise<void> {
  activationTested = false;
  activationSkipped = false;
  preferences.wakeWordEnabled = true;
  await savePreferences();
  startListening();
  orbState = "listening";
  transientNotice = "Dites maintenant « Neptune » ou « OK Neptune ».";
  render();
}

async function skipVoiceActivation(): Promise<void> {
  activationSkipped = true;
  activationTested = false;
  preferences.wakeWordEnabled = false;
  stopListening();
  await savePreferences();
  transientNotice = "Activation vocale désactivée. Le clavier reste entièrement fonctionnel.";
  orbState = "idle";
  render();
}

async function refreshEngineState(): Promise<void> {
  const response = await sendRuntime<{ ready?: boolean; detail?: string; connection?: ManagedConnection }>({ type: "GET_MANAGED_HERMES_STATUS" });
  if (response.ok && response.result?.ready) {
    engineState = "ready";
    engineProgress = 100;
    engineError = "";
    return;
  }
  engineState = "idle";
  void prepareEngine(false);
}

async function prepareEngine(repair: boolean): Promise<void> {
  if (engineState === "preparing") return;
  engineState = "preparing";
  engineProgress = 8;
  engineError = "";
  orbState = "thinking";
  transientNotice = repair ? "Réparation automatique de Neptune…" : "Démarrage du moteur Neptune…";
  render();

  try {
    const response = await sendRuntime<ManagedConnection>({ type: repair ? "REPAIR_MANAGED_HERMES" : "GET_MANAGED_HERMES" });
    if (!response.ok || !response.result) throw new Error(response.error?.message || "Le moteur Neptune n’a pas répondu.");
    preferences.endpoint = response.result.endpoint;
    preferences.model = response.result.model;
    await savePreferences();
    engineState = "ready";
    engineProgress = 100;
    engineError = "";
    transientNotice = "Neptune est prêt.";
    orbState = mission ? orbForMission(mission) : "idle";
    appendAudit("ENGINE_READY", response.result.runtimeVersion || "local");
  } catch (error) {
    engineState = "error";
    engineError = errorMessage(error);
    transientNotice = engineError;
    orbState = "error";
    appendAudit("ENGINE_ERROR", engineError);
  }
  render();
}

async function ensureProviderReady(): Promise<ProviderConfig | null> {
  const response = await sendRuntime<ManagedConnection>({ type: "GET_MANAGED_HERMES" });
  if (!response.ok || !response.result) {
    engineState = "error";
    engineError = response.error?.message || "Le moteur Neptune est indisponible.";
    transientNotice = engineError;
    return null;
  }
  engineState = "ready";
  engineProgress = 100;
  preferences.endpoint = response.result.endpoint;
  preferences.model = response.result.model;
  await savePreferences();
  return {
    id: "hermes",
    apiKey: response.result.apiKey,
    endpoint: response.result.endpoint,
    model: response.result.model
  };
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

  if (isBrowserTask(clean)) {
    await proposeWorkspace(clean);
    return;
  }

  const provider = await ensureProviderReady();
  if (!provider) {
    transientNotice = engineError || "Neptune se répare automatiquement. Réessayez dans quelques instants.";
    render();
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
    addMessage("assistant", errorMessage(error), "warning");
    orbState = "error";
  } finally {
    busy = false;
    abortController = null;
    if (!mission || ["completed", "stopped", "failed"].includes(mission.status)) orbState = "idle";
    render();
  }
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
      transientNotice = "Chrome doit autoriser Neptune à agir sur les sites avant de commencer.";
      render();
      return;
    }
  }

  workspacePrompt = null;
  orbState = "executing";
  transientNotice = "Démarrage de la mission persistante…";
  render();
  const response = await sendRuntime<AgentStartResult>({
    type: "AGENT_START",
    goal: pending.goal,
    workspaceMode: mode
  });
  if (!response.ok) {
    transientNotice = describeBrowserError(response.error);
    orbState = "error";
    render();
    return;
  }
  mission = isAgentMission(response.result?.mission) ? response.result!.mission! : await loadMission();
  detailsOpen = true;
  syncOrbWithMission();
  render();
}

async function approveCurrentAction(): Promise<void> {
  const response = await sendRuntime<AgentMission>({ type: "AGENT_APPROVE" });
  if (!response.ok || !isAgentMission(response.result)) {
    transientNotice = describeBrowserError(response.error);
    render();
    return;
  }
  mission = response.result;
  syncOrbWithMission();
  render();
}

async function resumeMission(): Promise<void> {
  const response = await sendRuntime<AgentMission>({ type: "AGENT_RESUME" });
  if (!response.ok || !isAgentMission(response.result)) {
    transientNotice = describeBrowserError(response.error);
    render();
    return;
  }
  mission = response.result;
  blockedMessage = "";
  syncOrbWithMission();
  render();
}

async function stopMission(message = "Mission arrêtée. Aucune action suivante ne sera exécutée."): Promise<void> {
  abortController?.abort();
  const response = await sendRuntime<AgentStopResult>({ type: "AGENT_STOP", reason: message });
  if (response.ok && isAgentMission(response.result?.mission)) mission = response.result!.mission!;
  workspacePrompt = null;
  busy = false;
  typing = false;
  blockedMessage = "";
  orbState = "idle";
  stopSpeaking();
  render();
}

async function refreshMission(): Promise<void> {
  const response = await sendRuntime<AgentMission | null>({ type: "AGENT_STATUS" });
  if (response.ok && isAgentMission(response.result)) mission = response.result;
  else mission = await loadMission();
  syncOrbWithMission();
  render();
}

async function loadMission(): Promise<AgentMission | null> {
  const stored = await chrome.storage.local.get(STORAGE_MISSION);
  return isAgentMission(stored[STORAGE_MISSION]) ? stored[STORAGE_MISSION] as AgentMission : null;
}

function toggleListening(): void {
  if (listeningWanted) stopListening();
  else startListening();
}

function startListening(): void {
  const target = window as NeptuneWindow;
  const Recognition = target.SpeechRecognition ?? target.webkitSpeechRecognition;
  if (!Recognition) {
    transientNotice = "La reconnaissance vocale n’est pas disponible dans cette version de Chrome. Utilisez le clavier.";
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
        transientNotice = voiceErrorMessage(event.error);
        orbState = "error";
        render();
      }
    };
    recognition.onend = () => {
      recognitionRunning = false;
      if (listeningWanted && !recognitionPausedForSpeech) window.setTimeout(restartRecognition, 500);
      else if (!recognitionPausedForSpeech) { orbState = mission ? orbForMission(mission) : "idle"; render(); }
    };
  }
  listeningWanted = true;
  restartRecognition();
}

function restartRecognition(): void {
  if (!recognition || recognitionRunning || !listeningWanted || recognitionPausedForSpeech) return;
  try { recognition.start(); }
  catch { window.setTimeout(() => { try { recognition?.start(); } catch { stopListening(); } }, 700); }
}

function handleTranscript(raw: string): void {
  const transcript = raw.trim();
  if (!transcript) return;
  const normalized = normalizeSpeech(transcript);
  const detected = ["ok neptune", "neptune"].find((candidate) => normalized.includes(candidate));
  if (!detected && !waitingForWakeCommand) return;

  if (!preferences.onboardingComplete && preferences.onboardingStep === 2) {
    activationTested = true;
    activationSkipped = false;
    transientNotice = "Activation vocale validée.";
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
  if (orbState === "listening") orbState = mission ? orbForMission(mission) : "idle";
  render();
}

async function enableBackgroundWake(): Promise<void> {
  await sendRuntime({
    type: "START_WAKE_LISTENER",
    config: { wakeWord: "OK Neptune", wakeWordEnabled: true, language: "fr-FR", oneShot: false }
  });
}

function speak(text: string): void {
  if (!text.trim()) return;
  speechSynthesis.cancel();
  const shouldResume = listeningWanted && preferences.autoResumeVoice;
  if (recognitionRunning) {
    recognitionPausedForSpeech = true;
    recognition?.stop();
  }
  const utterance = new SpeechSynthesisUtterance(text.slice(0, 2_000));
  utterance.lang = "fr-FR";
  utterance.rate = 1.02;
  utterance.pitch = 1;
  utterance.onstart = () => { orbState = "speaking"; render(); };
  utterance.onend = () => {
    recognitionPausedForSpeech = false;
    orbState = shouldResume ? "listening" : mission ? orbForMission(mission) : "idle";
    render();
    if (shouldResume) window.setTimeout(restartRecognition, 250);
  };
  utterance.onerror = () => {
    recognitionPausedForSpeech = false;
    orbState = mission ? orbForMission(mission) : "idle";
    render();
    if (shouldResume) restartRecognition();
  };
  speechSynthesis.speak(utterance);
}

function stopSpeaking(): void {
  speechSynthesis.cancel();
  stopLocalPlayback(false);
  recognitionPausedForSpeech = false;
}

async function requestSiteAccess(): Promise<boolean> {
  const granted = await chrome.permissions.request({ origins: HOST_ORIGINS });
  preferences.siteAccessGranted = granted;
  await savePreferences();
  return granted;
}

function render(): void {
  app.innerHTML = preferences.onboardingComplete ? renderAssistant() : renderOnboarding();
  window.requestAnimationFrame(() => {
    const conversation = document.getElementById("conversation");
    if (conversation) conversation.scrollTop = conversation.scrollHeight;
    animateSpectrum();
    updateOnboardingButton();
    if (!preferences.onboardingComplete && preferences.onboardingStep === ONBOARDING_LAST_STEP && engineState === "idle") {
      void prepareEngine(false);
    }
  });
}

function renderOnboarding(): string {
  const step = preferences.onboardingStep;
  return `<section class="onboarding">
    <div class="progress">${Array.from({ length: ONBOARDING_LAST_STEP + 1 }, (_, index) => `<span class="${index <= step ? "active" : ""}"></span>`).join("")}</div>
    <div class="onboarding-body">${renderHologram(true)}<div class="onboarding-copy">${onboardingMarkup(step)}</div></div>
    ${transientNotice ? `<div class="notice ${orbState === "error" ? "warning" : "success"}">${escapeHtml(transientNotice)}</div>` : ""}
    <footer class="onboarding-actions">
      <button type="button" class="ghost-button" data-action="onboarding-back" ${step === 0 ? "disabled" : ""}>Retour</button>
      <button type="button" class="primary-button" data-action="onboarding-next" ${canContinueOnboarding() ? "" : "disabled"}>${step === ONBOARDING_LAST_STEP ? "Commencer avec Neptune" : "Continuer"}</button>
    </footer>
  </section>`;
}

function onboardingMarkup(step: number): string {
  if (step === 0) {
    return `<p class="eyebrow">PREMIER ÉCHANGE</p><h2>Comment dois-je vous appeler ?</h2><p>Neptune personnalisera ses validations sans vous exposer de réglages techniques.</p><div class="field"><label for="preferred-name">Votre prénom</label><input id="preferred-name" class="input" value="${escapeAttribute(preferences.preferredName)}" placeholder="Johan" autofocus /></div>`;
  }
  if (step === 1) {
    return `<p class="eyebrow">VOIX INTÉGRÉE</p><h2>Préférez-vous une voix féminine ou masculine ?</h2><p>Les deux voix sont incluses dans Neptune.</p><div class="voice-pair">${voiceChoice("female")}${voiceChoice("male")}</div>${voiceState === "preparing" ? progressMarkup("Préparation de la voix", voiceProgress) : voiceState === "error" ? `<div class="notice warning">La voix n’a pas pu démarrer. Le clavier reste disponible.</div><button type="button" class="ghost-button" data-action="retry-voice">Réessayer</button>` : ""}`;
  }
  if (step === 2) {
    return `<p class="eyebrow">ACTIVATION VOCALE</p><h2>Dites « Neptune » ou « OK Neptune »</h2><p>Vous pourrez aussi utiliser Neptune uniquement au clavier.</p><div class="wake-test ${activationTested ? "success" : ""}"><span class="wake-dot"></span><strong>${activationTested ? "Activation validée" : listeningWanted ? "Je vous écoute…" : activationSkipped ? "Activation vocale désactivée" : "Prêt pour le test"}</strong></div><div class="inline-actions"><button type="button" class="primary-button" data-action="test-activation">${activationTested ? "Tester à nouveau" : "Tester maintenant"}</button><button type="button" class="ghost-button" data-action="skip-activation">Continuer sans micro</button></div>`;
  }
  return `<p class="eyebrow">MOTEUR NEPTUNE</p><h2>Neptune se prépare automatiquement</h2><p>Le moteur local, la mémoire et l’autoréparation sont configurés sans clé API ni commande technique.</p>${engineStatusMarkup()}<div class="configuration-summary"><span>Voix ${preferences.voiceGender === "female" ? "féminine" : "masculine"}</span><span>${activationSkipped ? "Utilisation au clavier" : "Activation vocale prête"}</span><span>Moteur local sécurisé</span></div>`;
}

function voiceChoice(gender: VoiceGender): string {
  const voice = voiceForGender(gender);
  const selected = preferences.voiceGender === gender;
  return `<article class="voice-choice ${selected ? "selected" : ""}"><button type="button" data-action="select-gender" data-value="${gender}"><span class="voice-symbol">${gender === "female" ? "F" : "M"}</span><strong>${voice.label}</strong><small>${voice.description}</small></button><button type="button" class="ghost-button" data-action="preview-gender" data-value="${gender}">Écouter</button></article>`;
}

function renderAssistant(): string {
  return `<section class="shell">
    <header class="topbar"><div class="brand-spectrum">${spectrumBars(18)}</div><div class="brand-copy"><p class="eyebrow">NEPTUNE</p><h1>Assistant navigateur</h1></div><button type="button" class="icon-button" data-action="open-settings" title="Réglages">⚙</button></header>
    <section class="assistant"><div class="assistant-head"><span class="state-label">${stateLabel()}${mission ? ` · cycle ${mission.cycle}/${mission.maxCycles}` : ""}</span><div class="inline-actions"><button type="button" class="ghost-button" data-action="toggle-details">Mission</button><button type="button" class="danger-button" data-action="stop">Arrêter</button></div></div>
      <div id="conversation" class="conversation-stage"><div class="hologram-sticky">${renderHologram(false)}</div><div class="messages">${messages.map(messageMarkup).join("")}${typing ? typingMarkup() : ""}</div>${workspacePrompt ? workspaceMarkup() : ""}${mission?.status === "awaiting_approval" ? approvalMarkup() : ""}${mission?.status === "blocked" ? blockedMarkup() : ""}${detailsOpen ? missionDetailsMarkup() : ""}${transientNotice ? `<div class="notice ${orbState === "error" ? "warning" : "success"}">${escapeHtml(transientNotice)}</div>` : ""}</div>
      <div class="composer-wrap"><form id="composer" class="composer"><button type="button" class="micro-button ${listeningWanted ? "active" : ""}" data-action="toggle-micro" title="${listeningWanted ? "Arrêter l’écoute" : "Parler à Neptune"}"><span></span></button><textarea id="draft" placeholder="Écrivez ou dites votre objectif…" rows="2">${escapeHtml(draft)}</textarea><button type="submit" class="send-button" data-action="send" ${busy ? "disabled" : ""}>➤</button></form><div class="composer-hint"><span>${listeningWanted ? "Dites Neptune ou OK Neptune" : "Micro en pause"}</span><span>${engineLabel()}</span></div></div>
    </section>${settingsOpen ? settingsMarkup() : ""}
  </section>`;
}

function renderHologram(full: boolean): string {
  return `<div class="neptune-hologram ${full ? "full" : "compact"} ${orbState}" data-spectrum-state="${orbState}" aria-label="Neptune ${stateLabel()}"><div class="spectrum-ring">${spectrumBars(full ? 64 : 48)}</div><div class="spectrum-aura"></div><div class="spectrum-core"><i></i><i></i><i></i></div></div>`;
}

function spectrumBars(count: number): string {
  return Array.from({ length: count }, (_, index) => `<i class="spectrum-bar" style="--i:${index};--count:${count};--seed:${(index * 17) % 23}"></i>`).join("");
}

function workspaceMarkup(): string {
  const prompt = workspacePrompt!;
  const activeTitle = prompt.activeTab?.title || prompt.activeTab?.url || "l’onglet actuel";
  return `<section class="intervention workspace"><p class="eyebrow">ESPACE DE TRAVAIL</p><strong>Où souhaitez-vous que je travaille ?</strong><p>${escapeHtml(prompt.reason)}</p><div class="workspace-current"><span>Page détectée</span><b>${escapeHtml(activeTitle)}</b></div><div class="workspace-grid"><button type="button" class="workspace-option ${prompt.recommended === "current-tab" ? "recommended" : ""}" data-action="workspace-current" ${prompt.activeTab?.url && /^https?:\/\//i.test(prompt.activeTab.url) ? "" : "disabled"}><strong>Prendre le relais ici</strong><small>Utiliser la page ouverte</small></button><button type="button" class="workspace-option ${prompt.recommended === "new-tab" ? "recommended" : ""}" data-action="workspace-tab"><strong>Nouvel onglet</strong><small>Séparer la mission</small></button><button type="button" class="workspace-option ${prompt.recommended === "new-window" ? "recommended" : ""}" data-action="workspace-window"><strong>Nouvelle fenêtre</strong><small>Espace dédié</small></button></div><button type="button" class="ghost-button" data-action="workspace-cancel">Annuler</button></section>`;
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
  return `<div class="modal-backdrop"><section class="modal"><header class="modal-head"><div><p class="eyebrow">PRÉFÉRENCES</p><h2>Configurer Neptune</h2></div><button type="button" class="icon-button" data-action="close-settings">✕</button></header><div class="settings-section"><h3>Expérience</h3><div class="field"><label for="settings-name">Votre prénom</label><input id="settings-name" class="input" value="${escapeAttribute(preferences.preferredName)}" /></div><div class="settings-voice-pair">${settingsVoiceButton("female")}${settingsVoiceButton("male")}</div><button type="button" class="ghost-button" data-action="toggle-background-wake">${preferences.wakeWordEnabled ? "Désactiver" : "Activer"} l’activation vocale</button></div><div class="settings-section"><h3>Moteur Neptune</h3><div class="setting-status"><strong>Moteur local</strong><span>${engineState === "ready" ? "Prêt et supervisé" : engineState === "preparing" ? `Préparation ${engineProgress}%` : "À vérifier"}</span></div><button type="button" class="primary-button wide-button" data-action="repair-engine">Diagnostiquer et réparer Neptune</button></div><div class="settings-section"><h3>Niveau de contrôle</h3><div class="trust-grid">${trustButton("prudent", "Prudent")}${trustButton("assisted", "Collaborateur")}${trustButton("controlled", "Autonome contrôlé")}</div></div><div class="settings-section"><h3>Données locales</h3><p>${messages.length} message(s) et ${audit.length} événement(s) conservés sur cet ordinateur.</p><div class="inline-actions"><button type="button" class="ghost-button" data-action="clear-history">Effacer la conversation</button><button type="button" class="ghost-button" data-action="clear-audit">Effacer le journal</button><button type="button" class="ghost-button" data-action="reset-onboarding">Relancer l’accueil</button></div></div></section></div>`;
}

function settingsVoiceButton(gender: VoiceGender): string {
  const voice = voiceForGender(gender);
  return `<button type="button" class="choice-card ${preferences.voiceGender === gender ? "selected" : ""}" data-action="select-gender" data-value="${gender}"><strong>${voice.label}</strong><small>${voice.description}</small></button>`;
}

function trustButton(level: TrustLevel, label: string): string {
  return `<button type="button" class="choice-card ${preferences.trustLevel === level ? "selected" : ""}" data-action="select-trust" data-value="${level}">${label}</button>`;
}

function engineStatusMarkup(): string {
  if (engineState === "ready") return `<div class="notice success">Neptune est prêt et surveillé automatiquement.</div>`;
  if (engineState === "preparing") return `${progressMarkup("Préparation automatique de Neptune", engineProgress)}<p class="preparation-note">Le premier démarrage peut prendre quelques minutes.</p>`;
  if (engineState === "error") return `<div class="notice warning">${escapeHtml(engineError || "Neptune n’a pas pu démarrer.")}</div><button type="button" class="primary-button wide-button" data-action="repair-engine">Réparer automatiquement</button>`;
  return `<button type="button" class="primary-button wide-button" data-action="prepare-engine">Démarrer Neptune</button>`;
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
  if (preferences.onboardingStep === 1) return voiceState === "ready" || voiceState === "error";
  if (preferences.onboardingStep === 2) return activationTested || activationSkipped;
  if (preferences.onboardingStep === ONBOARDING_LAST_STEP) return engineState === "ready";
  return true;
}

function updateOnboardingButton(): void {
  const button = app.querySelector<HTMLButtonElement>("button[data-action='onboarding-next']");
  if (button) button.disabled = !canContinueOnboarding();
}

function stateLabel(): string {
  return ({ idle: "Prêt", listening: "À l’écoute", thinking: "Réflexion", executing: "Mission en cours", speaking: "Neptune répond", permission: "Votre décision", blocked: "Intervention nécessaire", error: "À vérifier" } satisfies Record<OrbState, string>)[orbState];
}

function engineLabel(): string {
  if (engineState === "ready") return "Moteur Neptune prêt";
  if (engineState === "preparing") return `Préparation ${engineProgress}%`;
  if (engineState === "error") return "Réparation nécessaire";
  return "Moteur en attente";
}

function orbForMission(value: AgentMission): OrbState {
  if (value.status === "running") return "executing";
  if (value.status === "awaiting_approval") return "permission";
  if (value.status === "blocked") return "blocked";
  if (value.status === "failed") return "error";
  return "idle";
}

function syncOrbWithMission(): void {
  if (!mission) {
    if (!busy && !listeningWanted) orbState = "idle";
    return;
  }
  orbState = orbForMission(mission);
  blockedMessage = mission.status === "blocked" ? mission.lastError ?? "La mission attend votre intervention." : "";
}

function animateSpectrum(): void {
  for (const element of Array.from(document.querySelectorAll<HTMLElement>(".neptune-hologram"))) {
    element.dataset.spectrumState = orbState;
  }
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

async function resetOnboarding(): Promise<void> {
  stopListening();
  stopSpeaking();
  preferences = { ...preferences, onboardingComplete: false, onboardingStep: 0, productVersion: PRODUCT_VERSION };
  settingsOpen = false;
  activationTested = false;
  activationSkipped = false;
  engineState = "idle";
  await savePreferences();
  render();
  void prepareSelectedVoice(false);
}

async function sendRuntime<T = unknown>(payload: Record<string, unknown>): Promise<RuntimeResponse<T>> {
  try {
    const response = await chrome.runtime.sendMessage(payload) as RuntimeResponse<T> | undefined;
    return response ?? { ok: false, error: { code: "NO_RESPONSE", message: "Le service Neptune n’a pas répondu.", requiresHuman: false, retryable: true } };
  } catch (error) {
    return { ok: false, error: { code: "RUNTIME_ERROR", message: errorMessage(error), requiresHuman: false, retryable: true } };
  }
}

function describeBrowserError(error?: BrowserError): string {
  if (!error) return "La mission s’est interrompue sans détail exploitable.";
  switch (error.code) {
    case "HUMAN_VERIFICATION": return "Le site demande une vérification humaine. Effectuez-la, puis reprenez au checkpoint.";
    case "AUTHENTICATION_REQUIRED": return "Le compte nécessaire n’est pas connecté. Connectez-vous, puis reprenez la mission.";
    case "PAGE_PERMISSION": return "Chrome a refusé l’accès à cette page. Autorisez Neptune, puis reprenez.";
    case "TARGET_NOT_FOUND": return "L’élément attendu n’est plus visible. Neptune réobservera la page à la reprise.";
    case "NAVIGATION_TIMEOUT": return "La page a mis trop de temps à répondre. Vérifiez l’onglet, puis reprenez.";
    case "MISSION_STOPPED": return "La mission a été arrêtée.";
    default: return `J’ai rencontré un blocage : ${error.message}`;
  }
}

function normalizeMessages(value: unknown): ConversationMessage[] {
  return Array.isArray(value) ? value.filter((item): item is ConversationMessage => Boolean(item && typeof item === "object" && typeof (item as ConversationMessage).text === "string")).slice(-MAX_MESSAGES) : [];
}

function normalizeAudit(value: unknown): AuditEntry[] {
  return Array.isArray(value) ? value.filter((item): item is AuditEntry => Boolean(item && typeof item === "object" && typeof (item as AuditEntry).type === "string")).slice(-MAX_AUDIT) : [];
}

function isAgentMission(value: unknown): value is AgentMission {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AgentMission>;
  return typeof record.id === "string" && typeof record.goal === "string" && typeof record.status === "string" && Array.isArray(record.actions) && Array.isArray(record.history);
}

function stripWakeWord(value: string): string {
  return value.replace(/^\s*(?:ok\s+)?neptune[\s,.:;!?-]*/i, "").trim();
}

function normalizeSpeech(value: string): string {
  return value.toLocaleLowerCase("fr-FR").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

function voiceErrorMessage(error: string): string {
  const messagesByCode: Record<string, string> = {
    "not-allowed": "L’accès au microphone a été refusé. Autorisez-le dans Chrome ou continuez au clavier.",
    "service-not-allowed": "La reconnaissance vocale est bloquée par Chrome.",
    "audio-capture": "Aucun microphone n’est disponible.",
    network: "La reconnaissance vocale est momentanément indisponible."
  };
  return messagesByCode[error] ?? `Erreur de reconnaissance vocale : ${error}`;
}

function onboardingSpeech(step: number): string {
  return ["Comment dois-je vous appeler ?", "Préférez-vous une voix féminine ou masculine ?", "Dites Neptune ou OK Neptune pour échanger avec moi.", "Je prépare le moteur Neptune."][step] ?? "";
}

function clampProgress(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.round(Math.max(0, Math.min(100, numeric)));
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "Opération interrompue.";
  return error instanceof Error ? error.message : typeof error === "string" ? error : "Une erreur inattendue est survenue.";
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

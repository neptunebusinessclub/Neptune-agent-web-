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
  destroyChromeAi,
  getChromeAiAvailability,
  isBrowserTask,
  prepareChromeAi,
  type ProviderConfig,
  type ProviderId,
  type TrustLevel
} from "./intelligence";
import { deleteSecret, loadSecret, saveSecret } from "./secure-storage";

type Preferences = {
  onboardingComplete: boolean;
  onboardingStep: number;
  preferredName: string;
  voiceURI: string;
  trustLevel: TrustLevel;
  providerId: ProviderId;
  endpoint: string;
  model: string;
  wakeWordEnabled: boolean;
  wakeWord: "Neptune" | "OK Neptune";
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

type BrowserError = {
  code: string;
  message: string;
  requiresHuman: boolean;
  retryable: boolean;
};

type RuntimeResponse<T = unknown> = {
  ok: boolean;
  result?: T;
  error?: BrowserError;
};

type AuditEntry = {
  id: string;
  type: string;
  detail: string;
  occurredAt: string;
};

type OrbState = "idle" | "listening" | "thinking" | "executing" | "speaking" | "permission" | "blocked" | "error";

type SpeechRecognitionEventLike = Event & {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};

type SpeechRecognitionErrorEventLike = Event & { error: string };

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const STORAGE_PREFERENCES = "neptune.preferences.v2";
const STORAGE_MESSAGES = "neptune.messages.v2";
const STORAGE_AUDIT = "neptune.audit.v2";
const STORAGE_MISSION = "neptune.agent.mission.v2";
const ONBOARDING_LAST_STEP = 6;
const MAX_MESSAGES = 80;
const MAX_AUDIT = 240;
const HOST_ORIGINS = ["http://*/*", "https://*/*"];

const DEFAULT_PREFERENCES: Preferences = {
  onboardingComplete: false,
  onboardingStep: 0,
  preferredName: "",
  voiceURI: "",
  trustLevel: "prudent",
  providerId: "chrome-local",
  endpoint: "https://api.mammouth.ai/v1",
  model: "mammouth-recommended",
  wakeWordEnabled: true,
  wakeWord: "OK Neptune",
  siteAccessGranted: false,
  autoResumeVoice: true
};

const app = requireElement<HTMLElement>("app");
let preferences = { ...DEFAULT_PREFERENCES };
let messages: ConversationMessage[] = [];
let audit: AuditEntry[] = [];
let voices: SpeechSynthesisVoice[] = [];
let orbState: OrbState = "idle";
let draft = "";
let settingsOpen = false;
let detailsOpen = false;
let busy = false;
let typing = false;
let chromeAiStatus: Awaited<ReturnType<typeof getChromeAiAvailability>> = "unavailable";
let modelProgress = 0;
let providerSecretSaved = false;
let secretDraft = "";
let mission: AgentMission | null = null;
let blockedMessage = "";
let abortController: AbortController | null = null;
let recognition: SpeechRecognitionLike | null = null;
let listeningWanted = false;
let recognitionRunning = false;
let waitingForWakeCommand = false;
let recognitionPausedForSpeech = false;

void initialize();

async function initialize(): Promise<void> {
  const [stored, session] = await Promise.all([
    chrome.storage.local.get([STORAGE_PREFERENCES, STORAGE_MESSAGES, STORAGE_AUDIT]),
    chrome.storage.session.get(STORAGE_MISSION)
  ]);
  preferences = { ...DEFAULT_PREFERENCES, ...(stored[STORAGE_PREFERENCES] as Partial<Preferences> | undefined) };
  messages = Array.isArray(stored[STORAGE_MESSAGES]) ? stored[STORAGE_MESSAGES] as ConversationMessage[] : [];
  audit = Array.isArray(stored[STORAGE_AUDIT]) ? stored[STORAGE_AUDIT] as AuditEntry[] : [];
  mission = isAgentMission(session[STORAGE_MISSION]) ? session[STORAGE_MISSION] as AgentMission : null;
  preferences.siteAccessGranted = await chrome.permissions.contains({ origins: HOST_ORIGINS });
  voices = await loadVoices();
  if (!preferences.voiceURI) preferences.voiceURI = preferredVoice()?.voiceURI ?? "";
  chromeAiStatus = await getChromeAiAvailability();
  providerSecretSaved = Boolean(await loadSecret(preferences.providerId));
  bindGlobalEvents();

  if (mission && ["running", "awaiting_approval"].includes(mission.status)) {
    mission.status = "blocked";
    mission.lastError = "La mission a été interrompue par la fermeture du panneau. Elle peut reprendre au dernier checkpoint.";
    blockedMessage = mission.lastError;
    await saveMission();
  } else if (mission?.status === "blocked") {
    blockedMessage = mission.lastError ?? "La mission attend votre intervention.";
  }

  render();
  if (!preferences.onboardingComplete) {
    window.setTimeout(() => speak("Bonjour. Je suis Neptune, votre assistant navigateur. Commençons par faire connaissance."), 350);
  } else if (messages.length === 0) {
    addMessage("assistant", `Bonjour ${preferences.preferredName || ""}. Je suis prêt. Donnez-moi un objectif, je m’adapterai à chaque étape.`);
  }
}

function bindGlobalEvents(): void {
  app.addEventListener("click", (event) => void handleClick(event));
  app.addEventListener("input", handleInput);
  app.addEventListener("change", handleInput);
  app.addEventListener("submit", (event) => {
    event.preventDefault();
    if ((event.target as HTMLElement).id === "composer") void submitMessage(draft);
  });
  speechSynthesis.addEventListener("voiceschanged", () => {
    voices = speechSynthesis.getVoices();
    render();
  });
}

async function handleClick(event: Event): Promise<void> {
  const button = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const value = button.dataset.value ?? "";

  switch (action) {
    case "onboarding-back":
      preferences.onboardingStep = Math.max(0, preferences.onboardingStep - 1);
      await savePreferences();
      render();
      speak(onboardingSpeech(preferences.onboardingStep));
      break;
    case "onboarding-next": await nextOnboardingStep(); break;
    case "select-voice":
      preferences.voiceURI = value;
      await savePreferences();
      render();
      break;
    case "preview-voice": speak("Bonjour. Je suis Neptune. Voici un aperçu de ma voix.", value); break;
    case "select-trust":
      preferences.trustLevel = value as TrustLevel;
      await savePreferences();
      render();
      break;
    case "select-provider":
      preferences.providerId = value as ProviderId;
      providerSecretSaved = Boolean(await loadSecret(preferences.providerId));
      if (preferences.providerId === "mammouth") {
        preferences.endpoint = "https://api.mammouth.ai/v1";
        preferences.model = preferences.model || "mammouth-recommended";
      }
      await savePreferences();
      render();
      break;
    case "prepare-local-ai": await downloadLocalAi(); break;
    case "save-provider-secret": await saveCurrentProviderSecret(); break;
    case "delete-provider-secret":
      await deleteSecret(preferences.providerId);
      providerSecretSaved = false;
      secretDraft = "";
      render();
      break;
    case "select-wake-word":
      preferences.wakeWord = value as Preferences["wakeWord"];
      preferences.wakeWordEnabled = true;
      await savePreferences();
      render();
      break;
    case "test-wake-word":
      preferences.wakeWordEnabled = true;
      await savePreferences();
      startListening();
      break;
    case "disable-wake-word":
      preferences.wakeWordEnabled = false;
      stopListening();
      await savePreferences();
      render();
      break;
    case "grant-site-access": await requestSiteAccess(); break;
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
    case "reset-onboarding": await resetOnboarding(); break;
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
    case "test-provider": await testProvider(); break;
  }
}

function handleInput(event: Event): void {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  switch (target.id) {
    case "preferred-name": preferences.preferredName = target.value.slice(0, 80); break;
    case "provider-endpoint": preferences.endpoint = target.value.slice(0, 500); break;
    case "provider-model": preferences.model = target.value.slice(0, 200); break;
    case "provider-secret": secretDraft = target.value.slice(0, 1_000); break;
    case "draft": draft = target.value.slice(0, 10_000); break;
    case "settings-name": preferences.preferredName = target.value.slice(0, 80); void savePreferences(); break;
    case "settings-voice": preferences.voiceURI = target.value; void savePreferences(); break;
  }
}

async function nextOnboardingStep(): Promise<void> {
  const step = preferences.onboardingStep;
  if (step === 0 && preferences.preferredName.trim().length < 2) return;
  if (step === 1 && !preferences.voiceURI) return;
  if (step === 3) {
    if (preferences.providerId === "chrome-local" && chromeAiStatus !== "available") {
      await downloadLocalAi();
      chromeAiStatus = await getChromeAiAvailability();
      if (chromeAiStatus !== "available") return;
    }
    if (preferences.providerId !== "chrome-local" && !providerSecretSaved) {
      await saveCurrentProviderSecret();
      if (!providerSecretSaved) return;
    }
  }
  if (step === 5 && !preferences.siteAccessGranted) {
    const granted = await requestSiteAccess();
    if (!granted) return;
  }
  if (step < ONBOARDING_LAST_STEP) {
    preferences.onboardingStep += 1;
    await savePreferences();
    render();
    speak(onboardingSpeech(preferences.onboardingStep));
    return;
  }
  preferences.onboardingComplete = true;
  await savePreferences();
  addMessage("assistant", `Configuration terminée. ${preferences.preferredName}, donnez-moi simplement votre objectif.`);
  render();
  speak(`Configuration terminée. ${preferences.preferredName}, donnez-moi simplement votre objectif.`);
  if (preferences.wakeWordEnabled) startListening();
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

  const provider = await currentProviderConfig();
  if (!provider) {
    addMessage("assistant", "Aucun moteur d’intelligence n’est prêt. Ouvrez les réglages pour terminer la configuration.", "warning");
    settingsOpen = true;
    render();
    return;
  }

  if (isBrowserTask(clean)) {
    await startAgentMission(clean);
    return;
  }

  busy = true;
  typing = true;
  orbState = "thinking";
  abortController = new AbortController();
  render();
  try {
    const reply = await askIntelligence(provider, preferences.preferredName, messages.map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
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

async function startAgentMission(goal: string): Promise<void> {
  if (!preferences.siteAccessGranted) {
    mission = createAgentMission(goal);
    mission.status = "blocked";
    mission.lastError = `${preferences.preferredName}, Chrome doit autoriser Neptune à agir sur les sites.`;
    blockedMessage = mission.lastError;
    await saveMission();
    orbState = "blocked";
    render();
    return;
  }
  mission = createAgentMission(goal);
  detailsOpen = true;
  blockedMessage = "";
  appendAudit("MISSION_STARTED", goal);
  await saveMission();
  const started = await sendRuntime({ type: "START_MISSION" });
  if (!started.ok) {
    await blockMission(describeBrowserError(started.error));
    return;
  }
  addMessage("assistant", "Je prends la mission. J’observe, j’agis par petites étapes et je vérifie le résultat après chaque changement.");
  await advanceMission();
}

async function advanceMission(): Promise<void> {
  if (!mission || busy) return;
  const provider = await currentProviderConfig();
  if (!provider) {
    await blockMission("Le moteur d’intelligence n’est plus disponible. Reconfigurez-le, puis reprenez la mission.");
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
        await blockMission(`${preferences.preferredName}, je m’arrête avant de tourner en boucle : ${continuation.reason}.`);
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
          await blockMission(`${preferences.preferredName}, la page ne progresse plus malgré plusieurs tentatives. Indiquez-moi ce qui a changé ou effectuez l’étape bloquante, puis reprenez.`);
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
      if (batch === "paused" || batch === "blocked") return;
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
    if (mission?.status === "running") orbState = "thinking";
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
      addMessage("assistant", `${preferences.preferredName}, l’action « ${action.label} » nécessite votre autorisation.`, "permission");
      speak(`${preferences.preferredName}, cette action nécessite votre autorisation.`);
      render();
      return "paused";
    }

    mission = markActionStarted(mission, index);
    await saveMission();
    render();
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
  const status = await sendRuntime<{ tab?: { url?: string } }>({ type: "GET_WORK_TAB" });
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

async function currentProviderConfig(): Promise<ProviderConfig | null> {
  if (preferences.providerId === "chrome-local") {
    if (chromeAiStatus !== "available") return null;
    return { id: "chrome-local" };
  }
  const apiKey = await loadSecret(preferences.providerId);
  if (!apiKey) return null;
  return {
    id: preferences.providerId,
    apiKey,
    endpoint: preferences.endpoint,
    model: preferences.model
  };
}

async function downloadLocalAi(): Promise<void> {
  busy = true;
  modelProgress = 0;
  render();
  try {
    await prepareChromeAi(preferences.preferredName, (progress) => {
      modelProgress = progress;
      render();
    });
    chromeAiStatus = "available";
    preferences.providerId = "chrome-local";
    await savePreferences();
    appendAudit("AI_LOCAL_READY", "Intelligence locale Chrome prête");
  } catch (error) {
    chromeAiStatus = await getChromeAiAvailability();
    addTransientWarning(errorMessage(error));
  } finally {
    busy = false;
    render();
  }
}

async function saveCurrentProviderSecret(): Promise<void> {
  if (preferences.providerId === "chrome-local") return;
  if (secretDraft.trim().length < 8) {
    addTransientWarning("La clé API paraît incomplète.");
    return;
  }
  await saveSecret(preferences.providerId, secretDraft);
  secretDraft = "";
  providerSecretSaved = true;
  await savePreferences();
  appendAudit("PROVIDER_CONFIGURED", `Moteur ${preferences.providerId} configuré`);
  render();
}

async function requestSiteAccess(): Promise<boolean> {
  try {
    const granted = await chrome.permissions.request({ origins: HOST_ORIGINS });
    preferences.siteAccessGranted = granted;
    await savePreferences();
    if (granted) appendAudit("SITE_ACCESS_GRANTED", "Accès navigateur accordé par l’utilisateur");
    render();
    return granted;
  } catch {
    preferences.siteAccessGranted = false;
    render();
    return false;
  }
}

async function testProvider(): Promise<void> {
  const provider = await currentProviderConfig();
  if (!provider) {
    addTransientWarning("Le moteur n’est pas complètement configuré.");
    return;
  }
  busy = true;
  render();
  try {
    const reply = await askIntelligence(provider, preferences.preferredName, [{ role: "user", content: "Réponds uniquement : connexion réussie" }]);
    addTransientWarning(reply, "normal");
  } catch (error) {
    addTransientWarning(errorMessage(error));
  } finally {
    busy = false;
    render();
  }
}

function toggleListening(): void {
  if (listeningWanted) stopListening();
  else startListening();
}

function startListening(): void {
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!Recognition) {
    addMessage("assistant", "La reconnaissance vocale n’est pas disponible dans cette version de Chrome.", "warning");
    render();
    return;
  }
  if (!recognition) {
    recognition = new Recognition();
    recognition.lang = "fr-FR";
    recognition.continuous = preferences.wakeWordEnabled;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      recognitionRunning = true;
      if (!recognitionPausedForSpeech) orbState = "listening";
      render();
    };
    recognition.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result?.isFinal) continue;
        handleTranscript(result[0]?.transcript ?? "");
      }
    };
    recognition.onerror = (event) => {
      if (event.error !== "aborted" && event.error !== "no-speech") addMessage("assistant", voiceErrorMessage(event.error), "warning");
    };
    recognition.onend = () => {
      recognitionRunning = false;
      if (listeningWanted && preferences.wakeWordEnabled && !recognitionPausedForSpeech) {
        window.setTimeout(() => restartRecognition(), 350);
      } else if (!recognitionPausedForSpeech) {
        if (orbState === "listening") orbState = "idle";
        render();
      }
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
  if (!preferences.wakeWordEnabled) {
    void submitMessage(transcript);
    stopListening();
    return;
  }
  if (waitingForWakeCommand) {
    waitingForWakeCommand = false;
    void submitMessage(transcript);
    return;
  }
  const normalized = normalizeSpeech(transcript);
  const wakeCandidates = [preferences.wakeWord, "OK Neptune", "Neptune"].map(normalizeSpeech);
  const detected = wakeCandidates.find((candidate) => normalized.includes(candidate));
  if (!detected) return;
  const command = normalized.slice(normalized.indexOf(detected) + detected.length).replace(/^[,.:;!?\s-]+/, "").trim();
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

function speak(text: string, voiceURI = preferences.voiceURI): void {
  if (!text.trim()) return;
  speechSynthesis.cancel();
  const shouldResume = listeningWanted && preferences.autoResumeVoice;
  if (recognitionRunning) {
    recognitionPausedForSpeech = true;
    recognition?.stop();
  }
  const utterance = new SpeechSynthesisUtterance(text.slice(0, 1_800));
  utterance.lang = "fr-FR";
  utterance.rate = 1.03;
  utterance.pitch = 1;
  const voice = voices.find((item) => item.voiceURI === voiceURI) ?? preferredVoice();
  if (voice) utterance.voice = voice;
  utterance.onstart = () => { orbState = "speaking"; render(); };
  utterance.onend = () => {
    recognitionPausedForSpeech = false;
    orbState = shouldResume ? "listening" : mission?.status === "blocked" ? "blocked" : "idle";
    render();
    if (shouldResume) window.setTimeout(() => restartRecognition(), 250);
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
  recognitionPausedForSpeech = false;
  if (orbState === "speaking") orbState = "idle";
}

function render(): void {
  app.innerHTML = preferences.onboardingComplete ? renderAssistant() : renderOnboarding();
  window.requestAnimationFrame(() => {
    const conversation = document.getElementById("conversation");
    if (conversation) conversation.scrollTop = conversation.scrollHeight;
  });
}

function renderOnboarding(): string {
  const step = preferences.onboardingStep;
  return `<section class="onboarding">
    <div class="progress">${Array.from({ length: ONBOARDING_LAST_STEP + 1 }, (_, index) => `<span class="${index <= step ? "active" : ""}"></span>`).join("")}</div>
    <div class="onboarding-body">${renderOrb(true)}<div class="onboarding-copy">${onboardingStepMarkup(step)}</div></div>
    <footer class="onboarding-actions"><button class="ghost-button" data-action="onboarding-back" ${step === 0 ? "disabled" : ""}>Retour</button><button class="primary-button" data-action="onboarding-next" ${canContinueOnboarding() ? "" : "disabled"}>${step === ONBOARDING_LAST_STEP ? "Commencer avec Neptune" : "Continuer"}</button></footer>
  </section>`;
}

function onboardingStepMarkup(step: number): string {
  if (step === 0) return `<p class="eyebrow">PREMIER ÉCHANGE</p><h2>Comment dois-je vous appeler ?</h2><p>J’utiliserai votre prénom lorsqu’une validation, une intervention ou une décision importante le justifie.</p><div class="field"><label for="preferred-name">Votre prénom</label><input id="preferred-name" class="input" value="${escapeAttribute(preferences.preferredName)}" placeholder="Johan" autofocus /></div>`;
  if (step === 1) return `<p class="eyebrow">PERSONNALITÉ VOCALE</p><h2>Choisissez ma voix</h2><p>Pré-écoutez les voix françaises disponibles. Vous pourrez la modifier à tout moment.</p><div class="choice-grid">${voiceOptionsMarkup()}</div>`;
  if (step === 2) return `<p class="eyebrow">AUTORISATIONS</p><h2>Quel niveau de confiance m’accordez-vous ?</h2><p>Les paiements, suppressions, mots de passe, signatures et engagements contractuels restent toujours bloqués.</p><div class="choice-grid">${trustOptionsMarkup()}</div>`;
  if (step === 3) return `<p class="eyebrow">INTELLIGENCE</p><h2>Comment souhaitez-vous que je réfléchisse ?</h2><p>Local pour la confidentialité, cloud pour davantage de puissance. Le moteur pourra être changé plus tard.</p><div class="choice-grid">${providerOptionsMarkup()}</div>${providerConfigurationMarkup()}`;
  if (step === 4) return `<p class="eyebrow">ACTIVATION VOCALE</p><h2>Comment souhaitez-vous m’appeler ?</h2><p>Activez le micro une fois : je reste à l’écoute tant que le panneau Neptune est ouvert et je me mets en pause pendant mes réponses.</p><div class="choice-grid">${choiceButton("select-wake-word", "Neptune", "Neptune", "Activation courte et naturelle", preferences.wakeWordEnabled && preferences.wakeWord === "Neptune")}${choiceButton("select-wake-word", "OK Neptune", "OK Neptune", "Réduit les activations accidentelles", preferences.wakeWordEnabled && preferences.wakeWord === "OK Neptune")}${choiceButton("disable-wake-word", "", "Bouton micro uniquement", "Aucune écoute continue", !preferences.wakeWordEnabled)}</div><div class="inline-actions"><button class="primary-button" data-action="test-wake-word">Activer et tester le micro</button></div>`;
  if (step === 5) return `<p class="eyebrow">ACCÈS NAVIGATEUR</p><h2>Autorisez mon onglet de travail</h2><p>Chaque mission s’exécute dans un onglet Neptune séparé. Je réobserve la page après chaque changement important.</p><div class="notice ${preferences.siteAccessGranted ? "success" : "warning"}">${preferences.siteAccessGranted ? "Accès accordé. Neptune peut lire et agir sur les sites demandés." : "Chrome affichera une confirmation unique pour autoriser l’accès aux sites."}</div><div class="inline-actions"><button class="primary-button" data-action="grant-site-access">${preferences.siteAccessGranted ? "Vérifier l’autorisation" : "Autoriser les sites"}</button></div>`;
  return `<p class="eyebrow">PRÊT À COMMENCER</p><h2>Votre Neptune est configuré</h2><p>Essayez : « ${preferences.wakeWordEnabled ? `${preferences.wakeWord}, ` : ""}ouvre Le Bon Coin, cherche un bureau à Toulouse et résume les résultats. »</p><div class="notice success">Intelligence : ${providerLabel(preferences.providerId)} · Confiance : ${trustLabel(preferences.trustLevel)} · Voix : ${escapeHtml(selectedVoice()?.name ?? "système")}</div>`;
}

function renderAssistant(): string {
  return `<section class="shell"><header class="topbar"><div class="brand-mark">N</div><div class="brand-copy"><p class="eyebrow">NEPTUNE</p><h1>Assistant navigateur</h1></div><button class="icon-button" data-action="open-settings" title="Réglages">⚙</button></header><section class="assistant"><div class="assistant-head"><span class="state-label">${stateLabel()}${mission ? ` · cycle ${mission.cycle}/${mission.maxCycles}` : ""}</span><div class="inline-actions"><button class="ghost-button" data-action="toggle-details">Mission</button><button class="danger-button" data-action="stop">Arrêter</button></div></div><div id="conversation" class="conversation-stage"><div class="mini-orb-wrap">${renderOrb(false)}</div><div class="messages">${messages.map(messageMarkup).join("")}${typing ? typingMarkup() : ""}</div>${mission?.status === "awaiting_approval" ? approvalMarkup() : ""}${mission?.status === "blocked" ? blockedMarkup() : ""}${detailsOpen ? missionDetailsMarkup() : ""}</div><div class="composer-wrap"><form id="composer" class="composer"><button type="button" class="micro-button ${listeningWanted ? "active" : ""}" data-action="toggle-micro" title="${listeningWanted ? "Arrêter l’écoute" : "Parler à Neptune"}">●</button><textarea id="draft" placeholder="Écrivez ou dites votre objectif…" rows="2">${escapeHtml(draft)}</textarea><button type="submit" class="send-button" data-action="send" ${busy ? "disabled" : ""}>➤</button></form><div class="composer-hint"><span>${preferences.wakeWordEnabled ? listeningWanted ? `À l’écoute de « ${preferences.wakeWord} »` : `Activez le micro pour « ${preferences.wakeWord} »` : "Bouton micro ou texte."}</span><span>${providerLabel(preferences.providerId)}</span></div></div></section>${settingsOpen ? settingsMarkup() : ""}</section>`;
}

function renderOrb(full: boolean): string {
  if (full) return `<div class="orb-stage ${orbState}" aria-label="Neptune ${stateLabel()}"><div class="orb-halo halo-one"></div><div class="orb-halo halo-two"></div><div class="orb-ring ring-one"></div><div class="orb-ring ring-two"></div><div class="orb-core">N</div></div>`;
  return `<div class="mini-orb ${orbState}" aria-label="Neptune ${stateLabel()}"><span>N</span></div>`;
}

function voiceOptionsMarkup(): string {
  const french = voices.filter((voice) => voice.lang.toLocaleLowerCase("fr-FR").startsWith("fr"));
  const list = (french.length > 0 ? french : voices).slice(0, 8);
  if (list.length === 0) return `<div class="notice warning">Aucune voix système n’est encore chargée. Revenez à cette étape dans quelques secondes.</div>`;
  return list.map((voice) => `<div class="choice-card ${preferences.voiceURI === voice.voiceURI ? "selected" : ""}"><button class="choice-card" data-action="select-voice" data-value="${escapeAttribute(voice.voiceURI)}"><span class="choice-title-row"><span class="choice-title">${escapeHtml(voice.name)}</span><span class="choice-badge">${escapeHtml(voice.lang)}</span></span><span class="choice-description">${voice.localService ? "Voix locale du système" : "Voix fournie par Chrome"}</span></button><div class="inline-actions"><button class="ghost-button" data-action="preview-voice" data-value="${escapeAttribute(voice.voiceURI)}">Pré-écouter</button></div></div>`).join("");
}

function trustOptionsMarkup(): string {
  return ([
    ["prudent", "Prudent", "Je demande avant toute écriture, publication ou communication externe."],
    ["assisted", "Collaborateur", "Je peux adapter et poursuivre une mission, mais je demande avant toute action externe."],
    ["controlled", "Autonome contrôlé", "J’agis dans les règles et budgets approuvés, sans toucher aux actions sensibles."]
  ] as const).map(([id, title, description]) => choiceButton("select-trust", id, title, description, preferences.trustLevel === id)).join("");
}

function providerOptionsMarkup(): string {
  return [
    ["chrome-local", "Chrome AI local", "Gratuit, privé et hors ligne après le téléchargement.", "LOCAL"],
    ["mammouth", "Mammouth AI", "Plusieurs modèles via une seule clé API.", "CLOUD"],
    ["openai-compatible", "API compatible OpenAI", "Votre fournisseur, votre endpoint et votre modèle.", "CLOUD"]
  ].map(([id, title, description, badge]) => `<button class="choice-card ${preferences.providerId === id ? "selected" : ""}" data-action="select-provider" data-value="${id}"><span class="choice-title-row"><span class="choice-title">${title}</span><span class="choice-badge ${badge === "CLOUD" ? "cloud" : ""}">${badge}</span></span><span class="choice-description">${description}</span></button>`).join("");
}

function providerConfigurationMarkup(): string {
  if (preferences.providerId === "chrome-local") {
    const status = chromeAiStatus === "available" ? "Prêt" : chromeAiStatus === "downloadable" || chromeAiStatus === "downloading" ? "Téléchargement requis" : "Indisponible sur ce poste";
    return `<div class="notice ${chromeAiStatus === "available" ? "success" : chromeAiStatus === "unavailable" ? "warning" : ""}">${status}. Le modèle est géré par Chrome.</div>${modelProgress > 0 && modelProgress < 100 ? `<div class="download-progress"><span style="width:${modelProgress}%"></span></div>` : ""}<div class="inline-actions"><button class="primary-button" data-action="prepare-local-ai" ${busy || chromeAiStatus === "unavailable" ? "disabled" : ""}>${chromeAiStatus === "available" ? "Réinitialiser le modèle" : `Télécharger et utiliser${modelProgress ? ` · ${modelProgress}%` : ""}`}</button></div>`;
  }
  return `<div class="field"><label for="provider-endpoint">Adresse API</label><input id="provider-endpoint" class="input" value="${escapeAttribute(preferences.providerId === "mammouth" ? "https://api.mammouth.ai/v1" : preferences.endpoint)}" ${preferences.providerId === "mammouth" ? "readonly" : ""} /></div><div class="field"><label for="provider-model">Modèle</label><input id="provider-model" class="input" value="${escapeAttribute(preferences.model || (preferences.providerId === "mammouth" ? "mammouth-recommended" : ""))}" /></div><div class="field"><label for="provider-secret">Clé API ${providerSecretSaved ? "— enregistrée et chiffrée" : ""}</label><input id="provider-secret" class="input" type="password" value="${escapeAttribute(secretDraft)}" placeholder="Collez votre clé API" autocomplete="off" /></div><div class="inline-actions"><button class="primary-button" data-action="save-provider-secret">Enregistrer la clé</button>${providerSecretSaved ? `<button class="ghost-button" data-action="test-provider">Tester</button><button class="danger-button" data-action="delete-provider-secret">Supprimer</button>` : ""}</div>`;
}

function approvalMarkup(): string {
  const action = mission?.actions[mission.currentIndex];
  return `<section class="intervention permission"><strong>Autorisation requise</strong><p>${escapeHtml(action?.label ?? "Action externe")}</p><div class="inline-actions"><button class="primary-button" data-action="approve">Autoriser cette action</button><button class="secondary-button" data-action="deny">Refuser</button></div></section>`;
}

function blockedMarkup(): string {
  const permissionMissing = !preferences.siteAccessGranted;
  return `<section class="intervention blocked"><strong>Intervention nécessaire</strong><p>${escapeHtml(blockedMessage || mission?.lastError || "La mission est en pause.")}</p><div class="inline-actions">${permissionMissing ? `<button class="primary-button" data-action="grant-and-resume">Autoriser et reprendre</button>` : `<button class="primary-button" data-action="resume">Reprendre au checkpoint</button>`}<button class="secondary-button" data-action="deny">Arrêter</button></div></section>`;
}

function missionDetailsMarkup(): string {
  if (!mission) return `<section class="intervention"><strong>Détails de la mission</strong><p>Aucune mission en cours.</p></section>`;
  return `<section class="intervention"><strong>Détails de la mission</strong><p>${escapeHtml(mission.goal)}</p><div class="notice">Progression de sécurité : ${missionProgress(mission)} % · ${mission.usedActions}/${mission.maxActions} actions · cycle ${mission.cycle}/${mission.maxCycles}</div><div class="audit-list">${mission.actions.map((action, index) => `<div class="audit-item"><time>${index + 1} · ${escapeHtml(action.status)}</time>${escapeHtml(action.label)}<br><small>${escapeHtml(action.type)} · ${escapeHtml(action.risk)}</small></div>`).join("")}${mission.history.slice(-10).reverse().map((entry) => `<div class="audit-item"><time>cycle ${entry.cycle} · ${escapeHtml(entry.type)}</time>${escapeHtml(entry.summary)}</div>`).join("")}</div></section>`;
}

function settingsMarkup(): string {
  return `<div class="modal-backdrop"><section class="modal"><header class="modal-head"><div><p class="eyebrow">PRÉFÉRENCES</p><h2>Configurer Neptune</h2></div><button class="icon-button" data-action="close-settings">×</button></header><div class="settings-section"><h3>Identité et voix</h3><div class="field"><label for="settings-name">Votre prénom</label><input id="settings-name" class="input" value="${escapeAttribute(preferences.preferredName)}" /></div><div class="field"><label for="settings-voice">Voix</label><select id="settings-voice" class="select">${voices.map((voice) => `<option value="${escapeAttribute(voice.voiceURI)}" ${voice.voiceURI === preferences.voiceURI ? "selected" : ""}>${escapeHtml(voice.name)} · ${escapeHtml(voice.lang)}</option>`).join("")}</select></div></div><div class="settings-section"><h3>Intelligence</h3><p>${providerLabel(preferences.providerId)} · ${escapeHtml(preferences.model || "modèle local")}</p><div class="inline-actions"><button class="ghost-button" data-action="reset-onboarding">Reconfigurer étape par étape</button><button class="ghost-button" data-action="test-provider">Tester le moteur</button></div></div><div class="settings-section"><h3>Données locales</h3><p>${messages.length} message(s) et ${audit.length} événement(s) conservés dans ce profil Chrome.</p><div class="inline-actions"><button class="ghost-button" data-action="clear-history">Effacer la conversation</button><button class="ghost-button" data-action="clear-audit">Effacer le journal</button></div><div class="audit-list">${audit.slice(-12).reverse().map((entry) => `<div class="audit-item"><time>${formatTime(entry.occurredAt)} · ${escapeHtml(entry.type)}</time>${escapeHtml(entry.detail)}</div>`).join("")}</div></div><div class="settings-section"><h3>Sécurité</h3><p>Neptune utilise des cycles bornés, détecte la stagnation et refuse les paiements, achats, suppressions, mots de passe, signatures et contournements.</p></div></section></div>`;
}

function messageMarkup(message: ConversationMessage): string {
  return `<article class="message ${message.role === "assistant" ? "neptune" : "user"} ${message.tone}"><span class="message-role">${message.role === "assistant" ? "Neptune" : escapeHtml(preferences.preferredName || "Vous")}</span>${escapeHtml(message.text).replace(/\n/g, "<br>")}</article>`;
}

function typingMarkup(): string {
  return `<article class="message neptune"><span class="message-role">Neptune</span><span class="typing"><i></i><i></i><i></i></span></article>`;
}

function choiceButton(action: string, value: string, title: string, description: string, selected: boolean): string {
  return `<button class="choice-card ${selected ? "selected" : ""}" data-action="${action}" data-value="${escapeAttribute(value)}"><span class="choice-title">${escapeHtml(title)}</span><span class="choice-description">${escapeHtml(description)}</span></button>`;
}

function canContinueOnboarding(): boolean {
  const step = preferences.onboardingStep;
  if (step === 0) return preferences.preferredName.trim().length >= 2;
  if (step === 1) return Boolean(preferences.voiceURI);
  if (step === 3) return preferences.providerId === "chrome-local" ? chromeAiStatus !== "unavailable" : providerSecretSaved || secretDraft.trim().length >= 8;
  if (step === 5) return preferences.siteAccessGranted;
  return true;
}

function stateLabel(): string {
  return ({ idle: "Prêt", listening: "Écoute", thinking: "Observation et réflexion", executing: "Exécution contrôlée", speaking: "Réponse", permission: "Autorisation requise", blocked: "Intervention nécessaire", error: "Erreur" } satisfies Record<OrbState, string>)[orbState];
}

function onboardingSpeech(step: number): string {
  return ["Comment dois-je vous appeler ?", "Choisissez ma voix.", "Quel niveau de confiance m’accordez-vous ?", "Choisissez mon moteur d’intelligence.", "Choisissez mon mot d’activation et testons le microphone.", "Autorisez mon onglet de travail dans Chrome.", "Tout est prêt. Nous pouvons commencer."][step] ?? "";
}

function providerLabel(id: ProviderId): string {
  return id === "chrome-local" ? "Chrome AI local" : id === "mammouth" ? "Mammouth AI" : "API compatible OpenAI";
}

function trustLabel(level: TrustLevel): string {
  return level === "prudent" ? "Prudent" : level === "assisted" ? "Collaborateur" : "Autonome contrôlé";
}

function preferredVoice(): SpeechSynthesisVoice | undefined {
  return voices.find((voice) => voice.lang.toLocaleLowerCase("fr-FR").startsWith("fr") && voice.localService) ?? voices.find((voice) => voice.lang.toLocaleLowerCase("fr-FR").startsWith("fr")) ?? voices[0];
}

function selectedVoice(): SpeechSynthesisVoice | undefined {
  return voices.find((voice) => voice.voiceURI === preferences.voiceURI) ?? preferredVoice();
}

async function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const current = speechSynthesis.getVoices();
  if (current.length > 0) return current;
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => resolve(speechSynthesis.getVoices()), 1_200);
    speechSynthesis.addEventListener("voiceschanged", () => {
      window.clearTimeout(timeout);
      resolve(speechSynthesis.getVoices());
    }, { once: true });
  });
}

function addMessage(role: ConversationMessage["role"], text: string, tone: ConversationMessage["tone"] = "normal"): void {
  if (!text.trim()) return;
  messages = [...messages, { id: crypto.randomUUID(), role, text: text.trim(), tone, createdAt: new Date().toISOString() }].slice(-MAX_MESSAGES);
  void chrome.storage.local.set({ [STORAGE_MESSAGES]: messages });
  render();
}

function addTransientWarning(text: string, tone: ConversationMessage["tone"] = "warning"): void {
  addMessage("assistant", text, tone);
  speak(text);
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
  destroyChromeAi();
  preferences = { ...preferences, onboardingComplete: false, onboardingStep: 0 };
  settingsOpen = false;
  await savePreferences();
  render();
  speak("Reprenons la configuration. Comment dois-je vous appeler ?");
}

async function sendRuntime<T = unknown>(payload: Record<string, unknown>): Promise<RuntimeResponse<T>> {
  return chrome.runtime.sendMessage(payload) as Promise<RuntimeResponse<T>>;
}

function describeBrowserError(error?: BrowserError): string {
  if (!error) return `${preferences.preferredName}, la mission s’est interrompue sans détail exploitable.`;
  switch (error.code) {
    case "HUMAN_VERIFICATION": return `${preferences.preferredName}, le site demande une vérification humaine. Effectuez-la dans l’onglet Neptune, puis reprenez au checkpoint.`;
    case "AUTHENTICATION_REQUIRED": return `${preferences.preferredName}, le compte nécessaire n’est pas connecté. Connectez-vous dans l’onglet Neptune, puis reprenez la mission.`;
    case "PAGE_PERMISSION": return `${preferences.preferredName}, Chrome a refusé l’accès à cette page. Vérifiez les autorisations de l’extension puis reprenez.`;
    case "TARGET_NOT_FOUND": return `${preferences.preferredName}, l’élément attendu n’est plus visible. Je vais réobserver la page et adapter le plan.`;
    case "NAVIGATION_TIMEOUT": return `${preferences.preferredName}, la page a mis trop de temps à répondre. Vérifiez l’onglet puis reprenez.`;
    case "MISSION_STOPPED": return "La mission a été arrêtée.";
    default: return `${preferences.preferredName}, j’ai rencontré un blocage : ${error.message}`;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "Une erreur inattendue est survenue.";
}

function normalizeSpeech(value: string): string {
  return value.toLocaleLowerCase("fr-FR").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function formatTime(value: string): string {
  try { return new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }
  catch { return value; }
}

function isAgentMission(value: unknown): value is AgentMission {
  return Boolean(value && typeof value === "object" && typeof (value as AgentMission).goal === "string" && Array.isArray((value as AgentMission).history));
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Élément manquant : ${id}`);
  return element as T;
}

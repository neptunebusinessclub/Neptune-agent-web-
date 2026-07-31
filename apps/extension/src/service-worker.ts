import type { BrowserAction } from "@neptune/protocol";
import {
  ensureManagedHermes,
  getManagedHermesStatus,
  repairManagedHermes,
  type ManagedHermesProgress
} from "./managed-hermes-runtime";

export {};

type WorkspaceMode = "current-tab" | "new-tab" | "new-window";
type WakeConfig = { wakeWord: "Neptune" | "OK Neptune"; wakeWordEnabled: boolean; language: string; oneShot: boolean };
type AgentStateResource = "mission" | "preferences" | "messages" | "audit";
type AgentMessageInput = { role: "user" | "assistant"; text: string; tone?: "normal" | "warning" | "permission" };
type AgentAuditInput = { type: string; detail: string };
type ExtensionRequest =
  | { type: "GET_STATUS" }
  | { type: "GET_ACTIVE_TAB" }
  | { type: "START_MISSION"; initialUrl?: string; workspaceMode?: WorkspaceMode }
  | { type: "GET_WORK_TAB" }
  | { type: "STOP_MISSION" }
  | { type: "EXECUTE_ACTION"; action: BrowserAction; approved: boolean }
  | { type: "START_WAKE_LISTENER"; config: WakeConfig }
  | { type: "PAUSE_WAKE_LISTENER" }
  | { type: "STOP_WAKE_LISTENER" }
  | { type: "GET_WAKE_STATUS" }
  | { type: "BACKGROUND_WAKE_TRANSCRIPT"; transcript: string }
  | { type: "WAKE_DOCUMENT_STATUS"; status: string; error?: string }
  | { type: "GET_MANAGED_HERMES" }
  | { type: "REPAIR_MANAGED_HERMES" }
  | { type: "GET_MANAGED_HERMES_STATUS" }
  | { type: "AGENT_START"; goal: string; workspaceMode?: WorkspaceMode; initialUrl?: string }
  | { type: "AGENT_STOP"; reason?: string }
  | { type: "AGENT_APPROVE" }
  | { type: "AGENT_RESUME" }
  | { type: "AGENT_STATUS" }
  | { type: "AGENT_STATE_READ"; resource: AgentStateResource }
  | { type: "AGENT_STATE_WRITE_MISSION"; mission: unknown }
  | { type: "AGENT_STATE_APPEND_MESSAGE"; message: AgentMessageInput }
  | { type: "AGENT_STATE_APPEND_AUDIT"; entry: AgentAuditInput };

type BrowserError = {
  code: "HUMAN_VERIFICATION" | "AUTHENTICATION_REQUIRED" | "PAGE_PERMISSION" | "TARGET_NOT_FOUND" | "BROWSER_ACTION_FAILED" | "MISSION_STOPPED" | "NAVIGATION_TIMEOUT";
  message: string;
  requiresHuman: boolean;
  retryable: boolean;
};
type WakeStatus = { status: string; error?: string; updatedAt: string };
type AgentMissionSummary = { id?: string; status?: string; updatedAt?: string };
type StoredMessage = AgentMessageInput & { id: string; tone: "normal" | "warning" | "permission"; createdAt: string };
type StoredAudit = AgentAuditInput & { id: string; occurredAt: string };

const WORK_TAB_STORAGE_KEY = "neptuneWorkTabId";
const WORK_MODE_STORAGE_KEY = "neptuneWorkMode";
const WAKE_STATUS_STORAGE_KEY = "neptune.backgroundWakeStatus.v1";
const WAKE_CONFIG_STORAGE_KEY = "neptune.backgroundWakeConfig.v1";
const PENDING_TRANSCRIPT_KEY = "neptune.pendingVoiceTranscript.v1";
const ASSISTANT_WINDOW_KEY = "neptune.voiceAssistantWindowId.v1";
const MISSION_CONTROL_KEY = "neptune.missionControl.v2";
const MISSION_STORAGE_KEY = "neptune.agent.mission.v3";
const PREFERENCES_KEY = "neptune.preferences.v2";
const MESSAGES_STORAGE_KEY = "neptune.messages.v2";
const AUDIT_STORAGE_KEY = "neptune.audit.v2";
const HERMES_STATUS_KEY = "neptune.hermes.status.v2";
const OFFSCREEN_PATH = "offscreen.html";
const SIDEPANEL_PATH = "sidepanel.html";
const HERMES_HEALTH_ALARM = "neptune-hermes-health";
const AGENT_RECOVERY_ALARM = "neptune-agent-recovery";
const MAX_MESSAGES = 80;
const MAX_AUDIT = 240;

type MissionControl = { generation: number; status: "running" | "stopped"; updatedAt: string };
let creatingOffscreen: Promise<void> | null = null;

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  scheduleSupervision();
  void restoreBackgroundServices();
});
chrome.runtime.onStartup.addListener(() => {
  scheduleSupervision();
  void restoreBackgroundServices();
});
chrome.runtime.onSuspend.addListener(() => {
  void chrome.storage.session.set({ [HERMES_STATUS_KEY]: { ready: false, code: "SUSPENDED", detail: "Superviseur en veille", updatedAt: new Date().toISOString() } });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HERMES_HEALTH_ALARM) void superviseHermes();
  if (alarm.name === AGENT_RECOVERY_ALARM) void restoreAgentRuntime();
});
chrome.commands.onCommand.addListener((command) => {
  if (command !== "activate-neptune") return;
  void chrome.windows.getLastFocused().then((window) => typeof window.id === "number" ? chrome.sidePanel.open({ windowId: window.id }) : undefined).catch(() => undefined);
});
chrome.tabs.onRemoved.addListener((tabId) => void clearWorkTabIfMatches(tabId));
chrome.windows.onRemoved.addListener((windowId) => void clearAssistantWindowIfMatches(windowId));

chrome.runtime.onMessage.addListener((request: ExtensionRequest & { target?: string }, _sender, sendResponse) => {
  if (["neptune-sidepanel", "neptune-offscreen", "neptune-agent-runtime"].includes(request?.target ?? "")) return false;
  void handleRequest(request)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error: unknown) => sendResponse({ ok: false, error: classifyBrowserError(error) }));
  return true;
});

async function handleRequest(request: ExtensionRequest): Promise<unknown> {
  switch (request.type) {
    case "GET_STATUS": {
      const control = await getMissionControl();
      const hermes = await readHermesStatus();
      return {
        version: chrome.runtime.getManifest().version,
        stopped: control.status === "stopped",
        missionControl: control,
        workTab: publicTab(await getWorkTabIfPresent()),
        wake: await getWakeStatus(),
        hermes,
        mission: await readDurableMission()
      };
    }
    case "GET_ACTIVE_TAB":
      return { tab: publicTab(await getActiveWebTab()) };
    case "START_MISSION": {
      const control = await startMissionControl();
      return { tab: publicTab(await establishWorkspace(request.workspaceMode ?? "new-tab", request.initialUrl)), missionControl: control };
    }
    case "GET_WORK_TAB":
      return { tab: publicTab(await getWorkTab()) };
    case "STOP_MISSION":
      return stopMissionControl();
    case "EXECUTE_ACTION":
      return executeAction(request.action, request.approved);
    case "START_WAKE_LISTENER":
      return startWakeListener(request.config);
    case "PAUSE_WAKE_LISTENER":
      return pauseWakeListener();
    case "STOP_WAKE_LISTENER":
      return stopWakeListener();
    case "GET_WAKE_STATUS":
      return getWakeStatus();
    case "BACKGROUND_WAKE_TRANSCRIPT":
      return handleBackgroundTranscript(request.transcript);
    case "WAKE_DOCUMENT_STATUS":
      return updateWakeStatus(request.status, request.error);
    case "GET_MANAGED_HERMES":
      return ensureHermes(false);
    case "REPAIR_MANAGED_HERMES":
      return ensureHermes(true);
    case "GET_MANAGED_HERMES_STATUS":
      return getManagedHermesStatus();
    case "AGENT_START":
      return startDurableAgent(request.goal, request.workspaceMode ?? "new-tab", request.initialUrl);
    case "AGENT_STOP":
      return stopDurableAgent(request.reason);
    case "AGENT_APPROVE":
      return commandDurableAgent("AGENT_APPROVE", true);
    case "AGENT_RESUME":
      return commandDurableAgent("AGENT_RESUME", true);
    case "AGENT_STATUS":
      return readDurableMission();
    case "AGENT_STATE_READ":
      return readAgentState(request.resource);
    case "AGENT_STATE_WRITE_MISSION":
      return persistAgentMission(request.mission);
    case "AGENT_STATE_APPEND_MESSAGE":
      return appendAgentMessage(request.message);
    case "AGENT_STATE_APPEND_AUDIT":
      return appendAgentAudit(request.entry);
  }
}

async function ensureHermes(repair: boolean): Promise<unknown> {
  const progress = (state: ManagedHermesProgress) => {
    void chrome.storage.session.set({ [HERMES_STATUS_KEY]: { ready: false, code: state.phase, detail: state.detail, progress: state.progress, updatedAt: new Date().toISOString() } });
    void chrome.runtime.sendMessage({ target: "neptune-sidepanel", type: "HERMES_STATUS", ...state }).catch(() => undefined);
  };
  const connection = repair ? await repairManagedHermes(progress) : await ensureManagedHermes(progress);
  const status = { ready: true, code: "READY", detail: "Neptune est prêt.", progress: 100, updatedAt: new Date().toISOString() };
  await chrome.storage.session.set({ [HERMES_STATUS_KEY]: status });
  return connection;
}

async function superviseHermes(): Promise<void> {
  const mission = await readDurableMission();
  const active = mission && ["running", "awaiting_approval", "blocked"].includes(mission.status ?? "");
  const status = await getManagedHermesStatus();
  await chrome.storage.session.set({ [HERMES_STATUS_KEY]: { ...status, updatedAt: new Date().toISOString() } });
  if (!status.ready && active) {
    await ensureHermes(false).catch(async () => {
      await ensureHermes(true).catch(() => undefined);
    });
  }
}

async function readHermesStatus(): Promise<unknown> {
  const stored = await chrome.storage.session.get(HERMES_STATUS_KEY);
  return stored[HERMES_STATUS_KEY] ?? { ready: false, code: "UNKNOWN", detail: "Vérification en attente" };
}

async function startDurableAgent(goal: string, workspaceMode: WorkspaceMode, initialUrl?: string): Promise<unknown> {
  const clean = goal.replace(/\s+/g, " ").trim().slice(0, 10_000);
  if (!clean) throw new Error("BROWSER_ACTION_FAILED: la mission est vide");
  const control = await startMissionControl();
  const tab = await establishWorkspace(workspaceMode, initialUrl);
  await ensureOffscreenDocument();
  const result = await sendToAgentRuntime({ target: "neptune-agent-runtime", type: "AGENT_START", goal: clean });
  return { mission: unwrapOffscreenResult(result), tab: publicTab(tab), missionControl: control };
}

async function stopDurableAgent(reason?: string): Promise<unknown> {
  const control = await stopMissionControl();
  if (!(await hasOffscreenDocument())) return { mission: await readDurableMission(), missionControl: control };
  const result = await sendToAgentRuntime({ target: "neptune-agent-runtime", type: "AGENT_STOP", ...(reason ? { reason } : {}) });
  await closeOffscreenIfIdle();
  return { mission: unwrapOffscreenResult(result), missionControl: control };
}

async function commandDurableAgent(type: "AGENT_APPROVE" | "AGENT_RESUME", resumeControl: boolean): Promise<unknown> {
  if (resumeControl) await startMissionControl();
  await ensureOffscreenDocument();
  const result = await sendToAgentRuntime({ target: "neptune-agent-runtime", type });
  return unwrapOffscreenResult(result);
}

async function restoreAgentRuntime(): Promise<void> {
  const mission = await readDurableMission();
  if (!mission || !["running", "awaiting_approval", "blocked"].includes(mission.status ?? "")) return;
  await ensureOffscreenDocument();
  await sendToAgentRuntime({ target: "neptune-agent-runtime", type: "AGENT_STATUS" }).catch(() => undefined);
}

async function readDurableMission(): Promise<AgentMissionSummary | null> {
  const stored = await chrome.storage.local.get(MISSION_STORAGE_KEY);
  const value = stored[MISSION_STORAGE_KEY];
  return isMissionRecord(value) ? value : null;
}

async function readAgentState(resource: AgentStateResource): Promise<unknown> {
  const key = resource === "mission"
    ? MISSION_STORAGE_KEY
    : resource === "preferences"
      ? PREFERENCES_KEY
      : resource === "messages"
        ? MESSAGES_STORAGE_KEY
        : AUDIT_STORAGE_KEY;
  const stored = await chrome.storage.local.get(key);
  return stored[key] ?? (resource === "messages" || resource === "audit" ? [] : null);
}

async function persistAgentMission(value: unknown): Promise<AgentMissionSummary> {
  if (!isMissionRecord(value)) throw new Error("BROWSER_ACTION_FAILED: état de mission invalide");
  const mission = { ...value, updatedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [MISSION_STORAGE_KEY]: mission });
  await chrome.runtime.sendMessage({ target: "neptune-sidepanel", type: "AGENT_STATE_CHANGED", mission }).catch(() => undefined);
  return mission;
}

async function appendAgentMessage(input: AgentMessageInput): Promise<StoredMessage[]> {
  const text = typeof input?.text === "string" ? input.text.trim().slice(0, 12_000) : "";
  if (!text || !["user", "assistant"].includes(input?.role)) throw new Error("BROWSER_ACTION_FAILED: message de mission invalide");
  const stored = await chrome.storage.local.get(MESSAGES_STORAGE_KEY);
  const current = Array.isArray(stored[MESSAGES_STORAGE_KEY]) ? stored[MESSAGES_STORAGE_KEY] as StoredMessage[] : [];
  const message: StoredMessage = {
    id: crypto.randomUUID(),
    role: input.role,
    text,
    tone: input.tone === "warning" || input.tone === "permission" ? input.tone : "normal",
    createdAt: new Date().toISOString()
  };
  const messages = [...current, message].slice(-MAX_MESSAGES);
  await chrome.storage.local.set({ [MESSAGES_STORAGE_KEY]: messages });
  return messages;
}

async function appendAgentAudit(input: AgentAuditInput): Promise<StoredAudit[]> {
  const type = typeof input?.type === "string" ? input.type.trim().slice(0, 120) : "";
  const detail = typeof input?.detail === "string" ? input.detail.trim().slice(0, 1_000) : "";
  if (!type) throw new Error("BROWSER_ACTION_FAILED: événement de mission invalide");
  const stored = await chrome.storage.local.get(AUDIT_STORAGE_KEY);
  const current = Array.isArray(stored[AUDIT_STORAGE_KEY]) ? stored[AUDIT_STORAGE_KEY] as StoredAudit[] : [];
  const audit = [...current, { id: crypto.randomUUID(), type, detail, occurredAt: new Date().toISOString() }].slice(-MAX_AUDIT);
  await chrome.storage.local.set({ [AUDIT_STORAGE_KEY]: audit });
  return audit;
}

function isMissionRecord(value: unknown): value is AgentMissionSummary & Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const source = value as Record<string, unknown>;
  return typeof source.id === "string" && typeof source.status === "string" && typeof source.updatedAt === "string";
}

function unwrapOffscreenResult(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const response = value as { ok?: boolean; result?: unknown; error?: string };
  if (response.ok === false) throw new Error(response.error || "Le moteur de mission Neptune a échoué.");
  return response.result ?? value;
}

async function executeAction(action: BrowserAction, approved: boolean): Promise<unknown> {
  enforcePolicy(action, approved);
  await assertMissionRunning();
  switch (action.type) {
    case "OPEN_URL": {
      if (!action.url) throw new Error("OPEN_URL requires an URL");
      const url = validateNavigationUrl(action.url);
      const tab = await getWorkTab();
      if (!tab.id) throw new Error("Aucun onglet de travail disponible");
      await chrome.tabs.update(tab.id, { url, active: true });
      await waitForTab(tab.id, 30_000);
      return { url, tabId: tab.id };
    }
    case "NAVIGATE_BACK": {
      const tab = await getWorkTab();
      if (!tab.id) throw new Error("Aucun onglet de travail disponible");
      await chrome.tabs.goBack(tab.id);
      await waitForTab(tab.id, 30_000);
      return publicTab(await chrome.tabs.get(tab.id));
    }
    case "WAIT":
      await sleep(action.delayMs ?? 1_000);
      return { waitedMs: action.delayMs ?? 1_000 };
    case "ASK_APPROVAL":
      throw new Error("Human approval required");
    case "STOP_TASK":
      return stopMissionControl();
    default:
      return executeInWorkTab(action);
  }
}

function enforcePolicy(action: BrowserAction, approved: boolean): void {
  if ((action.risk === "external_write" || action.risk === "sensitive" || action.requiresApproval) && !approved) {
    throw new Error(`Action ${action.type} bloquée : autorisation explicite requise`);
  }
  if (action.type === "SEND_MESSAGE" && !action.requiresApproval) throw new Error("Plan invalide : SEND_MESSAGE doit exiger une autorisation");
  if (action.risk === "sensitive") throw new Error("Les actions sensibles ne sont pas exécutées automatiquement par Neptune");
}

async function executeInWorkTab(action: BrowserAction): Promise<unknown> {
  const tab = await getWorkTab();
  if (!tab.id) throw new Error("Aucun onglet de travail disponible");
  if (!tab.url || !/^https?:\/\//i.test(tab.url)) throw new Error("La page de travail ne peut pas être contrôlée. Commencez par ouvrir un site web.");
  await focusTab(tab);
  await ensureContentScript(tab.id);
  const response = await withTimeout(chrome.tabs.sendMessage(tab.id, {
    source: "NEPTUNE_AGENT",
    type: "EXECUTE_CONTENT_ACTION",
    action
  }), Math.max(12_000, (action.delayMs ?? 0) + 7_000));
  if (!response?.ok) throw new Error(response?.error ?? "L’action sur la page a échoué");
  await assertMissionRunning();
  return response.result ?? response;
}

async function establishWorkspace(mode: WorkspaceMode, initialUrl?: string): Promise<chrome.tabs.Tab> {
  let tab: chrome.tabs.Tab;
  if (mode === "current-tab") {
    tab = await getActiveWebTab();
  } else if (mode === "new-window") {
    const created = await chrome.windows.create({ url: safeInitialUrl(initialUrl), type: "normal", focused: true });
    if (typeof created.id !== "number") throw new Error("BROWSER_ACTION_FAILED: impossible de créer la fenêtre de travail");
    const tabs = await chrome.tabs.query({ windowId: created.id, active: true });
    const createdTab = tabs[0];
    const createdTabId = createdTab?.id;
    if (!createdTab || typeof createdTabId !== "number") throw new Error("BROWSER_ACTION_FAILED: la nouvelle fenêtre ne contient aucun onglet");
    tab = createdTab;
    if (/^https?:\/\//i.test(tab.url ?? "")) await waitForTab(createdTabId, 30_000);
  } else {
    tab = await createWorkTab(initialUrl);
  }
  if (typeof tab.id !== "number") throw new Error("BROWSER_ACTION_FAILED: aucun onglet de travail disponible");
  await chrome.storage.session.set({ [WORK_TAB_STORAGE_KEY]: tab.id, [WORK_MODE_STORAGE_KEY]: mode });
  return chrome.tabs.get(tab.id);
}

async function getMissionControl(): Promise<MissionControl> {
  const stored = await chrome.storage.session.get(MISSION_CONTROL_KEY);
  const value = stored[MISSION_CONTROL_KEY] as Partial<MissionControl> | undefined;
  return {
    generation: typeof value?.generation === "number" ? value.generation : 0,
    status: value?.status === "stopped" ? "stopped" : "running",
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString()
  };
}

async function startMissionControl(): Promise<MissionControl> {
  const previous = await getMissionControl();
  const next: MissionControl = { generation: previous.generation + 1, status: "running", updatedAt: new Date().toISOString() };
  await chrome.storage.session.set({ [MISSION_CONTROL_KEY]: next });
  return next;
}

async function stopMissionControl(): Promise<{ stopped: true; missionControl: MissionControl }> {
  const previous = await getMissionControl();
  const next: MissionControl = { ...previous, status: "stopped", updatedAt: new Date().toISOString() };
  await chrome.storage.session.set({ [MISSION_CONTROL_KEY]: next });
  return { stopped: true, missionControl: next };
}

async function assertMissionRunning(): Promise<void> {
  const control = await getMissionControl();
  if (control.status === "stopped") throw new Error("MISSION_STOPPED: mission arrêtée par l’utilisateur");
}

async function focusTab(tab: chrome.tabs.Tab): Promise<void> {
  if (typeof tab.windowId === "number") await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  if (typeof tab.id === "number") await chrome.tabs.update(tab.id, { active: true });
}

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { source: "NEPTUNE_AGENT", type: "PING" });
    if (response?.ok) return;
  } catch { /* injection contrôlée */ }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
  } catch (error) {
    throw new Error(`PAGE_PERMISSION: impossible d’accéder à cette page : ${error instanceof Error ? error.message : "permission refusée"}`);
  }
}

async function createWorkTab(initialUrl?: string): Promise<chrome.tabs.Tab> {
  const url = safeInitialUrl(initialUrl);
  const tab = await chrome.tabs.create({ url, active: true });
  if (!tab.id) throw new Error("Impossible de créer l’onglet de travail Neptune");
  if (/^https?:\/\//i.test(url)) await waitForTab(tab.id, 30_000);
  return chrome.tabs.get(tab.id);
}

async function getWorkTab(): Promise<chrome.tabs.Tab> {
  return await getWorkTabIfPresent() ?? establishWorkspace("new-tab");
}

async function getWorkTabIfPresent(): Promise<chrome.tabs.Tab | null> {
  const stored = await chrome.storage.session.get(WORK_TAB_STORAGE_KEY);
  const tabId = stored[WORK_TAB_STORAGE_KEY];
  if (typeof tabId !== "number") return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    await chrome.storage.session.remove([WORK_TAB_STORAGE_KEY, WORK_MODE_STORAGE_KEY]);
    return null;
  }
}

async function getActiveWebTab(): Promise<chrome.tabs.Tab> {
  const candidates = [
    ...(await chrome.tabs.query({ active: true, lastFocusedWindow: true })),
    ...(await chrome.tabs.query({ active: true, currentWindow: true }))
  ];
  const tab = candidates.find((candidate) => /^https?:\/\//i.test(candidate.url ?? ""));
  if (!tab) throw new Error("BROWSER_ACTION_FAILED: aucun onglet web actif n’est disponible");
  return tab;
}

async function clearWorkTabIfMatches(tabId: number): Promise<void> {
  const stored = await chrome.storage.session.get(WORK_TAB_STORAGE_KEY);
  if (stored[WORK_TAB_STORAGE_KEY] === tabId) await chrome.storage.session.remove([WORK_TAB_STORAGE_KEY, WORK_MODE_STORAGE_KEY]);
}

function publicTab(tab: chrome.tabs.Tab | null): { id?: number; url?: string; title?: string; windowId?: number } | null {
  if (!tab) return null;
  return {
    ...(typeof tab.id === "number" ? { id: tab.id } : {}),
    ...(typeof tab.url === "string" ? { url: tab.url } : {}),
    ...(typeof tab.title === "string" ? { title: tab.title } : {}),
    ...(typeof tab.windowId === "number" ? { windowId: tab.windowId } : {})
  };
}

function safeInitialUrl(rawUrl?: string): string {
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return "about:blank";
  return validateNavigationUrl(rawUrl);
}

function validateNavigationUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`Protocole bloqué : ${url.protocol}`);
  url.username = "";
  url.password = "";
  return url.toString();
}

async function waitForTab(tabId: number, timeoutMs: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("NAVIGATION_TIMEOUT: délai de navigation dépassé"));
    }, timeoutMs);
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function startWakeListener(config: WakeConfig): Promise<Record<string, unknown>> {
  await chrome.storage.session.set({ [WAKE_CONFIG_STORAGE_KEY]: config });
  await ensureOffscreenDocument();
  const response = await sendToOffscreen({ target: "neptune-offscreen", type: "WAKE_START", config });
  await updateWakeStatus("starting");
  return { status: "starting", offscreen: true, response };
}

async function pauseWakeListener(): Promise<Record<string, unknown>> {
  if (!(await hasOffscreenDocument())) return { status: "stopped", offscreen: false };
  const response = await sendToOffscreen({ target: "neptune-offscreen", type: "WAKE_PAUSE" });
  await updateWakeStatus("paused");
  return { status: "paused", response };
}

async function stopWakeListener(): Promise<Record<string, unknown>> {
  if (await hasOffscreenDocument()) {
    await sendToOffscreen({ target: "neptune-offscreen", type: "WAKE_STOP" }).catch(() => undefined);
  }
  await chrome.storage.session.remove([WAKE_CONFIG_STORAGE_KEY, PENDING_TRANSCRIPT_KEY]);
  await updateWakeStatus("stopped");
  await closeOffscreenIfIdle();
  return { status: "stopped" };
}

async function restoreBackgroundServices(): Promise<void> {
  await Promise.allSettled([restoreWakeListener(), restoreAgentRuntime(), superviseHermes()]);
}

async function restoreWakeListener(): Promise<void> {
  const stored = await chrome.storage.local.get(PREFERENCES_KEY);
  const preferences = stored[PREFERENCES_KEY] as { onboardingComplete?: boolean; wakeWordEnabled?: boolean } | undefined;
  if (!preferences?.onboardingComplete || !preferences.wakeWordEnabled) return;
  await startWakeListener({ wakeWord: "OK Neptune", wakeWordEnabled: true, language: "fr-FR", oneShot: false })
    .catch((error: unknown) => updateWakeStatus("error", error instanceof Error ? error.message : "Restauration impossible"));
}

async function handleBackgroundTranscript(transcript: string): Promise<Record<string, unknown>> {
  const clean = transcript.replace(/\s+/g, " ").trim().slice(0, 10_000);
  if (!clean) return { delivered: false };
  await chrome.storage.session.set({ [PENDING_TRANSCRIPT_KEY]: clean });
  const sidepanelUrl = chrome.runtime.getURL(SIDEPANEL_PATH);
  const contexts = await chrome.runtime.getContexts({ documentUrls: [sidepanelUrl] });
  if (contexts.length > 0) {
    await chrome.runtime.sendMessage({ target: "neptune-sidepanel", type: "WAKE_TRANSCRIPT", transcript: clean }).catch(() => undefined);
    return { delivered: true, destination: "existing-interface" };
  }
  const windowId = await openAssistantWindow();
  return { delivered: true, destination: "voice-window", windowId };
}

async function openAssistantWindow(): Promise<number | undefined> {
  const stored = await chrome.storage.session.get(ASSISTANT_WINDOW_KEY);
  const existingId = stored[ASSISTANT_WINDOW_KEY];
  if (typeof existingId === "number") {
    try {
      await chrome.windows.update(existingId, { focused: true, drawAttention: true });
      return existingId;
    } catch {
      await chrome.storage.session.remove(ASSISTANT_WINDOW_KEY);
    }
  }
  const created = await chrome.windows.create({ url: chrome.runtime.getURL(`${SIDEPANEL_PATH}?mode=voice`), type: "popup", width: 500, height: 780, focused: true });
  if (typeof created.id === "number") {
    await chrome.storage.session.set({ [ASSISTANT_WINDOW_KEY]: created.id });
    return created.id;
  }
  return undefined;
}

async function clearAssistantWindowIfMatches(windowId: number): Promise<void> {
  const stored = await chrome.storage.session.get(ASSISTANT_WINDOW_KEY);
  if (stored[ASSISTANT_WINDOW_KEY] === windowId) await chrome.storage.session.remove(ASSISTANT_WINDOW_KEY);
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.WORKERS],
    justification: "Maintenir l’activation vocale et le moteur de mission Neptune en arrière-plan."
  }).finally(() => { creatingOffscreen = null; });
  return creatingOffscreen;
}

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });
  return contexts.length > 0;
}

async function closeOffscreenIfIdle(): Promise<void> {
  const [wake, mission] = await Promise.all([getWakeStatus(), readDurableMission()]);
  const wakeActive = !["stopped", "unavailable", "error"].includes(wake.status);
  const missionActive = Boolean(mission && ["running", "awaiting_approval", "blocked"].includes(mission.status ?? ""));
  if (!wakeActive && !missionActive && await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument().catch(() => undefined);
  }
}

async function sendToOffscreen(payload: Record<string, unknown>): Promise<unknown> {
  return chrome.runtime.sendMessage(payload);
}

async function sendToAgentRuntime(payload: Record<string, unknown>): Promise<unknown> {
  return chrome.runtime.sendMessage(payload);
}

async function updateWakeStatus(status: string, error?: string): Promise<WakeStatus> {
  const value: WakeStatus = { status, ...(error ? { error } : {}), updatedAt: new Date().toISOString() };
  await chrome.storage.session.set({ [WAKE_STATUS_STORAGE_KEY]: value });
  await chrome.runtime.sendMessage({ target: "neptune-sidepanel", type: "WAKE_STATUS", ...value }).catch(() => undefined);
  return value;
}

async function getWakeStatus(): Promise<WakeStatus> {
  const stored = await chrome.storage.session.get(WAKE_STATUS_STORAGE_KEY);
  return stored[WAKE_STATUS_STORAGE_KEY] as WakeStatus | undefined ?? { status: "stopped", updatedAt: new Date(0).toISOString() };
}

function scheduleSupervision(): void {
  void chrome.alarms.create(HERMES_HEALTH_ALARM, { periodInMinutes: 1 });
  void chrome.alarms.create(AGENT_RECOVERY_ALARM, { periodInMinutes: 1 });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timeout = setTimeout(() => reject(new Error("BROWSER_ACTION_FAILED: délai d’action dépassé")), timeoutMs); })]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function classifyBrowserError(error: unknown): BrowserError {
  const message = error instanceof Error ? error.message : "Erreur navigateur inconnue";
  const normalized = message.toLocaleLowerCase("fr-FR");
  if (normalized.includes("mission_stopped")) return { code: "MISSION_STOPPED", message, requiresHuman: false, retryable: false };
  if (normalized.includes("navigation_timeout")) return { code: "NAVIGATION_TIMEOUT", message, requiresHuman: false, retryable: true };
  if (normalized.includes("platform_guard_detected") || normalized.includes("captcha")) return { code: "HUMAN_VERIFICATION", message, requiresHuman: true, retryable: true };
  if (normalized.includes("connexion") || normalized.includes("connecté") || normalized.includes("login")) return { code: "AUTHENTICATION_REQUIRED", message, requiresHuman: true, retryable: true };
  if (normalized.includes("page_permission") || normalized.includes("permission") || normalized.includes("cannot access contents")) return { code: "PAGE_PERMISSION", message, requiresHuman: false, retryable: true };
  if (normalized.includes("target not found") || normalized.includes("cible")) return { code: "TARGET_NOT_FOUND", message, requiresHuman: false, retryable: true };
  return { code: "BROWSER_ACTION_FAILED", message, requiresHuman: false, retryable: true };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

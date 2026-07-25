import type { BrowserAction } from "@neptune/protocol";

export {};

type WorkspaceMode = "current-tab" | "new-tab" | "new-window";
type WakeConfig = { wakeWord: "Neptune" | "OK Neptune"; wakeWordEnabled: boolean; language: string; oneShot: boolean };
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
  | { type: "WAKE_DOCUMENT_STATUS"; status: string; error?: string };

type BrowserError = {
  code: "HUMAN_VERIFICATION" | "AUTHENTICATION_REQUIRED" | "PAGE_PERMISSION" | "TARGET_NOT_FOUND" | "BROWSER_ACTION_FAILED" | "MISSION_STOPPED" | "NAVIGATION_TIMEOUT";
  message: string;
  requiresHuman: boolean;
  retryable: boolean;
};
type WakeStatus = { status: string; error?: string; updatedAt: string };

const WORK_TAB_STORAGE_KEY = "neptuneWorkTabId";
const WORK_MODE_STORAGE_KEY = "neptuneWorkMode";
const WAKE_STATUS_STORAGE_KEY = "neptune.backgroundWakeStatus.v1";
const WAKE_CONFIG_STORAGE_KEY = "neptune.backgroundWakeConfig.v1";
const PENDING_TRANSCRIPT_KEY = "neptune.pendingVoiceTranscript.v1";
const ASSISTANT_WINDOW_KEY = "neptune.voiceAssistantWindowId.v1";
const PREFERENCES_KEY = "neptune.preferences.v2";
const OFFSCREEN_PATH = "offscreen.html";
const SIDEPANEL_PATH = "sidepanel.html";
let stopped = false;
let creatingOffscreen: Promise<void> | null = null;

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void restoreWakeListener();
});
chrome.runtime.onStartup.addListener(() => void restoreWakeListener());
chrome.commands.onCommand.addListener((command) => {
  if (command !== "activate-neptune") return;
  void chrome.windows.getLastFocused().then((window) => typeof window.id === "number" ? chrome.sidePanel.open({ windowId: window.id }) : undefined).catch(() => undefined);
});
chrome.tabs.onRemoved.addListener((tabId) => void clearWorkTabIfMatches(tabId));
chrome.windows.onRemoved.addListener((windowId) => void clearAssistantWindowIfMatches(windowId));

chrome.runtime.onMessage.addListener((request: ExtensionRequest & { target?: string }, _sender, sendResponse) => {
  if (request?.target === "neptune-sidepanel" || request?.target === "neptune-offscreen") return false;
  void handleRequest(request)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error: unknown) => sendResponse({ ok: false, error: classifyBrowserError(error) }));
  return true;
});

async function handleRequest(request: ExtensionRequest): Promise<unknown> {
  switch (request.type) {
    case "GET_STATUS":
      return { version: chrome.runtime.getManifest().version, stopped, workTab: publicTab(await getWorkTabIfPresent()), wake: await getWakeStatus() };
    case "GET_ACTIVE_TAB":
      return { tab: publicTab(await getActiveWebTab()) };
    case "START_MISSION":
      stopped = false;
      return { tab: publicTab(await establishWorkspace(request.workspaceMode ?? "new-tab", request.initialUrl)) };
    case "GET_WORK_TAB":
      return { tab: publicTab(await getWorkTab()) };
    case "STOP_MISSION":
      stopped = true;
      return { stopped: true };
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
  }
}

async function establishWorkspace(mode: WorkspaceMode, initialUrl?: string): Promise<chrome.tabs.Tab> {
  let tab: chrome.tabs.Tab;
  if (mode === "current-tab") {
    tab = await getActiveWebTab();
  } else if (mode === "new-window") {
    const created = await chrome.windows.create({ url: safeInitialUrl(initialUrl), type: "normal", focused: true });
    if (typeof created.id !== "number") throw new Error("BROWSER_ACTION_FAILED: impossible de créer la fenêtre de travail");
    const tabs = await chrome.tabs.query({ windowId: created.id, active: true });
    if (!tabs[0]?.id) throw new Error("BROWSER_ACTION_FAILED: la nouvelle fenêtre ne contient aucun onglet");
    tab = tabs[0];
    if (/^https?:\/\//i.test(tab.url ?? "")) await waitForTab(tab.id, 30_000);
  } else {
    tab = await createWorkTab(initialUrl);
  }
  if (typeof tab.id !== "number") throw new Error("BROWSER_ACTION_FAILED: aucun onglet de travail disponible");
  await chrome.storage.session.set({ [WORK_TAB_STORAGE_KEY]: tab.id, [WORK_MODE_STORAGE_KEY]: mode });
  return chrome.tabs.get(tab.id);
}

async function executeAction(action: BrowserAction, approved: boolean): Promise<unknown> {
  enforcePolicy(action, approved);
  if (stopped) throw new Error("MISSION_STOPPED: mission arrêtée par l’utilisateur");
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
      stopped = true;
      return { stopped: true };
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
  return response.result ?? response;
}

async function focusTab(tab: chrome.tabs.Tab): Promise<void> {
  if (typeof tab.windowId === "number") await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  if (typeof tab.id === "number") await chrome.tabs.update(tab.id, { active: true });
}

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { source: "NEPTUNE_AGENT", type: "PING" });
    if (response?.ok) return;
  } catch {
    // Injection contrôlée ci-dessous.
  }
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
    await chrome.offscreen.closeDocument().catch(() => undefined);
  }
  await chrome.storage.session.remove([WAKE_CONFIG_STORAGE_KEY, PENDING_TRANSCRIPT_KEY]);
  await updateWakeStatus("stopped");
  return { status: "stopped" };
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
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "Écouter le mot d’activation Neptune lorsque l’interface de l’extension est fermée."
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

async function sendToOffscreen(payload: Record<string, unknown>): Promise<unknown> {
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

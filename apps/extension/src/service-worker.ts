import type { BrowserAction } from "@neptune/protocol";

type ExtensionRequest =
  | { type: "GET_STATUS" }
  | { type: "GET_ACTIVE_TAB" }
  | { type: "START_MISSION"; initialUrl?: string }
  | { type: "GET_WORK_TAB" }
  | { type: "STOP_MISSION" }
  | { type: "EXECUTE_ACTION"; action: BrowserAction; approved: boolean };

type BrowserError = {
  code: "HUMAN_VERIFICATION" | "AUTHENTICATION_REQUIRED" | "PAGE_PERMISSION" | "TARGET_NOT_FOUND" | "BROWSER_ACTION_FAILED" | "MISSION_STOPPED";
  message: string;
  requiresHuman: boolean;
  retryable: boolean;
};

const WORK_TAB_STORAGE_KEY = "neptuneWorkTabId";
let stopped = false;

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "activate-neptune") return;
  void chrome.windows.getCurrent().then((window) => {
    if (typeof window.id === "number") return chrome.sidePanel.open({ windowId: window.id });
    return undefined;
  }).catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearWorkTabIfMatches(tabId);
});

chrome.runtime.onMessage.addListener((request: ExtensionRequest, _sender, sendResponse) => {
  void handleRequest(request)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error: unknown) => sendResponse({ ok: false, error: classifyBrowserError(error) }));
  return true;
});

async function handleRequest(request: ExtensionRequest): Promise<unknown> {
  switch (request.type) {
    case "GET_STATUS":
      return {
        version: chrome.runtime.getManifest().version,
        stopped,
        workTab: publicTab(await getWorkTabIfPresent())
      };
    case "GET_ACTIVE_TAB":
      return { tab: publicTab(await getActiveTab()) };
    case "START_MISSION":
      stopped = false;
      return { tab: publicTab(await createWorkTab(request.initialUrl)) };
    case "GET_WORK_TAB":
      return { tab: publicTab(await getWorkTab()) };
    case "STOP_MISSION":
      stopped = true;
      return { stopped: true };
    case "EXECUTE_ACTION":
      return executeAction(request.action, request.approved);
  }
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
  if (action.type === "SEND_MESSAGE" && !action.requiresApproval) {
    throw new Error("Plan invalide : SEND_MESSAGE doit exiger une autorisation");
  }
  if (action.risk === "sensitive") {
    throw new Error("Les actions sensibles ne sont pas exécutées automatiquement par Neptune");
  }
}

async function executeInWorkTab(action: BrowserAction): Promise<unknown> {
  const tab = await getWorkTab();
  if (!tab.id) throw new Error("Aucun onglet de travail disponible");
  if (!tab.url || !/^https?:\/\//i.test(tab.url)) {
    throw new Error("La page de travail ne peut pas être contrôlée. Commencez par ouvrir un site web.");
  }

  await chrome.tabs.update(tab.id, { active: true });
  await ensureContentScript(tab.id);
  const response = await chrome.tabs.sendMessage(tab.id, {
    source: "NEPTUNE_AGENT",
    type: "EXECUTE_CONTENT_ACTION",
    action
  });
  if (!response?.ok) throw new Error(response?.error ?? "L’action sur la page a échoué");
  return response.result ?? response;
}

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { source: "NEPTUNE_AGENT", type: "PING" });
    if (response?.ok) return;
  } catch {
    // Le script sera injecté ci-dessous.
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Permission de page refusée";
    throw new Error(`PAGE_PERMISSION: impossible d’accéder à cette page : ${message}`);
  }
}

async function createWorkTab(initialUrl?: string): Promise<chrome.tabs.Tab> {
  const url = safeInitialUrl(initialUrl);
  const tab = await chrome.tabs.create({ url, active: true });
  if (!tab.id) throw new Error("Impossible de créer l’onglet de travail Neptune");
  await chrome.storage.session.set({ [WORK_TAB_STORAGE_KEY]: tab.id });
  if (/^https?:\/\//i.test(url)) await waitForTab(tab.id, 30_000);
  return chrome.tabs.get(tab.id);
}

async function getWorkTab(): Promise<chrome.tabs.Tab> {
  const existing = await getWorkTabIfPresent();
  return existing ?? createWorkTab();
}

async function getWorkTabIfPresent(): Promise<chrome.tabs.Tab | null> {
  const stored = await chrome.storage.session.get(WORK_TAB_STORAGE_KEY);
  const tabId = stored[WORK_TAB_STORAGE_KEY];
  if (typeof tabId !== "number") return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    await chrome.storage.session.remove(WORK_TAB_STORAGE_KEY);
    return null;
  }
}

async function clearWorkTabIfMatches(tabId: number): Promise<void> {
  const stored = await chrome.storage.session.get(WORK_TAB_STORAGE_KEY);
  if (stored[WORK_TAB_STORAGE_KEY] === tabId) await chrome.storage.session.remove(WORK_TAB_STORAGE_KEY);
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("Aucun onglet actif");
  return tab;
}

function publicTab(tab: chrome.tabs.Tab | null): { id?: number; url?: string; title?: string } | null {
  if (!tab) return null;
  return {
    ...(typeof tab.id === "number" ? { id: tab.id } : {}),
    ...(typeof tab.url === "string" ? { url: tab.url } : {}),
    ...(typeof tab.title === "string" ? { title: tab.title } : {})
  };
}

function safeInitialUrl(rawUrl?: string): string {
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return "about:blank";
  return validateNavigationUrl(rawUrl);
}

function validateNavigationUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (!(["http:", "https:"].includes(url.protocol))) throw new Error(`Protocole bloqué : ${url.protocol}`);
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
      reject(new Error("Délai de navigation dépassé"));
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

function classifyBrowserError(error: unknown): BrowserError {
  const message = error instanceof Error ? error.message : "Erreur navigateur inconnue";
  const normalized = message.toLocaleLowerCase("fr-FR");
  if (normalized.includes("mission_stopped")) {
    return { code: "MISSION_STOPPED", message, requiresHuman: false, retryable: false };
  }
  if (normalized.includes("platform_guard_detected") || normalized.includes("captcha")) {
    return { code: "HUMAN_VERIFICATION", message, requiresHuman: true, retryable: true };
  }
  if (normalized.includes("connexion") || normalized.includes("connecté") || normalized.includes("login")) {
    return { code: "AUTHENTICATION_REQUIRED", message, requiresHuman: true, retryable: true };
  }
  if (normalized.includes("page_permission") || normalized.includes("permission") || normalized.includes("cannot access contents")) {
    return { code: "PAGE_PERMISSION", message, requiresHuman: false, retryable: true };
  }
  if (normalized.includes("target not found") || normalized.includes("cible")) {
    return { code: "TARGET_NOT_FOUND", message, requiresHuman: false, retryable: true };
  }
  return { code: "BROWSER_ACTION_FAILED", message, requiresHuman: false, retryable: true };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

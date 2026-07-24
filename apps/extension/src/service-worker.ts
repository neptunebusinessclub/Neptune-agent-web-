import type { BrowserAction } from "@neptune/protocol";

type ExecuteActionRequest = {
  type: "EXECUTE_ACTION";
  action: BrowserAction;
  approved: boolean;
};

type ExtensionRequest =
  | ExecuteActionRequest
  | { type: "GET_ACTIVE_TAB" }
  | { type: "START_MISSION"; initialUrl?: string }
  | { type: "GET_WORK_TAB" }
  | { type: "STOP_MISSION" };

const WORK_TAB_STORAGE_KEY = "neptuneWorkTabId";
let stopped = false;

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearWorkTabIfMatches(tabId);
});

chrome.runtime.onMessage.addListener((request: ExtensionRequest, _sender, sendResponse) => {
  void handleRequest(request)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "Unknown error" });
    });
  return true;
});

async function handleRequest(request: ExtensionRequest): Promise<unknown> {
  if (request.type === "GET_ACTIVE_TAB") {
    const tab = await getActiveTab();
    return { ok: true, tab: publicTab(tab) };
  }

  if (request.type === "START_MISSION") {
    stopped = false;
    const tab = await createWorkTab(request.initialUrl);
    return { ok: true, tab: publicTab(tab) };
  }

  if (request.type === "GET_WORK_TAB") {
    const tab = await getWorkTab();
    return { ok: true, tab: publicTab(tab) };
  }

  if (request.type === "STOP_MISSION") {
    stopped = true;
    return { ok: true };
  }

  stopped = false;
  const { action, approved } = request;
  enforcePolicy(action, approved);

  if (stopped) throw new Error("Mission stopped");

  switch (action.type) {
    case "OPEN_URL": {
      if (!action.url) throw new Error("OPEN_URL requires an URL");
      const url = validateNavigationUrl(action.url);
      const tab = await getWorkTab();
      if (!tab.id) throw new Error("Aucun onglet de travail disponible");
      await chrome.tabs.update(tab.id, { url, active: true });
      await waitForTab(tab.id, 20_000);
      return { ok: true, url, tabId: tab.id };
    }
    case "WAIT": {
      await sleep(action.delayMs ?? 1_000);
      return { ok: true };
    }
    case "ASK_APPROVAL":
      return { ok: false, blocked: true, error: "Human approval required" };
    case "STOP_TASK":
      stopped = true;
      return { ok: true };
    default:
      return executeInWorkTab(action);
  }
}

function enforcePolicy(action: BrowserAction, approved: boolean): void {
  if ((action.risk === "external_write" || action.risk === "sensitive" || action.requiresApproval) && !approved) {
    throw new Error(`Action ${action.type} blocked: explicit approval required`);
  }
  if (action.type === "SEND_MESSAGE" && !action.requiresApproval) {
    throw new Error("Invalid plan: SEND_MESSAGE must require approval");
  }
}

async function executeInWorkTab(action: BrowserAction): Promise<unknown> {
  const tab = await getWorkTab();
  if (!tab.id) throw new Error("Aucun onglet de travail disponible");
  if (!tab.url || !/^https?:\/\//i.test(tab.url)) {
    throw new Error("La page de travail ne peut pas être contrôlée. Commence par ouvrir un site web.");
  }

  await chrome.tabs.update(tab.id, { active: true });
  await ensureContentScript(tab.id);
  const response = await chrome.tabs.sendMessage(tab.id, {
    source: "NEPTUNE_AGENT",
    type: "EXECUTE_CONTENT_ACTION",
    action
  });

  if (!response?.ok) throw new Error(response?.error ?? "Page action failed");
  return response;
}

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { source: "NEPTUNE_AGENT", type: "PING" });
    if (response?.ok) return;
  } catch {
    // The content script is not installed in this tab yet.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-script.js"]
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Permission de page refusée";
    throw new Error(`Impossible d’accéder à cette page : ${message}`);
  }
}

async function createWorkTab(initialUrl?: string): Promise<chrome.tabs.Tab> {
  const url = safeInitialUrl(initialUrl);
  const tab = await chrome.tabs.create({ url, active: true });
  if (!tab.id) throw new Error("Impossible de créer l’onglet de travail Neptune");
  await chrome.storage.session.set({ [WORK_TAB_STORAGE_KEY]: tab.id });
  if (/^https?:\/\//i.test(url)) await waitForTab(tab.id, 20_000);
  return chrome.tabs.get(tab.id);
}

async function getWorkTab(): Promise<chrome.tabs.Tab> {
  const stored = await chrome.storage.session.get(WORK_TAB_STORAGE_KEY);
  const tabId = stored[WORK_TAB_STORAGE_KEY];
  if (typeof tabId === "number") {
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      await chrome.storage.session.remove(WORK_TAB_STORAGE_KEY);
    }
  }
  return createWorkTab();
}

async function clearWorkTabIfMatches(tabId: number): Promise<void> {
  const stored = await chrome.storage.session.get(WORK_TAB_STORAGE_KEY);
  if (stored[WORK_TAB_STORAGE_KEY] === tabId) {
    await chrome.storage.session.remove(WORK_TAB_STORAGE_KEY);
  }
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active browser tab");
  return tab;
}

function publicTab(tab: chrome.tabs.Tab): {
  id: number | undefined;
  url: string | undefined;
  title: string | undefined;
} {
  return { id: tab.id, url: tab.url, title: tab.title };
}

function safeInitialUrl(rawUrl?: string): string {
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return "about:blank";
  return validateNavigationUrl(rawUrl);
}

function validateNavigationUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Blocked protocol: ${url.protocol}`);
  }
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
      reject(new Error("Navigation timeout"));
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

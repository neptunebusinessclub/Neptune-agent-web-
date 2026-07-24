import type { BrowserAction } from "@neptune/protocol";

type ExecuteActionRequest = {
  type: "EXECUTE_ACTION";
  action: BrowserAction;
  approved: boolean;
};

type ExtensionRequest =
  | ExecuteActionRequest
  | { type: "GET_ACTIVE_TAB" }
  | { type: "STOP_MISSION" };

let stopped = false;

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
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
    return { ok: true, tab: { id: tab.id, url: tab.url, title: tab.title } };
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
      const tab = await getActiveTab();
      if (!tab.id) throw new Error("No active tab");
      await chrome.tabs.update(tab.id, { url });
      await waitForTab(tab.id, 20_000);
      return { ok: true, url };
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
      return executeInActiveTab(action);
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

async function executeInActiveTab(action: BrowserAction): Promise<unknown> {
  const tab = await getActiveTab();
  if (!tab.id) throw new Error("No active tab");
  if (!tab.url || !/^https?:\/\//i.test(tab.url)) {
    throw new Error("The active page cannot be controlled");
  }

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

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-script.js"]
  });
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active browser tab");
  return tab;
}

function validateNavigationUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
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

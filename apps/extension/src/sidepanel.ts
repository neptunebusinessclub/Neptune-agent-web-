import type { BrowserAction, Mission } from "@neptune/protocol";

type StoredConfig = {
  apiUrl: string;
  apiToken: string;
  deviceId: string;
};

type RuntimeResponse = {
  ok: boolean;
  blocked?: boolean;
  error?: string;
  result?: unknown;
  tab?: { id?: number; url?: string; title?: string };
};

const elements = {
  apiUrl: get<HTMLInputElement>("api-url"),
  apiToken: get<HTMLInputElement>("api-token"),
  saveConfig: get<HTMLButtonElement>("save-config"),
  toggleConfig: get<HTMLButtonElement>("toggle-config"),
  configPanel: get<HTMLDivElement>("config-panel"),
  connectionStatus: get<HTMLSpanElement>("connection-status"),
  goal: get<HTMLTextAreaElement>("goal"),
  createMission: get<HTMLButtonElement>("create-mission"),
  stopMission: get<HTMLButtonElement>("stop-mission"),
  runMission: get<HTMLButtonElement>("run-mission"),
  missionStatus: get<HTMLSpanElement>("mission-status"),
  actionList: get<HTMLOListElement>("action-list"),
  approvalCard: get<HTMLElement>("approval-card"),
  approvalSummary: get<HTMLParagraphElement>("approval-summary"),
  approve: get<HTMLButtonElement>("approve"),
  deny: get<HTMLButtonElement>("deny"),
  log: get<HTMLDivElement>("log"),
  clearLog: get<HTMLButtonElement>("clear-log")
};

let config: StoredConfig;
let mission: Mission | null = null;
let approvedActionIds = new Set<string>();
let stopped = false;

void initialize();

async function initialize(): Promise<void> {
  config = await loadConfig();
  elements.apiUrl.value = config.apiUrl;
  elements.apiToken.value = config.apiToken;
  bindEvents();
  await checkConnection();
  addLog("Agent initialisé. Aucune action n’est exécutée sans mission explicite.");
}

function bindEvents(): void {
  elements.toggleConfig.addEventListener("click", () => elements.configPanel.classList.toggle("hidden"));
  elements.saveConfig.addEventListener("click", () => void saveConfig());
  elements.createMission.addEventListener("click", () => void createMission());
  elements.runMission.addEventListener("click", () => void runMission());
  elements.stopMission.addEventListener("click", () => void stopMission());
  elements.approve.addEventListener("click", () => void approveMission(true));
  elements.deny.addEventListener("click", () => void approveMission(false));
  elements.clearLog.addEventListener("click", () => { elements.log.replaceChildren(); });
}

async function loadConfig(): Promise<StoredConfig> {
  const stored = await chrome.storage.local.get(["apiUrl", "apiToken", "deviceId"]);
  const deviceId = typeof stored.deviceId === "string" ? stored.deviceId : crypto.randomUUID();
  if (!stored.deviceId) await chrome.storage.local.set({ deviceId });
  return {
    apiUrl: typeof stored.apiUrl === "string" ? stored.apiUrl : "http://127.0.0.1:8787",
    apiToken: typeof stored.apiToken === "string" ? stored.apiToken : "",
    deviceId
  };
}

async function saveConfig(): Promise<void> {
  const apiUrl = elements.apiUrl.value.trim().replace(/\/$/, "");
  const apiToken = elements.apiToken.value.trim();
  if (!/^https?:\/\//.test(apiUrl)) {
    addLog("L’URL du moteur doit commencer par http:// ou https://.");
    return;
  }
  config = { ...config, apiUrl, apiToken };
  await chrome.storage.local.set({ apiUrl, apiToken });
  addLog("Configuration enregistrée.");
  await checkConnection();
}

async function checkConnection(): Promise<void> {
  try {
    const response = await fetch(`${config.apiUrl}/health`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    elements.connectionStatus.textContent = "Connecté";
    elements.connectionStatus.className = "status status-online";
  } catch {
    elements.connectionStatus.textContent = "Hors ligne";
    elements.connectionStatus.className = "status status-offline";
  }
}

async function createMission(): Promise<void> {
  const goal = elements.goal.value.trim();
  if (goal.length < 3) {
    addLog("Décris une mission avant de continuer.");
    return;
  }
  if (!config.apiToken) {
    elements.configPanel.classList.remove("hidden");
    addLog("Ajoute le jeton API Cloudflare dans la configuration.");
    return;
  }

  setBusy(true);
  try {
    const active = await sendRuntime({ type: "GET_ACTIVE_TAB" });
    const response = await apiFetch("/v1/missions", {
      method: "POST",
      body: JSON.stringify({
        goal,
        deviceId: config.deviceId,
        context: active.tab?.url ? { activeUrl: active.tab.url } : {}
      })
    });
    mission = await parseJson<Mission>(response);
    approvedActionIds.clear();
    stopped = false;
    addLog(`Mission préparée : ${mission.actions.length} action(s).`);
    renderMission();
  } catch (error) {
    addLog(errorMessage(error));
  } finally {
    setBusy(false);
  }
}

async function approveMission(approved: boolean): Promise<void> {
  if (!mission) return;
  const actionIds = mission.actions.filter((action) => action.requiresApproval).map((action) => action.id);
  if (actionIds.length === 0) return;

  try {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const response = await apiFetch(`/v1/missions/${mission.id}/approvals`, {
      method: "POST",
      body: JSON.stringify({ actionIds, approved, expiresAt })
    });
    if (!response.ok) throw new Error(await response.text());

    if (approved) {
      approvedActionIds = new Set(actionIds);
      mission.status = "planned";
      addLog(`Autorisation accordée pour ${actionIds.length} action(s), valable une heure.`);
    } else {
      approvedActionIds.clear();
      mission.status = "cancelled";
      addLog("Mission refusée. Aucune action sensible ne sera exécutée.");
    }
    renderMission();
  } catch (error) {
    addLog(errorMessage(error));
  }
}

async function runMission(): Promise<void> {
  if (!mission || stopped) return;
  setBusy(true);
  elements.stopMission.disabled = false;
  mission.status = "running";
  renderMission();
  await reportEvent("MISSION_STARTED");

  try {
    for (const action of mission.actions) {
      if (stopped) throw new Error("Mission arrêtée par l’utilisateur");
      if (action.status === "completed") continue;

      if (action.type === "ASK_APPROVAL") {
        if (!approvedActionIds.has(action.id)) {
          action.status = "blocked";
          mission.status = "awaiting_approval";
          addLog("Mission suspendue : validation requise.");
          renderMission();
          return;
        }
        action.status = "completed";
        renderMission();
        continue;
      }

      const approved = !action.requiresApproval || approvedActionIds.has(action.id);
      if (!approved) {
        action.status = "blocked";
        mission.status = "awaiting_approval";
        addLog(`Action bloquée : ${action.label}`);
        renderMission();
        return;
      }

      action.status = "running";
      renderMission();
      await reportEvent("ACTION_STARTED", action.id);
      addLog(`Exécution : ${action.label}`);

      const result = await sendRuntime({ type: "EXECUTE_ACTION", action, approved });
      if (!result.ok) throw new Error(result.error ?? "Action échouée");

      action.status = "completed";
      await reportEvent("ACTION_COMPLETED", action.id, { result: result.result ?? null });
      renderMission();
    }

    mission.status = "completed";
    await reportEvent("MISSION_COMPLETED");
    addLog("Mission terminée.");
  } catch (error) {
    const runningAction = mission.actions.find((action) => action.status === "running");
    if (runningAction) {
      runningAction.status = "failed";
      await reportEvent("ACTION_FAILED", runningAction.id, { error: errorMessage(error) });
    }
    mission.status = stopped ? "cancelled" : "failed";
    addLog(errorMessage(error));
  } finally {
    setBusy(false);
    elements.stopMission.disabled = true;
    renderMission();
  }
}

async function stopMission(): Promise<void> {
  stopped = true;
  await sendRuntime({ type: "STOP_MISSION" });
  if (mission && mission.status === "running") mission.status = "cancelled";
  elements.stopMission.disabled = true;
  addLog("Arrêt demandé. L’agent ne lancera pas l’action suivante.");
  renderMission();
}

function renderMission(): void {
  elements.actionList.replaceChildren();
  if (!mission) {
    elements.missionStatus.textContent = "Aucune mission";
    elements.runMission.disabled = true;
    elements.approvalCard.classList.add("hidden");
    return;
  }

  elements.missionStatus.textContent = labelStatus(mission.status);
  mission.actions.forEach((action, index) => {
    const item = document.createElement("li");
    item.className = "action-item";

    const position = document.createElement("span");
    position.className = "action-index";
    position.textContent = String(index + 1);

    const body = document.createElement("div");
    const label = document.createElement("div");
    label.className = "action-label";
    label.textContent = action.label;
    const meta = document.createElement("div");
    meta.className = "action-meta";
    meta.textContent = `${action.type} · ${action.risk}${action.requiresApproval ? " · validation" : ""}`;
    body.append(label, meta);

    const state = document.createElement("span");
    state.className = `action-state ${action.status}`;
    state.textContent = labelStatus(action.status);
    item.append(position, body, state);
    elements.actionList.append(item);
  });

  const sensitive = mission.actions.filter((action) => action.requiresApproval);
  const needsApproval = sensitive.some((action) => !approvedActionIds.has(action.id))
    && mission.status !== "cancelled";
  elements.approvalCard.classList.toggle("hidden", !needsApproval);
  elements.approvalSummary.textContent = `${sensitive.length} action(s) nécessitent une confirmation. Vérifie le plan avant d’autoriser.`;
  elements.runMission.disabled = ["cancelled", "completed", "running"].includes(mission.status) || needsApproval;
}

async function reportEvent(
  type: "MISSION_STARTED" | "ACTION_STARTED" | "ACTION_COMPLETED" | "ACTION_FAILED" | "MISSION_COMPLETED",
  actionId?: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  if (!mission) return;
  try {
    await apiFetch(`/v1/missions/${mission.id}/events`, {
      method: "POST",
      body: JSON.stringify({ type, actionId, payload, occurredAt: new Date().toISOString() })
    });
  } catch (error) {
    addLog(`Journal distant indisponible : ${errorMessage(error)}`);
  }
}

async function apiFetch(path: string, init: RequestInit): Promise<Response> {
  const response = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiToken}`,
      ...(init.headers ?? {})
    }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API ${response.status}: ${body.slice(0, 500)}`);
  }
  return response;
}

async function parseJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

function sendRuntime(message: unknown): Promise<RuntimeResponse> {
  return chrome.runtime.sendMessage(message) as Promise<RuntimeResponse>;
}

function setBusy(busy: boolean): void {
  elements.createMission.disabled = busy;
  if (busy) elements.runMission.disabled = true;
}

function addLog(message: string): void {
  const entry = document.createElement("div");
  entry.className = "log-entry";
  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
  const text = document.createElement("span");
  text.textContent = message;
  entry.append(time, text);
  elements.log.prepend(entry);
}

function labelStatus(status: string): string {
  const labels: Record<string, string> = {
    planned: "Prête",
    running: "En cours",
    awaiting_approval: "À valider",
    completed: "Terminée",
    failed: "Échec",
    cancelled: "Annulée",
    pending: "À faire",
    blocked: "Bloquée"
  };
  return labels[status] ?? status;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Erreur inconnue";
}

function get<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

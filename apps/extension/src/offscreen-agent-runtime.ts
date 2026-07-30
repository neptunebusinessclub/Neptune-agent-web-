import type { BrowserAction } from "@neptune/protocol";
import {
  addHistory,
  canContinueMission,
  createAgentMission,
  installDecision,
  isMissionStalled,
  markActionCompleted,
  markActionFailed,
  markActionStarted,
  recordObservation,
  type AgentMission,
  type AgentObservation
} from "./agent-core";
import { planAgentStep } from "./agent-intelligence";
import type { ProviderConfig, TrustLevel } from "./intelligence";

export {};

type AgentCommand =
  | { target: "neptune-agent-runtime"; type: "AGENT_START"; goal: string }
  | { target: "neptune-agent-runtime"; type: "AGENT_STOP"; reason?: string }
  | { target: "neptune-agent-runtime"; type: "AGENT_APPROVE" }
  | { target: "neptune-agent-runtime"; type: "AGENT_RESUME" }
  | { target: "neptune-agent-runtime"; type: "AGENT_STATUS" };

type RuntimeResponse<T = unknown> = {
  ok: boolean;
  result?: T;
  error?: { code?: string; message?: string; requiresHuman?: boolean; retryable?: boolean };
};

type ManagedConnection = {
  endpoint: string;
  apiKey: string;
  model: string;
};

type Preferences = {
  preferredName?: string;
  trustLevel?: TrustLevel;
};

type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  tone: "normal" | "warning" | "permission";
  createdAt: string;
};

type AuditEntry = { id: string; type: string; detail: string; occurredAt: string };

const STORAGE_MISSION = "neptune.agent.mission.v3";
const STORAGE_MESSAGES = "neptune.messages.v2";
const STORAGE_AUDIT = "neptune.audit.v2";
const STORAGE_PREFERENCES = "neptune.preferences.v2";
const MAX_MESSAGES = 80;
const MAX_AUDIT = 240;

let mission: AgentMission | null = null;
let runPromise: Promise<void> | null = null;
let abortController: AbortController | null = null;

chrome.runtime.onMessage.addListener((message: AgentCommand, _sender, sendResponse) => {
  if (message?.target !== "neptune-agent-runtime") return false;
  void handleCommand(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }));
  return true;
});

void restoreDurableMission();

async function handleCommand(message: AgentCommand): Promise<unknown> {
  switch (message.type) {
    case "AGENT_START":
      return startMission(message.goal);
    case "AGENT_STOP":
      return stopMission(message.reason || "Mission arrêtée par l’utilisateur.");
    case "AGENT_APPROVE":
      return approveMissionAction();
    case "AGENT_RESUME":
      return resumeMission();
    case "AGENT_STATUS":
      return mission ?? await readMission();
  }
}

async function restoreDurableMission(): Promise<void> {
  mission = await readMission();
  if (!mission || !["running", "awaiting_approval", "blocked"].includes(mission.status)) return;

  const current = mission.actions[mission.currentIndex];
  if (current?.status === "running") {
    if (current.risk === "external_write" || current.risk === "sensitive") {
      mission.status = "blocked";
      mission.lastError = "Neptune a été interrompu pendant une action externe. Vérifiez le résultat dans la page, puis cliquez sur Reprendre.";
      mission = addHistory(mission, "human", mission.lastError);
      await appendMessage("assistant", mission.lastError, "warning");
    } else {
      mission.actions = mission.actions.map((action, index) => index === mission!.currentIndex ? { ...action, status: "pending" as const } : action);
      mission.status = "running";
      mission = addHistory(mission, "error", "Reprise automatique après interruption du moteur de mission.");
    }
    await saveMission();
  }

  if (mission.status === "running") startRunner();
}

async function startMission(rawGoal: string): Promise<AgentMission> {
  const goal = rawGoal.replace(/\s+/g, " ").trim().slice(0, 10_000);
  if (!goal) throw new Error("La mission est vide.");
  abortController?.abort();
  mission = createAgentMission(goal);
  mission = addHistory(mission, "decision", "Mission persistante démarrée dans le moteur Neptune.");
  await saveMission();
  await appendAudit("MISSION_STARTED", goal);
  await appendMessage("assistant", "Mission démarrée. Je peux continuer même si le panneau Neptune est fermé.");
  startRunner();
  return mission;
}

async function stopMission(reason: string): Promise<AgentMission | null> {
  abortController?.abort();
  abortController = null;
  if (!mission) mission = await readMission();
  if (!mission) return null;
  mission.status = "stopped";
  mission.lastError = reason;
  mission = addHistory(mission, "human", reason);
  await saveMission();
  await appendAudit("MISSION_STOPPED", reason);
  await appendMessage("assistant", reason, "warning");
  return mission;
}

async function approveMissionAction(): Promise<AgentMission> {
  if (!mission) mission = await readMission();
  if (!mission) throw new Error("Aucune mission n’est en attente.");
  const action = mission.actions[mission.currentIndex];
  if (!action) throw new Error("Aucune action n’attend une autorisation.");
  mission.approvedActionId = action.id;
  mission.status = "running";
  mission.actions = mission.actions.map((candidate, index) => index === mission!.currentIndex ? { ...candidate, status: "pending" as const } : candidate);
  mission = addHistory(mission, "human", `Autorisation accordée : ${action.label}`);
  await saveMission();
  await appendAudit("ACTION_APPROVED", action.label);
  startRunner();
  return mission;
}

async function resumeMission(): Promise<AgentMission> {
  if (!mission) mission = await readMission();
  if (!mission) throw new Error("Aucune mission ne peut être reprise.");
  if (["completed", "stopped", "failed"].includes(mission.status)) throw new Error("Cette mission est déjà terminée.");
  const current = mission.actions[mission.currentIndex];
  if (current?.status === "running") {
    mission.actions = mission.actions.map((candidate, index) => index === mission!.currentIndex ? { ...candidate, status: "pending" as const } : candidate);
  }
  mission.status = "running";
  mission.lastError = undefined;
  mission = addHistory(mission, "human", "Reprise confirmée par l’utilisateur.");
  await saveMission();
  await appendAudit("MISSION_RESUMED", mission.goal);
  startRunner();
  return mission;
}

function startRunner(): void {
  if (runPromise) return;
  runPromise = runMissionLoop()
    .catch((error: unknown) => blockMission(errorMessage(error)))
    .finally(() => {
      runPromise = null;
      abortController = null;
    });
}

async function runMissionLoop(): Promise<void> {
  if (!mission) return;
  abortController = new AbortController();
  const signal = abortController.signal;

  while (mission?.status === "running") {
    if (signal.aborted) return;
    const continuation = canContinueMission(mission);
    if (!continuation.ok) {
      await blockMission(`Je m’arrête avant de tourner en boucle : ${continuation.reason}.`);
      return;
    }

    const observationResult = await observeCurrentPage();
    if (observationResult.error) {
      if (observationResult.error.requiresHuman) {
        await blockMission(observationResult.error.message || "Une intervention humaine est nécessaire.");
        return;
      }
      mission = addHistory(mission, "error", observationResult.error.message || "Erreur d’observation");
      mission.lastError = observationResult.error.message;
    } else if (observationResult.observation) {
      mission = recordObservation(mission, observationResult.observation);
      if (mission.cycle >= 3 && isMissionStalled(mission)) {
        await blockMission("La page ne progresse plus après plusieurs vérifications. Effectuez l’étape bloquante, puis cliquez sur Reprendre.");
        return;
      }
    }
    await saveMission();

    const provider = await getManagedProvider(signal);
    const preferences = await readPreferences();
    const decision = await planAgentStep(provider, preferences.preferredName || "Utilisateur", preferences.trustLevel || "assisted", {
      goal: mission.goal,
      cycle: mission.cycle,
      remainingActions: mission.maxActions - mission.usedActions,
      ...(mission.lastObservation ? { observation: mission.lastObservation } : {}),
      history: mission.history,
      ...(mission.lastError ? { lastError: mission.lastError } : {})
    }, signal);

    if (decision.done) {
      mission = addHistory(mission, "decision", decision.text || "Objectif atteint");
      mission.status = "completed";
      await saveMission();
      await appendAudit("MISSION_COMPLETED", mission.goal);
      await appendMessage("assistant", decision.text || "Mission terminée.");
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
    const batchResult = await executeCurrentBatch(signal);
    if (batchResult !== "continue") return;
    await delay(250, signal);
  }
}

async function executeCurrentBatch(signal: AbortSignal): Promise<"continue" | "paused" | "blocked"> {
  if (!mission) return "blocked";
  for (let index = mission.currentIndex; index < mission.actions.length; index += 1) {
    if (signal.aborted) return "blocked";
    const action = mission.actions[index];
    if (!action) continue;
    mission.currentIndex = index;

    if (action.status === "completed") continue;
    if (needsApproval(action) && mission.approvedActionId !== action.id) {
      action.status = "blocked";
      mission.status = "awaiting_approval";
      mission = addHistory(mission, "human", `Autorisation demandée : ${action.label}`);
      await saveMission();
      await appendMessage("assistant", `L’action « ${action.label} » nécessite votre autorisation.`, "permission");
      return "paused";
    }

    mission = markActionStarted(mission, index);
    await saveMission();
    await appendAudit("ACTION_STARTED", action.label);

    const response = await sendRuntime({
      type: "EXECUTE_ACTION",
      action: { ...action, status: "pending" },
      approved: mission.approvedActionId === action.id || !needsApproval(action)
    });

    if (!response.ok) {
      const message = response.error?.message || "Action échouée";
      mission = markActionFailed(mission, index, message);
      await saveMission();
      await appendAudit("ACTION_FAILED", `${action.label} · ${message}`);
      if (response.error?.requiresHuman || response.error?.retryable === false) {
        await blockMission(message);
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
    await appendAudit("ACTION_COMPLETED", action.label);

    if (["OPEN_URL", "CLICK_ELEMENT", "SEND_MESSAGE", "NAVIGATE_BACK", "SCROLL_PAGE"].includes(action.type)) {
      mission.currentIndex = mission.actions.length;
      await saveMission();
      return "continue";
    }
  }
  return "continue";
}

async function observeCurrentPage(): Promise<{ observation?: AgentObservation; error?: RuntimeResponse["error"] }> {
  const status = await sendRuntime<{ tab?: { url?: string } }>({ type: "GET_WORK_TAB" });
  if (!status.ok) return { ...(status.error ? { error: status.error } : {}) };
  const url = status.result?.tab?.url;
  if (!url || !/^https?:\/\//i.test(url)) return {};
  const action: BrowserAction = {
    id: crypto.randomUUID(),
    type: "READ_PAGE",
    label: "Observer l’état actuel de la page",
    risk: "read_only",
    requiresApproval: false,
    status: "pending"
  };
  const response = await sendRuntime<AgentObservation>({ type: "EXECUTE_ACTION", action, approved: true });
  if (!response.ok) return { ...(response.error ? { error: response.error } : {}) };
  return response.result ? { observation: response.result } : {};
}

async function getManagedProvider(signal: AbortSignal): Promise<ProviderConfig> {
  const response = await sendRuntime<ManagedConnection>({ type: "GET_MANAGED_HERMES" });
  if (!response.ok || !response.result) throw new Error(response.error?.message || "Le moteur Neptune n’est pas disponible.");
  if (signal.aborted) throw new DOMException("Mission interrompue.", "AbortError");
  return { id: "hermes", endpoint: response.result.endpoint, apiKey: response.result.apiKey, model: response.result.model };
}

async function blockMission(message: string): Promise<void> {
  if (!mission) return;
  mission.status = "blocked";
  mission.lastError = message;
  mission = addHistory(mission, "human", message);
  await saveMission();
  await appendAudit("MISSION_BLOCKED", message);
  await appendMessage("assistant", message, "warning");
}

async function readMission(): Promise<AgentMission | null> {
  const stored = await chrome.storage.local.get(STORAGE_MISSION);
  const value = stored[STORAGE_MISSION];
  return isMission(value) ? value : null;
}

async function saveMission(): Promise<void> {
  if (!mission) return;
  mission.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ [STORAGE_MISSION]: mission });
  await chrome.runtime.sendMessage({ target: "neptune-sidepanel", type: "AGENT_STATE_CHANGED", mission }).catch(() => undefined);
}

async function readPreferences(): Promise<Preferences> {
  const stored = await chrome.storage.local.get(STORAGE_PREFERENCES);
  const value = stored[STORAGE_PREFERENCES];
  return value && typeof value === "object" ? value as Preferences : {};
}

async function appendMessage(role: ConversationMessage["role"], text: string, tone: ConversationMessage["tone"] = "normal"): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_MESSAGES);
  const current = Array.isArray(stored[STORAGE_MESSAGES]) ? stored[STORAGE_MESSAGES] as ConversationMessage[] : [];
  const messages = [...current, { id: crypto.randomUUID(), role, text: text.slice(0, 12_000), tone, createdAt: new Date().toISOString() }].slice(-MAX_MESSAGES);
  await chrome.storage.local.set({ [STORAGE_MESSAGES]: messages });
}

async function appendAudit(type: string, detail: string): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_AUDIT);
  const current = Array.isArray(stored[STORAGE_AUDIT]) ? stored[STORAGE_AUDIT] as AuditEntry[] : [];
  const audit = [...current, { id: crypto.randomUUID(), type, detail: detail.slice(0, 1_000), occurredAt: new Date().toISOString() }].slice(-MAX_AUDIT);
  await chrome.storage.local.set({ [STORAGE_AUDIT]: audit });
}

async function sendRuntime<T = unknown>(request: Record<string, unknown>): Promise<RuntimeResponse<T>> {
  try {
    const response = await chrome.runtime.sendMessage(request) as RuntimeResponse<T> | undefined;
    return response ?? { ok: false, error: { message: "Le service navigateur Neptune n’a pas répondu.", retryable: true } };
  } catch (error) {
    return { ok: false, error: { message: errorMessage(error), retryable: true } };
  }
}

function needsApproval(action: BrowserAction): boolean {
  return action.requiresApproval || action.risk === "external_write" || action.risk === "sensitive";
}

function isMission(value: unknown): value is AgentMission {
  if (!value || typeof value !== "object") return false;
  const source = value as Partial<AgentMission>;
  return typeof source.id === "string" && typeof source.goal === "string" && typeof source.status === "string" && Array.isArray(source.actions);
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "Mission interrompue.";
  return error instanceof Error ? error.message : String(error || "Erreur Neptune inconnue");
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Mission interrompue.", "AbortError"));
      return;
    }
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException("Mission interrompue.", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

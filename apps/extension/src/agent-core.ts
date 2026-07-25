import type { BrowserAction } from "@neptune/protocol";

export const MAX_AGENT_CYCLES = 16;
export const MAX_AGENT_ACTIONS = 48;
export const MAX_REPEATED_OBSERVATIONS = 3;

export type AgentObservation = {
  title?: string;
  url?: string;
  text?: string;
  language?: string | null;
  links?: unknown[];
  controls?: unknown[];
  headings?: unknown[];
  forms?: unknown[];
  scroll?: unknown;
  guardDetected?: boolean;
};

export type AgentHistoryEntry = {
  cycle: number;
  type: "observation" | "decision" | "action" | "error" | "human";
  summary: string;
  occurredAt: string;
};

export type AgentMission = {
  id: string;
  goal: string;
  status: "running" | "awaiting_approval" | "blocked" | "completed" | "stopped" | "failed";
  cycle: number;
  maxCycles: number;
  usedActions: number;
  maxActions: number;
  actions: BrowserAction[];
  currentIndex: number;
  approvedActionId?: string | undefined;
  results: Array<{ actionId: string; result: unknown }>;
  history: AgentHistoryEntry[];
  fingerprints: string[];
  lastObservation?: AgentObservation | undefined;
  lastError?: string | undefined;
  createdAt: string;
  updatedAt: string;
};

export function createAgentMission(goal: string): AgentMission {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    goal,
    status: "running",
    cycle: 0,
    maxCycles: MAX_AGENT_CYCLES,
    usedActions: 0,
    maxActions: MAX_AGENT_ACTIONS,
    actions: [],
    currentIndex: 0,
    results: [],
    history: [],
    fingerprints: [],
    createdAt: now,
    updatedAt: now
  };
}

export function cloneAgentMission(value: AgentMission): AgentMission {
  return {
    ...value,
    actions: value.actions.map((action) => ({ ...action, ...(action.target ? { target: { ...action.target } } : {}) })),
    results: [...value.results],
    history: [...value.history],
    fingerprints: [...value.fingerprints],
    ...(value.lastObservation ? { lastObservation: structuredClone(value.lastObservation) } : {})
  };
}

export function addHistory(
  mission: AgentMission,
  type: AgentHistoryEntry["type"],
  summary: string
): AgentMission {
  return touch({
    ...mission,
    history: [...mission.history, {
      cycle: mission.cycle,
      type,
      summary: summary.slice(0, 1_200),
      occurredAt: new Date().toISOString()
    }].slice(-80)
  });
}

export function recordObservation(mission: AgentMission, observation: AgentObservation): AgentMission {
  const fingerprint = fingerprintObservation(observation);
  const observed = addHistory({
    ...mission,
    lastObservation: observation,
    fingerprints: [...mission.fingerprints, fingerprint].slice(-8)
  }, "observation", `${observation.title ?? "Page"} · ${observation.url ?? "URL inconnue"}`);
  return touch(observed);
}

export function fingerprintObservation(observation?: AgentObservation): string {
  if (!observation) return "no-observation";
  const source = [
    observation.url ?? "",
    observation.title ?? "",
    (observation.text ?? "").replace(/\s+/g, " ").trim().slice(0, 2_000),
    JSON.stringify(observation.controls ?? []).slice(0, 1_500),
    JSON.stringify(observation.scroll ?? {}).slice(0, 400)
  ].join("|");
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function isMissionStalled(mission: AgentMission): boolean {
  if (mission.fingerprints.length < MAX_REPEATED_OBSERVATIONS) return false;
  const recent = mission.fingerprints.slice(-MAX_REPEATED_OBSERVATIONS);
  return recent.every((value) => value === recent[0]);
}

export function canContinueMission(mission: AgentMission): { ok: boolean; reason?: string } {
  if (mission.status === "stopped" || mission.status === "completed") return { ok: false, reason: "Mission déjà terminée" };
  if (mission.cycle >= mission.maxCycles) return { ok: false, reason: "Nombre maximal de cycles atteint" };
  if (mission.usedActions >= mission.maxActions) return { ok: false, reason: "Budget maximal d’actions atteint" };
  return { ok: true };
}

export function installDecision(mission: AgentMission, actions: BrowserAction[], explanation: string): AgentMission {
  const remaining = Math.max(0, mission.maxActions - mission.usedActions);
  const batch = actions.slice(0, Math.min(5, remaining)).map((action) => ({ ...action, status: "pending" as const }));
  return addHistory({
    ...mission,
    cycle: mission.cycle + 1,
    actions: batch,
    currentIndex: 0,
    approvedActionId: undefined,
    lastError: undefined,
    status: "running"
  }, "decision", explanation || `${batch.length} action(s) préparée(s)`);
}

export function markActionStarted(mission: AgentMission, index: number): AgentMission {
  const actions = mission.actions.map((action, actionIndex) => actionIndex === index ? { ...action, status: "running" as const } : action);
  const label = actions[index]?.label ?? "Action";
  return addHistory({ ...mission, actions, currentIndex: index }, "action", `Début : ${label}`);
}

export function markActionCompleted(mission: AgentMission, index: number, result: unknown): AgentMission {
  const current = mission.actions[index];
  const actions = mission.actions.map((action, actionIndex) => actionIndex === index ? { ...action, status: "completed" as const } : action);
  return addHistory({
    ...mission,
    actions,
    currentIndex: index + 1,
    usedActions: mission.usedActions + 1,
    approvedActionId: mission.approvedActionId === current?.id ? undefined : mission.approvedActionId,
    results: current ? [...mission.results, { actionId: current.id, result }].slice(-40) : mission.results
  }, "action", `Terminé : ${current?.label ?? "Action"}`);
}

export function markActionFailed(mission: AgentMission, index: number, message: string): AgentMission {
  const current = mission.actions[index];
  const actions = mission.actions.map((action, actionIndex) => actionIndex === index ? { ...action, status: "failed" as const } : action);
  return addHistory({
    ...mission,
    actions,
    currentIndex: index,
    usedActions: mission.usedActions + 1,
    lastError: message
  }, "error", `${current?.label ?? "Action"} : ${message}`);
}

export function missionProgress(mission: AgentMission): number {
  const cycleShare = Math.min(1, mission.cycle / mission.maxCycles);
  const actionShare = Math.min(1, mission.usedActions / mission.maxActions);
  return Math.round(Math.max(cycleShare, actionShare) * 100);
}

function touch<T extends AgentMission>(mission: T): T {
  return { ...mission, updatedAt: new Date().toISOString() };
}

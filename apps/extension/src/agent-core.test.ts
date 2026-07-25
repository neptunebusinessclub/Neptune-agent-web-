import { describe, expect, it } from "vitest";
import {
  canContinueMission,
  createAgentMission,
  fingerprintObservation,
  installDecision,
  isMissionStalled,
  markActionCompleted,
  recordObservation
} from "./agent-core";

const readAction = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  type: "READ_PAGE" as const,
  label: "Lire la page",
  risk: "read_only" as const,
  requiresApproval: false,
  status: "pending" as const
};

describe("Neptune agent core", () => {
  it("creates a bounded mission", () => {
    const mission = createAgentMission("Ouvre un site et lis la page");
    expect(mission.maxCycles).toBe(16);
    expect(mission.maxActions).toBe(48);
    expect(canContinueMission(mission).ok).toBe(true);
  });

  it("limits each decision to five actions", () => {
    const mission = createAgentMission("Test");
    const next = installDecision(mission, Array.from({ length: 9 }, (_, index) => ({
      ...readAction,
      id: `123e4567-e89b-12d3-a456-4266141740${String(index).padStart(2, "0")}`
    })), "Plan");
    expect(next.actions).toHaveLength(5);
    expect(next.cycle).toBe(1);
  });

  it("detects repeated page observations", () => {
    let mission = createAgentMission("Test");
    const observation = { url: "https://example.com", title: "Example", text: "Même page" };
    mission = recordObservation(mission, observation);
    mission = recordObservation(mission, observation);
    mission = recordObservation(mission, observation);
    expect(isMissionStalled(mission)).toBe(true);
    expect(fingerprintObservation(observation)).toHaveLength(8);
  });

  it("tracks action budget and result", () => {
    let mission = installDecision(createAgentMission("Test"), [readAction], "Lire");
    mission = markActionCompleted(mission, 0, { title: "Page" });
    expect(mission.usedActions).toBe(1);
    expect(mission.results).toHaveLength(1);
  });
});

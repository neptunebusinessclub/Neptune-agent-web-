import { describe, expect, it } from "vitest";
import { buildAgentPrompt } from "./agent-intelligence";

describe("Neptune agent decision prompt", () => {
  it("requires short observe-act cycles", () => {
    const prompt = buildAgentPrompt("Johan", "assisted", {
      goal: "Cherche un bureau à Toulouse",
      cycle: 2,
      remainingActions: 40,
      observation: {
        title: "Résultats",
        url: "https://example.com/search",
        text: "Bureaux à louer"
      },
      history: [],
      lastError: "Target not found"
    });
    expect(prompt).toContain("PROCHAINE petite étape");
    expect(prompt).toContain("au maximum 5 actions");
    expect(prompt).toContain("Target not found");
    expect(prompt).toContain("WAIT_FOR_ELEMENT");
  });
});

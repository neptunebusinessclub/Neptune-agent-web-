import { describe, expect, it } from "vitest";
import { extractJson, isForbiddenGoal, normalizePlan } from "./intelligence";

describe("Neptune intelligence safety", () => {
  it("extracts JSON from a fenced response", () => {
    expect(extractJson("```json\n{\"text\":\"ok\",\"actions\":[]}\n```"))
      .toEqual({ text: "ok", actions: [] });
  });

  it("forces approval for SEND_MESSAGE", () => {
    const result = normalizePlan({
      text: "Préparation",
      actions: [{
        type: "SEND_MESSAGE",
        label: "Envoyer le message",
        risk: "read_only",
        requiresApproval: false,
        target: { role: "textbox", name: "Message" },
        value: "Bonjour"
      }]
    });
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.risk).toBe("external_write");
    expect(result.actions[0]?.requiresApproval).toBe(true);
  });

  it("drops unsupported or malformed actions", () => {
    const result = normalizePlan({
      text: "Plan",
      actions: [
        { type: "PAY", label: "Payer" },
        { type: "CLICK_ELEMENT", label: "Cliquer sans cible" },
        { type: "OPEN_URL", label: "Protocole interdit", url: "javascript:alert(1)" }
      ]
    });
    expect(result.actions).toEqual([]);
  });

  it("recognizes sensitive goals", () => {
    expect(isForbiddenGoal("achète ce produit avec ma carte bancaire")).toBe(true);
    expect(isForbiddenGoal("ouvre Le Bon Coin et lis la page")).toBe(false);
  });
});

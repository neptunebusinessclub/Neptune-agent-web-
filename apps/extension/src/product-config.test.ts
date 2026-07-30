import { describe, expect, it } from "vitest";
import {
  BALANCED_LOCAL_MODEL_ID,
  PRODUCT_VOICES,
  inferWorkspaceMode,
  voiceForGender
} from "./product-config";

describe("Neptune product defaults", () => {
  it("expose exactement une voix féminine et une voix masculine premium", () => {
    expect(Object.keys(PRODUCT_VOICES)).toEqual(["female", "male"]);
    expect(voiceForGender("female").id).toBe("fr_FR-siwis-medium");
    expect(voiceForGender("male").id).toBe("fr_FR-upmc-medium");
  });

  it("utilise le modèle local équilibré par défaut", () => {
    expect(BALANCED_LOCAL_MODEL_ID).toBe("Qwen2.5-1.5B-Instruct-q4f16_1-MLC");
  });
});

describe("adaptive workspace recommendation", () => {
  it("recommande la page actuelle lorsqu’elle est explicitement désignée", () => {
    expect(inferWorkspaceMode("Prends le relais sur cette page", "https://example.com").recommended).toBe("current-tab");
  });

  it("respecte une demande explicite de nouvelle fenêtre", () => {
    const result = inferWorkspaceMode("Ouvre cela dans une nouvelle fenêtre", "https://example.com");
    expect(result.recommended).toBe("new-window");
    expect(result.explicit).toBe(true);
  });

  it("utilise un nouvel onglet par défaut pour protéger la navigation", () => {
    expect(inferWorkspaceMode("Recherche un hôtel à Toulouse", "https://example.com").recommended).toBe("new-tab");
  });
});

import { describe, expect, it } from "vitest";
import {
  getLocalModelCatalog,
  recommendModelId,
  type LocalModelCard
} from "./local-model-runtime";

describe("Neptune local model hub", () => {
  it("exposes a deduplicated friendly catalog", () => {
    const catalog = getLocalModelCatalog();
    expect(catalog.length).toBeGreaterThan(0);
    expect(new Set(catalog.map((model) => model.id)).size).toBe(catalog.length);
    expect(catalog.some((model) => model.recommended)).toBe(true);
    expect(catalog.every((model) => model.name.startsWith("Neptune"))).toBe(true);
  });

  it("recommends the fast tier in the neutral test environment", () => {
    const catalog: LocalModelCard[] = [
      card("light", "light-model"),
      card("fast", "fast-model"),
      card("balanced", "balanced-model")
    ];
    expect(recommendModelId(catalog)).toBe("fast-model");
  });
});

function card(tier: LocalModelCard["tier"], id: string): LocalModelCard {
  return {
    id,
    name: `Neptune ${tier}`,
    description: tier,
    badge: tier,
    memoryGb: null,
    tier,
    recommended: false
  };
}

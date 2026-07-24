import { describe, expect, it } from "vitest";
import { browserActionSchema, isWriteAction } from "./index";

const base = {
  id: "2f34cd4c-92fa-4c0b-92e3-acde81f65b73",
  label: "Test action",
  status: "pending" as const
};

describe("browserActionSchema", () => {
  it("rejects a message send without explicit approval", () => {
    const result = browserActionSchema.safeParse({
      ...base,
      type: "SEND_MESSAGE",
      risk: "external_write",
      requiresApproval: false,
      target: { role: "textbox", name: "Message" },
      value: "Bonjour"
    });
    expect(result.success).toBe(false);
  });

  it("accepts a read-only navigation", () => {
    const result = browserActionSchema.safeParse({
      ...base,
      type: "OPEN_URL",
      risk: "read_only",
      requiresApproval: false,
      url: "https://www.leboncoin.fr/"
    });
    expect(result.success).toBe(true);
  });

  it("classifies external writes as write actions", () => {
    const parsed = browserActionSchema.parse({
      ...base,
      type: "SEND_MESSAGE",
      risk: "external_write",
      requiresApproval: true,
      target: { role: "textbox", name: "Message" },
      value: "Bonjour"
    });
    expect(isWriteAction(parsed)).toBe(true);
  });
});

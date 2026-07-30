import { beforeAll, describe, expect, it, vi } from "vitest";

const storageGet = vi.fn(async () => ({}));
const storageSet = vi.fn(async () => undefined);

beforeAll(() => {
  vi.stubGlobal("speechSynthesis", {
    speak: vi.fn(),
    cancel: vi.fn()
  });
  vi.stubGlobal("window", {
    dispatchEvent: vi.fn()
  });
  vi.stubGlobal("chrome", {
    storage: {
      local: { get: storageGet, set: storageSet },
      onChanged: { addListener: vi.fn() }
    },
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` }
  });
});

describe("Neptune embedded French voices", () => {
  it("exposes exactly one female and one male product voice", async () => {
    const { NEPTUNE_LOCAL_VOICES } = await import("./local-voice-runtime");
    expect(NEPTUNE_LOCAL_VOICES).toHaveLength(2);
    expect(NEPTUNE_LOCAL_VOICES.map((voice) => voice.id)).toEqual([
      "fr_FR-siwis-medium",
      "fr_FR-tom-medium"
    ]);
    expect(NEPTUNE_LOCAL_VOICES.map((voice) => voice.name)).toEqual([
      "Féminine",
      "Masculine"
    ]);
    expect(new Set(NEPTUNE_LOCAL_VOICES.map((voice) => voice.id)).size).toBe(2);
    expect(NEPTUNE_LOCAL_VOICES.every((voice) => voice.id.startsWith("fr_FR-"))).toBe(true);
    expect(NEPTUNE_LOCAL_VOICES.filter((voice) => voice.recommended)).toHaveLength(1);
  });

  it("round-trips local voice URIs", async () => {
    const { fromLocalVoiceUri, isLocalVoiceUri, toLocalVoiceUri } = await import("./local-voice-runtime");
    const uri = toLocalVoiceUri("fr_FR-siwis-medium");
    expect(isLocalVoiceUri(uri)).toBe(true);
    expect(fromLocalVoiceUri(uri)).toBe("fr_FR-siwis-medium");
    expect(fromLocalVoiceUri("system-voice")).toBeNull();
  });
});

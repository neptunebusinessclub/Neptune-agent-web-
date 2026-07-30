import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  callHermesAgent,
  normalizeHermesEndpoint,
  testHermesConnection
} from "./hermes-client";

const storage = new Map<string, unknown>();

beforeEach(() => {
  storage.clear();
  vi.restoreAllMocks();
  vi.stubGlobal("chrome", {
    runtime: { getURL: () => "chrome-extension://neptune-test/" },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) storage.set(key, value);
        }),
        remove: vi.fn(async (key: string) => { storage.delete(key); })
      }
    }
  });
});

describe("Hermes endpoint security", () => {
  it("normalizes localhost and removes a trailing /v1", () => {
    expect(normalizeHermesEndpoint("http://127.0.0.1:8642/v1/"))
      .toBe("http://127.0.0.1:8642");
  });

  it("refuses clear-text remote Hermes servers", () => {
    expect(() => normalizeHermesEndpoint("http://example.com:8642"))
      .toThrow("HTTPS");
  });
});

describe("Hermes capability detection", () => {
  it("detects the agent, advertised model and installed skills", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: "ok", platform: "hermes-agent", version: "0.9.0" }))
      .mockResolvedValueOnce(jsonResponse({
        platform: "hermes-agent",
        model: "hermes-agent",
        auth: { required: true },
        runtime: { tool_execution: "server" },
        features: {
          chat_completions: true,
          run_submission: true,
          run_stop: true,
          session_continuity_header: "X-Hermes-Session-Id",
          skills_api: true
        }
      }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "neptune-hermes" }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ name: "research" }, { name: "memory" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const connection = await testHermesConnection({
      endpoint: "http://127.0.0.1:8642/v1",
      apiKey: "a-secure-hermes-key",
      model: "neptune-hermes"
    });

    expect(connection.endpoint).toBe("http://127.0.0.1:8642");
    expect(connection.model).toBe("neptune-hermes");
    expect(connection.version).toBe("0.9.0");
    expect(connection.skillsCount).toBe(2);
    expect(connection.capabilities.serverToolExecution).toBe(true);
  });
});

describe("Hermes conversation bridge", () => {
  it("sends stable Hermes session headers and returns a JSON-compatible answer", async () => {
    let requestHeaders: Headers | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requestHeaders = new Headers(init?.headers);
      return jsonResponse({
        choices: [{ message: { content: "Hermes est connecté à Neptune." } }]
      }, { "X-Hermes-Session-Id": "hermes-session-confirmed" });
    }));

    const answer = await callHermesAgent(
      { endpoint: "http://localhost:8642", apiKey: "a-secure-hermes-key", model: "hermes-agent" },
      "Johan",
      [{ role: "user", content: "Teste la connexion." }],
      "Tu es Neptune."
    );

    expect(answer).toBe("Hermes est connecté à Neptune.");
    expect(requestHeaders?.get("Authorization")).toBe("Bearer a-secure-hermes-key");
    expect(requestHeaders?.get("X-Hermes-Session-Id")).toMatch(/^neptune-/);
    expect(requestHeaders?.get("X-Hermes-Session-Key")).toMatch(/^neptune-user-/);
    expect(storage.get("neptune.hermes.identity.v1")).toMatchObject({ sessionId: "hermes-session-confirmed" });
  });

  it("combines Hermes SSE deltas and accepts tool progress events", async () => {
    const progress = vi.fn();
    vi.stubGlobal("window", { dispatchEvent: progress });
    vi.stubGlobal("CustomEvent", class {
      type: string;
      detail: unknown;
      constructor(type: string, options?: { detail?: unknown }) {
        this.type = type;
        this.detail = options?.detail;
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      `event: hermes.tool.progress\ndata: ${JSON.stringify({ tool_name: "web_search", status: "running", preview: "Recherche Neptune" })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hermes " }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "répond." }, finish_reason: null }] })}\n\n`,
      "data: [DONE]\n\n"
    ])));

    const answer = await callHermesAgent(
      { endpoint: "http://localhost:8642", apiKey: "a-secure-hermes-key", model: "hermes-agent" },
      "Johan",
      [{ role: "user", content: "Recherche une information." }],
      "Tu es Neptune."
    );

    expect(answer).toBe("Hermes répond.");
    expect(progress).toHaveBeenCalled();
  });

  it("turns an aborted Hermes stream into an AbortError", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; },
      cancel() { streamController = undefined; }
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    })));
    const controller = new AbortController();
    const request = callHermesAgent(
      { endpoint: "http://localhost:8642", apiKey: "a-secure-hermes-key", model: "hermes-agent" },
      "Johan",
      [{ role: "user", content: "Lance une tâche longue." }],
      "Tu es Neptune.",
      controller.signal
    );
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
});

function jsonResponse(body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) }
  });
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    }
  }), {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "X-Hermes-Session-Id": "stream-session"
    }
  });
}

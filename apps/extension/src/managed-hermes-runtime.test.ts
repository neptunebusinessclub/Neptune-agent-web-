import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearManagedHermesSession,
  closeManagedHermesSupervisor,
  ensureManagedHermes,
  getManagedHermesStatus
} from "./managed-hermes-runtime";

type Listener<T> = (value: T) => void;

function event<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    addListener(listener: Listener<T>) { listeners.add(listener); },
    removeListener(listener: Listener<T>) { listeners.delete(listener); },
    emit(value: T) { for (const listener of listeners) listener(value); }
  };
}

const session = new Map<string, unknown>();

beforeEach(() => {
  closeManagedHermesSupervisor();
  session.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  vi.stubGlobal("CustomEvent", class {
    constructor(public type: string, public options?: { detail?: unknown }) {}
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })));
});

describe("managed Neptune native bridge", () => {
  it("returns a health-checked loopback connection without user configuration", async () => {
    const onMessage = event<Record<string, unknown>>();
    const onDisconnect = event<void>();
    const postMessage = vi.fn((request: { requestId: string }) => {
      queueMicrotask(() => {
        onMessage.emit({
          requestId: request.requestId,
          kind: "progress",
          phase: "starting-hermes",
          progress: 72,
          detail: "Démarrage du moteur local…"
        });
        onMessage.emit({
          requestId: request.requestId,
          kind: "ready",
          endpoint: "http://127.0.0.1:8642",
          apiKey: "abcdefghijklmnopqrstuvwxyz0123456789",
          model: "Qwen3-4B-Q4_K_M",
          runtimeVersion: "2.0.0"
        });
      });
    });
    vi.stubGlobal("chrome", createChromeStub(onMessage, onDisconnect, postMessage));

    const progress = vi.fn();
    const connection = await ensureManagedHermes(progress);
    expect(connection).toMatchObject({
      endpoint: "http://127.0.0.1:8642",
      model: "Qwen3-4B-Q4_K_M",
      managed: true
    });
    expect(connection.verifiedAt).toEqual(expect.any(Number));
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ progress: 72 }));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "ensure" }));
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:8642/health", expect.objectContaining({ cache: "no-store" }));
    await clearManagedHermesSession();
  });

  it("invalidates a stale cached connection and asks the native supervisor to restart it", async () => {
    session.set("neptune.managedHermes.connection.v2", {
      endpoint: "http://127.0.0.1:8642",
      apiKey: "abcdefghijklmnopqrstuvwxyz0123456789",
      model: "Qwen3-4B-Q4_K_M",
      managed: true,
      verifiedAt: Date.now() - 60_000
    });
    const health = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    vi.stubGlobal("fetch", health);

    const onMessage = event<Record<string, unknown>>();
    const onDisconnect = event<void>();
    const postMessage = vi.fn((request: { requestId: string }) => {
      queueMicrotask(() => onMessage.emit({
        requestId: request.requestId,
        kind: "ready",
        endpoint: "http://127.0.0.1:8642",
        apiKey: "abcdefghijklmnopqrstuvwxyz0123456789",
        model: "Qwen3-4B-Q4_K_M",
        runtimeVersion: "2.0.0"
      }));
    });
    vi.stubGlobal("chrome", createChromeStub(onMessage, onDisconnect, postMessage));

    const connection = await ensureManagedHermes();
    expect(connection.verifiedAt).toEqual(expect.any(Number));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "ensure" }));
    expect(health).toHaveBeenCalledTimes(2);
  });

  it("reports ready only after a real health response", async () => {
    session.set("neptune.managedHermes.connection.v2", {
      endpoint: "http://127.0.0.1:8642",
      apiKey: "abcdefghijklmnopqrstuvwxyz0123456789",
      model: "Qwen3-4B-Q4_K_M",
      managed: true,
      verifiedAt: Date.now()
    });
    const onMessage = event<Record<string, unknown>>();
    const onDisconnect = event<void>();
    vi.stubGlobal("chrome", createChromeStub(onMessage, onDisconnect, vi.fn()));
    await expect(getManagedHermesStatus()).resolves.toMatchObject({ ready: true, code: "READY" });
  });

  it("rejects a native host response that exposes a remote endpoint", async () => {
    const onMessage = event<Record<string, unknown>>();
    const onDisconnect = event<void>();
    vi.stubGlobal("chrome", createChromeStub(onMessage, onDisconnect, (request: { requestId: string }) => {
      queueMicrotask(() => onMessage.emit({
        requestId: request.requestId,
        kind: "ready",
        endpoint: "https://example.com",
        apiKey: "abcdefghijklmnopqrstuvwxyz0123456789",
        model: "Qwen3-4B-Q4_K_M"
      }));
    }));

    await expect(ensureManagedHermes()).rejects.toThrow("connexion locale valide");
  });
});

function createChromeStub(
  onMessage: ReturnType<typeof event<Record<string, unknown>>>,
  onDisconnect: ReturnType<typeof event<void>>,
  postMessage: (request: { requestId: string; type?: string }) => void
) {
  return {
    runtime: {
      connectNative: vi.fn(() => ({ onMessage, onDisconnect, postMessage, disconnect: vi.fn() })),
      getManifest: () => ({ version: "2.0.0" }),
      lastError: undefined
    },
    storage: {
      session: {
        get: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.map((key) => [key, session.get(key)]));
        }),
        set: vi.fn(async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) session.set(key, value);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) session.delete(key);
        })
      }
    }
  };
}

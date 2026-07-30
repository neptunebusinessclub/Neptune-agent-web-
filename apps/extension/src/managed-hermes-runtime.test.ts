import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearManagedHermesSession, ensureManagedHermes } from "./managed-hermes-runtime";

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
  session.clear();
  vi.restoreAllMocks();
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  vi.stubGlobal("CustomEvent", class {
    constructor(public type: string, public options?: { detail?: unknown }) {}
  });
});

describe("managed Hermes native bridge", () => {
  it("returns a validated loopback connection without user configuration", async () => {
    const onMessage = event<Record<string, unknown>>();
    const onDisconnect = event<void>();
    const postMessage = vi.fn((request: { requestId: string }) => {
      queueMicrotask(() => {
        onMessage.emit({
          requestId: request.requestId,
          kind: "progress",
          phase: "starting-hermes",
          progress: 72,
          detail: "Démarrage de la mémoire Hermes…"
        });
        onMessage.emit({
          requestId: request.requestId,
          kind: "ready",
          endpoint: "http://127.0.0.1:8642",
          apiKey: "abcdefghijklmnopqrstuvwxyz0123456789",
          model: "Qwen3-4B-Q4_K_M",
          runtimeVersion: "1.8.0"
        });
      });
    });
    vi.stubGlobal("chrome", {
      runtime: {
        connectNative: vi.fn(() => ({ onMessage, onDisconnect, postMessage, disconnect: vi.fn() })),
        getManifest: () => ({ version: "1.8.0" }),
        lastError: undefined
      },
      storage: {
        session: {
          get: vi.fn(async (key: string) => ({ [key]: session.get(key) })),
          set: vi.fn(async (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) session.set(key, value); }),
          remove: vi.fn(async (key: string) => { session.delete(key); })
        }
      }
    });

    const progress = vi.fn();
    const connection = await ensureManagedHermes(progress);
    expect(connection).toMatchObject({
      endpoint: "http://127.0.0.1:8642",
      model: "Qwen3-4B-Q4_K_M",
      managed: true
    });
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ progress: 72 }));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "ensure" }));
    await clearManagedHermesSession();
  });

  it("rejects a native host response that exposes a remote endpoint", async () => {
    const onMessage = event<Record<string, unknown>>();
    const onDisconnect = event<void>();
    vi.stubGlobal("chrome", {
      runtime: {
        connectNative: vi.fn(() => ({
          onMessage,
          onDisconnect,
          disconnect: vi.fn(),
          postMessage(request: { requestId: string }) {
            queueMicrotask(() => onMessage.emit({
              requestId: request.requestId,
              kind: "ready",
              endpoint: "https://example.com",
              apiKey: "abcdefghijklmnopqrstuvwxyz0123456789",
              model: "Qwen3-4B-Q4_K_M"
            }));
          }
        })),
        getManifest: () => ({ version: "1.8.0" }),
        lastError: undefined
      },
      storage: {
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(),
          remove: vi.fn()
        }
      }
    });

    await expect(ensureManagedHermes()).rejects.toThrow("connexion locale valide");
  });
});

export type ManagedHermesPhase =
  | "detecting"
  | "installing"
  | "model"
  | "starting-model"
  | "starting-hermes"
  | "verifying"
  | "ready"
  | "repairing";

export type ManagedHermesConnection = {
  endpoint: string;
  apiKey: string;
  model: string;
  runtimeVersion?: string;
  managed: true;
};

export type ManagedHermesProgress = {
  phase: ManagedHermesPhase;
  progress: number;
  detail: string;
};

type NativeMessage = {
  requestId?: string;
  kind?: "progress" | "ready" | "error" | "status";
  phase?: ManagedHermesPhase;
  progress?: number;
  detail?: string;
  code?: string;
  endpoint?: string;
  apiKey?: string;
  model?: string;
  runtimeVersion?: string;
};

const HOST_NAME = "com.neptune.hermes";
const SESSION_CONNECTION_KEY = "neptune.managedHermes.connection.v1";
let inFlight: Promise<ManagedHermesConnection> | null = null;

export async function ensureManagedHermes(
  onProgress: (progress: ManagedHermesProgress) => void = () => undefined,
  signal?: AbortSignal
): Promise<ManagedHermesConnection> {
  const cached = await readCachedConnection();
  if (cached) return cached;
  if (inFlight) return inFlight;
  inFlight = requestManagedHermes("ensure", onProgress, signal)
    .then(async (connection) => {
      await chrome.storage.session.set({ [SESSION_CONNECTION_KEY]: connection });
      return connection;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

export async function repairManagedHermes(
  onProgress: (progress: ManagedHermesProgress) => void = () => undefined,
  signal?: AbortSignal
): Promise<ManagedHermesConnection> {
  await chrome.storage.session.remove(SESSION_CONNECTION_KEY);
  return requestManagedHermes("repair", onProgress, signal).then(async (connection) => {
    await chrome.storage.session.set({ [SESSION_CONNECTION_KEY]: connection });
    return connection;
  });
}

export async function clearManagedHermesSession(): Promise<void> {
  await chrome.storage.session.remove(SESSION_CONNECTION_KEY);
}

async function readCachedConnection(): Promise<ManagedHermesConnection | null> {
  const stored = await chrome.storage.session.get(SESSION_CONNECTION_KEY);
  return normalizeConnection(stored[SESSION_CONNECTION_KEY]);
}

function requestManagedHermes(
  command: "ensure" | "repair",
  onProgress: (progress: ManagedHermesProgress) => void,
  signal?: AbortSignal
): Promise<ManagedHermesConnection> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Préparation de Hermes interrompue.", "AbortError"));
      return;
    }

    let settled = false;
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (error) {
      reject(runtimeUnavailable(error));
      return;
    }

    const requestId = crypto.randomUUID();
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      try { port.disconnect(); } catch { /* already disconnected */ }
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const abort = () => finish(() => reject(new DOMException("Préparation de Hermes interrompue.", "AbortError")));
    const onDisconnect = () => {
      const message = chrome.runtime.lastError?.message ?? "Le moteur Hermes géré par Neptune n’est pas installé ou ne répond pas.";
      finish(() => reject(runtimeUnavailable(message)));
    };
    const onMessage = (message: NativeMessage) => {
      if (message.requestId !== requestId) return;
      if (message.kind === "progress") {
        const progress = {
          phase: message.phase ?? "detecting",
          progress: clampProgress(message.progress),
          detail: message.detail?.trim() || "Préparation du cerveau Hermes…"
        } satisfies ManagedHermesProgress;
        onProgress(progress);
        dispatchRuntimeStatus(progress);
        return;
      }
      if (message.kind === "error") {
        finish(() => reject(new Error(message.detail || `Hermes n’a pas pu démarrer (${message.code || "RUNTIME_ERROR"}).`)));
        return;
      }
      if (message.kind === "ready") {
        const connection = normalizeConnection(message);
        if (!connection) {
          finish(() => reject(new Error("Le moteur Hermes a répondu sans fournir une connexion locale valide.")));
          return;
        }
        const progress = { phase: "ready", progress: 100, detail: "Hermes est prêt." } satisfies ManagedHermesProgress;
        onProgress(progress);
        dispatchRuntimeStatus(progress);
        finish(() => resolve(connection));
      }
    };

    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    signal?.addEventListener("abort", abort, { once: true });
    port.postMessage({ requestId, type: command, clientVersion: chrome.runtime.getManifest().version });
  });
}

function normalizeConnection(value: unknown): ManagedHermesConnection | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const endpoint = typeof source.endpoint === "string" ? source.endpoint.trim().replace(/\/$/, "") : "";
  const apiKey = typeof source.apiKey === "string" ? source.apiKey.trim() : "";
  const model = typeof source.model === "string" ? source.model.trim() : "";
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(endpoint) || apiKey.length < 24 || !model) return null;
  return {
    endpoint,
    apiKey,
    model,
    ...(typeof source.runtimeVersion === "string" && source.runtimeVersion ? { runtimeVersion: source.runtimeVersion } : {}),
    managed: true
  };
}

function runtimeUnavailable(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error || "");
  const message = /native messaging host|specified native messaging host|not found|not installed/i.test(detail)
    ? "Le moteur Neptune intégré n’est pas encore installé. Lancez NeptuneSetup.exe une seule fois ; aucune clé ni configuration ne sera demandée."
    : `Le moteur Hermes local ne répond pas : ${detail || "erreur inconnue"}`;
  const failure = new Error(message);
  failure.name = "ManagedHermesUnavailableError";
  return failure;
}

function clampProgress(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.round(Math.max(0, Math.min(100, numeric)));
}

function dispatchRuntimeStatus(progress: ManagedHermesProgress): void {
  try {
    window.dispatchEvent(new CustomEvent("neptune-hermes-runtime-status", { detail: progress }));
  } catch {
    // Tests and service-worker contexts do not expose window.
  }
}

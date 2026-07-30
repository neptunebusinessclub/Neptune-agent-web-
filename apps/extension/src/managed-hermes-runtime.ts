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
  verifiedAt?: number;
};

export type ManagedHermesProgress = {
  phase: ManagedHermesPhase;
  progress: number;
  detail: string;
};

export type ManagedHermesStatus = {
  ready: boolean;
  code: string;
  detail: string;
  connection?: ManagedHermesConnection;
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

type PendingRequest = {
  resolve: (message: NativeMessage) => void;
  reject: (error: Error) => void;
  onProgress: (progress: ManagedHermesProgress) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const HOST_NAME = "com.neptune.hermes";
const SESSION_CONNECTION_KEY = "neptune.managedHermes.connection.v2";
const HEALTH_CACHE_MS = 15_000;
const HEALTH_TIMEOUT_MS = 4_000;
const NATIVE_TIMEOUT_MS = 7 * 60_000;

let nativePort: chrome.runtime.Port | null = null;
let ensureInFlight: Promise<ManagedHermesConnection> | null = null;
let repairInFlight: Promise<ManagedHermesConnection> | null = null;
const pending = new Map<string, PendingRequest>();

export async function ensureManagedHermes(
  onProgress: (progress: ManagedHermesProgress) => void = () => undefined,
  signal?: AbortSignal
): Promise<ManagedHermesConnection> {
  const cached = await readCachedConnection();
  if (cached && isFresh(cached) && await verifyConnection(cached, signal)) return cached;
  if (cached) await clearManagedHermesSession();
  if (ensureInFlight) return ensureInFlight;

  ensureInFlight = ensureWithRecovery(onProgress, signal)
    .finally(() => { ensureInFlight = null; });
  return ensureInFlight;
}

export async function repairManagedHermes(
  onProgress: (progress: ManagedHermesProgress) => void = () => undefined,
  signal?: AbortSignal
): Promise<ManagedHermesConnection> {
  if (repairInFlight) return repairInFlight;
  repairInFlight = (async () => {
    await clearManagedHermesSession();
    closeNativePort();
    const message = await requestNative("repair", onProgress, signal);
    const connection = normalizeConnection(message);
    if (!connection) throw new Error("Le moteur Neptune a terminé sa réparation sans fournir de connexion locale valide.");
    if (!await verifyConnection(connection, signal)) {
      throw new Error("Le moteur Neptune a redémarré, mais son contrôle de santé a échoué.");
    }
    return cacheVerifiedConnection(connection);
  })().finally(() => { repairInFlight = null; });
  return repairInFlight;
}

export async function getManagedHermesStatus(signal?: AbortSignal): Promise<ManagedHermesStatus> {
  const cached = await readCachedConnection();
  if (cached && await verifyConnection(cached, signal)) {
    const connection = await cacheVerifiedConnection(cached);
    return { ready: true, code: "READY", detail: "Neptune est prêt.", connection };
  }
  if (cached) await clearManagedHermesSession();

  try {
    const message = await requestNative("status", () => undefined, signal, 15_000);
    const connection = normalizeConnection(message);
    if (connection && await verifyConnection(connection, signal)) {
      const verified = await cacheVerifiedConnection(connection);
      return { ready: true, code: "READY", detail: message.detail || "Neptune est prêt.", connection: verified };
    }
    return {
      ready: false,
      code: message.code || "STOPPED",
      detail: message.detail || "Le moteur Neptune est installé mais ne répond pas."
    };
  } catch (error) {
    return { ready: false, code: "UNAVAILABLE", detail: runtimeUnavailable(error).message };
  }
}

export async function clearManagedHermesSession(): Promise<void> {
  await chrome.storage.session.remove([SESSION_CONNECTION_KEY, "neptune.managedHermes.connection.v1"]);
}

export function closeManagedHermesSupervisor(): void {
  closeNativePort();
}

async function ensureWithRecovery(
  onProgress: (progress: ManagedHermesProgress) => void,
  signal?: AbortSignal
): Promise<ManagedHermesConnection> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const message = await requestNative("ensure", onProgress, signal);
      const connection = normalizeConnection(message);
      if (!connection) throw new Error("Le moteur Neptune a répondu sans fournir une connexion locale valide.");
      if (!await verifyConnection(connection, signal)) throw new Error("Le contrôle de santé Neptune a échoué après le démarrage.");
      return cacheVerifiedConnection(connection);
    } catch (error) {
      lastError = error;
      closeNativePort();
      if (signal?.aborted) throw abortError();
      if (attempt === 0) await delay(900, signal);
    }
  }

  try {
    return await repairManagedHermes(onProgress, signal);
  } catch (repairError) {
    const primary = lastError instanceof Error ? lastError.message : String(lastError || "erreur inconnue");
    const repair = repairError instanceof Error ? repairError.message : String(repairError || "erreur inconnue");
    throw new Error(`Neptune n’a pas pu rétablir son moteur local. Démarrage : ${primary}. Réparation : ${repair}.`);
  }
}

function requestNative(
  command: "ensure" | "repair" | "status",
  onProgress: (progress: ManagedHermesProgress) => void,
  signal?: AbortSignal,
  timeoutMs = NATIVE_TIMEOUT_MS
): Promise<NativeMessage> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    let port: chrome.runtime.Port;
    try {
      port = getNativePort();
    } catch (error) {
      reject(runtimeUnavailable(error));
      return;
    }

    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      const request = pending.get(requestId);
      if (!request) return;
      pending.delete(requestId);
      request.reject(new Error("Le moteur Neptune n’a pas répondu dans le délai prévu."));
      closeNativePort();
    }, timeoutMs);

    const abort = () => {
      const request = pending.get(requestId);
      if (!request) return;
      clearTimeout(request.timeout);
      pending.delete(requestId);
      request.reject(abortError());
    };

    pending.set(requestId, {
      resolve: (message) => {
        signal?.removeEventListener("abort", abort);
        resolve(message);
      },
      reject: (error) => {
        signal?.removeEventListener("abort", abort);
        reject(error);
      },
      onProgress,
      timeout
    });
    signal?.addEventListener("abort", abort, { once: true });

    try {
      port.postMessage({ requestId, type: command, clientVersion: chrome.runtime.getManifest().version });
    } catch (error) {
      clearTimeout(timeout);
      pending.delete(requestId);
      signal?.removeEventListener("abort", abort);
      closeNativePort();
      reject(runtimeUnavailable(error));
    }
  });
}

function getNativePort(): chrome.runtime.Port {
  if (nativePort) return nativePort;
  const port = chrome.runtime.connectNative(HOST_NAME);
  nativePort = port;

  port.onMessage.addListener((message: NativeMessage) => {
    const requestId = message.requestId || "";
    const request = pending.get(requestId);
    if (!request) return;

    if (message.kind === "progress") {
      const progress = {
        phase: message.phase ?? "detecting",
        progress: clampProgress(message.progress),
        detail: message.detail?.trim() || "Préparation du moteur Neptune…"
      } satisfies ManagedHermesProgress;
      request.onProgress(progress);
      dispatchRuntimeStatus(progress);
      return;
    }

    clearTimeout(request.timeout);
    pending.delete(requestId);
    if (message.kind === "error") {
      request.reject(new Error(message.detail || `Le moteur Neptune a échoué (${message.code || "RUNTIME_ERROR"}).`));
      return;
    }
    request.resolve(message);
  });

  port.onDisconnect.addListener(() => {
    const detail = chrome.runtime.lastError?.message || "Le pont local Neptune a été interrompu.";
    if (nativePort === port) nativePort = null;
    for (const [requestId, request] of pending) {
      clearTimeout(request.timeout);
      pending.delete(requestId);
      request.reject(runtimeUnavailable(detail));
    }
  });

  return port;
}

function closeNativePort(): void {
  const port = nativePort;
  nativePort = null;
  if (!port) return;
  try { port.disconnect(); } catch { /* déjà fermé */ }
}

async function verifyConnection(connection: ManagedHermesConnection, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(`${connection.endpoint}/health`, {
      headers: { Authorization: `Bearer ${connection.apiKey}` },
      cache: "no-store",
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

async function cacheVerifiedConnection(connection: ManagedHermesConnection): Promise<ManagedHermesConnection> {
  const verified = { ...connection, verifiedAt: Date.now(), managed: true as const };
  await chrome.storage.session.set({ [SESSION_CONNECTION_KEY]: verified });
  return verified;
}

async function readCachedConnection(): Promise<ManagedHermesConnection | null> {
  const stored = await chrome.storage.session.get([SESSION_CONNECTION_KEY, "neptune.managedHermes.connection.v1"]);
  return normalizeConnection(stored[SESSION_CONNECTION_KEY] ?? stored["neptune.managedHermes.connection.v1"]);
}

function isFresh(connection: ManagedHermesConnection): boolean {
  return typeof connection.verifiedAt === "number" && Date.now() - connection.verifiedAt < HEALTH_CACHE_MS;
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
    ...(typeof source.verifiedAt === "number" ? { verifiedAt: source.verifiedAt } : {}),
    managed: true
  };
}

function runtimeUnavailable(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error || "");
  const message = /native messaging host|specified native messaging host|not found|not installed/i.test(detail)
    ? "Le moteur Neptune n’est pas installé ou Chrome n’a pas encore chargé sa liaison locale. Relancez l’installateur Neptune, puis redémarrez Chrome."
    : `Le moteur Neptune local ne répond pas : ${detail || "erreur inconnue"}`;
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
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("neptune-hermes-runtime-status", { detail: progress }));
    }
  } catch { /* contexte service worker */ }
}

function abortError(): DOMException {
  return new DOMException("Préparation de Neptune interrompue.", "AbortError");
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export type HermesPurpose = "conversation" | "browser-planning";

export type HermesProviderConfig = {
  endpoint?: string;
  apiKey?: string;
  model?: string;
};

export type HermesCapabilities = {
  platform: string;
  model: string;
  version?: string;
  authRequired: boolean;
  serverToolExecution: boolean;
  chatCompletions: boolean;
  runs: boolean;
  runStop: boolean;
  sessionContinuity: boolean;
  skillsApi: boolean;
  raw: Record<string, unknown>;
};

export type HermesConnection = {
  endpoint: string;
  model: string;
  version?: string;
  skillsCount: number | null;
  capabilities: HermesCapabilities;
};

type HermesIdentity = {
  sessionId: string;
  sessionKey: string;
  updatedAt: string;
};

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const IDENTITY_KEY = "neptune.hermes.identity.v1";
const DEFAULT_ENDPOINT = "http://127.0.0.1:8642";
const DEFAULT_MODEL = "hermes-agent";
const REQUEST_TIMEOUT_MS = 180_000;

export function getHermesDefaultEndpoint(): string {
  return DEFAULT_ENDPOINT;
}

export function getNeptuneExtensionOrigin(): string {
  try {
    return chrome.runtime.getURL("").replace(/\/$/, "");
  } catch {
    return "chrome-extension://EXTENSION_ID";
  }
}

export function normalizeHermesEndpoint(endpoint?: string): string {
  const raw = endpoint?.trim() || DEFAULT_ENDPOINT;
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("L’adresse Hermes doit utiliser HTTP ou HTTPS.");
  }
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Un serveur Hermes distant doit utiliser HTTPS.");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/v1")) pathname = pathname.slice(0, -3);
  url.pathname = pathname || "/";
  return url.toString().replace(/\/$/, "");
}

export function hermesOriginPattern(endpoint?: string): string {
  const root = normalizeHermesEndpoint(endpoint);
  const url = new URL(root);
  return `${url.origin}/*`;
}

export async function testHermesConnection(
  config: HermesProviderConfig,
  signal?: AbortSignal
): Promise<HermesConnection> {
  const endpoint = normalizeHermesEndpoint(config.endpoint);
  const apiKey = requireApiKey(config.apiKey);
  const headers = authHeaders(apiKey);

  const health = await hermesFetchJson(`${endpoint}/health`, { headers, signal: signal ?? null }, endpoint);
  const capabilitiesPayload = await hermesFetchJson(`${endpoint}/v1/capabilities`, { headers, signal: signal ?? null }, endpoint);
  const capabilities = normalizeCapabilities(capabilitiesPayload, health);
  if (capabilities.platform !== "hermes-agent") {
    throw new Error("Le serveur répond, mais il ne s’identifie pas comme Hermes Agent.");
  }
  if (!capabilities.chatCompletions) {
    throw new Error("Cette version de Hermes n’expose pas l’API de conversation requise.");
  }

  const modelsPayload = await hermesFetchJson(`${endpoint}/v1/models`, { headers, signal: signal ?? null }, endpoint);
  const model = resolveHermesModel(modelsPayload, config.model || capabilities.model);
  const skillsCount = capabilities.skillsApi
    ? await fetchSkillsCount(endpoint, headers, signal).catch(() => null)
    : null;

  return {
    endpoint,
    model,
    ...(capabilities.version ? { version: capabilities.version } : {}),
    skillsCount,
    capabilities
  };
}

export async function callHermesAgent(
  config: HermesProviderConfig,
  userName: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  systemInstruction: string,
  signal?: AbortSignal,
  purpose: HermesPurpose = "conversation"
): Promise<string> {
  const endpoint = normalizeHermesEndpoint(config.endpoint);
  const apiKey = requireApiKey(config.apiKey);
  const identity = purpose === "conversation" ? await getOrCreateIdentity() : null;
  const model = config.model?.trim() || DEFAULT_MODEL;
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const combined = mergeAbortSignals(signal, controller.signal);
  const sessionId = identity?.sessionId ?? `neptune-planner-${crypto.randomUUID()}`;
  const headers: Record<string, string> = {
    ...authHeaders(apiKey),
    "Content-Type": "application/json",
    "X-Hermes-Session-Id": sessionId,
    "Idempotency-Key": crypto.randomUUID()
  };
  if (identity && purpose === "conversation") headers["X-Hermes-Session-Key"] = identity.sessionKey;

  const system = purpose === "browser-planning"
    ? `${systemInstruction}\n\nMode Neptune Browser Planner : n’exécute aucun outil Hermes, n’ouvre aucun navigateur serveur, n’écris dans aucune mémoire et réponds uniquement dans le format JSON demandé. Neptune exécutera lui-même les actions dans le navigateur local après validation.`
    : `${systemInstruction}\n\nTu es le cerveau agentique optionnel de Neptune. Tu peux utiliser les compétences, la mémoire et les outils configurés dans Hermes. Les outils s’exécutent sur l’hôte Hermes, jamais silencieusement dans le navigateur Neptune. Ne prétends pas avoir manipulé l’onglet local de Neptune.`;
  const cleanMessages: ChatMessage[] = [
    { role: "system", content: system.slice(0, 16_000) },
    ...messages.slice(-18).map((message) => ({
      role: message.role,
      content: message.content.slice(0, 16_000)
    }))
  ];

  try {
    dispatchHermesStatus("connecting", "Connexion au cerveau Hermes");
    const response = await fetch(`${endpoint}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: cleanMessages,
        temperature: purpose === "browser-planning" ? 0.1 : 0.25,
        stream: false
      }),
      signal: combined
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) throw hermesHttpError(response.status, payload);
    const content = extractAssistantContent(payload);
    const returnedSessionId = response.headers.get("X-Hermes-Session-Id");
    if (identity && returnedSessionId && returnedSessionId !== identity.sessionId) {
      await saveIdentity({ ...identity, sessionId: returnedSessionId, updatedAt: new Date().toISOString() });
    }
    dispatchHermesStatus("completed", "Réponse Hermes reçue");
    return content;
  } catch (error) {
    if (combined.aborted) {
      dispatchHermesStatus("stopped", "Requête Hermes interrompue");
      throw new DOMException("La requête Hermes a été interrompue.", "AbortError");
    }
    dispatchHermesStatus("error", error instanceof Error ? error.message : "Erreur Hermes");
    throw normalizeHermesNetworkError(error, endpoint);
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export async function resetHermesSession(): Promise<void> {
  await chrome.storage.local.remove(IDENTITY_KEY);
}

function normalizeCapabilities(payload: Record<string, unknown>, health: Record<string, unknown>): HermesCapabilities {
  const features = isRecord(payload.features) ? payload.features : {};
  const runtime = isRecord(payload.runtime) ? payload.runtime : {};
  const auth = isRecord(payload.auth) ? payload.auth : {};
  return {
    platform: typeof payload.platform === "string" ? payload.platform : "",
    model: typeof payload.model === "string" && payload.model.trim() ? payload.model : DEFAULT_MODEL,
    ...(typeof health.version === "string" ? { version: health.version } : {}),
    authRequired: auth.required !== false,
    serverToolExecution: runtime.tool_execution === "server",
    chatCompletions: features.chat_completions === true,
    runs: features.run_submission === true,
    runStop: features.run_stop === true,
    sessionContinuity: typeof features.session_continuity_header === "string",
    skillsApi: features.skills_api === true,
    raw: payload
  };
}

function resolveHermesModel(payload: Record<string, unknown>, preferred?: string): string {
  const data = Array.isArray(payload.data) ? payload.data : [];
  const models = data.flatMap((item) => isRecord(item) && typeof item.id === "string" ? [item.id] : []);
  const cleanPreferred = preferred?.trim();
  if (cleanPreferred && models.includes(cleanPreferred)) return cleanPreferred;
  return models[0] || cleanPreferred || DEFAULT_MODEL;
}

async function fetchSkillsCount(endpoint: string, headers: Record<string, string>, signal?: AbortSignal): Promise<number | null> {
  const payload = await hermesFetchJson(`${endpoint}/v1/skills`, { headers, signal: signal ?? null }, endpoint);
  const source = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.skills) ? payload.skills : null;
  return source ? source.length : null;
}

async function hermesFetchJson(
  url: string,
  init: RequestInit,
  endpoint: string
): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(url, init);
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) throw hermesHttpError(response.status, payload);
    if (!payload || typeof payload !== "object") throw new Error("Hermes a renvoyé une réponse illisible.");
    return payload;
  } catch (error) {
    throw normalizeHermesNetworkError(error, endpoint);
  }
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

function requireApiKey(apiKey?: string): string {
  const clean = apiKey?.trim() ?? "";
  if (clean.length < 8) {
    throw new Error("La clé du serveur Hermes est absente ou trop courte. Configurez API_SERVER_KEY dans Hermes.");
  }
  return clean;
}

function extractAssistantContent(payload: Record<string, unknown> | null): string {
  const choices = payload && Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0];
  const message = isRecord(first) && isRecord(first.message) ? first.message : null;
  const content = message?.content;
  if (typeof content === "string" && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const text = content.flatMap((item) => isRecord(item) && typeof item.text === "string" ? [item.text] : []).join("\n").trim();
    if (text) return text;
  }
  throw new Error("Hermes n’a renvoyé aucune réponse exploitable.");
}

function hermesHttpError(status: number, payload: Record<string, unknown> | null): Error {
  const rawError = payload?.error;
  const message = typeof rawError === "string"
    ? rawError
    : isRecord(rawError) && typeof rawError.message === "string"
      ? rawError.message
      : typeof payload?.message === "string"
        ? payload.message
        : `HTTP ${status}`;
  if (status === 401 || status === 403) return new Error("Hermes a refusé l’authentification. Vérifiez API_SERVER_KEY.");
  if (status === 404) return new Error("L’API Hermes attendue n’est pas disponible. Mettez Hermes Agent à jour et activez API_SERVER_ENABLED.");
  return new Error(`Hermes a refusé la requête : ${message}`);
}

function normalizeHermesNetworkError(error: unknown, endpoint: string): Error {
  if (error instanceof DOMException && error.name === "AbortError") return error;
  if (error instanceof TypeError) {
    return new Error(`Connexion impossible à ${endpoint}. Vérifiez que « hermes gateway » est démarré et que API_SERVER_CORS_ORIGINS contient ${getNeptuneExtensionOrigin()}.`);
  }
  return error instanceof Error ? error : new Error("Connexion Hermes impossible.");
}

async function getOrCreateIdentity(): Promise<HermesIdentity> {
  const stored = await chrome.storage.local.get(IDENTITY_KEY);
  const current = stored[IDENTITY_KEY];
  if (isRecord(current) && typeof current.sessionId === "string" && typeof current.sessionKey === "string") {
    return {
      sessionId: current.sessionId,
      sessionKey: current.sessionKey,
      updatedAt: typeof current.updatedAt === "string" ? current.updatedAt : new Date().toISOString()
    };
  }
  const identity: HermesIdentity = {
    sessionId: `neptune-${crypto.randomUUID()}`,
    sessionKey: `neptune-user-${crypto.randomUUID()}`,
    updatedAt: new Date().toISOString()
  };
  await saveIdentity(identity);
  return identity;
}

async function saveIdentity(identity: HermesIdentity): Promise<void> {
  await chrome.storage.local.set({ [IDENTITY_KEY]: identity });
}

function mergeAbortSignals(primary?: AbortSignal, secondary?: AbortSignal): AbortSignal {
  if (!primary) return secondary ?? new AbortController().signal;
  if (!secondary) return primary;
  if (primary.aborted || secondary.aborted) return AbortSignal.abort();
  const controller = new AbortController();
  const abort = () => controller.abort();
  primary.addEventListener("abort", abort, { once: true });
  secondary.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

function dispatchHermesStatus(status: string, detail: string): void {
  try {
    window.dispatchEvent(new CustomEvent("neptune-hermes-status", { detail: { status, detail } }));
  } catch {
    // The client may be used from a non-window test context.
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

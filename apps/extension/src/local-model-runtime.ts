import {
  CreateWebWorkerMLCEngine,
  prebuiltAppConfig
} from "@mlc-ai/web-llm";

export type LocalModelAvailability = "unavailable" | "downloadable" | "downloading" | "available";

export type LocalLanguageModelMonitor = {
  addEventListener(type: "downloadprogress", listener: (event: { loaded: number }) => void): void;
};

export type LocalLanguageModelSession = {
  prompt(
    input: string | Array<{ role: string; content: string }>,
    options?: { signal?: AbortSignal; responseConstraint?: unknown; omitResponseConstraintInput?: boolean }
  ): Promise<string>;
  destroy(): void;
};

export type LocalLanguageModelApi = {
  availability(options?: unknown): Promise<LocalModelAvailability>;
  create(options?: {
    initialPrompts?: Array<{ role: string; content: string }>;
    expectedInputs?: Array<{ type: "text"; languages: string[] }>;
    expectedOutputs?: Array<{ type: "text"; languages: string[] }>;
    monitor?: (monitor: LocalLanguageModelMonitor) => void;
    signal?: AbortSignal;
  }): Promise<LocalLanguageModelSession>;
};

export type LocalEngineChoice = "auto" | "chrome-native" | "webllm";

export type LocalModelSelection = {
  engine: LocalEngineChoice;
  modelId: string;
};

export type LocalModelCard = {
  id: string;
  name: string;
  description: string;
  badge: string;
  memoryGb: number | null;
  tier: "light" | "fast" | "balanced" | "advanced" | "expert";
  recommended: boolean;
};

type WebLlmEngine = Awaited<ReturnType<typeof CreateWebWorkerMLCEngine>>;
type WebLlmMessage = { role: "system" | "user" | "assistant"; content: string };

type InitProgressReport = {
  progress?: number;
  text?: string;
  timeElapsed?: number;
};

const STORAGE_SELECTION = "neptune.local-model.selection.v1";
const STORAGE_READY = "neptune.local-model.ready.v1";
const DEFAULT_MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC";

const nativeLanguageModel = (window as Window & { LanguageModel?: LocalLanguageModelApi }).LanguageModel;
let webLlmEngine: WebLlmEngine | null = null;
let webLlmWorker: Worker | null = null;
let activeWebLlmModel = "";
let webLlmLoadingModel = "";

const FRIENDLY_MODELS: Array<{
  matcher: RegExp;
  name: string;
  description: string;
  badge: string;
  tier: LocalModelCard["tier"];
}> = [
  {
    matcher: /^Qwen2\.5-0\.5B-Instruct-q4f16_1-MLC$/i,
    name: "Neptune Essentiel",
    description: "Le plus léger. Idéal pour les commandes simples et les ordinateurs modestes.",
    badge: "TRÈS LÉGER",
    tier: "light"
  },
  {
    matcher: /^Llama-3\.2-1B-Instruct-q4f16_1-MLC$/i,
    name: "Neptune Rapide",
    description: "Rapide et polyvalent pour la navigation quotidienne.",
    badge: "RECOMMANDÉ",
    tier: "fast"
  },
  {
    matcher: /^Qwen2\.5-1\.5B-Instruct-q4f16_1-MLC$/i,
    name: "Neptune Équilibré",
    description: "Un meilleur raisonnement tout en restant accessible à la plupart des postes récents.",
    badge: "ÉQUILIBRÉ",
    tier: "balanced"
  },
  {
    matcher: /^gemma-2-2b-it-q4f16_1-MLC$/i,
    name: "Neptune Avancé",
    description: "Plus précis pour les pages complexes et les objectifs en plusieurs étapes.",
    badge: "AVANCÉ",
    tier: "advanced"
  },
  {
    matcher: /^Llama-3\.2-3B-Instruct-q4f16_1-MLC$/i,
    name: "Neptune Expert Local",
    description: "Le plus puissant de la sélection locale. Recommandé sur un ordinateur performant.",
    badge: "PUISSANT",
    tier: "expert"
  }
];

export function isWebGpuAvailable(): boolean {
  return Boolean((navigator as Navigator & { gpu?: unknown }).gpu);
}

export function getLocalModelCatalog(): LocalModelCard[] {
  const records = prebuiltAppConfig.model_list as unknown as Array<Record<string, unknown>>;
  const available = records.flatMap((record) => {
    const id = typeof record.model_id === "string" ? record.model_id : "";
    if (!id) return [];
    const friendly = FRIENDLY_MODELS.find((item) => item.matcher.test(id));
    if (!friendly) return [];
    const memoryMb = typeof record.vram_required_MB === "number" ? record.vram_required_MB : null;
    return [{
      id,
      name: friendly.name,
      description: friendly.description,
      badge: friendly.badge,
      memoryGb: memoryMb ? Math.round(memoryMb / 102.4) / 10 : null,
      tier: friendly.tier,
      recommended: false
    } satisfies LocalModelCard];
  });

  const unique = new Map(available.map((model) => [model.id, model]));
  const catalog = [...unique.values()];
  if (catalog.length === 0) {
    const fallback = records.find((record) => typeof record.model_id === "string" && /(?:0\.5B|1B)-Instruct.*q4f16/i.test(record.model_id));
    if (typeof fallback?.model_id === "string") {
      catalog.push({
        id: fallback.model_id,
        name: "Neptune Local",
        description: "Modèle local optimisé pour fonctionner directement dans Chrome.",
        badge: "LOCAL",
        memoryGb: typeof fallback.vram_required_MB === "number" ? Math.round(fallback.vram_required_MB / 102.4) / 10 : null,
        tier: "fast",
        recommended: false
      });
    }
  }

  const recommendedId = recommendModelId(catalog);
  return catalog.map((model) => ({ ...model, recommended: model.id === recommendedId }));
}

export function recommendModelId(catalog = getLocalModelCatalog()): string {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const preferredTiers: LocalModelCard["tier"][] = memory <= 4
    ? ["light", "fast", "balanced", "advanced", "expert"]
    : memory <= 8
      ? ["fast", "balanced", "light", "advanced", "expert"]
      : ["balanced", "advanced", "fast", "expert", "light"];
  for (const tier of preferredTiers) {
    const match = catalog.find((model) => model.tier === tier);
    if (match) return match.id;
  }
  return catalog[0]?.id ?? DEFAULT_MODEL_ID;
}

export async function getLocalModelSelection(): Promise<LocalModelSelection> {
  const stored = await chrome.storage.local.get(STORAGE_SELECTION);
  const candidate = stored[STORAGE_SELECTION] as Partial<LocalModelSelection> | undefined;
  const catalog = getLocalModelCatalog();
  const fallbackModel = recommendModelId(catalog);
  const modelId = typeof candidate?.modelId === "string" && catalog.some((model) => model.id === candidate.modelId)
    ? candidate.modelId
    : fallbackModel;
  const engine: LocalEngineChoice = candidate?.engine === "chrome-native" || candidate?.engine === "webllm" || candidate?.engine === "auto"
    ? candidate.engine
    : "auto";
  return { engine, modelId };
}

export async function saveLocalModelSelection(selection: LocalModelSelection): Promise<void> {
  const previous = await getLocalModelSelection();
  if (previous.engine !== selection.engine || previous.modelId !== selection.modelId) await releaseLocalModel();
  await chrome.storage.local.set({ [STORAGE_SELECTION]: selection });
  window.dispatchEvent(new CustomEvent("neptune-local-model-selection", { detail: selection }));
}

export function getLocalLanguageModelApi(): LocalLanguageModelApi | undefined {
  if (!nativeLanguageModel && !isWebGpuAvailable()) return undefined;
  return hybridLanguageModel;
}

export async function releaseLocalModel(): Promise<void> {
  try {
    await (webLlmEngine as unknown as { unload?: () => Promise<void> } | null)?.unload?.();
  } catch {
    // Le worker sera terminé même si le moteur refuse le déchargement.
  }
  webLlmWorker?.terminate();
  webLlmWorker = null;
  webLlmEngine = null;
  activeWebLlmModel = "";
  webLlmLoadingModel = "";
}

const hybridLanguageModel: LocalLanguageModelApi = {
  async availability(options): Promise<LocalModelAvailability> {
    const selection = await getLocalModelSelection();
    if (selection.engine === "chrome-native") {
      return nativeLanguageModel ? nativeLanguageModel.availability(options) : "unavailable";
    }
    if (selection.engine === "auto" && nativeLanguageModel) {
      const nativeStatus = await nativeLanguageModel.availability(options).catch(() => "unavailable" as const);
      if (nativeStatus !== "unavailable") return nativeStatus;
    }
    if (!isWebGpuAvailable()) return "unavailable";
    if (activeWebLlmModel === selection.modelId && webLlmEngine) return "available";
    if (webLlmLoadingModel === selection.modelId) return "downloading";
    const stored = await chrome.storage.local.get(STORAGE_READY);
    if (stored[STORAGE_READY] === selection.modelId) return "available";
    return "downloadable";
  },

  async create(options): Promise<LocalLanguageModelSession> {
    const selection = await getLocalModelSelection();
    if (selection.engine === "chrome-native") {
      if (!nativeLanguageModel) throw new Error("L’intelligence intégrée de Chrome n’est pas disponible sur ce poste.");
      return nativeLanguageModel.create(options);
    }
    if (selection.engine === "auto" && nativeLanguageModel) {
      const nativeStatus = await nativeLanguageModel.availability(options).catch(() => "unavailable" as const);
      if (nativeStatus !== "unavailable") return nativeLanguageModel.create(options);
    }
    return createWebLlmSession(selection.modelId, options);
  }
};

async function createWebLlmSession(
  modelId: string,
  options?: Parameters<LocalLanguageModelApi["create"]>[0]
): Promise<LocalLanguageModelSession> {
  if (!isWebGpuAvailable()) throw new Error("WebGPU n’est pas disponible. Choisissez l’intelligence Chrome ou un moteur cloud.");

  let progressListener: ((event: { loaded: number }) => void) | undefined;
  options?.monitor?.({
    addEventListener(_type, listener) {
      progressListener = listener;
    }
  });

  if (!webLlmEngine || activeWebLlmModel !== modelId) {
    await releaseLocalModel();
    webLlmLoadingModel = modelId;
    dispatchProgress(modelId, 0, "Préparation du moteur local");
    webLlmWorker = new Worker(chrome.runtime.getURL("webllm-worker.js"), { type: "module" });
    const appConfig = { ...prebuiltAppConfig, cacheBackend: "indexeddb" as const };
    try {
      webLlmEngine = await CreateWebWorkerMLCEngine(webLlmWorker, modelId, {
        appConfig,
        initProgressCallback(report: InitProgressReport) {
          const progress = clampProgress(report.progress);
          progressListener?.({ loaded: progress });
          dispatchProgress(modelId, progress, report.text ?? "Téléchargement du modèle local");
        }
      });
      activeWebLlmModel = modelId;
      await chrome.storage.local.set({ [STORAGE_READY]: modelId });
      dispatchProgress(modelId, 1, "Modèle local prêt");
    } catch (error) {
      await releaseLocalModel();
      throw new Error(`Le modèle local n’a pas pu être chargé : ${error instanceof Error ? error.message : "erreur inconnue"}`);
    } finally {
      webLlmLoadingModel = "";
    }
  }

  const initialPrompts = options?.initialPrompts ?? [];
  let destroyed = false;
  return {
    async prompt(input, promptOptions): Promise<string> {
      if (destroyed || !webLlmEngine) throw new Error("La session locale n’est plus active.");
      const inputMessages: WebLlmMessage[] = typeof input === "string"
        ? [{ role: "user", content: input }]
        : input.map((message) => ({ role: normalizeRole(message.role), content: message.content }));
      const messages: WebLlmMessage[] = [
        ...initialPrompts.map((message) => ({ role: normalizeRole(message.role), content: message.content })),
        ...inputMessages
      ];
      const createCompletion = webLlmEngine.chat.completions.create.bind(webLlmEngine.chat.completions) as unknown as (
        request: { messages: WebLlmMessage[]; temperature: number; max_tokens: number; stream: false }
      ) => Promise<unknown>;
      const request = createCompletion({
        messages,
        temperature: 0.2,
        max_tokens: 2_000,
        stream: false
      });
      const completion = await raceWithAbort(request, promptOptions?.signal, webLlmEngine);
      const content = (completion as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
      if (typeof content === "string" && content.trim()) return content.trim();
      if (Array.isArray(content)) {
        const text = content.flatMap((part) => typeof part === "string" ? [part] : []).join(" ").trim();
        if (text) return text;
      }
      throw new Error("Le modèle local a renvoyé une réponse vide.");
    },
    destroy() {
      destroyed = true;
    }
  };
}

function dispatchProgress(modelId: string, progress: number, text: string): void {
  window.dispatchEvent(new CustomEvent("neptune-local-model-progress", {
    detail: { modelId, progress, text }
  }));
}

function clampProgress(value?: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeRole(role: string): "system" | "user" | "assistant" {
  if (role === "system" || role === "assistant") return role;
  return "user";
}

async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  engine: WebLlmEngine
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    await interruptEngine(engine);
    throw new DOMException("La génération a été interrompue.", "AbortError");
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      void interruptEngine(engine);
      reject(new DOMException("La génération a été interrompue.", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function interruptEngine(engine: WebLlmEngine): Promise<void> {
  try {
    await (engine as unknown as { interruptGenerate?: () => Promise<void> }).interruptGenerate?.();
  } catch {
    // L’arrêt du flux reste best-effort.
  }
}

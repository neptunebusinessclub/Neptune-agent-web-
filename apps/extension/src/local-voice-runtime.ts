export const LOCAL_VOICE_PREFIX = "neptune-piper:";

export type NeptuneLocalVoice = {
  id: string;
  name: string;
  style: string;
  quality: "low" | "medium";
  recommended: boolean;
};

export const NEPTUNE_LOCAL_VOICES: NeptuneLocalVoice[] = [
  {
    id: "fr_FR-siwis-medium",
    name: "Néréide",
    style: "Claire, posée et naturelle",
    quality: "medium",
    recommended: true
  },
  {
    id: "fr_FR-tom-medium",
    name: "Triton",
    style: "Directe, stable et professionnelle",
    quality: "medium",
    recommended: false
  },
  {
    id: "fr_FR-upmc-medium",
    name: "Atlas",
    style: "Neutre, précise et structurée",
    quality: "medium",
    recommended: false
  },
  {
    id: "fr_FR-mls-medium",
    name: "Nova",
    style: "Dynamique et conversationnelle",
    quality: "medium",
    recommended: false
  },
  {
    id: "fr_FR-gilles-low",
    name: "Mistral",
    style: "Légère et rapide sur les postes modestes",
    quality: "low",
    recommended: false
  }
];

type WorkerResponse =
  | { type: "RESULT"; requestId: string; result: unknown }
  | { type: "AUDIO"; requestId: string; voiceId: string; mimeType: string; buffer: ArrayBuffer }
  | { type: "PROGRESS"; requestId: string; voiceId: string; progress: number; loaded: number; total: number; file: string }
  | { type: "ERROR"; requestId: string; message: string };

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  onProgress?: ((progress: number, detail: string) => void) | undefined;
};

const PREFERENCES_KEY = "neptune.preferences.v2";
const READY_KEY = "neptune.local-voices.ready.v1";
const pending = new Map<string, PendingRequest>();
let worker: Worker | null = null;
let currentAudio: HTMLAudioElement | null = null;
let currentAudioUrl = "";
let selectedVoiceUri = "";
let proxyInstalled = false;
let playbackGeneration = 0;

const nativeSpeak = speechSynthesis.speak.bind(speechSynthesis);
const nativeCancel = speechSynthesis.cancel.bind(speechSynthesis);

void initializeSelection();
installSpeechProxy();

export function toLocalVoiceUri(voiceId: string): string {
  return `${LOCAL_VOICE_PREFIX}${voiceId}`;
}

export function fromLocalVoiceUri(value: string): string | null {
  return value.startsWith(LOCAL_VOICE_PREFIX) ? value.slice(LOCAL_VOICE_PREFIX.length) : null;
}

export function isLocalVoiceUri(value: string): boolean {
  return Boolean(fromLocalVoiceUri(value));
}

export function getSelectedLocalVoice(): NeptuneLocalVoice | null {
  const id = fromLocalVoiceUri(selectedVoiceUri);
  return id ? NEPTUNE_LOCAL_VOICES.find((voice) => voice.id === id) ?? null : null;
}

export function setSelectedVoiceUri(value: string): void {
  selectedVoiceUri = value;
  window.dispatchEvent(new CustomEvent("neptune-voice-selection", { detail: { voiceURI: value } }));
}

export async function getReadyLocalVoices(): Promise<string[]> {
  const stored = await chrome.storage.local.get(READY_KEY);
  return Array.isArray(stored[READY_KEY]) ? stored[READY_KEY].filter((value): value is string => typeof value === "string") : [];
}

export async function getAvailableLocalVoiceIds(): Promise<string[]> {
  const result = await requestWorker("LIST", {});
  if (Array.isArray(result)) return result.filter((value): value is string => typeof value === "string");
  if (result && typeof result === "object") return Object.keys(result as Record<string, unknown>);
  return [];
}

export async function prepareLocalVoice(
  voiceId: string,
  onProgress?: (progress: number, detail: string) => void
): Promise<void> {
  const available: string[] = await getAvailableLocalVoiceIds().catch((): string[] => []);
  if (available.length > 0 && !available.includes(voiceId)) {
    throw new Error("Cette voix française n’est pas disponible dans le catalogue local installé.");
  }
  await requestWorker("DOWNLOAD", { voiceId }, onProgress);
  const ready = new Set(await getReadyLocalVoices());
  ready.add(voiceId);
  await chrome.storage.local.set({ [READY_KEY]: [...ready] });
  window.dispatchEvent(new CustomEvent("neptune-voice-ready", { detail: { voiceId } }));
}

export async function previewLocalVoice(
  voiceId: string,
  onProgress?: (progress: number, detail: string) => void
): Promise<void> {
  await prepareLocalVoice(voiceId, onProgress);
  const voice = NEPTUNE_LOCAL_VOICES.find((item) => item.id === voiceId);
  await playLocalText(
    `Bonjour. Je suis Neptune. Voici la voix ${voice?.name ?? "locale"}. Je suis prêt à vous accompagner.`,
    voiceId,
    onProgress
  );
}

export async function playLocalText(
  text: string,
  voiceId: string,
  onProgress?: (progress: number, detail: string) => void
): Promise<void> {
  const generation = ++playbackGeneration;
  stopLocalPlayback(false);
  const response = await requestWorker("SYNTHESIZE", { voiceId, text: text.slice(0, 2_000) }, onProgress) as {
    buffer: ArrayBuffer;
    mimeType: string;
  };
  if (generation !== playbackGeneration) return;
  const blob = new Blob([response.buffer], { type: response.mimeType || "audio/wav" });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;
  currentAudioUrl = url;
  await new Promise<void>((resolve, reject) => {
    audio.onended = () => resolve();
    audio.onerror = () => reject(new Error("La lecture de la voix locale a échoué."));
    void audio.play().catch(reject);
  }).finally(() => {
    if (currentAudio === audio) currentAudio = null;
    if (currentAudioUrl === url) currentAudioUrl = "";
    URL.revokeObjectURL(url);
  });
}

export function stopLocalPlayback(resetWorker = true): void {
  playbackGeneration += 1;
  currentAudio?.pause();
  if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
  currentAudio = null;
  currentAudioUrl = "";
  if (resetWorker) resetVoiceWorker(new DOMException("La synthèse vocale a été interrompue.", "AbortError"));
}

function installSpeechProxy(): void {
  if (proxyInstalled) return;
  proxyInstalled = true;
  const synthesis = speechSynthesis as SpeechSynthesis & {
    speak: (utterance: SpeechSynthesisUtterance) => void;
    cancel: () => void;
  };

  synthesis.speak = (utterance: SpeechSynthesisUtterance): void => {
    const localVoiceId = fromLocalVoiceUri(selectedVoiceUri);
    if (!localVoiceId) {
      nativeSpeak(utterance);
      return;
    }
    const generation = ++playbackGeneration;
    utterance.dispatchEvent(new Event("start"));
    void prepareLocalVoice(localVoiceId, (progress, detail) => {
      window.dispatchEvent(new CustomEvent("neptune-voice-progress", { detail: { voiceId: localVoiceId, progress, text: detail } }));
    }).then(() => requestWorker("SYNTHESIZE", {
      voiceId: localVoiceId,
      text: utterance.text.slice(0, 2_000)
    })).then(async (response) => {
      if (generation !== playbackGeneration) return;
      const audioPayload = response as { buffer: ArrayBuffer; mimeType: string };
      const blob = new Blob([audioPayload.buffer], { type: audioPayload.mimeType || "audio/wav" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentAudio = audio;
      currentAudioUrl = url;
      audio.onended = () => {
        if (generation === playbackGeneration) utterance.dispatchEvent(new Event("end"));
        cleanupAudio(audio, url);
      };
      audio.onerror = () => {
        if (generation === playbackGeneration) utterance.dispatchEvent(new Event("error"));
        cleanupAudio(audio, url);
      };
      await audio.play();
    }).catch(() => {
      if (generation === playbackGeneration) utterance.dispatchEvent(new Event("error"));
    });
  };

  synthesis.cancel = (): void => {
    stopLocalPlayback(true);
    nativeCancel();
  };
}

async function initializeSelection(): Promise<void> {
  const stored = await chrome.storage.local.get(PREFERENCES_KEY);
  const preferences = stored[PREFERENCES_KEY] as { voiceURI?: unknown } | undefined;
  if (typeof preferences?.voiceURI === "string") selectedVoiceUri = preferences.voiceURI;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const next = changes[PREFERENCES_KEY]?.newValue as { voiceURI?: unknown } | undefined;
    if (typeof next?.voiceURI === "string") setSelectedVoiceUri(next.voiceURI);
  });
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(chrome.runtime.getURL("piper-voice-worker.js"), { type: "module" });
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    const request = pending.get(message.requestId);
    if (!request) return;
    if (message.type === "PROGRESS") {
      request.onProgress?.(Math.max(0, Math.min(1, message.progress)), message.file || "Téléchargement de la voix");
      window.dispatchEvent(new CustomEvent("neptune-voice-progress", { detail: message }));
      return;
    }
    pending.delete(message.requestId);
    if (message.type === "ERROR") {
      request.reject(new Error(message.message));
      return;
    }
    if (message.type === "AUDIO") {
      request.resolve({ buffer: message.buffer, mimeType: message.mimeType });
      return;
    }
    request.resolve(message.result);
  };
  worker.onerror = (event) => resetVoiceWorker(new Error(event.message || "Le moteur vocal local s’est arrêté."));
  return worker;
}

function requestWorker(
  type: "LIST" | "STORED" | "DOWNLOAD" | "SYNTHESIZE" | "REMOVE",
  payload: Record<string, unknown>,
  onProgress?: (progress: number, detail: string) => void
): Promise<unknown> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject, onProgress });
    getWorker().postMessage({ type, requestId, ...payload });
  });
}

function resetVoiceWorker(reason: unknown): void {
  worker?.terminate();
  worker = null;
  for (const request of pending.values()) request.reject(reason);
  pending.clear();
}

function cleanupAudio(audio: HTMLAudioElement, url: string): void {
  if (currentAudio === audio) currentAudio = null;
  if (currentAudioUrl === url) currentAudioUrl = "";
  URL.revokeObjectURL(url);
}

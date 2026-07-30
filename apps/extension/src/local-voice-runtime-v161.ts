export const LOCAL_VOICE_PREFIX = "neptune-piper:";

export type NeptuneLocalVoice = {
  id: string;
  name: string;
  style: string;
  quality: "medium";
  recommended: boolean;
};

export const NEPTUNE_LOCAL_VOICES: NeptuneLocalVoice[] = [
  {
    id: "fr_FR-siwis-medium",
    name: "Féminine",
    style: "Claire, naturelle et chaleureuse",
    quality: "medium",
    recommended: true
  },
  {
    id: "fr_FR-upmc-medium",
    name: "Masculine",
    style: "Grave, fluide et professionnelle",
    quality: "medium",
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
  timeoutId: number;
};

const PREFERENCES_KEY = "neptune.preferences.v2";
const READY_KEY = "neptune.local-voices.ready.v1";
const pending = new Map<string, PendingRequest>();
const voicePreparations = new Map<string, Promise<void>>();
let worker: Worker | null = null;
let selectedVoiceUri = "";
let proxyInstalled = false;
let playbackGeneration = 0;
let audioContext: AudioContext | null = null;
let activeSource: AudioBufferSourceNode | null = null;
let activeAudio: HTMLAudioElement | null = null;
let activeAudioUrl = "";
let meterFrame = 0;

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

export async function unlockLocalAudio(): Promise<void> {
  const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return;
  if (!audioContext || audioContext.state === "closed") audioContext = new AudioContextClass();
  if (audioContext.state === "suspended") await audioContext.resume();
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

export function prepareLocalVoice(
  voiceId: string,
  onProgress?: (progress: number, detail: string) => void
): Promise<void> {
  const existing = voicePreparations.get(voiceId);
  if (existing) return existing;
  const preparation = prepareLocalVoiceOnce(voiceId, onProgress).finally(() => {
    voicePreparations.delete(voiceId);
  });
  voicePreparations.set(voiceId, preparation);
  return preparation;
}

async function prepareLocalVoiceOnce(
  voiceId: string,
  onProgress?: (progress: number, detail: string) => void
): Promise<void> {
  const available = await getAvailableLocalVoiceIds();
  if (!available.includes(voiceId)) throw new Error("Cette voix française n’est pas incluse dans Neptune.");

  const ready = new Set(await getReadyLocalVoices());
  if (ready.has(voiceId)) {
    onProgress?.(1, "Voix intégrée prête");
    return;
  }

  try {
    await requestWorker("DOWNLOAD", { voiceId }, onProgress);
    ready.add(voiceId);
    await chrome.storage.local.set({ [READY_KEY]: [...ready] });
    window.dispatchEvent(new CustomEvent("neptune-voice-ready", { detail: { voiceId } }));
  } catch (error) {
    ready.delete(voiceId);
    await chrome.storage.local.set({ [READY_KEY]: [...ready] });
    throw error;
  }
}

export async function previewLocalVoice(
  voiceId: string,
  onProgress?: (progress: number, detail: string) => void
): Promise<void> {
  await unlockLocalAudio();
  await prepareLocalVoice(voiceId, onProgress);
  const voice = NEPTUNE_LOCAL_VOICES.find((item) => item.id === voiceId);
  await playLocalText(
    `Bonjour. Je suis Neptune. Vous écoutez maintenant la voix ${voice?.name.toLocaleLowerCase("fr-FR") ?? "locale"}.`,
    voiceId,
    onProgress
  );
}

export async function playLocalText(
  text: string,
  voiceId: string,
  onProgress?: (progress: number, detail: string) => void
): Promise<void> {
  stopLocalPlayback(false);
  const generation = playbackGeneration;
  markPlayback("preparing", voiceId);
  const response = await requestWorker("SYNTHESIZE", { voiceId, text: text.slice(0, 2_000) }, onProgress) as {
    buffer: ArrayBuffer;
    mimeType: string;
  };
  if (response.buffer.byteLength < 1_024) throw new Error("La voix a produit un fichier audio invalide.");
  if (generation !== playbackGeneration) return;

  try {
    await playDecodedAudio(response.buffer, response.mimeType || "audio/wav", generation, voiceId);
  } catch (error) {
    markPlayback("error", voiceId);
    throw error;
  }
}

export function stopLocalPlayback(resetWorker = true): void {
  playbackGeneration += 1;
  cancelAnimationFrame(meterFrame);
  meterFrame = 0;
  try { activeSource?.stop(); } catch { /* already stopped */ }
  activeSource?.disconnect();
  activeSource = null;
  activeAudio?.pause();
  activeAudio = null;
  if (activeAudioUrl) URL.revokeObjectURL(activeAudioUrl);
  activeAudioUrl = "";
  emitAudioLevel(0);
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
    stopLocalPlayback(false);
    const generation = playbackGeneration;
    utterance.dispatchEvent(new Event("start"));
    markPlayback("preparing", localVoiceId);
    void prepareLocalVoice(localVoiceId, (progress, detail) => {
      window.dispatchEvent(new CustomEvent("neptune-voice-progress", { detail: { voiceId: localVoiceId, progress, text: detail } }));
    }).then(() => requestWorker("SYNTHESIZE", {
      voiceId: localVoiceId,
      text: utterance.text.slice(0, 2_000)
    })).then(async (response) => {
      if (generation !== playbackGeneration) return;
      const audioPayload = response as { buffer: ArrayBuffer; mimeType: string };
      if (audioPayload.buffer.byteLength < 1_024) throw new Error("Audio local invalide");
      await playDecodedAudio(audioPayload.buffer, audioPayload.mimeType || "audio/wav", generation, localVoiceId);
      if (generation === playbackGeneration) utterance.dispatchEvent(new Event("end"));
    }).catch(() => {
      markPlayback("error", localVoiceId);
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
      request.onProgress?.(Math.max(0, Math.min(1, message.progress)), message.file || "Préparation de la voix");
      window.dispatchEvent(new CustomEvent("neptune-voice-progress", { detail: message }));
      return;
    }
    pending.delete(message.requestId);
    window.clearTimeout(request.timeoutId);
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
    const timeoutId = window.setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("Le moteur vocal local ne répond pas. Rechargez Neptune puis réessayez."));
      resetVoiceWorker(new Error("Voice worker timeout"));
    }, type === "SYNTHESIZE" ? 90_000 : 45_000);
    pending.set(requestId, { resolve, reject, onProgress, timeoutId });
    getWorker().postMessage({ type, requestId, ...payload });
  });
}

function resetVoiceWorker(reason: unknown): void {
  worker?.terminate();
  worker = null;
  voicePreparations.clear();
  for (const request of pending.values()) {
    window.clearTimeout(request.timeoutId);
    request.reject(reason);
  }
  pending.clear();
}

async function playDecodedAudio(buffer: ArrayBuffer, mimeType: string, generation: number, voiceId: string): Promise<void> {
  await unlockLocalAudio();
  if (audioContext && audioContext.state === "running") {
    try {
      const decoded = await audioContext.decodeAudioData(buffer.slice(0));
      if (generation !== playbackGeneration) return;
      await playAudioBuffer(decoded, generation, voiceId);
      return;
    } catch {
      // Some Chromium builds reject valid WAV buffers in Web Audio. The HTML audio fallback remains local.
    }
  }
  await playHtmlAudio(buffer, mimeType, generation, voiceId);
}

async function playAudioBuffer(buffer: AudioBuffer, generation: number, voiceId: string): Promise<void> {
  if (!audioContext) throw new Error("Le moteur audio de Chrome n’est pas disponible.");
  const source = audioContext.createBufferSource();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.88;
  source.buffer = buffer;
  source.connect(analyser);
  analyser.connect(audioContext.destination);
  activeSource = source;
  markPlayback("playing", voiceId);
  startMeter(analyser, generation);

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      try { source.stop(); } catch { /* already stopped */ }
      reject(new Error("La lecture de la voix locale a dépassé le délai autorisé."));
    }, Math.max(8_000, Math.min(60_000, buffer.duration * 1_000 + 5_000)));
    source.onended = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    try { source.start(); }
    catch (error) {
      window.clearTimeout(timeout);
      reject(error);
    }
  });

  if (activeSource === source) activeSource = null;
  cancelAnimationFrame(meterFrame);
  meterFrame = 0;
  emitAudioLevel(0);
  if (generation === playbackGeneration) markPlayback("ended", voiceId);
}

async function playHtmlAudio(buffer: ArrayBuffer, mimeType: string, generation: number, voiceId: string): Promise<void> {
  const blob = new Blob([buffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  activeAudio = audio;
  activeAudioUrl = url;
  markPlayback("playing", voiceId);
  await promiseWithTimeout(audio.play(), 5_000, "Chrome a empêché la lecture audio. Cliquez à nouveau sur Écouter.");
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      audio.pause();
      resolve();
    }, 60_000);
    audio.onended = () => { window.clearTimeout(timeout); resolve(); };
    audio.onerror = () => { window.clearTimeout(timeout); reject(new Error("La lecture de la voix locale a échoué.")); };
  });
  audio.pause();
  if (activeAudio === audio) activeAudio = null;
  if (activeAudioUrl === url) activeAudioUrl = "";
  URL.revokeObjectURL(url);
  if (generation === playbackGeneration) markPlayback("ended", voiceId);
}

function startMeter(analyser: AnalyserNode, generation: number): void {
  const values = new Uint8Array(analyser.frequencyBinCount);
  let envelope = 0;
  const tick = () => {
    if (generation !== playbackGeneration) return;
    analyser.getByteFrequencyData(values);
    const raw = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length * 255);
    envelope += (raw - envelope) * 0.12;
    emitAudioLevel(envelope);
    meterFrame = window.requestAnimationFrame(tick);
  };
  tick();
}

function emitAudioLevel(level: number): void {
  window.dispatchEvent(new CustomEvent("neptune-audio-level", { detail: { level: Math.max(0, Math.min(1, level)) } }));
}

function markPlayback(state: "preparing" | "playing" | "ended" | "error", voiceId: string): void {
  document.documentElement.dataset.neptuneVoicePlayback = state;
  document.documentElement.dataset.neptuneVoiceId = voiceId;
  window.dispatchEvent(new CustomEvent("neptune-voice-playback", { detail: { state, voiceId } }));
}

function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then((value) => {
      window.clearTimeout(timeout);
      resolve(value);
    }, (error) => {
      window.clearTimeout(timeout);
      reject(error);
    });
  });
}

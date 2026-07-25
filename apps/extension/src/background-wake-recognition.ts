export {};

type BackgroundRecognitionResultEvent = Event & {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};
type BackgroundRecognitionErrorEvent = Event & { error: string };
type WakePreferences = { onboardingComplete?: boolean; wakeWordEnabled?: boolean };
type WakeStatusMessage = {
  target: "neptune-sidepanel";
  type: "WAKE_STATUS" | "WAKE_TRANSCRIPT";
  status?: string;
  error?: string;
  transcript?: string;
};

const PREFERENCES_KEY = "neptune.preferences.v2";
const PENDING_TRANSCRIPT_KEY = "neptune.pendingVoiceTranscript.v1";
let microphonePermissionPrimed = false;
let autoStarted = false;
const instances = new Set<NeptuneBackgroundRecognition>();

class NeptuneBackgroundRecognition {
  lang = "fr-FR";
  continuous = true;
  interimResults = false;
  maxAlternatives = 1;
  onstart: (() => void) | null = null;
  onresult: ((event: BackgroundRecognitionResultEvent) => void) | null = null;
  onerror: ((event: BackgroundRecognitionErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;
  private active = false;

  constructor() { instances.add(this); }

  start(): void {
    if (this.active) return;
    this.active = true;
    void startBackgroundRecognition(this).catch((error: unknown) => {
      this.active = false;
      this.onerror?.(createErrorEvent(error instanceof Error ? error.message : "not-allowed"));
      this.onend?.();
    });
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    void chrome.runtime.sendMessage({ type: "PAUSE_WAKE_LISTENER" }).catch(() => undefined);
    this.onend?.();
  }

  abort(): void {
    this.active = false;
    void chrome.runtime.sendMessage({ type: "PAUSE_WAKE_LISTENER" }).catch(() => undefined);
    this.onend?.();
  }

  emitTranscript(transcript: string): void {
    if (!this.active || !transcript.trim()) return;
    const result = { isFinal: true, 0: { transcript } };
    const results = {
      0: result,
      length: 1,
      item(index: number) { return index === 0 ? result : null; }
    } as unknown as BackgroundRecognitionResultEvent["results"];
    this.onresult?.({ type: "result", resultIndex: 0, results } as BackgroundRecognitionResultEvent);
    if (!this.continuous) {
      this.active = false;
      this.onend?.();
    }
  }

  emitStatus(status?: string, error?: string): void {
    if (!this.active) return;
    if (status === "listening" || status === "ready") this.onstart?.();
    if (status === "unavailable" || status === "error") this.onerror?.(createErrorEvent(error || "service-not-allowed"));
  }
}

installRecognitionProxy();
installRuntimeBridge();
installAutomaticStartup();

function installRecognitionProxy(): void {
  const target = window as unknown as {
    SpeechRecognition?: typeof NeptuneBackgroundRecognition;
    webkitSpeechRecognition?: typeof NeptuneBackgroundRecognition;
  };
  target.SpeechRecognition = NeptuneBackgroundRecognition;
  target.webkitSpeechRecognition = NeptuneBackgroundRecognition;
}

function installRuntimeBridge(): void {
  chrome.runtime.onMessage.addListener((message: WakeStatusMessage) => {
    if (message?.target !== "neptune-sidepanel") return false;
    if (message.type === "WAKE_TRANSCRIPT" && message.transcript) {
      for (const instance of instances) instance.emitTranscript(message.transcript);
    }
    if (message.type === "WAKE_STATUS") {
      for (const instance of instances) instance.emitStatus(message.status, message.error);
      window.dispatchEvent(new CustomEvent("neptune-background-wake-status", { detail: message }));
    }
    return false;
  });
}

function installAutomaticStartup(): void {
  new MutationObserver(() => void maybeAutoStart()).observe(document.documentElement, { childList: true, subtree: true });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[PREFERENCES_KEY]) return;
    void syncWakePreference();
  });
  void maybeAutoStart();
}

async function maybeAutoStart(): Promise<void> {
  if (autoStarted) return;
  const button = document.querySelector<HTMLButtonElement>("button[data-action='toggle-micro']");
  if (!button) return;
  const preferences = await loadPreferences();
  if (!preferences.onboardingComplete || !preferences.wakeWordEnabled) return;
  autoStarted = true;
  button.click();
}

async function syncWakePreference(): Promise<void> {
  const preferences = await loadPreferences();
  if (!preferences.wakeWordEnabled) {
    autoStarted = false;
    await chrome.runtime.sendMessage({ type: "STOP_WAKE_LISTENER" }).catch(() => undefined);
    return;
  }
  await maybeAutoStart();
}

async function startBackgroundRecognition(instance: NeptuneBackgroundRecognition): Promise<void> {
  await primeMicrophonePermission();
  const preferences = await loadPreferences();
  const response = await chrome.runtime.sendMessage({
    type: "START_WAKE_LISTENER",
    config: {
      wakeWord: "OK Neptune",
      wakeWordEnabled: preferences.wakeWordEnabled !== false,
      language: instance.lang || "fr-FR",
      oneShot: !instance.continuous
    }
  }) as { ok?: boolean; error?: { message?: string } | string };
  if (!response?.ok) {
    const message = typeof response?.error === "string" ? response.error : response?.error?.message;
    throw new Error(message || "L’écoute vocale hors écran n’a pas pu démarrer.");
  }
  instance.onstart?.();
  await deliverPendingTranscript(instance);
}

async function deliverPendingTranscript(instance: NeptuneBackgroundRecognition): Promise<void> {
  const stored = await chrome.storage.session.get(PENDING_TRANSCRIPT_KEY);
  const transcript = stored[PENDING_TRANSCRIPT_KEY];
  if (typeof transcript !== "string" || !transcript.trim()) return;
  await chrome.storage.session.remove(PENDING_TRANSCRIPT_KEY);
  window.setTimeout(() => instance.emitTranscript(transcript), 250);
}

async function primeMicrophonePermission(): Promise<void> {
  if (microphonePermissionPrimed) return;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("La capture microphone n’est pas disponible dans cette version de Chrome.");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of stream.getTracks()) track.stop();
  microphonePermissionPrimed = true;
}

async function loadPreferences(): Promise<WakePreferences> {
  const stored = await chrome.storage.local.get(PREFERENCES_KEY);
  return (stored[PREFERENCES_KEY] as WakePreferences | undefined) ?? {};
}

function createErrorEvent(error: string): BackgroundRecognitionErrorEvent {
  return { type: "error", error } as BackgroundRecognitionErrorEvent;
}

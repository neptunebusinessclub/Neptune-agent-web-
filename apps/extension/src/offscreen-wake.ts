type WakeConfig = {
  wakeWord: "Neptune" | "OK Neptune";
  wakeWordEnabled: boolean;
  language: string;
  oneShot: boolean;
};

type WakeMessage =
  | { target: "neptune-offscreen"; type: "WAKE_START"; config: WakeConfig }
  | { target: "neptune-offscreen"; type: "WAKE_PAUSE" }
  | { target: "neptune-offscreen"; type: "WAKE_STOP" }
  | { target: "neptune-offscreen"; type: "WAKE_STATUS" };

type SpeechRecognitionEventLike = Event & {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};

type SpeechRecognitionErrorEventLike = Event & { error: string };

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort?(): void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

let config: WakeConfig = {
  wakeWord: "OK Neptune",
  wakeWordEnabled: true,
  language: "fr-FR",
  oneShot: false
};
let recognition: SpeechRecognitionLike | null = null;
let desired = false;
let paused = true;
let running = false;
let waitingForCommand = false;
let restartTimer: number | undefined;

chrome.runtime.onMessage.addListener((message: WakeMessage, _sender, sendResponse) => {
  if (message?.target !== "neptune-offscreen") return false;
  void handleMessage(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error: unknown) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Erreur d’écoute hors écran"
    }));
  return true;
});

void reportStatus("ready");

async function handleMessage(message: WakeMessage): Promise<Record<string, unknown>> {
  switch (message.type) {
    case "WAKE_START":
      config = message.config;
      desired = true;
      paused = false;
      waitingForCommand = false;
      startRecognition();
      return statusSnapshot();
    case "WAKE_PAUSE":
      paused = true;
      waitingForCommand = false;
      stopRecognition(false);
      await reportStatus("paused");
      return statusSnapshot();
    case "WAKE_STOP":
      desired = false;
      paused = true;
      waitingForCommand = false;
      stopRecognition(true);
      await reportStatus("stopped");
      return statusSnapshot();
    case "WAKE_STATUS":
      return statusSnapshot();
  }
}

function ensureRecognition(): SpeechRecognitionLike {
  if (recognition) return recognition;
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!Recognition) {
    void reportStatus("unavailable", "La reconnaissance vocale hors écran n’est pas disponible dans cette version de Chrome.");
    throw new Error("La reconnaissance vocale hors écran n’est pas disponible.");
  }

  recognition = new Recognition();
  recognition.lang = config.language;
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => {
    running = true;
    void reportStatus("listening");
  };
  recognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (!result?.isFinal) continue;
      handleTranscript(result[0]?.transcript ?? "");
    }
  };
  recognition.onerror = (event) => {
    const ignorable = event.error === "aborted" || event.error === "no-speech";
    if (!ignorable) void reportStatus("error", event.error);
  };
  recognition.onend = () => {
    running = false;
    if (desired && !paused) scheduleRestart();
    else void reportStatus(paused ? "paused" : "stopped");
  };
  return recognition;
}

function startRecognition(): void {
  window.clearTimeout(restartTimer);
  const instance = ensureRecognition();
  instance.lang = config.language;
  if (running) return;
  try {
    instance.start();
  } catch {
    scheduleRestart();
  }
}

function stopRecognition(abort: boolean): void {
  window.clearTimeout(restartTimer);
  if (!recognition || !running) return;
  try {
    if (abort) recognition.abort?.();
    else recognition.stop();
  } catch {
    running = false;
  }
}

function scheduleRestart(): void {
  window.clearTimeout(restartTimer);
  restartTimer = window.setTimeout(() => {
    if (!desired || paused) return;
    startRecognition();
  }, 450);
}

function handleTranscript(raw: string): void {
  const transcript = raw.replace(/\s+/g, " ").trim();
  if (!transcript) return;

  if (!config.wakeWordEnabled) {
    void emitTranscript(transcript);
    if (config.oneShot) {
      paused = true;
      stopRecognition(false);
    }
    return;
  }

  if (waitingForCommand) {
    waitingForCommand = false;
    void emitTranscript(`${config.wakeWord} ${transcript}`);
    return;
  }

  const normalized = normalize(transcript);
  const candidates = [config.wakeWord, "OK Neptune", "Neptune"].map(normalize);
  const detected = candidates.find((candidate) => normalized.includes(candidate));
  if (!detected) return;

  const index = normalized.indexOf(detected);
  const command = transcript.slice(Math.max(0, index + detected.length)).replace(/^[,.:;!?\s-]+/, "").trim();
  if (command) {
    void emitTranscript(`${config.wakeWord} ${command}`);
  } else {
    waitingForCommand = true;
    void reportStatus("awaiting-command");
  }
}

async function emitTranscript(transcript: string): Promise<void> {
  await chrome.runtime.sendMessage({
    type: "BACKGROUND_WAKE_TRANSCRIPT",
    transcript,
    wakeWord: config.wakeWord,
    occurredAt: new Date().toISOString()
  });
  await reportStatus("command-detected");
}

async function reportStatus(status: string, error?: string): Promise<void> {
  await chrome.runtime.sendMessage({
    type: "WAKE_DOCUMENT_STATUS",
    status,
    ...(error ? { error } : {}),
    occurredAt: new Date().toISOString()
  }).catch(() => undefined);
}

function statusSnapshot(): Record<string, unknown> {
  return {
    desired,
    paused,
    running,
    waitingForCommand,
    wakeWord: config.wakeWord,
    wakeWordEnabled: config.wakeWordEnabled
  };
}

function normalize(value: string): string {
  return value.toLocaleLowerCase("fr-FR").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

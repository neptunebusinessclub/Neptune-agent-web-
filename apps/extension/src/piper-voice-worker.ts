import * as piper from "@mintplex-labs/piper-tts-web";

export {};

type WorkerRequest =
  | { type: "LIST"; requestId: string }
  | { type: "STORED"; requestId: string }
  | { type: "DOWNLOAD"; requestId: string; voiceId: string }
  | { type: "SYNTHESIZE"; requestId: string; voiceId: string; text: string }
  | { type: "REMOVE"; requestId: string; voiceId: string };

type EmbeddedVoice = {
  name: string;
  files: readonly [string, string];
};

const EMBEDDED_VOICES = {
  "fr_FR-siwis-medium": {
    name: "Voix féminine",
    files: ["fr_FR-siwis-medium.onnx", "fr_FR-siwis-medium.onnx.json"]
  },
  "fr_FR-upmc-medium": {
    name: "Voix masculine",
    files: ["fr_FR-upmc-medium.onnx", "fr_FR-upmc-medium.onnx.json"]
  }
} as const satisfies Record<string, EmbeddedVoice>;

const nativeFetch = globalThis.fetch.bind(globalThis);
const extensionRoot = new URL("./", self.location.href);
const runtime = globalThis as typeof globalThis & { fetch: typeof fetch };
let operationQueue: Promise<void> = Promise.resolve();
let activeVoiceId = "";

runtime.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const sourceUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const file = Object.values(EMBEDDED_VOICES)
    .flatMap((voice) => [...voice.files])
    .find((candidate) => sourceUrl.endsWith(`/${candidate}`) || sourceUrl.endsWith(candidate));
  if (file) return nativeFetch(new URL(`voices/${file}`, extensionRoot));
  return nativeFetch(input, init);
};

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  operationQueue = operationQueue.then(() => handle(request)).catch((error: unknown) => {
    postMessage({
      type: "ERROR",
      requestId: request.requestId,
      message: error instanceof Error ? error.message : "Erreur vocale locale inconnue"
    });
  });
};

async function handle(request: WorkerRequest): Promise<void> {
  switch (request.type) {
    case "LIST":
      postMessage({ type: "RESULT", requestId: request.requestId, result: EMBEDDED_VOICES });
      return;
    case "STORED":
      postMessage({ type: "RESULT", requestId: request.requestId, result: await listStoredVoices() });
      return;
    case "DOWNLOAD":
      assertEmbeddedVoice(request.voiceId);
      await installEmbeddedVoice(request.voiceId, request.requestId);
      postMessage({ type: "RESULT", requestId: request.requestId, result: { ready: true, voiceId: request.voiceId } });
      return;
    case "SYNTHESIZE": {
      assertEmbeddedVoice(request.voiceId);
      const cleanText = request.text.trim().slice(0, 2_000);
      if (!cleanText) throw new Error("Aucun texte n’a été fourni au moteur vocal.");
      await installEmbeddedVoice(request.voiceId, request.requestId, false);
      resetSessionForVoice(request.voiceId);
      const wav = await piper.predict({ text: cleanText, voiceId: request.voiceId });
      const buffer = await wav.arrayBuffer();
      if (buffer.byteLength < 1_024) throw new Error("Le moteur vocal a généré un audio incomplet.");
      postMessage({
        type: "AUDIO",
        requestId: request.requestId,
        voiceId: request.voiceId,
        mimeType: wav.type || "audio/wav",
        buffer
      }, { transfer: [buffer] });
      return;
    }
    case "REMOVE":
      assertEmbeddedVoice(request.voiceId);
      await removeEmbeddedVoice(request.voiceId);
      if (activeVoiceId === request.voiceId) resetPiperSession();
      postMessage({ type: "RESULT", requestId: request.requestId, result: { removed: true, voiceId: request.voiceId } });
  }
}

async function installEmbeddedVoice(voiceId: keyof typeof EMBEDDED_VOICES, requestId: string, reportProgress = true): Promise<void> {
  const voice = EMBEDDED_VOICES[voiceId];
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle("piper", { create: true });
  let completed = 0;

  for (const fileName of voice.files) {
    const response = await nativeFetch(new URL(`voices/${fileName}`, extensionRoot));
    if (!response.ok) throw new Error(`Ressource vocale introuvable : ${fileName}`);
    const expectedSize = Number(response.headers.get("content-length") ?? 0);
    const blob = await response.blob();
    if (blob.size < 1_024 || (expectedSize > 0 && blob.size !== expectedSize)) {
      throw new Error(`Ressource vocale incomplète : ${fileName}`);
    }

    const current = await readStoredFile(directory, fileName);
    if (!current || current.size !== blob.size) {
      const handle = await directory.getFileHandle(fileName, { create: true });
      const writable = await handle.createWritable({ keepExistingData: false });
      await writable.write(blob);
      await writable.close();
      const verified = await (await directory.getFileHandle(fileName)).getFile();
      if (verified.size !== blob.size) throw new Error(`Écriture OPFS incomplète : ${fileName}`);
    }

    completed += 1;
    if (reportProgress) {
      postMessage({
        type: "PROGRESS",
        requestId,
        voiceId,
        loaded: completed,
        total: voice.files.length,
        progress: completed / voice.files.length,
        file: `Vérification de ${fileName}`
      });
    }
  }
}

async function readStoredFile(directory: FileSystemDirectoryHandle, fileName: string): Promise<File | null> {
  try {
    return await (await directory.getFileHandle(fileName)).getFile();
  } catch {
    return null;
  }
}

async function listStoredVoices(): Promise<string[]> {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle("piper", { create: true });
  const stored: string[] = [];
  for (const [voiceId, voice] of Object.entries(EMBEDDED_VOICES)) {
    const files = await Promise.all(voice.files.map((fileName) => readStoredFile(directory, fileName)));
    if (files.every((file) => file && file.size >= 1_024)) stored.push(voiceId);
  }
  return stored;
}

async function removeEmbeddedVoice(voiceId: keyof typeof EMBEDDED_VOICES): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle("piper", { create: true });
  for (const fileName of EMBEDDED_VOICES[voiceId].files) {
    await directory.removeEntry(fileName).catch(() => undefined);
  }
}

function resetSessionForVoice(voiceId: string): void {
  if (activeVoiceId === voiceId) return;
  resetPiperSession();
  activeVoiceId = voiceId;
}

function resetPiperSession(): void {
  const sessionClass = piper.TtsSession as typeof piper.TtsSession & { _instance: unknown };
  sessionClass._instance = null;
  activeVoiceId = "";
}

function assertEmbeddedVoice(voiceId: string): asserts voiceId is keyof typeof EMBEDDED_VOICES {
  if (!(voiceId in EMBEDDED_VOICES)) throw new Error("Cette voix n’est pas incluse dans Neptune.");
}

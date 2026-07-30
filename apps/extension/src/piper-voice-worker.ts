import * as piper from "@mintplex-labs/piper-tts-web";

export {};

type WorkerRequest =
  | { type: "LIST"; requestId: string }
  | { type: "STORED"; requestId: string }
  | { type: "DOWNLOAD"; requestId: string; voiceId: string }
  | { type: "SYNTHESIZE"; requestId: string; voiceId: string; text: string }
  | { type: "REMOVE"; requestId: string; voiceId: string };

type ProgressPayload = {
  url?: string;
  loaded?: number;
  total?: number;
};

const EMBEDDED_VOICES = {
  "fr_FR-siwis-medium": {
    name: "Voix féminine",
    files: ["fr_FR-siwis-medium.onnx", "fr_FR-siwis-medium.onnx.json"]
  },
  "fr_FR-tom-medium": {
    name: "Voix masculine",
    files: ["fr_FR-tom-medium.onnx", "fr_FR-tom-medium.onnx.json"]
  }
} as const;

const nativeFetch = globalThis.fetch.bind(globalThis);
const extensionRoot = new URL("./", self.location.href);
const runtime = globalThis as typeof globalThis & { fetch: typeof fetch };
let operationQueue: Promise<void> = Promise.resolve();

runtime.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const sourceUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const file = Object.values(EMBEDDED_VOICES)
    .flatMap((voice) => voice.files)
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
    case "STORED": {
      const stored = await piper.stored();
      postMessage({ type: "RESULT", requestId: request.requestId, result: stored });
      return;
    }
    case "DOWNLOAD": {
      assertEmbeddedVoice(request.voiceId);
      await piper.download(request.voiceId, (progress: ProgressPayload) => {
        const loaded = typeof progress.loaded === "number" ? progress.loaded : 0;
        const total = typeof progress.total === "number" ? progress.total : 0;
        postMessage({
          type: "PROGRESS",
          requestId: request.requestId,
          voiceId: request.voiceId,
          loaded,
          total,
          progress: total > 0 ? loaded / total : 0,
          file: progress.url ?? "Préparation de la voix intégrée"
        });
      });
      postMessage({ type: "RESULT", requestId: request.requestId, result: { ready: true, voiceId: request.voiceId } });
      return;
    }
    case "SYNTHESIZE": {
      assertEmbeddedVoice(request.voiceId);
      const cleanText = request.text.trim().slice(0, 2_000);
      if (!cleanText) throw new Error("Aucun texte n’a été fourni au moteur vocal.");
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
      await piper.remove(request.voiceId);
      postMessage({ type: "RESULT", requestId: request.requestId, result: { removed: true, voiceId: request.voiceId } });
  }
}

function assertEmbeddedVoice(voiceId: string): asserts voiceId is keyof typeof EMBEDDED_VOICES {
  if (!(voiceId in EMBEDDED_VOICES)) throw new Error("Cette voix n’est pas incluse dans Neptune.");
}

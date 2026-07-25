import * as piper from "@mintplex-labs/piper-tts-web";

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

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  void handle(event.data).catch((error: unknown) => {
    postMessage({
      type: "ERROR",
      requestId: event.data.requestId,
      message: error instanceof Error ? error.message : "Erreur vocale locale inconnue"
    });
  });
};

async function handle(request: WorkerRequest): Promise<void> {
  switch (request.type) {
    case "LIST": {
      const voices = await piper.voices();
      postMessage({ type: "RESULT", requestId: request.requestId, result: voices });
      return;
    }
    case "STORED": {
      const stored = await piper.stored();
      postMessage({ type: "RESULT", requestId: request.requestId, result: stored });
      return;
    }
    case "DOWNLOAD": {
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
          file: progress.url ?? ""
        });
      });
      postMessage({ type: "RESULT", requestId: request.requestId, result: { ready: true, voiceId: request.voiceId } });
      return;
    }
    case "SYNTHESIZE": {
      const wav = await piper.predict({
        text: request.text.slice(0, 2_000),
        voiceId: request.voiceId
      });
      const buffer = await wav.arrayBuffer();
      postMessage({
        type: "AUDIO",
        requestId: request.requestId,
        voiceId: request.voiceId,
        mimeType: wav.type || "audio/wav",
        buffer
      }, { transfer: [buffer] });
      return;
    }
    case "REMOVE": {
      await piper.remove(request.voiceId);
      postMessage({ type: "RESULT", requestId: request.requestId, result: { removed: true, voiceId: request.voiceId } });
    }
  }
}

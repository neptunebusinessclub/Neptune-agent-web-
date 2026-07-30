import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const voiceDestination = path.join(root, "apps", "extension", "static", "voices");
const runtimeDestination = path.join(voiceDestination, "runtime");

const resources = [
  {
    target: path.join(voiceDestination, "fr_FR-siwis-medium.onnx"),
    label: "fr_FR-siwis-medium.onnx",
    url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx",
    md5: "20e876e8c839e9b11a26085858f2300c"
  },
  {
    target: path.join(voiceDestination, "fr_FR-siwis-medium.onnx.json"),
    label: "fr_FR-siwis-medium.onnx.json",
    url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx.json",
    md5: "a407e7e6901feb79c2ea2a5466076cce"
  },
  {
    target: path.join(voiceDestination, "fr_FR-upmc-medium.onnx"),
    label: "fr_FR-upmc-medium.onnx",
    url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/upmc/medium/fr_FR-upmc-medium.onnx",
    md5: "6837ede9408c7e1b39fa4a126af9e865"
  },
  {
    target: path.join(voiceDestination, "fr_FR-upmc-medium.onnx.json"),
    label: "fr_FR-upmc-medium.onnx.json",
    url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/upmc/medium/fr_FR-upmc-medium.onnx.json",
    md5: "574571ae93aba72dbd159582981037da"
  },
  {
    target: path.join(runtimeDestination, "piper_phonemize.data"),
    label: "piper_phonemize.data",
    url: "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data"
  },
  {
    target: path.join(runtimeDestination, "piper_phonemize.wasm"),
    label: "piper_phonemize.wasm",
    url: "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.wasm"
  },
  {
    target: path.join(runtimeDestination, "ort-wasm-simd-threaded.jsep.mjs"),
    label: "ort-wasm-simd-threaded.jsep.mjs",
    url: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort-wasm-simd-threaded.jsep.mjs"
  },
  {
    target: path.join(runtimeDestination, "ort-wasm-simd-threaded.jsep.wasm"),
    label: "ort-wasm-simd-threaded.jsep.wasm",
    url: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort-wasm-simd-threaded.jsep.wasm"
  }
];

await mkdir(voiceDestination, { recursive: true });
await mkdir(runtimeDestination, { recursive: true });
await Promise.all([
  rm(path.join(voiceDestination, "fr_FR-tom-medium.onnx"), { force: true }),
  rm(path.join(voiceDestination, "fr_FR-tom-medium.onnx.json"), { force: true })
]);

for (const resource of resources) {
  const current = await readFile(resource.target).catch(() => null);
  if (current && isValid(current, resource.md5)) {
    console.log(`Ressource vocale Neptune déjà prête : ${resource.label}`);
    continue;
  }

  console.log(`Intégration de la ressource vocale Neptune : ${resource.label}`);
  const response = await fetch(resource.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Téléchargement impossible pour ${resource.label} : HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!isValid(bytes, resource.md5)) throw new Error(`Ressource invalide ou incomplète : ${resource.label}.`);
  await writeFile(resource.target, bytes);
}

function isValid(value, expectedMd5) {
  if (value.byteLength < 1_024) return false;
  return expectedMd5 ? digest(value) === expectedMd5 : true;
}

function digest(value) {
  return createHash("md5").update(value).digest("hex");
}

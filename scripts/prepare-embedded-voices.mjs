import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "apps", "extension", "static", "voices");

const voices = [
  {
    file: "fr_FR-siwis-medium.onnx",
    url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx",
    md5: "20e876e8c839e9b11a26085858f2300c"
  },
  {
    file: "fr_FR-siwis-medium.onnx.json",
    url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx.json",
    md5: "a407e7e6901feb79c2ea2a5466076cce"
  },
  {
    file: "fr_FR-tom-medium.onnx",
    url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/tom/medium/fr_FR-tom-medium.onnx",
    md5: "5b460c2394a871e675f5c798af149412"
  },
  {
    file: "fr_FR-tom-medium.onnx.json",
    url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/tom/medium/fr_FR-tom-medium.onnx.json",
    md5: "964d58602df7adf76c2401b070f68ea2"
  }
];

await mkdir(destination, { recursive: true });

for (const voice of voices) {
  const target = path.join(destination, voice.file);
  const current = await readFile(target).catch(() => null);
  if (current && digest(current) === voice.md5) {
    console.log(`Voix Neptune déjà prête : ${voice.file}`);
    continue;
  }

  console.log(`Intégration de la voix Neptune : ${voice.file}`);
  const response = await fetch(voice.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Téléchargement impossible pour ${voice.file} : HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = digest(bytes);
  if (actual !== voice.md5) {
    throw new Error(`Empreinte invalide pour ${voice.file}. Attendue ${voice.md5}, obtenue ${actual}.`);
  }
  await writeFile(target, bytes);
}

function digest(value) {
  return createHash("md5").update(value).digest("hex");
}

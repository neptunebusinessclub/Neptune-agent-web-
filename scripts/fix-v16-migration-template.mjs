import { readFile, writeFile } from "node:fs/promises";

const path = "scripts/apply-v16-hardening.mjs";
const original = await readFile(path, "utf8");
const pattern = /appendAudit\("LOCAL_BRAIN_FALLBACK",\s*`[^`]+`\);/;
const replacement = 'appendAudit("LOCAL_BRAIN_FALLBACK", `\\${modelId}: \\${errorMessage(error)}`);';
if (!pattern.test(original)) {
  if (original.includes('`\\${modelId}: \\${errorMessage(error)}`')) process.exit(0);
  throw new Error("Migration template target not found");
}
await writeFile(path, original.replace(pattern, replacement));

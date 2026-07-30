import { readFile, writeFile } from "node:fs/promises";

const path = "scripts/apply-v16-hardening.mjs";
const original = await readFile(path, "utf8");
const target = 'appendAudit("LOCAL_BRAIN_FALLBACK", `${modelId}: ${errorMessage(error)}`);';
const replacement = 'appendAudit("LOCAL_BRAIN_FALLBACK", `\\${modelId}: \\${errorMessage(error)}`);';
if (!original.includes(target)) {
  if (original.includes(replacement)) process.exit(0);
  throw new Error("Migration template target not found");
}
await writeFile(path, original.replace(target, replacement));

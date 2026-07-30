import { readFile, writeFile } from "node:fs/promises";

const path = "scripts/apply-v16-hardening.mjs";
const original = await readFile(path, "utf8");
const marker = 'appendAudit("LOCAL_BRAIN_FALLBACK", `';
const start = original.indexOf(marker);
if (start < 0) throw new Error("Migration template start marker not found");
const end = original.indexOf('`);', start);
if (end < 0) throw new Error("Migration template end marker not found");
const replacement = 'appendAudit("LOCAL_BRAIN_FALLBACK", `\\${modelId}: \\${errorMessage(error)}`);';
const next = original.slice(0, start) + replacement + original.slice(end + 3);
await writeFile(path, next);

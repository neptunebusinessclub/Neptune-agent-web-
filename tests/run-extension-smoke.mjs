import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const installation = spawnSync(pnpm, ["dlx", "playwright@1.55.0", "install", "chromium"], {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32"
});
if (installation.error) throw installation.error;
if (installation.status !== 0) {
  throw new Error(`Chromium provisioning failed with exit code ${installation.status ?? "unknown"}`);
}

const cacheRoot = process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== "0"
  ? path.resolve(process.env.PLAYWRIGHT_BROWSERS_PATH)
  : path.join(os.homedir(), ".cache", "ms-playwright");
const binary = findChromium(cacheRoot);
if (!binary) throw new Error(`Playwright Chromium was installed but no browser binary was found under ${cacheRoot}`);
console.log(`Neptune smoke test Chromium: ${binary}`);
process.env.CHROME_BIN = binary;
await import("./extension-smoke-cdp.mjs");

function findChromium(root) {
  if (!existsSync(root)) return "";
  const preferred = [];
  walk(root, preferred);
  return preferred.find((candidate) => /chromium-[^/\\]+[/\\]chrome-linux[/\\]chrome$/.test(candidate))
    ?? preferred.find((candidate) => /chromium-[^/\\]+[/\\]chrome-win[/\\]chrome\.exe$/.test(candidate))
    ?? preferred.find((candidate) => /Chromium\.app[/\\]Contents[/\\]MacOS[/\\]Chromium$/.test(candidate))
    ?? "";
}

function walk(directory, results) {
  for (const name of readdirSync(directory)) {
    const entry = path.join(directory, name);
    let stat;
    try { stat = statSync(entry); } catch { continue; }
    if (stat.isDirectory()) {
      if (!name.includes("headless_shell")) walk(entry, results);
    } else if (name === "chrome" || name === "chrome.exe" || name === "Chromium") {
      results.push(entry);
    }
  }
}

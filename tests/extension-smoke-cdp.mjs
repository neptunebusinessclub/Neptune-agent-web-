import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

if (process.platform === "linux" && !process.env.DISPLAY && process.env.NEPTUNE_XVFB_CHILD !== "1") {
  const xvfb = spawnSync("xvfb-run", ["-a", process.execPath, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, NEPTUNE_XVFB_CHILD: "1" }
  });
  process.exit(xvfb.status ?? 1);
}

const extensionPath = path.resolve("apps/extension/dist");
const userDataDir = await mkdtemp(path.join(os.tmpdir(), "neptune-cdp-"));
const chromeBinary = findChrome();

const chrome = spawn(chromeBinary, [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--remote-debugging-port=0",
  `--user-data-dir=${userDataDir}`,
  `--disable-extensions-except=${extensionPath}`,
  `--load-extension=${extensionPath}`,
  "--autoplay-policy=no-user-gesture-required",
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--disable-component-update",
  "--no-default-browser-check",
  "--no-first-run",
  "about:blank"
], { stdio: ["ignore", "pipe", "pipe"] });

let chromeOutput = "";
chrome.stdout.on("data", (chunk) => { chromeOutput += chunk.toString(); });
chrome.stderr.on("data", (chunk) => { chromeOutput += chunk.toString(); });

try {
  const port = await waitForDevToolsPort(userDataDir, chrome);
  const extensionTarget = await waitForExtensionWorker(port);
  const extensionId = new URL(extensionTarget.url).host;
  const startupUrl = `chrome-extension://${extensionId}/sidepanel.html`;
  const pageTarget = await waitForPageTarget(port);
  const cdp = createCdpClient(pageTarget.webSocketDebuggerUrl);
  const exceptions = [];
  const consoleErrors = [];
  cdp.on("Runtime.exceptionThrown", (params) => {
    exceptions.push(params?.exceptionDetails?.text ?? "Unknown page exception");
  });
  cdp.on("Runtime.consoleAPICalled", (params) => {
    if (params?.type === "error") consoleErrors.push((params.args ?? []).map((arg) => arg.value ?? arg.description ?? "").join(" "));
  });

  await cdp.connect();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: startupUrl });
  await ensureOnboardingLoaded(cdp, startupUrl);

  assert(await evaluate(cdp, `document.querySelector("button[data-action='onboarding-next']").disabled === true`), "Continue must start disabled");
  await evaluate(cdp, `(() => { const input = document.querySelector("#preferred-name"); input.value = "Johan"; input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await waitFor(cdp, `document.querySelector("button[data-action='onboarding-next']").disabled === false`, 5_000);
  await evaluate(cdp, `document.querySelector("button[data-action='onboarding-next']").click()`);
  await waitFor(cdp, `document.body.innerText.includes("Préférez-vous une voix féminine ou masculine")`, 10_000);

  await evaluate(cdp, `document.querySelector("button[data-action='preview-gender'][data-value='female']").click()`);
  await waitForPlayback(cdp, "fr_FR-siwis-medium", 120_000);
  await waitForAudit(cdp, "Voix féminine", 120_000);
  await assertNoVoiceFailure(cdp, exceptions, consoleErrors, "female");

  await evaluate(cdp, `document.querySelector("button[data-action='preview-gender'][data-value='male']").click()`);
  await waitForPlayback(cdp, "fr_FR-upmc-medium", 120_000);
  await waitForAudit(cdp, "Voix masculine", 120_000);
  await assertNoVoiceFailure(cdp, exceptions, consoleErrors, "male");

  await evaluate(cdp, `document.querySelector("button[data-action='onboarding-next']").click()`);
  await waitFor(cdp, `document.body.innerText.includes("Dites « Neptune » ou « OK Neptune »")`, 10_000);
  await evaluate(cdp, `document.querySelector("button[data-action='test-activation']").click()`);
  await delay(1_500);
  const permissionText = await evaluate(cdp, `document.body.innerText`);
  assert(!/Permission dismissed/i.test(permissionText), "The microphone flow exposed the raw Permission dismissed error");

  const stopState = await evaluate(cdp, `(async () => {
    await chrome.runtime.sendMessage({ type: "START_MISSION", workspaceMode: "new-tab" });
    await chrome.runtime.sendMessage({ type: "STOP_MISSION" });
    const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    return status?.result?.stopped === true && status?.result?.missionControl?.status === "stopped";
  })()`);
  assert(stopState, "Mission stop state is not persisted in chrome.storage.session");

  const browserCdp = createCdpClient(await getBrowserWebSocketUrl(port));
  await browserCdp.connect();
  try {
    await browserCdp.send("Target.closeTarget", { targetId: extensionTarget.id });
  } catch (error) {
    if (!/No target with given id found/i.test(error instanceof Error ? error.message : String(error))) throw error;
  }
  await waitForTargetGone(port, extensionTarget.id, 10_000);
  await browserCdp.close();

  await waitFor(cdp, `(async () => {
    try {
      const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
      return status?.result?.stopped === true && status?.result?.missionControl?.status === "stopped";
    } catch {
      return false;
    }
  })()`, 15_000);

  await cdp.close();
  console.log(`Neptune Chromium smoke test passed with audible premium voices, guarded microphone flow and durable stop state for extension ${extensionId}.`);
} catch (error) {
  console.error(chromeOutput.slice(-8_000));
  throw error;
} finally {
  await stopProcess(chrome);
  await removeDirectoryWithRetry(userDataDir);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) throw new Error("No Chromium or Chrome binary found on the CI runner");
  return match;
}

async function waitForDevToolsPort(directory, processHandle) {
  const file = path.join(directory, "DevToolsActivePort");
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (processHandle.exitCode !== null) throw new Error(`Chrome exited early with code ${processHandle.exitCode}`);
    if (existsSync(file)) {
      const [port] = (await readFile(file, "utf8")).trim().split(/\s+/);
      if (port) return Number(port);
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for Chrome DevTools port");
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`Cannot list Chrome targets: HTTP ${response.status}`);
  return response.json();
}

async function getBrowserWebSocketUrl(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!response.ok) throw new Error(`Cannot read Chrome version endpoint: HTTP ${response.status}`);
  const version = await response.json();
  if (!version.webSocketDebuggerUrl) throw new Error("Chrome browser CDP endpoint is missing");
  return version.webSocketDebuggerUrl;
}

async function waitForExtensionWorker(port) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const targets = await listTargets(port).catch(() => []);
    const target = targets.find((item) => ["service_worker", "background_page"].includes(item.type) && /^chrome-extension:\/\/.+\/service-worker\.js/.test(item.url));
    if (target?.webSocketDebuggerUrl) return target;
    await delay(100);
  }
  throw new Error("Neptune service worker was not activated by Chrome");
}

async function waitForTargetGone(port, targetId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await listTargets(port).catch(() => []);
    if (!targets.some((target) => target.id === targetId)) return;
    await delay(100);
  }
  throw new Error("The Neptune service worker did not stop when requested");
}

async function waitForPageTarget(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const targets = await listTargets(port).catch(() => []);
    const target = targets.find((item) => item.type === "page" && item.url === "about:blank") ?? targets.find((item) => item.type === "page");
    if (target?.webSocketDebuggerUrl) return target;
    await delay(100);
  }
  throw new Error("No controllable Chrome page target is available");
}

async function ensureOnboardingLoaded(cdp, url) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      await cdp.send("Page.navigate", { url });
      await delay(500);
    }
    try {
      await waitFor(cdp, `document.readyState === "complete" && Boolean(document.querySelector("#preferred-name"))`, 20_000);
      return;
    } catch (error) {
      if (attempt === 1) {
        const diagnostic = await evaluate(cdp, `({ href: location.href, title: document.title, body: document.body?.innerText?.slice(0, 1000) ?? "", html: document.documentElement?.outerHTML?.slice(0, 2000) ?? "" })`).catch(() => ({}));
        throw new Error(`Neptune onboarding did not load: ${JSON.stringify(diagnostic)}; ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

async function waitForAudit(cdp, detail, timeoutMs) {
  await waitFor(cdp, `(async () => {
    const stored = await chrome.storage.local.get("neptune.audit.v2");
    const audit = Array.isArray(stored["neptune.audit.v2"]) ? stored["neptune.audit.v2"] : [];
    return audit.some((entry) => entry?.type === "VOICE_READY" && entry?.detail === ${JSON.stringify(detail)});
  })()`, timeoutMs);
}

async function waitForPlayback(cdp, voiceId, timeoutMs) {
  await waitFor(cdp, `document.documentElement.dataset.neptuneVoiceId === ${JSON.stringify(voiceId)} && document.documentElement.dataset.neptuneVoicePlayback === "ended"`, timeoutMs);
}

async function assertNoVoiceFailure(cdp, exceptions, consoleErrors, label) {
  const bodyText = await evaluate(cdp, `document.body.innerText`);
  assert(!bodyText.includes("Uncaught ReferenceError"), `The ${label} voice exposed an uncaught ReferenceError`);
  assert(!bodyText.includes("chrome is not defined"), `The ${label} voice worker still depends on chrome.*`);
  assert(!bodyText.includes("La voix n’a pas pu démarrer"), `The embedded ${label} voice failed its real Chromium smoke test`);
  assert(exceptions.length === 0, `Page exceptions after ${label} voice: ${exceptions.join(" | ")}`);
  assert(consoleErrors.filter((message) => /ReferenceError|chrome is not defined|Worker/i.test(message)).length === 0, `Console errors after ${label} voice: ${consoleErrors.join(" | ")}`);
}

function createCdpClient(url) {
  let socket;
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  return {
    async connect() {
      socket = new WebSocket(url);
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.id) {
          const request = pending.get(message.id);
          if (!request) return;
          pending.delete(message.id);
          if (message.error) request.reject(new Error(message.error.message));
          else request.resolve(message.result);
          return;
        }
        for (const listener of listeners.get(message.method) ?? []) listener(message.params);
      });
    },
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) ?? []), listener]);
    },
    async close() {
      socket?.close();
    }
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Evaluation failed");
  return result.result?.value;
}

async function waitFor(cdp, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function stopProcess(processHandle) {
  if (processHandle.exitCode !== null) return;
  const exited = once(processHandle, "exit");
  processHandle.kill("SIGTERM");
  const graceful = await Promise.race([exited.then(() => true), delay(3_000).then(() => false)]);
  if (graceful || processHandle.exitCode !== null) return;
  const killed = once(processHandle, "exit");
  processHandle.kill("SIGKILL");
  await Promise.race([killed, delay(3_000)]);
}

async function removeDirectoryWithRetry(directory) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      await delay(150 * (attempt + 1));
    }
  }
  throw lastError;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

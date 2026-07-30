import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

if (process.platform !== "win32") {
  console.log("Managed Hermes native smoke test skipped outside Windows.");
  process.exit(0);
}

const repository = path.resolve(import.meta.dirname, "..");
const hostExecutable = path.join(repository, "apps", "managed-runtime", "dist", "NeptuneHermesHost.exe");
const localAppData = await mkdtemp(path.join(os.tmpdir(), "neptune-hermes-native-"));
const runtimeDir = path.join(localAppData, "Neptune", "Hermes");
const apiKey = "neptune-native-smoke-key-abcdefghijklmnopqrstuvwxyz";
await mkdir(runtimeDir, { recursive: true });
await writeFile(path.join(runtimeDir, "connection.json"), JSON.stringify({
  endpoint: "http://127.0.0.1:8642",
  apiKey,
  model: "Qwen3-4B-Q4_K_M",
  runtimeVersion: "1.8.0"
}), "utf8");

const server = createServer((request, response) => {
  if (request.url === "/health" && request.headers.authorization === `Bearer ${apiKey}`) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "ok", platform: "hermes-agent" }));
    return;
  }
  response.writeHead(404);
  response.end();
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(8642, "127.0.0.1", resolve);
});

const child = spawn(hostExecutable, [], {
  env: { ...process.env, LOCALAPPDATA: localAppData },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

try {
  const requestId = crypto.randomUUID();
  const request = Buffer.from(JSON.stringify({ requestId, type: "ensure", clientVersion: "1.8.0" }));
  const frame = Buffer.allocUnsafe(4 + request.length);
  frame.writeUInt32LE(request.length, 0);
  request.copy(frame, 4);
  child.stdin.write(frame);

  const ready = await readUntilReady(child.stdout, requestId, 15_000);
  assert(ready.endpoint === "http://127.0.0.1:8642", "native host returned a non-loopback endpoint");
  assert(ready.apiKey === apiKey, "native host did not return the managed key");
  assert(ready.model === "Qwen3-4B-Q4_K_M", "native host returned the wrong model");
  assert(ready.runtimeVersion === "1.8.0", "native host returned the wrong runtime version");
  console.log("Managed Hermes Native Messaging smoke test passed.");
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\nHost stderr: ${stderr}`);
} finally {
  child.kill();
  child.stdin.destroy();
  await new Promise((resolve) => server.close(resolve));
  await rm(localAppData, { recursive: true, force: true });
}

async function readUntilReady(stream, requestId, timeoutMs) {
  let buffer = Buffer.alloc(0);
  const deadline = Date.now() + timeoutMs;
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length <= 0 || length > 1024 * 1024) throw new Error(`invalid native frame length: ${length}`);
      if (buffer.length < 4 + length) break;
      const message = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
      buffer = buffer.subarray(4 + length);
      if (message.requestId !== requestId) continue;
      if (message.kind === "error") throw new Error(message.detail || message.code || "native host error");
      if (message.kind === "ready") return message;
    }
    if (Date.now() > deadline) break;
  }
  throw new Error("timed out waiting for managed Hermes ready response");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

import { readFile, writeFile } from "node:fs/promises";

function replaceExact(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`Validation fix target not found: ${label}`);
  return source.replace(before, after);
}

const smokePath = "tests/extension-smoke-cdp.mjs";
let smoke = await readFile(smokePath, "utf8");
smoke = replaceExact(
  smoke,
  `  await completeOnboardingForIntegrationTest(cdp);`,
  `  await completeOnboardingForIntegrationTest(cdp, hermes.endpoint);`,
  "managed onboarding test connection"
);
smoke = replaceExact(
  smoke,
`  await waitFor(cdp, \`Boolean(document.querySelector("button[data-action='open-settings']"))\`, 15_000);
  await evaluate(cdp, \`document.querySelector("button[data-action='open-settings']").click()\`);
  await waitFor(cdp, \`Boolean(document.querySelector("button[data-action='toggle-advanced']"))\`, 10_000);
  await evaluate(cdp, \`document.querySelector("button[data-action='toggle-advanced']").click()\`);
  await waitFor(cdp, \`Boolean(document.querySelector("#advanced-provider option[value='hermes']")) && Boolean(document.querySelector("#neptune-hermes-card"))\`, 10_000);

  const corsLine = await evaluate(cdp, \`document.querySelector(".hermes-origin")?.textContent ?? ""\`);
  assert(corsLine === \`API_SERVER_CORS_ORIGINS=chrome-extension://\${extensionId}\`, "Neptune did not expose the exact Hermes CORS origin");

  await evaluate(cdp, \`(() => {
    const provider = document.querySelector("#advanced-provider");
    provider.value = "hermes";
    provider.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()\`);
  await waitFor(cdp, \`document.querySelector("#advanced-provider")?.value === "hermes" && Boolean(document.querySelector("#provider-endpoint")) && Boolean(document.querySelector("#provider-secret"))\`, 10_000);

  await evaluate(cdp, \`(() => {
    const endpoint = document.querySelector("#provider-endpoint");
    const model = document.querySelector("#provider-model");
    const secret = document.querySelector("#provider-secret");
    endpoint.value = \${JSON.stringify(hermes.endpoint)};
    model.value = "hermes-agent";
    secret.value = "neptune-hermes-test-key";
    endpoint.dispatchEvent(new Event("input", { bubbles: true }));
    model.dispatchEvent(new Event("input", { bubbles: true }));
    secret.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()\`);
  await evaluate(cdp, \`document.querySelector("button[data-hermes-action='connect']").click()\`);
  await waitFor(cdp, \`document.querySelector("#neptune-hermes-status")?.textContent?.includes("Hermes connecté") === true\`, 20_000);
  assert(hermes.requests.some((request) => request.path === "/v1/capabilities"), "Neptune did not inspect Hermes capabilities");
  assert(hermes.requests.some((request) => request.path === "/v1/skills"), "Neptune did not inspect Hermes skills");`,
`  await waitFor(cdp, \`Boolean(document.querySelector("button[data-action='open-settings']"))\`, 20_000);
  await evaluate(cdp, \`document.querySelector("button[data-action='open-settings']").click()\`);
  await waitFor(cdp, \`Boolean(document.querySelector("button[data-action='toggle-advanced']"))\`, 10_000);
  await evaluate(cdp, \`document.querySelector("button[data-action='toggle-advanced']").click()\`);
  await waitFor(cdp, \`document.querySelector("#advanced-provider")?.value === "hermes" && document.body.innerText.includes("Hermes intégré")\`, 10_000);
  const manualHermesFields = await evaluate(cdp, \`Boolean(document.querySelector("#provider-endpoint")) || Boolean(document.querySelector("#provider-secret")) || Boolean(document.querySelector("#neptune-hermes-card"))\`);
  assert(manualHermesFields === false, "Neptune still exposes manual Hermes URL, API key or CORS controls");`,
  "remove manual Hermes configuration test"
);
smoke = replaceExact(
  smoke,
  `  assert(chatRequest.authorization === "Bearer neptune-hermes-test-key", "Neptune did not authenticate the Hermes request");`,
  `  assert(chatRequest.authorization === "Bearer neptune-hermes-test-key", "Neptune did not use the automatically managed Hermes key");`,
  "managed authentication assertion"
);
smoke = replaceExact(
  smoke,
`async function completeOnboardingForIntegrationTest(cdp) {
  await evaluate(cdp, \`(async () => {
    const key = "neptune.preferences.v2";
    const stored = await chrome.storage.local.get(key);
    await chrome.storage.local.set({
      [key]: {
        ...(stored[key] ?? {}),
        productVersion: 17,
        onboardingComplete: true,
        onboardingStep: 3,
        wakeWordEnabled: false,
        autoResumeVoice: false
      }
    });
    location.reload();
    return true;
  })()\`);
}`,
`async function completeOnboardingForIntegrationTest(cdp, endpoint) {
  await evaluate(cdp, \`(async () => {
    const key = "neptune.preferences.v2";
    const stored = await chrome.storage.local.get(key);
    await chrome.storage.local.set({
      [key]: {
        ...(stored[key] ?? {}),
        productVersion: 18,
        onboardingComplete: true,
        onboardingStep: 3,
        providerId: "hermes",
        endpoint: \${JSON.stringify(endpoint)},
        model: "Qwen3-4B-Q4_K_M",
        wakeWordEnabled: false,
        autoResumeVoice: false
      }
    });
    await chrome.storage.session.set({
      "neptune.managedHermes.connection.v1": {
        endpoint: \${JSON.stringify(endpoint)},
        apiKey: "neptune-hermes-test-key",
        model: "Qwen3-4B-Q4_K_M",
        runtimeVersion: "1.8.0",
        managed: true
      }
    });
    location.reload();
    return true;
  })()\`);
}`,
  "managed onboarding helper"
);
smoke = smoke.replace(
  `Neptune Chromium smoke test passed with premium voices, Hermes API integration and durable stop state`,
  `Neptune Chromium smoke test passed with premium voices, zero-config managed Hermes and durable stop state`
);
await writeFile(smokePath, smoke, "utf8");

for (const powershellPath of [
  "apps/managed-runtime/assets/install.ps1",
  "apps/managed-runtime/assets/start-runtime.ps1"
]) {
  let source = await readFile(powershellPath, "utf8");
  source = source.replace(/'([^'\n]*’[^'\n]*)'/g, (_match, content) => `"${content.replaceAll('"', '`"').replaceAll('’', "'")}"`);
  source = source.replaceAll("’", "'");
  await writeFile(powershellPath, source, "utf8");
}

console.log("Managed Hermes validation sources fixed.");

import { readFile, writeFile } from "node:fs/promises";

const files = {
  app: "apps/extension/src/neptune-app.ts",
  service: "apps/extension/src/service-worker.ts",
  voiceRuntime: "apps/extension/src/local-voice-runtime.ts",
  voiceWorker: "apps/extension/src/piper-voice-worker.ts",
  build: "apps/extension/esbuild.mjs",
  css: "apps/extension/static/sidepanel.css",
  ci: ".github/workflows/ci.yml"
};

function replaceOnce(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`Target not found: ${label}`);
  return source.replace(search, replacement);
}

async function patch(path, transform) {
  const original = await readFile(path, "utf8");
  const next = transform(original);
  if (next === original) throw new Error(`No change produced for ${path}`);
  await writeFile(path, next);
}

await patch(files.voiceWorker, (source) => {
  source = replaceOnce(
    source,
    "const nativeFetch = globalThis.fetch.bind(globalThis);\nconst runtime = globalThis as typeof globalThis & { fetch: typeof fetch };",
    "const nativeFetch = globalThis.fetch.bind(globalThis);\nconst extensionRoot = new URL(\"./\", self.location.href);\nconst runtime = globalThis as typeof globalThis & { fetch: typeof fetch };",
    "voice worker extension root"
  );
  source = replaceOnce(
    source,
    "if (file) return nativeFetch(chrome.runtime.getURL(`voices/${file}`));",
    "if (file) return nativeFetch(new URL(`voices/${file}`, extensionRoot));",
    "voice worker chrome runtime dependency"
  );
  return source;
});

await patch(files.build, (source) => replaceOnce(
  source,
  ".replace(/[\"']https:\\/\\/cdnjs\\.cloudflare\\.com\\/ajax\\/libs\\/onnxruntime-web\\/1\\.18\\.0\\/[\"']/g, 'chrome.runtime.getURL(\"voices/runtime/\")')\n        .replace(/[\"']https:\\/\\/cdn\\.jsdelivr\\.net\\/npm\\/@diffusionstudio\\/piper-wasm@1\\.0\\.0\\/build\\/piper_phonemize[\"']/g, 'chrome.runtime.getURL(\"voices/runtime/piper_phonemize\")');",
  ".replace(/[\"']https:\\/\\/cdnjs\\.cloudflare\\.com\\/ajax\\/libs\\/onnxruntime-web\\/1\\.18\\.0\\/[\"']/g, 'new URL(\"voices/runtime/\", self.location.href).href')\n        .replace(/[\"']https:\\/\\/cdn\\.jsdelivr\\.net\\/npm\\/@diffusionstudio\\/piper-wasm@1\\.0\\.0\\/build\\/piper_phonemize[\"']/g, 'new URL(\"voices/runtime/piper_phonemize\", self.location.href).href');",
  "embedded Piper runtime URL resolution"
));

await patch(files.voiceRuntime, (source) => {
  source = replaceOnce(
    source,
    "type PendingRequest = {\n  resolve: (value: unknown) => void;\n  reject: (reason: unknown) => void;\n  onProgress?: ((progress: number, detail: string) => void) | undefined;\n};",
    "type PendingRequest = {\n  resolve: (value: unknown) => void;\n  reject: (reason: unknown) => void;\n  onProgress?: ((progress: number, detail: string) => void) | undefined;\n  timeoutId: number;\n};",
    "voice pending request timeout"
  );
  source = replaceOnce(
    source,
    "    pending.delete(message.requestId);\n    if (message.type === \"ERROR\") {",
    "    pending.delete(message.requestId);\n    window.clearTimeout(request.timeoutId);\n    if (message.type === \"ERROR\") {",
    "clear voice timeout"
  );
  source = replaceOnce(
    source,
    "      currentAudio = audio;\n      currentAudioUrl = url;\n      audio.onended = () => {",
    "      currentAudio = audio;\n      currentAudioUrl = url;\n      attachAudioMeter(audio);\n      audio.onended = () => {",
    "speech proxy audio meter"
  );
  source = replaceOnce(
    source,
    "  currentAudio = audio;\n  currentAudioUrl = url;\n  await new Promise<void>((resolve, reject) => {",
    "  currentAudio = audio;\n  currentAudioUrl = url;\n  attachAudioMeter(audio);\n  await new Promise<void>((resolve, reject) => {",
    "direct playback audio meter"
  );
  source = replaceOnce(
    source,
    "  return new Promise((resolve, reject) => {\n    pending.set(requestId, { resolve, reject, onProgress });\n    getWorker().postMessage({ type, requestId, ...payload });\n  });",
    "  return new Promise((resolve, reject) => {\n    const timeoutId = window.setTimeout(() => {\n      pending.delete(requestId);\n      reject(new Error(\"Le moteur vocal local ne répond pas. Rechargez Neptune puis réessayez.\"));\n      resetVoiceWorker(new Error(\"Voice worker timeout\"));\n    }, type === \"SYNTHESIZE\" ? 90_000 : 45_000);\n    pending.set(requestId, { resolve, reject, onProgress, timeoutId });\n    getWorker().postMessage({ type, requestId, ...payload });\n  });",
    "voice request timeout"
  );
  source = replaceOnce(
    source,
    "  for (const request of pending.values()) request.reject(reason);\n  pending.clear();\n}",
    "  for (const request of pending.values()) {\n    window.clearTimeout(request.timeoutId);\n    request.reject(reason);\n  }\n  pending.clear();\n}\n\nfunction attachAudioMeter(audio: HTMLAudioElement): void {\n  const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;\n  if (!AudioContextClass) return;\n  try {\n    const context = new AudioContextClass();\n    const sourceNode = context.createMediaElementSource(audio);\n    const analyser = context.createAnalyser();\n    analyser.fftSize = 256;\n    sourceNode.connect(analyser);\n    analyser.connect(context.destination);\n    const values = new Uint8Array(analyser.frequencyBinCount);\n    const tick = () => {\n      if (audio.paused || audio.ended) {\n        window.dispatchEvent(new CustomEvent(\"neptune-audio-level\", { detail: { level: 0 } }));\n        void context.close();\n        return;\n      }\n      analyser.getByteFrequencyData(values);\n      const level = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length * 255);\n      window.dispatchEvent(new CustomEvent(\"neptune-audio-level\", { detail: { level } }));\n      window.requestAnimationFrame(tick);\n    };\n    void context.resume().then(tick);\n  } catch {\n    // The voice remains functional even when the visual analyser is unavailable.\n  }\n}",
    "audio meter helper"
  );
  return source;
});

await patch(files.service, (source) => {
  source = replaceOnce(
    source,
    "const ASSISTANT_WINDOW_KEY = \"neptune.voiceAssistantWindowId.v1\";\nconst PREFERENCES_KEY = \"neptune.preferences.v2\";",
    "const ASSISTANT_WINDOW_KEY = \"neptune.voiceAssistantWindowId.v1\";\nconst MISSION_CONTROL_KEY = \"neptune.missionControl.v1\";\nconst PREFERENCES_KEY = \"neptune.preferences.v2\";",
    "mission control key"
  );
  source = replaceOnce(source, "let stopped = false;", "type MissionControl = { generation: number; status: \"running\" | \"stopped\"; updatedAt: string };", "remove volatile stopped flag");
  source = replaceOnce(
    source,
    "    case \"GET_STATUS\":\n      return { version: chrome.runtime.getManifest().version, stopped, workTab: publicTab(await getWorkTabIfPresent()), wake: await getWakeStatus() };",
    "    case \"GET_STATUS\": {\n      const control = await getMissionControl();\n      return { version: chrome.runtime.getManifest().version, stopped: control.status === \"stopped\", missionControl: control, workTab: publicTab(await getWorkTabIfPresent()), wake: await getWakeStatus() };\n    }",
    "durable status"
  );
  source = replaceOnce(
    source,
    "    case \"START_MISSION\":\n      stopped = false;\n      return { tab: publicTab(await establishWorkspace(request.workspaceMode ?? \"new-tab\", request.initialUrl)) };",
    "    case \"START_MISSION\": {\n      const control = await startMissionControl();\n      return { tab: publicTab(await establishWorkspace(request.workspaceMode ?? \"new-tab\", request.initialUrl)), missionControl: control };\n    }",
    "durable mission start"
  );
  source = replaceOnce(
    source,
    "    case \"STOP_MISSION\":\n      stopped = true;\n      return { stopped: true };",
    "    case \"STOP_MISSION\":\n      return stopMissionControl();",
    "durable mission stop"
  );
  source = replaceOnce(
    source,
    "async function executeAction(action: BrowserAction, approved: boolean): Promise<unknown> {\n  enforcePolicy(action, approved);\n  if (stopped) throw new Error(\"MISSION_STOPPED: mission arrêtée par l’utilisateur\");",
    "async function executeAction(action: BrowserAction, approved: boolean): Promise<unknown> {\n  enforcePolicy(action, approved);\n  await assertMissionRunning();",
    "durable pre-action stop check"
  );
  source = replaceOnce(
    source,
    "    case \"STOP_TASK\":\n      stopped = true;\n      return { stopped: true };",
    "    case \"STOP_TASK\":\n      return stopMissionControl();",
    "durable stop task"
  );
  source = replaceOnce(
    source,
    "  if (!response?.ok) throw new Error(response?.error ?? \"L’action sur la page a échoué\");\n  return response.result ?? response;\n}",
    "  if (!response?.ok) throw new Error(response?.error ?? \"L’action sur la page a échoué\");\n  await assertMissionRunning();\n  return response.result ?? response;\n}\n\nasync function getMissionControl(): Promise<MissionControl> {\n  const stored = await chrome.storage.session.get(MISSION_CONTROL_KEY);\n  const value = stored[MISSION_CONTROL_KEY] as Partial<MissionControl> | undefined;\n  return {\n    generation: typeof value?.generation === \"number\" ? value.generation : 0,\n    status: value?.status === \"stopped\" ? \"stopped\" : \"running\",\n    updatedAt: typeof value?.updatedAt === \"string\" ? value.updatedAt : new Date(0).toISOString()\n  };\n}\n\nasync function startMissionControl(): Promise<MissionControl> {\n  const previous = await getMissionControl();\n  const next: MissionControl = { generation: previous.generation + 1, status: \"running\", updatedAt: new Date().toISOString() };\n  await chrome.storage.session.set({ [MISSION_CONTROL_KEY]: next });\n  return next;\n}\n\nasync function stopMissionControl(): Promise<{ stopped: true; missionControl: MissionControl }> {\n  const previous = await getMissionControl();\n  const next: MissionControl = { ...previous, status: \"stopped\", updatedAt: new Date().toISOString() };\n  await chrome.storage.session.set({ [MISSION_CONTROL_KEY]: next });\n  return { stopped: true, missionControl: next };\n}\n\nasync function assertMissionRunning(): Promise<void> {\n  const control = await getMissionControl();\n  if (control.status === \"stopped\") throw new Error(\"MISSION_STOPPED: mission arrêtée par l’utilisateur\");\n}",
    "mission control helpers"
  );
  return source;
});

await patch(files.app, (source) => {
  source = replaceOnce(
    source,
    "  isWebGpuAvailable,\n  saveLocalModelSelection,",
    "  isWebGpuAvailable,\n  recommendModelId,\n  saveLocalModelSelection,",
    "adaptive model import"
  );
  source = replaceOnce(source, "let actionLocked = false;", "const pendingActions = new Set<string>();", "per-action lock state");
  source = replaceOnce(
    source,
    "  render();\n  void prepareSelectedVoice(false).then(() => {\n    if (!preferences.onboardingComplete && preferences.onboardingStep === 0) {\n      speak(\"Bonjour. Je suis Neptune. Comment dois-je vous appeler ?\");\n    }\n  });",
    "  render();\n  if (!preferences.onboardingComplete && preferences.onboardingStep === 0) {\n    void prepareSelectedVoice(false);\n  }",
    "safe first launch voice initialization"
  );
  source = replaceOnce(
    source,
    "  app.addEventListener(\"submit\", (event) => {\n    event.preventDefault();\n    if ((event.target as HTMLElement).id === \"composer\") void submitMessage(draft);\n  });",
    "  app.addEventListener(\"submit\", (event) => {\n    event.preventDefault();\n    if ((event.target as HTMLElement).id === \"composer\") void submitMessage(draft);\n  });\n  app.addEventListener(\"keydown\", (event) => {\n    if (event.key === \"Enter\" && (event.target as HTMLElement).id === \"preferred-name\") {\n      event.preventDefault();\n      if (canContinueOnboarding()) void nextOnboardingStep();\n    }\n  });\n  window.addEventListener(\"neptune-audio-level\", (event) => {\n    const level = Number((event as CustomEvent<{ level?: number }>).detail?.level ?? 0);\n    document.documentElement.style.setProperty(\"--audio-level\", String(Math.max(0, Math.min(1, level))));\n  });",
    "onboarding enter and audio meter bridge"
  );
  source = replaceOnce(
    source,
    "  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(\"button[data-action]\");\n  if (!button || button.disabled || actionLocked) return;\n  event.preventDefault();\n  const action = button.dataset.action ?? \"\";\n  const value = button.dataset.value ?? \"\";\n  actionLocked = true;",
    "  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(\"button[data-action]\");\n  if (!button || button.disabled) return;\n  event.preventDefault();\n  const action = button.dataset.action ?? \"\";\n  const value = button.dataset.value ?? \"\";\n  const actionKey = `${action}:${value}`;\n  if (pendingActions.has(actionKey)) return;\n  pendingActions.add(actionKey);\n  button.disabled = true;\n  button.setAttribute(\"aria-busy\", \"true\");",
    "per-action dispatcher"
  );
  source = replaceOnce(
    source,
    "      case \"prepare-brain\": await prepareBalancedBrain(); break;",
    "      case \"prepare-brain\": await prepareBalancedBrain(); break;\n      case \"retry-voice\": await prepareSelectedVoice(true); break;",
    "retry voice action"
  );
  source = replaceOnce(
    source,
    "  } finally {\n    actionLocked = false;\n  }",
    "  } finally {\n    pendingActions.delete(actionKey);\n    if (button.isConnected) {\n      button.disabled = false;\n      button.removeAttribute(\"aria-busy\");\n    }\n  }",
    "release per-action lock"
  );
  source = replaceOnce(
    source,
    "    case \"preferred-name\": preferences.preferredName = target.value.slice(0, 80); break;",
    "    case \"preferred-name\": {\n      preferences.preferredName = target.value.slice(0, 80);\n      const nextButton = app.querySelector<HTMLButtonElement>(\"button[data-action='onboarding-next']\");\n      if (nextButton) nextButton.disabled = preferences.preferredName.trim().length < 2;\n      void savePreferences();\n      break;\n    }",
    "reactive preferred name"
  );
  source = replaceOnce(
    source,
    "    case \"provider-secret\": secretDraft = target.value.slice(0, 1_000); break;",
    "    case \"provider-secret\": secretDraft = target.value.slice(0, 1_000); break;\n    case \"advanced-local-model\": {\n      const applyButton = app.querySelector<HTMLButtonElement>(\"button[data-action='select-local-model']\");\n      if (applyButton) applyButton.dataset.value = target.value;\n      break;\n    }\n    case \"advanced-provider\": void selectProvider(target.value as ProviderId); break;",
    "advanced settings change handlers"
  );
  source = replaceOnce(
    source,
    "    voiceState = \"ready\";\n    voiceProgress = 100;\n    appendAudit(\"VOICE_READY\", voice.label);\n  } catch (error) {\n    voiceState = \"error\";\n    transientWarning = `La voix intégrée n’a pas pu être préparée : ${errorMessage(error)}`;\n  }",
    "    voiceState = \"ready\";\n    voiceProgress = 100;\n    if (orbState === \"error\") orbState = \"idle\";\n    transientWarning = \"\";\n    appendAudit(\"VOICE_READY\", voice.label);\n  } catch (error) {\n    voiceState = \"error\";\n    orbState = \"error\";\n    appendAudit(\"VOICE_ERROR\", errorMessage(error));\n    transientWarning = \"La voix intégrée n’a pas pu démarrer. Rechargez Neptune ou utilisez Réessayer.\";\n  }",
    "structured voice error"
  );
  source = replaceOnce(
    source,
    "  const next: LocalModelSelection = force || current.engine !== \"webllm\"\n    ? { engine: \"webllm\", modelId: BALANCED_LOCAL_MODEL_ID }\n    : current;\n  if (next.modelId !== BALANCED_LOCAL_MODEL_ID && force) next.modelId = BALANCED_LOCAL_MODEL_ID;",
    "  const recommended = recommendModelId(getLocalModelCatalog());\n  const next: LocalModelSelection = force || current.engine !== \"webllm\"\n    ? { engine: \"webllm\", modelId: recommended || BALANCED_LOCAL_MODEL_ID }\n    : current;\n  if (force) next.modelId = recommended || BALANCED_LOCAL_MODEL_ID;",
    "adaptive initial model selection"
  );
  const oldBrain = `async function prepareBalancedBrain(): Promise<void> {\n  if (brainState === \"preparing\") return;\n  brainState = \"preparing\";\n  brainProgress = 0;\n  brainError = \"\";\n  render();\n  try {\n    await saveLocalModelSelection({ engine: \"webllm\", modelId: BALANCED_LOCAL_MODEL_ID });\n    preferences.providerId = \"chrome-local\";\n    preferences.model = BALANCED_LOCAL_MODEL_ID;\n    await savePreferences();\n    const api = getLocalLanguageModelApi();\n    if (!api) throw new Error(\"WebGPU n’est pas disponible sur cet ordinateur.\");\n    const session = await api.create({\n      initialPrompts: [{ role: \"system\", content: \"Tu es Neptune. Réponds uniquement : prêt.\" }],\n      monitor(monitor) {\n        monitor.addEventListener(\"downloadprogress\", (event) => {\n          brainProgress = Math.round(Math.max(0, Math.min(1, event.loaded)) * 100);\n          render();\n        });\n      }\n    });\n    await session.prompt(\"Réponds uniquement : prêt\");\n    session.destroy();\n    brainProgress = 100;\n    brainState = \"ready\";\n    appendAudit(\"LOCAL_BRAIN_READY\", \"Neptune Équilibré prêt\");\n  } catch (error) {\n    const apiStatus = await getChromeAiAvailability();\n    if (apiStatus !== \"unavailable\") {\n      await saveLocalModelSelection({ engine: \"auto\", modelId: BALANCED_LOCAL_MODEL_ID });\n      brainState = apiStatus === \"available\" ? \"ready\" : \"idle\";\n      brainError = \"Neptune utilisera automatiquement le meilleur moteur local disponible.\";\n    } else {\n      brainState = \"error\";\n      brainError = errorMessage(error);\n    }\n  }\n  render();\n}`;
  const newBrain = `async function prepareBalancedBrain(): Promise<void> {\n  if (brainState === \"preparing\") return;\n  brainState = \"preparing\";\n  brainProgress = 0;\n  brainError = \"\";\n  render();\n\n  const catalog = getLocalModelCatalog();\n  const recommended = recommendModelId(catalog);\n  const candidates = [...new Set([\n    recommended,\n    BALANCED_LOCAL_MODEL_ID,\n    ...catalog.filter((model) => model.tier === \"fast\").map((model) => model.id),\n    ...catalog.filter((model) => model.tier === \"light\").map((model) => model.id)\n  ].filter(Boolean))];\n  let lastError: unknown = null;\n\n  for (const modelId of candidates) {\n    try {\n      await saveLocalModelSelection({ engine: \"webllm\", modelId });\n      preferences.providerId = \"chrome-local\";\n      preferences.model = modelId;\n      await savePreferences();\n      const api = getLocalLanguageModelApi();\n      if (!api) throw new Error(\"Aucun moteur local compatible n’est disponible sur cet ordinateur.\");\n      const session = await api.create({\n        initialPrompts: [{ role: \"system\", content: \"Tu es Neptune. Réponds uniquement : prêt.\" }],\n        monitor(monitor) {\n          monitor.addEventListener(\"downloadprogress\", (event) => {\n            brainProgress = Math.round(Math.max(0, Math.min(1, event.loaded)) * 100);\n            render();\n          });\n        }\n      });\n      await session.prompt(\"Réponds uniquement : prêt\");\n      session.destroy();\n      brainProgress = 100;\n      brainState = \"ready\";\n      appendAudit(\"LOCAL_BRAIN_READY\", modelId);\n      render();\n      return;\n    } catch (error) {\n      lastError = error;\n      appendAudit(\"LOCAL_BRAIN_FALLBACK\", `${modelId}: ${errorMessage(error)}`);\n    }\n  }\n\n  const apiStatus = await getChromeAiAvailability();\n  if (apiStatus === \"available\") {\n    await saveLocalModelSelection({ engine: \"chrome-native\", modelId: recommended || BALANCED_LOCAL_MODEL_ID });\n    brainState = \"ready\";\n    brainProgress = 100;\n    brainError = \"Neptune utilise l’intelligence locale intégrée à Chrome.\";\n  } else {\n    brainState = \"error\";\n    orbState = \"error\";\n    brainError = \"Ce poste ne peut pas exécuter le cerveau local. Ouvrez les paramètres avancés pour connecter un fournisseur.\";\n    appendAudit(\"LOCAL_BRAIN_ERROR\", errorMessage(lastError));\n  }\n  render();\n}`;
  source = replaceOnce(source, oldBrain, newBrain, "adaptive brain preparation");
  source = replaceOnce(
    source,
    "<select class=\"select\" id=\"advanced-local-model\" onchange=\"this.closest('.modal')?.querySelector('[data-action=\\\"select-local-model\\\"]')?.setAttribute('data-value', this.value)\">",
    "<select class=\"select\" id=\"advanced-local-model\">",
    "remove inline model handler"
  );
  source = replaceOnce(
    source,
    "${voiceState === \"preparing\" ? progressMarkup(\"Préparation de la voix intégrée\", voiceProgress) : \"\"}`;",
    "${voiceState === \"preparing\" ? progressMarkup(\"Préparation de la voix intégrée\", voiceProgress) : voiceState === \"error\" ? `<div class=\"notice warning\">La voix n’a pas pu démarrer.</div><button type=\"button\" class=\"primary-button wide-button\" data-action=\"retry-voice\">Réessayer la voix</button>` : \"\"}`;",
    "voice recovery UI"
  );
  return source;
});

await patch(files.css, (source) => {
  source = replaceOnce(source, "  --pink: #f04cc6;", "  --pink: #f04cc6;\n  --audio-level: 0;", "audio level variable");
  source = replaceOnce(
    source,
    ".neptune-hologram.full { width: min(246px, 72vw); aspect-ratio: 1; }\n.neptune-hologram.compact { width: 112px; height: 112px; }",
    ".neptune-hologram.full { --spectrum-radius: 92px; width: min(246px, 72vw); aspect-ratio: 1; }\n.neptune-hologram.compact { --spectrum-radius: 42px; width: 112px; height: 112px; }",
    "stable hologram radius"
  );
  source = replaceOnce(
    source,
    "  transform-origin: 50% calc(var(--count) * .22px + 86px);\n  transform: translate(-50%, -100%) rotate(var(--angle)) translateY(calc(-1 * (var(--count) * .20px + 49px))) scaleY(.36);",
    "  transform-origin: center;\n  transform: translate(-50%, -50%) rotate(var(--angle)) translateY(calc(-1 * var(--spectrum-radius))) scaleY(calc(.36 + var(--audio-level) * 1.15));",
    "center spectrum bars"
  );
  source = replaceOnce(
    source,
    ".neptune-hologram.compact .spectrum-bar { width: 2px; height: 13px; transform-origin: 50% 55px; transform: translate(-50%, -100%) rotate(var(--angle)) translateY(-42px) scaleY(.38); }",
    ".neptune-hologram.compact .spectrum-bar { width: 2px; height: 13px; transform-origin: center; transform: translate(-50%, -50%) rotate(var(--angle)) translateY(calc(-1 * var(--spectrum-radius))) scaleY(calc(.38 + var(--audio-level) * 1.05)); }",
    "center compact spectrum"
  );
  return source;
});

await patch(files.ci, (source) => {
  source = replaceOnce(source, "pnpm install --no-frozen-lockfile", "pnpm install --frozen-lockfile", "frozen dependency graph");
  source = replaceOnce(
    source,
    "          if grep -E \"cdn\\.jsdelivr\\.net/npm/@diffusionstudio/piper-wasm|cdnjs\\.cloudflare\\.com/ajax/libs/onnxruntime-web\" apps/extension/dist/piper-voice-worker.js; then",
    "          if grep -E \"cdn\\.jsdelivr\\.net/npm/@diffusionstudio/piper-wasm|cdnjs\\.cloudflare\\.com/ajax/libs/onnxruntime-web|chrome\\.runtime\" apps/extension/dist/piper-voice-worker.js; then",
    "voice worker forbidden dependencies"
  );
  source = replaceOnce(
    source,
    "      - name: Dry-run Cloudflare Worker\n        run: pnpm --filter @neptune/worker-api build",
    "      - name: Install Chromium smoke-test runtime\n        run: pnpm dlx playwright@1.55.0 install chromium\n\n      - name: Run extension onboarding smoke test\n        run: xvfb-run -a pnpm dlx playwright@1.55.0 test tests/extension-smoke.spec.mjs --reporter=line --workers=1\n\n      - name: Dry-run Cloudflare Worker\n        run: pnpm --filter @neptune/worker-api build",
    "browser smoke test"
  );
  return source;
});

console.log("Neptune v1.6 runtime hardening applied.");

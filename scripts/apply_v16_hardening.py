from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise RuntimeError(f"Target not found: {label}")
    return text.replace(old, new, 1)


def patch(path: str, transform) -> None:
    file = Path(path)
    original = file.read_text()
    updated = transform(original)
    if updated == original:
        raise RuntimeError(f"No change produced for {path}")
    file.write_text(updated)


def patch_voice_worker(source: str) -> str:
    source = replace_once(
        source,
        'const nativeFetch = globalThis.fetch.bind(globalThis);\nconst runtime = globalThis as typeof globalThis & { fetch: typeof fetch };',
        'const nativeFetch = globalThis.fetch.bind(globalThis);\nconst extensionRoot = new URL("./", self.location.href);\nconst runtime = globalThis as typeof globalThis & { fetch: typeof fetch };',
        'voice worker extension root',
    )
    return replace_once(
        source,
        'if (file) return nativeFetch(chrome.runtime.getURL(`voices/${file}`));',
        'if (file) return nativeFetch(new URL(`voices/${file}`, extensionRoot));',
        'voice worker chrome dependency',
    )


def patch_build(source: str) -> str:
    source = source.replace(
        "'chrome.runtime.getURL(\"voices/runtime/\")'",
        "'new URL(\"voices/runtime/\", self.location.href).href'",
    )
    source = source.replace(
        "'chrome.runtime.getURL(\"voices/runtime/piper_phonemize\")'",
        "'new URL(\"voices/runtime/piper_phonemize\", self.location.href).href'",
    )
    if 'chrome.runtime.getURL("voices/runtime/' in source:
        raise RuntimeError('Piper build still contains chrome.runtime.getURL')
    return source


def patch_voice_runtime(source: str) -> str:
    source = replace_once(
        source,
        '''type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  onProgress?: ((progress: number, detail: string) => void) | undefined;
};''',
        '''type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  onProgress?: ((progress: number, detail: string) => void) | undefined;
  timeoutId: number;
};''',
        'voice pending timeout type',
    )
    source = replace_once(
        source,
        '''    pending.delete(message.requestId);
    if (message.type === "ERROR") {''',
        '''    pending.delete(message.requestId);
    window.clearTimeout(request.timeoutId);
    if (message.type === "ERROR") {''',
        'clear voice timeout',
    )
    source = source.replace(
        '''      currentAudio = audio;
      currentAudioUrl = url;
      audio.onended = () => {''',
        '''      currentAudio = audio;
      currentAudioUrl = url;
      attachAudioMeter(audio);
      audio.onended = () => {''',
        1,
    )
    source = source.replace(
        '''  currentAudio = audio;
  currentAudioUrl = url;
  await new Promise<void>((resolve, reject) => {''',
        '''  currentAudio = audio;
  currentAudioUrl = url;
  attachAudioMeter(audio);
  await new Promise<void>((resolve, reject) => {''',
        1,
    )
    source = replace_once(
        source,
        '''  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject, onProgress });
    getWorker().postMessage({ type, requestId, ...payload });
  });''',
        '''  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("Le moteur vocal local ne répond pas. Rechargez Neptune puis réessayez."));
      resetVoiceWorker(new Error("Voice worker timeout"));
    }, type === "SYNTHESIZE" ? 90_000 : 45_000);
    pending.set(requestId, { resolve, reject, onProgress, timeoutId });
    getWorker().postMessage({ type, requestId, ...payload });
  });''',
        'voice request timeout',
    )
    source = replace_once(
        source,
        '''  for (const request of pending.values()) request.reject(reason);
  pending.clear();
}''',
        '''  for (const request of pending.values()) {
    window.clearTimeout(request.timeoutId);
    request.reject(reason);
  }
  pending.clear();
}

function attachAudioMeter(audio: HTMLAudioElement): void {
  const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return;
  try {
    const context = new AudioContextClass();
    const sourceNode = context.createMediaElementSource(audio);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    sourceNode.connect(analyser);
    analyser.connect(context.destination);
    const values = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (audio.paused || audio.ended) {
        window.dispatchEvent(new CustomEvent("neptune-audio-level", { detail: { level: 0 } }));
        void context.close();
        return;
      }
      analyser.getByteFrequencyData(values);
      const level = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length * 255);
      window.dispatchEvent(new CustomEvent("neptune-audio-level", { detail: { level } }));
      window.requestAnimationFrame(tick);
    };
    void context.resume().then(tick);
  } catch {
    // The voice remains functional when the analyser is unavailable.
  }
}''',
        'audio meter helper',
    )
    return source


def patch_service(source: str) -> str:
    source = replace_once(
        source,
        'const ASSISTANT_WINDOW_KEY = "neptune.voiceAssistantWindowId.v1";\nconst PREFERENCES_KEY = "neptune.preferences.v2";',
        'const ASSISTANT_WINDOW_KEY = "neptune.voiceAssistantWindowId.v1";\nconst MISSION_CONTROL_KEY = "neptune.missionControl.v1";\nconst PREFERENCES_KEY = "neptune.preferences.v2";',
        'mission control key',
    )
    source = replace_once(
        source,
        'let stopped = false;',
        'type MissionControl = { generation: number; status: "running" | "stopped"; updatedAt: string };',
        'remove volatile stop flag',
    )
    source = replace_once(
        source,
        '''    case "GET_STATUS":
      return { version: chrome.runtime.getManifest().version, stopped, workTab: publicTab(await getWorkTabIfPresent()), wake: await getWakeStatus() };''',
        '''    case "GET_STATUS": {
      const control = await getMissionControl();
      return { version: chrome.runtime.getManifest().version, stopped: control.status === "stopped", missionControl: control, workTab: publicTab(await getWorkTabIfPresent()), wake: await getWakeStatus() };
    }''',
        'durable status',
    )
    source = replace_once(
        source,
        '''    case "START_MISSION":
      stopped = false;
      return { tab: publicTab(await establishWorkspace(request.workspaceMode ?? "new-tab", request.initialUrl)) };''',
        '''    case "START_MISSION": {
      const control = await startMissionControl();
      return { tab: publicTab(await establishWorkspace(request.workspaceMode ?? "new-tab", request.initialUrl)), missionControl: control };
    }''',
        'durable mission start',
    )
    source = replace_once(
        source,
        '''    case "STOP_MISSION":
      stopped = true;
      return { stopped: true };''',
        '''    case "STOP_MISSION":
      return stopMissionControl();''',
        'durable mission stop',
    )
    source = replace_once(
        source,
        '''async function executeAction(action: BrowserAction, approved: boolean): Promise<unknown> {
  enforcePolicy(action, approved);
  if (stopped) throw new Error("MISSION_STOPPED: mission arrêtée par l’utilisateur");''',
        '''async function executeAction(action: BrowserAction, approved: boolean): Promise<unknown> {
  enforcePolicy(action, approved);
  await assertMissionRunning();''',
        'pre-action stop check',
    )
    source = replace_once(
        source,
        '''    case "STOP_TASK":
      stopped = true;
      return { stopped: true };''',
        '''    case "STOP_TASK":
      return stopMissionControl();''',
        'stop task persistence',
    )
    source = replace_once(
        source,
        '''  if (!response?.ok) throw new Error(response?.error ?? "L’action sur la page a échoué");
  return response.result ?? response;
}''',
        '''  if (!response?.ok) throw new Error(response?.error ?? "L’action sur la page a échoué");
  await assertMissionRunning();
  return response.result ?? response;
}

async function getMissionControl(): Promise<MissionControl> {
  const stored = await chrome.storage.session.get(MISSION_CONTROL_KEY);
  const value = stored[MISSION_CONTROL_KEY] as Partial<MissionControl> | undefined;
  return {
    generation: typeof value?.generation === "number" ? value.generation : 0,
    status: value?.status === "stopped" ? "stopped" : "running",
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString()
  };
}

async function startMissionControl(): Promise<MissionControl> {
  const previous = await getMissionControl();
  const next: MissionControl = { generation: previous.generation + 1, status: "running", updatedAt: new Date().toISOString() };
  await chrome.storage.session.set({ [MISSION_CONTROL_KEY]: next });
  return next;
}

async function stopMissionControl(): Promise<{ stopped: true; missionControl: MissionControl }> {
  const previous = await getMissionControl();
  const next: MissionControl = { ...previous, status: "stopped", updatedAt: new Date().toISOString() };
  await chrome.storage.session.set({ [MISSION_CONTROL_KEY]: next });
  return { stopped: true, missionControl: next };
}

async function assertMissionRunning(): Promise<void> {
  const control = await getMissionControl();
  if (control.status === "stopped") throw new Error("MISSION_STOPPED: mission arrêtée par l’utilisateur");
}''',
        'mission control helpers',
    )
    return source


def patch_app(source: str) -> str:
    source = replace_once(
        source,
        '  isWebGpuAvailable,\n  saveLocalModelSelection,',
        '  isWebGpuAvailable,\n  recommendModelId,\n  saveLocalModelSelection,',
        'adaptive model import',
    )
    source = replace_once(source, 'let actionLocked = false;', 'const pendingActions = new Set<string>();', 'per-action lock')
    source = replace_once(
        source,
        '''  render();
  void prepareSelectedVoice(false).then(() => {
    if (!preferences.onboardingComplete && preferences.onboardingStep === 0) {
      speak("Bonjour. Je suis Neptune. Comment dois-je vous appeler ?");
    }
  });''',
        '''  render();
  if (!preferences.onboardingComplete && preferences.onboardingStep === 0) {
    void prepareSelectedVoice(false);
  }''',
        'safe first launch voice',
    )
    source = replace_once(
        source,
        '''  app.addEventListener("submit", (event) => {
    event.preventDefault();
    if ((event.target as HTMLElement).id === "composer") void submitMessage(draft);
  });''',
        '''  app.addEventListener("submit", (event) => {
    event.preventDefault();
    if ((event.target as HTMLElement).id === "composer") void submitMessage(draft);
  });
  app.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.target as HTMLElement).id === "preferred-name") {
      event.preventDefault();
      if (canContinueOnboarding()) void nextOnboardingStep();
    }
  });
  window.addEventListener("neptune-audio-level", (event) => {
    const level = Number((event as CustomEvent<{ level?: number }>).detail?.level ?? 0);
    document.documentElement.style.setProperty("--audio-level", String(Math.max(0, Math.min(1, level))));
  });''',
        'keyboard and audio bridge',
    )
    source = replace_once(
        source,
        '''  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
  if (!button || button.disabled || actionLocked) return;
  event.preventDefault();
  const action = button.dataset.action ?? "";
  const value = button.dataset.value ?? "";
  actionLocked = true;''',
        '''  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
  if (!button || button.disabled) return;
  event.preventDefault();
  const action = button.dataset.action ?? "";
  const value = button.dataset.value ?? "";
  const actionKey = `${action}:${value}`;
  if (pendingActions.has(actionKey)) return;
  pendingActions.add(actionKey);
  button.disabled = true;
  button.setAttribute("aria-busy", "true");''',
        'per-action dispatcher',
    )
    source = replace_once(
        source,
        '      case "prepare-brain": await prepareBalancedBrain(); break;',
        '      case "prepare-brain": await prepareBalancedBrain(); break;\n      case "retry-voice": await prepareSelectedVoice(true); break;',
        'retry voice action',
    )
    source = replace_once(
        source,
        '''  } finally {
    actionLocked = false;
  }''',
        '''  } finally {
    pendingActions.delete(actionKey);
    if (button.isConnected) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }''',
        'release per-action lock',
    )
    source = replace_once(
        source,
        '    case "preferred-name": preferences.preferredName = target.value.slice(0, 80); break;',
        '''    case "preferred-name": {
      preferences.preferredName = target.value.slice(0, 80);
      const nextButton = app.querySelector<HTMLButtonElement>("button[data-action='onboarding-next']");
      if (nextButton) nextButton.disabled = preferences.preferredName.trim().length < 2;
      void savePreferences();
      break;
    }''',
        'reactive preferred name',
    )
    source = replace_once(
        source,
        '    case "provider-secret": secretDraft = target.value.slice(0, 1_000); break;',
        '''    case "provider-secret": secretDraft = target.value.slice(0, 1_000); break;
    case "advanced-local-model": {
      const applyButton = app.querySelector<HTMLButtonElement>("button[data-action='select-local-model']");
      if (applyButton) applyButton.dataset.value = target.value;
      break;
    }
    case "advanced-provider": void selectProvider(target.value as ProviderId); break;''',
        'advanced settings handlers',
    )
    source = replace_once(
        source,
        '''    voiceState = "ready";
    voiceProgress = 100;
    appendAudit("VOICE_READY", voice.label);
  } catch (error) {
    voiceState = "error";
    transientWarning = `La voix intégrée n’a pas pu être préparée : ${errorMessage(error)}`;
  }''',
        '''    voiceState = "ready";
    voiceProgress = 100;
    if (orbState === "error") orbState = "idle";
    transientWarning = "";
    appendAudit("VOICE_READY", voice.label);
  } catch (error) {
    voiceState = "error";
    orbState = "error";
    appendAudit("VOICE_ERROR", errorMessage(error));
    transientWarning = "La voix intégrée n’a pas pu démarrer. Rechargez Neptune ou utilisez Réessayer.";
  }''',
        'structured voice error',
    )
    source = replace_once(
        source,
        '''  const next: LocalModelSelection = force || current.engine !== "webllm"
    ? { engine: "webllm", modelId: BALANCED_LOCAL_MODEL_ID }
    : current;
  if (next.modelId !== BALANCED_LOCAL_MODEL_ID && force) next.modelId = BALANCED_LOCAL_MODEL_ID;''',
        '''  const recommended = recommendModelId(getLocalModelCatalog());
  const next: LocalModelSelection = force || current.engine !== "webllm"
    ? { engine: "webllm", modelId: recommended || BALANCED_LOCAL_MODEL_ID }
    : current;
  if (force) next.modelId = recommended || BALANCED_LOCAL_MODEL_ID;''',
        'adaptive selection',
    )
    old_brain = '''async function prepareBalancedBrain(): Promise<void> {
  if (brainState === "preparing") return;
  brainState = "preparing";
  brainProgress = 0;
  brainError = "";
  render();
  try {
    await saveLocalModelSelection({ engine: "webllm", modelId: BALANCED_LOCAL_MODEL_ID });
    preferences.providerId = "chrome-local";
    preferences.model = BALANCED_LOCAL_MODEL_ID;
    await savePreferences();
    const api = getLocalLanguageModelApi();
    if (!api) throw new Error("WebGPU n’est pas disponible sur cet ordinateur.");
    const session = await api.create({
      initialPrompts: [{ role: "system", content: "Tu es Neptune. Réponds uniquement : prêt." }],
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          brainProgress = Math.round(Math.max(0, Math.min(1, event.loaded)) * 100);
          render();
        });
      }
    });
    await session.prompt("Réponds uniquement : prêt");
    session.destroy();
    brainProgress = 100;
    brainState = "ready";
    appendAudit("LOCAL_BRAIN_READY", "Neptune Équilibré prêt");
  } catch (error) {
    const apiStatus = await getChromeAiAvailability();
    if (apiStatus !== "unavailable") {
      await saveLocalModelSelection({ engine: "auto", modelId: BALANCED_LOCAL_MODEL_ID });
      brainState = apiStatus === "available" ? "ready" : "idle";
      brainError = "Neptune utilisera automatiquement le meilleur moteur local disponible.";
    } else {
      brainState = "error";
      brainError = errorMessage(error);
    }
  }
  render();
}'''
    new_brain = '''async function prepareBalancedBrain(): Promise<void> {
  if (brainState === "preparing") return;
  brainState = "preparing";
  brainProgress = 0;
  brainError = "";
  render();

  const catalog = getLocalModelCatalog();
  const recommended = recommendModelId(catalog);
  const candidates = [...new Set([
    recommended,
    BALANCED_LOCAL_MODEL_ID,
    ...catalog.filter((model) => model.tier === "fast").map((model) => model.id),
    ...catalog.filter((model) => model.tier === "light").map((model) => model.id)
  ].filter(Boolean))];
  let lastError: unknown = null;

  for (const modelId of candidates) {
    try {
      await saveLocalModelSelection({ engine: "webllm", modelId });
      preferences.providerId = "chrome-local";
      preferences.model = modelId;
      await savePreferences();
      const api = getLocalLanguageModelApi();
      if (!api) throw new Error("Aucun moteur local compatible n’est disponible sur cet ordinateur.");
      const session = await api.create({
        initialPrompts: [{ role: "system", content: "Tu es Neptune. Réponds uniquement : prêt." }],
        monitor(monitor) {
          monitor.addEventListener("downloadprogress", (event) => {
            brainProgress = Math.round(Math.max(0, Math.min(1, event.loaded)) * 100);
            render();
          });
        }
      });
      await session.prompt("Réponds uniquement : prêt");
      session.destroy();
      brainProgress = 100;
      brainState = "ready";
      appendAudit("LOCAL_BRAIN_READY", modelId);
      render();
      return;
    } catch (error) {
      lastError = error;
      appendAudit("LOCAL_BRAIN_FALLBACK", `${modelId}: ${errorMessage(error)}`);
    }
  }

  const apiStatus = await getChromeAiAvailability();
  if (apiStatus === "available") {
    await saveLocalModelSelection({ engine: "chrome-native", modelId: recommended || BALANCED_LOCAL_MODEL_ID });
    brainState = "ready";
    brainProgress = 100;
    brainError = "Neptune utilise l’intelligence locale intégrée à Chrome.";
  } else {
    brainState = "error";
    orbState = "error";
    brainError = "Ce poste ne peut pas exécuter le cerveau local. Ouvrez les paramètres avancés pour connecter un fournisseur.";
    appendAudit("LOCAL_BRAIN_ERROR", errorMessage(lastError));
  }
  render();
}'''
    source = replace_once(source, old_brain, new_brain, 'adaptive brain preparation')
    source = replace_once(
        source,
        '<select class="select" id="advanced-local-model" onchange="this.closest(\'.modal\')?.querySelector(\'[data-action=\\"select-local-model\\"]\')?.setAttribute(\'data-value\', this.value)">',
        '<select class="select" id="advanced-local-model">',
        'remove inline handler',
    )
    source = replace_once(
        source,
        '${voiceState === "preparing" ? progressMarkup("Préparation de la voix intégrée", voiceProgress) : ""}`;',
        '${voiceState === "preparing" ? progressMarkup("Préparation de la voix intégrée", voiceProgress) : voiceState === "error" ? `<div class="notice warning">La voix n\'a pas pu démarrer.</div><button type="button" class="primary-button wide-button" data-action="retry-voice">Réessayer la voix</button>` : ""}`;',
        'voice recovery UI',
    )
    return source


def patch_css(source: str) -> str:
    source = replace_once(source, '  --pink: #f04cc6;', '  --pink: #f04cc6;\n  --audio-level: 0;', 'audio variable')
    source = replace_once(
        source,
        '.neptune-hologram.full { width: min(246px, 72vw); aspect-ratio: 1; }\n.neptune-hologram.compact { width: 112px; height: 112px; }',
        '.neptune-hologram.full { --spectrum-radius: 92px; width: min(246px, 72vw); aspect-ratio: 1; }\n.neptune-hologram.compact { --spectrum-radius: 42px; width: 112px; height: 112px; }',
        'stable radius',
    )
    source = replace_once(
        source,
        '  transform-origin: 50% calc(var(--count) * .22px + 86px);\n  transform: translate(-50%, -100%) rotate(var(--angle)) translateY(calc(-1 * (var(--count) * .20px + 49px))) scaleY(.36);',
        '  transform-origin: center;\n  transform: translate(-50%, -50%) rotate(var(--angle)) translateY(calc(-1 * var(--spectrum-radius))) scaleY(calc(.36 + var(--audio-level) * 1.15));',
        'center spectrum',
    )
    return replace_once(
        source,
        '.neptune-hologram.compact .spectrum-bar { width: 2px; height: 13px; transform-origin: 50% 55px; transform: translate(-50%, -100%) rotate(var(--angle)) translateY(-42px) scaleY(.38); }',
        '.neptune-hologram.compact .spectrum-bar { width: 2px; height: 13px; transform-origin: center; transform: translate(-50%, -50%) rotate(var(--angle)) translateY(calc(-1 * var(--spectrum-radius))) scaleY(calc(.38 + var(--audio-level) * 1.05)); }',
        'center compact spectrum',
    )


patch('apps/extension/src/piper-voice-worker.ts', patch_voice_worker)
patch('apps/extension/esbuild.mjs', patch_build)
patch('apps/extension/src/local-voice-runtime.ts', patch_voice_runtime)
patch('apps/extension/src/service-worker.ts', patch_service)
patch('apps/extension/src/neptune-app.ts', patch_app)
patch('apps/extension/static/sidepanel.css', patch_css)
print('Neptune v1.6 hardening applied')

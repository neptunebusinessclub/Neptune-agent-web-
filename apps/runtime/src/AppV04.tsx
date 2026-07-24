import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { NeptuneOrb } from "./components/NeptuneOrb";
import { Onboarding } from "./components/Onboarding";
import {
  actionNeedsApproval,
  describeBrowserError,
  getNativeBridgeStatus,
  isLikelyBrowserTask,
  planBrowserTask,
  registerBrowserExtensionHost,
  sendBrowserRequest,
  type BrowserMission
} from "./lib/browser";
import {
  askIntelligence,
  createProviders,
  installOllamaModel,
  probeProvider,
  saveProviderSecret,
  speakWithSystemVoice,
  stopSpeaking
} from "./lib/runtime";
import type {
  BrowserAction,
  BrowserResponse,
  ConversationMessage,
  IntelligenceProvider,
  NativeBridgeStatus,
  OrbState,
  TrustLevel,
  UserPreferences,
  VoiceOption
} from "./types";

const STORAGE_KEY = "neptune.runtime.preferences.v1";
const OLLAMA_MODELS = [
  { id: "gemma3:4b", label: "Neptune Rapide", detail: "Bon compromis pour un ordinateur standard" },
  { id: "qwen3:4b", label: "Neptune Équilibré", detail: "Raisonnement et français polyvalents" },
  { id: "llama3.2:3b", label: "Neptune Léger", detail: "Faible consommation de mémoire" }
];

const VOICES: VoiceOption[] = [
  { id: "nereide", name: "Néréide", description: "Féminine, posée et claire", locale: "fr-FR", engine: "system" },
  { id: "triton", name: "Triton", description: "Masculine, profonde et calme", locale: "fr-FR", engine: "system" },
  { id: "nova", name: "Nova", description: "Féminine, vive et directe", locale: "fr-FR", engine: "system" },
  { id: "atlas", name: "Atlas", description: "Masculine, neutre et professionnelle", locale: "fr-FR", engine: "system" }
];

const DEFAULT_PREFERENCES: UserPreferences = {
  preferredName: "",
  voiceId: "nereide",
  trustLevel: "prudent",
  providerId: "",
  modelId: "",
  wakeWordEnabled: false,
  wakeWord: "OK Neptune",
  onboardingComplete: false
};

type View = "assistant" | "intelligence" | "settings";

type SpeechRecognitionEventLike = {
  results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>;
};

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type BlockedState = {
  mission: BrowserMission;
  message: string;
};

function loadPreferences(): UserPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_PREFERENCES, ...JSON.parse(raw) as Partial<UserPreferences> } : DEFAULT_PREFERENCES;
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function newMessage(role: ConversationMessage["role"], text: string, tone?: ConversationMessage["tone"]): ConversationMessage {
  return {
    id: crypto.randomUUID(),
    role,
    text,
    createdAt: new Date().toISOString(),
    ...(tone ? { tone } : {})
  };
}

export default function AppV04() {
  const [preferences, setPreferences] = useState<UserPreferences>(loadPreferences);
  const [providers, setProviders] = useState<IntelligenceProvider[]>(createProviders);
  const [view, setView] = useState<View>("assistant");
  const [orbState, setOrbState] = useState<OrbState>("idle");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [bridge, setBridge] = useState<NativeBridgeStatus>({ connected: false, hostRegistered: false, extensionId: "" });
  const [mission, setMission] = useState<BrowserMission | null>(null);
  const [blocked, setBlocked] = useState<BlockedState | null>(null);
  const [awaitingPermission, setAwaitingPermission] = useState<BrowserMission | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === preferences.providerId),
    [providers, preferences.providerId]
  );

  useEffect(() => {
    void detectLocalProviders();
    void refreshBridge();
    const timer = window.setInterval(() => void refreshBridge(), 3_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  }, [preferences]);

  useEffect(() => {
    if (!preferences.onboardingComplete || messages.length > 0) return;
    const greeting = `Bonjour ${preferences.preferredName}. Je suis Neptune. Mon intelligence et mon bras navigateur sont séparés pour que chaque action reste contrôlable. Que faisons-nous ?`;
    setMessages([newMessage("assistant", greeting)]);
    setOrbState("speaking");
    speakWithSystemVoice(greeting);
    const timer = window.setTimeout(() => setOrbState("idle"), 1_800);
    return () => window.clearTimeout(timer);
  }, [preferences.onboardingComplete, preferences.preferredName, messages.length]);

  async function refreshBridge() {
    setBridge(await getNativeBridgeStatus());
  }

  async function detectLocalProviders() {
    const next = await Promise.all(
      providers.map((provider) => provider.kind === "local" ? probeProvider(provider) : Promise.resolve(provider))
    );
    setProviders(next);
  }

  function completeOnboarding(next: UserPreferences) {
    setPreferences(next);
    setView("assistant");
  }

  function previewVoice(voiceId: string) {
    const voice = VOICES.find((item) => item.id === voiceId);
    setOrbState("speaking");
    speakWithSystemVoice(`Bonjour. Je suis Neptune. Vous écoutez la voix ${voice?.name ?? "sélectionnée"}.`);
    window.setTimeout(() => setOrbState("idle"), 1_800);
  }

  async function submitText(text: string) {
    const clean = text.trim();
    if (!clean) return;
    stopSpeaking();

    if (blocked && /^(continue|continuer|j'ai terminé|c'est fait)/i.test(clean)) {
      setDraft("");
      await resumeMission(blocked.mission);
      return;
    }

    const userMessage = newMessage("user", clean);
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setDraft("");

    if (!selectedProvider || !preferences.modelId) {
      showAssistant(`${preferences.preferredName}, aucun modèle n’est actif. Ouvrez Intelligence pour détecter Ollama ou LM Studio, ou connecter un moteur cloud.`, "warning", "blocked");
      return;
    }

    if (isLikelyBrowserTask(clean)) {
      setOrbState("thinking");
      try {
        const reply = await planBrowserTask(
          selectedProvider,
          preferences.modelId,
          clean,
          preferences.preferredName,
          preferences.trustLevel
        );
        showAssistant(reply.text, reply.requiresPermission ? "permission" : "normal", "speaking", false);
        const actions = reply.actions ?? [];
        if (actions.length === 0) {
          showAssistant("Je n’ai pas obtenu de plan navigateur suffisamment sûr. Reformulez l’objectif en précisant le site et le résultat attendu.", "warning", "blocked");
          return;
        }
        const nextMission: BrowserMission = {
          id: crypto.randomUUID(),
          goal: clean,
          actions: actions.map((action) => ({ ...action, status: "pending" })),
          currentIndex: 0,
          approved: false,
          results: []
        };
        setMission(nextMission);
        setDetailsOpen(true);
        await executeMission(nextMission, true);
      } catch (error) {
        showAssistant(error instanceof Error ? error.message : String(error), "warning", "error");
      }
      return;
    }

    setOrbState("thinking");
    const reply = await askIntelligence(selectedProvider, preferences.modelId, nextMessages, preferences.preferredName);
    showAssistant(
      reply.text,
      reply.requiresPermission ? "permission" : reply.blockedReason ? "warning" : "normal",
      reply.blockedReason ? "blocked" : "speaking"
    );
  }

  function showAssistant(
    text: string,
    tone: ConversationMessage["tone"] = "normal",
    state: OrbState = "speaking",
    speak = true
  ) {
    setMessages((current) => [...current, newMessage("assistant", text, tone)]);
    setOrbState(state);
    if (speak && state !== "blocked" && state !== "error") speakWithSystemVoice(text);
    window.setTimeout(() => setOrbState((current) => current === state ? "idle" : current), 2_300);
  }

  async function executeMission(source: BrowserMission, startNew: boolean) {
    if (!bridge.connected) {
      const message = `${preferences.preferredName}, l’extension Neptune n’est pas reliée au Runtime. Ouvrez Chrome, rechargez l’extension puis cliquez sur « Reconnecter ».`;
      setBlocked({ mission: source, message });
      showAssistant(message, "warning", "blocked", false);
      return;
    }

    let working: BrowserMission = {
      ...source,
      actions: source.actions.map((action) => ({ ...action })),
      results: [...source.results]
    };
    setBlocked(null);
    setAwaitingPermission(null);
    setOrbState("executing");

    try {
      if (startNew && working.currentIndex === 0) {
        const started = await sendBrowserRequest({ type: "START_MISSION" });
        if (!started.ok) throw started;
      }

      for (let index = working.currentIndex; index < working.actions.length; index += 1) {
        const action = working.actions[index];
        if (!action) continue;
        working.currentIndex = index;

        if (actionNeedsApproval(action, preferences.trustLevel) && !working.approved) {
          action.status = "blocked";
          setMission({ ...working, actions: [...working.actions] });
          setAwaitingPermission({ ...working, actions: [...working.actions] });
          setOrbState("permission");
          showAssistant(`L’action « ${action.label} » nécessite votre autorisation. Je n’irai pas plus loin sans votre accord.`, "permission", "permission", false);
          return;
        }

        action.status = "running";
        setMission({ ...working, actions: [...working.actions] });
        const response = await sendBrowserRequest({
          type: "EXECUTE_ACTION",
          action: { ...action, status: "pending" },
          approved: working.approved || !actionNeedsApproval(action, preferences.trustLevel)
        });
        if (!response.ok) throw response;
        action.status = "completed";
        working.results.push({ actionId: action.id, result: response.result ?? null });
        working.currentIndex = index + 1;
        setMission({ ...working, actions: [...working.actions], results: [...working.results] });
      }

      setMission({ ...working, actions: [...working.actions], results: [...working.results] });
      setOrbState("speaking");
      showAssistant("Mission terminée. Les étapes et résultats sont disponibles dans Détails de la mission.", "normal", "speaking");
    } catch (error) {
      const response = isBrowserResponse(error) ? error : ({ ok: false, error: String(error) } satisfies BrowserResponse);
      const action = working.actions[working.currentIndex];
      if (action) action.status = "failed";
      const message = describeBrowserError(response.error, preferences.preferredName);
      const resumable = { ...working, actions: [...working.actions], results: [...working.results] };
      setMission(resumable);
      setBlocked({ mission: resumable, message });
      showAssistant(message, "warning", "blocked", false);
    }
  }

  async function approveMission() {
    if (!awaitingPermission) return;
    const approved = {
      ...awaitingPermission,
      approved: true,
      actions: awaitingPermission.actions.map((action, index) => index === awaitingPermission.currentIndex ? { ...action, status: "pending" as const } : { ...action })
    };
    setAwaitingPermission(null);
    setMission(approved);
    await executeMission(approved, false);
  }

  async function resumeMission(source: BrowserMission) {
    const resumed = {
      ...source,
      actions: source.actions.map((action, index) => index === source.currentIndex ? { ...action, status: "pending" as const } : { ...action })
    };
    setBlocked(null);
    setMission(resumed);
    await executeMission(resumed, false);
  }

  async function stopMission() {
    try {
      await sendBrowserRequest({ type: "STOP_MISSION" });
    } catch {
      // A local stop remains effective even if the extension disconnected.
    }
    setMission(null);
    setBlocked(null);
    setAwaitingPermission(null);
    stopSpeaking();
    setOrbState("idle");
    showAssistant("Mission arrêtée. Aucune action suivante ne sera lancée.", "warning", "idle", false);
  }

  async function reconnectBridge() {
    try {
      await registerBrowserExtensionHost();
    } catch {
      // Registration may already be correct; refresh still provides the real status.
    }
    await refreshBridge();
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submitText(draft);
  }

  function toggleVoiceInput() {
    if (isListening) {
      recognitionRef.current?.stop();
      return;
    }
    const SpeechRecognition = (window as unknown as {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionConstructor }).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      showAssistant("La dictée système n’est pas disponible dans ce moteur. Le wake word local et sherpa-onnx restent le prochain sous-lot vocal.", "warning", "blocked", false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "fr-FR";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results).map((result) => result[0]?.transcript ?? "").join(" ").trim();
      setDraft(transcript);
      const last = event.results[event.results.length - 1];
      if (last?.isFinal && transcript) void submitText(transcript);
    };
    recognition.onerror = () => { setIsListening(false); setOrbState("error"); };
    recognition.onend = () => { setIsListening(false); setOrbState("idle"); };
    recognitionRef.current = recognition;
    setIsListening(true);
    setOrbState("listening");
    recognition.start();
  }

  if (!preferences.onboardingComplete) {
    return (
      <main className="runtime-window onboarding-window">
        <div className="onboarding-orb"><NeptuneOrb state={orbState} /></div>
        <Onboarding voices={VOICES} providers={providers} initial={preferences} onComplete={completeOnboarding} onPreviewVoice={previewVoice} />
      </main>
    );
  }

  return (
    <main className="runtime-window">
      <aside className="sidebar">
        <div className="brand-lockup"><span className="brand-symbol">N</span><span>NEPTUNE</span></div>
        <nav>
          <button className={view === "assistant" ? "active" : ""} onClick={() => setView("assistant")}>Assistant</button>
          <button className={view === "intelligence" ? "active" : ""} onClick={() => setView("intelligence")}>Intelligence</button>
          <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>Préférences</button>
        </nav>
        <div className="runtime-connections">
          <div className="sidebar-status"><span className={`status-dot ${selectedProvider?.status === "available" || selectedProvider?.status === "connected" ? "online" : ""}`} /><div><strong>{selectedProvider?.name ?? "Aucun moteur"}</strong><small>{preferences.modelId || "À configurer"}</small></div></div>
          <div className="sidebar-status"><span className={`status-dot ${bridge.connected ? "online" : ""}`} /><div><strong>Extension navigateur</strong><small>{bridge.connected ? "Connectée" : "Hors ligne"}</small></div></div>
        </div>
      </aside>

      {view === "assistant" && (
        <section className="assistant-view">
          <header className="topbar">
            <div><p className="eyebrow">ASSISTANT PERSONNEL</p><h1>Bonjour {preferences.preferredName}</h1></div>
            <div className="topbar-actions">
              {!bridge.connected && <button className="ghost-button" onClick={() => void reconnectBridge()}>Reconnecter Chrome</button>}
              <button className="ghost-button" onClick={() => setDetailsOpen((value) => !value)}>Détails de la mission</button>
              <button className="stop-button" onClick={() => void stopMission()}>Arrêt immédiat</button>
            </div>
          </header>

          <div className="assistant-grid">
            <div className="orb-column"><NeptuneOrb state={orbState} /></div>
            <div className="conversation-column">
              <div className="conversation" aria-live="polite">
                {messages.map((message) => (
                  <article key={message.id} className={`message ${message.role} ${message.tone ?? "normal"}`}>
                    <span className="message-role">{message.role === "user" ? preferences.preferredName : "Neptune"}</span>
                    <p>{message.text}</p>
                  </article>
                ))}
              </div>

              {awaitingPermission && (
                <div className="intervention-card permission-card">
                  <strong>Autorisation requise</strong>
                  <p>{awaitingPermission.actions[awaitingPermission.currentIndex]?.label}</p>
                  <div><button className="primary-button" onClick={() => void approveMission()}>Autoriser et continuer</button><button className="secondary-button" onClick={() => void stopMission()}>Refuser</button></div>
                </div>
              )}

              {blocked && (
                <div className="intervention-card blocked-card">
                  <strong>Intervention nécessaire</strong>
                  <p>{blocked.message}</p>
                  <div><button className="primary-button" onClick={() => void resumeMission(blocked.mission)}>J’ai terminé, continuer</button><button className="secondary-button" onClick={() => void stopMission()}>Arrêter</button></div>
                </div>
              )}

              <form className="composer" onSubmit={onSubmit}>
                <button type="button" className={`micro-button ${isListening ? "active" : ""}`} onClick={toggleVoiceInput} aria-label="Dicter une commande">●</button>
                <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Écrivez ou dites : « Neptune, ouvre Instagram… »" rows={2} />
                <button className="send-button" type="submit">Envoyer</button>
              </form>
              <p className="wake-word-hint">{preferences.wakeWordEnabled ? `Mot d’activation configuré : « ${preferences.wakeWord} » — activation permanente au prochain lot vocal.` : "Utilisez le bouton micro ou activez le mot d’activation dans Préférences."}</p>
            </div>
          </div>

          {detailsOpen && (
            <aside className="mission-drawer">
              <div className="drawer-heading"><h2>Détails de la mission</h2><button onClick={() => setDetailsOpen(false)}>Fermer</button></div>
              <dl>
                <div><dt>Confiance</dt><dd>{trustLabel(preferences.trustLevel)}</dd></div>
                <div><dt>Moteur</dt><dd>{selectedProvider?.name ?? "Non connecté"}</dd></div>
                <div><dt>Extension</dt><dd>{bridge.connected ? "Connectée" : "Hors ligne"}</dd></div>
                <div><dt>État</dt><dd>{orbState}</dd></div>
              </dl>
              {mission ? <ol className="runtime-action-list">{mission.actions.map((action, index) => <li key={action.id} className={action.status}><span>{index + 1}</span><div><strong>{action.label}</strong><small>{action.type} · {action.status}</small></div></li>)}</ol> : <p>Aucune mission navigateur en cours.</p>}
            </aside>
          )}
        </section>
      )}

      {view === "intelligence" && <IntelligenceView providers={providers} preferences={preferences} onProvidersChange={setProviders} onPreferencesChange={setPreferences} />}
      {view === "settings" && <SettingsView preferences={preferences} onChange={setPreferences} onReset={() => setPreferences(DEFAULT_PREFERENCES)} />}
    </main>
  );
}

function IntelligenceView({ providers, preferences, onProvidersChange, onPreferencesChange }: { providers: IntelligenceProvider[]; preferences: UserPreferences; onProvidersChange: (providers: IntelligenceProvider[]) => void; onPreferencesChange: (preferences: UserPreferences) => void }) {
  const [secretProvider, setSecretProvider] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [notice, setNotice] = useState("");
  const [installing, setInstalling] = useState<string | null>(null);

  async function detect(provider: IntelligenceProvider) {
    setNotice(`Détection de ${provider.name}…`);
    const next = await probeProvider(provider);
    onProvidersChange(providers.map((item) => item.id === provider.id ? next : item));
    setNotice(next.status === "available" ? `${provider.name} détecté.` : `${provider.name} n’est pas joignable.`);
  }

  async function install(provider: IntelligenceProvider, model: string) {
    setInstalling(model);
    setNotice(`Téléchargement de ${model}. Selon la connexion, cela peut prendre plusieurs minutes…`);
    try {
      await installOllamaModel(provider, model);
      const next = await probeProvider(provider);
      onProvidersChange(providers.map((item) => item.id === provider.id ? next : item));
      onPreferencesChange({ ...preferences, providerId: provider.id, modelId: model });
      setNotice(`${model} est installé et sélectionné.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Le téléchargement a échoué.");
    } finally {
      setInstalling(null);
    }
  }

  async function saveSecret(provider: IntelligenceProvider) {
    try {
      await saveProviderSecret(provider.id, secret);
      onProvidersChange(providers.map((item) => item.id === provider.id ? { ...item, status: "connected" } : item));
      setSecretProvider(null);
      setSecret("");
      setNotice(`Clé ${provider.name} enregistrée dans le coffre local.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Impossible d’enregistrer la clé.");
    }
  }

  return (
    <section className="content-view">
      <header className="page-heading"><p className="eyebrow">MOTEURS D’INTELLIGENCE</p><h1>Choisissez comment Neptune réfléchit</h1><p>Local pour la confidentialité, cloud pour la puissance. Les clés restent dans le coffre Windows.</p></header>
      <button className="secondary-button" onClick={() => void Promise.all(providers.filter((item) => item.kind === "local").map(detect))}>Détecter les moteurs locaux</button>
      {notice && <p className="notice">{notice}</p>}
      <div className="provider-catalog">
        {providers.map((provider) => (
          <article key={provider.id} className={`provider-card ${preferences.providerId === provider.id ? "selected" : ""}`}>
            <div className="provider-card-heading"><div><span className={`provider-kind ${provider.kind}`}>{provider.kind === "local" ? "LOCAL" : "CLOUD"}</span><h2>{provider.name}</h2></div><span className={`provider-status ${provider.status}`}>{providerStatus(provider.status)}</span></div>
            <p>{provider.description}</p>
            {provider.models.length > 0 && <select value={preferences.providerId === provider.id ? preferences.modelId : provider.models[0]} onChange={(event) => onPreferencesChange({ ...preferences, providerId: provider.id, modelId: event.target.value })}>{provider.models.map((model) => <option key={model} value={model}>{model}</option>)}</select>}
            {provider.id === "ollama" && provider.status === "available" && <div className="model-install-grid">{OLLAMA_MODELS.map((model) => <button key={model.id} disabled={installing !== null || provider.models.includes(model.id)} onClick={() => void install(provider, model.id)}><strong>{model.label}</strong><small>{model.detail}</small><span>{provider.models.includes(model.id) ? "Installé" : installing === model.id ? "Téléchargement…" : "Installer"}</span></button>)}</div>}
            <div className="provider-actions">
              {provider.kind === "local" ? <button className="secondary-button" onClick={() => void detect(provider)}>Détecter</button> : <button className="secondary-button" onClick={() => setSecretProvider(provider.id)}>Connecter</button>}
              <button className="primary-button" disabled={provider.kind === "local" && provider.status !== "available"} onClick={() => onPreferencesChange({ ...preferences, providerId: provider.id, modelId: provider.models[0] ?? preferences.modelId })}>Utiliser</button>
            </div>
            {secretProvider === provider.id && <div className="secret-panel"><input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="Clé API — jamais envoyée à Cloudflare" /><button className="primary-button" onClick={() => void saveSecret(provider)}>Enregistrer dans le coffre</button></div>}
          </article>
        ))}
      </div>
    </section>
  );
}

function SettingsView({ preferences, onChange, onReset }: { preferences: UserPreferences; onChange: (preferences: UserPreferences) => void; onReset: () => void }) {
  return (
    <section className="content-view settings-view">
      <header className="page-heading"><p className="eyebrow">PRÉFÉRENCES</p><h1>Comportement de Neptune</h1></header>
      <div className="settings-grid">
        <label>Comment dois-je vous appeler ?<input value={preferences.preferredName} onChange={(event) => onChange({ ...preferences, preferredName: event.target.value })} /></label>
        <label>Niveau de confiance<select value={preferences.trustLevel} onChange={(event) => onChange({ ...preferences, trustLevel: event.target.value as TrustLevel })}><option value="prudent">Prudent</option><option value="assisted">Collaborateur</option><option value="controlled">Autonome contrôlé</option></select></label>
        <label className="toggle-row"><span><strong>Mot d’activation</strong><small>Le moteur permanent local arrive dans le lot vocal.</small></span><input type="checkbox" checked={preferences.wakeWordEnabled} onChange={(event) => onChange({ ...preferences, wakeWordEnabled: event.target.checked })} /></label>
        <label>Expression d’activation<select value={preferences.wakeWord} onChange={(event) => onChange({ ...preferences, wakeWord: event.target.value as UserPreferences["wakeWord"] })}><option>Neptune</option><option>OK Neptune</option></select></label>
      </div>
      <div className="security-panel"><h2>Limites non négociables</h2><p>Paiements, suppressions, signatures, mots de passe, permissions et engagements contractuels exigent toujours votre confirmation explicite.</p></div>
      <button className="danger-outline" onClick={onReset}>Recommencer la configuration initiale</button>
    </section>
  );
}

function trustLabel(level: TrustLevel): string {
  return level === "prudent" ? "Prudent" : level === "assisted" ? "Collaborateur" : "Autonome contrôlé";
}

function providerStatus(status: IntelligenceProvider["status"]): string {
  if (status === "available") return "Détecté";
  if (status === "connected") return "Connecté";
  if (status === "unavailable") return "Indisponible";
  return "À vérifier";
}

function isBrowserResponse(value: unknown): value is BrowserResponse {
  return typeof value === "object" && value !== null && "ok" in value;
}

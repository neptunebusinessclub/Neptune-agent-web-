import { useEffect, useMemo, useState } from "react";
import { getNativeBridgeStatus, registerBrowserExtensionHost } from "../lib/browser";
import { speakWithSystemVoice, stopSpeaking } from "../lib/runtime";
import type { IntelligenceProvider, NativeBridgeStatus, TrustLevel, UserPreferences, VoiceOption } from "../types";

const TRUST_LEVELS: Array<{ id: TrustLevel; title: string; description: string }> = [
  {
    id: "prudent",
    title: "Prudent",
    description: "Neptune demande avant toute écriture, publication ou communication externe."
  },
  {
    id: "assisted",
    title: "Collaborateur",
    description: "Une autorisation peut couvrir une mission et un volume d’actions clairement défini."
  },
  {
    id: "controlled",
    title: "Autonome contrôlé",
    description: "Neptune agit dans les règles, domaines et quotas que vous avez approuvés."
  }
];

const STEP_COUNT = 6;
const EMPTY_BRIDGE: NativeBridgeStatus = { connected: false, hostRegistered: false, extensionId: "" };

export function Onboarding({
  voices,
  providers,
  initial,
  onComplete,
  onPreviewVoice
}: {
  voices: VoiceOption[];
  providers: IntelligenceProvider[];
  initial: UserPreferences;
  onComplete: (preferences: UserPreferences) => void;
  onPreviewVoice: (voiceId: string) => void;
}) {
  const [step, setStep] = useState(0);
  const [preferences, setPreferences] = useState(initial);
  const [bridge, setBridge] = useState<NativeBridgeStatus>(EMPTY_BRIDGE);
  const [checkingBrowser, setCheckingBrowser] = useState(false);
  const availableProviders = useMemo(
    () => providers.filter((provider) => provider.status === "available" || provider.kind === "cloud"),
    [providers]
  );

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const status = await getNativeBridgeStatus();
      if (active) setBridge(status);
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const name = preferences.preferredName.trim();
    const lines = [
      "Bonjour. Je suis Neptune. Avant de commencer, comment dois-je vous appeler ?",
      `${name ? `Merci ${name}. ` : ""}Choisissez maintenant ma voix. Vous pouvez pré-écouter chaque proposition.`,
      "Quel niveau de confiance m’accordez-vous ? Je vous expliquerai toujours les actions sensibles avant de les exécuter.",
      "Choisissez maintenant le moteur d’intelligence que je dois utiliser. Vous pourrez le changer plus tard.",
      "Souhaitez-vous m’activer en disant Neptune, ou OK Neptune ?",
      "Dernière étape. Relions-moi à votre navigateur pour que je travaille dans un onglet séparé."
    ];
    const timer = window.setTimeout(() => speakWithSystemVoice(lines[step] ?? ""), 260);
    return () => {
      window.clearTimeout(timer);
      stopSpeaking();
    };
  }, [step]);

  const canContinue =
    (step === 0 && preferences.preferredName.trim().length >= 2)
    || (step === 1 && Boolean(preferences.voiceId))
    || (step === 2 && Boolean(preferences.trustLevel))
    || (step === 3 && Boolean(preferences.providerId))
    || step === 4
    || step === 5;

  function next() {
    if (!canContinue) return;
    if (step < STEP_COUNT - 1) {
      setStep((current) => current + 1);
      return;
    }
    stopSpeaking();
    const provider = providers.find((item) => item.id === preferences.providerId);
    const modelId = preferences.modelId || provider?.models[0] || "";
    onComplete({ ...preferences, modelId, onboardingComplete: true });
  }

  async function reconnectBrowser() {
    setCheckingBrowser(true);
    try {
      await registerBrowserExtensionHost();
    } catch {
      // The host may already be registered; the status check below is authoritative.
    }
    setBridge(await getNativeBridgeStatus());
    setCheckingBrowser(false);
  }

  return (
    <div className="onboarding-shell">
      <div className="onboarding-progress" aria-label={`Étape ${step + 1} sur ${STEP_COUNT}`}>
        {Array.from({ length: STEP_COUNT }, (_, item) => <span key={item} className={item <= step ? "active" : ""} />)}
      </div>

      {step === 0 && (
        <section className="onboarding-card">
          <p className="eyebrow">PREMIER ÉCHANGE</p>
          <h1>Comment dois-je vous appeler&nbsp;?</h1>
          <p>Ce prénom sera utilisé uniquement lorsque l’échange le justifie, notamment en cas de blocage ou de validation importante.</p>
          <input
            autoFocus
            value={preferences.preferredName}
            onChange={(event) => setPreferences({ ...preferences, preferredName: event.target.value })}
            placeholder="Votre prénom"
          />
        </section>
      )}

      {step === 1 && (
        <section className="onboarding-card">
          <p className="eyebrow">PERSONNALITÉ VOCALE</p>
          <h1>Choisissez ma voix</h1>
          <p>Pré-écoutez chaque voix avant de décider. Vous pourrez la modifier à tout moment.</p>
          <div className="choice-grid voice-grid">
            {voices.map((voice) => (
              <button
                type="button"
                key={voice.id}
                className={`choice-card ${preferences.voiceId === voice.id ? "selected" : ""}`}
                onClick={() => setPreferences({ ...preferences, voiceId: voice.id })}
              >
                <span className="choice-title">{voice.name}</span>
                <span className="choice-description">{voice.description}</span>
                <span
                  className="preview-link"
                  onClick={(event) => {
                    event.stopPropagation();
                    onPreviewVoice(voice.id);
                  }}
                >Pré-écouter</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="onboarding-card">
          <p className="eyebrow">AUTORISATIONS</p>
          <h1>Quel niveau de confiance m’accordez-vous&nbsp;?</h1>
          <div className="choice-grid">
            {TRUST_LEVELS.map((level) => (
              <button
                type="button"
                key={level.id}
                className={`choice-card ${preferences.trustLevel === level.id ? "selected" : ""}`}
                onClick={() => setPreferences({ ...preferences, trustLevel: level.id })}
              >
                <span className="choice-title">{level.title}</span>
                <span className="choice-description">{level.description}</span>
              </button>
            ))}
          </div>
          <p className="security-note">Paiements, suppressions, signatures, sécurité et engagements contractuels restent toujours soumis à votre confirmation.</p>
        </section>
      )}

      {step === 3 && (
        <section className="onboarding-card">
          <p className="eyebrow">INTELLIGENCE</p>
          <h1>Choisissez mon moteur</h1>
          <p>Local pour la confidentialité, cloud pour la puissance. Vous pourrez changer de modèle sans recommencer la configuration.</p>
          <div className="choice-grid provider-grid">
            {availableProviders.map((provider) => (
              <button
                type="button"
                key={provider.id}
                className={`choice-card ${preferences.providerId === provider.id ? "selected" : ""}`}
                onClick={() => setPreferences({
                  ...preferences,
                  providerId: provider.id,
                  modelId: provider.models[0] ?? ""
                })}
              >
                <span className="choice-title-row">
                  <span className="choice-title">{provider.name}</span>
                  <span className={`provider-kind ${provider.kind}`}>{provider.kind === "local" ? "LOCAL" : "CLOUD"}</span>
                </span>
                <span className="choice-description">{provider.description}</span>
                <span className="provider-state">
                  {provider.status === "available" ? `${provider.models.length} modèle(s) détecté(s)` : "Connexion guidée après l’installation"}
                </span>
              </button>
            ))}
          </div>
          {availableProviders.length === 0 && (
            <div className="onboarding-warning">
              Aucun moteur local n’est détecté. Installez Ollama ou LM Studio, puis revenez à cette étape.
            </div>
          )}
        </section>
      )}

      {step === 4 && (
        <section className="onboarding-card">
          <p className="eyebrow">ACTIVATION VOCALE</p>
          <h1>Comment souhaitez-vous m’appeler&nbsp;?</h1>
          <p>Le mot d’activation sera traité localement lorsque le moteur vocal permanent sera installé.</p>
          <label className="onboarding-toggle">
            <span><strong>Activer le mot d’activation</strong><small>Le microphone restera visible lorsque l’écoute est active.</small></span>
            <input
              type="checkbox"
              checked={preferences.wakeWordEnabled}
              onChange={(event) => setPreferences({ ...preferences, wakeWordEnabled: event.target.checked })}
            />
          </label>
          <div className="choice-grid wake-word-grid">
            {(["Neptune", "OK Neptune"] as const).map((wakeWord) => (
              <button
                type="button"
                key={wakeWord}
                disabled={!preferences.wakeWordEnabled}
                className={`choice-card ${preferences.wakeWord === wakeWord ? "selected" : ""}`}
                onClick={() => setPreferences({ ...preferences, wakeWord })}
              >
                <span className="choice-title">«&nbsp;{wakeWord}&nbsp;»</span>
                <span className="choice-description">Expression utilisée pour commencer une commande vocale.</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {step === 5 && (
        <section className="onboarding-card">
          <p className="eyebrow">NAVIGATEUR</p>
          <h1>Relions-moi à votre navigateur</h1>
          <p>L’extension est mon bras navigateur. Elle doit être installée et connectée pour que je puisse agir dans un onglet de travail séparé.</p>
          <div className={`browser-pairing-card ${bridge.connected ? "connected" : "disconnected"}`}>
            <span className="pairing-light" />
            <div>
              <strong>{bridge.connected ? "Extension Neptune connectée" : "Extension Neptune non détectée"}</strong>
              <small>{bridge.connected ? "Le pont local sécurisé est opérationnel." : "Ouvrez Chrome, rechargez l’extension puis relancez la vérification."}</small>
            </div>
          </div>
          {!bridge.connected && (
            <button type="button" className="secondary-button browser-retry" disabled={checkingBrowser} onClick={() => void reconnectBrowser()}>
              {checkingBrowser ? "Vérification…" : "Vérifier la connexion"}
            </button>
          )}
          <p className="security-note">Vous pouvez terminer sans navigateur et le connecter plus tard depuis les préférences.</p>
        </section>
      )}

      <footer className="onboarding-actions">
        <button type="button" className="ghost-button" disabled={step === 0} onClick={() => setStep((current) => current - 1)}>
          Retour
        </button>
        <button type="button" className="primary-button" disabled={!canContinue} onClick={next}>
          {step === STEP_COUNT - 1 ? (bridge.connected ? "Commencer avec Neptune" : "Terminer sans navigateur") : "Continuer"}
        </button>
      </footer>
    </div>
  );
}
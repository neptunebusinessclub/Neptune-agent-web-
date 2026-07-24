import { useMemo, useState } from "react";
import type { IntelligenceProvider, TrustLevel, UserPreferences, VoiceOption } from "../types";

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
  const availableProviders = useMemo(
    () => providers.filter((provider) => provider.status === "available" || provider.kind === "cloud"),
    [providers]
  );

  const canContinue =
    (step === 0 && preferences.preferredName.trim().length >= 2)
    || (step === 1 && Boolean(preferences.voiceId))
    || (step === 2 && Boolean(preferences.trustLevel))
    || (step === 3 && Boolean(preferences.providerId));

  function next() {
    if (!canContinue) return;
    if (step < 3) {
      setStep((current) => current + 1);
      return;
    }
    const provider = providers.find((item) => item.id === preferences.providerId);
    const modelId = preferences.modelId || provider?.models[0] || "";
    onComplete({ ...preferences, modelId, onboardingComplete: true });
  }

  return (
    <div className="onboarding-shell">
      <div className="onboarding-progress" aria-label={`Étape ${step + 1} sur 4`}>
        {[0, 1, 2, 3].map((item) => <span key={item} className={item <= step ? "active" : ""} />)}
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
          <p>Pré-écoutez les voix disponibles. Les moteurs locaux Kokoro et Piper seront proposés dès qu’ils sont installés.</p>
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
          <p>Vous pourrez changer de modèle à tout moment. Les clés cloud restent dans le coffre sécurisé de l’ordinateur.</p>
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
                  {provider.status === "available" ? `${provider.models.length} modèle(s) détecté(s)` : "Connexion à configurer"}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <footer className="onboarding-actions">
        <button type="button" className="ghost-button" disabled={step === 0} onClick={() => setStep((current) => current - 1)}>
          Retour
        </button>
        <button type="button" className="primary-button" disabled={!canContinue} onClick={next}>
          {step === 3 ? "Démarrer avec Neptune" : "Continuer"}
        </button>
      </footer>
    </div>
  );
}

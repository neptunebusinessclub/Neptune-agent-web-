import { unlockLocalAudio } from "./local-voice-runtime";

const PREFERENCES_KEY = "neptune.preferences.v2";
let visualEnvelope = 0;
let permissionRequestRunning = false;

window.addEventListener("neptune-audio-level", (event) => {
  event.stopImmediatePropagation();
  const raw = Number((event as CustomEvent<{ level?: number }>).detail?.level ?? 0);
  const target = Math.max(0, Math.min(1, raw));
  visualEnvelope += (target - visualEnvelope) * (target > visualEnvelope ? 0.14 : 0.07);
  document.documentElement.style.setProperty("--audio-level", visualEnvelope.toFixed(4));
}, { capture: true });

document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const voiceButton = target.closest<HTMLButtonElement>("button[data-action='select-gender'], button[data-action='preview-gender']");
  if (voiceButton) void unlockLocalAudio().catch(() => undefined);

  const activationButton = target.closest<HTMLButtonElement>("button[data-action='test-activation']");
  if (activationButton && activationButton.dataset.microphoneReady !== "true") {
    event.preventDefault();
    event.stopImmediatePropagation();
    void requestMicrophoneThenContinue(activationButton);
    return;
  }

  const premiumButton = target.closest<HTMLButtonElement>("button[data-premium-action]");
  if (!premiumButton) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const action = premiumButton.dataset.premiumAction;
  if (action === "retry-microphone") {
    const testButton = document.querySelector<HTMLButtonElement>("button[data-action='test-activation']");
    if (testButton) void requestMicrophoneThenContinue(testButton);
  } else if (action === "continue-without-microphone") {
    void continueWithoutMicrophone();
  }
}, true);

const observer = new MutationObserver(() => {
  const permissionNotice = Array.from(document.querySelectorAll<HTMLElement>(".notice"))
    .find((element) => /permission dismissed|microphone|reconnaissance vocale.*refus|accès au microphone/i.test(element.textContent ?? ""));
  if (permissionNotice) {
    permissionNotice.textContent = "Le microphone n’a pas été autorisé. Neptune reste utilisable au clavier : vous pourrez réactiver la voix plus tard.";
    permissionNotice.classList.add("warning");
    ensureMicrophoneRecovery("Chrome n’a pas accordé l’accès au microphone.");
  }
});
observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

async function requestMicrophoneThenContinue(button: HTMLButtonElement): Promise<void> {
  if (permissionRequestRunning) return;
  permissionRequestRunning = true;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = "Autorisation du micro…";
  removeMicrophoneRecovery();

  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Le microphone n’est pas accessible dans cette version de Chrome.");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    button.dataset.microphoneReady = "true";
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = "Je vous écoute…";
    button.click();
    window.setTimeout(() => delete button.dataset.microphoneReady, 1_000);
  } catch (error) {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = "Réessayer le microphone";
    ensureMicrophoneRecovery(permissionMessage(error));
  } finally {
    permissionRequestRunning = false;
  }
}

function ensureMicrophoneRecovery(message: string): void {
  const copy = document.querySelector<HTMLElement>(".onboarding-copy");
  if (!copy || document.getElementById("neptune-microphone-recovery")) return;
  const panel = document.createElement("section");
  panel.id = "neptune-microphone-recovery";
  panel.className = "microphone-recovery";
  panel.innerHTML = `<strong>Le vocal n’est pas bloquant</strong><p>${escapeHtml(message)} Autorisez le microphone dans Chrome, ou continuez maintenant au clavier.</p><div class="microphone-recovery-actions"><button type="button" class="primary-button" data-premium-action="retry-microphone">Réessayer</button><button type="button" class="ghost-button" data-premium-action="continue-without-microphone">Continuer sans le micro</button></div>`;
  copy.append(panel);
}

function removeMicrophoneRecovery(): void {
  document.getElementById("neptune-microphone-recovery")?.remove();
}

async function continueWithoutMicrophone(): Promise<void> {
  const stored = await chrome.storage.local.get(PREFERENCES_KEY);
  const current = stored[PREFERENCES_KEY] && typeof stored[PREFERENCES_KEY] === "object"
    ? stored[PREFERENCES_KEY] as Record<string, unknown>
    : {};
  await chrome.storage.local.set({
    [PREFERENCES_KEY]: {
      ...current,
      productVersion: 17,
      onboardingStep: 3,
      wakeWordEnabled: false,
      autoResumeVoice: false
    }
  });
  location.reload();
}

function permissionMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") return "La demande a été refusée ou fermée.";
    if (error.name === "NotFoundError") return "Aucun microphone n’est disponible sur cet ordinateur.";
    if (error.name === "NotReadableError") return "Le microphone est déjà utilisé par une autre application.";
  }
  return error instanceof Error ? error.message : "Le microphone n’a pas pu être initialisé.";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

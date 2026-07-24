type CompanionState = {
  complete: boolean;
  step: number;
};

type RuntimeResponse = {
  ok?: boolean;
  error?: string;
};

const STORAGE_COMPLETE = "neptuneCompanionOnboardingComplete";
const STORAGE_STEP = "neptuneCompanionOnboardingStep";
const LAST_STEP = 3;

const elements = {
  onboarding: get<HTMLElement>("onboarding-view"),
  companion: get<HTMLElement>("companion-view"),
  progress: get<HTMLDivElement>("progress"),
  stepContent: get<HTMLDivElement>("step-content"),
  back: get<HTMLButtonElement>("back-step"),
  next: get<HTMLButtonElement>("next-step"),
  status: get<HTMLSpanElement>("companion-status"),
  extensionDetail: get<HTMLElement>("extension-detail"),
  checkExtension: get<HTMLButtonElement>("check-extension"),
  restart: get<HTMLButtonElement>("restart-onboarding")
};

let state: CompanionState = { complete: false, step: 0 };

void initialize();

async function initialize(): Promise<void> {
  state = await loadState();
  bindEvents();
  render();
  await checkExtension();
}

function bindEvents(): void {
  elements.back.addEventListener("click", () => {
    state.step = Math.max(0, state.step - 1);
    void persistState();
    render();
  });

  elements.next.addEventListener("click", () => {
    if (state.step < LAST_STEP) {
      state.step += 1;
      void persistState();
      render();
      return;
    }
    state.complete = true;
    void persistState();
    render();
  });

  elements.checkExtension.addEventListener("click", () => void checkExtension(true));
  elements.restart.addEventListener("click", () => {
    state = { complete: false, step: 0 };
    void persistState();
    render();
  });
}

async function loadState(): Promise<CompanionState> {
  const stored = await chrome.storage.local.get([STORAGE_COMPLETE, STORAGE_STEP]);
  return {
    complete: stored[STORAGE_COMPLETE] === true,
    step: typeof stored[STORAGE_STEP] === "number"
      ? Math.min(LAST_STEP, Math.max(0, stored[STORAGE_STEP]))
      : 0
  };
}

async function persistState(): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_COMPLETE]: state.complete,
    [STORAGE_STEP]: state.step
  });
}

function render(): void {
  elements.onboarding.classList.toggle("hidden", state.complete);
  elements.companion.classList.toggle("hidden", !state.complete);
  if (state.complete) return;

  elements.progress.replaceChildren(...Array.from({ length: LAST_STEP + 1 }, (_, index) => {
    const item = document.createElement("span");
    if (index <= state.step) item.classList.add("active");
    return item;
  }));

  elements.back.disabled = state.step === 0;
  elements.next.textContent = state.step === LAST_STEP ? "Terminer l’installation" : nextLabel(state.step);
  elements.stepContent.innerHTML = stepMarkup(state.step);
}

function nextLabel(step: number): string {
  if (step === 0) return "Commencer";
  if (step === 1) return "Neptune est ouvert";
  if (step === 2) return "Continuer";
  return "Terminer";
}

function stepMarkup(step: number): string {
  if (step === 0) {
    return `
      <p class="eyebrow">PREMIÈRE INSTALLATION</p>
      <h2>Je suis Neptune.</h2>
      <p>L’application est mon intelligence et ma voix. Cette extension est mon bras navigateur. Les deux fonctionnent ensemble, mais votre conversation reste dans l’application Neptune.</p>
      <ul class="step-list">
        <li><span>1</span><div>Une conversation simple, textuelle ou vocale.</div></li>
        <li><span>2</span><div>Un onglet de travail séparé pour chaque mission.</div></li>
        <li><span>3</span><div>Une confirmation claire avant toute action sensible.</div></li>
      </ul>`;
  }

  if (step === 1) {
    return `
      <p class="eyebrow">APPLICATION PRINCIPALE</p>
      <h2>Ouvrez Neptune Runtime.</h2>
      <p>Lors de la première ouverture, Neptune vous accueille et configure le produit avec vous, étape par étape. Gardez ensuite l’application ouverte pendant les missions navigateur.</p>
      <ul class="step-list">
        <li><span>01</span><div>Lancez l’application Neptune installée sur Windows.</div></li>
        <li><span>02</span><div>Attendez l’écran de présentation avec l’orbe Neptune.</div></li>
        <li><span>03</span><div>Revenez ici une fois l’application ouverte.</div></li>
      </ul>`;
  }

  if (step === 2) {
    return `
      <p class="eyebrow">CONFIGURATION PERSONNELLE</p>
      <h2>Neptune apprend à travailler avec vous.</h2>
      <p>Le premier échange dans l’application doit configurer les éléments qui changent réellement son comportement.</p>
      <ul class="step-list">
        <li><span>N</span><div>Votre prénom et la manière dont Neptune doit vous appeler.</div></li>
        <li><span>V</span><div>Sa voix, avec pré-écoute avant validation.</div></li>
        <li><span>C</span><div>Le niveau de confiance et les autorisations accordées.</div></li>
        <li><span>IA</span><div>Le moteur d’intelligence local ou cloud à utiliser.</div></li>
        <li><span>●</span><div>Le mot d’activation « Neptune » ou « OK Neptune ».</div></li>
      </ul>`;
  }

  return `
    <p class="eyebrow">CONNEXION NAVIGATEUR</p>
    <h2>Le compagnon est prêt.</h2>
    <p>Vous n’avez aucune URL technique ni aucun jeton API à saisir ici. L’application Neptune pilote directement cette extension par un pont local sécurisé.</p>
    <div class="connection-check">Extension chargée et prête à recevoir Neptune</div>
    <ul class="step-list">
      <li><span>✓</span><div>Les missions utilisent un nouvel onglet dédié.</div></li>
      <li><span>✓</span><div>Votre onglet personnel n’est pas réutilisé par défaut.</div></li>
      <li><span>✓</span><div>Les actions sensibles restent bloquées sans confirmation.</div></li>
    </ul>`;
}

async function checkExtension(showChecking = false): Promise<void> {
  if (showChecking) {
    elements.status.textContent = "Vérification";
    elements.status.className = "status status-checking";
    elements.extensionDetail.textContent = "Contrôle du service navigateur…";
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB" }) as RuntimeResponse | undefined;
    if (!response?.ok) throw new Error(response?.error ?? "Service indisponible");
    elements.status.textContent = "Prêt";
    elements.status.className = "status status-online";
    elements.extensionDetail.textContent = `Compagnon actif · version ${chrome.runtime.getManifest().version}`;
  } catch {
    elements.status.textContent = "À reconnecter";
    elements.status.className = "status status-offline";
    elements.extensionDetail.textContent = "Rechargez l’extension depuis chrome://extensions";
  }
}

function get<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Élément manquant : ${id}`);
  return element as T;
}
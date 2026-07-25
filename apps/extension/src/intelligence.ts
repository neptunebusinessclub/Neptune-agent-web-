import type { BrowserAction } from "@neptune/protocol";
import {
  getLocalLanguageModelApi,
  type LocalLanguageModelSession,
  type LocalModelAvailability
} from "./local-model-runtime";

export type ProviderId = "chrome-local" | "mammouth" | "openai-compatible";
export type TrustLevel = "prudent" | "assisted" | "controlled";

export type ProviderConfig = {
  id: ProviderId;
  endpoint?: string;
  model?: string;
  apiKey?: string;
};

export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
};

export type AgentReply = {
  text: string;
  actions: BrowserAction[];
};

const MAX_MESSAGES = 18;
const MAX_ACTIONS = 24;
const BLOCKED_GOAL = /\b(payer|paiement|acheter|commande|carte bancaire|iban|virement|mot de passe|password|supprimer le compte|signature|signer|contrat)\b/i;
const BROWSER_SIGNALS = /\b(ouvre|va sur|navigue|cherche sur|lis la page|clique|remplis|sélectionne|selectionne|fais défiler|defiler|envoie un message|instagram|linkedin|leboncoin|le bon coin|site web|navigateur|page actuelle)\b/i;

let chromeSession: LocalLanguageModelSession | null = null;
let chromeSessionOwner = "";

export function isBrowserTask(text: string): boolean {
  return BROWSER_SIGNALS.test(text);
}

export function isForbiddenGoal(text: string): boolean {
  return BLOCKED_GOAL.test(text);
}

export async function getChromeAiAvailability(): Promise<LocalModelAvailability> {
  const api = getLocalLanguageModelApi();
  if (!api) return "unavailable";
  try {
    return await api.availability({
      expectedInputs: [{ type: "text", languages: ["fr", "en"] }],
      expectedOutputs: [{ type: "text", languages: ["fr"] }]
    });
  } catch {
    return "unavailable";
  }
}

export async function prepareChromeAi(userName: string, onProgress: (progress: number) => void): Promise<void> {
  const api = getLocalLanguageModelApi();
  if (!api) throw new Error("Aucun moteur local compatible n’est disponible sur cet ordinateur.");
  chromeSession?.destroy();
  chromeSession = await api.create({
    expectedInputs: [{ type: "text", languages: ["fr", "en"] }],
    expectedOutputs: [{ type: "text", languages: ["fr"] }],
    initialPrompts: [{
      role: "system",
      content: systemPrompt(userName)
    }],
    monitor(monitor) {
      monitor.addEventListener("downloadprogress", (event) => onProgress(Math.round(event.loaded * 100)));
    }
  });
  chromeSessionOwner = userName;
}

export function destroyChromeAi(): void {
  chromeSession?.destroy();
  chromeSession = null;
  chromeSessionOwner = "";
}

export async function askIntelligence(
  provider: ProviderConfig,
  userName: string,
  messages: ChatTurn[],
  signal?: AbortSignal
): Promise<string> {
  const cleanMessages = messages.slice(-MAX_MESSAGES).map((message) => ({
    role: message.role,
    content: message.content.slice(0, 12_000)
  }));

  if (provider.id === "chrome-local") {
    if (!chromeSession || chromeSessionOwner !== userName) {
      await prepareChromeAi(userName, () => undefined);
    }
    const transcript = cleanMessages.map((message) => `${message.role === "user" ? "Utilisateur" : "Neptune"}: ${message.content}`).join("\n\n");
    return chromeSession!.prompt(transcript, signal ? { signal } : undefined);
  }

  return callOpenAiCompatible(provider, [
    { role: "system", content: systemPrompt(userName) },
    ...cleanMessages
  ], signal);
}

export async function planBrowserTask(
  provider: ProviderConfig,
  userName: string,
  trustLevel: TrustLevel,
  goal: string,
  pageContext?: unknown,
  signal?: AbortSignal
): Promise<AgentReply> {
  if (isForbiddenGoal(goal)) {
    return {
      text: `${userName}, cette demande touche une action que Neptune ne doit pas automatiser. Je peux vous guider, mais je ne l’exécuterai pas.`,
      actions: []
    };
  }

  const pageSection = pageContext
    ? `\nÉtat de la page actuellement observée :\n${JSON.stringify(pageContext).slice(0, 14_000)}`
    : "";
  const prompt = `${plannerPrompt(userName, trustLevel)}\n\nObjectif : ${goal}${pageSection}`;
  let raw: string;

  if (provider.id === "chrome-local") {
    if (!chromeSession || chromeSessionOwner !== userName) await prepareChromeAi(userName, () => undefined);
    raw = await chromeSession!.prompt(prompt, signal ? { signal } : undefined);
  } else {
    raw = await callOpenAiCompatible(provider, [
      { role: "system", content: plannerPrompt(userName, trustLevel) },
      { role: "user", content: `Objectif : ${goal}${pageSection}` }
    ], signal);
  }

  return normalizePlan(extractJson(raw), raw);
}

export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  if (!candidate || !candidate.includes("{")) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

export function normalizePlan(value: unknown, fallbackText = ""): AgentReply {
  if (!value || typeof value !== "object") {
    return { text: fallbackText.trim() || "Je n’ai pas pu construire un plan suffisamment fiable.", actions: [] };
  }
  const record = value as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text.slice(0, 1_200) : "J’ai préparé un plan contrôlé.";
  const source = Array.isArray(record.actions) ? record.actions : [];
  const actions = source.slice(0, MAX_ACTIONS).flatMap((item) => normalizeAction(item));
  return { text, actions };
}

function normalizeAction(value: unknown): BrowserAction[] {
  if (!value || typeof value !== "object") return [];
  const action = value as Record<string, unknown>;
  const type = typeof action.type === "string" ? action.type.toUpperCase() : "";
  const allowed = [
    "OPEN_URL",
    "READ_PAGE",
    "CLICK_ELEMENT",
    "FILL_FIELD",
    "SELECT_OPTION",
    "PRESS_KEY",
    "SCROLL_PAGE",
    "WAIT_FOR_ELEMENT",
    "NAVIGATE_BACK",
    "SEND_MESSAGE",
    "WAIT"
  ] as const;
  if (!allowed.includes(type as typeof allowed[number])) return [];

  let risk: BrowserAction["risk"] = action.risk === "draft_write" || action.risk === "external_write" || action.risk === "sensitive"
    ? action.risk
    : "read_only";
  let requiresApproval = action.requiresApproval === true;
  if (type === "SEND_MESSAGE") {
    risk = "external_write";
    requiresApproval = true;
  }
  if (risk === "external_write" || risk === "sensitive") requiresApproval = true;

  const target = normalizeTarget(action.target);
  if (["CLICK_ELEMENT", "FILL_FIELD", "SELECT_OPTION", "WAIT_FOR_ELEMENT", "SEND_MESSAGE"].includes(type) && !target) return [];
  const url = typeof action.url === "string" ? safeUrl(action.url) : undefined;
  if (type === "OPEN_URL" && !url) return [];
  const valueText = typeof action.value === "string" ? action.value.slice(0, 10_000) : undefined;
  if (["FILL_FIELD", "SELECT_OPTION", "PRESS_KEY", "SCROLL_PAGE", "SEND_MESSAGE"].includes(type) && valueText === undefined) return [];

  return [{
    id: crypto.randomUUID(),
    type: type as BrowserAction["type"],
    label: typeof action.label === "string" ? action.label.slice(0, 180) : type,
    risk,
    requiresApproval,
    status: "pending",
    ...(target ? { target } : {}),
    ...(url ? { url } : {}),
    ...(valueText !== undefined ? { value: valueText } : {}),
    ...(typeof action.delayMs === "number" ? { delayMs: Math.max(0, Math.min(60_000, Math.round(action.delayMs))) } : {})
  }];
}

function normalizeTarget(value: unknown): BrowserAction["target"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const target = {
    ...(typeof source.selector === "string" && source.selector.trim() ? { selector: source.selector.slice(0, 500) } : {}),
    ...(typeof source.role === "string" && source.role.trim() ? { role: source.role.slice(0, 80) } : {}),
    ...(typeof source.name === "string" && source.name.trim() ? { name: source.name.slice(0, 300) } : {}),
    ...(typeof source.text === "string" && source.text.trim() ? { text: source.text.slice(0, 300) } : {})
  };
  return Object.keys(target).length > 0 ? target : undefined;
}

async function callOpenAiCompatible(
  provider: ProviderConfig,
  messages: Array<{ role: string; content: string }>,
  signal?: AbortSignal
): Promise<string> {
  const apiKey = provider.apiKey?.trim();
  if (!apiKey) throw new Error("La clé API de ce moteur n’est pas configurée.");
  const base = provider.id === "mammouth"
    ? "https://api.mammouth.ai/v1"
    : normalizeEndpoint(provider.endpoint);
  const model = provider.model?.trim() || (provider.id === "mammouth" ? "mammouth-recommended" : "");
  if (!model) throw new Error("Aucun modèle cloud n’est sélectionné.");

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 90_000);
  const combinedSignal = signal ?? controller.signal;
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model, messages, temperature: .2, max_tokens: 2_000, stream: false }),
      signal: combinedSignal
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      const error = payload?.error as Record<string, unknown> | string | undefined;
      const message = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : `HTTP ${response.status}`;
      throw new Error(`Le moteur cloud a refusé la requête : ${message}`);
    }
    const choices = payload?.choices;
    if (!Array.isArray(choices)) throw new Error("Le moteur cloud n’a renvoyé aucune réponse exploitable.");
    const content = (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("Le moteur cloud a renvoyé une réponse vide.");
    return content.trim();
  } finally {
    window.clearTimeout(timeout);
  }
}

function normalizeEndpoint(endpoint?: string): string {
  const raw = endpoint?.trim().replace(/\/$/, "") ?? "";
  if (!raw) throw new Error("L’adresse API du moteur cloud n’est pas configurée.");
  const url = new URL(raw);
  if (!( ["https:", "http:"].includes(url.protocol))) throw new Error("L’adresse API doit utiliser HTTP ou HTTPS.");
  if (url.protocol === "http:" && !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("Une adresse cloud doit utiliser HTTPS.");
  }
  return url.toString().replace(/\/$/, "");
}

function safeUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (!( ["http:", "https:"].includes(url.protocol))) return undefined;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function systemPrompt(userName: string): string {
  return `Tu es Neptune, un assistant navigateur professionnel, direct et fiable. L’utilisateur s’appelle ${userName || "Utilisateur"}. Réponds en français. N’utilise son prénom que lors d’une validation importante, d’un blocage ou lorsque cela améliore réellement l’échange. Ne prétends jamais avoir exécuté une action qui n’a pas été confirmée par le navigateur. Signale clairement tes limites et refuse tout contournement de CAPTCHA, protection de plateforme ou restriction de compte.`;
}

function plannerPrompt(userName: string, trustLevel: TrustLevel): string {
  return `Tu planifies les actions navigateur de Neptune pour ${userName || "l’utilisateur"}. Niveau de confiance : ${trustLevel}.
Réponds uniquement par un objet JSON valide de cette forme :
{"text":"explication courte en français","actions":[{"type":"OPEN_URL|READ_PAGE|CLICK_ELEMENT|FILL_FIELD|SELECT_OPTION|PRESS_KEY|SCROLL_PAGE|WAIT_FOR_ELEMENT|NAVIGATE_BACK|SEND_MESSAGE|WAIT","label":"description","risk":"read_only|draft_write|external_write|sensitive","requiresApproval":false,"url":"https://...","target":{"role":"button","name":"...","text":"..."},"value":"...","delayMs":1000}]}
Règles impératives :
- au maximum ${MAX_ACTIONS} actions ;
- OPEN_URL et READ_PAGE sont read_only ;
- SEND_MESSAGE est toujours external_write et requiresApproval=true ;
- n’automatise jamais paiement, achat, suppression, mot de passe, signature, contrat, virement ou contournement de CAPTCHA ;
- préfère role/name/text aux sélecteurs CSS ;
- si la page doit être comprise avant de cliquer, termine le plan actuel par READ_PAGE ;
- ne fabrique pas une cible que tu ne peux pas déduire ;
- une URL doit être HTTPS complète lorsque le site est connu.`;
}

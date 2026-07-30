import type { BrowserAction } from "@neptune/protocol";
import type { AgentHistoryEntry, AgentObservation } from "./agent-core";
import {
  askIntelligence,
  extractJson,
  normalizePlan,
  type ProviderConfig,
  type TrustLevel
} from "./intelligence";

export type AgentDecision = {
  text: string;
  done: boolean;
  needsHuman: boolean;
  reason?: string;
  actions: BrowserAction[];
};

export type AgentStepContext = {
  goal: string;
  cycle: number;
  remainingActions: number;
  observation?: AgentObservation;
  history: AgentHistoryEntry[];
  lastError?: string;
};

export async function planAgentStep(
  provider: ProviderConfig,
  userName: string,
  trustLevel: TrustLevel,
  context: AgentStepContext,
  signal?: AbortSignal
): Promise<AgentDecision> {
  const prompt = buildAgentPrompt(userName, trustLevel, context);
  let raw: string;

  if (provider.id === "hermes") {
    try {
      raw = await askIntelligence({ id: "chrome-local" }, userName, [{ role: "user", content: prompt }], signal, {
        purpose: "browser-planning"
      });
    } catch (error) {
      throw new Error(`Hermes reste connecté pour la mémoire et les compétences, mais Neptune ne transmet pas le contenu de votre onglet aux outils Hermes. Le planificateur navigateur local doit être disponible : ${error instanceof Error ? error.message : "moteur local indisponible"}`);
    }
  } else {
    raw = await askIntelligence(provider, userName, [{ role: "user", content: prompt }], signal, {
      purpose: "browser-planning"
    });
  }

  const parsed = extractJson(raw);
  const normalized = normalizePlan(parsed, raw);
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const done = record.done === true;
  const needsHuman = record.needsHuman === true;
  const reason = typeof record.reason === "string" ? record.reason.slice(0, 800) : undefined;
  const actions = normalized.actions.slice(0, Math.min(5, Math.max(0, context.remainingActions)));

  if (done) return { text: normalized.text, done: true, needsHuman: false, actions: [] };
  if (needsHuman) return { text: normalized.text, done: false, needsHuman: true, ...(reason ? { reason } : {}), actions: [] };
  return {
    text: normalized.text,
    done: false,
    needsHuman: false,
    ...(reason ? { reason } : {}),
    actions
  };
}

export function buildAgentPrompt(
  userName: string,
  trustLevel: TrustLevel,
  context: AgentStepContext
): string {
  const observation = context.observation
    ? JSON.stringify(context.observation).slice(0, 18_000)
    : "Aucune page web n’est encore ouverte dans l’onglet de travail.";
  const history = context.history.slice(-12).map((entry) => (
    `[cycle ${entry.cycle}] ${entry.type}: ${entry.summary}`
  )).join("\n") || "Aucun historique.";
  const error = context.lastError ? `\nDernière erreur : ${context.lastError}` : "";

  return `Tu es le moteur de décision agentique de Neptune pour ${userName || "l’utilisateur"}.
Objectif global : ${context.goal}
Niveau de confiance : ${trustLevel}
Cycle : ${context.cycle + 1}
Budget d’actions restant : ${context.remainingActions}

État actuel de la page :
${observation}

Historique récent :
${history}${error}

Décide uniquement de la PROCHAINE petite étape. Observe, agis, puis laisse Neptune réévaluer la page.
Réponds uniquement avec un objet JSON valide :
{
  "text":"explication courte en français",
  "done":false,
  "needsHuman":false,
  "reason":"raison éventuelle",
  "actions":[
    {
      "type":"OPEN_URL|READ_PAGE|CLICK_ELEMENT|FILL_FIELD|SELECT_OPTION|PRESS_KEY|SCROLL_PAGE|WAIT_FOR_ELEMENT|NAVIGATE_BACK|SEND_MESSAGE|WAIT",
      "label":"description précise",
      "risk":"read_only|draft_write|external_write|sensitive",
      "requiresApproval":false,
      "url":"https://...",
      "target":{"role":"button","name":"...","text":"..."},
      "value":"...",
      "delayMs":1000
    }
  ]
}

Règles impératives :
- au maximum 5 actions dans ce cycle ;
- si l’objectif est atteint, done=true et actions=[] ;
- si une intervention humaine est indispensable, needsHuman=true et actions=[] ;
- ne devine jamais un bouton ou un champ absent de l’observation ;
- si la page doit être comprise ou a changé, utilise READ_PAGE et arrête le cycle ;
- après une navigation, un clic important ou un envoi, termine généralement le cycle pour permettre une nouvelle observation ;
- SEND_MESSAGE est toujours external_write et requiresApproval=true ;
- n’automatise jamais paiement, achat, suppression, mot de passe, signature, contrat, virement, CAPTCHA ou contournement de protection ;
- préfère role, name et text aux sélecteurs CSS ;
- utilise WAIT_FOR_ELEMENT pour un contenu chargé dynamiquement ;
- utilise SCROLL_PAGE seulement si l’élément utile n’est pas visible ;
- en cas d’erreur de cible, réobserve et choisis une autre stratégie au lieu de répéter la même action.`;
}

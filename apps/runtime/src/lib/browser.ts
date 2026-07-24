import { invoke } from "@tauri-apps/api/core";
import type {
  BrowserAction,
  BrowserResponse,
  IntelligenceProvider,
  NativeBridgeStatus,
  RuntimeReply,
  TrustLevel
} from "../types";

export type BrowserMission = {
  id: string;
  goal: string;
  actions: BrowserAction[];
  currentIndex: number;
  approved: boolean;
  results: Array<{ actionId: string; result: unknown }>;
};

export async function getNativeBridgeStatus(): Promise<NativeBridgeStatus> {
  try {
    return await invoke<NativeBridgeStatus>("native_bridge_status");
  } catch {
    return { connected: false, hostRegistered: false, extensionId: "" };
  }
}

export async function registerBrowserExtensionHost(): Promise<string> {
  return invoke<string>("register_browser_extension_host");
}

export async function sendBrowserRequest(payload: Record<string, unknown>): Promise<BrowserResponse> {
  return invoke<BrowserResponse>("browser_request", { payload });
}

export async function planBrowserTask(
  provider: IntelligenceProvider,
  model: string,
  goal: string,
  userName: string,
  trustLevel: TrustLevel
): Promise<RuntimeReply> {
  return invoke<RuntimeReply>("plan_browser_task", {
    providerId: provider.id,
    endpoint: provider.endpoint ?? null,
    model,
    goal,
    userName,
    trustLevel
  });
}

export function isLikelyBrowserTask(text: string): boolean {
  const normalized = text.toLocaleLowerCase("fr-FR");
  const signals = [
    "ouvre ",
    "va sur ",
    "navigue",
    "cherche sur",
    "lis la page",
    "clique",
    "remplis",
    "envoie un message",
    "instagram",
    "linkedin",
    "leboncoin",
    "le bon coin",
    "site web",
    "navigateur"
  ];
  return signals.some((signal) => normalized.includes(signal));
}

export function actionNeedsApproval(action: BrowserAction, trustLevel: TrustLevel): boolean {
  if (action.requiresApproval || action.risk === "sensitive" || action.risk === "external_write") return true;
  if (trustLevel === "prudent") return action.risk !== "read_only";
  return false;
}

export function describeBrowserError(error: BrowserResponse["error"], userName: string): string {
  if (!error) return `${userName}, la mission s’est interrompue sans détail exploitable.`;
  if (typeof error === "string") return `${userName}, ${error}`;
  switch (error.code) {
    case "HUMAN_VERIFICATION":
      return `${userName}, le site demande une vérification humaine. Effectuez-la dans l’onglet Neptune, puis cliquez sur « Continuer ».`;
    case "AUTHENTICATION_REQUIRED":
      return `${userName}, le compte nécessaire n’est pas connecté. Connectez-vous dans l’onglet Neptune, puis relancez l’étape.`;
    case "PAGE_PERMISSION":
      return `${userName}, Chrome a refusé l’accès à cette page. Rechargez l’extension Neptune puis réessayez.`;
    case "TARGET_NOT_FOUND":
      return `${userName}, l’élément attendu n’est plus visible. La page a peut-être changé ; je peux analyser à nouveau la page.`;
    default:
      return `${userName}, j’ai rencontré un blocage : ${error.message}`;
  }
}

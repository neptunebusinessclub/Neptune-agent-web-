export type OrbState =
  | "idle"
  | "listening"
  | "thinking"
  | "executing"
  | "speaking"
  | "blocked"
  | "permission"
  | "error";

export type TrustLevel = "prudent" | "assisted" | "controlled";
export type ProviderKind = "local" | "cloud";
export type ProviderStatus = "unknown" | "available" | "connected" | "unavailable";

export type VoiceOption = {
  id: string;
  name: string;
  description: string;
  locale: string;
  engine: "system" | "kokoro" | "piper";
};

export type IntelligenceProvider = {
  id: string;
  name: string;
  kind: ProviderKind;
  description: string;
  endpoint?: string;
  status: ProviderStatus;
  models: string[];
  selectedModel?: string;
  requiresKey: boolean;
  recommended?: boolean;
};

export type UserPreferences = {
  preferredName: string;
  voiceId: string;
  trustLevel: TrustLevel;
  providerId: string;
  modelId: string;
  wakeWordEnabled: boolean;
  wakeWord: "Neptune" | "OK Neptune";
  onboardingComplete: boolean;
};

export type ConversationMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  tone?: "normal" | "warning" | "permission";
};

export type BrowserTarget = {
  selector?: string;
  role?: string;
  name?: string;
  text?: string;
};

export type BrowserAction = {
  id: string;
  type: "OPEN_URL" | "READ_PAGE" | "CLICK_ELEMENT" | "FILL_FIELD" | "SEND_MESSAGE" | "WAIT";
  label: string;
  risk: "read_only" | "draft_write" | "external_write" | "sensitive";
  requiresApproval: boolean;
  target?: BrowserTarget;
  value?: string;
  url?: string;
  delayMs?: number;
  status: "pending" | "running" | "completed" | "failed" | "blocked";
};

export type RuntimeReply = {
  text: string;
  requiresPermission?: boolean;
  blockedReason?: string;
  actions?: BrowserAction[];
};

export type NativeBridgeStatus = {
  connected: boolean;
  hostRegistered: boolean;
  extensionId: string;
};

export type BrowserError = {
  code: string;
  message: string;
  requiresHuman: boolean;
  retryable: boolean;
};

export type BrowserResponse = {
  requestId?: string;
  ok: boolean;
  result?: unknown;
  error?: BrowserError | string;
};

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

export type RuntimeReply = {
  text: string;
  requiresPermission?: boolean;
  blockedReason?: string;
};

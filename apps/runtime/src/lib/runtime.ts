import { invoke } from "@tauri-apps/api/core";
import type { ConversationMessage, IntelligenceProvider, RuntimeReply } from "../types";

const DEFAULT_PROVIDERS: IntelligenceProvider[] = [
  {
    id: "lm-studio",
    name: "LM Studio",
    kind: "local",
    description: "Modèles locaux, privés et utilisables hors connexion.",
    endpoint: "http://127.0.0.1:1234",
    status: "unknown",
    models: [],
    requiresKey: false,
    recommended: true
  },
  {
    id: "ollama",
    name: "Ollama",
    kind: "local",
    description: "Installation locale légère avec téléchargement de modèles.",
    endpoint: "http://127.0.0.1:11434",
    status: "unknown",
    models: [],
    requiresKey: false
  },
  {
    id: "mammouth",
    name: "Mammouth AI",
    kind: "cloud",
    description: "Accès unifié à plusieurs modèles cloud.",
    status: "unknown",
    models: [],
    requiresKey: true,
    recommended: true
  },
  {
    id: "openai-compatible",
    name: "Fournisseur compatible OpenAI",
    kind: "cloud",
    description: "OpenAI, Mistral, Groq, OpenRouter ou endpoint compatible.",
    status: "unknown",
    models: [],
    requiresKey: true
  }
];

export function createProviders(): IntelligenceProvider[] {
  return DEFAULT_PROVIDERS.map((provider) => ({ ...provider, models: [...provider.models] }));
}

export async function probeProvider(provider: IntelligenceProvider): Promise<IntelligenceProvider> {
  try {
    const result = await invoke<{ available: boolean; models: string[] }>("probe_provider", {
      providerId: provider.id,
      endpoint: provider.endpoint ?? null
    });
    return {
      ...provider,
      status: result.available ? "available" : "unavailable",
      models: result.models
    };
  } catch {
    return probeProviderInPreview(provider);
  }
}

async function probeProviderInPreview(provider: IntelligenceProvider): Promise<IntelligenceProvider> {
  try {
    if (provider.id === "lm-studio") {
      const response = await fetch(`${provider.endpoint}/v1/models`);
      if (!response.ok) throw new Error("LM Studio indisponible");
      const payload = await response.json() as { data?: Array<{ id?: string }> };
      const models = (payload.data ?? []).map((item) => item.id).filter((id): id is string => Boolean(id));
      return { ...provider, status: "available", models };
    }
    if (provider.id === "ollama") {
      const response = await fetch(`${provider.endpoint}/api/tags`);
      if (!response.ok) throw new Error("Ollama indisponible");
      const payload = await response.json() as { models?: Array<{ name?: string }> };
      const models = (payload.models ?? []).map((item) => item.name).filter((id): id is string => Boolean(id));
      return { ...provider, status: "available", models };
    }
  } catch {
    return { ...provider, status: "unavailable", models: [] };
  }
  return provider;
}

export async function saveProviderSecret(providerId: string, secret: string): Promise<void> {
  if (!secret.trim()) throw new Error("La clé est vide.");
  await invoke("save_provider_secret", { providerId, secret });
}

export async function askIntelligence(
  provider: IntelligenceProvider,
  model: string,
  messages: ConversationMessage[],
  userName: string
): Promise<RuntimeReply> {
  const payload = messages
    .filter((message) => message.role !== "system")
    .slice(-12)
    .map((message) => ({ role: message.role, content: message.text }));

  try {
    return await invoke<RuntimeReply>("chat", {
      providerId: provider.id,
      endpoint: provider.endpoint ?? null,
      model,
      messages: payload,
      userName
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      text: `${userName ? `${userName}, ` : ""}je ne peux pas encore joindre le moteur ${provider.name}. Ouvre Intelligence et vérifie qu’il est connecté.`,
      blockedReason: reason
    };
  }
}

export function speakWithSystemVoice(text: string, voiceName?: string): void {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "fr-FR";
  const matching = window.speechSynthesis.getVoices().find((voice) => voice.name === voiceName);
  if (matching) utterance.voice = matching;
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  window.speechSynthesis?.cancel();
}

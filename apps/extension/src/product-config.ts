export const PRODUCT_VERSION = 20;
export const BALANCED_LOCAL_MODEL_ID = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";
export const LOCAL_VOICE_PREFIX = "neptune-piper:";

export type VoiceGender = "female" | "male";
export type WorkspaceMode = "current-tab" | "new-tab" | "new-window";

export const PRODUCT_VOICES = {
  female: {
    gender: "female" as const,
    id: "fr_FR-siwis-medium",
    uri: `${LOCAL_VOICE_PREFIX}fr_FR-siwis-medium`,
    label: "Voix féminine",
    description: "Claire, naturelle et chaleureuse"
  },
  male: {
    gender: "male" as const,
    id: "fr_FR-upmc-medium",
    uri: `${LOCAL_VOICE_PREFIX}fr_FR-upmc-medium`,
    label: "Voix masculine",
    description: "Grave, fluide et professionnelle"
  }
} as const;

export function voiceForGender(gender: VoiceGender) {
  return PRODUCT_VOICES[gender];
}

export function inferWorkspaceMode(goal: string, activeUrl?: string): {
  recommended: WorkspaceMode;
  explicit: boolean;
  reason: string;
} {
  const clean = goal.toLocaleLowerCase("fr-FR");
  if (/\b(nouvelle?|ouvre|ouvrir).{0,12}fen[eê]tre\b|\bdans une fen[eê]tre\b/.test(clean)) {
    return { recommended: "new-window", explicit: true, reason: "La demande mentionne une nouvelle fenêtre." };
  }
  if (/\b(nouvel?|ouvre|ouvrir).{0,12}onglet\b|\bdans un onglet\b/.test(clean)) {
    return { recommended: "new-tab", explicit: true, reason: "La demande mentionne un nouvel onglet." };
  }
  if (activeUrl && /^https?:\/\//i.test(activeUrl) && /\b(cette page|ce site|ici|cet onglet|page actuelle|onglet actuel|prends le relais|continue ici|sur cette page)\b/.test(clean)) {
    return { recommended: "current-tab", explicit: false, reason: "La demande semble concerner la page déjà ouverte." };
  }
  return { recommended: "new-tab", explicit: false, reason: "Un onglet séparé protège le travail déjà ouvert." };
}

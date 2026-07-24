import type { BrowserAction, CreateMissionInput } from "@neptune/protocol";

function action(input: Omit<BrowserAction, "id" | "status">): BrowserAction {
  return {
    ...input,
    id: crypto.randomUUID(),
    status: "pending"
  };
}

function extractFirstUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s]+/i);
  if (!match) return undefined;

  try {
    return new URL(match[0]).toString();
  } catch {
    return undefined;
  }
}

function inferKnownDestination(goal: string): string | undefined {
  const normalized = goal.toLocaleLowerCase("fr-FR");
  if (normalized.includes("le bon coin") || normalized.includes("leboncoin")) {
    return "https://www.leboncoin.fr/";
  }
  if (normalized.includes("instagram")) {
    return "https://www.instagram.com/";
  }
  if (normalized.includes("linkedin")) {
    return "https://www.linkedin.com/";
  }
  return undefined;
}

/**
 * Planner MVP volontairement fermé : il produit uniquement des actions connues.
 * Le futur LLM devra retourner ce même schéma et sera rejeté si la validation échoue.
 */
export function buildMissionPlan(input: CreateMissionInput): BrowserAction[] {
  const goal = input.goal.trim();
  const normalized = goal.toLocaleLowerCase("fr-FR");
  const requestedUrl = extractFirstUrl(goal) ?? inferKnownDestination(goal);
  const actions: BrowserAction[] = [];

  if (requestedUrl) {
    actions.push(action({
      type: "OPEN_URL",
      label: `Ouvrir ${new URL(requestedUrl).hostname}`,
      risk: "read_only",
      requiresApproval: false,
      url: requestedUrl
    }));
  }

  actions.push(action({
    type: "READ_PAGE",
    label: "Lire la page active et relever les éléments utiles",
    risk: "read_only",
    requiresApproval: false
  }));

  const isOutreachMission = [
    "message",
    "inviter",
    "invitation",
    "prospect",
    "followers",
    "abonnés",
    "abonnes"
  ].some((keyword) => normalized.includes(keyword));

  if (isOutreachMission) {
    actions.push(action({
      type: "ASK_APPROVAL",
      label: "Présenter la cible et le message avant toute communication externe",
      risk: "draft_write",
      requiresApproval: true,
      value: "Le texte final et la liste de destinataires doivent être validés avant l'envoi."
    }));
  }

  return actions;
}

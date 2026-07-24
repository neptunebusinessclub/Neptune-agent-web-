import type { BrowserAction } from "@neptune/protocol";

declare global {
  interface Window {
    __NEPTUNE_AGENT_CONTENT_SCRIPT__?: boolean;
  }
}

if (!window.__NEPTUNE_AGENT_CONTENT_SCRIPT__) {
  window.__NEPTUNE_AGENT_CONTENT_SCRIPT__ = true;
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.source !== "NEPTUNE_AGENT") return false;
    if (request.type === "PING") {
      sendResponse({ ok: true });
      return false;
    }
    if (request.type === "EXECUTE_CONTENT_ACTION") {
      void execute(request.action as BrowserAction)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error: unknown) => sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Erreur de page inconnue"
        }));
      return true;
    }
    return false;
  });
}

async function execute(action: BrowserAction): Promise<unknown> {
  detectPlatformGuard();
  switch (action.type) {
    case "READ_PAGE":
      return readPage();
    case "CLICK_ELEMENT": {
      const element = requireElement(action);
      assertInteractive(element);
      assertSafeControl(element);
      element.scrollIntoView({ behavior: "smooth", block: "center" });
      await sleep(250);
      (element as HTMLElement).click();
      await sleep(350);
      return { clicked: describeElement(element), page: compactPageState() };
    }
    case "FILL_FIELD": {
      const element = requireElement(action);
      assertSafeField(element);
      setElementValue(element, action.value ?? "");
      return { filled: describeElement(element), length: action.value?.length ?? 0 };
    }
    case "SEND_MESSAGE": {
      const composer = requireElement(action);
      assertSafeField(composer);
      setElementValue(composer, action.value ?? "");
      const submit = findSubmitControl(composer);
      if (!submit) throw new Error("Message préparé, mais aucun bouton d’envoi non ambigu n’a été trouvé");
      assertInteractive(submit);
      assertSafeControl(submit);
      submit.scrollIntoView({ behavior: "smooth", block: "center" });
      await sleep(300);
      (submit as HTMLElement).click();
      return { sent: true, composer: describeElement(composer), submit: describeElement(submit) };
    }
    default:
      throw new Error(`Action de page non prise en charge : ${action.type}`);
  }
}

function readPage(): Record<string, unknown> {
  const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 10_000);
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
    .filter(isVisible)
    .slice(0, 70)
    .map((link) => ({
      text: accessibleName(link).slice(0, 180),
      href: safePublicUrl(link.href)
    }))
    .filter((link) => Boolean(link.href));
  const controls = Array.from(document.querySelectorAll<HTMLElement>(
    "button, input, textarea, select, [role='button'], [role='textbox'], [contenteditable='true']"
  ))
    .filter(isVisible)
    .slice(0, 90)
    .map((element) => ({
      tag: element.tagName.toLocaleLowerCase("fr-FR"),
      role: element.getAttribute("role") ?? implicitRole(element),
      name: accessibleName(element).slice(0, 180),
      type: element instanceof HTMLInputElement ? element.type : null,
      disabled: isDisabled(element)
    }))
    .filter((control) => Boolean(control.name));

  return {
    title: document.title,
    url: location.href,
    language: document.documentElement.lang || null,
    text,
    links,
    controls,
    guardDetected: false
  };
}

function compactPageState(): Record<string, unknown> {
  return {
    title: document.title,
    url: location.href,
    text: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 1_500)
  };
}

function requireElement(action: BrowserAction): Element {
  if (!action.target) throw new Error(`${action.type} nécessite une cible`);
  const element = findElement(action.target);
  if (!element) throw new Error(`Target not found for ${action.label}`);
  if (!isVisible(element)) throw new Error("La cible existe mais n’est pas visible");
  return element;
}

function findElement(target: NonNullable<BrowserAction["target"]>): Element | null {
  if (target.selector) {
    try {
      const element = document.querySelector(target.selector);
      if (element) return element;
    } catch {
      throw new Error("Le sélecteur fourni par le plan est invalide");
    }
  }

  const candidates = Array.from(document.querySelectorAll<HTMLElement>(
    "button, a, input, textarea, select, [role], [contenteditable='true'], [tabindex]"
  )).filter(isVisible);
  const normalizedName = normalize(target.name);
  const normalizedText = normalize(target.text);
  const requestedRole = normalize(target.role);

  const ranked = candidates.map((element) => {
    const role = normalize(element.getAttribute("role") ?? implicitRole(element));
    const name = normalize(accessibleName(element));
    const text = normalize(element.textContent ?? "");
    let score = 0;
    if (requestedRole) {
      if (role !== requestedRole) return { element, score: -1 };
      score += 4;
    }
    if (normalizedName) {
      if (name === normalizedName) score += 8;
      else if (name.includes(normalizedName)) score += 5;
      else return { element, score: -1 };
    }
    if (normalizedText) {
      if (text === normalizedText) score += 7;
      else if (text.includes(normalizedText)) score += 4;
      else return { element, score: -1 };
    }
    return { element, score };
  }).filter((item) => item.score >= 0).sort((a, b) => b.score - a.score);

  if (ranked.length === 0) return null;
  if (ranked.length > 1 && ranked[0]!.score === ranked[1]!.score && ranked[0]!.score < 8) {
    throw new Error("Plusieurs cibles correspondent : une validation ou une description plus précise est nécessaire");
  }
  return ranked[0]!.element;
}

function setElementValue(element: Element, value: string): void {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.focus();
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    element.focus();
    element.textContent = value;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    return;
  }
  throw new Error("La cible n’est pas un champ modifiable");
}

function findSubmitControl(composer: Element): Element | null {
  const form = composer.closest("form");
  const scoped = form ? Array.from(form.querySelectorAll<HTMLElement>("button, [role='button'], input[type='submit']")) : [];
  const candidates = (scoped.length > 0 ? scoped : Array.from(document.querySelectorAll<HTMLElement>("button, [role='button']"))).filter(isVisible);
  const labels = ["envoyer", "send", "publier", "répondre", "repondre"];
  const matches = candidates.filter((candidate) => {
    const text = normalize(accessibleName(candidate));
    return labels.some((label) => text === label || text.includes(label));
  });
  return matches.length === 1 ? matches[0]! : null;
}

function detectPlatformGuard(): void {
  const text = normalize(document.body?.innerText ?? "");
  const warningSignals = [
    "captcha",
    "activité inhabituelle",
    "activite inhabituelle",
    "temporarily blocked",
    "action blocked",
    "nous limitons la fréquence",
    "suspicious activity",
    "confirmez que vous êtes humain",
    "confirm you are human"
  ];
  if (warningSignals.some((signal) => text.includes(signal))) {
    throw new Error("PLATFORM_GUARD_DETECTED: vérification humaine requise");
  }
}

function assertInteractive(element: Element): void {
  if (isDisabled(element)) throw new Error("La cible est désactivée");
}

function assertSafeField(element: Element): void {
  const name = normalize(accessibleName(element));
  const type = element instanceof HTMLInputElement ? element.type.toLocaleLowerCase("fr-FR") : "";
  const blocked = ["password", "mot de passe", "carte bancaire", "credit card", "cvv", "iban", "signature", "code secret"];
  if (type === "password" || blocked.some((signal) => name.includes(signal))) {
    throw new Error("Neptune refuse de remplir un champ sensible");
  }
}

function assertSafeControl(element: Element): void {
  const name = normalize(accessibleName(element));
  const blocked = ["payer", "acheter", "commander", "confirmer le paiement", "supprimer le compte", "signer", "valider le virement"];
  if (blocked.some((signal) => name.includes(signal))) {
    throw new Error("Neptune refuse d’activer un contrôle sensible");
  }
}

function isDisabled(element: Element): boolean {
  return (element instanceof HTMLButtonElement && element.disabled)
    || (element instanceof HTMLInputElement && element.disabled)
    || element.getAttribute("aria-disabled") === "true";
}

function isVisible(element: Element): boolean {
  const htmlElement = element as HTMLElement;
  const style = getComputedStyle(htmlElement);
  const rect = htmlElement.getBoundingClientRect();
  return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || "1") > 0 && rect.width > 0 && rect.height > 0;
}

function implicitRole(element: HTMLElement): string | null {
  if (element instanceof HTMLButtonElement) return "button";
  if (element instanceof HTMLAnchorElement) return "link";
  if (element instanceof HTMLTextAreaElement) return "textbox";
  if (element instanceof HTMLSelectElement) return "combobox";
  if (element instanceof HTMLInputElement) return ["button", "submit", "reset"].includes(element.type) ? "button" : "textbox";
  if (element.isContentEditable) return "textbox";
  return null;
}

function accessibleName(element: Element): string {
  const html = element as HTMLElement;
  const labelledBy = element.getAttribute("aria-labelledby");
  const labelledText = labelledBy
    ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ")
    : "";
  return [
    element.getAttribute("aria-label"),
    labelledText,
    element.getAttribute("placeholder"),
    element.getAttribute("title"),
    html.innerText,
    element instanceof HTMLInputElement ? element.value : null
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function describeElement(element: Element): Record<string, string | null> {
  return {
    tag: element.tagName.toLocaleLowerCase("fr-FR"),
    role: element.getAttribute("role") ?? implicitRole(element as HTMLElement),
    label: accessibleName(element).slice(0, 180) || null
  };
}

function safePublicUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (!(["http:", "https:"].includes(url.protocol))) return null;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return null;
  }
}

function normalize(value?: string | null): string {
  return (value ?? "").toLocaleLowerCase("fr-FR").replace(/\s+/g, " ").trim();
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

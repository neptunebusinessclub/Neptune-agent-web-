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
          error: error instanceof Error ? error.message : "Unknown page error"
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
      element.scrollIntoView({ behavior: "smooth", block: "center" });
      await sleep(250);
      (element as HTMLElement).click();
      return { clicked: describeElement(element) };
    }
    case "FILL_FIELD": {
      const element = requireElement(action);
      setElementValue(element, action.value ?? "");
      return { filled: describeElement(element), length: action.value?.length ?? 0 };
    }
    case "SEND_MESSAGE": {
      const composer = requireElement(action);
      setElementValue(composer, action.value ?? "");
      const submit = findSubmitControl(composer);
      if (!submit) {
        throw new Error("Message prepared, but no unambiguous send control was found");
      }
      assertInteractive(submit);
      submit.scrollIntoView({ behavior: "smooth", block: "center" });
      await sleep(300);
      (submit as HTMLElement).click();
      return { sent: true, composer: describeElement(composer), submit: describeElement(submit) };
    }
    default:
      throw new Error(`Unsupported content action: ${action.type}`);
  }
}

function readPage(): Record<string, unknown> {
  const selection = document.body?.innerText ?? "";
  const normalized = selection.replace(/\s+/g, " ").trim().slice(0, 8_000);
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
    .filter(isVisible)
    .slice(0, 80)
    .map((link) => ({
      text: (link.innerText || link.getAttribute("aria-label") || "").trim().slice(0, 200),
      href: safePublicUrl(link.href)
    }))
    .filter((link) => Boolean(link.href));

  return {
    title: document.title,
    url: location.href,
    language: document.documentElement.lang || null,
    text: normalized,
    links
  };
}

function requireElement(action: BrowserAction): Element {
  if (!action.target) throw new Error(`${action.type} requires a target`);
  const element = findElement(action.target);
  if (!element) throw new Error(`Target not found for ${action.label}`);
  if (!isVisible(element)) throw new Error("Target exists but is not visible");
  return element;
}

function findElement(target: NonNullable<BrowserAction["target"]>): Element | null {
  if (target.selector) {
    try {
      const element = document.querySelector(target.selector);
      if (element) return element;
    } catch {
      throw new Error("Invalid selector supplied by the action plan");
    }
  }

  const candidates = Array.from(document.querySelectorAll<HTMLElement>(
    "button, a, input, textarea, select, [role], [contenteditable='true'], [tabindex]"
  )).filter(isVisible);

  const normalizedName = target.name?.toLocaleLowerCase("fr-FR").trim();
  const normalizedText = target.text?.toLocaleLowerCase("fr-FR").trim();

  return candidates.find((element) => {
    const role = element.getAttribute("role") ?? implicitRole(element);
    if (target.role && role !== target.role) return false;

    const accessibleName = [
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
      element.getAttribute("title"),
      element.innerText,
      element instanceof HTMLInputElement ? element.value : null
    ].filter(Boolean).join(" ").toLocaleLowerCase("fr-FR");

    if (normalizedName && !accessibleName.includes(normalizedName)) return false;
    if (normalizedText && !(element.textContent ?? "").toLocaleLowerCase("fr-FR").includes(normalizedText)) return false;
    return true;
  }) ?? null;
}

function setElementValue(element: Element, value: string): void {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
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

  throw new Error("Target is not an editable field");
}

function findSubmitControl(composer: Element): Element | null {
  const form = composer.closest("form");
  const scoped = form ? Array.from(form.querySelectorAll<HTMLElement>("button, [role='button'], input[type='submit']")) : [];
  const candidates = scoped.length > 0
    ? scoped
    : Array.from(document.querySelectorAll<HTMLElement>("button, [role='button']")).filter(isVisible);

  const labels = ["envoyer", "send"];
  return candidates.find((candidate) => {
    const text = [
      candidate.innerText,
      candidate.getAttribute("aria-label"),
      candidate.getAttribute("title")
    ].filter(Boolean).join(" ").toLocaleLowerCase("fr-FR");
    return labels.some((label) => text === label || text.includes(label));
  }) ?? null;
}

function detectPlatformGuard(): void {
  const text = (document.body?.innerText ?? "").toLocaleLowerCase("fr-FR");
  const warningSignals = [
    "captcha",
    "activité inhabituelle",
    "activite inhabituelle",
    "temporarily blocked",
    "action blocked",
    "nous limitons la fréquence",
    "suspicious activity"
  ];
  if (warningSignals.some((signal) => text.includes(signal))) {
    throw new Error("PLATFORM_GUARD_DETECTED: mission paused for human review");
  }
}

function assertInteractive(element: Element): void {
  if (element instanceof HTMLButtonElement && element.disabled) throw new Error("Target button is disabled");
  if (element.getAttribute("aria-disabled") === "true") throw new Error("Target is aria-disabled");
}

function isVisible(element: Element): boolean {
  const htmlElement = element as HTMLElement;
  const style = getComputedStyle(htmlElement);
  const rect = htmlElement.getBoundingClientRect();
  return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
}

function implicitRole(element: HTMLElement): string | null {
  if (element instanceof HTMLButtonElement) return "button";
  if (element instanceof HTMLAnchorElement) return "link";
  if (element instanceof HTMLTextAreaElement) return "textbox";
  if (element instanceof HTMLInputElement) {
    return ["button", "submit", "reset"].includes(element.type) ? "button" : "textbox";
  }
  return null;
}

function describeElement(element: Element): Record<string, string | null> {
  return {
    tag: element.tagName.toLocaleLowerCase("fr-FR"),
    role: element.getAttribute("role") ?? implicitRole(element as HTMLElement),
    label: element.getAttribute("aria-label") ?? element.getAttribute("title") ?? null
  };
}

function safePublicUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return null;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

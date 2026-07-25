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
      await waitForDomStability(450, 2_500);
      return readPage();
    case "CLICK_ELEMENT": {
      const element = requireElement(action);
      assertInteractive(element);
      assertSafeControl(element);
      element.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      await sleep(220);
      (element as HTMLElement).focus?.();
      (element as HTMLElement).click();
      await waitForDomStability(500, 4_000);
      return { clicked: describeElement(element), page: compactPageState() };
    }
    case "FILL_FIELD": {
      const element = requireElement(action);
      assertSafeField(element);
      setElementValue(element, action.value ?? "");
      await waitForDomStability(250, 1_500);
      return { filled: describeElement(element), length: action.value?.length ?? 0 };
    }
    case "SELECT_OPTION": {
      const element = requireElement(action);
      assertSafeField(element);
      selectOption(element, action.value ?? "");
      await waitForDomStability(250, 1_500);
      return { selected: describeElement(element), value: action.value ?? "" };
    }
    case "PRESS_KEY": {
      const target = action.target ? requireElement(action) : document.activeElement;
      if (!(target instanceof Element)) throw new Error("Aucun élément actif pour la touche demandée");
      assertSafeField(target);
      pressKey(target, action.value ?? "Enter");
      await waitForDomStability(300, 2_000);
      return { key: action.value ?? "Enter", target: describeElement(target), page: compactPageState() };
    }
    case "SCROLL_PAGE": {
      const result = scrollPage(action.value ?? "down");
      await waitForDomStability(350, 2_000);
      return { ...result, page: compactPageState() };
    }
    case "WAIT_FOR_ELEMENT": {
      const element = await waitForElement(action, action.delayMs ?? 10_000);
      return { found: describeElement(element), page: compactPageState() };
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
      await sleep(250);
      (submit as HTMLElement).click();
      await waitForDomStability(450, 3_500);
      return { sent: true, composer: describeElement(composer), submit: describeElement(submit), page: compactPageState() };
    }
    default:
      throw new Error(`Action de page non prise en charge : ${action.type}`);
  }
}

function readPage(): Record<string, unknown> {
  const documents = collectDocuments();
  const allElements = documents.flatMap((doc) => collectElements(doc));
  const text = documents.map((doc) => doc.body?.innerText ?? "").join(" ").replace(/\s+/g, " ").trim().slice(0, 16_000);
  const links = uniqueBy(
    allElements.filter((element): element is HTMLAnchorElement => element instanceof HTMLAnchorElement && Boolean(element.href))
      .filter(isVisible)
      .slice(0, 100)
      .map((link) => ({ text: accessibleName(link).slice(0, 180), href: safePublicUrl(link.href) }))
      .filter((link) => Boolean(link.href)),
    (link) => `${link.text}|${link.href}`
  );
  const controls = allElements
    .filter(isPotentialControl)
    .filter(isVisible)
    .slice(0, 140)
    .map((element) => ({
      tag: element.tagName.toLocaleLowerCase("fr-FR"),
      role: element.getAttribute("role") ?? implicitRole(element),
      name: accessibleName(element).slice(0, 180),
      type: element instanceof HTMLInputElement ? element.type : null,
      disabled: isDisabled(element),
      value: publicControlValue(element),
      frame: frameLabel(element.ownerDocument)
    }))
    .filter((control) => Boolean(control.name));
  const headings = allElements
    .filter((element) => /^H[1-6]$/.test(element.tagName) || /^heading$/i.test(element.getAttribute("role") ?? ""))
    .filter(isVisible)
    .slice(0, 60)
    .map((element) => ({ level: headingLevel(element), text: accessibleName(element).slice(0, 240) }))
    .filter((heading) => Boolean(heading.text));
  const forms = documents.flatMap((doc) => Array.from(doc.forms)).slice(0, 30).map((form) => ({
    name: accessibleName(form).slice(0, 180),
    action: safePublicUrl(form.action),
    fields: collectElements(form).filter(isPotentialField).filter(isVisible).slice(0, 30).map((field) => ({
      role: field.getAttribute("role") ?? implicitRole(field),
      name: accessibleName(field).slice(0, 160),
      type: field instanceof HTMLInputElement ? field.type : null
    }))
  }));

  return {
    title: document.title,
    url: location.href,
    language: document.documentElement.lang || null,
    text,
    links,
    controls,
    headings,
    forms,
    scroll: scrollState(),
    frameCount: documents.length,
    guardDetected: false
  };
}

function compactPageState(): Record<string, unknown> {
  return {
    title: document.title,
    url: location.href,
    text: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 2_500),
    scroll: scrollState()
  };
}

function requireElement(action: BrowserAction): Element {
  if (!action.target) throw new Error(`${action.type} nécessite une cible`);
  const element = findElement(action.target);
  if (!element) throw new Error(`Target not found for ${action.label}`);
  if (!isVisible(element)) throw new Error("La cible existe mais n’est pas visible");
  return element;
}

async function waitForElement(action: BrowserAction, timeoutMs: number): Promise<Element> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    detectPlatformGuard();
    if (action.target) {
      const element = findElement(action.target);
      if (element && isVisible(element)) return element;
    }
    await sleep(250);
  }
  throw new Error(`Target not found after ${timeoutMs} ms for ${action.label}`);
}

function findElement(target: NonNullable<BrowserAction["target"]>): Element | null {
  const roots = collectRoots();
  if (target.selector) {
    for (const root of roots) {
      try {
        const element = root.querySelector(target.selector);
        if (element) return element;
      } catch {
        throw new Error("Le sélecteur fourni par le plan est invalide");
      }
    }
  }

  const candidates = roots.flatMap((root) => Array.from(root.querySelectorAll<HTMLElement>(
    "button, a, input, textarea, select, option, [role], [contenteditable='true'], [tabindex], summary, label"
  ))).filter(isVisible);
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
      score += 5;
    }
    if (normalizedName) {
      if (name === normalizedName) score += 12;
      else if (name.startsWith(normalizedName) || normalizedName.startsWith(name)) score += 8;
      else if (name.includes(normalizedName)) score += 6;
      else return { element, score: -1 };
    }
    if (normalizedText) {
      if (text === normalizedText) score += 10;
      else if (text.includes(normalizedText)) score += 6;
      else return { element, score: -1 };
    }
    if (element === document.activeElement) score += 1;
    return { element, score };
  }).filter((item) => item.score >= 0).sort((a, b) => b.score - a.score);

  if (ranked.length === 0) return null;
  if (ranked.length > 1 && ranked[0]!.score === ranked[1]!.score && ranked[0]!.score < 12) {
    throw new Error("Plusieurs cibles correspondent : une description plus précise est nécessaire");
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

function selectOption(element: Element, value: string): void {
  if (!(element instanceof HTMLSelectElement)) throw new Error("La cible n’est pas une liste déroulante native");
  const normalizedValue = normalize(value);
  const option = Array.from(element.options).find((item) => normalize(item.value) === normalizedValue || normalize(item.textContent) === normalizedValue || normalize(item.textContent).includes(normalizedValue));
  if (!option) throw new Error(`Option introuvable : ${value}`);
  element.value = option.value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function pressKey(element: Element, value: string): void {
  const key = normalizeKey(value);
  (element as HTMLElement).focus?.();
  for (const type of ["keydown", "keypress", "keyup"] as const) {
    element.dispatchEvent(new KeyboardEvent(type, { key, code: key === " " ? "Space" : key, bubbles: true, cancelable: true }));
  }
}

function scrollPage(raw: string): Record<string, number | string> {
  const value = normalize(raw);
  const viewport = Math.max(320, window.innerHeight * .82);
  const amount = /^-?\d+$/.test(value) ? Number(value) : value.includes("up") || value.includes("haut") ? -viewport : value.includes("top") || value.includes("début") || value.includes("debut") ? -document.documentElement.scrollHeight : value.includes("bottom") || value.includes("fin") ? document.documentElement.scrollHeight : viewport;
  window.scrollBy({ top: amount, behavior: "smooth" });
  return { direction: raw, requestedPixels: Math.round(amount), position: Math.round(window.scrollY) };
}

function findSubmitControl(composer: Element): Element | null {
  const form = composer.closest("form");
  const scoped = form ? collectElements(form).filter((element) => element.matches("button, [role='button'], input[type='submit']")) : [];
  const candidates = (scoped.length > 0 ? scoped : collectElements(document).filter((element) => element.matches("button, [role='button'], input[type='submit']"))).filter(isVisible);
  const labels = ["envoyer", "send", "publier", "répondre", "repondre", "valider"];
  const matches = candidates.filter((candidate) => {
    const text = normalize(accessibleName(candidate));
    return labels.some((label) => text === label || text.includes(label));
  });
  return matches.length === 1 ? matches[0]! : null;
}

function collectDocuments(): Document[] {
  const result = [document];
  for (const frame of Array.from(document.querySelectorAll("iframe"))) {
    try {
      if (frame.contentDocument) result.push(frame.contentDocument);
    } catch {
      // Les iframes cross-origin restent volontairement inaccessibles.
    }
  }
  return result;
}

function collectRoots(): Array<Document | ShadowRoot | Element> {
  const roots: Array<Document | ShadowRoot | Element> = [];
  const visit = (root: Document | ShadowRoot | Element): void => {
    roots.push(root);
    for (const element of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      if (element.shadowRoot) visit(element.shadowRoot);
      if (element instanceof HTMLIFrameElement) {
        try { if (element.contentDocument) visit(element.contentDocument); } catch { /* cross-origin */ }
      }
    }
  };
  visit(document);
  return roots;
}

function collectElements(root: Document | ShadowRoot | Element): HTMLElement[] {
  const result: HTMLElement[] = [];
  const visit = (current: Document | ShadowRoot | Element): void => {
    for (const element of Array.from(current.querySelectorAll<HTMLElement>("*"))) {
      result.push(element);
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(root);
  return result;
}

function detectPlatformGuard(): void {
  const text = normalize(collectDocuments().map((doc) => doc.body?.innerText ?? "").join(" "));
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
  const blocked = ["password", "mot de passe", "carte bancaire", "credit card", "cvv", "iban", "signature", "code secret", "otp", "code de vérification"];
  if (type === "password" || blocked.some((signal) => name.includes(signal))) {
    throw new Error("Neptune refuse de remplir un champ sensible");
  }
}

function assertSafeControl(element: Element): void {
  const name = normalize(accessibleName(element));
  const blocked = ["payer", "acheter", "commander", "confirmer le paiement", "supprimer le compte", "signer", "valider le virement", "modifier le mot de passe"];
  if (blocked.some((signal) => name.includes(signal))) {
    throw new Error("Neptune refuse d’activer un contrôle sensible");
  }
}

function isPotentialControl(element: HTMLElement): boolean {
  return element.matches("button, input, textarea, select, [role='button'], [role='textbox'], [role='combobox'], [role='checkbox'], [role='radio'], [contenteditable='true'], summary");
}

function isPotentialField(element: HTMLElement): boolean {
  return element.matches("input, textarea, select, [role='textbox'], [role='combobox'], [contenteditable='true']");
}

function isDisabled(element: Element): boolean {
  return (element instanceof HTMLButtonElement && element.disabled)
    || (element instanceof HTMLInputElement && element.disabled)
    || (element instanceof HTMLSelectElement && element.disabled)
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
  if (element instanceof HTMLInputElement) {
    if (["button", "submit", "reset"].includes(element.type)) return "button";
    if (element.type === "checkbox") return "checkbox";
    if (element.type === "radio") return "radio";
    return "textbox";
  }
  if (element.isContentEditable) return "textbox";
  return null;
}

function accessibleName(element: Element): string {
  const html = element as HTMLElement;
  const labelledBy = element.getAttribute("aria-labelledby");
  const labelledText = labelledBy
    ? labelledBy.split(/\s+/).map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "").join(" ")
    : "";
  const explicitLabel = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
    ? element.labels ? Array.from(element.labels).map((label) => label.textContent ?? "").join(" ") : ""
    : "";
  return [
    element.getAttribute("aria-label"),
    labelledText,
    explicitLabel,
    element.getAttribute("alt"),
    element.getAttribute("placeholder"),
    element.getAttribute("title"),
    html.innerText,
    element instanceof HTMLInputElement && !["password", "hidden"].includes(element.type) ? element.value : null
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function describeElement(element: Element): Record<string, string | null> {
  return {
    tag: element.tagName.toLocaleLowerCase("fr-FR"),
    role: element.getAttribute("role") ?? implicitRole(element as HTMLElement),
    label: accessibleName(element).slice(0, 180) || null,
    frame: frameLabel(element.ownerDocument)
  };
}

function publicControlValue(element: HTMLElement): string | boolean | null {
  if (element instanceof HTMLInputElement) {
    if (["password", "hidden"].includes(element.type)) return null;
    if (["checkbox", "radio"].includes(element.type)) return element.checked;
    return element.value.slice(0, 180);
  }
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return element.value.slice(0, 180);
  return null;
}

function frameLabel(doc: Document): string {
  if (doc === document) return "top";
  return doc.title || doc.location?.pathname || "iframe";
}

function headingLevel(element: HTMLElement): number | null {
  const match = element.tagName.match(/^H([1-6])$/);
  if (match) return Number(match[1]);
  const ariaLevel = Number(element.getAttribute("aria-level"));
  return Number.isFinite(ariaLevel) && ariaLevel > 0 ? ariaLevel : null;
}

function scrollState(): Record<string, number | boolean> {
  const root = document.scrollingElement ?? document.documentElement;
  const max = Math.max(0, root.scrollHeight - window.innerHeight);
  return {
    y: Math.round(window.scrollY),
    maxY: Math.round(max),
    progress: max > 0 ? Math.round((window.scrollY / max) * 100) : 100,
    atTop: window.scrollY <= 4,
    atBottom: window.scrollY >= max - 4
  };
}

async function waitForDomStability(idleMs: number, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let idleTimer = window.setTimeout(finish, idleMs);
    const timeout = window.setTimeout(finish, timeoutMs);
    const observer = new MutationObserver(() => {
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(finish, idleMs);
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    function finish(): void {
      observer.disconnect();
      window.clearTimeout(idleTimer);
      window.clearTimeout(timeout);
      resolve();
    }
  });
}

function normalizeKey(value: string): string {
  const normalized = normalize(value);
  const keys: Record<string, string> = {
    enter: "Enter",
    entrée: "Enter",
    entree: "Enter",
    tab: "Tab",
    escape: "Escape",
    echap: "Escape",
    espace: " ",
    space: " ",
    arrowdown: "ArrowDown",
    bas: "ArrowDown",
    arrowup: "ArrowUp",
    haut: "ArrowUp"
  };
  return keys[normalized] ?? value.slice(0, 30);
}

function safePublicUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (!( ["http:", "https:"].includes(url.protocol))) return null;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return null;
  }
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = key(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function normalize(value?: string | null): string {
  return (value ?? "").toLocaleLowerCase("fr-FR").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

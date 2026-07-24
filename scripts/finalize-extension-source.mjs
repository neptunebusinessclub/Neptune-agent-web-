import { readFileSync, writeFileSync, rmSync } from "node:fs";

function replaceRequired(path, before, after) {
  const source = readFileSync(path, "utf8");
  if (!source.includes(before)) {
    throw new Error(`Motif absent dans ${path}: ${before.slice(0, 80)}`);
  }
  writeFileSync(path, source.replace(before, after));
}

replaceRequired(
  "apps/extension/src/intelligence.ts",
  "return chromeSession!.prompt(transcript, { signal });",
  "return chromeSession!.prompt(transcript, signal ? { signal } : undefined);"
);
replaceRequired(
  "apps/extension/src/intelligence.ts",
  "raw = await chromeSession!.prompt(prompt, { signal });",
  "raw = await chromeSession!.prompt(prompt, signal ? { signal } : undefined);"
);
replaceRequired(
  "apps/extension/src/service-worker.ts",
  `function publicTab(tab: chrome.tabs.Tab | null): { id?: number; url?: string; title?: string } | null {\n  return tab ? { id: tab.id, url: tab.url, title: tab.title } : null;\n}`,
  `function publicTab(tab: chrome.tabs.Tab | null): { id?: number; url?: string; title?: string } | null {\n  if (!tab) return null;\n  return {\n    ...(typeof tab.id === "number" ? { id: tab.id } : {}),\n    ...(typeof tab.url === "string" ? { url: tab.url } : {}),\n    ...(typeof tab.title === "string" ? { title: tab.title } : {})\n  };\n}`
);
replaceRequired(
  "apps/extension/src/sidepanel.ts",
  `      await downloadLocalAi();\n      if (chromeAiStatus !== "available") return;`,
  `      await downloadLocalAi();\n      chromeAiStatus = await getChromeAiAvailability();\n      if (chromeAiStatus !== "available") return;`
);
replaceRequired(
  "apps/extension/src/sidepanel.ts",
  `    if (!pendingApproval && !blockedMission && orbState !== "speaking") orbState = "idle";`,
  `    if (!pendingApproval && !blockedMission) orbState = "idle";`
);
replaceRequired(
  "apps/extension/src/sidepanel.ts",
  `  return [\n    ["prudent", "Prudent", "Je demande avant toute écriture, publication ou communication externe."],\n    ["assisted", "Collaborateur", "Une autorisation peut couvrir une mission clairement définie."],\n    ["controlled", "Autonome contrôlé", "J’agis dans les règles et quotas approuvés, sans toucher aux actions sensibles."]\n  ].map(([id, title, description]) => choiceButton("select-trust", id, title, description, preferences.trustLevel === id)).join("");`,
  `  return ([\n    ["prudent", "Prudent", "Je demande avant toute écriture, publication ou communication externe."],\n    ["assisted", "Collaborateur", "Une autorisation peut couvrir une mission clairement définie."],\n    ["controlled", "Autonome contrôlé", "J’agis dans les règles et quotas approuvés, sans toucher aux actions sensibles."]\n  ] as const).map(([id, title, description]) => choiceButton("select-trust", id, title, description, preferences.trustLevel === id)).join("");`
);

rmSync("scripts/finalize-extension-source.mjs");

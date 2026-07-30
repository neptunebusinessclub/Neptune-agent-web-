import { test, expect, chromium } from "playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const extensionPath = path.resolve("apps/extension/dist");

function extensionIdFromKey(key) {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  return [...digest].flatMap((byte) => [byte >> 4, byte & 15]).map((nibble) => String.fromCharCode(97 + nibble)).join("");
}

test("first-run onboarding is interactive and the embedded female voice starts without console errors", async () => {
  test.setTimeout(180_000);
  const manifest = JSON.parse(await readFile(path.join(extensionPath, "manifest.json"), "utf8"));
  const extensionId = extensionIdFromKey(manifest.key);
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "neptune-chromium-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--no-first-run"
    ]
  });

  try {
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await expect(page.getByRole("heading", { name: "Comment dois-je vous appeler ?" })).toBeVisible();

    const continueButton = page.locator("button[data-action='onboarding-next']");
    await expect(continueButton).toBeDisabled();
    await page.locator("#preferred-name").fill("Johan");
    await expect(continueButton).toBeEnabled();
    await continueButton.click();

    await expect(page.getByRole("heading", { name: "Préférez-vous une voix féminine ou masculine ?" })).toBeVisible();
    await page.locator("button[data-action='preview-gender'][data-value='female']").click();
    await expect(page.locator("button[data-action='onboarding-next']")).toBeEnabled({ timeout: 120_000 });
    await expect(page.locator("text=Uncaught ReferenceError")).toHaveCount(0);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors.filter((message) => /ReferenceError|chrome is not defined|Failed to construct 'Worker'/i.test(message))).toEqual([]);
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

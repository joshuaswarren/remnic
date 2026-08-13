import { readFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../admin-console/public/what-helps-me");
const assets = new Map<string, readonly [string, string]>([
  ["/remnic/ui/what-helps-me/", ["index.html", "text/html; charset=utf-8"]],
  ["/remnic/ui/what-helps-me/what-helps-me.css", ["what-helps-me.css", "text/css; charset=utf-8"]],
  ["/remnic/ui/what-helps-me/model.js", ["model.js", "application/javascript; charset=utf-8"]],
  ["/remnic/ui/what-helps-me/app.js", ["app.js", "application/javascript; charset=utf-8"]],
]);

interface WhatHelpsMeBrowserModel {
  expiryForChoice(choice: string, customValue: string, nowMs: number): string;
  buildShareUrl(currentUrl: string, grantId: string, secret: string, legacyPath: boolean): string;
}

let server: Server;
let origin = "";

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://placeholder").pathname;
    const asset = assets.get(pathname);
    if (!asset) {
      response.writeHead(404).end();
      return;
    }
    const body = await readFile(path.join(publicDir, asset[0]));
    response.writeHead(200, { "content-type": asset[1], "content-length": String(body.length) });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The UI test server did not bind a TCP port.");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

async function expectNoSeriousAxeFindings(page: Page): Promise<void> {
  const report = await new AxeBuilder({ page }).analyze();
  const findings = report.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical"
  );
  expect(findings).toEqual([]);
}

function helperUrl(suffix = "") {
  return `${origin}/remnic/ui/what-helps-me/?mode=replay&grant=replay-grant${suffix}#secret=${"s".repeat(43)}`;
}

async function createReplayShare(page: Page): Promise<void> {
  await page.goto(`${origin}/remnic/ui/what-helps-me/?mode=replay`);
  await page.getByLabel("Send these selected notes to my configured model to draft my cards.").check();
  await page.getByRole("button", { name: "Draft my support cards" }).click();
  await page.getByRole("button", { name: "Approve" }).first().click();
  await page.locator('input[name="shareCard"]').first().check();
  await page.getByRole("button", { name: "Create share link" }).click();
  await expect(page.getByText("Share link ready")).toBeVisible();
}

test("the owner reviews one card at a time and controls sharing", async ({ page }, testInfo) => {
  await page.goto(`${origin}/remnic/ui/what-helps-me/?mode=replay`);

  await expect(page.getByText("Synthetic replay")).toBeVisible();
  await expect(page.getByText("No support cards yet.")).toBeVisible();
  await expect(page.locator(".note-item")).toHaveCount(3);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({
    local: 0,
    session: 0,
  });

  await page.getByRole("button", { name: "Draft my support cards" }).click();
  await expect(page.getByText("Select the consent box before any model call.")).toBeVisible();
  await page.getByLabel("Send these selected notes to my configured model to draft my cards.").check();
  await page.getByRole("button", { name: "Draft my support cards" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".support-card")).toHaveCount(3);
  await expect(page.locator(".status-pill.draft")).toHaveCount(3);

  await page.getByRole("button", { name: "Edit" }).first().click();
  await page.getByLabel("Card title").fill("Softer lighting");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("heading", { name: "Softer lighting" })).toBeVisible();

  await page.getByRole("button", { name: "Approve" }).first().click();
  await expect(page.locator(".status-pill.approved")).toHaveCount(1);
  await page.locator('input[name="shareCard"]').first().check();
  await page.getByRole("button", { name: "Create share link" }).click();
  await expect(page.getByText("Share link ready")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop sharing" })).toBeVisible();

  await expectNoSeriousAxeFindings(page);
  await page.screenshot({ path: testInfo.outputPath(`owner-${testInfo.project.name}.png`), fullPage: true });

  await page.getByRole("button", { name: "Stop sharing" }).click();
  await expect(page.getByText("Sharing stopped", { exact: true })).toBeVisible();
});

test("the owner link disappears when sharing stops", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers owner link revocation.");
  await createReplayShare(page);

  await page.getByRole("button", { name: "Stop sharing" }).click();

  await expect(page.getByText("Share link ready")).toBeHidden();
  await expect(page.getByLabel("Copy this link once")).toHaveValue("");
});

test("the owner link disappears when a shared card is withdrawn", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers stale owner links.");
  await createReplayShare(page);

  await page.getByRole("button", { name: "Withdraw" }).first().click();

  await expect(page.getByText("Share link ready")).toBeHidden();
  await expect(page.getByLabel("Copy this link once")).toHaveValue("");
});

test("the owner link disappears at its expiry time", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers owner link expiry.");
  await page.clock.install({ time: new Date("2026-08-13T12:00:00.000Z") });
  await createReplayShare(page);

  await page.clock.fastForward(2 * 60 * 60_000);

  await expect(page.getByText("Share link ready")).toBeHidden();
  await expect(page.getByLabel("Copy this link once")).toHaveValue("");
});

test("the owner note preview preserves API text and binds consent to its revision", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers note preview content.");

  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards: [] }) });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: [] }) });
  });
  await page.route("**/engram/v1/support-passport/memories/note-with-attributes", async (route) => {
    expect(route.request().headers().authorization).toBe("Bearer owner-token");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        found: true,
        memory: {
          id: "note-with-attributes",
          content: "Tell me before plans change.\n[Attributes: this is part of my note]",
          revision: "b".repeat(64),
        },
      }),
    });
  });
  let generationInput: unknown;
  await page.route("**/engram/v1/support-passport/drafts/generate", async (route) => {
    generationInput = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards: [] }) });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();
  await page.getByLabel("Memory ID").fill("note-with-attributes");
  await page.getByRole("button", { name: "Add selected note" }).click();

  await expect(
    page.getByText("Tell me before plans change. [Attributes: this is part of my note]", { exact: true })
  ).toBeVisible();
  await page.getByLabel("Send these selected notes to my configured model to draft my cards.").check();
  await page.getByRole("button", { name: "Draft my support cards" }).click();
  expect(generationInput).toEqual({
    sourceMemoryIds: ["note-with-attributes"],
    sourceMemoryRevisions: [{ memoryId: "note-with-attributes", revision: "b".repeat(64) }],
    consent: true,
  });
});

test("a note preview preserves a newer memory ID while its request settles", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers note preview input state.");
  const releasePreview = Promise.withResolvers<void>();
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards: [] }) });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: [] }) });
  });
  await page.route("**/engram/v1/support-passport/memories/first-note", async (route) => {
    await releasePreview.promise;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        found: true,
        memory: { id: "first-note", content: "First selected note.", revision: "b".repeat(64) },
      }),
    });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();
  await page.getByLabel("Memory ID").fill("first-note");
  await page.getByRole("button", { name: "Add selected note" }).click();
  await expect(page.getByRole("button", { name: "Adding note…" })).toBeDisabled();
  await page.getByLabel("Memory ID").fill("next-note");
  releasePreview.resolve();

  await expect(page.getByText("First selected note.")).toBeVisible();
  await expect(page.getByLabel("Memory ID")).toHaveValue("next-note");
});

test("an owner page clears private state before browser-cache restoration", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers owner browser-cache cleanup.");
  const now = new Date();
  const card = {
    cardId: "private-card",
    title: "Private support",
    statement: "Private support text.",
    category: "other",
    status: "active",
    updatedAt: now.toISOString(),
    reviewBy: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    revision: "a".repeat(64),
  };
  const grant = {
    grantId: "private-grant",
    stateVersion: 1,
    cards: [{ cardId: card.cardId, revision: card.revision }],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
    status: "active",
  };
  const ownerShell = await readFile(path.join(publicDir, "index.html"), "utf8");
  await page.route(`${origin}/remnic/ui/what-helps-me/`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: ownerShell.replace(
        "</head>",
        '<script>(function(token,script){const key="__REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN__";const clear=function(){token="";try{delete window[key]}catch{window[key]=""}};window.addEventListener("pagehide",clear,{once:true});window.addEventListener("beforeunload",clear,{once:true});try{Object.defineProperty(window,key,{configurable:true,get:function(){const value=token;clear();return value}})}finally{if(script){script.textContent="";script.remove()}}})("prefilled-owner-token",document.currentScript);</script></head>'
      ),
    });
  });
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards: [card] }) });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: [grant] }) });
  });
  await page.route("**/engram/v1/support-passport/memories/private-note", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        found: true,
        memory: { id: "private-note", content: "Private selected note.", revision: "b".repeat(64) },
      }),
    });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await expect(page.getByLabel("Bearer token")).toHaveValue("prefilled-owner-token");
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN__?: string })
          .__REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN__
    )
  ).toBe("");
  expect(
    await page
      .locator("script")
      .evaluateAll((scripts) => scripts.some((script) => script.textContent?.includes("prefilled-owner-token")))
  ).toBe(false);
  await page.getByRole("button", { name: "Open my guide" }).click();
  await page.getByLabel("Memory ID").fill("private-note");
  await page.getByRole("button", { name: "Add selected note" }).click();
  await page.locator('input[name="duration"][value="custom"]').check();
  await page.locator("#customTimeInput").fill("2026-08-14T12:00");
  await expect(page.locator("#customTimeField")).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Card title").fill("Unsaved private edit");
  await expect(page.getByText("Private selected note.")).toBeVisible();
  await expect(page.locator("#cardList").getByText("Private support text.")).toBeVisible();

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));

  await expect(page.locator("#connectPanel")).toBeVisible();
  await expect(page.locator("#ownerView")).toBeHidden();
  await expect(page.getByLabel("Bearer token")).toHaveValue("");
  await expect(page.locator(".note-item")).toHaveCount(0);
  await expect(page.locator(".support-card")).toHaveCount(0);
  await expect(page.locator(".grant-card")).toHaveCount(0);
  await expect(page.locator("#cardDialog")).toBeHidden();
  await expect(page.getByLabel("Card title")).toHaveValue("");
  await expect(page.locator("#customTimeField")).toBeHidden();
  await expect(page.locator("#customTimeInput")).toHaveValue("");
  await expect(page.getByLabel("Copy this link once")).toHaveValue("");
});

test("a missing selected memory shows the specific not-found message", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers missing memory feedback.");
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards: [] }) });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: [] }) });
  });
  await page.route("**/engram/v1/support-passport/memories/missing-note", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ found: false }) });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();
  await page.getByLabel("Memory ID").fill("missing-note");
  await page.getByRole("button", { name: "Add selected note" }).click();

  await expect(page.getByText("That memory was not found in your Remnic scope.")).toBeVisible();
});

test("the owner cannot select more than eight cards for one share link", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers the share-card limit.");
  const now = new Date();
  const cards = Array.from({ length: 9 }, (_, index) => ({
    cardId: `card-${index + 1}`,
    title: `Support card ${index + 1}`,
    statement: `Support statement ${index + 1}.`,
    category: "other",
    status: "active",
    updatedAt: now.toISOString(),
    reviewBy: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    revision: String(index + 1).repeat(64),
  }));
  let createCalls = 0;
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards }) });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    if (route.request().method() === "POST") createCalls += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: [] }) });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();
  const choices = page.locator('input[name="shareCard"]');
  for (let index = 0; index < 8; index += 1) await choices.nth(index).check();
  await expect(choices.nth(8)).toBeDisabled();
  expect(
    await choices.evaluateAll(
      (inputs) => inputs.filter((input) => input instanceof HTMLInputElement && input.checked).length
    )
  ).toBe(8);

  await choices.nth(8).evaluate((input) => {
    if (!(input instanceof HTMLInputElement)) throw new Error("The share choice must be a checkbox.");
    input.disabled = false;
    input.checked = true;
  });
  await page.getByRole("button", { name: "Create share link" }).click();
  await expect(page.getByText("Select no more than eight approved support cards.")).toBeVisible();
  expect(createCalls).toBe(0);
});

test("a created share link remains visible when its list refresh fails", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers owner refresh recovery.");
  const now = new Date();
  const card = {
    cardId: "card-approved",
    title: "Quiet place",
    statement: "Offer me a quiet place and time.",
    category: "environment",
    status: "active",
    updatedAt: now.toISOString(),
    reviewBy: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    revision: "a".repeat(64),
  };
  let cardReads = 0;
  let grantInput: unknown;
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    cardReads += 1;
    if (cardReads > 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "offline" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards: [card] }) });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    if (route.request().method() === "POST") {
      grantInput = route.request().postDataJSON();
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          grantId: "3b998a98-d48d-4f5c-887c-617af9228847",
          secret: "s".repeat(43),
          expiresAt: new Date(now.getTime() + 2 * 60 * 60_000).toISOString(),
          version: 1,
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: [] }) });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();
  await page.locator('input[name="shareCard"]').check();
  await page.getByRole("button", { name: "Create share link" }).click();

  expect(grantInput).toEqual({
    cardIds: [card.cardId],
    cardRevisions: [{ cardId: card.cardId, revision: card.revision }],
    expiresAt: expect.any(String),
  });
  await expect(page.getByText("Share link ready")).toBeVisible();
  await expect(page.getByLabel("Copy this link once")).toHaveValue(
    /grant=3b998a98-d48d-4f5c-887c-617af9228847#secret=/
  );
  await expect(page.getByText("The share link was created, but the share list did not refresh.")).toBeVisible();
  await expect(page.getByText("The share link was not created.")).toHaveCount(0);
});

test("a malformed grant response never becomes a share link", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers response validation.");
  const now = new Date();
  const card = {
    cardId: "card-approved",
    title: "Quiet place",
    statement: "Offer me a quiet place and time.",
    category: "environment",
    status: "active",
    updatedAt: now.toISOString(),
    reviewBy: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    revision: "a".repeat(64),
  };
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards: [card] }) });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          grantId: "3b998a98-d48d-4f5c-887c-617af9228847",
          secret: "not-a-share-secret",
          expiresAt: new Date(now.getTime() + 2 * 60 * 60_000).toISOString(),
          version: 1,
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: [] }) });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();
  await page.locator('input[name="shareCard"]').check();
  await page.getByRole("button", { name: "Create share link" }).click();

  await expect(page.getByText("The new share link response is invalid.")).toBeVisible();
  await expect(page.getByText("Share link ready")).toBeHidden();
  await expect(page.getByLabel("Copy this link once")).toHaveValue("");
});

test("a new share attempt clears the prior link before a later failure", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers stale share-link cleanup.");
  const now = new Date();
  const card = {
    cardId: "card-approved",
    title: "Quiet place",
    statement: "Offer me a quiet place and time.",
    category: "environment",
    status: "active",
    updatedAt: now.toISOString(),
    reviewBy: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    revision: "b".repeat(64),
  };
  let createCalls = 0;
  const secondResponse = Promise.withResolvers<void>();
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards: [card] }) });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: [] }) });
      return;
    }
    createCalls += 1;
    if (createCalls === 1) {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          grantId: "3b998a98-d48d-4f5c-887c-617af9228847",
          secret: "s".repeat(43),
          expiresAt: new Date(now.getTime() + 2 * 60 * 60_000).toISOString(),
          version: 1,
        }),
      });
      return;
    }
    await secondResponse.promise;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "The share service is unavailable." }),
    });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();
  await page.locator('input[name="shareCard"]').check();
  await page.getByRole("button", { name: "Create share link" }).click();
  await expect(page.getByText("Share link ready")).toBeVisible();
  await expect(page.locator('input[name="shareCard"]')).not.toBeChecked();
  await page.locator('input[name="shareCard"]').check();

  await page.getByRole("button", { name: "Create share link" }).click();
  await expect(page.getByText("Share link ready")).toBeHidden();
  await expect(page.getByLabel("Copy this link once")).toHaveValue("");
  secondResponse.resolve();

  await expect(page.getByText("The share service is unavailable.")).toBeVisible();
  await expect(page.getByText("Share link ready")).toBeHidden();
});

test("a saved manual draft stays successful when its list refresh fails", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers draft refresh recovery.");
  let cardReads = 0;
  let draftWrites = 0;
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    cardReads += 1;
    if (cardReads > 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "offline" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards: [] }) });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: [] }) });
  });
  await page.route("**/engram/v1/support-passport/drafts", async (route) => {
    draftWrites += 1;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ cardId: "draft-one" }),
    });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();
  await page.getByRole("button", { name: "Write a card" }).click();
  await page.getByLabel("Card title").fill("Quiet place");
  await page.getByLabel("What helps me").fill("Offer me a quiet place and time.");
  await page.getByRole("button", { name: "Save draft" }).click();

  await expect(page.locator("#toast")).toHaveText("Draft saved. Review and approve it before sharing.");
  await expect(page.locator("#generateError")).toContainText("The draft was saved, but the card list did not refresh.");
  await expect(page.getByText("The draft did not save.")).toHaveCount(0);
  await expect(page.locator("#cardDialog")).toBeHidden();
  expect(draftWrites).toBe(1);
});

test("a manual draft locks its editor until the save settles", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers the draft editor lock.");
  const releaseDraft = Promise.withResolvers<void>();
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards: [] }) });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: [] }) });
  });
  await page.route("**/engram/v1/support-passport/drafts", async (route) => {
    await releaseDraft.promise;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ cardId: "draft-one" }),
    });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();
  await page.getByRole("button", { name: "Write a card" }).click();
  await page.getByLabel("Card title").fill("Quiet place");
  await page.getByLabel("What helps me").fill("Offer me a quiet place and time.");
  await page.getByRole("button", { name: "Save draft" }).click();

  await expect(page.getByRole("button", { name: "Saving draft…" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Close support card editor" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Keep reviewing" })).toBeDisabled();
  await expect(page.getByLabel("Card title")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Write a card" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.locator("#cardDialog")).toBeVisible();

  releaseDraft.resolve();
  await expect(page.locator("#cardDialog")).toBeHidden();
  await expect(page.getByRole("button", { name: "Write a card" })).toBeEnabled();
});

test("an overdue card can be edited without changing its review reminder", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers overdue card edits.");
  const overdueReview = "2026-01-15T10:30:00.000Z";
  const card = {
    cardId: "card-overdue",
    title: "Plan changes",
    statement: "Tell me before plans change.",
    category: "transitions",
    status: "active",
    updatedAt: "2026-01-01T12:00:00.000Z",
    reviewBy: overdueReview,
    revision: "a".repeat(64),
  };
  let replacementInput: unknown;
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards: [card] }) });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: [] }) });
  });
  await page.route("**/engram/v1/support-passport/cards/card-overdue", async (route) => {
    replacementInput = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ card }) });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Card title").fill("Early plan changes");
  await page.getByRole("button", { name: "Save draft" }).click();

  expect(replacementInput).toEqual({
    title: "Early plan changes",
    statement: card.statement,
    category: card.category,
    reviewBy: overdueReview,
    expectedRevision: card.revision,
  });
  await expect(page.locator("#toast")).toHaveText("Draft saved. Review and approve it before sharing.");
  await expect(page.getByText("Choose a future review reminder.")).toHaveCount(0);
});

test("successful owner mutations stay successful when their list refresh fails", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers owner mutation recovery.");
  const now = new Date();
  const card = {
    cardId: "card-pending",
    title: "Plan changes",
    statement: "Tell me before plans change.",
    category: "transitions",
    status: "pending_review",
    updatedAt: now.toISOString(),
    reviewBy: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    revision: "a".repeat(64),
  };
  const grant = {
    grantId: "grant-active",
    stateVersion: 1,
    cards: [{ cardId: card.cardId, revision: card.revision }],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
    status: "active",
  };
  let failCardRefresh = false;
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    if (failCardRefresh) {
      failCardRefresh = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "offline" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards: [card] }) });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: [grant] }) });
  });
  await page.route("**/engram/v1/support-passport/cards/card-pending/approve", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ card }) });
  });
  await page.route("**/engram/v1/support-passport/grants/grant-active/revoke", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grant }) });
  });
  await page.route("**/engram/v1/support-passport/memories/note-one", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        found: true,
        memory: { id: "note-one", content: "Tell me before plans change.", revision: "b".repeat(64) },
      }),
    });
  });
  await page.route("**/engram/v1/support-passport/drafts/generate", async (route) => {
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ cards: [] }) });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();

  failCardRefresh = true;
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator("#toast")).toHaveText("Approved Plan changes. It can now be shared.");
  await expect(page.locator("#generateError")).toContainText("The card list did not refresh.");
  await expect(page.getByText("The support card did not change.")).toHaveCount(0);

  await page.getByLabel("Memory ID").fill("note-one");
  await page.getByRole("button", { name: "Add selected note" }).click();
  await page.getByLabel("Send these selected notes to my configured model to draft my cards.").check();
  failCardRefresh = true;
  await page.getByRole("button", { name: "Draft my support cards" }).click();
  await expect(page.locator("#toast")).toHaveText("Drafts ready. Review each card before approval.");
  await expect(page.locator("#generateError")).toContainText("The card list did not refresh.");
  await expect(page.getByText("The configured model did not return valid drafts.")).toHaveCount(0);

  failCardRefresh = true;
  await page.getByRole("button", { name: "Stop sharing" }).click();
  await expect(page.locator("#toast")).toHaveText("Sharing stopped. The helper link is now locked.");
  await expect(page.locator("#shareError")).toContainText("The share list did not refresh.");
  await expect(page.getByText("The share link did not stop.")).toHaveCount(0);
});

test("an older owner refresh cannot replace newer owner state", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers owner refresh ordering.");
  const now = new Date();
  const oldCard = {
    cardId: "card-current",
    title: "Old support state",
    statement: "This response started first.",
    category: "other",
    status: "pending_review",
    updatedAt: now.toISOString(),
    reviewBy: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    revision: "a".repeat(64),
  };
  const newCard = {
    ...oldCard,
    title: "New support state",
    statement: "This response started second.",
    status: "active",
    revision: "b".repeat(64),
  };
  let cardReads = 0;
  const oldReadStarted = Promise.withResolvers<void>();
  const releaseOldRead = Promise.withResolvers<void>();
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    cardReads += 1;
    if (cardReads === 2) {
      oldReadStarted.resolve();
      await releaseOldRead.promise;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ cards: [oldCard] }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ cards: cardReads === 1 ? [oldCard] : [newCard] }),
    });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: [] }) });
  });
  await page.route("**/engram/v1/support-passport/cards/card-current/approve", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ card: newCard }) });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();
  const refresh = page.getByRole("button", { name: "Refresh cards and share links" });
  await refresh.click();
  await oldReadStarted.promise;
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("heading", { name: newCard.title })).toBeVisible();
  releaseOldRead.resolve();
  await expect(refresh).toBeEnabled();
  await expect(page.getByRole("heading", { name: newCard.title })).toBeVisible();
  await expect(page.getByRole("heading", { name: oldCard.title })).toHaveCount(0);
});

test("an expired share confirms a timed-out stop request", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers stop reconciliation.");
  const now = new Date("2026-08-11T12:00:00.000Z");
  const grant = {
    grantId: "grant-active",
    stateVersion: 1,
    cards: [{ cardId: "card-one", revision: "a".repeat(64) }],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
    status: "active",
  };
  let grantReads = 0;
  const reconciliationStarted = Promise.withResolvers<void>();
  const releaseReconciliation = Promise.withResolvers<void>();
  await page.clock.install({ time: now });
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/engram/v1/support-passport/grants/grant-active/revoke")) {
        return await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The request was aborted.", "AbortError")),
            { once: true }
          );
        });
      }
      return await realFetch(input, init);
    };
  });
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards: [] }) });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    grantReads += 1;
    if (grantReads === 2) {
      reconciliationStarted.resolve();
      await releaseReconciliation.promise;
    }
    const current = grantReads === 1 ? grant : { ...grant, status: "expired" };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: [current] }) });
  });
  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();
  await page.getByRole("button", { name: "Stop sharing" }).click();
  await page.clock.fastForward(60_000);
  await reconciliationStarted.promise;
  await expect(page.getByRole("button", { name: "Stopping sharing…" })).toBeDisabled();
  releaseReconciliation.resolve();

  await expect(page.locator("#toast")).toHaveText("Sharing stopped. The helper link is now locked.");
  await expect(page.getByText("Share time ended", { exact: true })).toBeVisible();
  await expect(page.locator("#shareError")).toHaveText("");
});

test("a stalled owner read aborts and restores the connect action", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers the owner request timeout.");
  await page.clock.install({ time: new Date("2026-08-11T12:00:00.000Z") });
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    Object.assign(window, { __ownerReadAbortObserved: false });
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/engram/v1/support-passport/cards")) {
        return await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              Object.assign(window, { __ownerReadAbortObserved: true });
              reject(new DOMException("The request was aborted.", "AbortError"));
            },
            { once: true }
          );
        });
      }
      return await realFetch(input, init);
    };
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: [] }) });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  const button = page.getByRole("button", { name: "Open my guide" });
  await button.click();
  await expect(page.getByRole("button", { name: "Opening guide…" })).toBeDisabled();
  await page.clock.fastForward(30_000);

  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { __ownerReadAbortObserved?: boolean }).__ownerReadAbortObserved)
    )
    .toBe(true);
  await expect(page.getByText("The owner request took too long. Try again.")).toBeVisible();
  await expect(button).toBeEnabled();
});

test("a stalled manual draft aborts without leaving a retryable duplicate", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers owner write cancellation.");
  await page.clock.install({ time: new Date("2026-08-11T12:00:00.000Z") });
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    Object.assign(window, {
      __ownerDraftAbortObserved: false,
      __ownerDraftCalls: 0,
      __ownerDraftReconciliationStarted: false,
      __releaseOwnerDraftReconciliation: undefined,
    });
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/engram/v1/support-passport/drafts") && init?.method === "POST") {
        Object.assign(window, {
          __ownerDraftCalls: ((window as typeof window & { __ownerDraftCalls?: number }).__ownerDraftCalls ?? 0) + 1,
        });
        return await new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              Object.assign(window, { __ownerDraftAbortObserved: true });
              reject(new DOMException("The request was aborted.", "AbortError"));
            },
            { once: true }
          );
        });
      }
      if (
        url.endsWith("/engram/v1/support-passport/cards") &&
        (window as typeof window & { __ownerDraftAbortObserved?: boolean }).__ownerDraftAbortObserved &&
        !(window as typeof window & { __ownerDraftReconciliationStarted?: boolean }).__ownerDraftReconciliationStarted
      ) {
        Object.assign(window, { __ownerDraftReconciliationStarted: true });
        return await new Promise<Response>((resolve) => {
          Object.assign(window, {
            __releaseOwnerDraftReconciliation: () =>
              resolve(
                new Response(JSON.stringify({ cards: [] }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                })
              ),
          });
        });
      }
      return await realFetch(input, init);
    };
  });
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards: [] }) });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: [] }) });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();
  await page.getByRole("button", { name: "Write a card" }).click();
  await page.getByLabel("Card title").fill("Quiet place");
  await page.getByLabel("What helps me").fill("Offer me a quiet place and time.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("button", { name: "Saving draft…" })).toBeDisabled();
  await page.clock.fastForward(60_000);
  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { __ownerDraftAbortObserved?: boolean }).__ownerDraftAbortObserved)
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __ownerDraftReconciliationStarted?: boolean }).__ownerDraftReconciliationStarted
      )
    )
    .toBe(true);
  await expect(page.getByRole("button", { name: "Saving draft…" })).toBeDisabled();
  await page.evaluate(() => {
    const release = (
      window as typeof window & {
        __releaseOwnerDraftReconciliation?: () => void;
      }
    ).__releaseOwnerDraftReconciliation;
    release?.();
  });
  await page.clock.fastForward(750);

  await expect(page.getByText("The request stopped before the draft saved.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save draft" })).toBeEnabled();
  expect(await page.evaluate(() => (window as typeof window & { __ownerDraftCalls?: number }).__ownerDraftCalls)).toBe(
    1
  );
});

test("a timed-out edit does not claim an identical draft for another card", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers edit reconciliation.");
  const now = new Date("2026-08-11T12:00:00.000Z");
  const reviewBy = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
  const sourceCard = {
    cardId: "source-card",
    title: "Plan changes",
    statement: "Tell me before plans change.",
    category: "transitions",
    status: "active",
    updatedAt: now.toISOString(),
    reviewBy,
    revision: "a".repeat(64),
  };
  const otherCard = { ...sourceCard, cardId: "other-card", revision: "b".repeat(64) };
  const unrelatedDraft = {
    ...sourceCard,
    cardId: "unrelated-draft",
    title: "Early plan changes",
    status: "pending_review",
    revision: "c".repeat(64),
  };
  await page.clock.install({ time: now });
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    Object.assign(window, { __ownerEditAbortObserved: false, __ownerEditCalls: 0 });
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/engram/v1/support-passport/cards/source-card") && init?.method === "PUT") {
        Object.assign(window, {
          __ownerEditCalls: ((window as typeof window & { __ownerEditCalls?: number }).__ownerEditCalls ?? 0) + 1,
        });
        return await new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              Object.assign(window, { __ownerEditAbortObserved: true });
              reject(new DOMException("The request was aborted.", "AbortError"));
            },
            { once: true }
          );
        });
      }
      return await realFetch(input, init);
    };
  });
  let cardReads = 0;
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    cardReads += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ cards: cardReads === 1 ? [sourceCard, otherCard] : [sourceCard, unrelatedDraft] }),
    });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: [] }) });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();
  await page.getByRole("button", { name: "Edit" }).first().click();
  await page.getByLabel("Card title").fill(unrelatedDraft.title);
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.clock.fastForward(60_000);
  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { __ownerEditAbortObserved?: boolean }).__ownerEditAbortObserved)
    )
    .toBe(true);
  await page.clock.fastForward(1_000);

  await expect(page.getByText("The edit timed out. Review the current guide before trying again.")).toBeVisible();
  await expect(page.locator("#cardDialog")).toBeVisible();
  await expect(page.getByLabel("Card title")).toHaveValue(unrelatedDraft.title);
  await expect(page.locator("#toast")).not.toHaveText("Draft saved. Review and approve it before sharing.");
  expect(await page.evaluate(() => (window as typeof window & { __ownerEditCalls?: number }).__ownerEditCalls)).toBe(1);
});

test("a successful response with invalid JSON does not open the owner guide", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers response decoding.");
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "not-json" });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: [] }) });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();

  await expect(page.getByText("The server returned invalid JSON with HTTP 200.")).toBeVisible();
  await expect(page.locator("#ownerView")).toBeHidden();
});

test("a stalled model draft shows uncertain state without claiming another draft", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers model draft cancellation.");
  const now = new Date("2026-08-11T12:00:00.000Z");
  const unrelatedDraft = {
    cardId: "unrelated-draft",
    title: "A separate draft",
    statement: "This draft came from another request.",
    category: "other",
    status: "pending_review",
    updatedAt: now.toISOString(),
    reviewBy: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    revision: "c".repeat(64),
  };
  await page.clock.install({ time: now });
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    Object.assign(window, { __ownerModelAbortObserved: false, __ownerModelCalls: 0 });
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/engram/v1/support-passport/drafts/generate") && init?.method === "POST") {
        Object.assign(window, {
          __ownerModelCalls: ((window as typeof window & { __ownerModelCalls?: number }).__ownerModelCalls ?? 0) + 1,
        });
        return await new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              Object.assign(window, { __ownerModelAbortObserved: true });
              reject(new DOMException("The request was aborted.", "AbortError"));
            },
            { once: true }
          );
        });
      }
      return await realFetch(input, init);
    };
  });
  let cardReads = 0;
  const reconciliationStarted = Promise.withResolvers<void>();
  const releaseReconciliation = Promise.withResolvers<void>();
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    cardReads += 1;
    if (cardReads === 2) {
      reconciliationStarted.resolve();
      await releaseReconciliation.promise;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ cards: cardReads === 1 ? [] : [unrelatedDraft] }),
    });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: [] }) });
  });
  await page.route("**/engram/v1/support-passport/memories/note-one", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        found: true,
        memory: { id: "note-one", content: "Tell me before plans change.", revision: "b".repeat(64) },
      }),
    });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();
  await page.getByLabel("Memory ID").fill("note-one");
  await page.getByRole("button", { name: "Add selected note" }).click();
  await page.getByLabel("Send these selected notes to my configured model to draft my cards.").check();
  await page.getByRole("button", { name: "Draft my support cards" }).click();
  await expect(page.getByRole("button", { name: "Drafting cards…" })).toBeDisabled();
  await expect(page.getByLabel("Memory ID")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Add selected note" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Remove selected note note-one" })).toBeDisabled();
  await expect(page.getByLabel("Send these selected notes to my configured model to draft my cards.")).toBeDisabled();
  await page.clock.fastForward(15 * 60_000);
  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { __ownerModelAbortObserved?: boolean }).__ownerModelAbortObserved)
    )
    .toBe(true);
  await reconciliationStarted.promise;
  await expect(page.getByRole("button", { name: "Drafting cards…" })).toBeDisabled();
  releaseReconciliation.resolve();

  await expect(
    page.getByText("Drafting timed out. Review the current guide before deciding whether to draft again.")
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: unrelatedDraft.title })).toBeVisible();
  await expect(page.locator("#toast")).not.toHaveText("Drafts ready. Review each card before approval.");
  await expect(
    page.getByLabel("Send these selected notes to my configured model to draft my cards.")
  ).not.toBeChecked();
  await expect(page.getByLabel("Memory ID")).toBeEnabled();
  await expect(page.getByRole("button", { name: "Add selected note" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Remove selected note note-one" })).toBeEnabled();
  expect(await page.evaluate(() => (window as typeof window & { __ownerModelCalls?: number }).__ownerModelCalls)).toBe(
    1
  );
});

test("a stalled share creation shows uncertain state without revoking a grant", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers share write cancellation.");
  const now = new Date("2026-08-11T12:00:00.000Z");
  const expiresAt = new Date(now.getTime() + 2 * 60 * 60_000).toISOString();
  const card = {
    cardId: "card-approved",
    title: "Quiet place",
    statement: "Offer me a quiet place and time.",
    category: "environment",
    status: "active",
    updatedAt: now.toISOString(),
    reviewBy: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    revision: "a".repeat(64),
  };
  const activeGrant = {
    grantId: "3b998a98-d48d-4f5c-887c-617af9228847",
    stateVersion: 1,
    cards: [{ cardId: card.cardId, revision: card.revision }],
    createdAt: now.toISOString(),
    expiresAt,
    status: "active",
  };
  await page.clock.install({ time: now });
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    Object.assign(window, { __ownerShareAbortObserved: false, __ownerShareCalls: 0, __ownerRevokeCalls: 0 });
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/engram/v1/support-passport/grants") && init?.method === "POST") {
        Object.assign(window, {
          __ownerShareCalls: ((window as typeof window & { __ownerShareCalls?: number }).__ownerShareCalls ?? 0) + 1,
        });
        return await new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              Object.assign(window, { __ownerShareAbortObserved: true });
              reject(new DOMException("The request was aborted.", "AbortError"));
            },
            { once: true }
          );
        });
      }
      if (url.endsWith("/revoke") && init?.method === "POST") {
        Object.assign(window, {
          __ownerRevokeCalls: ((window as typeof window & { __ownerRevokeCalls?: number }).__ownerRevokeCalls ?? 0) + 1,
        });
      }
      return await realFetch(input, init);
    };
  });
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards: [card] }) });
  });
  let grantReads = 0;
  const reconciliationStarted = Promise.withResolvers<void>();
  const releaseReconciliation = Promise.withResolvers<void>();
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    grantReads += 1;
    if (grantReads === 2) {
      reconciliationStarted.resolve();
      await releaseReconciliation.promise;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ grants: grantReads === 1 ? [] : [activeGrant] }),
    });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();
  await page.locator('input[name="shareCard"]').check();
  await page.getByRole("button", { name: "Create share link" }).click();
  await expect(page.getByRole("button", { name: "Creating link…" })).toBeDisabled();
  await expect(page.locator('input[name="shareCard"]')).toBeDisabled();
  await expect(page.locator('input[name="duration"][value="30m"]')).toBeDisabled();
  await page.clock.fastForward(60_000);
  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { __ownerShareAbortObserved?: boolean }).__ownerShareAbortObserved)
    )
    .toBe(true);
  await reconciliationStarted.promise;
  await expect(page.getByRole("button", { name: "Creating link…" })).toBeDisabled();
  releaseReconciliation.resolve();

  await expect(
    page.getByText(
      "The server did not confirm whether it created a link. Review the live share list and stop any link you do not recognize before creating another."
    )
  ).toBeVisible();
  await expect(page.getByText("Live share", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop sharing" })).toBeVisible();
  await expect(page.getByText("Share link ready")).toBeHidden();
  await expect(page.getByLabel("Copy this link once")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Create share link" })).toBeEnabled();
  await expect(page.locator('input[name="shareCard"]')).toBeChecked();
  await expect(page.locator('input[name="shareCard"]')).toBeEnabled();
  await expect(page.locator('input[name="duration"][value="30m"]')).toBeEnabled();
  expect(await page.evaluate(() => (window as typeof window & { __ownerShareCalls?: number }).__ownerShareCalls)).toBe(
    1
  );
  expect(
    await page.evaluate(() => (window as typeof window & { __ownerRevokeCalls?: number }).__ownerRevokeCalls)
  ).toBe(0);
});

test("the owner view bounds rendered share history", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers bounded share history.");
  const now = new Date();
  const grants = Array.from({ length: 150 }, (_, index) => ({
    grantId: `grant-${index}`,
    stateVersion: 1,
    cards: [{ cardId: "card-one", revision: "a".repeat(64) }],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
    status: "expired",
  }));
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards: [] }) });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants }) });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();

  await expect(page.locator(".grant-card")).toHaveCount(100);
});

test("the helper sees only shared cards and grounded citations", async ({ page }, testInfo) => {
  await page.goto(helperUrl());

  await expect(page.getByRole("heading", { name: "What helps me" })).toBeVisible();
  await expect(page.locator(".public-card")).toHaveCount(3);
  await expect(page.locator("#tokenInput")).toHaveCount(0);
  await expect(page.getByText("Selected notes", { exact: true })).toHaveCount(0);

  await page.getByLabel("Your question").fill("What should I do when this person is overwhelmed?");
  await page.getByRole("button", { name: "Ask from this guide" }).click();
  await expect(page.getByText("Offer a quiet place and time. Give the person space to respond.")).toBeVisible();
  await expect(page.locator(".citation")).toContainText("Support card");

  await expectNoSeriousAxeFindings(page);
  await page.screenshot({ path: testInfo.outputPath(`helper-${testInfo.project.name}.png`), fullPage: true });
});

test("a new helper question clears the prior answer before dispatch", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers stale-answer prevention.");
  const now = new Date();
  const secondStarted = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<void>();
  let asks = 0;
  await page.route(
    /\/engram\/v1\/support-passport\/public\/grants\/replay-grant-new-question(?:\/ask)?$/,
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          headers: { date: now.toUTCString() },
          contentType: "application/json",
          body: JSON.stringify({
            schemaVersion: 1,
            grantId: "replay-grant-new-question",
            expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
            updatedAt: now.toISOString(),
            cards: [
              {
                cardId: "card-quiet",
                title: "Quiet place",
                statement: "Offer me a quiet place and time.",
                category: "environment",
                updatedAt: now.toISOString(),
              },
            ],
          }),
        });
        return;
      }
      asks += 1;
      if (asks === 1) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            answer: "Offer a quiet place.",
            citedCardIds: ["card-quiet"],
            coverage: "grounded",
          }),
        });
        return;
      }
      secondStarted.resolve();
      await releaseSecond.promise;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "The configured model is unavailable.", code: "provider_unavailable" }),
      });
    }
  );

  await page.goto(`${origin}/remnic/ui/what-helps-me/?grant=replay-grant-new-question#secret=${"s".repeat(43)}`);
  await page.getByLabel("Your question").fill("What helps right now?");
  await page.getByRole("button", { name: "Ask from this guide" }).click();
  await expect(page.getByText("Offer a quiet place.", { exact: true })).toBeVisible();

  await page.getByLabel("Your question").fill("What food helps?");
  await page.getByRole("button", { name: "Ask from this guide" }).click();
  await secondStarted.promise;
  await expect(page.locator("#answerPanel")).toBeHidden();
  releaseSecond.resolve();
  await expect(page.getByText("The configured model is unavailable.")).toBeVisible();
  await expect(page.getByText("Offer a quiet place.", { exact: true })).toHaveCount(0);
  await expect(page.locator("#answerPanel")).toBeHidden();
});

test("a bad helper link has a clear locked view", async ({ page }, testInfo) => {
  await page.goto(`${origin}/remnic/ui/what-helps-me/#secret=${"s".repeat(43)}`);

  await expect(page.getByRole("heading", { name: "This link does not open a support passport." })).toBeVisible();
  await expect(page.locator("#tokenInput")).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe("");
  await expect(page.locator("#lockedTitle")).toBeFocused();
  await expectNoSeriousAxeFindings(page);
  await page.screenshot({ path: testInfo.outputPath(`locked-${testInfo.project.name}.png`), fullPage: true });
});

test("a transient initial helper failure can retry without the removed URL secret", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers initial helper retry.");
  const now = new Date();
  let reads = 0;
  await page.route("**/engram/v1/support-passport/public/grants/replay-grant-retry", async (route) => {
    reads += 1;
    expect(route.request().headers().authorization).toBe(`SupportPassport ${"s".repeat(43)}`);
    if (reads === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "The service is temporarily unavailable.", code: "provider_unavailable" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { date: now.toUTCString() },
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        grantId: "replay-grant-retry",
        expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
        updatedAt: now.toISOString(),
        cards: [
          {
            cardId: "card-retry",
            title: "Quiet place",
            statement: "Offer me a quiet place and time.",
            category: "environment",
            updatedAt: now.toISOString(),
          },
        ],
      }),
    });
  });

  await page.goto(helperUrl("-retry").replace("mode=replay&", ""));
  expect(new URL(page.url()).hash).toBe("");
  await expect(page.getByRole("heading", { name: "The support passport did not load." })).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();

  await expect(page.getByRole("heading", { name: "What helps me" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Quiet place" })).toBeVisible();
  expect(reads).toBe(2);
});

test("owner navigation avoids smooth scrolling when reduced motion is requested", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers reduced motion.");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    Object.assign(window, { __scrollBehaviors: [] });
    Element.prototype.scrollIntoView = (options) => {
      const behavior = typeof options === "object" && options ? options.behavior : undefined;
      (window as typeof window & { __scrollBehaviors: Array<ScrollBehavior | undefined> }).__scrollBehaviors.push(
        behavior
      );
    };
  });
  await page.goto(`${origin}/remnic/ui/what-helps-me/?mode=replay`);
  await page.getByLabel("Send these selected notes to my configured model to draft my cards.").check();
  await page.getByRole("button", { name: "Draft my support cards" }).click();

  expect(
    await page.evaluate(
      () => (window as typeof window & { __scrollBehaviors?: Array<ScrollBehavior | undefined> }).__scrollBehaviors
    )
  ).toEqual(["auto"]);
});

test("share links use the canonical path and reserve time for grant creation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers the browser policy helpers.");
  await page.goto(`${origin}/remnic/ui/what-helps-me/?mode=replay`);

  const result = await page.evaluate(() => {
    const now = Date.parse("2026-08-11T12:00:00.000Z");
    const model = (window as typeof window & { WhatHelpsMeModel: WhatHelpsMeBrowserModel }).WhatHelpsMeModel;
    let boundaryError = "";
    try {
      model.expiryForChoice("custom", new Date(now + 359_999).toISOString(), now);
    } catch (error) {
      boundaryError = error instanceof Error ? error.message : "unknown error";
    }
    return {
      boundaryError,
      expiresAt: model.expiryForChoice("custom", new Date(now + 360_000).toISOString(), now),
      shareUrl: model.buildShareUrl(
        "https://example.test/engram/ui/what-helps-me/?old=value#old=value",
        "grant-one",
        "secret-one",
        false
      ),
    };
  });

  expect(result).toEqual({
    boundaryError: "Choose a share time at least six minutes from now and no more than seven days away.",
    expiresAt: "2026-08-11T12:06:00.000Z",
    shareUrl: "https://example.test/remnic/ui/what-helps-me/?grant=grant-one#secret=secret-one",
  });
});

test("helper load, error, stale, stopped, and expired states fail closed", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers the state matrix.");

  const cases = [
    ["server-error", 503, "provider_unavailable", "The support passport did not load."],
    ["stale", 410, "grant_stale", "This share link is no longer current."],
    ["stopped", 410, "grant_gone", "This support passport is locked."],
    ["expired-before-load", 410, "grant_expired", "This share link has expired."],
  ] as const;
  for (const [name, status, code, heading] of cases) {
    const releaseResponse = Promise.withResolvers<void>();
    await page.route(`**/engram/v1/support-passport/public/grants/replay-grant-${name}`, async (route) => {
      await releaseResponse.promise;
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: name, code }) });
    });
    await page.goto(helperUrl(`-${name}`).replace("mode=replay&", ""));
    await expect(page.getByText("Opening the shared guide…")).toBeVisible();
    releaseResponse.resolve();
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await page.unrouteAll({ behavior: "wait" });
  }

  const expiryClock = new Date("2026-08-11T12:00:00.000Z");
  await page.clock.install({ time: expiryClock });
  const expiresAt = new Date(expiryClock.getTime() + 5_000).toISOString();
  const publicCard = {
    cardId: "card-expiring",
    title: "Quiet place",
    statement: "Offer me a quiet place and time.",
    category: "environment",
    updatedAt: new Date().toISOString(),
  };
  await page.route(/\/engram\/v1\/support-passport\/public\/grants\/replay-grant-expired(?:\/ask)?$/, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          grantId: "replay-grant-expired",
          expiresAt,
          updatedAt: publicCard.updatedAt,
          cards: [publicCard],
        }),
      });
      return;
    }
    await route.fulfill({
      status: 410,
      contentType: "application/json",
      body: JSON.stringify({ error: "ended", code: "grant_gone" }),
    });
  });
  await page.goto(helperUrl("-expired").replace("mode=replay&", ""));
  await expect(page.locator(".public-card")).toHaveCount(1);
  await page.clock.fastForward(5_000);
  await expect(page.getByRole("heading", { name: "This share link has expired." })).toBeVisible();
  await expect(page.locator(".public-card")).toHaveCount(0);
});

test("a fast helper clock does not expire a server-authorized guide", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers helper clock calibration.");

  await page.addInitScript(() => {
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + 24 * 60 * 60_000;
  });
  const serverNow = Date.now();
  await page.route("**/engram/v1/support-passport/public/grants/replay-grant-fast-clock", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { date: new Date(serverNow).toUTCString() },
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        grantId: "replay-grant-fast-clock",
        expiresAt: new Date(serverNow + 60 * 60_000).toISOString(),
        updatedAt: new Date(serverNow).toISOString(),
        cards: [
          {
            cardId: "card-fast-clock",
            title: "Quiet place",
            statement: "Offer me a quiet place and time.",
            category: "environment",
            updatedAt: new Date(serverNow).toISOString(),
          },
        ],
      }),
    });
  });

  await page.goto(helperUrl("-fast-clock").replace("mode=replay&", ""));

  await expect(page.locator(".public-card")).toHaveCount(1);
  await expect(page.locator("#lockedView")).toBeHidden();
});

test("a stalled initial helper read aborts and fails closed", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers the initial helper timeout.");
  await page.clock.install({ time: new Date("2026-08-11T12:00:00.000Z") });
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    Object.assign(window, { __initialHelperAbortObserved: false });
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("replay-grant-initial-stalled") && (init?.method ?? "GET") === "GET") {
        return await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              Object.assign(window, { __initialHelperAbortObserved: true });
              reject(new DOMException("The request was aborted.", "AbortError"));
            },
            { once: true }
          );
        });
      }
      return await realFetch(input, init);
    };
  });

  await page.goto(helperUrl("-initial-stalled").replace("mode=replay&", ""));
  await expect(page.getByText("Opening the shared guide…")).toBeVisible();
  await page.clock.fastForward(10_000);

  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { __initialHelperAbortObserved?: boolean }).__initialHelperAbortObserved
      )
    )
    .toBe(true);
  await expect(page.getByRole("heading", { name: "The support passport did not load." })).toBeVisible();
});

test("a stalled helper question aborts and restores its action", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers the helper question timeout.");
  const now = new Date("2026-08-11T12:00:00.000Z");
  await page.clock.install({ time: now });
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    Object.assign(window, { __helperQuestionAbortObserved: false });
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/ask") && init?.method === "POST") {
        return await new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              Object.assign(window, { __helperQuestionAbortObserved: true });
              reject(new DOMException("The request was aborted.", "AbortError"));
            },
            { once: true }
          );
        });
      }
      return await realFetch(input, init);
    };
  });
  await page.route("**/engram/v1/support-passport/public/grants/replay-grant-question-stalled", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { date: now.toUTCString() },
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        grantId: "replay-grant-question-stalled",
        expiresAt: new Date(now.getTime() + 2 * 60 * 60_000).toISOString(),
        updatedAt: now.toISOString(),
        cards: [
          {
            cardId: "card-question",
            title: "Plan changes",
            statement: "Tell me before plans change.",
            category: "transitions",
            updatedAt: now.toISOString(),
          },
        ],
      }),
    });
  });

  await page.goto(helperUrl("-question-stalled").replace("mode=replay&", ""));
  await page.getByLabel("Your question").fill("What should I do when plans change?");
  const button = page.getByRole("button", { name: "Ask from this guide" });
  await button.click();
  await expect(page.getByRole("button", { name: "Checking shared cards…" })).toBeDisabled();
  await expect(page.getByLabel("Your question")).toBeDisabled();
  await page.clock.fastForward(15 * 60_000);

  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { __helperQuestionAbortObserved?: boolean }).__helperQuestionAbortObserved
      )
    )
    .toBe(true);
  await expect(page.getByText("The question took too long. Try again.")).toBeVisible();
  await expect(button).toBeEnabled();
  await expect(page.getByLabel("Your question")).toBeEnabled();
});

test("a live helper view locks after the owner revokes its grant", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers live grant revalidation.");

  const now = new Date("2026-08-11T12:00:00.000Z");
  await page.clock.install({ time: now });
  let reads = 0;
  const updatedAt = now.toISOString();
  await page.route("**/engram/v1/support-passport/public/grants/replay-grant-live-revoked", async (route) => {
    reads += 1;
    if (reads > 1) {
      await route.fulfill({
        status: 410,
        contentType: "application/json",
        body: JSON.stringify({ error: "ended", code: "grant_gone" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        grantId: "replay-grant-live-revoked",
        expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
        updatedAt,
        cards: [
          {
            cardId: "card-live",
            title: "Quiet place",
            statement: "Offer me a quiet place and time.",
            category: "environment",
            updatedAt,
          },
        ],
      }),
    });
  });

  await page.goto(helperUrl("-live-revoked").replace("mode=replay&", ""));
  await expect(page.locator(".public-card")).toHaveCount(1);
  await page.clock.fastForward(30_000);
  await expect(page.getByRole("heading", { name: "This support passport is locked." })).toBeVisible();
  expect(reads).toBeGreaterThanOrEqual(2);
  await expect(page.locator(".public-card")).toHaveCount(0);
});

test("a restored helper view stays locked without its removed secret", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers helper browser-cache cleanup.");
  const now = new Date();
  let revoked = false;
  let reads = 0;
  await page.route("**/engram/v1/support-passport/public/grants/replay-grant-restored", async (route) => {
    reads += 1;
    if (revoked) {
      await route.fulfill({
        status: 410,
        contentType: "application/json",
        body: JSON.stringify({ error: "ended", code: "grant_gone" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { date: now.toUTCString() },
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        grantId: "replay-grant-restored",
        expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
        updatedAt: now.toISOString(),
        cards: [
          {
            cardId: "card-restored",
            title: "Quiet place",
            statement: "Offer me a quiet place and time.",
            category: "environment",
            updatedAt: now.toISOString(),
          },
        ],
      }),
    });
  });

  await page.goto(helperUrl("-restored").replace("mode=replay&", ""));
  await expect(page.locator(".public-card")).toHaveCount(1);
  await page.getByLabel("Your question").fill("What should I do?");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await expect(page.getByRole("heading", { name: "This helper session ended." })).toBeVisible();
  await expect(page.getByText("Open the original share link again to view this support passport.")).toBeVisible();
  await expect(page.locator(".public-card")).toHaveCount(0);
  await expect(page.getByLabel("Your question")).toHaveValue("");
  revoked = true;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));

  await expect(page.getByRole("heading", { name: "This helper session ended." })).toBeVisible();
  expect(reads).toBe(1);
  await expect(page.locator(".public-card")).toHaveCount(0);
});

test("helper revalidation backs off after a rate limit", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers helper polling backoff.");
  const now = new Date("2026-08-11T12:00:00.000Z");
  await page.clock.install({ time: now });
  let reads = 0;
  await page.route("**/engram/v1/support-passport/public/grants/replay-grant-rate-limit", async (route) => {
    reads += 1;
    if (reads === 2) {
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ error: "Too many helper requests.", code: "rate_limited" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { date: now.toUTCString() },
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        grantId: "replay-grant-rate-limit",
        expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
        updatedAt: now.toISOString(),
        cards: [
          {
            cardId: "card-rate-limit",
            title: "Quiet place",
            statement: "Offer me a quiet place and time.",
            category: "environment",
            updatedAt: now.toISOString(),
          },
        ],
      }),
    });
  });

  await page.goto(helperUrl("-rate-limit").replace("mode=replay&", ""));
  await expect(page.locator(".public-card")).toHaveCount(1);
  await page.clock.fastForward(30_000);
  await expect.poll(() => reads).toBe(2);
  await page.clock.fastForward(59_000);
  expect(reads).toBe(2);
  await page.clock.fastForward(1_000);
  await expect.poll(() => reads).toBe(3);
});

test("a stalled helper revalidation aborts and later observes revocation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers revalidation recovery.");
  const now = new Date("2026-08-11T12:00:00.000Z");
  await page.clock.install({ time: now });
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    let grantReads = 0;
    Object.assign(window, { __revalidationAbortObserved: false });
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("replay-grant-stalled") && (init?.method ?? "GET") === "GET") {
        grantReads += 1;
        if (grantReads === 2) {
          return await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                Object.assign(window, { __revalidationAbortObserved: true });
                reject(new DOMException("The request was aborted.", "AbortError"));
              },
              { once: true }
            );
          });
        }
      }
      return await realFetch(input, init);
    };
  });
  let serverReads = 0;
  await page.route("**/engram/v1/support-passport/public/grants/replay-grant-stalled", async (route) => {
    serverReads += 1;
    if (serverReads > 1) {
      await route.fulfill({
        status: 410,
        contentType: "application/json",
        body: JSON.stringify({ error: "ended", code: "grant_gone" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { date: now.toUTCString() },
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        grantId: "replay-grant-stalled",
        expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
        updatedAt: now.toISOString(),
        cards: [
          {
            cardId: "card-stalled",
            title: "Quiet place",
            statement: "Offer me a quiet place and time.",
            category: "environment",
            updatedAt: now.toISOString(),
          },
        ],
      }),
    });
  });

  await page.goto(helperUrl("-stalled").replace("mode=replay&", ""));
  await expect(page.locator(".public-card")).toHaveCount(1);
  await page.clock.fastForward(30_000);
  await page.clock.fastForward(10_000);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { __revalidationAbortObserved?: boolean }).__revalidationAbortObserved
      )
    )
    .toBe(true);
  await page.clock.fastForward(30_000);
  await expect(page.getByRole("heading", { name: "This support passport is locked." })).toBeVisible();
  expect(serverReads).toBe(2);
});

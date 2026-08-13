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
  expiryForChoice(choice: string, customValue: string, nowMs: number): { durationMs: number } | { expiresAt: string };
  buildShareUrl(
    currentUrl: string,
    grantId: string,
    secret: string,
    legacyPath: boolean,
    replayChannelId?: string
  ): string;
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

function injectOwnerPrefill(shell: string, token: string): string {
  const script = `<script>(function(token,script){const key="__REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN__";const clear=function(){token="";try{delete window[key]}catch{window[key]=""}};window.addEventListener("pagehide",clear,{once:true});window.addEventListener("beforeunload",clear,{once:true});try{if(new URLSearchParams(location.hash.slice(1)).has("secret")){clear();return}Object.defineProperty(window,key,{configurable:true,get:function(){const value=token;clear();return value}})}finally{if(script){script.textContent="";script.remove()}}})(${JSON.stringify(token)},document.currentScript);</script>`;
  return shell.replace("</head>", `${script}</head>`);
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
  await expect(page.getByLabel("Memory ID")).toHaveAttribute("maxlength", "512");
  await expect(page.getByLabel("Memory ID")).not.toHaveAttribute("pattern");
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
  await expect(page.getByText("Share time ended", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop sharing" })).toHaveCount(0);
});

test("a fast owner clock keeps a server-authorized share link visible", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers owner clock calibration.");
  await page.addInitScript(() => {
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + 24 * 60 * 60_000;
  });
  const serverNow = Date.now();
  const card = {
    cardId: "card-fast-owner-clock",
    title: "Quiet place",
    statement: "Offer me a quiet place and time.",
    category: "environment",
    status: "active",
    updatedAt: new Date(serverNow).toISOString(),
    reviewBy: new Date(serverNow + 24 * 60 * 60_000).toISOString(),
    revision: "a".repeat(64),
  };
  const grant = {
    grantId: "3b998a98-d48d-4f5c-887c-617af9228847",
    stateVersion: 1,
    cards: [{ cardId: card.cardId, revision: card.revision }],
    createdAt: new Date(serverNow).toISOString(),
    expiresAt: new Date(serverNow + 60 * 60_000).toISOString(),
    status: "active",
  };
  let created = false;
  let createInput: Record<string, unknown> | undefined;
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { date: new Date(serverNow).toUTCString() },
      contentType: "application/json",
      body: JSON.stringify({ cards: [card] }),
    });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    if (route.request().method() === "POST") {
      created = true;
      createInput = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        headers: { date: new Date(serverNow).toUTCString() },
        contentType: "application/json",
        body: JSON.stringify({
          grantId: grant.grantId,
          secret: "s".repeat(43),
          expiresAt: grant.expiresAt,
          version: grant.stateVersion,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { date: new Date(serverNow).toUTCString() },
      contentType: "application/json",
      body: JSON.stringify({ grants: created ? [grant] : [] }),
    });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();
  await page.locator('input[name="shareCard"]').check();
  await page.locator('input[name="duration"][value="custom"]').check();
  const customExpiry = serverNow + 60 * 60_000;
  await page.locator("#customTimeInput").fill(
    await page.evaluate((timestamp) => {
      const date = new Date(timestamp);
      const offset = date.getTimezoneOffset() * 60_000;
      return new Date(timestamp - offset).toISOString().slice(0, 16);
    }, customExpiry)
  );
  await page.getByRole("button", { name: "Create share link" }).click();

  await expect(page.getByText("Share link ready")).toBeVisible();
  await expect(page.getByLabel("Copy this link once")).toHaveValue(/#secret=/);
  expect(createInput?.expiresAt).toBe(new Date(Math.floor(customExpiry / 60_000) * 60_000).toISOString());
});

test("a new replay helper locks after a shared card is withdrawn", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers replay share invalidation.");
  await page.goto(`${origin}/remnic/ui/what-helps-me/?mode=replay`);
  await page.getByLabel("Send these selected notes to my configured model to draft my cards.").check();
  await page.getByRole("button", { name: "Draft my support cards" }).click();
  await page.getByRole("button", { name: "Approve" }).first().click();
  await page.locator('input[name="shareCard"]').first().check();
  await page.getByRole("button", { name: "Create share link" }).click();
  const shareUrl = await page.getByLabel("Copy this link once").inputValue();
  await page.getByRole("button", { name: "Withdraw" }).click();

  const helper = await context.newPage();
  await helper.goto(shareUrl);

  await expect(helper.getByRole("heading", { name: "This share link is no longer current." })).toBeVisible();
  await expect(helper.getByRole("button", { name: "Try again" })).toBeHidden();
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
  await expect(page.getByLabel("Bearer token")).not.toHaveAttribute("name");
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

test("drafting waits for a pending note preview", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers pending note previews.");
  const releasePreview = Promise.withResolvers<void>();
  let generationCalls = 0;
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards: [] }) });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: [] }) });
  });
  await page.route(/\/engram\/v1\/support-passport\/memories\/(first-note|second-note)$/, async (route) => {
    const memoryId = new URL(route.request().url()).pathname.split("/").at(-1) ?? "";
    if (memoryId === "second-note") await releasePreview.promise;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        found: true,
        memory: {
          id: memoryId,
          content: `${memoryId} content.`,
          revision: (memoryId === "first-note" ? "a" : "b").repeat(64),
        },
      }),
    });
  });
  await page.route("**/engram/v1/support-passport/drafts/generate", async (route) => {
    generationCalls += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards: [] }) });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();
  await page.getByLabel("Memory ID").fill("first-note");
  await page.getByRole("button", { name: "Add selected note" }).click();
  await page.getByLabel("Send these selected notes to my configured model to draft my cards.").check();
  await page.getByLabel("Memory ID").fill("second-note");
  await page.getByRole("button", { name: "Add selected note" }).click();

  await expect(page.getByRole("button", { name: "Adding note…" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Draft my support cards" })).toBeDisabled();
  await page.locator("#generateButton").dispatchEvent("click");
  await expect(page.getByText("Wait for the selected note to finish loading before drafting.")).toBeVisible();
  expect(generationCalls).toBe(0);

  releasePreview.resolve();
  await expect(page.locator(".note-item")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Draft my support cards" })).toBeEnabled();
  await expect(
    page.getByLabel("Send these selected notes to my configured model to draft my cards.")
  ).not.toBeChecked();
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
      body: injectOwnerPrefill(ownerShell, "prefilled-owner-token"),
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
    await page.evaluate(() => Object.hasOwn(window, "__REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN__"))
  ).toBe(false);
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

test("owner cleanup cancels delayed private announcements", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers announcement cleanup.");
  const now = new Date("2026-08-13T12:00:00.000Z");
  const card = {
    cardId: "private-announcement-card",
    title: "Private support title",
    statement: "Private support text.",
    category: "other",
    status: "pending_review",
    updatedAt: now.toISOString(),
    reviewBy: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    revision: "a".repeat(64),
  };
  let approved = false;
  await page.clock.install({ time: now });
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cards: approved ? [{ ...card, status: "active", revision: "b".repeat(64) }] : [card],
      }),
    });
  });
  await page.route("**/engram/v1/support-passport/cards/private-announcement-card/approve", async (route) => {
    approved = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ card }) });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: [] }) });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator("#toast")).toContainText("Private support title");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await page.clock.fastForward(20);

  await expect(page.locator("#announcer")).toHaveText("");
  await expect(page.locator("#ownerView")).toBeHidden();
});

test("a hidden owner write cannot add an error after reconnect", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers owner lifecycle isolation.");
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    Object.assign(window, {
      __hiddenOwnerWriteAborted: false,
      __releaseHiddenOwnerWrite: undefined,
    });
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/engram/v1/support-passport/drafts/generate") && init?.method === "POST") {
        return await new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => Object.assign(window, { __hiddenOwnerWriteAborted: true }), {
            once: true,
          });
          Object.assign(window, {
            __releaseHiddenOwnerWrite: () => reject(new Error("late hidden owner write failure")),
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
  await page.route("**/engram/v1/support-passport/memories/note-hidden-owner", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        found: true,
        memory: {
          id: "note-hidden-owner",
          content: "Tell me before plans change.",
          revision: "b".repeat(64),
        },
      }),
    });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();
  await page.getByLabel("Memory ID").fill("note-hidden-owner");
  await page.getByRole("button", { name: "Add selected note" }).click();
  await page.getByLabel("Send these selected notes to my configured model to draft my cards.").check();
  await page.getByRole("button", { name: "Draft my support cards" }).click();
  await expect(page.getByRole("button", { name: "Drafting cards…" })).toBeDisabled();

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await expect(page.locator("#generateButton")).toHaveText("Draft my support cards");
  await expect(page.locator('#shareForm button[type="submit"]')).toHaveText("Create share link");
  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { __hiddenOwnerWriteAborted?: boolean }).__hiddenOwnerWriteAborted)
    )
    .toBe(true);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();
  await page.evaluate(() => {
    const release = (window as typeof window & { __releaseHiddenOwnerWrite?: () => void }).__releaseHiddenOwnerWrite;
    release?.();
  });

  await expect(page.locator("#generateError")).toHaveText("");
  await expect(page.getByText("late hidden owner write failure")).toHaveCount(0);
  await expect(page.locator("#ownerView")).toBeVisible();
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

test("two share submissions create one grant", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers duplicate share submission.");
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
  const releaseGrant = Promise.withResolvers<void>();
  let createCalls = 0;
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards: [card] }) });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: [] }) });
      return;
    }
    createCalls += 1;
    await releaseGrant.promise;
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
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();
  await page.locator('input[name="shareCard"]').check();
  await page.locator("#shareForm").evaluate((form) => {
    for (let index = 0; index < 2; index += 1) {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }
  });

  await expect.poll(() => createCalls).toBe(1);
  await expect(page.getByRole("button", { name: "Creating link…" })).toBeDisabled();
  releaseGrant.resolve();
  await expect(page.getByRole("button", { name: "Create share link" })).toBeEnabled();
  expect(createCalls).toBe(1);
});

test("sharing waits while a selected card is being withdrawn", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers the card and share write lock.");
  const now = new Date();
  const card = {
    cardId: "card-being-withdrawn",
    title: "Quiet place",
    statement: "Offer me a quiet place and time.",
    category: "environment",
    status: "active",
    updatedAt: now.toISOString(),
    reviewBy: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    revision: "a".repeat(64),
  };
  const releaseWithdrawal = Promise.withResolvers<void>();
  let withdrawn = false;
  let createCalls = 0;
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ cards: withdrawn ? [] : [card] }),
    });
  });
  await page.route("**/engram/v1/support-passport/cards/card-being-withdrawn/withdraw", async (route) => {
    await releaseWithdrawal.promise;
    withdrawn = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ card }) });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    if (route.request().method() === "POST") createCalls += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: [] }) });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();
  await page.locator('input[name="shareCard"]').check();
  await page.getByRole("button", { name: "Withdraw" }).click();

  await expect(page.getByRole("button", { name: "Stopping…" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Create share link" })).toBeDisabled();
  await page.locator("#shareForm").dispatchEvent("submit");
  await expect(
    page.getByText("Wait for the selected support card to finish changing before sharing it.")
  ).toBeVisible();
  expect(createCalls).toBe(0);

  releaseWithdrawal.resolve();
  await expect(page.locator('input[name="shareCard"]')).toHaveCount(0);
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
    durationMs: 2 * 60 * 60_000,
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
  const activeGrant = {
    grantId: "3b998a98-d48d-4f5c-887c-617af9228847",
    stateVersion: 1,
    cards: [{ cardId: card.cardId, revision: card.revision }],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 2 * 60 * 60_000).toISOString(),
    status: "active",
  };
  let firstGrantCreated = false;
  const secondResponse = Promise.withResolvers<void>();
  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards: [card] }) });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ grants: firstGrantCreated ? [activeGrant] : [] }),
      });
      return;
    }
    createCalls += 1;
    if (createCalls === 1) {
      firstGrantCreated = true;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          grantId: activeGrant.grantId,
          secret: "s".repeat(43),
          expiresAt: activeGrant.expiresAt,
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

test("a timed-out manual draft stays uncertain when an identical draft appears", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers owner write cancellation.");
  await page.clock.install({ time: new Date("2026-08-11T12:00:00.000Z") });
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    let submittedDraft: Record<string, string> | undefined;
    const identicalDraftResponse = () =>
      new Response(
        JSON.stringify({
          cards: [
            {
              ...submittedDraft,
              cardId: "identical-other-tab-draft",
              status: "pending_review",
              updatedAt: new Date().toISOString(),
              revision: "c".repeat(64),
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    Object.assign(window, {
      __ownerDraftAbortObserved: false,
      __ownerDraftCalls: 0,
      __ownerDraftReconciliationStarted: false,
      __releaseOwnerDraftReconciliation: undefined,
    });
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/engram/v1/support-passport/drafts") && init?.method === "POST") {
        submittedDraft = JSON.parse(typeof init.body === "string" ? init.body : "{}") as Record<string, string>;
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
        (window as typeof window & { __ownerDraftAbortObserved?: boolean }).__ownerDraftAbortObserved
      ) {
        if (
          (window as typeof window & { __ownerDraftReconciliationStarted?: boolean }).__ownerDraftReconciliationStarted
        ) {
          return identicalDraftResponse();
        }
        Object.assign(window, { __ownerDraftReconciliationStarted: true });
        return await new Promise<Response>((resolve) => {
          Object.assign(window, {
            __releaseOwnerDraftReconciliation: () => resolve(identicalDraftResponse()),
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

  await expect(
    page.getByText(
      "The request timed out. Review the current guide to see whether the draft saved before trying again."
    )
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Quiet place" })).toBeVisible();
  await expect(page.locator("#cardDialog")).toBeVisible();
  await expect(page.locator("#toast")).not.toHaveText("Draft saved. Review and approve it before sharing.");
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
  await expect(page.getByRole("button", { name: "Edit" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Withdraw" })).toBeDisabled();
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

test("the helper sees only shared cards and grounded citations", async ({ page, context }, testInfo) => {
  await page.goto(`${origin}/remnic/ui/what-helps-me/?mode=replay`);
  await page.getByLabel("Send these selected notes to my configured model to draft my cards.").check();
  await page.getByRole("button", { name: "Draft my support cards" }).click();
  for (const title of ["Lighting", "Plan changes", "When I stop speaking"]) {
    await page.locator(".support-card").filter({ hasText: title }).getByRole("button", { name: "Approve" }).click();
  }
  const choices = page.locator('input[name="shareCard"]');
  for (let index = 0; index < 3; index += 1) await choices.nth(index).check();
  await page.getByRole("button", { name: "Create share link" }).click();
  const shareUrl = await page.locator("#shareLinkInput").inputValue();

  const helper = await context.newPage();
  try {
    await helper.goto(shareUrl);
    await expect(helper.getByRole("heading", { name: "What helps me" })).toBeVisible();
    await expect(helper.locator(".public-card")).toHaveCount(3);
    await expect(helper.locator("#tokenInput")).toHaveCount(0);
    await expect(helper.getByText("Selected notes", { exact: true })).toHaveCount(0);

    await helper.getByLabel("Your question").fill("What should I do if this person stops speaking?");
    await helper.getByRole("button", { name: "Ask from this guide" }).click();
    await expect(helper.locator("#answerCopy")).toHaveText("If I stop speaking, offer a quiet place and time.");
    await expect(helper.locator(".citation")).toContainText("Support card");

    await expectNoSeriousAxeFindings(helper);
    await helper.screenshot({ path: testInfo.outputPath(`helper-${testInfo.project.name}.png`), fullPage: true });
  } finally {
    await helper.close();
  }
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

test("an older helper ask cannot unlock a newer ask", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers overlapping helper asks.");
  const now = new Date();
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    let askCalls = 0;
    Object.assign(window, { __helperAskCalls: 0, __releaseSecondHelperAsk: undefined });
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith("/ask") || init?.method !== "POST") return await realFetch(input, init);
      askCalls += 1;
      Object.assign(window, { __helperAskCalls: askCalls });
      if (askCalls === 1) {
        return await new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The request was aborted.", "AbortError")),
            { once: true }
          );
        });
      }
      return await new Promise<Response>((resolve) => {
        Object.assign(window, {
          __releaseSecondHelperAsk: () =>
            resolve(
              new Response(
                JSON.stringify({
                  answer: "Offer a quiet place.",
                  citedCardIds: ["card-quiet"],
                  coverage: "grounded",
                }),
                { status: 200, headers: { "content-type": "application/json" } }
              )
            ),
        });
      });
    };
  });
  await page.route("**/engram/v1/support-passport/public/grants/replay-grant-overlap", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { date: now.toUTCString() },
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        grantId: "replay-grant-overlap",
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
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/?grant=replay-grant-overlap#secret=${"s".repeat(43)}`);
  await page.getByLabel("Your question").fill("What helps first?");
  await page.getByRole("button", { name: "Ask from this guide" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as typeof window & { __helperAskCalls?: number }).__helperAskCalls))
    .toBe(1);
  await page.evaluate(() => {
    const input = document.getElementById("questionInput");
    const form = document.getElementById("questionForm");
    if (!(input instanceof HTMLTextAreaElement) || !(form instanceof HTMLFormElement)) return;
    input.disabled = false;
    input.value = "What helps second?";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await expect
    .poll(() => page.evaluate(() => (window as typeof window & { __helperAskCalls?: number }).__helperAskCalls))
    .toBe(2);

  await expect(page.getByLabel("Your question")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Checking shared cards…" })).toBeDisabled();
  await expect(page.locator("#questionError")).toHaveText("");
  await page.evaluate(() => {
    const release = (window as typeof window & { __releaseSecondHelperAsk?: () => void }).__releaseSecondHelperAsk;
    release?.();
  });

  await expect(page.getByText("Offer a quiet place.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Your question")).toBeEnabled();
  await expect(page.getByRole("button", { name: "Ask from this guide" })).toBeEnabled();
});

test("replay helpers receive only the card selected by the owner", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers replay grant transfer.");
  await page.goto(`${origin}/remnic/ui/what-helps-me/?mode=replay`);
  await page.getByLabel("Send these selected notes to my configured model to draft my cards.").check();
  await page.getByRole("button", { name: "Draft my support cards" }).click();
  const planCard = page.locator(".support-card").filter({ hasText: "Plan changes" });
  await planCard.getByRole("button", { name: "Approve" }).click();
  await page.locator(".card-choice").filter({ hasText: "Plan changes" }).locator('input[name="shareCard"]').check();
  await page.getByRole("button", { name: "Create share link" }).click();
  const shareUrl = await page.locator("#shareLinkInput").inputValue();

  const helper = await context.newPage();
  try {
    await helper.goto(shareUrl);
    await expect(helper.locator(".public-card")).toHaveCount(1);
    await expect(helper.locator(".public-card").getByRole("heading", { name: "Plan changes" })).toBeVisible();
    await expect(helper.getByRole("heading", { name: "Lighting" })).toHaveCount(0);
    await helper.getByLabel("Your question").fill("Can you change the lighting?");
    await helper.getByRole("button", { name: "Ask from this guide" }).click();
    await expect(helper.locator("#answerCopy")).toHaveText("That is not covered in this person's support guide.");
    await expect(helper.locator(".citation")).toHaveText("No support card covers this question.");
    await helper.getByLabel("Your question").fill("What should I do when plans change?");
    await helper.getByRole("button", { name: "Ask from this guide" }).click();
    await expect(helper.locator("#answerCopy")).toHaveText("Tell me before plans change.");
    await expect(helper.locator(".citation")).toContainText("Plan changes");
  } finally {
    await helper.close();
  }
});

test("a replay helper with the wrong secret stays locked", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers replay secret validation.");
  await page.goto(`${origin}/remnic/ui/what-helps-me/?mode=replay`);
  await page.getByLabel("Send these selected notes to my configured model to draft my cards.").check();
  await page.getByRole("button", { name: "Draft my support cards" }).click();
  await page.getByRole("button", { name: "Approve" }).first().click();
  await page.locator('input[name="shareCard"]').first().check();
  await page.getByRole("button", { name: "Create share link" }).click();
  const badUrl = new URL(await page.locator("#shareLinkInput").inputValue());
  badUrl.hash = `secret=${"x".repeat(43)}`;

  const helper = await context.newPage();
  try {
    await helper.goto(badUrl.toString());
    await expect(helper.getByRole("heading", { name: "This link does not open a support passport." })).toBeVisible();
    await expect(helper.locator(".public-card")).toHaveCount(0);
  } finally {
    await helper.close();
  }
});

test("a replay helper locks after the owner withdraws a shared card", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers replay card withdrawal.");
  await page.goto(`${origin}/remnic/ui/what-helps-me/?mode=replay`);
  await page.getByLabel("Send these selected notes to my configured model to draft my cards.").check();
  await page.getByRole("button", { name: "Draft my support cards" }).click();
  const planCard = page.locator(".support-card").filter({ hasText: "Plan changes" });
  await planCard.getByRole("button", { name: "Approve" }).click();
  await page.locator(".card-choice").filter({ hasText: "Plan changes" }).locator('input[name="shareCard"]').check();
  await page.getByRole("button", { name: "Create share link" }).click();
  const shareUrl = await page.locator("#shareLinkInput").inputValue();

  const helper = await context.newPage();
  try {
    await helper.goto(shareUrl);
    await expect(helper.locator(".public-card")).toHaveCount(1);
    await planCard.getByRole("button", { name: "Withdraw" }).click();
    await expect(helper.getByRole("heading", { name: "This share link is no longer current." })).toBeVisible();
    await expect(helper.locator(".public-card")).toHaveCount(0);
  } finally {
    await helper.close();
  }
});

test("a replay helper locks after the owner approves an edited shared card", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers replay card replacement.");
  await page.goto(`${origin}/remnic/ui/what-helps-me/?mode=replay`);
  await page.getByLabel("Send these selected notes to my configured model to draft my cards.").check();
  await page.getByRole("button", { name: "Draft my support cards" }).click();
  const planCard = page.locator(".support-card").filter({ hasText: "Tell me before plans change." });
  await planCard.getByRole("button", { name: "Approve" }).click();
  await page.locator(".card-choice").filter({ hasText: "Plan changes" }).locator('input[name="shareCard"]').check();
  await page.getByRole("button", { name: "Create share link" }).click();
  const shareUrl = await page.locator("#shareLinkInput").inputValue();

  const helper = await context.newPage();
  try {
    await helper.goto(shareUrl);
    await expect(helper.locator(".public-card")).toHaveCount(1);
    await planCard.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("What helps me").fill("Tell me early when plans change.");
    await page.getByRole("button", { name: "Save draft" }).click();
    const replacement = page.locator(".support-card").filter({ hasText: "Tell me early when plans change." });
    await replacement.getByRole("button", { name: "Approve" }).click();
    await expect(helper.getByRole("heading", { name: "This share link is no longer current." })).toBeVisible();
    await expect(helper.locator(".public-card")).toHaveCount(0);
  } finally {
    await helper.close();
  }
});

test("a replay helper keeps an invalidation that arrives while its guide loads", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers replay load invalidation.");
  await page.goto(`${origin}/remnic/ui/what-helps-me/?mode=replay`);
  await page.getByLabel("Send these selected notes to my configured model to draft my cards.").check();
  await page.getByRole("button", { name: "Draft my support cards" }).click();
  const planCard = page.locator(".support-card").filter({ hasText: "Plan changes" });
  await planCard.getByRole("button", { name: "Approve" }).click();
  await page.locator(".card-choice").filter({ hasText: "Plan changes" }).locator('input[name="shareCard"]').check();
  await page.getByRole("button", { name: "Create share link" }).click();
  const shareUrl = await page.locator("#shareLinkInput").inputValue();

  const helper = await context.newPage();
  await helper.addInitScript(() => {
    const NativeBroadcastChannel = window.BroadcastChannel;
    window.BroadcastChannel = class DelayedReplayChannel extends NativeBroadcastChannel {
      addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
      ) {
        if (type !== "message") return super.addEventListener(type, listener, options);
        const delayed = (event: MessageEvent) => {
          const dispatch = () => {
            if (typeof listener === "function") listener(event);
            else listener.handleEvent(event);
          };
          if (event.data?.type === "grant-state") {
            Object.assign(window, { __replayGrantStateDelayed: true });
            window.setTimeout(dispatch, 150);
          } else dispatch();
        };
        return super.addEventListener(type, delayed as EventListener, options);
      }
    };
  });
  try {
    await helper.goto(shareUrl, { waitUntil: "domcontentloaded" });
    await helper.waitForFunction(
      () => (window as typeof window & { __replayGrantStateDelayed?: boolean }).__replayGrantStateDelayed === true,
      undefined,
      { timeout: 5_000 }
    );
    await planCard.getByRole("button", { name: "Withdraw" }).click();
    await expect(helper.getByRole("heading", { name: "This share link is no longer current." })).toBeVisible();
    await expect(helper.locator(".public-card")).toHaveCount(0);
  } finally {
    await helper.close();
  }
});

test("replay owner tabs do not answer another owner's helper", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers replay owner isolation.");
  const otherOwner = await context.newPage();
  await page.goto(`${origin}/remnic/ui/what-helps-me/?mode=replay`);
  await otherOwner.goto(`${origin}/remnic/ui/what-helps-me/?mode=replay`);
  await page.getByLabel("Send these selected notes to my configured model to draft my cards.").check();
  await page.getByRole("button", { name: "Draft my support cards" }).click();
  await page.getByRole("button", { name: "Approve" }).first().click();
  await page.locator('input[name="shareCard"]').first().check();
  await page.getByRole("button", { name: "Create share link" }).click();
  const shareUrl = await page.locator("#shareLinkInput").inputValue();

  const helper = await context.newPage();
  try {
    await helper.goto(shareUrl);
    await expect(helper.locator(".public-card")).toHaveCount(1);
    await expect(helper.locator("#lockedView")).toBeHidden();
  } finally {
    await helper.close();
    await otherOwner.close();
  }
});

test("replay helpers never cite an unrelated selected card", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers replay answer grounding.");
  await page.goto(`${origin}/remnic/ui/what-helps-me/?mode=replay`);
  await page.getByRole("button", { name: "Write a card" }).click();
  await page.getByLabel("Card title").fill("Email preference");
  await page.getByLabel("What helps me").fill("I need time to read emails.");
  await page.getByRole("button", { name: "Save draft" }).click();
  const emailCard = page.locator(".support-card").filter({ hasText: "Email preference" });
  await emailCard.getByRole("button", { name: "Approve" }).click();
  await page.locator(".card-choice").filter({ hasText: "Email preference" }).locator('input[name="shareCard"]').check();
  await page.getByRole("button", { name: "Create share link" }).click();
  const shareUrl = await page.locator("#shareLinkInput").inputValue();

  const helper = await context.newPage();
  try {
    await helper.goto(shareUrl);
    await expect(helper.locator(".public-card")).toHaveCount(1);
    await helper.getByLabel("Your question").fill("What should I do when this person is overwhelmed?");
    await helper.getByRole("button", { name: "Ask from this guide" }).click();
    await expect(helper.locator("#answerCopy")).toHaveText("That is not covered in this person's support guide.");
    await expect(helper.locator(".citation")).toHaveText("No support card covers this question.");
    await expect(helper.locator(".citation")).not.toContainText("Email preference");
  } finally {
    await helper.close();
  }
});

test("replay helpers require the same quiet-support intent", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers quiet-support intent grounding.");
  await page.goto(`${origin}/remnic/ui/what-helps-me/?mode=replay`);
  await page.getByRole("button", { name: "Write a card" }).click();
  await page.getByLabel("Card title").fill("Walking when overwhelmed");
  await page.getByLabel("What helps me").fill("Walking helps me when I am overwhelmed.");
  await page.getByLabel("Category").selectOption("regulation");
  await page.getByRole("button", { name: "Save draft" }).click();
  const walkingCard = page.locator(".support-card").filter({ hasText: "Walking when overwhelmed" });
  await walkingCard.getByRole("button", { name: "Approve" }).click();
  await page.locator(".card-choice").filter({ hasText: "Walking when overwhelmed" }).locator('input[name="shareCard"]').check();
  await page.getByRole("button", { name: "Create share link" }).click();
  const shareUrl = await page.locator("#shareLinkInput").inputValue();

  const helper = await context.newPage();
  try {
    await helper.goto(shareUrl);
    await helper.getByLabel("Your question").fill("Should I offer a quiet room?");
    await helper.getByRole("button", { name: "Ask from this guide" }).click();
    await expect(helper.locator("#answerCopy")).toHaveText("That is not covered in this person's support guide.");
    await expect(helper.locator(".citation")).toHaveText("No support card covers this question.");

    await helper.getByLabel("Your question").fill("What helps when this person is overwhelmed?");
    await helper.getByRole("button", { name: "Ask from this guide" }).click();
    await expect(helper.locator("#answerCopy")).toHaveText("Walking helps me when I am overwhelmed.");
    await expect(helper.locator(".citation")).toContainText("Walking when overwhelmed");
  } finally {
    await helper.close();
  }
});

test("replay helpers require the same transition intent", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers transition intent grounding.");
  await page.goto(`${origin}/remnic/ui/what-helps-me/?mode=replay`);
  await page.getByRole("button", { name: "Write a card" }).click();
  await page.getByLabel("Card title").fill("Morning routine");
  await page.getByLabel("What helps me").fill("Keep my morning routine consistent.");
  await page.getByLabel("Category").selectOption("transitions");
  await page.getByRole("button", { name: "Save draft" }).click();
  const routineCard = page.locator(".support-card").filter({ hasText: "Morning routine" });
  await routineCard.getByRole("button", { name: "Approve" }).click();
  await page.locator(".card-choice").filter({ hasText: "Morning routine" }).locator('input[name="shareCard"]').check();
  await page.getByRole("button", { name: "Create share link" }).click();
  const shareUrl = await page.locator("#shareLinkInput").inputValue();

  const helper = await context.newPage();
  try {
    await helper.goto(shareUrl);
    await helper.getByLabel("Your question").fill("What is tomorrow's schedule?");
    await helper.getByRole("button", { name: "Ask from this guide" }).click();
    await expect(helper.locator("#answerCopy")).toHaveText("That is not covered in this person's support guide.");
    await expect(helper.locator(".citation")).toHaveText("No support card covers this question.");

    await helper.getByLabel("Your question").fill("What helps with the morning routine?");
    await helper.getByRole("button", { name: "Ask from this guide" }).click();
    await expect(helper.locator("#answerCopy")).toHaveText("Keep my morning routine consistent.");
    await expect(helper.locator(".citation")).toContainText("Morning routine");
  } finally {
    await helper.close();
  }
});

test("a replay helper fails closed without owner share state", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers replay synchronization failure.");

  await page.goto(helperUrl("-without-owner"));

  await expect(page.getByRole("heading", { name: "The support passport did not load." })).toBeVisible();
  await expect(page.locator(".public-card")).toHaveCount(0);

  await page.getByRole("button", { name: "Try again" }).click();

  await expect(page.getByRole("heading", { name: "The support passport did not load." })).toBeVisible();
  await expect(page.locator(".public-card")).toHaveCount(0);
});

test("a restored replay owner keeps the share bridge active", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers replay owner restoration.");
  await page.goto(`${origin}/remnic/ui/what-helps-me/?mode=replay`);
  await page.getByLabel("Send these selected notes to my configured model to draft my cards.").check();
  await page.getByRole("button", { name: "Draft my support cards" }).click();
  await page.getByRole("button", { name: "Approve" }).first().click();
  await page.locator('input[name="shareCard"]').first().check();
  await page.getByRole("button", { name: "Create share link" }).click();
  const shareUrl = await page.locator("#shareLinkInput").inputValue();

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));

  const helper = await context.newPage();
  try {
    await helper.goto(shareUrl);
    await expect(helper.locator(".public-card")).toHaveCount(1);
    await page.getByRole("button", { name: "Stop sharing" }).click();
    await expect(helper.getByRole("heading", { name: "This support passport is locked." })).toBeVisible();
  } finally {
    await helper.close();
  }
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

test("a fragment helper clears secrets when both app bundles fail", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers bootstrap secret cleanup.");
  const ownerShell = await readFile(path.join(publicDir, "index.html"), "utf8");
  await page.route(`${origin}/remnic/ui/what-helps-me/`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: injectOwnerPrefill(ownerShell, "prefilled-owner-token"),
    });
  });
  await page.route(/\/what-helps-me\/(?:model|app)\.js$/, async (route) => {
    await route.abort();
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/#secret=${"s".repeat(43)}`);

  expect(new URL(page.url()).hash).toBe("");
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN__?: string })
          .__REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN__
    )
  ).toBeUndefined();
  expect(
    await page
      .locator("script")
      .evaluateAll((scripts) => scripts.some((script) => script.textContent?.includes("prefilled-owner-token")))
  ).toBe(false);
});

test("a manual owner token clears when the app bundles fail", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers bundle-independent token cleanup.");
  await page.route(/\/what-helps-me\/(?:model|app)\.js$/, async (route) => {
    await route.abort();
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("manual-owner-token");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));

  await expect(page.getByLabel("Bearer token")).toHaveValue("");
  await page.getByLabel("Bearer token").fill("restored-owner-token");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.getByLabel("Bearer token")).toHaveValue("");
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

test("share links use the canonical path and keep preset duration independent from browser time", async ({
  page,
}, testInfo) => {
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
      customExpiry: model.expiryForChoice("custom", new Date(now + 360_000).toISOString(), now),
      presetExpiry: model.expiryForChoice("30m", "", now + 60 * 60_000),
      shareUrl: model.buildShareUrl(
        "https://example.test/engram/ui/what-helps-me/?old=value#old=value",
        "grant-one",
        "secret-one",
        false,
        "ignored-replay-channel"
      ),
    };
  });

  expect(result).toEqual({
    boundaryError: "Choose a share time at least six minutes from now and no more than seven days away.",
    customExpiry: { expiresAt: "2026-08-11T12:06:00.000Z" },
    presetExpiry: { durationMs: 1_800_000 },
    shareUrl: "https://example.test/remnic/ui/what-helps-me/?grant=grant-one#secret=secret-one",
  });
});

test("replay share presets create a finite share link", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers replay expiry.");
  await page.goto(`${origin}/remnic/ui/what-helps-me/?mode=replay`);
  await page.getByLabel("Send these selected notes to my configured model to draft my cards.").check();
  await page.getByRole("button", { name: "Draft my support cards" }).click();
  await page.getByRole("button", { name: "Approve" }).first().click();
  await page.locator('input[name="shareCard"]').first().check();
  await page.getByRole("button", { name: "Create share link" }).click();

  await expect(page.locator("#toast")).toContainText(/Share link created\. It ends/);
  await expect(page.locator("#shareLinkInput")).toHaveValue(/grant=/);
  await expect(page.locator("#grantList")).not.toContainText("Invalid Date");
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

  const serverNow = Date.parse("2026-08-13T12:00:00.000Z");
  await page.clock.install({ time: new Date(serverNow) });
  await page.addInitScript(() => {
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + 24 * 60 * 60_000;
  });
  let reads = 0;
  await page.route("**/engram/v1/support-passport/public/grants/replay-grant-fast-clock", async (route) => {
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
  await page.clock.fastForward(30_000);
  await expect(page.getByRole("heading", { name: "This support passport is locked." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "This share link has expired." })).toHaveCount(0);
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
  await page.route(
    /\/engram\/v1\/support-passport\/public\/grants\/replay-grant-live-revoked(?:\/ask)?$/,
    async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            answer: "Offer a quiet place.",
            citedCardIds: ["card-live"],
            coverage: "grounded",
          }),
        });
        return;
      }
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
    }
  );

  await page.goto(helperUrl("-live-revoked").replace("mode=replay&", ""));
  await expect(page.locator(".public-card")).toHaveCount(1);
  await page.getByLabel("Your question").fill("What helps right now?");
  await page.getByRole("button", { name: "Ask from this guide" }).click();
  await expect(page.getByText("Offer a quiet place.", { exact: true })).toBeVisible();
  await page.clock.fastForward(30_000);
  await expect(page.getByRole("heading", { name: "This support passport is locked." })).toBeVisible();
  expect(reads).toBeGreaterThanOrEqual(2);
  await expect(page.locator(".public-card")).toHaveCount(0);
  await expect(page.getByLabel("Your question")).toHaveValue("");
  await expect(page.locator("#answerCopy")).toHaveText("");
  await expect(page.locator("#citationList")).toBeEmpty();
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

test("a late helper load failure cannot replace the hidden-page lock", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers helper lifecycle isolation.");
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    Object.assign(window, {
      __hiddenHelperReadAborted: false,
      __releaseHiddenHelperRead: undefined,
    });
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("replay-grant-hidden-helper") && (init?.method ?? "GET") === "GET") {
        return await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => Object.assign(window, { __hiddenHelperReadAborted: true }), {
            once: true,
          });
          Object.assign(window, {
            __releaseHiddenHelperRead: () => reject(new Error("late hidden helper read failure")),
          });
        });
      }
      return await realFetch(input, init);
    };
  });

  await page.goto(helperUrl("-hidden-helper").replace("mode=replay&", ""));
  await expect(page.getByText("Opening the shared guide…")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await expect(page.getByRole("heading", { name: "This helper session ended." })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { __hiddenHelperReadAborted?: boolean }).__hiddenHelperReadAborted)
    )
    .toBe(true);
  await page.evaluate(() => {
    const release = (window as typeof window & { __releaseHiddenHelperRead?: () => void }).__releaseHiddenHelperRead;
    release?.();
  });

  await expect(page.getByRole("heading", { name: "This helper session ended." })).toBeVisible();
  await expect(page.getByText("Open the original share link again to view this support passport.")).toBeVisible();
  await expect(page.getByText("late hidden helper read failure")).toHaveCount(0);
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

test("a stalled helper revalidation fails closed before a retry observes revocation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers fail-closed revalidation.");
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
  await expect(page.getByRole("heading", { name: "The support passport did not load." })).toBeVisible();
  await expect(page.locator(".public-card")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  expect(serverReads).toBe(1);

  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "This support passport is locked." })).toBeVisible();
  expect(serverReads).toBe(2);
});

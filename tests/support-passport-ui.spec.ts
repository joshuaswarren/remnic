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
  stripAttributesSuffix(content: string): string;
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

test("the owner note preview hides stored attribute metadata", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers note preview content.");

  await page.route("**/engram/v1/support-passport/cards", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards: [] }) });
  });
  await page.route("**/engram/v1/support-passport/grants", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ grants: [] }) });
  });
  await page.route("**/engram/v1/memories/note-with-attributes", async (route) => {
    expect(route.request().headers().authorization).toBe("Bearer owner-token");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        found: true,
        memory: {
          content: "Tell me before plans change.\n[Attributes: support-passport: source]",
        },
      }),
    });
  });

  await page.goto(`${origin}/remnic/ui/what-helps-me/`);
  await page.getByLabel("Bearer token").fill("owner-token");
  await page.getByRole("button", { name: "Open my guide" }).click();
  await page.getByLabel("Memory ID").fill("note-with-attributes");
  await page.getByRole("button", { name: "Add selected note" }).click();

  await expect(page.getByText("Tell me before plans change.", { exact: true })).toBeVisible();
  await expect(page.getByText(/\[Attributes:/)).toHaveCount(0);
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

test("a bad helper link has a clear locked view", async ({ page }, testInfo) => {
  await page.goto(`${origin}/remnic/ui/what-helps-me/#secret=${"s".repeat(43)}`);

  await expect(page.getByRole("heading", { name: "This link does not open a support passport." })).toBeVisible();
  await expect(page.locator("#tokenInput")).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe("");
  await expectNoSeriousAxeFindings(page);
  await page.screenshot({ path: testInfo.outputPath(`locked-${testInfo.project.name}.png`), fullPage: true });
});

test("share links use the canonical path and reserve time for grant creation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers the browser policy helpers.");
  await page.goto(`${origin}/remnic/ui/what-helps-me/?mode=replay`);

  const result = await page.evaluate(() => {
    const now = Date.parse("2026-08-11T12:00:00.000Z");
    const model = (window as typeof window & { WhatHelpsMeModel: WhatHelpsMeBrowserModel }).WhatHelpsMeModel;
    let boundaryError = "";
    try {
      model.expiryForChoice("custom", new Date(now + 300_000).toISOString(), now);
    } catch (error) {
      boundaryError = error instanceof Error ? error.message : "unknown error";
    }
    return {
      boundaryError,
      expiresAt: model.expiryForChoice("custom", new Date(now + 305_000).toISOString(), now),
      shareUrl: model.buildShareUrl(
        "https://example.test/engram/ui/what-helps-me/?old=value#old=value",
        "grant-one",
        "secret-one",
        false
      ),
      notePreview: model.stripAttributesSuffix(
        "Tell me before plans change.\n[Attributes: support-passport: source]"
      ),
    };
  });

  expect(result).toEqual({
    boundaryError: "Choose a share time at least five minutes from now and no more than seven days away.",
    expiresAt: "2026-08-11T12:05:05.000Z",
    shareUrl: "https://example.test/remnic/ui/what-helps-me/?grant=grant-one#secret=secret-one",
    notePreview: "Tell me before plans change.",
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

  const expiresAt = new Date(Date.now() + 250).toISOString();
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

test("a live helper view locks after the owner revokes its grant", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-375", "One viewport covers live grant revalidation.");

  let reads = 0;
  const updatedAt = new Date().toISOString();
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
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
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
  await expect(page.getByRole("heading", { name: "This support passport is locked." })).toBeVisible({
    timeout: 20_000,
  });
  expect(reads).toBeGreaterThanOrEqual(2);
  await expect(page.locator(".public-card")).toHaveCount(0);
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
  await page.clock.fastForward(15_000);
  await page.clock.fastForward(10_000);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { __revalidationAbortObserved?: boolean }).__revalidationAbortObserved
      )
    )
    .toBe(true);
  await page.clock.fastForward(15_000);
  await expect(page.getByRole("heading", { name: "This support passport is locked." })).toBeVisible();
  expect(serverReads).toBe(2);
});

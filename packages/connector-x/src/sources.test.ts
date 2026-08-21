import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseXConnectorConfig } from "./config.js";
import { XBudgetTracker, createXSource, unlimitedBudget } from "./sources.js";
import type { XExecFn } from "./sources.js";

function mcpConfig(overrides: Record<string, unknown> = {}) {
  return parseXConnectorConfig({
    userId: "123",
    sources: [{ id: "x-mcp", kind: "mcp", ...overrides }],
  }).sources[0];
}

function tokenFileFor(dir: string): string {
  return path.join(dir, "tokens.json");
}

async function seedTokens(dir: string): Promise<string> {
  const file = tokenFileFor(dir);
  await writeFile(
    file,
    JSON.stringify({ access_token: "tok", refresh_token: "r", expires_at: Date.now() + 3_600_000 })
  );
  return file;
}

function mcpResponses(pages: unknown[]): Response[] {
  const out: Response[] = [
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Mcp-Session-Id": "s1" },
    }),
    new Response("", { status: 202 }),
  ];
  let id = 2;
  for (const page of pages) {
    out.push(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(page) }] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    id += 1;
  }
  return out;
}

const ENV = { REMNIC_X_CLIENT_ID: "cid", REMNIC_X_CLIENT_SECRET: "csecret" };

function page(ids: string[], nextToken?: string): unknown {
  return {
    data: ids.map((id) => ({ id, text: `post ${id}`, author_id: "7" })),
    includes: { users: [{ id: "7", username: "author" }] },
    ...(nextToken !== undefined ? { meta: { next_token: nextToken } } : {}),
  };
}

test("mcp source paginates and stops on a page of known ids", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-x-src-"));
  const tokenFile = await seedTokens(dir);
  const responses = mcpResponses([page(["1", "2"], "p2"), page(["3"]), page(["9"])]);
  let call = 0;
  const source = createXSource(mcpConfig({ auth: { tokenFile } }), {
    env: ENV,
    userId: "123",
    fetchImpl: (async () => {
      call += 1;
      const next = responses.shift();
      assert.ok(next !== undefined);
      return next;
    }) as typeof fetch,
  });
  const budget = new XBudgetTracker({ maxPagesPerSync: 5, maxCostUsdPerMonth: 10, costPerReadUsd: 0.01 }, 0);
  // Bookmarks page 2 contains only known ids → pagination stops after it,
  // then one own-posts timeline page runs.
  const outcome = await source.fetch({ knownIds: new Set(["3"]), budget });
  assert.equal(outcome.records.length, 4);
  assert.equal(outcome.reads, 3);
  assert.equal(call, 5);
  assert.equal(outcome.skipped, undefined);
  assert.ok(outcome.records.some((record) => record.kind === "own_post" && record.postId === "9"));
});

test("mcp source enforces the page cap as a clean skip", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-x-src-"));
  const tokenFile = await seedTokens(dir);
  const responses = mcpResponses([page(["1"], "p2"), page(["2"], "p3"), page(["3"])]);
  const source = createXSource(mcpConfig({ auth: { tokenFile } }), {
    env: ENV,
    fetchImpl: (async () => {
      const next = responses.shift();
      assert.ok(next !== undefined);
      return next;
    }) as typeof fetch,
  });
  const budget = new XBudgetTracker({ maxPagesPerSync: 2, maxCostUsdPerMonth: 10, costPerReadUsd: 0.01 }, 0);
  const outcome = await source.fetch({ knownIds: new Set(), budget });
  assert.equal(outcome.records.length, 2);
  assert.equal(outcome.reads, 2);
  assert.equal(outcome.skipped?.reason, "page-cap");
});

test("mcp source skips cleanly when the monthly cost cap is reached", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-x-src-"));
  const tokenFile = await seedTokens(dir);
  let fetches = 0;
  const source = createXSource(mcpConfig({ auth: { tokenFile } }), {
    env: ENV,
    fetchImpl: (async () => {
      fetches += 1;
      return mcpResponses([page(["1"])])[2];
    }) as typeof fetch,
  });
  const budget = new XBudgetTracker(
    { maxPagesPerSync: 2, maxCostUsdPerMonth: 0.01, costPerReadUsd: 0.01 },
    0.01 // already at cap this month
  );
  const outcome = await source.fetch({ knownIds: new Set(), budget });
  assert.equal(outcome.records.length, 0);
  assert.equal(outcome.skipped?.reason, "monthly-cost-cap");
  assert.equal(fetches, 0); // initialize+notification never happened: gate ran first
});

test("mcp source maps credits-depleted to a clean skip", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-x-src-"));
  const tokenFile = await seedTokens(dir);
  const responses = [
    ...mcpResponses([]).slice(0, 2),
    new Response(JSON.stringify({ detail: "credits depleted", status: 402 }), { status: 402 }),
  ];
  const source = createXSource(mcpConfig({ auth: { tokenFile } }), {
    env: ENV,
    fetchImpl: (async () => {
      const next = responses.shift();
      assert.ok(next !== undefined);
      return next;
    }) as typeof fetch,
  });
  const outcome = await source.fetch({ knownIds: new Set(), budget: unlimitedBudget });
  assert.equal(outcome.skipped?.reason, "credits-depleted");
});

test("mcp source without credentials degrades, not crashes", async () => {
  const source = createXSource(mcpConfig(), { env: {} });
  const outcome = await source.fetch({ knownIds: new Set(), budget: unlimitedBudget });
  assert.equal(outcome.skipped?.reason, "auth-not-configured");
});

test("corpus source reads sorted json files and skips bad ones and escaping symlinks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-x-corpus-"));
  const outside = await mkdtemp(path.join(tmpdir(), "remnic-x-outside-"));
  await writeFile(path.join(root, "b.json"), JSON.stringify({ id: "2", text: "second" }));
  await writeFile(path.join(root, "a.json"), JSON.stringify([{ id: "1", text: "first" }]));
  await writeFile(path.join(root, "bad.json"), "{not json");
  await symlink(path.join(outside, "x.json"), path.join(root, "escape.json"));
  await writeFile(path.join(outside, "x.json"), JSON.stringify({ id: "99", text: "outside" }));
  const config = parseXConnectorConfig({
    sources: [{ id: "c", kind: "corpusDir", path: root }],
  }).sources[0];
  const source = createXSource(config);
  const outcome = await source.fetch({ knownIds: new Set(), budget: unlimitedBudget });
  assert.equal(outcome.records.length, 2);
  assert.ok(outcome.records.every((record) => record.postId !== "99"));
  assert.equal(outcome.reads, 0);
});

test("corpus source reports a missing directory as a clean skip", async () => {
  const config = parseXConnectorConfig({
    sources: [{ id: "c", kind: "corpusDir", path: "/nonexistent/remnic-x-test" }],
  }).sources[0];
  const outcome = await createXSource(config).fetch({
    knownIds: new Set(),
    budget: unlimitedBudget,
  });
  assert.equal(outcome.skipped?.reason, "corpus-dir-missing");
});

test("cli source parses bird-style json output for bookmarks and posts", async () => {
  const config = parseXConnectorConfig({
    sources: [{ id: "b", kind: "cli", bin: "bird", postsArgs: ["timeline", "--json"] }],
  }).sources[0];
  const exec: XExecFn = async (_bin, args) => {
    if (args.includes("bookmarks")) {
      return { stdout: JSON.stringify([{ id: "7", text: "saved", username: "k" }]), stderr: "" };
    }
    return { stdout: JSON.stringify({ data: [{ id: "8", text: "mine", kind: "post" }] }), stderr: "" };
  };
  const outcome = await createXSource(config, { execImpl: exec }).fetch({
    knownIds: new Set(),
    budget: unlimitedBudget,
  });
  assert.equal(outcome.records.length, 2);
  assert.deepEqual(outcome.records.map((record) => `${record.kind}:${record.postId}`).sort(), [
    "bookmark:7",
    "own_post:8",
  ]);
});

test("cli source degrades when the binary is missing or output is not json", async () => {
  const config = parseXConnectorConfig({
    sources: [{ id: "b", kind: "cli" }],
  }).sources[0];
  const missing: XExecFn = async () => {
    const err = new Error("spawn bird ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  };
  const outcome = await createXSource(config, { execImpl: missing }).fetch({
    knownIds: new Set(),
    budget: unlimitedBudget,
  });
  assert.equal(outcome.skipped?.reason, "cli-not-installed");

  const garbage: XExecFn = async () => ({ stdout: "not json", stderr: "" });
  const outcome2 = await createXSource(config, { execImpl: garbage }).fetch({
    knownIds: new Set(),
    budget: unlimitedBudget,
  });
  assert.equal(outcome2.skipped?.reason, "cli-output-unparseable");
});

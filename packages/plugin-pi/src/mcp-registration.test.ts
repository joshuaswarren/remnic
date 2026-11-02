import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { createRemnicPiExtension, type PiApi } from "./index.js";
import type { RemnicPiConfig } from "./config.js";

/**
 * Issue #3243: after a startup `tools/list` failure the session kept a healthy
 * daemon and zero Remnic tools, and the only advertised recovery was a session
 * restart. These regressions pin the recovery path: `/remnic-status` re-lists
 * and registers the catalog, never registers a tool twice, and keeps the
 * `mcpToolsEnabled` / auth gates closed.
 *
 * Upstream contract (`@earendil-works/pi-coding-agent`, npm `latest` 1.5.0;
 * also 0.85.1 installed on the fleet): `dist/core/extensions/loader.js`
 * -> `registerTool()` stores the definition in `extension.tools`, a Map keyed
 * by tool name, and calls `runtime.refreshTools()`. A repeated name therefore
 * REPLACES the definition rather than adding a second tool, but the SDK's own
 * `examples/extensions/dynamic-tools.ts` still guards re-registration with a
 * name set. Remnic keeps its own set so a retry never re-registers a tool
 * that already succeeded.
 */

type RegisteredToolName = string;

/** The subset of Pi's extension context this test drives. */
type PiCommandContext = {
  cwd: string;
  ui: {
    notify: (message: string, level: string) => void;
    setStatus: (key: string, value: string) => void;
  };
  sessionManager: { getSessionId: () => string };
};

type CommandHandler = (args: string, ctx: PiCommandContext) => Promise<void>;

type PiHarness = {
  pi: PiApi;
  /** Every `pi.registerTool` call, in call order, including calls that threw. */
  attempts: RegisteredToolName[];
  /** Every `pi.registerTool` call that returned normally, in call order. */
  registered: RegisteredToolName[];
  commands: Map<string, CommandHandler>;
  run: (name: string, args: string, ctx: PiCommandContext) => Promise<void>;
};

function createHarness(options: { failFirstRegistrationOf?: string } = {}): PiHarness {
  const attempts: RegisteredToolName[] = [];
  const registered: RegisteredToolName[] = [];
  const failed = new Set<string>();
  const commands = new Map<string, CommandHandler>();
  const pi: PiApi = {
    on: () => undefined,
    registerCommand: (name, commandOptions) => {
      commands.set(name, commandOptions.handler);
    },
    registerTool: (tool) => {
      const name = String(tool.name);
      attempts.push(name);
      if (options.failFirstRegistrationOf === name && !failed.has(name)) {
        failed.add(name);
        throw new Error(`simulated pi.registerTool failure for ${name}`);
      }
      registered.push(name);
    },
    appendEntry: () => undefined,
  };
  return {
    pi,
    attempts,
    registered,
    commands,
    run: async (name, args, ctx) => {
      const handler = commands.get(name);
      assert.ok(handler, `missing command ${name}`);
      await handler(args, ctx);
    },
  };
}

type FetchDoubles = {
  /** Number of `tools/list` requests seen by the daemon double. */
  listCalls: () => number;
};

/**
 * Synthetic daemon at the fetch boundary: `/engram/v1/health` and
 * `/engram/v1/live` answer, `/mcp` answers `tools/list` with the catalog when
 * `listingHealthy()` holds and fails with a 503 otherwise.
 */
function installFetch(
  t: TestContext,
  options: {
    catalog: Array<{ name: string; description?: string }>;
    listingHealthy: () => boolean;
  },
): FetchDoubles {
  const originalFetch = globalThis.fetch;
  let listCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/mcp")) {
      const body = parseMcpRequestBody(String(init?.body ?? "{}"));
      if (body.method === "tools/list") {
        listCalls += 1;
        if (!options.listingHealthy()) {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "unavailable" } }),
            { status: 503 },
          );
        }
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: options.catalog } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), { status: 200 });
    }
    if (url.endsWith("/engram/v1/health") || url.endsWith("/engram/v1/live")) {
      return new Response(JSON.stringify({ ok: true, ready: true }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return { listCalls: () => listCalls };
}

/** The JSON-RPC request fields the daemon double reads off the wire. */
type McpRequestBody = { id?: number; method?: string };

/** Parse the JSON-RPC body the client posts, at the fetch boundary. */
function parseMcpRequestBody(body: string): McpRequestBody {
  const parsed: McpRequestBody = JSON.parse(body);
  return parsed;
}

async function runStatus(harness: PiHarness): Promise<Array<{ message: string; level: string }>> {
  const notifications: Array<{ message: string; level: string }> = [];
  await harness.run("remnic-status", "", {
    cwd: "/tmp/remnic-pi",
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      setStatus: () => undefined,
    },
    sessionManager: { getSessionId: () => "pi-mcp-registration" },
  });
  return notifications;
}

function baseConfig(): RemnicPiConfig {
  return {
    remnicDaemonUrl: "http://127.0.0.1:4318",
    recallMode: "auto",
    recallTopK: 8,
    recallBudgetChars: 12000,
    recallEnabled: false,
    observeEnabled: false,
    observeSkipExtraction: false,
    compactionEnabled: false,
    mcpToolsEnabled: true,
    statusEnabled: false,
    requestTimeoutMs: 60000,
    startupRequestTimeoutMs: 2000,
    turnRequestTimeoutMs: 20000,
    observeMaxBytes: 102400,
    observeMaxRetries: 2,
    daemonCooldownMs: 5000,
    recallTimeoutThreshold: 7,
    recallTimeoutWindow: 10,
  };
}

test("/remnic-status registers the MCP tools that the startup listing failed to fetch", async (t) => {
  let listingHealthy = false;
  const { listCalls } = installFetch(t, {
    catalog: [{ name: "remnic_recall" }],
    listingHealthy: () => listingHealthy,
  });
  const harness = createHarness();
  const extension = createRemnicPiExtension({
    config: { ...baseConfig(), authToken: "status-recovery-token" },
  });

  await extension(harness.pi);
  assert.deepEqual(harness.registered, [], "the failing startup listing must leave the session without tools");

  listingHealthy = true;
  const listCallsBeforeStatus = listCalls();
  const notifications = await runStatus(harness);

  assert.deepEqual(
    harness.registered,
    ["remnic_recall"],
    "the status command must register the catalog tools that startup could not list",
  );
  assert.equal(
    new Set(harness.registered).size,
    harness.registered.length,
    "the status retry must not register the same tool twice",
  );
  assert.ok(
    listCalls() > listCallsBeforeStatus,
    "the status command must re-list the catalog after the startup failure",
  );
  assert.ok(notifications.length > 0, "the status command must answer the user");
});

for (const initialNames of [[], ["unrelated_tool"]]) {
  test(`/remnic-status recovers after a catalog with no matching tools: ${JSON.stringify(initialNames)}`, async (t) => {
    const catalog = initialNames.map((name) => ({ name }));
    const { listCalls } = installFetch(t, { catalog, listingHealthy: () => true });
    const harness = createHarness();
    const extension = createRemnicPiExtension({
      config: { ...baseConfig(), authToken: "catalog-recovery-token" },
    });

    await extension(harness.pi);
    assert.deepEqual(harness.registered, []);
    assert.equal(listCalls(), 1);

    catalog.splice(0, catalog.length, { name: "remnic_recall" });
    await runStatus(harness);
    assert.deepEqual(harness.registered, ["remnic_recall"]);
    assert.equal(listCalls(), 2);

    await runStatus(harness);
    assert.deepEqual(harness.registered, ["remnic_recall"]);
    assert.equal(listCalls(), 2, "successful registration must complete recovery");
  });
}

test("the status retry registers only the tool whose registration failed", async (t) => {
  installFetch(t, {
    catalog: [{ name: "remnic_alpha" }, { name: "remnic_beta" }],
    listingHealthy: () => true,
  });
  const harness = createHarness({ failFirstRegistrationOf: "remnic_beta" });
  const extension = createRemnicPiExtension({
    config: { ...baseConfig(), authToken: "partial-registration-token" },
  });

  await assert.doesNotReject(
    () => extension(harness.pi),
    "one failed tool registration must not abort the whole extension load",
  );
  assert.deepEqual(harness.registered, ["remnic_alpha"], "the tool that registered successfully stays registered");

  await runStatus(harness);

  assert.deepEqual(
    [...harness.registered].sort(),
    ["remnic_alpha", "remnic_beta"],
    "the status retry must register the tool that failed and keep the successful one",
  );
  assert.equal(
    harness.attempts.filter((name) => name === "remnic_alpha").length,
    1,
    "a tool that already registered must never be registered again",
  );
});

test("concurrent status retries do not register the same tool twice", async (t) => {
  let listingHealthy = false;
  installFetch(t, {
    catalog: [{ name: "remnic_recall" }],
    listingHealthy: () => listingHealthy,
  });
  const harness = createHarness();
  const extension = createRemnicPiExtension({
    config: { ...baseConfig(), authToken: "concurrent-retry-token" },
  });

  await extension(harness.pi);
  assert.deepEqual(harness.registered, [], "the failing startup listing must leave the session without tools");

  listingHealthy = true;
  const context = {
    cwd: "/tmp/remnic-pi",
    ui: { notify: () => undefined, setStatus: () => undefined },
    sessionManager: { getSessionId: () => "pi-mcp-concurrent" },
  };
  // Both handlers await the daemon before they register, so the two retries
  // overlap in the listing window without any wall-clock wait.
  await Promise.all([
    harness.run("remnic-status", "", context),
    harness.run("remnic-status", "", context),
  ]);

  assert.deepEqual(
    harness.registered,
    ["remnic_recall"],
    "two concurrent status retries must register the tool exactly once",
  );
  assert.equal(
    new Set(harness.attempts).size,
    harness.attempts.length,
    "concurrent status retries must not attempt the same registration twice",
  );
});

test("a status command that runs while the startup registration is still in flight does not double-register", async (t) => {
  // The gate holds every `tools/list` response until the test releases it, so
  // the startup registration and the status command are in the listing window
  // at the same time. No wall-clock wait is involved.
  const gate = Promise.withResolvers<void>();
  const originalFetch = globalThis.fetch;
  let listCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/mcp")) {
      const body = parseMcpRequestBody(String(init?.body ?? "{}"));
      if (body.method === "tools/list") {
        listCalls += 1;
        await gate.promise;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { tools: [{ name: "remnic_recall" }] },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), { status: 200 });
    }
    if (url.endsWith("/engram/v1/health") || url.endsWith("/engram/v1/live")) {
      return new Response(JSON.stringify({ ok: true, ready: true }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const harness = createHarness();
  const extension = createRemnicPiExtension({
    config: { ...baseConfig(), authToken: "load-status-race-token" },
  });

  const loadPromise = extension(harness.pi);
  const context = {
    cwd: "/tmp/remnic-pi",
    ui: { notify: () => undefined, setStatus: () => undefined },
    sessionManager: { getSessionId: () => "pi-mcp-load-status-race" },
  };
  // The command is registered synchronously by the extension factory, so the
  // status handler can run while the startup listing is still pending.
  const statusPromise = harness.run("remnic-status", "", context);
  gate.resolve();
  await Promise.all([loadPromise, statusPromise]);

  assert.ok(listCalls >= 1, "the catalog must have been listed");
  assert.deepEqual(
    harness.registered,
    ["remnic_recall"],
    "the startup registration and the concurrent status command must register the tool once",
  );
  assert.equal(
    new Set(harness.attempts).size,
    harness.attempts.length,
    "a status command racing the startup registration must not attempt the same registration twice",
  );
});

test("a status retry after a successful startup registration does not register the tools again", async (t) => {
  installFetch(t, {
    catalog: [{ name: "remnic_recall" }],
    listingHealthy: () => true,
  });
  const harness = createHarness();
  const extension = createRemnicPiExtension({
    config: { ...baseConfig(), authToken: "already-registered-token" },
  });

  await extension(harness.pi);
  assert.deepEqual(harness.registered, ["remnic_recall"], "startup registers the catalog tools");

  await runStatus(harness);

  assert.deepEqual(harness.registered, ["remnic_recall"], "the tools stay registered exactly once");
  assert.equal(
    harness.attempts.filter((name) => name === "remnic_recall").length,
    1,
    "a status command must not re-register a tool that is already registered",
  );
});

test("the status retry keeps the disabled MCP tools gate closed", async (t) => {
  const { listCalls } = installFetch(t, {
    catalog: [{ name: "remnic_recall" }],
    listingHealthy: () => true,
  });
  const harness = createHarness();
  const extension = createRemnicPiExtension({
    config: { ...baseConfig(), authToken: "disabled-gate-token", mcpToolsEnabled: false },
  });

  await extension(harness.pi);
  await runStatus(harness);

  assert.deepEqual(harness.registered, [], "a disabled MCP tools config must not register tools");
  assert.equal(listCalls(), 0, "a disabled MCP tools config must not even list the catalog");
});

test("the status retry keeps the missing auth token gate closed", async (t) => {
  const { listCalls } = installFetch(t, {
    catalog: [{ name: "remnic_recall" }],
    listingHealthy: () => true,
  });
  const harness = createHarness();
  // baseConfig() carries no auth token: the extension must stay out of the
  // MCP tools path entirely.
  const extension = createRemnicPiExtension({ config: baseConfig() });

  await extension(harness.pi);
  await runStatus(harness);

  assert.deepEqual(harness.registered, [], "a missing auth token must not register tools");
  assert.equal(listCalls(), 0, "a missing auth token must not even list the catalog");
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { QmdDaemonSession } from "./qmd-daemon-session.js";
import { QmdClient } from "./qmd.js";
import { resolveQmdCapabilities } from "./qmd-preflight.js";
import type { CommandChildProcess } from "./runtime/child-process.js";

type Reply = (payload: unknown) => void;
type FakeConfig = { tools?: unknown; listError?: boolean; listReplyDelayMs?: number; holdCall?: boolean; timeoutFirstList?: boolean; listAttempts?: { count: number }; listResponses?: { count: number } };

function parseMessage(line: string): { id?: number; method?: string } {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const message: { id?: unknown; method?: unknown } = value;
  return {
    id: typeof message.id === "number" ? message.id : undefined,
    method: typeof message.method === "string" ? message.method : undefined,
  };
}

function readRequestId(line: string): number | undefined {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || !("params" in value)) return undefined;
  const params: unknown = value.params;
  if (!params || typeof params !== "object" || !("requestId" in params)) return undefined;
  const requestId: unknown = params.requestId;
  return typeof requestId === "number" ? requestId : undefined;
}

function readToolArguments(line: string): Record<string, unknown> | undefined {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || !("params" in value)) return undefined;
  const params: unknown = value.params;
  if (!params || typeof params !== "object" || !("arguments" in params)) return undefined;
  const args: unknown = params.arguments;
  return args && typeof args === "object" && !Array.isArray(args) ? args : undefined;
}

// Real timer: exercise the session's actual AbortSignal path after stdin delivery.
function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function waitUntil(check: () => boolean, description: string): Promise<void> {
  for (let attempts = 0; attempts < 250; attempts += 1) {
    if (check()) return;
    await delay(10);
  }
  assert.fail(`timed out waiting for ${description}`);
}

function child(config: FakeConfig, lines: string[], onSpawn?: () => void): CommandChildProcess {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const process = new EventEmitter() as EventEmitter & {
    killed: boolean;
    pid: number;
    stdin: { destroyed: boolean; write: (chunk: string, cb?: (err?: Error | null) => void) => boolean; on: (...args: unknown[]) => unknown };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (signal?: string) => boolean;
  };
  const reply: Reply = (payload) => stdout.emit("data", Buffer.from(`${JSON.stringify(payload)}\n`));
  process.killed = false;
  process.pid = 4242;
  process.stdout = stdout;
  process.stderr = stderr;
  process.stdin = {
    destroyed: false,
    on() { return process.stdin; },
    write(chunk, cb) {
      queueMicrotask(() => {
        for (const line of String(chunk).split("\n")) {
          if (!line.trim()) continue;
          lines.push(line);
          const message = parseMessage(line);
          if (message.method === "initialize" && message.id !== undefined) {
            reply({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "qmd", version: "2.5.3" } } });
          } else if (message.method === "tools/list" && message.id !== undefined) {
            const attempts = config.listAttempts ?? (config.listAttempts = { count: 0 });
            attempts.count += 1;
            if (config.timeoutFirstList && attempts.count === 1) continue;
            const responses = config.listResponses ?? (config.listResponses = { count: 0 });
            if (config.listError) {
              reply({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "list failed" } });
              responses.count += 1;
            } else if (config.tools !== undefined) {
              const respond = () => {
                reply({ jsonrpc: "2.0", id: message.id, result: config.tools });
                responses.count += 1;
              };
              if (config.listReplyDelayMs) setTimeout(respond, config.listReplyDelayMs);
              else respond();
            }
          } else if (message.method === "tools/call" && message.id !== undefined && !config.holdCall) {
            reply({ jsonrpc: "2.0", id: message.id, result: { structuredContent: { results: [] } } });
          }
        }
      });
      cb?.(null);
      return true;
    },
  };
  process.kill = () => { process.killed = true; process.emit("close", 0); return true; };
  onSpawn?.();
  return process as unknown as CommandChildProcess;
}

const schema = {
  tools: [{
    name: "query",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        additionalSearches: {
          type: "array",
          items: {
            type: "object",
            properties: { type: { type: "string", enum: ["lex", "vec", "hyde"] }, query: { type: "string", maxLength: 8192 } },
          },
        },
      },
    },
  }],
};

function started(config: FakeConfig, lines: string[], spawned?: { count: number }) {
  const session = new QmdDaemonSession("qmd", {}, undefined, () => child(config, lines, () => { if (spawned) spawned.count += 1; }));
  return session.start().then((ok) => {
    assert.equal(ok, true);
    return session;
  });
}

test("tools/list inputSchema enables advertised additionalSearches", async () => {
  const lines: string[] = [];
  const session = await started({ tools: schema }, lines);
  try {
    await waitUntil(() => session.supportsAdditionalSearches(), "advertised additionalSearches capability");
    assert.ok(lines.some((line) => parseMessage(line).method === "tools/list"));
  } finally { await session.close(); }
});

test("old and malformed tools/list schemas do not enable the capability", async () => {
  const malformed: unknown[] = [
    {}, { tools: "bad" }, { tools: [{ name: "query" }] },
    { tools: [{ name: "query", inputSchema: "bad" }] },
    { tools: [{ name: "query", inputSchema: { type: "object", properties: "bad" } }] },
    { tools: [{ name: "query", inputSchema: { type: "object", properties: { additionalSearches: "bad" } } }] },
    { tools: [{ name: "query", inputSchema: { ...schema.tools[0]?.inputSchema, properties: { query: { type: "string" }, additionalSearches: { type: "array", items: { type: "string" } } } } }] },
    { tools: [{ name: "query", inputSchema: { ...schema.tools[0]?.inputSchema, properties: { query: { type: "string" }, additionalSearches: { type: "array", items: { type: "object", properties: { type: { type: "string", enum: ["lex"] }, query: { type: "string" } } } } } } }] },
    { tools: [{ name: "other", inputSchema: schema }] },
  ];
  const old = { tools: [{ name: "query", inputSchema: { type: "object", properties: { searches: { type: "array" } } } }] };
  for (const tools of [old, ...malformed]) {
    const config: FakeConfig = { tools, listResponses: { count: 0 } };
    const session = await started(config, []);
    try {
      await waitUntil(() => config.listResponses?.count === 1, "tools/list response");
      if (tools === old) {
        await delay(2_100);
        session.probeAdditionalSearchesIfDue();
        assert.equal(config.listAttempts?.count, 1, "a valid old schema is definitive and must not reprobe");
      }
      assert.equal(session.supportsAdditionalSearches(), false);
    } finally { await session.close(); }
  }
});

test("a malformed tools/list schema is retried on natural search and can recover", async () => {
  const lines: string[] = [];
  const config: FakeConfig = {
    tools: { tools: [{ name: "query", inputSchema: { type: "object", properties: "malformed" } }] },
    listAttempts: { count: 0 },
    listResponses: { count: 0 },
  };
  const session = await started(config, lines);
  const client = new QmdClient("memories", 5);
  const internals = client as unknown as {
    available: boolean;
    daemonAvailable: boolean;
    daemonSession: QmdDaemonSession;
    qmdCapabilities: ReturnType<typeof resolveQmdCapabilities>;
    searchViaDaemon: (query: string, collection: string, max: number) => Promise<unknown>;
  };
  internals.available = true;
  internals.daemonAvailable = true;
  internals.daemonSession = session;
  internals.qmdCapabilities = resolveQmdCapabilities("qmd 2.5.3");
  try {
    await waitUntil(() => config.listResponses?.count === 1, "malformed tools/list response");
    assert.equal(session.supportsAdditionalSearches(), false);
    await delay(2_100);
    config.tools = schema;
    config.listReplyDelayMs = 100;
    await internals.searchViaDaemon("malformed-schema-recovery", "memories", 5);
    const legacyArgs = lines.map(readToolArguments).find((args) => args?.searches && Array.isArray(args.searches));
    assert.ok(legacyArgs, "search uses the legacy request while reprobe is pending");
    await waitUntil(() => session.supportsAdditionalSearches(), "capability after malformed-schema recovery");
    await internals.searchViaDaemon("malformed-schema-recovery-next", "memories", 5);
    const fusedArgs = lines.map(readToolArguments).find((args) => args?.query === "malformed-schema-recovery-next");
    assert.ok(fusedArgs, "later search uses the advertised query form");
    assert.ok(Array.isArray(fusedArgs.additionalSearches));
    assert.equal(config.listAttempts?.count, 2);
  } finally { await session.close(); }
});

test("tools/list errors and timeouts preserve the session's legacy usability", async () => {
  for (const config of [{ listError: true }, {}] as FakeConfig[]) {
    config.listAttempts = { count: 0 };
    config.listResponses = { count: 0 };
    const lines: string[] = [];
    const session = await started(config, lines);
    try {
      await waitUntil(() => config.listAttempts?.count === 1, "tools/list request");
      assert.equal(session.supportsAdditionalSearches(), false);
      if (config.listError) await waitUntil(() => config.listResponses?.count === 1, "tools/list error response");
      await session.callTool("query", { searches: [] }, 5_000);
      assert.ok(lines.some((line) => parseMessage(line).method === "tools/call"));
    } finally { await session.close(); }
  }
});

test("a transient tools/list timeout retries later and enables advertised support", async () => {
  const lines: string[] = [];
  const config: FakeConfig = { tools: schema, timeoutFirstList: true, listAttempts: { count: 0 } };
  const session = await started(config, lines);
  try {
    await waitUntil(() => config.listAttempts?.count === 1, "initial tools/list attempt");
    await Promise.all([session.start(), session.start(), session.start()]);
    await waitUntil(() => session.supportsAdditionalSearches(), "capability after timeout retry");
    assert.equal(config.listAttempts?.count, 2, "concurrent starters must share the single retry");
  } finally { await session.close(); }
});

test("natural searches reprobe after a prolonged tools/list outage without delaying queries", async () => {
  const lines: string[] = [];
  const config: FakeConfig = { tools: schema, listError: true, listAttempts: { count: 0 }, listResponses: { count: 0 } };
  const session = await started(config, lines);
  const client = new QmdClient("memories", 5);
  const internals = client as unknown as {
    available: boolean;
    daemonAvailable: boolean;
    daemonSession: QmdDaemonSession;
    qmdCapabilities: ReturnType<typeof resolveQmdCapabilities>;
    searchViaDaemon: (query: string, collection: string, max: number) => Promise<unknown>;
  };
  internals.available = true;
  internals.daemonAvailable = true;
  internals.daemonSession = session;
  internals.qmdCapabilities = resolveQmdCapabilities("qmd 2.5.3");
  try {
    await waitUntil(() => config.listResponses?.count === 1, "initial tools/list failure");
    await delay(3_500);
    config.listError = false;
    config.listReplyDelayMs = 100;
    const attemptsBeforeNaturalSearch = config.listAttempts?.count;
    const firstStartedAt = Date.now();
    await Promise.all([
      internals.searchViaDaemon("reprobe-after-long-outage", "memories", 5),
      internals.searchViaDaemon("reprobe-after-long-outage-concurrent", "memories", 5),
    ]);
    assert.ok(Date.now() - firstStartedAt < 500, "the natural searches must not wait for tools/list");
    assert.equal(config.listAttempts?.count, (attemptsBeforeNaturalSearch ?? 0) + 1, "concurrent natural activity should start one bounded-rate reprobe");
    const firstArgs = lines.map(readToolArguments).find((args) => args?.searches && Array.isArray(args.searches));
    assert.ok(firstArgs, "the searches must retain the old structured request during discovery");
    await waitUntil(() => session.supportsAdditionalSearches(), "recovered capability discovery");
    await internals.searchViaDaemon("reprobe-after-long-outage-next", "memories", 5);
    const nextArgs = lines.map(readToolArguments).find((args) => args?.query === "reprobe-after-long-outage-next");
    assert.ok(nextArgs, "the next search should use the advertised query form");
    assert.ok(Array.isArray(nextArgs.additionalSearches));
    assert.equal("searches" in nextArgs, false);
  } finally { await session.close(); }
});

test("shutdown cancels a scheduled capability retry", async () => {
  const lines: string[] = [];
  const config: FakeConfig = { tools: schema, timeoutFirstList: true, listAttempts: { count: 0 } };
  const session = await started(config, lines);
  await waitUntil(() => config.listAttempts?.count === 1, "initial tools/list attempt");
  await delay(1_100); // Timeout has fired; the retry backoff is still pending.
  assert.equal(config.listAttempts?.count, 1);
  await session.close();
  await delay(300);
  assert.equal(config.listAttempts?.count, 1);
});

test("capability is cleared on restart and rediscovered once for concurrent starters", async () => {
  const lines: string[] = [];
  const spawned = { count: 0 };
  const session = await started({ tools: schema }, lines, spawned);
  await waitUntil(() => session.supportsAdditionalSearches(), "initial capability");
  session.invalidate();
  assert.equal(session.supportsAdditionalSearches(), false);
  assert.deepEqual(await Promise.all([session.start(), session.start()]), [true, true]);
  await waitUntil(() => session.supportsAdditionalSearches(), "capability after restart");
  assert.equal(spawned.count, 2);
  assert.equal(lines.filter((line) => parseMessage(line).method === "tools/list").length, 2);
  await session.close();
  assert.equal(session.supportsAdditionalSearches(), false);
});

test("aborting fused search still cancels the daemon tool call", async () => {
  const lines: string[] = [];
  const session = await started({ tools: schema, holdCall: true }, lines);
  await waitUntil(() => session.supportsAdditionalSearches(), "capability before fused cancellation");
  const client = new QmdClient("memories", 5);
  const internals = client as unknown as { available: boolean; daemonAvailable: boolean; qmdCapabilities: unknown; daemonSession: unknown };
  internals.available = true;
  internals.daemonAvailable = true;
  internals.qmdCapabilities = resolveQmdCapabilities("qmd 2.5.3");
  internals.daemonSession = session;
  const controller = new AbortController();
  const search = client.search("fused cancellation query", "memories", 5, undefined, { signal: controller.signal });
  await delay(20);
  controller.abort();
  await assert.rejects(search, (error: Error) => error.name === "AbortError");
  const call = lines.find((line) => parseMessage(line).method === "tools/call");
  const cancel = lines.find((line) => parseMessage(line).method === "notifications/cancelled");
  assert.ok(call && cancel);
  assert.equal(readRequestId(cancel), parseMessage(call).id);
  const args = readToolArguments(call);
  assert.equal(args?.query, "fused cancellation query");
  assert.equal(args && "searches" in args, false);
  assert.ok(Array.isArray(args?.additionalSearches));
  await session.close();
});

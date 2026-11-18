import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

import { daemonCongestionForTest, QmdClient } from "./qmd.js";
import type { QmdDaemonSession } from "./qmd-daemon-session.js";

/**
 * Regression coverage for the recall stall fixed in #3476: when the shared
 * qmd mcp daemon's embedding backend is contended (e.g., another process
 * saturates the GPU), every hybrid lex+vec+hyde query waits behind it. The
 * client must degrade to a lex-only plan for a bounded window instead of
 * paying full-latency hybrid calls on every recall stage.
 */

interface QmdMcpQueryArgs {
  searches?: Array<{ type: string; query: string }>;
  collections?: string[];
  collection?: string;
  query?: string;
  limit?: number;
  rerank?: boolean;
}

interface McpResultDoc {
  docid?: string;
  file?: string;
  path?: string;
  snippet?: string;
  score?: number;
}

interface McpToolResult {
  structuredContent?: { results?: McpResultDoc[] };
}

type CallToolFn = (
  name: string,
  args: QmdMcpQueryArgs,
  timeoutMs: number,
  signal?: AbortSignal
) => Promise<McpToolResult>;

type CongestionInternals = {
  available: boolean;
  daemonAvailable: boolean;
  daemonSlowQueryMs: number;
  daemonCongestionWindowMs: number;
  daemonSession: QmdDaemonSession;
  qmdCapabilities: Record<string, boolean>;
};

interface CapturedCall {
  name: string;
  args: QmdMcpQueryArgs;
}

function mcpOk(docs: Array<{ path: string }>): McpToolResult {
  return {
    structuredContent: {
      results: docs.map((d) => ({ docid: `id-${d.path}`, file: d.path, snippet: "s", score: 1 })),
    },
  };
}

function makeClient(callTool: CallToolFn) {
  const client = new QmdClient("memories", 3, { daemonUrl: "stdio://qmd" });
  // SAFETY: the stub drives private QmdClient fields by name; every member it
  // sets is exercised by the assertions below.
  const internals: CongestionInternals = client as never;
  internals.available = true;
  internals.daemonAvailable = true;
  internals.daemonSlowQueryMs = 50;
  internals.daemonCongestionWindowMs = 10_000;
  internals.qmdCapabilities = {
    v2McpQueryTool: true,
    structuredSearches: true,
    queryRerankToggle: true,
    intentHints: false,
    explainTraces: false,
    candidateLimit: false,
    chunkStrategy: false,
    mcpIndexSelection: false,
  };
  // SAFETY: the fake session stands in for a real QmdDaemonSession; tests
  // only exercise callTool and use the object as a congestion-map key.
  internals.daemonSession = { isActive: () => true, callTool } as never;
  return { client, internals };
}

function legTypes(call: CapturedCall): string[] {
  return call.args.searches?.map((s) => s.type) ?? [];
}

test("slow hybrid daemon query degrades subsequent queries to lex-only for the window", async () => {
  const calls: CapturedCall[] = [];
  const { client } = makeClient(async (name, args) => {
    calls.push({ name, args });
    // First (hybrid) call is slow — marks congestion. Degraded calls are fast.
    if (calls.length === 1) await sleep(80);
    return mcpOk([{ path: `r${calls.length}.md` }]);
  });

  const first = await client.search("alpha", "memories", 3);
  assert.deepEqual(legTypes(calls[0]!), ["lex", "vec", "hyde"]);
  assert.equal(first.length, 1);

  // Different query text avoids the 60s result cache — the second call must
  // reach the daemon but with the degraded lex-only plan.
  const second = await client.search("beta query", "memories", 3);
  assert.equal(second.length, 1);
  assert.deepEqual(legTypes(calls[1]!), ["lex"]);
});

test("daemon query timeout marks congestion without waiting for a slow success", async () => {
  const calls: CapturedCall[] = [];
  const { client, internals } = makeClient(async (name, args) => {
    calls.push({ name, args });
    if (calls.length === 1) throw new Error("QMD mcp tools/call timed out after 60000ms");
    return mcpOk([{ path: "r.md" }]);
  });

  await client.search("gamma", "memories", 3);
  assert.ok(
    daemonCongestionForTest.get(internals.daemonSession) > performance.now() - 1,
    "timeout should open the congestion window"
  );

  await client.search("delta query", "memories", 3);
  assert.deepEqual(legTypes(calls[1]!), ["lex"]);
});

test("congestion window expiry restores the hybrid plan", async () => {
  const calls: CapturedCall[] = [];
  const { client, internals } = makeClient(async (name, args) => {
    calls.push({ name, args });
    return mcpOk([{ path: "r.md" }]);
  });
  daemonCongestionForTest.set(internals.daemonSession, performance.now() - 1); // window already elapsed

  await client.search("epsilon", "memories", 3);
  assert.deepEqual(legTypes(calls[0]!), ["lex", "vec", "hyde"]);
});

test("a congested global search stays global — no collection filter in the degraded call", async () => {
  const calls: CapturedCall[] = [];
  const { client, internals } = makeClient(async (name, args) => {
    calls.push({ name, args });
    return mcpOk([{ path: "r.md" }]);
  });
  daemonCongestionForTest.set(internals.daemonSession, performance.now() + 60_000);

  await client.searchGlobal("wide query", 3);
  assert.deepEqual(legTypes(calls[0]!), ["lex"]);
  assert.equal(calls[0]!.args.collections, undefined);
});

test("degraded results cache under the degraded namespace only", async () => {
  const calls: CapturedCall[] = [];
  const { client, internals } = makeClient(async (name, args) => {
    calls.push({ name, args });
    return mcpOk([{ path: `r${calls.length}.md` }]);
  });
  daemonCongestionForTest.set(internals.daemonSession, performance.now() + 60_000);

  await client.search("shared key", "memories", 3);
  assert.deepEqual(legTypes(calls[0]!), ["lex"]);

  // Same query still congested → degraded-cache hit, no new daemon call.
  await client.search("shared key", "memories", 3);
  assert.equal(calls.length, 1);

  // After expiry the same query must run the hybrid plan — the degraded
  // result must not have been written into the std namespace.
  daemonCongestionForTest.set(internals.daemonSession, performance.now() - 1);
  await client.search("shared key", "memories", 3);
  assert.equal(calls.length, 2);
  assert.deepEqual(legTypes(calls[1]!), ["lex", "vec", "hyde"]);
});

test("a congestion mark from one client gates siblings sharing the daemon session", async () => {
  const calls: CapturedCall[] = [];
  const sessionCallTool: CallToolFn = async (name, args) => {
    calls.push({ name, args });
    if (calls.length === 1) await sleep(80); // slow query → marks congestion
    return mcpOk([{ path: `r${calls.length}.md` }]);
  };
  const a = makeClient(sessionCallTool);
  const b = makeClient(sessionCallTool);
  // Registry semantics: both clients retain the same shared session object.
  b.internals.daemonSession = a.internals.daemonSession;

  await a.client.search("slow seed", "memories", 3);
  await b.client.search("sibling query", "memories", 3);
  assert.equal(calls[1]!.args.searches?.[0]?.query, "sibling query");
  assert.deepEqual(legTypes(calls[1]!), ["lex"]);
});

test("a daemon call cancelled after the slow mark still opens the window", async () => {
  const calls: CapturedCall[] = [];
  const { client, internals } = makeClient((name, args, _timeout, signal) => {
    calls.push({ name, args });
    if (calls.length > 1) return Promise.resolve(mcpOk([{ path: "r.md" }]));
    return new Promise<McpToolResult>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  });

  const ac = new AbortController();
  const pending = client.search("leg deadline", "memories", 3, undefined, { signal: ac.signal });
  await sleep(80); // past the 50ms slow mark — a namespace leg deadline lands here
  ac.abort();
  await assert.rejects(pending, (err: Error) => err.name === "AbortError");
  assert.ok(daemonCongestionForTest.get(internals.daemonSession) > performance.now() - 1);

  await client.search("next query", "memories", 3);
  assert.deepEqual(legTypes(calls[1]!), ["lex"]);
});

test("vector search serves the lex leg while the congestion window is open", async () => {
  const calls: CapturedCall[] = [];
  const { client, internals } = makeClient(async (name, args) => {
    calls.push({ name, args });
    return mcpOk([{ path: "v.md" }]);
  });
  daemonCongestionForTest.set(internals.daemonSession, performance.now() + 60_000);

  await client.vectorSearch("vec query", "memories", 3);
  assert.deepEqual(legTypes(calls[0]!), ["lex"]);
  assert.deepEqual(calls[0]!.args.collections, ["memories"]);
});

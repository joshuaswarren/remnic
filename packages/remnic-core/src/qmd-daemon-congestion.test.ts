import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

import { QmdClient } from "./qmd.js";

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
  daemonCongestedUntilMs: number;
  daemonSlowQueryMs: number;
  daemonCongestionWindowMs: number;
  daemonSession: { isActive: () => boolean; callTool: CallToolFn } | null;
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
  internals.daemonSession = { isActive: () => true, callTool };
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
  assert.ok(internals.daemonCongestedUntilMs > Date.now() - 1, "timeout should open the congestion window");

  await client.search("delta query", "memories", 3);
  assert.deepEqual(legTypes(calls[1]!), ["lex"]);
});

test("congestion window expiry restores the hybrid plan", async () => {
  const calls: CapturedCall[] = [];
  const { client, internals } = makeClient(async (name, args) => {
    calls.push({ name, args });
    return mcpOk([{ path: "r.md" }]);
  });
  internals.daemonCongestedUntilMs = Date.now() - 1; // window already elapsed

  await client.search("epsilon", "memories", 3);
  assert.deepEqual(legTypes(calls[0]!), ["lex", "vec", "hyde"]);
});

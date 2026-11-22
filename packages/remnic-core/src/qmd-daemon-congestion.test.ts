import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

import { daemonCongestionForTest, QmdClient } from "./qmd.js";
import type { QmdDaemonSession } from "./qmd-daemon-session.js";


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
  // SAFETY: the stub drives private QmdClient fields by name; every member it
  // sets is exercised by the assertions below.
  const client = new QmdClient("memories", 3, { daemonUrl: "stdio://qmd" });
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
  // SAFETY: the fake session stands in for a real QmdDaemonSession; tests
  // only exercise callTool and use the object as a congestion-map key.
  };
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
    if (calls.length === 1) await sleep(80);
    return mcpOk([{ path: `r${calls.length}.md` }]);
  });

  const first = await client.search("alpha", "memories", 3);
  assert.deepEqual(legTypes(calls[0]!), ["lex", "vec", "hyde"]);
  assert.equal(first.length, 1);

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
  assert.equal(calls[1]!.args.rerank, false); // lex plan never pays the rerank leg
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

  await client.search("shared key", "memories", 3);
  assert.equal(calls.length, 1);

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
  b.internals.daemonSession = a.internals.daemonSession;

  await a.client.search("slow seed", "memories", 3);
  await b.client.search("sibling query", "memories", 3);
  assert.equal(calls[1]!.args.searches?.[0]?.query, "sibling query");
  assert.deepEqual(legTypes(calls[1]!), ["lex"]);
});

test("an already slow in-flight hybrid query degrades a sibling on the same daemon (#3499)", async (t) => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const calls: CapturedCall[] = [];
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const sessionCallTool: CallToolFn = async (name, args) => {
    calls.push({ name, args });
    if (calls.length === 1) {
      started.resolve();
      await release.promise;
    }
    return mcpOk([{ path: "result.md" }]);
  };
  const first = makeClient(sessionCallTool);
  const sibling = makeClient(sessionCallTool);
  sibling.internals.daemonSession = first.internals.daemonSession;

  const pending = first.client.search("first recall", "memories", 3);
  try {
    await started.promise;
    assert.deepEqual(legTypes(calls[0]!), ["lex", "vec", "hyde"]);
    now += first.internals.daemonSlowQueryMs;
    const results = await sibling.client.search("second recall", "memories", 3);
    assert.equal(results.length, 1);
    assert.deepEqual(calls[1]!.args.collections, ["memories"]);
    assert.deepEqual(legTypes(calls[1]!), ["lex"]);
    assert.equal(calls[1]!.args.rerank, false);
  } finally {
    release.resolve();
    await pending;
  }
});

test("a repeat of a slow query takes a lexical plan without waiting for the original", async (t) => {
  let now = 1_000;
  t.mock.method(performance, "now", () => now);
  const calls: CapturedCall[] = [];
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { client, internals } = makeClient(async (name, args) => {
    calls.push({ name, args });
    if (calls.length === 1) {
      started.resolve();
      await release.promise;
      return mcpOk([{ path: "hybrid.md" }]);
    }
    return mcpOk([{ path: "lexical.md" }]);
  });

  const original = client.search("repeat during a slow query", "memories", 3);
  await started.promise;
  now += internals.daemonSlowQueryMs;
  const repeat = client.search("repeat during a slow query", "memories", 3);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2, "the repeat must not join the slow hybrid call");
    assert.deepEqual(legTypes(calls[1]!), ["lex"]);
    assert.equal((await repeat)[0]?.path, "lexical.md");
  } finally {
    release.resolve();
    await Promise.all([original, repeat]);
  }
  now += internals.daemonCongestionWindowMs + 1;
  assert.equal((await client.search("repeat during a slow query", "memories", 3))[0]?.path, "hybrid.md");
  assert.equal(calls.length, 2);
});

for (const [leg, rerank, gatesSibling] of [
  ["lex", false, false],
  ["lex", undefined, true],
  ["vec", false, true],
] as const) {
  test(`slow in-flight ${leg} (rerank=${rerank ?? "default"}) gates hybrid: ${gatesSibling}`, async (t) => {
    let now = 1000;
    t.mock.method(performance, "now", () => now);
    const calls: CapturedCall[] = [];
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { client, internals } = makeClient(async (name, args) => {
      calls.push({ name, args });
      if (calls.length === 1) {
        started.resolve();
        await release.promise;
      }
      return mcpOk([{ path: "result.md" }]);
    });

    const query = `slow ${leg} recall (rerank=${rerank ?? "default"})`;
    const options: Parameters<typeof client.search>[3] = {
      structuredSearches: [{ type: leg, query }],
    };
    if (rerank === false) {
      options.rerank = false;
    }
    const pending = client.search(query, "memories", 3, options);
    try {
      await started.promise;
      assert.deepEqual(legTypes(calls[0]!), [leg]);
      assert.equal(calls[0]!.args.rerank, rerank);
      now += internals.daemonSlowQueryMs;
      const results = await client.search(`hybrid sibling of ${query}`, "memories", 3);
      assert.equal(results[0]?.path, "result.md");
      assert.deepEqual(legTypes(calls[1]!), gatesSibling ? ["lex"] : ["lex", "vec", "hyde"]);
    } finally {
      release.resolve();
      await pending;
    }
  });
}

test("a fresh in-flight call does not gate siblings yet (#3499)", async (t) => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const calls: CapturedCall[] = [];
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const sessionCallTool: CallToolFn = async (name, args) => {
    calls.push({ name, args });
    if (calls.length === 1) {
      started.resolve();
      await release.promise;
    }
    return mcpOk([{ path: "r.md" }]);
  };
  const first = makeClient(sessionCallTool);
  const sibling = makeClient(sessionCallTool);
  sibling.internals.daemonSession = first.internals.daemonSession;

  const pending = first.client.search("first young recall", "memories", 3);
  try {
    await started.promise;
    now += first.internals.daemonSlowQueryMs - 1;
    const results = await sibling.client.search("second young recall", "memories", 3);
    assert.deepEqual(legTypes(calls[1]!), ["lex", "vec", "hyde"]);
    assert.equal(results.length, 1);
  } finally {
    release.resolve();
    await pending;
  }
});

test("a slow success clears the marker; hybrid returns only after the window also clears (#3499)", async (t) => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const calls: CapturedCall[] = [];
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const sessionCallTool: CallToolFn = async (name, args) => {
    calls.push({ name, args });
    if (calls.length === 1) {
      started.resolve();
      await release.promise;
    }
    return mcpOk([{ path: "r.md" }]);
  };
  const first = makeClient(sessionCallTool);
  const sibling = makeClient(sessionCallTool);
  sibling.internals.daemonSession = first.internals.daemonSession;

  const pending = first.client.search("first success recall", "memories", 3);
  await started.promise;
  now += first.internals.daemonSlowQueryMs + 1;
  release.resolve();
  await pending; // a slow success still opens the congestion window (#3476)
  assert.equal(
    daemonCongestionForTest.inflightCalls(first.internals.daemonSession),
    0,
    "the marker is removed on success",
  );
  assert.ok(
    daemonCongestionForTest.get(first.internals.daemonSession) > now,
    "the slow success opened the congestion window",
  );
  now += first.internals.daemonCongestionWindowMs + 1;
  const results = await sibling.client.search("second success recall", "memories", 3);
  assert.deepEqual(legTypes(calls[1]!), ["lex", "vec", "hyde"]);
  assert.equal(results.length, 1);
});

test("a failed slow call clears the marker and opens no window (#3499)", async (t) => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const calls: CapturedCall[] = [];
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const sessionCallTool: CallToolFn = async (name, args) => {
    calls.push({ name, args });
    if (calls.length === 1) {
      started.resolve();
      await release.promise;
      throw new Error("fetch failed");
    }
    return mcpOk([{ path: "r.md" }]);
  };
  const first = makeClient(sessionCallTool);
  const sibling = makeClient(sessionCallTool);
  sibling.internals.daemonSession = first.internals.daemonSession;

  const pending = first.client.search("first failure recall", "memories", 3);
  await started.promise;
  now += first.internals.daemonSlowQueryMs + 1;
  release.resolve();
  const results = await pending; // transient failure degrades to [] without a window
  assert.deepEqual(results, []);
  assert.equal(
    daemonCongestionForTest.inflightCalls(first.internals.daemonSession),
    0,
    "the marker is removed on failure",
  );
  assert.equal(
    daemonCongestionForTest.get(first.internals.daemonSession),
    0,
    "a transient failure opens no congestion window",
  );
  await sibling.client.search("second failure recall", "memories", 3);
  assert.deepEqual(legTypes(calls[1]!), ["lex", "vec", "hyde"]);
});

test("a cancelled slow call clears the marker; the existing slow-cancel window still applies (#3499)", async (t) => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const calls: CapturedCall[] = [];
  const started = Promise.withResolvers<void>();
  const sessionCallTool: CallToolFn = async (name, args, _timeout, signal) => {
    calls.push({ name, args });
    if (calls.length === 1) {
      started.resolve();
      return new Promise<McpToolResult>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return mcpOk([{ path: "r.md" }]);
  };
  const first = makeClient(sessionCallTool);
  const sibling = makeClient(sessionCallTool);
  sibling.internals.daemonSession = first.internals.daemonSession;
  const ac = new AbortController();

  const pending = first.client.search("first cancel recall", "memories", 3, undefined, { signal: ac.signal });
  await started.promise;
  now += first.internals.daemonSlowQueryMs + 1;
  ac.abort();
  await assert.rejects(pending, /aborted/);
  assert.equal(
    daemonCongestionForTest.inflightCalls(first.internals.daemonSession),
    0,
    "the marker is removed on cancellation",
  );
  assert.ok(
    daemonCongestionForTest.get(first.internals.daemonSession) > now,
    "a cancellation after the slow mark keeps the existing window",
  );
  await sibling.client.search("second cancel recall", "memories", 3);
  assert.deepEqual(legTypes(calls[1]!), ["lex"]);
  now += first.internals.daemonCongestionWindowMs + 1;
  await sibling.client.search("third cancel recall", "memories", 3);
  assert.deepEqual(legTypes(calls[2]!), ["lex", "vec", "hyde"]);
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
  assert.equal(calls[0]!.args.rerank, false); // no options passed — still no rerank
});

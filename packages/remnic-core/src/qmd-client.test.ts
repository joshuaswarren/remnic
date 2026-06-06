import assert from "node:assert/strict";
import test from "node:test";

import { QmdClient } from "./qmd.js";
import type { QmdSearchResult } from "./types.js";

test("QmdClient rechecks daemon availability before returning unavailable", async () => {
  const client = new QmdClient("memories", 3, {
    daemonUrl: "stdio://qmd",
    daemonRecheckIntervalMs: 0,
  });
  const internals = client as unknown as {
    available: boolean;
    daemonAvailable: boolean;
    probeDaemon: () => Promise<boolean>;
    searchViaDaemon: (
      query: string,
      collection: string | undefined,
      maxResults: number,
    ) => Promise<QmdSearchResult[]>;
  };
  let probeCount = 0;
  internals.available = false;
  internals.daemonAvailable = false;
  internals.probeDaemon = async () => {
    probeCount += 1;
    internals.daemonAvailable = true;
    return true;
  };
  internals.searchViaDaemon = async (query, collection, maxResults) => [
    {
      docid: `${collection}:${maxResults}`,
      path: "memory.md",
      snippet: query,
      score: 1,
      transport: "daemon",
    },
  ];

  const results = await client.search("slow startup", "memories", 3);

  assert.equal(probeCount, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.transport, "daemon");
});

type SubprocessInternals = {
  available: boolean;
  runQmdCommand: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  searchViaSubprocess: (
    query: string,
    collection: string,
    maxResults: number,
  ) => Promise<QmdSearchResult[]>;
  searchGlobalViaSubprocess: (query: string, maxResults: number) => Promise<QmdSearchResult[]>;
};

function captureSubprocessArgs(client: QmdClient): string[][] {
  const calls: string[][] = [];
  const internals = client as unknown as SubprocessInternals;
  internals.available = true;
  internals.runQmdCommand = async (args: string[]) => {
    calls.push(args);
    return { stdout: "[]", stderr: "" };
  };
  return calls;
}

test("subprocess fallback defaults to `qmd query` for scoped and global recall", async () => {
  const client = new QmdClient("memories", 3, {});
  const calls = captureSubprocessArgs(client);
  const internals = client as unknown as SubprocessInternals;

  await internals.searchViaSubprocess("hermes deployment", "memories", 3);
  await internals.searchGlobalViaSubprocess("hermes deployment", 3);

  assert.equal(calls[0]?.[0], "query", "scoped fallback must default to `qmd query`");
  assert.equal(calls[1]?.[0], "query", "global fallback must default to `qmd query`");
});

test("qmdSubprocessStrategy 'search' applies BM25 to scoped AND global recall (gotcha #39)", async () => {
  // Cursor #1422 review: the gate must be uniform across every subprocess path,
  // not just the scoped one.
  const client = new QmdClient("memories", 3, { qmdSubprocessStrategy: "search" });
  const calls = captureSubprocessArgs(client);
  const internals = client as unknown as SubprocessInternals;

  await internals.searchViaSubprocess("hermes deployment", "memories", 3);
  await internals.searchGlobalViaSubprocess("hermes deployment", 3);

  assert.equal(calls[0]?.[0], "search", "scoped fallback must honor BM25 opt-in");
  assert.equal(calls[1]?.[0], "search", "global fallback must honor BM25 opt-in");
  // Global BM25 must NOT pass a collection flag.
  assert.ok(!calls[1]?.includes("-c"), "global BM25 search must not include -c");
});

test("QMD search cache key isolates results by strategy (codex review on #1422)", async () => {
  // Two clients with different strategies must not serve each other's cached
  // results for the same query/collection within the global cache TTL.
  function makeClient(opts: Record<string, unknown>): {
    client: QmdClient;
    calls: string[][];
  } {
    const client = new QmdClient("memories", 3, opts);
    const internals = client as unknown as SubprocessInternals & {
      daemonAvailable: boolean;
    };
    internals.available = true;
    internals.daemonAvailable = false;
    const calls: string[][] = [];
    internals.runQmdCommand = async (args: string[]) => {
      calls.push(args);
      return { stdout: "[]", stderr: "" };
    };
    return { client, calls };
  }

  // Unique query avoids colliding with cache entries from other tests.
  const query = "strategy-cache-isolation-probe-xyz";
  const a = makeClient({ qmdSearchStrategy: "hybrid" });
  const b = makeClient({ qmdSearchStrategy: "lex" });

  await a.client.search(query, "memories", 3);
  await b.client.search(query, "memories", 3);

  // If the cache key ignored strategy, b would hit a's cached entry and never
  // invoke the subprocess. Both must register their own subprocess call.
  assert.equal(a.calls.length, 1, "first strategy populates its own cache entry");
  assert.equal(b.calls.length, 1, "second strategy must NOT reuse the first's cached result");
});

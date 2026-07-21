import assert from "node:assert/strict";
import test from "node:test";

import { QmdClient, parseQmdStatusOutput } from "./qmd.js";
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
  runQmdCommand: (
    args: string[],
    timeoutMs?: number,
    signal?: AbortSignal,
  ) => Promise<{ stdout: string; stderr: string }>;
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

test("updateStrict respects QMD update min-interval throttles", async () => {
  const client = new QmdClient("memories", 3, { updateMinIntervalMs: 60_000 });
  client.resetUpdateThrottles();
  const calls = captureSubprocessArgs(client);

  try {
    await client.updateStrict();
    await assert.rejects(
      () => client.updateStrict(),
      /QMD update skipped by min-interval gate|QMD update skipped by global min-interval gate/,
    );
  } finally {
    client.resetUpdateThrottles();
  }

  assert.equal(calls.length, 1);
});

test("embedCollectionStrict rejects QMD embed subprocess failures", async () => {
  const client = new QmdClient("memories", 3, { updateMinIntervalMs: 60_000 });
  client.resetUpdateThrottles();
  const internals = client as unknown as SubprocessInternals;
  const calls: string[][] = [];
  internals.available = true;
  internals.runQmdCommand = async (args: string[]) => {
    calls.push(args);
    throw new Error("embed subprocess failed");
  };

  try {
    await assert.rejects(
      () => client.embedCollectionStrict("memories--project"),
      /embed subprocess failed/,
    );
  } finally {
    client.resetUpdateThrottles();
  }

  assert.deepEqual(calls, [["embed", "-c", "memories--project"]]);
});

test("embedCollectionStrict respects QMD embed min-interval throttles", async () => {
  const client = new QmdClient("memories", 3, { updateMinIntervalMs: 60_000 });
  client.resetUpdateThrottles();
  const calls = captureSubprocessArgs(client);

  try {
    await client.embedCollectionStrict("memories--project");
    await assert.rejects(
      () => client.embedCollectionStrict("memories--project"),
      /QMD embed skipped by per-collection min-interval gate/,
    );
  } finally {
    client.resetUpdateThrottles();
  }

  assert.equal(calls.length, 1);
});

test("ensureCollection treats cancelled auto-create as unknown", async () => {
  const client = new QmdClient("memories", 3, {});
  const internals = client as unknown as SubprocessInternals & {
    daemonAvailable: boolean;
  };
  const controller = new AbortController();
  const calls: string[][] = [];

  internals.available = true;
  internals.daemonAvailable = false;
  internals.runQmdCommand = async (args, _timeoutMs, signal) => {
    calls.push(args);
    if (args[0] === "collection" && args[1] === "list") {
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "collection" && args[1] === "add") {
      assert.equal(signal, controller.signal);
      controller.abort();
      throw new Error("startup timeout aborted collection add");
    }
    throw new Error(`unexpected qmd command: ${args.join(" ")}`);
  };

  const result = await client.ensureCollection("/tmp/remnic-memory", "memories", {
    signal: controller.signal,
  });

  assert.equal(result, "unknown");
  assert.deepEqual(calls, [
    ["collection", "list"],
    ["collection", "add", "/tmp/remnic-memory", "--name", "memories"],
  ]);
});

test("ensureCollection rechecks collection state after auto-create failure", async () => {
  const client = new QmdClient("memories", 3, {});
  const internals = client as unknown as SubprocessInternals & {
    daemonAvailable: boolean;
  };
  const calls: string[][] = [];
  let listCount = 0;

  internals.available = true;
  internals.daemonAvailable = false;
  internals.runQmdCommand = async (args) => {
    calls.push(args);
    if (args[0] === "collection" && args[1] === "list") {
      listCount += 1;
      return {
        stdout: listCount === 1 ? "" : "memories (qmd://memories/)",
        stderr: "",
      };
    }
    if (args[0] === "collection" && args[1] === "add") {
      throw new Error("qmd collection add timed out after indexing started");
    }
    throw new Error(`unexpected qmd command: ${args.join(" ")}`);
  };

  const result = await client.ensureCollection("/tmp/remnic-memory", "memories");

  assert.equal(result, "present");
  assert.deepEqual(calls, [
    ["collection", "list"],
    ["collection", "add", "/tmp/remnic-memory", "--name", "memories"],
    ["collection", "list"],
  ]);
});

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

test("parseQmdStatusOutput parses full status output", () => {
  const stdout = [
    "Collection: remnic-memory",
    "Total files: 1200",
    "Embedded: 1150",
    "Pending: 50",
    "Oldest pending: 2h",
  ].join("\n");
  const report = parseQmdStatusOutput(stdout);
  assert.equal(report.totalFiles, 1200);
  assert.equal(report.embeddedFiles, 1150);
  assert.equal(report.pendingEmbeddings, 50);
  assert.equal(report.oldestPendingAgeMs, 2 * 60 * 60 * 1000);
  assert.equal(report.raw, stdout);
});

test("parseQmdStatusOutput parses documented QMD status format", () => {
  const stdout = [
    "Collection: remnic-memory",
    "Total: 1,200 files indexed",
    "Vectors: 1,150 embedded",
    "Pending: 50",
    "Oldest pending: 2h",
  ].join("\n");
  const report = parseQmdStatusOutput(stdout);
  assert.equal(report.totalFiles, 1200);
  assert.equal(report.embeddedFiles, 1150);
  assert.equal(report.pendingEmbeddings, 50);
  assert.equal(report.oldestPendingAgeMs, 2 * 60 * 60 * 1000);
});

test("parseQmdStatusOutput parses time units correctly", () => {
  assert.equal(parseQmdStatusOutput("Oldest pending: 45s").oldestPendingAgeMs, 45_000);
  assert.equal(parseQmdStatusOutput("Oldest pending: 3m").oldestPendingAgeMs, 180_000);
  assert.equal(parseQmdStatusOutput("Oldest pending: 500ms").oldestPendingAgeMs, 500);
  assert.equal(parseQmdStatusOutput("no age here").oldestPendingAgeMs, null);
});

test("parseQmdStatusOutput returns nulls for unparseable output", () => {
  const report = parseQmdStatusOutput("garbage output");
  assert.equal(report.totalFiles, null);
  assert.equal(report.embeddedFiles, null);
  assert.equal(report.pendingEmbeddings, null);
  assert.equal(report.oldestPendingAgeMs, null);
});

test("QmdClient.status() returns parsed report on success", async () => {
  const client = new QmdClient("test-col", 3);
  const internals = client as unknown as {
    available: boolean;
    runQmdCommand: (args: string[]) => Promise<{ stdout: string; code: number }>;
  };
  internals.available = true;
  let capturedArgs: string[] = [];
  internals.runQmdCommand = async (args: string[]) => {
    capturedArgs = args;
    return { stdout: "Total files: 10\nEmbedded: 8\nPending: 2\nOldest pending: 5m", code: 0 };
  };
  const report = await client.status();
  assert.deepEqual(capturedArgs, ["status", "-c", "test-col"]);
  assert.equal(report.pendingEmbeddings, 2);
  assert.equal(report.oldestPendingAgeMs, 300_000);
});

test("QmdClient.status() returns null fields when unavailable", async () => {
  const client = new QmdClient("test-col", 3);
  const internals = client as unknown as { available: boolean };
  internals.available = false;
  const report = await client.status();
  assert.equal(report.pendingEmbeddings, null);
  assert.equal(report.oldestPendingAgeMs, null);
});

test("QmdClient.embedFiles() runs update then embed", async () => {
  const client = new QmdClient("test-col", 3);
  const internals = client as unknown as {
    available: boolean;
    runQmdCommand: (args: string[]) => Promise<{ stdout: string; code: number }>;
  };
  internals.available = true;
  const allCalls: string[][] = [];
  internals.runQmdCommand = async (args: string[]) => {
    allCalls.push(args);
    return { stdout: "ok", code: 0 };
  };
  const result = await client.embedFiles(["/mem/a.md", "/mem/b.md"]);
  assert.equal(result, true);
  assert.equal(allCalls.length, 2);
  assert.deepEqual(allCalls[0], ["update", "-c", "test-col"]);
  assert.deepEqual(allCalls[1], ["embed", "-c", "test-col"]);
});

test("QmdClient.embedFiles() returns false for empty paths", async () => {
  const client = new QmdClient("test-col", 3);
  const internals = client as unknown as { available: boolean };
  internals.available = true;
  const result = await client.embedFiles([]);
  assert.equal(result, false);
});

test("QmdClient.embedFiles() returns false when unavailable", async () => {
  const client = new QmdClient("test-col", 3);
  const internals = client as unknown as { available: boolean };
  internals.available = false;
  const result = await client.embedFiles(["/mem/a.md"]);
  assert.equal(result, false);
});

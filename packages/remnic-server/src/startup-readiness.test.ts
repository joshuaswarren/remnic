import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";

import { startServer, type ServerResult } from "./index.js";
import { completeStartupReadiness, createStartupSyncEnsurers } from "./startup-readiness.js";


interface RecordedSearch {
  query: string;
  collection: string | undefined;
  maxResults: number | undefined;
}

const searchRequest = z.object({
  query: z.string(),
  collection: z.string().optional(),
  maxResults: z.number().optional(),
});

interface FakeSearchService {
  baseUrl: string;
  searches: RecordedSearch[];
  /** Resolves when the readiness warm-up query is first recorded. */
  firstReadinessSearch: Promise<void>;
  close: () => Promise<void>;
}

async function startFakeSearchService(): Promise<FakeSearchService> {
  const searches: RecordedSearch[] = [];
  const { promise: firstReadinessSearch, resolve: resolveFirstReadinessSearch } =
    Promise.withResolvers<void>();
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/search/")) {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        try {
          const parsed = searchRequest.parse(JSON.parse(body));
          searches.push({
            query: parsed.query,
            collection: parsed.collection,
            maxResults: parsed.maxResults,
          });
          if (parsed.query === "remnic startup readiness") resolveFirstReadinessSearch();
          res.writeHead(200, { "content-type": "application/json" });
          res.end("[]");
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  };
  const httpServer: HttpServer = createServer(handle);
  const { promise: listening, resolve: resolveListening, reject: rejectListening } =
    Promise.withResolvers<number>();
  httpServer.once("error", rejectListening);
  httpServer.listen(0, "127.0.0.1", () => {
    const address = z.object({ port: z.number().int().positive() }).safeParse(httpServer.address());
    if (address.success) resolveListening(address.data.port);
    else rejectListening(new Error("no TCP address"));
  });
  const port = await listening;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    searches,
    firstReadinessSearch,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // close() is callback-only by API; executor form is required here.
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function withTestDeadline<T>(promise: Promise<T>, timeoutMs = 30_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("test deadline exceeded")), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForState(
  condition: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function bootServerWithFakeSearch(options: {
  fake: FakeSearchService;
  namespacesEnabled: boolean;
  migrateDefaultNamespace?: boolean;
}): Promise<{ result: ServerResult; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-readiness-3253-"));
  const memoryDir = path.join(dir, "memory");
  if (options.migrateDefaultNamespace) {
    // A content marker under namespaces/<default> with no legacy root data
    // migrates the default namespace's storage off the flat root
    // (resolveDefaultNamespaceRoot), so its collection becomes suffixed.
    await mkdir(path.join(memoryDir, "namespaces", "main", "entities"), { recursive: true });
  }
  const configPath = path.join(dir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      remnic: {
        memoryDir,
        qmdEnabled: false,
        searchBackend: "remote",
        remoteSearchBaseUrl: options.fake.baseUrl,
        qmdCollection: "engram",
        namespacesEnabled: options.namespacesEnabled,
        defaultNamespace: "main",
        namespaceCatalogEnabled: true,
        embeddingFallbackEnabled: false,
        localLlmEnabled: false,
        identityContinuityEnabled: false,
        transcriptEnabled: false,
        hourlySummariesEnabled: false,
        compoundingEnabled: false,
        knowledgeIndexEnabled: false,
      },
      server: {
        host: "127.0.0.1",
        authToken: "test-token",
      },
    }),
    "utf8",
  );
  const result = await withTestDeadline(
    startServer({ configPath, authToken: "test-token", allowEphemeralPort: true }),
  );
  return {
    result,
    cleanup: async () => {
      await result.stop().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function testReadinessWarmupUsesResolvedCollection(options: {
  namespacesEnabled: boolean;
  migrateDefaultNamespace?: boolean;
  expectedCollection: (collection: string | undefined) => boolean;
  expectedLabel: string;
}): Promise<void> {
  const fake = await startFakeSearchService();
  let boot: { result: ServerResult; cleanup: () => Promise<void> } | undefined;
  try {
    boot = await withTestDeadline(
      bootServerWithFakeSearch({
        fake,
        namespacesEnabled: options.namespacesEnabled,
        migrateDefaultNamespace: options.migrateDefaultNamespace,
      }),
    );
    await withTestDeadline(fake.firstReadinessSearch, 20_000);
    const readinessSearches = fake.searches.filter(
      (entry) => entry.query === "remnic startup readiness",
    );
    assert.ok(
      readinessSearches.every((entry) => options.expectedCollection(entry.collection)),
      `readiness warm-up searched the wrong collection (${options.expectedLabel}): ` +
        `${JSON.stringify(readinessSearches)}`,
    );
    assert.ok(
      readinessSearches.every((entry) => entry.maxResults === (entry.collection === "engram" ? 50 : 1)),
      `readiness warm-up must retain the native candidate budget: ${JSON.stringify(readinessSearches)}`,
    );
    // A legitimately empty corpus warms cleanly: the gate opened (health serves
    // 200 instead of the 503 not_ready) after the successful empty search.
    await waitForState(async () => {
      const health = await fetch(`http://127.0.0.1:${boot!.result.port}/engram/v1/health`, {
        headers: { authorization: "Bearer test-token" },
        signal: AbortSignal.timeout(2_000),
      });
      await health.text();
      return health.status === 200;
    }, "health to report ready after warm-up");
  } finally {
    await boot?.cleanup();
    await fake.close();
  }
}

test("readiness warm-up searches the migrated default namespace's suffixed collection (#3253)", async () => {
  await testReadinessWarmupUsesResolvedCollection({
    namespacesEnabled: true,
    migrateDefaultNamespace: true,
    expectedLabel: "namespaced default",
    expectedCollection: (collection) => collection === "engram--ns-6d61696e",
  });
});

test("readiness warm-up keeps the legacy flat-root base collection for a flat default namespace (#3253)", async () => {
  await testReadinessWarmupUsesResolvedCollection({
    namespacesEnabled: true,
    expectedLabel: "legacy flat default",
    expectedCollection: (collection) => collection === "engram",
  });
});

test("readiness warm-up uses the backend default collection when namespaces are disabled (#3253)", async () => {
  await testReadinessWarmupUsesResolvedCollection({
    namespacesEnabled: false,
    expectedLabel: "namespaces disabled",
    expectedCollection: (collection) => collection === undefined,
  });
});


const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface FakeEnsurerOrchestrator {
  deferredSyncSucceeded: boolean;
  available: boolean;
  readyCalls: number;
  syncCalls: number;
  readyGate: PromiseWithResolvers<boolean>;
  syncGate: PromiseWithResolvers<boolean>;
}

// sets available=true before collection ensure finishes (qmd.ts
// recordProbeSuccess), which is exactly the window #3518's second read found
// the readiness gate trusting.
function fakeEnsurerOrchestrator() {
  const fake: FakeEnsurerOrchestrator = {
    deferredSyncSucceeded: false,
    available: false,
    readyCalls: 0,
    syncCalls: 0,
    readyGate: Promise.withResolvers<boolean>(),
    syncGate: Promise.withResolvers<boolean>(),
  };
  // (deferredSyncSucceeded, qmd.isAvailable/debugStatus, the two sync entry
  // points); the fake omits the rest of Orchestrator by design.
  const orchestrator = {
    get deferredSyncSucceeded() {
      return fake.deferredSyncSucceeded;
    },
    set deferredSyncSucceeded(value: boolean) {
      fake.deferredSyncSucceeded = value;
    },
    qmd: {
      isAvailable: () => fake.available,
      debugStatus: () => "synthetic-qmd",
    },
    startupSearchReadySync: async () => {
      fake.readyCalls += 1;
      fake.available = true;
      return fake.readyGate.promise;
    },
    startupSearchSync: async () => {
      fake.syncCalls += 1;
      fake.available = true;
      return fake.syncGate.promise;
    },
  } as any;
  return { orchestrator, fake };
}

test("ensureSearchReady joins an in-flight readiness sync instead of trusting mid-run isAvailable (#3518 second read)", async () => {
  const { orchestrator, fake } = fakeEnsurerOrchestrator();
  const { ensureSearchReady } = createStartupSyncEnsurers(orchestrator);
  const signal = new AbortController().signal;

  const first = ensureSearchReady(signal);
  await waitForState(() => fake.available, "probe availability flips mid-run");

  const second = ensureSearchReady(signal);
  const secondOutcome = await Promise.race([
    second.then(() => "settled" as const),
    sleepMs(50).then(() => "pending" as const),
  ]);
  assert.equal(
    secondOutcome,
    "pending",
    "a caller arriving mid-run must join it; isAvailable alone must not open readiness",
  );
  assert.equal(fake.readyCalls, 1, "concurrent readiness callers share one sync run");

  fake.readyGate.resolve(true);
  assert.equal(await first, true);
  assert.equal(await second, true);
});

test("ensureSearchReady re-ensures collections when the probe completed but the ensure is unproven (#3518 second read)", async () => {
  const { orchestrator, fake } = fakeEnsurerOrchestrator();
  // initialize() probed successfully but its collection batch timed out as
  // "unknown" or threw non-fatally: availability is true while no ensure is
  // proven to have completed.
  fake.available = true;
  fake.readyGate.resolve(true);
  const { ensureSearchReady } = createStartupSyncEnsurers(orchestrator);

  assert.equal(await ensureSearchReady(new AbortController().signal), true);
  assert.equal(
    fake.readyCalls,
    1,
    "isAvailable alone must not skip the collection ensure",
  );
});

test("ensureSearchReady during an in-flight full sync runs its own readiness level and never waits on the corpus update (#3518 second read)", async () => {
  const { orchestrator, fake } = fakeEnsurerOrchestrator();
  const { ensureSearchReady, ensureStartupSync } = createStartupSyncEnsurers(orchestrator);
  const signal = new AbortController().signal;

  const sync = ensureStartupSync(signal);
  await waitForState(() => fake.available, "full sync probe flips availability mid-run");

  fake.readyGate.resolve(true);
  const ready = await Promise.race([
    ensureSearchReady(signal),
    sleepMs(500).then(() => "hung" as const),
  ]);
  assert.equal(
    ready,
    true,
    "the readiness attempt must resolve ready, not merely settle",
  );
  assert.equal(
    fake.readyCalls,
    1,
    "the readiness level runs its own ensure rather than trusting mid-sync availability",
  );
  const syncOutcome = await Promise.race([
    sync.then(() => "settled" as const),
    sleepMs(50).then(() => "pending" as const),
  ]);
  assert.equal(
    syncOutcome,
    "pending",
    "the readiness gate must not wait on the full sync's corpus update",
  );
  fake.syncGate.resolve(true);
  assert.equal(await sync, true);
});

test("ensureSearchReady short-circuits once the startup sync succeeded", async () => {
  const { orchestrator, fake } = fakeEnsurerOrchestrator();
  fake.deferredSyncSucceeded = true;
  const { ensureSearchReady } = createStartupSyncEnsurers(orchestrator);

  assert.equal(await ensureSearchReady(new AbortController().signal), true);
  assert.equal(fake.readyCalls, 0, "no readiness work runs once the sync flag is set");
});

test("an unverified collection ensure opens the gate degraded, never warmed (wAQ third read)", async () => {
  const { orchestrator, fake } = fakeEnsurerOrchestrator();
  // ensureCollection answered "unknown": the real coordinator reports the
  // readiness ensure as not-ready, so each warm-up attempt fails before the
  // search. The gate must open degraded — a zero-result healthy warm-up must
  // never reach it as "warmed".
  fake.readyGate.resolve(false);
  const { ensureSearchReady } = createStartupSyncEnsurers(orchestrator);
  const state = { ready: false, warmupAttempts: 0, lastError: null, degraded: false };
  let gateOpens = 0;
  let warmupSearches = 0;

  const outcome = await completeStartupReadiness({
    deferredReady: Promise.resolve(),
    warmup: async () => {
      warmupSearches += 1;
    },
    prepareWarmup: ensureSearchReady,
    state,
    timeoutMs: 50,
    retryIntervalMs: 5,
    degradedAfterAttempts: 1,
    openGate: () => {
      gateOpens += 1;
    },
    shutdownSignal: AbortSignal.timeout(300),
  });

  assert.equal(outcome, "cancelled");
  assert.equal(warmupSearches, 0, "the warm-up search never runs while the ensure is unverified");
  assert.equal(gateOpens, 1, "the gate opens once, degraded");
  assert.equal(state.degraded, true, "an unknown collection state counts as degraded");
  assert.equal(state.ready, true);
});

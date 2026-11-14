import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { z } from "zod";

import { currentCorrelationId } from "./access-correlation.js";
import { recordAbstractionNode } from "./abstraction-nodes.js";
import { EngramAccessHttpServer } from "./access-http.js";
import { EngramAccessService } from "./access-service.js";
import { CompoundingEngine } from "./compounding/engine.js";
import { parseConfig } from "./config.js";
import { rebuildMemoryProjection } from "./maintenance/rebuild-memory-projection.js";
import { Orchestrator } from "./orchestrator.js";
import {
  PHASE2_AWAIT_STATUSES,
  type Phase2AwaitStatus,
} from "./recall-phase2-timing.js";
import { getRecallTimings } from "./recall-timings.js";
import { StorageManager } from "./storage.js";
import { cleanupDir, eventually } from "./testing/orchestrator-lite.js";
import type { MemoryFile, QmdSearchResult } from "./types.js";
import type { SearchBackend } from "./search/port.js";

test.afterEach(() => {
  mock.restoreAll();
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface ConfigOverrides {
  qmdEnabled?: boolean;
  harmonicRetrievalEnabled?: boolean;
  queryAwareIndexingEnabled?: boolean;
  compoundingEnabled?: boolean;
  recallEnrichmentDeadlineMs?: number;
  recallOuterTimeoutMs?: number;
}

function makeConfig(memoryDir: string, overrides: ConfigOverrides = {}) {
  return parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    recallPlannerEnabled: false,
    sharedContextEnabled: false,
    initGateTimeoutMs: 1000,
    ...overrides,
  });
}

/** Complete typed SearchBackend stub (no casts): one settled QMD candidate. */
function settledQmdBackend(result: QmdSearchResult): SearchBackend {
  return {
    async probe() {
      return true;
    },
    isAvailable() {
      return true;
    },
    debugStatus() {
      return "backend=settled-qmd-stub";
    },
    async search() {
      return [result];
    },
    async searchGlobal() {
      return [];
    },
    async bm25Search() {
      return [];
    },
    async vectorSearch() {
      return [];
    },
    async hybridSearch() {
      return [];
    },
    async update() {},
    async updateCollection() {},
    async embed() {},
    async embedCollection() {},
    async ensureCollection() {
      return "present";
    },
  };
}

interface StartedServer {
  url: string;
  stop: () => Promise<void>;
}

async function startTimingsServer(service: EngramAccessService): Promise<StartedServer> {
  const server = new EngramAccessHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    principal: "operator",
    trustPrincipalHeader: true,
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  return { url: `http://${started.host}:${started.port}`, stop: () => server.stop() };
}

interface RecallBody {
  query: string;
  sessionKey: string;
  asOf?: string;
}

function recallRequest(
  server: StartedServer,
  body: RecallBody,
  extraHeaders: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${server.url}/engram/v1/recall`, {
    method: "POST",
    headers: {
      authorization: "Bearer secret-token",
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    signal,
  });
}

function assertPhase2(
  label: string,
  ms: number | undefined,
  status: Phase2AwaitStatus | undefined,
): void {
  assert.ok(
    status !== undefined && PHASE2_AWAIT_STATUSES.includes(status),
    `${label} status must be a bounded enum value`,
  );
  assert.ok(
    ms !== undefined && Number.isFinite(ms) && ms >= 0,
    `${label} ms must be a bounded non-negative number`,
  );
}

interface HarmonicHarness {
  qmdMemory: MemoryFile;
  releaseHarmonicRead: () => void;
  harmonicReadCalls: { count: number };
  correlationIdsSeen: string[];
}

/** Park the harmonic source read behind a gate (the house ordering-harness pattern). */
async function makeHarmonicHarness(memoryDir: string): Promise<HarmonicHarness> {
  const storage = new StorageManager(memoryDir);
  await storage.ensureDirectories();
  const { memory: qmdMemory } = await storage.writeMemory(
    "fact",
    "the atlas qmd sentinel confirms deployment cadence",
    { source: "test" },
  );
  const { memory: harmonicSource } = await storage.writeMemory(
    "fact",
    "atlas harmonic source lookup body",
    { source: "test" },
  );
  await recordAbstractionNode({
    memoryDir,
    node: {
      schemaVersion: 1,
      nodeId: "correlation-under-test",
      recordedAt: new Date().toISOString(),
      sessionKey: "agent:test",
      kind: "topic",
      abstractionLevel: "meso",
      title: "atlas source lookup",
      summary: "atlas source lookup",
      sourceMemoryIds: [harmonicSource.frontmatter.id],
    },
  });
  await rebuildMemoryProjection({ memoryDir, storage, dryRun: false });

  const harmonicGate = Promise.withResolvers<void>();
  const harmonicReadCalls = { count: 0 };
  const correlationIdsSeen: string[] = [];
  const originalRead = StorageManager.prototype.readMemoryByPath;
  const harmonicSourcePath = path.resolve(harmonicSource.path);
  mock.method(
    StorageManager.prototype,
    "readMemoryByPath",
    function interceptHarmonicSourceRead(
      this: StorageManager,
      filePath: string,
    ): Promise<MemoryFile | null> {
      if (path.resolve(filePath) !== harmonicSourcePath) {
        return originalRead.call(this, filePath);
      }
      harmonicReadCalls.count += 1;
      const seen = currentCorrelationId();
      if (seen !== undefined) correlationIdsSeen.push(seen);
      return harmonicGate.promise.then(() => originalRead.call(this, filePath));
    },
  );
  return {
    qmdMemory,
    releaseHarmonicRead: () => harmonicGate.resolve(),
    harmonicReadCalls,
    correlationIdsSeen,
  };
}

function stubQmd(orchestrator: Orchestrator, harness: HarmonicHarness): void {
  orchestrator.qmd = settledQmdBackend({
    docid: harness.qmdMemory.frontmatter.id,
    path: harness.qmdMemory.path,
    score: 0.9,
    snippet: harness.qmdMemory.content,
  });
}

test("recall timing requestId equals the HTTP x-request-id response header", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-timing-corr-"));
  const config = makeConfig(memoryDir);
  const server = await startTimingsServer(new EngramAccessService(new Orchestrator(config)));
  try {
    const response = await recallRequest(server, { query: "correlation probe", sessionKey: "corr:probe" });
    assert.equal(response.status, 200);
    const requestIdHeader = response.headers.get("x-request-id");
    assert.ok(requestIdHeader, "recall response must carry x-request-id");

    const records = getRecallTimings(config);
    // The record's requestId IS the server-generated HTTP correlation id
    // surfaced as x-request-id — not a second, unrelated uuid.
    assert.equal(records[0]?.requestId, requestIdHeader);
    assert.equal(records[0]?.outcome, "ok");
  } finally {
    await server.stop();
    await cleanupDir(memoryDir);
  }
});

test("concurrent recalls never cross request ids", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-timing-corr-par-"));
  const config = makeConfig(memoryDir);
  const server = await startTimingsServer(new EngramAccessService(new Orchestrator(config)));
  try {
    const responses = await Promise.all(
      ["parallel one", "parallel two", "parallel three"].map((query) =>
        recallRequest(server, { query, sessionKey: "corr:parallel" }),
      ),
    );
    const headerIds = responses.map((response) => response.headers.get("x-request-id"));
    assert.equal(new Set(headerIds).size, headerIds.length, "each request gets its own correlation id");

    const recordIds = getRecallTimings(config).map((record) => record.requestId);
    for (const id of headerIds) {
      assert.ok(id !== null && recordIds.includes(id), "each request's record carries that request's id");
    }
  } finally {
    await server.stop();
    await cleanupDir(memoryDir);
  }
});

test("client-supplied x-request-id never becomes the record's request id", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-timing-corr-spoof-"));
  const config = makeConfig(memoryDir);
  const server = await startTimingsServer(new EngramAccessService(new Orchestrator(config)));
  try {
    const response = await recallRequest(
      server,
      { query: "spoof probe", sessionKey: "corr:spoof" },
      { "x-request-id": "client-chosen-id" },
    );
    const serverHeader = response.headers.get("x-request-id");
    assert.notEqual(serverHeader, "client-chosen-id");

    const records = getRecallTimings(config);
    assert.equal(records[0]?.requestId, serverHeader);
    assert.match(records[0]?.requestId ?? "", UUID_PATTERN);
  } finally {
    await server.stop();
    await cleanupDir(memoryDir);
  }
});

test("HTTP recall rejected as bad input records outcome error under the x-request-id", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-timing-corr-error-"));
  const config = makeConfig(memoryDir);
  const server = await startTimingsServer(new EngramAccessService(new Orchestrator(config)));
  try {
    const response = await recallRequest(server, {
      query: "bad asOf probe",
      sessionKey: "corr:error",
      asOf: "not-a-timestamp",
    });
    assert.equal(response.status, 400);
    const requestIdHeader = response.headers.get("x-request-id");
    assert.ok(requestIdHeader, "error responses carry x-request-id too");

    const records = getRecallTimings(config);
    assert.equal(records[0]?.requestId, requestIdHeader);
    assert.equal(records[0]?.outcome, "error");
  } finally {
    await server.stop();
    await cleanupDir(memoryDir);
  }
});

test("aborted HTTP recall records outcome aborted under its own request id", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-timing-corr-abort-"));
  const config = makeConfig(memoryDir, { qmdEnabled: true, harmonicRetrievalEnabled: true });
  const orchestrator = new Orchestrator(config);
  const harness = await makeHarmonicHarness(memoryDir);
  stubQmd(orchestrator, harness);
  const server = await startTimingsServer(new EngramAccessService(orchestrator));
  try {
    const client = new AbortController();
    const pending = recallRequest(
      server,
      { query: "atlas source lookup", sessionKey: "corr:abort" },
      {},
      client.signal,
    ).catch(() => undefined);
    await eventually(
      async () => (harness.harmonicReadCalls.count > 0 ? true : null),
      "harmonic read reached the parked seam",
    );
    client.abort();
    harness.releaseHarmonicRead();
    await eventually(
      async () => (getRecallTimings(config)[0]?.outcome === "aborted" ? true : null),
      "the aborted attempt records outcome aborted",
    );
    await pending;

    const records = getRecallTimings(config);
    assert.equal(records.length, 1, "exactly one record for the attempt");
    assert.equal(harness.correlationIdsSeen.length, 1);
    // Same id: the one the HTTP layer minted for this request, observed from
    // inside the request's own async context while the recall was in flight.
    assert.equal(records[0]?.requestId, harness.correlationIdsSeen[0]);
    assert.match(records[0]?.requestId ?? "", UUID_PATTERN);
  } finally {
    harness.releaseHarmonicRead();
    await server.stop();
    await cleanupDir(memoryDir);
  }
});

test("phase-2 await fields are populated, bounded, and skipped for disabled sections", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-timing-phase2-"));
  const config = makeConfig(memoryDir);
  const service = new EngramAccessService(new Orchestrator(config));
  await service.recall({ query: "phase two probe", sessionKey: "phase2:probe" });
  const record = getRecallTimings(config)[0];
  assert.ok(record);
  assertPhase2("harmonic", record.phase2HarmonicMs, record.phase2HarmonicStatus);
  assertPhase2("graph snapshot", record.phase2GraphSnapshotMs, record.phase2GraphSnapshotStatus);
  assertPhase2("intent snapshot", record.phase2IntentSnapshotMs, record.phase2IntentSnapshotStatus);
  assertPhase2("compression", record.phase2CompressionMs, record.phase2CompressionStatus);
  assertPhase2("compounding", record.phase2CompoundingMs, record.phase2CompoundingStatus);
  assertPhase2("questions", record.phase2QuestionsMs, record.phase2QuestionsStatus);
  assertPhase2("prefilter", record.phase2PrefilterMs, record.phase2PrefilterStatus);
  // Default config disables these sections: 0 ms, skipped, no invented time.
  assert.equal(record.phase2HarmonicStatus, "skipped");
  assert.equal(record.phase2HarmonicMs, 0);
  assert.equal(record.phase2CompressionStatus, "skipped");
  assert.equal(record.phase2CompressionMs, 0);
  assert.equal(record.phase2QuestionsStatus, "skipped");
  assert.equal(record.phase2QuestionsMs, 0);
  assert.equal(record.phase2PrefilterStatus, "skipped");
  assert.equal(record.phase2PrefilterMs, 0);
  // The intent snapshot always runs.
  assert.equal(record.phase2IntentSnapshotStatus, "ok");
  await cleanupDir(memoryDir);
});

test("enrichment timeout records timeout status while recall still succeeds", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-timing-phase2-timeout-"));
  const config = makeConfig(memoryDir, {
    qmdEnabled: true,
    harmonicRetrievalEnabled: true,
    recallEnrichmentDeadlineMs: 1,
  });
  const orchestrator = new Orchestrator(config);
  const harness = await makeHarmonicHarness(memoryDir);
  stubQmd(orchestrator, harness);
  const service = new EngramAccessService(orchestrator);
  // The recall must still settle (fail-open unchanged) despite the parked read.
  await service.recall({ query: "atlas source lookup", sessionKey: "phase2:timeout" });
  const record = getRecallTimings(config)[0];
  assert.ok(record);
  assert.equal(record.phase2HarmonicStatus, "timeout");
  assertPhase2("harmonic", record.phase2HarmonicMs, record.phase2HarmonicStatus);
  assert.equal(record.outcome, "ok");
  harness.releaseHarmonicRead();
  await cleanupDir(memoryDir);
});

test("failed enrichment records error status while recall still succeeds", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-timing-phase2-error-"));
  const config = makeConfig(memoryDir, { compoundingEnabled: true });
  const orchestrator = new Orchestrator(config);
  mock.method(CompoundingEngine.prototype, "buildRecallSection", () =>
    Promise.reject(new Error("synthetic compounding failure")));
  const service = new EngramAccessService(orchestrator);
  // Fail-open is unchanged: the recall still resolves; only the status says why.
  await service.recall({ query: "compounding failure probe", sessionKey: "phase2:error" });
  const record = getRecallTimings(config)[0];
  assert.ok(record);
  assert.equal(record.phase2CompoundingStatus, "error");
  assertPhase2("compounding", record.phase2CompoundingMs, record.phase2CompoundingStatus);
  assert.equal(record.outcome, "ok");
  await cleanupDir(memoryDir);
});

test("started-earlier awaits also record total time since their promise was created", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-timing-phase2-overlap-"));
  const config = makeConfig(memoryDir, {
    qmdEnabled: true,
    harmonicRetrievalEnabled: true,
    queryAwareIndexingEnabled: true,
  });
  const orchestrator = new Orchestrator(config);
  const harness = await makeHarmonicHarness(memoryDir);
  harness.releaseHarmonicRead();
  stubQmd(orchestrator, harness);
  const service = new EngramAccessService(orchestrator);
  await service.recall({ query: "atlas source lookup", sessionKey: "phase2:overlap" });
  const record = getRecallTimings(config)[0];
  assert.ok(record);
  assert.equal(record.phase2HarmonicStatus, "ok");
  assert.ok(record.phase2HarmonicMs !== undefined && record.phase2HarmonicTotalMs !== undefined);
  // Total time since the promise was created covers the await itself: the two
  // overlap, they are not additive.
  assert.ok(record.phase2HarmonicTotalMs >= record.phase2HarmonicMs);
  assert.ok(record.phase2PrefilterMs !== undefined && record.phase2PrefilterTotalMs !== undefined);
  assert.ok(record.phase2PrefilterTotalMs >= record.phase2PrefilterMs);
  await cleanupDir(memoryDir);
});

test("recall response body carries no timing-contract fields", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-timing-corr-body-"));
  const config = makeConfig(memoryDir);
  const server = await startTimingsServer(new EngramAccessService(new Orchestrator(config)));
  try {
    const response = await recallRequest(server, { query: "body shape probe", sessionKey: "corr:body" });
    assert.equal(response.status, 200);
    const keys = Object.keys(z.object({}).passthrough().parse(await response.json()));
    for (const expected of ["query", "namespace", "context", "count", "memoryIds", "results", "fallbackUsed", "sourcesUsed"]) {
      assert.ok(keys.includes(expected), `recall body must still carry ${expected}`);
    }
    // Timing-contract fields live only in the operator-gated timing record.
    for (const key of keys) {
      assert.doesNotMatch(key, /requestId|outcome|httpTotal|phase2|timingsMs/, `timing field leaked into recall body: ${key}`);
    }
  } finally {
    await server.stop();
    await cleanupDir(memoryDir);
  }
});

test("a recall the outer timeout cuts short records outcome error, not ok", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-timing-outer-timeout-"));
  const config = makeConfig(memoryDir, {
    qmdEnabled: true,
    harmonicRetrievalEnabled: true,
    recallOuterTimeoutMs: 50,
  });
  const orchestrator = new Orchestrator(config);
  const harness = await makeHarmonicHarness(memoryDir);
  stubQmd(orchestrator, harness);
  const service = new EngramAccessService(orchestrator);
  // The entry coordinator swallows the timeout and returns a degraded context,
  // so the surface call resolves; the record must still say it did not complete.
  await service.recall({ query: "atlas source lookup", sessionKey: "outer:timeout" });
  harness.releaseHarmonicRead();
  const records = getRecallTimings(config);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.outcome, "error");
  assert.equal(records[0]?.phase2HarmonicStatus, undefined, "no phase-2 data from a pipeline that never finished");
  await cleanupDir(memoryDir);
});

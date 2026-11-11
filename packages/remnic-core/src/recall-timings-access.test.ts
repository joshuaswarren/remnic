import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getOperation } from "./access-boundary.js";
import { EngramAccessHttpServer } from "./access-http.js";
import { EngramAccessService } from "./access-service.js";
import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import {
  getRecallTimings,
  getRecallTimingStatus,
  recordRecallTiming,
  resolveRecallTimingsOperatorPrincipal,
  type RecallTimingRecord,
} from "./recall-timings.js";

function makeConfig(memoryDir: string, overrides: Record<string, unknown> = {}) {
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

// Outside HTTP dispatch (direct service calls) the id is a generated fallback, marked "local:" in the same field.
const REQUEST_ID_PATTERN = /^local:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("authenticated recall timings route returns two recalls without user-correlatable inputs", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-recall-timings-"));
  const config = makeConfig(memoryDir);
  const orchestrator = new Orchestrator(config);
  const service = new EngramAccessService(orchestrator);
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
  const url = `http://${started.host}:${started.port}/engram/v1/recall/timings`;
  try {
    // Drive recalls through the service path (HTTP / MCP recall route) so the
    // records carry the attempt contract (requestId + outcome + httpTotalMs).
    await service.recall({ query: "private first query", sessionKey: "private:first:session" });
    await service.recall({ query: "private second query", sessionKey: "private:second:session", mode: "no_recall" });

    const denied = await fetch(url);
    assert.equal(denied.status, 401);

    const nonOperator = await fetch(url, {
      headers: {
        Authorization: "Bearer secret-token",
        "X-Engram-Principal": "reader",
      },
    });
    assert.equal(nonOperator.status, 403);
    assert.equal(nonOperator.headers.get("cache-control"), "no-store");

    const response = await fetch(url, {
      headers: {
        Authorization: "Bearer secret-token",
        "X-Engram-Principal": "operator",
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = await response.json() as {
      generatedAt: string;
      processStartedAt: string;
      capacity: number;
      count: number;
      order: string;
      records: RecallTimingRecord[];
    };
    assert.ok(Number.isFinite(Date.parse(payload.generatedAt)));
    assert.ok(Number.isFinite(Date.parse(payload.processStartedAt)));
    assert.ok(Date.parse(payload.processStartedAt) <= Date.parse(payload.generatedAt));
    assert.equal(payload.capacity, 50);
    assert.equal(payload.order, "newest-first");
    assert.equal(payload.count, 2);
    assert.equal(payload.records.length, 2);
    const operation = getOperation("recall_timings");
    assert.ok(operation);
    await assert.rejects(
      operation.run({}, {
        service,
        authenticatedPrincipal: "reader",
        operatorPrincipal: "operator",
      }),
      /configured operator principal/,
    );
    const operationOutput = await operation.run({}, {
      service,
      authenticatedPrincipal: "operator",
      operatorPrincipal: "operator",
    }) as { result: { count: number; records: RecallTimingRecord[] } };
    // generatedAt legitimately differs between the two calls; the data must not.
    assert.equal(operationOutput.result.count, payload.count);
    assert.deepEqual(operationOutput.result.records, payload.records);
    for (const record of payload.records) {
      assert.equal(record.namespace, "default");
      assert.ok(Number.isFinite(Date.parse(record.timestamp)));
      assert.equal(typeof record.timingsMs.total, "number");
      assert.ok(record.timingsMs.total >= 0);
      assert.equal(typeof record.recallPlan, "string");
      assert.equal(typeof record.queryPolicy, "string");
      // Attempt contract (requestId + outcome + monotonic httpTotalMs).
      assert.match(record.requestId, REQUEST_ID_PATTERN);
      assert.equal(record.outcome, "ok");
      assert.ok(Number.isFinite(record.httpTotalMs) && record.httpTotalMs >= 0);
      assert.equal("query" in record, false);
      assert.equal("prompt" in record, false);
      assert.equal("sessionKey" in record, false);
      assert.equal("retrievalQuery" in record, false);
      assert.equal("query" in record.timingsMs, false);
      assert.equal("prompt" in record.timingsMs, false);
    }
  } finally {
    await server.stop();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("recall timing history keeps only the newest 50 records", () => {
  const config = makeConfig(path.join(os.tmpdir(), "remnic-recall-timing-ring"));
  for (let index = 0; index < 51; index += 1) {
    recordRecallTiming(config, {
      timestamp: new Date(index * 1000).toISOString(),
      namespace: "default",
      total: index,
      recallPlan: "full",
      queryPolicy: "general/full",
    });
  }

  const records = getRecallTimings(config);
  assert.equal(records.length, 50);
  assert.equal(records[0]?.timingsMs.total, 50);
  assert.equal(records[49]?.timingsMs.total, 1);
});

test("operator principal resolution agrees for standalone and embedded access", () => {
  const standaloneConfig = makeConfig(path.join(os.tmpdir(), "remnic-recall-timing-standalone"));
  assert.equal(
    resolveRecallTimingsOperatorPrincipal(standaloneConfig, "standalone-operator"),
    "standalone-operator",
  );

  const embeddedConfig = makeConfig(path.join(os.tmpdir(), "remnic-recall-timing-embedded"), {
    agentAccessHttp: {
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      principal: "embedded-operator",
      maxBodyBytes: 1024,
    },
  });
  assert.equal(
    resolveRecallTimingsOperatorPrincipal(embeddedConfig),
    "embedded-operator",
  );
  assert.equal(
    resolveRecallTimingsOperatorPrincipal(
      embeddedConfig,
      "fallback-transport-principal",
    ),
    "embedded-operator",
  );
});

test("recall timing records expose only the fixed telemetry schema", () => {
  const config = makeConfig(path.join(os.tmpdir(), "remnic-recall-timing-schema"));
  recordRecallTiming(config, {
    timestamp: new Date(0).toISOString(),
    namespace: "default",
    total: "7ms",
    qmd: "3ms",
    qmdPost: "2ms-cache",
    recallPlan: "full",
    queryPolicy: "general/full",
    queryAware: "1ms;helped=private prompt detail",
    prompt: "private prompt",
    sessionKey: "user-session",
    unknownTiming: "9ms",
  });

  const record = getRecallTimings(config)[0];
  assert.deepEqual(record, {
    timestamp: new Date(0).toISOString(),
    namespace: "default",
    recallPlan: "full",
    queryPolicy: "general/full",
    // Attempt contract defaults for legacy emitters: no id, not an error,
    // no monotonic duration measured.
    requestId: "",
    outcome: "ok",
    httpTotalMs: 0,
    timingsMs: {
      total: 7,
      qmd: 3,
      qmdPost: 2,
    },
  });
});

test("trustStage is allowlisted and its ms is parsed (issue #1905)", () => {
  const config = makeConfig(path.join(os.tmpdir(), "remnic-recall-timing-trust"));
  recordRecallTiming(config, {
    timestamp: new Date(0).toISOString(),
    namespace: "default",
    total: "10ms",
    trustStage: "3ms",
    recallPlan: "full",
    queryPolicy: "general/full",
  });
  recordRecallTiming(config, {
    timestamp: new Date(1).toISOString(),
    namespace: "default",
    total: "10ms",
    trustStage: "2ms-cache",
    recallPlan: "full",
    queryPolicy: "general/full",
  });
  const records = getRecallTimings(config);
  // newest-first ordering
  assert.equal(records[0]?.timingsMs.trustStage, 2, "\"2ms-cache\" parses to numeric 2");
  assert.equal(records[1]?.timingsMs.trustStage, 3, "\"3ms\" parses to numeric 3");
});

test("queueWaitMs is allowlisted and parsed while a non-allowlisted sibling is dropped (issue #1906)", () => {
  const config = makeConfig(path.join(os.tmpdir(), "remnic-recall-timing-queuewait"));
  recordRecallTiming(config, {
    timestamp: new Date(0).toISOString(),
    namespace: "default",
    total: "42ms",
    queueWaitMs: "12ms",
    queueWaitDebug: "99ms",
    recallPlan: "full",
    queryPolicy: "general/full",
  });
  const record = getRecallTimings(config)[0];
  assert.ok(record);
  assert.equal(record.timingsMs.queueWaitMs, 12);
  assert.equal("queueWaitDebug" in record.timingsMs, false);
});

test("phases that did not run are omitted while measured zeros survive", () => {
  const config = makeConfig(path.join(os.tmpdir(), "remnic-recall-timing-phases"));
  recordRecallTiming(config, {
    timestamp: new Date(0).toISOString(),
    namespace: "default",
    total: "5ms",
    qmd: "0ms",
    recallPlan: "full",
    queryPolicy: "general/full",
  });

  const record = getRecallTimings(config)[0];
  assert.ok(record);
  assert.equal(record.timingsMs.qmd, 0);
  assert.equal("qmdPost" in record.timingsMs, false);
  assert.equal("ki" in record.timingsMs, false);
});

test("status envelope reports a stable process start and live generation time", () => {
  const config = makeConfig(path.join(os.tmpdir(), "remnic-recall-timing-envelope"));
  const first = getRecallTimingStatus(config);
  const second = getRecallTimingStatus(config);
  assert.equal(first.processStartedAt, second.processStartedAt);
  assert.ok(Number.isFinite(Date.parse(first.processStartedAt)));
  assert.ok(Date.parse(first.processStartedAt) <= Date.now());
  assert.equal(first.capacity, 50);
  assert.equal(first.order, "newest-first");
  assert.equal(first.count, 0);
  assert.deepEqual(first.records, []);
});

test("configured operator principal outranks a divergent server principal override", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-recall-timings-div-"));
  const config = makeConfig(memoryDir, {
    agentAccessHttp: {
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      principal: "config-operator",
      maxBodyBytes: 1024,
    },
  });
  const orchestrator = new Orchestrator(config);
  const service = new EngramAccessService(orchestrator);
  const server = new EngramAccessHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    principal: "cli-override",
    trustPrincipalHeader: true,
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const url = `http://${started.host}:${started.port}/engram/v1/recall/timings`;
  try {
    // The server's own default identity is NOT the operator when the config
    // explicitly names a different one. Settled precedence: config first.
    const overrideOnly = await fetch(url, {
      headers: { Authorization: "Bearer secret-token" },
    });
    assert.equal(overrideOnly.status, 403);

    const configOperator = await fetch(url, {
      headers: {
        Authorization: "Bearer secret-token",
        "X-Engram-Principal": "config-operator",
      },
    });
    assert.equal(configOperator.status, 200);
  } finally {
    await server.stop();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("batch context without transport operator fails closed when config names no operator", async () => {
  const config = makeConfig(path.join(os.tmpdir(), "remnic-recall-timing-batch-closed"));
  const orchestrator = new Orchestrator(config);
  const service = new EngramAccessService(orchestrator);
  const operation = getOperation("recall_timings");
  assert.ok(operation);
  // No config principal and no transport operator: nobody can pass the gate,
  // not even a caller whose authenticated principal would match elsewhere.
  await assert.rejects(
    operation.run({}, { service, authenticatedPrincipal: "operator" }),
    /configured operator principal/,
  );
  // The same caller passes once the transport supplies the operator context,
  // as the HTTP route does by dispatching with operatorPrincipal set to the
  // server's own principal.
  const output = await operation.run({}, {
    service,
    authenticatedPrincipal: "operator",
    operatorPrincipal: "operator",
  }) as { result: { count: number } };
  assert.equal(output.result.count, 0);
});

test("recall timing record allowlists requestId, outcome, and monotonic httpTotalMs (attempt contract)", () => {
  const config = makeConfig(path.join(os.tmpdir(), "remnic-recall-timing-attempt-fields"));
  recordRecallTiming(config, {
    timestamp: new Date(0).toISOString(),
    namespace: "default",
    total: "42ms",
    recallPlan: "full",
    queryPolicy: "general/full",
    requestId: "attempt-1",
    outcome: "error",
    httpTotalMs: 123.5,
    // Not part of the record contract: dropped by the sanitizer.
    query: "private user text",
    sessionKey: "private:session",
  });
  const record = getRecallTimings(config)[0];
  assert.ok(record);
  assert.equal(record.requestId, "attempt-1");
  assert.equal(record.outcome, "error");
  assert.equal(record.httpTotalMs, 123.5);
  assert.equal("query" in record, false);
  assert.equal("sessionKey" in record, false);
});

test("attempt contract fields fail closed for legacy emitters and bad values", () => {
  const config = makeConfig(path.join(os.tmpdir(), "remnic-recall-timing-attempt-defaults"));
  recordRecallTiming(config, {
    timestamp: new Date(0).toISOString(),
    namespace: "default",
    total: 5,
    recallPlan: "full",
    queryPolicy: "general/full",
    requestId: 42,
    outcome: "bogus",
    httpTotalMs: "12ms",
  });
  recordRecallTiming(config, {
    timestamp: new Date(0).toISOString(),
    namespace: "default",
    total: 6,
    recallPlan: "full",
    queryPolicy: "general/full",
    httpTotalMs: -3,
  });
  const [newest, oldest] = getRecallTimings(config);
  assert.ok(newest && oldest);
  // Direct orchestrator callers (x-ray, daemon hooks) predate the contract:
  // their records carry neutral defaults, never a misleading id or duration.
  assert.equal(newest.requestId, "");
  assert.equal(newest.outcome, "ok");
  assert.equal(newest.httpTotalMs, 0);
  // Parsed and sanitized: non-string requestId drops, unknown outcome fails
  // closed to "ok", "12ms" parses, negative durations floor to 0.
  assert.equal(oldest.requestId, "");
  assert.equal(oldest.outcome, "ok");
  assert.equal(oldest.httpTotalMs, 12);
});

test("service recall records exactly one attempt in finally with contract fields", async () => {
  const config = makeConfig(path.join(os.tmpdir(), "remnic-recall-timing-attempt-ok"));
  const service = new EngramAccessService(new Orchestrator(config));
  await service.recall({ query: "contract probe", sessionKey: "contract:probe:session" });
  const records = getRecallTimings(config);
  // One attempt, one record: the pipeline's per-phase payload folds into the
  // finally-record instead of pushing a second entry.
  assert.equal(records.length, 1);
  const record = records[0]!;
  assert.match(record.requestId, REQUEST_ID_PATTERN);
  assert.equal(record.outcome, "ok");
  assert.ok(Number.isFinite(record.httpTotalMs) && record.httpTotalMs >= 0);
  assert.ok(Number.isFinite(record.timingsMs.total) && record.timingsMs.total >= 0);
  assert.equal(record.recallPlan, "full");
});

test("denied recall attempt still records outcome error in finally", async () => {
  const config = makeConfig(path.join(os.tmpdir(), "remnic-recall-timing-attempt-error"));
  const service = new EngramAccessService(new Orchestrator(config));
  await assert.rejects(
    service.recall({ query: "contract probe", sessionKey: "contract:probe:session", asOf: "   " }),
    /asOf/,
  );
  const records = getRecallTimings(config);
  // The attempt failed before the pipeline ran: the finally-record is the
  // only trace, with the error outcome and the monotonic total it measured.
  assert.equal(records.length, 1);
  const record = records[0]!;
  assert.match(record.requestId, REQUEST_ID_PATTERN);
  assert.equal(record.outcome, "error");
  assert.ok(Number.isFinite(record.httpTotalMs) && record.httpTotalMs >= 0);
});

test("phase-2 await fields are allowlisted, enum-bounded, and carry no extra content", () => {
  const config = makeConfig(path.join(os.tmpdir(), "remnic-recall-timing-phase2-sanitizer"));
  recordRecallTiming(config, {
    timestamp: new Date(0).toISOString(),
    namespace: "default",
    total: "9ms",
    recallPlan: "full",
    queryPolicy: "general/full",
    outcome: "aborted",
    phase2HarmonicMs: "7ms",
    phase2HarmonicStatus: "timeout",
    phase2HarmonicTotalMs: "30ms",
    phase2QuestionsMs: "2ms",
    // A status outside the enum, and a total on an await that has none, drop.
    phase2QuestionsStatus: "private user question text",
    phase2QuestionsTotalMs: "5ms",
    // Not part of the contract at all.
    phase2SecretMs: "1ms",
    phase2HarmonicQuery: "private query",
  });
  const record = getRecallTimings(config)[0];
  assert.ok(record);
  assert.equal(record.outcome, "aborted");
  assert.equal(record.phase2HarmonicMs, 7);
  assert.equal(record.phase2HarmonicStatus, "timeout");
  assert.equal(record.phase2HarmonicTotalMs, 30);
  assert.equal(record.phase2QuestionsMs, 2);
  assert.equal("phase2QuestionsStatus" in record, false);
  assert.equal("phase2QuestionsTotalMs" in record, false);
  assert.equal("phase2SecretMs" in record, false);
  assert.equal("phase2HarmonicQuery" in record, false);
});

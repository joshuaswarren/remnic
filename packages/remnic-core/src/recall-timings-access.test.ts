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
    await orchestrator.recall("private first query", "private:first:session");
    await orchestrator.recall("private second query", "private:second:session", { mode: "no_recall" });

    const denied = await fetch(url);
    assert.equal(denied.status, 401);

    const nonOperator = await fetch(url, {
      headers: {
        Authorization: "Bearer secret-token",
        "X-Engram-Principal": "reader",
      },
    });
    assert.equal(nonOperator.status, 403);

    const response = await fetch(url, {
      headers: {
        Authorization: "Bearer secret-token",
        "X-Engram-Principal": "operator",
      },
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      count: number;
      records: RecallTimingRecord[];
    };
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
    assert.deepEqual(operationOutput.result, payload);
    for (const record of payload.records) {
      assert.equal(record.namespace, "default");
      assert.ok(Number.isFinite(Date.parse(record.timestamp)));
      assert.equal(typeof record.total, "number");
      assert.ok(record.total >= 0);
      assert.equal(typeof record.recallPlan, "string");
      assert.equal(typeof record.queryPolicy, "string");
      assert.equal("query" in record, false);
      assert.equal("prompt" in record, false);
      assert.equal("sessionKey" in record, false);
      assert.equal("retrievalQuery" in record, false);
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
  assert.equal(records[0]?.total, 50);
  assert.equal(records[49]?.total, 1);
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
    total: 7,
    qmd: 3,
    qmdPost: 2,
    recallPlan: "full",
    queryPolicy: "general/full",
  });
});

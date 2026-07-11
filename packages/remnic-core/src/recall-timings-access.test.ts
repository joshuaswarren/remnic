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
  recordRecallTiming,
  type RecallTimingRecord,
} from "./recall-timings.js";

function makeConfig(memoryDir: string) {
  return parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    recallPlannerEnabled: false,
    sharedContextEnabled: false,
    initGateTimeoutMs: 1000,
  });
}

test("authenticated recall timings route returns two recalls without user-correlatable inputs", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-recall-timings-"));
  const orchestrator = new Orchestrator(makeConfig(memoryDir));
  const service = new EngramAccessService(orchestrator);
  const server = new EngramAccessHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const url = `http://${started.host}:${started.port}/engram/v1/recall/timings`;
  try {
    await orchestrator.recall("private first query", "private:first:session");
    await orchestrator.recall("private second query", "private:second:session");

    const denied = await fetch(url);
    assert.equal(denied.status, 401);

    const response = await fetch(url, {
      headers: { Authorization: "Bearer secret-token" },
    });
    assert.equal(response.status, 200);
    const records = await response.json() as RecallTimingRecord[];
    assert.equal(records.length, 2);
    const operation = getOperation("recall_timings");
    assert.ok(operation);
    const operationOutput = await operation.run({}, {
      service,
      authenticatedPrincipal: "operator",
    }) as { result: RecallTimingRecord[] };
    assert.deepEqual(operationOutput.result, records);
    for (const record of records) {
      assert.equal(record.namespace, "default");
      assert.ok(Number.isFinite(Date.parse(record.timestamp)));
      assert.match(record.total, /^\d+ms$/);
      assert.ok(Number.parseInt(record.total, 10) >= 0);
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
      total: `${index}ms`,
      recallPlan: "full",
      queryPolicy: "general/full",
    });
  }

  const records = getRecallTimings(config);
  assert.equal(records.length, 50);
  assert.equal(records[0]?.total, "50ms");
  assert.equal(records[49]?.total, "1ms");
});

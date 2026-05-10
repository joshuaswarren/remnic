import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { Orchestrator } from "../src/orchestrator.js";
import { parseConfig } from "../src/config.js";

async function makeOrchestrator(
  prefix: string,
  overrides: Record<string, unknown> = {},
): Promise<Orchestrator> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    knowledgeIndexEnabled: false,
    compoundingInjectEnabled: false,
    memoryBoxesEnabled: false,
    temporalMemoryTreeEnabled: false,
    injectQuestions: false,
    ...overrides,
  });
  return new Orchestrator(config);
}

// Recall with xrayCapture disabled (the default) must not populate the
// snapshot.  This guards the "no behavior change when flag absent"
// invariant from issue #570 PR 1.
test("getLastXraySnapshot returns null when xrayCapture flag is not set", async () => {
  const orchestrator = await makeOrchestrator("engram-xray-absent-");
  (orchestrator as any).initPromise = null;

  await orchestrator.recall("hello world", "agent:test:xray-absent");

  assert.equal(orchestrator.getLastXraySnapshot(), null);
});

// Recall with xrayCapture: true must populate a snapshot that carries
// the query text and the session/trace scope.
test("getLastXraySnapshot captures a snapshot when xrayCapture flag is true", async () => {
  const orchestrator = await makeOrchestrator("engram-xray-capture-");
  (orchestrator as any).initPromise = null;

  await orchestrator.recall(
    "capture me please",
    "agent:test:xray-capture",
    { xrayCapture: true },
  );

  const snapshot = orchestrator.getLastXraySnapshot();
  assert.ok(snapshot);
  assert.equal(snapshot.schemaVersion, "1");
  assert.equal(snapshot.query, "capture me please");
  assert.equal(snapshot.sessionKey, "agent:test:xray-capture");
  assert.ok(
    typeof snapshot.snapshotId === "string" && snapshot.snapshotId.length > 0,
    "snapshotId should be a non-empty string",
  );
  assert.ok(
    typeof snapshot.capturedAt === "number" && snapshot.capturedAt > 0,
    "capturedAt should be a positive number",
  );
  // No results for a cold-start recall with empty memory — the capture
  // path should still emit an empty results array.
  assert.deepEqual(snapshot.results, []);
});

// Snapshots are deep-copied on read.  Mutating the returned value must
// not affect a subsequent `getLastXraySnapshot()` call.
test("getLastXraySnapshot returns a deep copy", async () => {
  const orchestrator = await makeOrchestrator("engram-xray-deepcopy-");
  (orchestrator as any).initPromise = null;

  await orchestrator.recall(
    "deep copy test",
    "agent:test:xray-deepcopy",
    { xrayCapture: true },
  );

  const first = orchestrator.getLastXraySnapshot();
  assert.ok(first);
  first.results.push({
    memoryId: "fake",
    path: "/fake.md",
    servedBy: "hybrid",
    admittedBy: ["tampered"],
    scoreDecomposition: { final: 1 },
  });

  const second = orchestrator.getLastXraySnapshot();
  assert.ok(second);
  assert.deepEqual(second.results, []);
});

// clearLastXraySnapshot() resets the in-memory capture.
test("clearLastXraySnapshot resets the captured snapshot", async () => {
  const orchestrator = await makeOrchestrator("engram-xray-clear-");
  (orchestrator as any).initPromise = null;

  await orchestrator.recall(
    "clear test",
    "agent:test:xray-clear",
    { xrayCapture: true },
  );
  assert.ok(orchestrator.getLastXraySnapshot());

  orchestrator.clearLastXraySnapshot();
  assert.equal(orchestrator.getLastXraySnapshot(), null);
});

// `no_recall` planner mode returns early from recallInternal, but
// capture must still fire on that branch when the caller opted in —
// otherwise `getLastXraySnapshot()` returns a stale prior capture
// (or null) and debug surfaces silently report the wrong recall.
test("recall captures an X-ray snapshot even when mode is no_recall", async () => {
  const orchestrator = await makeOrchestrator("engram-xray-no-recall-");
  (orchestrator as any).initPromise = null;

  await orchestrator.recall(
    "no recall please",
    "agent:test:xray-no-recall",
    { xrayCapture: true, mode: "no_recall" },
  );

  const snapshot = orchestrator.getLastXraySnapshot();
  assert.ok(snapshot, "snapshot should be captured on the no_recall branch");
  assert.equal(snapshot.query, "no recall please");
  assert.equal(snapshot.sessionKey, "agent:test:xray-no-recall");
  assert.deepEqual(snapshot.results, []);
  // The no_recall branch records a single `planner-mode` filter trace
  // so downstream surfaces can render why zero results surfaced.
  assert.equal(snapshot.filters.length, 1);
  assert.equal(snapshot.filters[0]!.name, "planner-mode");
  assert.equal(snapshot.filters[0]!.reason, "no_recall");
});

// An aborted recall with `xrayCapture: true` must NOT clobber a prior
// captured snapshot.  Otherwise a timeout / cancellation racing past
// the capture site would overwrite a successful prior capture with
// partial data from the canceled call.
test("aborted recall with xrayCapture does not clobber a prior captured snapshot", async () => {
  const orchestrator = await makeOrchestrator("engram-xray-abort-");
  (orchestrator as any).initPromise = null;

  // Seed a successful capture.
  await orchestrator.recall(
    "first",
    "agent:test:xray-abort",
    { xrayCapture: true },
  );
  const captured = orchestrator.getLastXraySnapshot();
  assert.ok(captured);
  assert.equal(captured.query, "first");

  // Second recall is aborted before the capture site fires — the
  // prior snapshot must still be accessible.
  const aborted = new AbortController();
  aborted.abort();
  await orchestrator.recall(
    "aborted-second",
    "agent:test:xray-abort",
    { xrayCapture: true, abortSignal: aborted.signal },
  );

  const stillCaptured = orchestrator.getLastXraySnapshot();
  assert.ok(stillCaptured);
  assert.equal(stillCaptured.query, "first");
});

// A recall without the flag must NOT overwrite a previously captured
// snapshot.  This keeps the capture surface useful when a capturing
// caller is interleaved with non-capturing callers.
test("recall without xrayCapture does not overwrite a prior captured snapshot", async () => {
  const orchestrator = await makeOrchestrator("engram-xray-preserve-");
  (orchestrator as any).initPromise = null;

  await orchestrator.recall(
    "first",
    "agent:test:xray-preserve",
    { xrayCapture: true },
  );
  const captured = orchestrator.getLastXraySnapshot();
  assert.ok(captured);
  assert.equal(captured.query, "first");

  // Second recall does not request capture — the prior snapshot must
  // still be accessible.
  await orchestrator.recall("second", "agent:test:xray-preserve");

  const stillCaptured = orchestrator.getLastXraySnapshot();
  assert.ok(stillCaptured);
  assert.equal(stillCaptured.query, "first");
});

test("recall X-ray attaches provenance for surfaced memory results", async () => {
  const orchestrator = await makeOrchestrator("engram-xray-provenance-");
  (orchestrator as any).initPromise = null;

  await (orchestrator as any).storage.writeMemory(
    "fact",
    "The recall cache TTL is twenty minutes.",
    {
      source: "test",
      confidence: 0.92,
      tags: ["repo", "private"],
    },
  );

  await orchestrator.recall(
    "recall cache TTL",
    "agent:test:xray-provenance",
    { xrayCapture: true, mode: "full" },
  );

  const snapshot = orchestrator.getLastXraySnapshot();
  assert.ok(snapshot);
  assert.equal(snapshot.results.length, 1);
  const result = snapshot.results[0]!;
  assert.equal(result.servedBy, "recent-scan");
  const provenance = result.provenance;
  assert.ok(provenance, "surfaced memory should carry provenance");
  assert.equal(provenance.source, "test");
  assert.equal(provenance.scope, "namespace:default");
  assert.deepEqual(provenance.userContextScopes, ["repo", "private"]);
  assert.equal(provenance.retrievalReason, "served-by=recent-scan");
  assert.equal(provenance.confidence, 0.92);
  assert.equal(provenance.stale, false);
  assert.equal(provenance.corrected, false);
  assert.equal(provenance.safeToUse, false);
  assert.equal(provenance.safety, "requires-review");
  assert.ok(provenance.safetyReasons.includes("boundary-review=private"));
});

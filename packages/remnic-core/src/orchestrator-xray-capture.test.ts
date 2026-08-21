import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { buildXraySnapshot, type RecallXraySnapshot } from "./recall-xray.js";

let orchestratorSequence = 0;

function makeOrchestrator(): Orchestrator {
  orchestratorSequence += 1;
  const memoryDir = path.join(
    tmpdir(),
    `remnic-xray-capture-unit-${process.pid}-${orchestratorSequence}`,
  );
  return new Orchestrator(parseConfig({
    memoryDir,
    workspaceDir: memoryDir,
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
  }));
}

function snapshot(query: string, snapshotId: string): RecallXraySnapshot {
  return buildXraySnapshot({
    query,
    snapshotIdGenerator: () => snapshotId,
    now: () => 1,
  });
}

function setSnapshot(orchestrator: Orchestrator, value: RecallXraySnapshot): void {
  (orchestrator as unknown as { lastXraySnapshot: RecallXraySnapshot | null })
    .lastXraySnapshot = value;
}

function stubRecall(
  orchestrator: Orchestrator,
  invoke: (
    prompt: string,
    sessionKey: string | undefined,
    options: Record<string, unknown>,
  ) => Promise<string>,
): void {
  (orchestrator as unknown as { invokeRecall: typeof invoke }).invokeRecall = invoke;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("recallWithXrayCapture clears stale state and returns an owned nested clone", async () => {
  const orchestrator = makeOrchestrator();
  setSnapshot(orchestrator, snapshot("stale", "stale-id"));
  const captured = buildXraySnapshot({
    query: "normalized query",
    snapshotIdGenerator: () => "fresh-id",
    now: () => 1,
    results: [{
      memoryId: "memory-1",
      path: "memories/memory-1.md",
      servedBy: "hybrid",
      scoreDecomposition: { final: 1 },
      admittedBy: ["retrieval"],
      graphPath: ["a", "b"],
    }],
    filters: [{ name: "retrieval", considered: 1, admitted: 1 }],
  });
  stubRecall(orchestrator, async (_prompt, _sessionKey, options) => {
    assert.equal(options.xrayCapture, true);
    assert.equal(orchestrator.getLastXraySnapshot(), null);
    setSnapshot(orchestrator, captured);
    return "recall-result";
  });

  const result = await orchestrator.recallWithXrayCapture("raw query", "session");
  assert.equal(result.result, "recall-result");
  assert.deepEqual(result.snapshot, captured);
  assert.notEqual(result.snapshot, captured);

  result.snapshot!.results[0]!.admittedBy.push("tampered");
  result.snapshot!.results[0]!.graphPath!.push("tampered");
  result.snapshot!.filters[0]!.reason = "tampered";
  const stored = orchestrator.getLastXraySnapshot();
  assert.deepEqual(stored?.results[0]?.admittedBy, ["retrieval"]);
  assert.deepEqual(stored?.results[0]?.graphPath, ["a", "b"]);
  assert.equal(stored?.filters[0]?.reason, undefined);
});

test("recallWithXrayCapture serializes every consumer of one orchestrator slot", async () => {
  const orchestrator = makeOrchestrator();
  const firstGate = deferred<void>();
  const firstStarted = deferred<void>();
  const order: string[] = [];
  stubRecall(orchestrator, async (prompt) => {
    order.push(`${prompt}:start`);
    if (prompt === "first") {
      firstStarted.resolve();
      await firstGate.promise;
    }
    setSnapshot(orchestrator, snapshot(prompt, `${prompt}-id`));
    order.push(`${prompt}:end`);
    return prompt;
  });

  const first = orchestrator.recallWithXrayCapture("first");
  const second = orchestrator.recallWithXrayCapture("second");
  await firstStarted.promise;
  assert.deepEqual(order, ["first:start"]);
  firstGate.resolve();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
  assert.equal(firstResult.snapshot?.snapshotId, "first-id");
  assert.equal(secondResult.snapshot?.snapshotId, "second-id");
});

test("recallWithXrayCapture queues are independent across orchestrators", async () => {
  const firstOrchestrator = makeOrchestrator();
  const secondOrchestrator = makeOrchestrator();
  const firstGate = deferred<void>();
  let secondStarted = false;
  stubRecall(firstOrchestrator, async () => {
    await firstGate.promise;
    return "first";
  });
  stubRecall(secondOrchestrator, async () => {
    secondStarted = true;
    return "second";
  });

  const first = firstOrchestrator.recallWithXrayCapture("first");
  await secondOrchestrator.recallWithXrayCapture("second");
  assert.equal(secondStarted, true);
  firstGate.resolve();
  await first;
});

test("recallWithXrayCapture rejects a pre-aborted signal without clearing or invoking", async () => {
  const orchestrator = makeOrchestrator();
  const stale = snapshot("stale", "stale-id");
  setSnapshot(orchestrator, stale);
  const abortController = new AbortController();
  abortController.abort();
  let invoked = false;
  stubRecall(orchestrator, async () => {
    invoked = true;
    return "unexpected";
  });

  await assert.rejects(
    orchestrator.recallWithXrayCapture("aborted", undefined, {
      abortSignal: abortController.signal,
    }),
    { name: "AbortError" },
  );
  assert.equal(invoked, false);
  assert.deepEqual(orchestrator.getLastXraySnapshot(), stale);
});

test("queued abort rejects promptly while its barrier prevents a third capture overtaking", async () => {
  const orchestrator = makeOrchestrator();
  const firstGate = deferred<void>();
  const abortController = new AbortController();
  const order: string[] = [];
  stubRecall(orchestrator, async (prompt) => {
    order.push(`${prompt}:start`);
    if (prompt === "first") await firstGate.promise;
    setSnapshot(orchestrator, snapshot(prompt, `${prompt}-id`));
    order.push(`${prompt}:end`);
    return prompt;
  });

  const first = orchestrator.recallWithXrayCapture("first");
  await Promise.resolve();
  const queued = orchestrator.recallWithXrayCapture("aborted", undefined, {
    abortSignal: abortController.signal,
  });
  const third = orchestrator.recallWithXrayCapture("third");
  abortController.abort();

  await assert.rejects(queued, { name: "AbortError" });
  assert.deepEqual(order, ["first:start"]);
  firstGate.resolve();

  const [firstResult, thirdResult] = await Promise.all([first, third]);
  assert.deepEqual(order, ["first:start", "first:end", "third:start", "third:end"]);
  assert.equal(firstResult.snapshot?.snapshotId, "first-id");
  assert.equal(thirdResult.snapshot?.snapshotId, "third-id");
});

test("started abort retains ownership until recall settles", async () => {
  const orchestrator = makeOrchestrator();
  const activeGate = deferred<void>();
  const activeStarted = deferred<void>();
  const abortController = new AbortController();
  let nextStarted = false;
  stubRecall(orchestrator, async (prompt) => {
    if (prompt === "active") {
      activeStarted.resolve();
      await activeGate.promise;
      setSnapshot(orchestrator, snapshot("active", "active-id"));
    } else {
      nextStarted = true;
      setSnapshot(orchestrator, snapshot("next", "next-id"));
    }
    return prompt;
  });

  const active = orchestrator.recallWithXrayCapture("active", undefined, {
    abortSignal: abortController.signal,
  });
  await activeStarted.promise;
  abortController.abort();
  const next = orchestrator.recallWithXrayCapture("next");
  await Promise.resolve();
  assert.equal(nextStarted, false);

  activeGate.resolve();
  const activeResult = await active;
  const nextResult = await next;
  assert.equal(activeResult.snapshot?.snapshotId, "active-id");
  assert.equal(nextResult.snapshot?.snapshotId, "next-id");
});

test("failed and empty captures restore prior shared snapshot but return no stale snapshot", async () => {
  const orchestrator = makeOrchestrator();
  const prior = snapshot("prior", "prior-id");
  setSnapshot(orchestrator, prior);
  stubRecall(orchestrator, async (prompt) => {
    if (prompt === "failure") throw new Error("recall failed");
    return "empty";
  });

  await assert.rejects(
    orchestrator.recallWithXrayCapture("failure"),
    /recall failed/,
  );
  assert.equal(orchestrator.getLastXraySnapshot()?.snapshotId, "prior-id");

  const empty = await orchestrator.recallWithXrayCapture("empty");
  assert.equal(empty.snapshot, null);
  assert.equal(orchestrator.getLastXraySnapshot()?.snapshotId, "prior-id");
});

test("legacy capturing recall shares the queue and preserves its string return", async () => {
  const orchestrator = makeOrchestrator();
  const firstGate = deferred<void>();
  const order: string[] = [];
  stubRecall(orchestrator, async (prompt) => {
    order.push(`${prompt}:start`);
    if (prompt === "atomic") await firstGate.promise;
    setSnapshot(orchestrator, snapshot(prompt, `${prompt}-id`));
    order.push(`${prompt}:end`);
    return `${prompt}-result`;
  });

  const atomic = orchestrator.recallWithXrayCapture("atomic");
  await Promise.resolve();
  const legacy = orchestrator.recall("legacy", undefined, { xrayCapture: true });
  await Promise.resolve();
  assert.deepEqual(order, ["atomic:start"]);
  firstGate.resolve();

  const [atomicResult, legacyResult] = await Promise.all([atomic, legacy]);
  assert.equal(atomicResult.result, "atomic-result");
  assert.equal(legacyResult, "legacy-result");
  assert.deepEqual(order, ["atomic:start", "atomic:end", "legacy:start", "legacy:end"]);
});

test("ordinary recall remains independent and does not overwrite a captured snapshot", async () => {
  const orchestrator = makeOrchestrator();
  const captureGate = deferred<void>();
  const captureStarted = deferred<void>();
  const order: string[] = [];
  stubRecall(orchestrator, async (prompt, _sessionKey, options) => {
    order.push(prompt);
    if (prompt === "capture") {
      captureStarted.resolve();
      await captureGate.promise;
      setSnapshot(orchestrator, snapshot("capture", "capture-id"));
    }
    assert.equal(options.xrayCapture === true, prompt === "capture");
    return `${prompt}-result`;
  });

  const capture = orchestrator.recallWithXrayCapture("capture");
  await captureStarted.promise;
  const ordinary = await orchestrator.recall("ordinary");
  assert.equal(ordinary, "ordinary-result");
  assert.deepEqual(order, ["capture", "ordinary"]);
  captureGate.resolve();
  await capture;
  await orchestrator.recall("ordinary-after");
  assert.equal(orchestrator.getLastXraySnapshot()?.snapshotId, "capture-id");
});

test("recallWithXrayCapture accepts normalized snapshot queries without equality checks", async () => {
  const orchestrator = makeOrchestrator();
  stubRecall(orchestrator, async () => {
    setSnapshot(orchestrator, snapshot("daily briefing", "normalized-id"));
    return "context";
  });

  const result = await orchestrator.recallWithXrayCapture(":cron: daily briefing");
  assert.equal(result.snapshot?.query, "daily briefing");
});

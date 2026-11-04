// In-process claim drain (daemon backlog scheduler task body): the runner
// must drain a claim through the shared extraction queue WITHOUT the global
// buffer swap, group the claim's turns by captured extraction scope (exact
// pins + CURRENT policy re-applied from the original binding), keep failing
// chunks as durable retryable backlog (no drop, no side file), and leave the
// claim retryable across cancel / dead-lease adoption.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { hostname } from "node:os";
import path from "node:path";

import { Orchestrator } from "./orchestrator.js";
import { BufferDrainRunner } from "./orchestration/buffer-drain-runner.js";
import type { DrainLease } from "./storage/buffer-drain-claims.js";
import {
  cleanupDir,
  makeHarmonicLifecycleConfig,
  memoryFilesContaining,
  mkTempMemoryDir,
  singleFactResult,
  stubExtraction,
} from "./testing/orchestrator-lite.js";
import { resolveNamespaceStorageRoot } from "./namespaces/storage.js";
import type { BufferTurn, PluginConfig } from "./types.js";

function turn(content: string, sessionKey: string, timestamp = "2026-11-01T00:00:00.000Z"): BufferTurn {
  return { role: "user", content, timestamp, sessionKey };
}

interface Drainer {
  orchestrator: Orchestrator;
  runner: BufferDrainRunner;
  calls: BufferTurn[][];
  memoryDir: string;
  config: PluginConfig;
  cleanup(): Promise<void>;
}

async function makeDrainer(overrides: Record<string, unknown> = {}): Promise<Drainer> {
  const memoryDir = await mkTempMemoryDir("drain-inprocess");
  const config = makeHarmonicLifecycleConfig(memoryDir, overrides);
  const orchestrator = new Orchestrator(config);
  const calls = stubExtraction(orchestrator, (turns) => singleFactResult(`fact for ${turns[0]?.content ?? "empty"}`));
  return {
    orchestrator,
    runner: new BufferDrainRunner(orchestrator),
    calls,
    memoryDir,
    config,
    cleanup: async () => {
      await orchestrator.destroy().catch(() => undefined);
      await cleanupDir(memoryDir);
    },
  };
}

function gateOnContent(calls: BufferTurn[][], content: string): { release(): void; entered(): Promise<void> } {
  let release!: () => void;
  const enteredPromise = new Promise<void>((resolveEntered) => {
    const original = calls.push.bind(calls);
    Object.defineProperty(calls, "push", {
      value: (turns: BufferTurn[]) => {
        const out = original(turns);
        if (turns.some((t) => t.content === content)) {
          resolveEntered();
          return new Promise<void>((resolveRelease) => {
            release = resolveRelease;
          }).then(() => out);
        }
        return out;
      },
    });
  });
  return { release: () => release(), entered: () => enteredPromise };
}

function leaseFor(ownerId: string): DrainLease {
  const now = new Date().toISOString();
  return { ownerId, pid: process.pid, host: hostname(), acquiredAt: now, heartbeatAt: now, leaseMs: 60_000 };
}

test("an in-process claim drain never swaps the live buffer: concurrent live saves persist normally", async () => {
  const d = await makeDrainer();
  try {
    await d.orchestrator.buffer.addTurn("sess-a", turn("a1", "sess-a"));
    await d.orchestrator.buffer.addTurn("sess-b", turn("b1", "sess-b"));
    await d.orchestrator.buffer.save();
    assert.equal(await d.runner.claim("sess-a", "drain-1"), true);

    const gate = gateOnContent(d.calls, "a1");
    const draining = d.runner.drainSession("sess-a", { ownerId: "drain-1" });
    await gate.entered();

    // While the claim drain holds the extraction open, the foreground owner
    // keeps capturing: a live save must land in LIVE session storage, never
    // inside the claim's storage view.
    await d.orchestrator.buffer.addTurn("sess-b", turn("b2", "sess-b", "2026-11-01T00:01:00.000Z"));
    await d.orchestrator.buffer.save();
    const persisted = await d.orchestrator.storage.loadBuffer();
    assert.ok(
      persisted.entries?.["sess-b"]?.turns.some((t) => t.content === "b2"),
      "the concurrent live save persists through live storage",
    );
    const claim = await d.runner.claims.load("sess-a");
    assert.deepEqual(
      claim?.entry.turns.map((t) => t.content),
      ["a1"],
      "the claim holds only its own session's turns",
    );

    gate.release();
    const outcome = await draining;
    assert.equal(outcome.status, "drained");
  } finally {
    await d.cleanup();
  }
});

const NAMESPACED: Record<string, unknown> = {
  namespacesEnabled: true,
  defaultNamespace: "default",
  principalFromSessionKeyMode: "prefix",
  namespacePolicies: [
    { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    { name: "default", readPrincipals: ["default"], writePrincipals: ["default"] },
  ],
};

test("a mixed-scope claim drains each group under its exact captured scope", async () => {
  const d = await makeDrainer(NAMESPACED);
  try {
    const pinned: BufferTurn = {
      ...turn("pinned capture", "sess-mixed"),
      acceptedCapture: true,
      writeNamespaceOverride: "alice",
      principalOverride: "alice",
    };
    await d.orchestrator.buffer.addTurn("sess-mixed", pinned);
    await d.orchestrator.buffer.addTurn("sess-mixed", turn("native one", "sess-mixed", "2026-11-01T00:01:00.000Z"));
    await d.orchestrator.buffer.save();
    assert.equal(await d.runner.claim("sess-mixed", "drain-1"), true);

    const outcome = await d.runner.drainSession("sess-mixed", { ownerId: "drain-1" });
    assert.equal(outcome.status, "drained", "the whole mixed claim drains");
    assert.equal(outcome.turnsRemaining, 0);
    assert.ok(d.calls.length >= 2, "scope groups extract separately");
    assert.deepEqual(
      d.calls.find((turns) => turns.some((t) => t.content === "pinned capture"))?.map((t) => t.content),
      ["pinned capture"],
      "the pinned group extracts alone under its own scope",
    );
    assert.deepEqual(
      d.calls.find((turns) => turns.some((t) => t.content === "native one"))?.map((t) => t.content),
      ["native one"],
      "the native group extracts alone",
    );
    // Durable outputs land in the EXACT captured namespaces.
    const aliceRoot = await resolveNamespaceStorageRoot(d.config, "alice");
    const defaultRoot = await resolveNamespaceStorageRoot(d.config, "default");
    assert.ok((await memoryFilesContaining(aliceRoot, "fact for pinned capture")).length > 0, "the pinned fact persists in alice");
    assert.ok(
      (await memoryFilesContaining(defaultRoot, "fact for native one")).length > 0,
      "the native fact persists in the default namespace",
    );
  } finally {
    await d.cleanup();
  }
});

test("a policy-denied group stays pending, is reported, and never blocks other groups", async () => {
  // Namespaces DISABLED: the pinned non-default namespace can no longer be
  // honored, so the pinned group is denied while native work still drains.
  const d = await makeDrainer({ namespacesEnabled: false, defaultNamespace: "default" });
  try {
    const pinned: BufferTurn = {
      ...turn("pinned capture", "sess-denied"),
      acceptedCapture: true,
      writeNamespaceOverride: "alice",
      principalOverride: "alice",
    };
    await d.orchestrator.buffer.addTurn("sess-denied", pinned);
    await d.orchestrator.buffer.addTurn("sess-denied", turn("native one", "sess-denied", "2026-11-01T00:01:00.000Z"));
    await d.orchestrator.buffer.save();
    assert.equal(await d.runner.claim("sess-denied", "drain-1"), true);

    const outcome = await d.runner.drainSession("sess-denied", { ownerId: "drain-1" });
    assert.equal(outcome.status, "deferred", "denied backlog keeps the drain open");
    assert.deepEqual(outcome.denied, [{ reason: "pinned_namespace_unavailable", turns: 1 }]);
    assert.equal(outcome.reason, "pinned_namespace_unavailable");
    assert.equal(outcome.turnsRemaining, 1, "the denied turn stays pending in the claim");
    const claim = await d.runner.claims.load("sess-denied");
    assert.deepEqual(claim?.entry.turns.map((t) => t.content), ["pinned capture"]);
    const defaultRoot = await resolveNamespaceStorageRoot(d.config, "default");
    assert.ok(
      (await memoryFilesContaining(defaultRoot, "fact for native one")).length > 0,
      "the native group drained despite the denial",
    );
  } finally {
    await d.cleanup();
  }
});

test("a repeatedly failing group never drops: the claim keeps every turn and the lease is released", async () => {
  const d = await makeDrainer();
  try {
    // Fail ONLY the failing session's extraction, once; others succeed.
    const original = d.calls.push.bind(d.calls);
    let failuresLeft = 1;
    Object.defineProperty(d.calls, "push", {
      value: (turns: BufferTurn[]) => {
        if (turns.some((t) => t.sessionKey === "sess-fail") && failuresLeft-- > 0) throw new Error("provider down");
        return original(turns);
      },
    });
    await d.orchestrator.buffer.addTurn("sess-fail", turn("f1", "sess-fail"));
    await d.orchestrator.buffer.addTurn("sess-fail", turn("f2", "sess-fail", "2026-11-01T00:01:00.000Z"));
    await d.orchestrator.buffer.save();
    assert.equal(await d.runner.claim("sess-fail", "drain-1"), true);

    const outcome = await d.runner.drainSession("sess-fail", { ownerId: "drain-1" });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.turnsRemaining, 2, "both turns stay as durable retryable backlog");
    const claim = await d.runner.claims.load("sess-fail");
    assert.deepEqual(claim?.entry.turns.map((t) => t.content), ["f1", "f2"]);
    assert.equal(existsSync(d.runner.claims.leasePathForTest("sess-fail")), false, "the lease is released for retry");
    assert.equal(
      existsSync(path.join(d.memoryDir, "dropped")),
      false,
      "no side-file recovery copy was written",
    );
    // And the retry genuinely drains it.
    const retry = await d.runner.drainSession("sess-fail", { ownerId: "drain-1" });
    assert.equal(retry.status, "drained");
  } finally {
    await d.cleanup();
  }
});

test("cancelling mid-drain keeps the claim retryable; a rerun finishes it", async () => {
  const d = await makeDrainer();
  try {
    await d.orchestrator.buffer.addTurn("sess-cancel", turn("c1", "sess-cancel"));
    await d.orchestrator.buffer.save();
    assert.equal(await d.runner.claim("sess-cancel", "drain-1"), true);

    const controller = new AbortController();
    const gate = gateOnContent(d.calls, "c1");
    const draining = d.runner.drainSession("sess-cancel", { ownerId: "drain-1", signal: controller.signal });
    await gate.entered();
    controller.abort();
    gate.release();
    const outcome = await draining;
    assert.notEqual(outcome.status, "drained", "an aborted run does not report drained");
    assert.equal(outcome.turnsRemaining, 1, "the turn stays claimed");
    assert.equal(existsSync(d.runner.claims.leasePathForTest("sess-cancel")), false, "the lease is released");

    const rerun = await d.runner.drainSession("sess-cancel", { ownerId: "drain-1" });
    assert.equal(rerun.status, "drained", "the rerun drains the retained claim");
    assert.ok((await d.runner.claims.load("sess-cancel")) === null || (await d.runner.claims.load("sess-cancel"))?.entry.turns.length === 0);
  } finally {
    await d.cleanup();
  }
});

test("an abandoned claim with a dead owner's lease is adopted and drained", async () => {
  const d = await makeDrainer();
  try {
    await d.orchestrator.buffer.addTurn("sess-dead", turn("d1", "sess-dead"));
    await d.orchestrator.buffer.save();
    const deadLease: DrainLease = { ...leaseFor("dead-worker"), pid: 999_999_999 };
    assert.equal(await d.runner.claims.claimFromSessionFile("sess-dead", deadLease), "claimed");

    const outcome = await d.runner.drainSession("sess-dead", { ownerId: "daemon-drain-1" });
    assert.equal(outcome.status, "drained", "the dead owner's claim is taken over and drained");
    assert.equal(d.calls.length, 1);
  } finally {
    await d.cleanup();
  }
});

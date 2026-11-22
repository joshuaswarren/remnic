import assert from "node:assert/strict";
import test from "node:test";

import { ReplayAdmissionRefusedError, StorageTargetRequiredError } from "../buffer-admission.js";
import type { AddTurnOutcome } from "../buffer-types.js";
import { SmartBuffer } from "../buffer.js";
import { parseConfig } from "../config.js";
import type { BufferEntryState, BufferState, BufferTurn, PluginConfig } from "../types.js";
import { ingestReplayBatchBuffered } from "./turn-ingestion-buffered.js";
import type { TurnIngestionDeps } from "./turn-ingestion.js";

type Deps = Pick<TurnIngestionDeps, "config" | "buffer" | "lcmEngine" | "queueBufferedExtraction">;
type OutcomeRow = { bufferKey: string; turn: BufferTurn; outcome: AddTurnOutcome };
type TurnBatch = readonly { bufferKey: string; turns: readonly BufferTurn[] }[];
type QueueOpts = NonNullable<Parameters<Deps["queueBufferedExtraction"]>[2]>;
type FlushOpts = Parameters<StubBuffer["flushPendingSave"]>[0];
type CaptureCalls = { flushArgs: FlushOpts[] };

interface StubBuffer {
  addTurnsBounded(batches: readonly { bufferKey: string; turns: readonly BufferTurn[] }[]): Promise<OutcomeRow[] | null>;
  addTurnsBoundedForObserveReplay(
    batches: readonly { bufferKey: string; turns: readonly BufferTurn[] }[],
    admissionKey: string,
  ): Promise<OutcomeRow[] | null | "duplicate">;
  flushPendingSave(opts?: { throwOnFailure?: boolean }): Promise<void>;
}

function turn(content: string): BufferTurn {
  return { role: "user", content, timestamp: "2026-11-19T00:00:00.000Z" };
}

function okRows(batches: readonly { bufferKey: string; turns: readonly BufferTurn[] }[]): OutcomeRow[] {
  return batches.flatMap(({ bufferKey, turns }) =>
    turns.map((t) => ({ bufferKey, turn: t, outcome: { decision: "keep_buffering" } satisfies AddTurnOutcome })),
  );
}

function depsFor(overrides: {
  config?: PluginConfig;
  buffer?: Partial<StubBuffer>;
  lcmEngine?: Deps["lcmEngine"];
  queueBufferedExtraction?: Deps["queueBufferedExtraction"];
} = {}) {
  const calls: CaptureCalls = { flushArgs: [] };
  const buffer: StubBuffer = {
    addTurnsBounded: async (batches) => okRows(batches),
    addTurnsBoundedForObserveReplay: async (batches) => okRows(batches),
    flushPendingSave: async (opts) => {
      calls.flushArgs.push(opts);
    },
    ...overrides.buffer,
  };
  // SAFETY: the stub buffer implements only the three methods the buffered path calls.
  const deps = {
    config: overrides.config ?? parseConfig({ memoryDir: "/tmp/remnic-buffered-test" }),
    buffer,
    lcmEngine: overrides.lcmEngine ?? null,
    queueBufferedExtraction: overrides.queueBufferedExtraction ?? (async () => {}),
  } as Deps;
  return { deps, buffer, calls };
}

function configWithoutStorageTarget(): PluginConfig {
  const config = parseConfig({ memoryDir: "/tmp/remnic-buffered-test" });
  // SAFETY: removing the default namespace is the scenario under test.
  (config as { defaultNamespace?: string }).defaultNamespace = undefined;
  return config;
}

test("buffered ingest: no resolvable write target throws StorageTargetRequiredError", async () => {
  const { deps } = depsFor({ config: configWithoutStorageTarget() });

  await assert.rejects(
    ingestReplayBatchBuffered(deps, new Map([["s1", [turn("a")]]]), {}),
    StorageTargetRequiredError,
  );
});

test("buffered ingest: writeNamespaceOverride pins every turn and wins over the default namespace", async () => {
  let seenBatches: { bufferKey: string; turns: readonly BufferTurn[] }[] = [];
  const { deps } = depsFor({
    buffer: {
      addTurnsBounded: async (batches) => {
        seenBatches = batches.map((b) => ({ bufferKey: b.bufferKey, turns: b.turns }));
        return okRows(batches);
      },
    },
  });

  await ingestReplayBatchBuffered(deps, new Map([["s1", [turn("a"), turn("b")]]]), {
    writeNamespaceOverride: "ns-work",
  });

  assert.deepEqual(seenBatches[0]?.turns.map((t) => t.writeNamespaceOverride), ["ns-work", "ns-work"]);
  assert.ok(seenBatches[0]?.turns.every((t) => t.acceptedCapture === true));
});

test("buffered ingest: scope pins (principal, scope plan, coding context) are carried onto turns", async () => {
  let seenBatches: { bufferKey: string; turns: readonly BufferTurn[] }[] = [];
  const { deps } = depsFor({
    buffer: {
      addTurnsBounded: async (batches) => {
        seenBatches = batches.map((b) => ({ bufferKey: b.bufferKey, turns: b.turns }));
        return okRows(batches);
      },
    },
  });
  // SAFETY: the stub path never reads these positional arguments.
  const scopeProfileWritePlan = { writeNamespace: "ns-scoped" } as never;
  // SAFETY: same placeholder-only argument.
  const codingContext = { projectId: "p1" } as never;

  await ingestReplayBatchBuffered(deps, new Map([["s1", [turn("a")]]]), {
    writeNamespaceOverride: "ns-scoped",
    principalOverride: "agent-1",
    scopeProfileWritePlan,
    codingContext,
  });

  const pinned = seenBatches[0]?.turns[0];
  assert.equal(pinned?.principalOverride, "agent-1");
  assert.equal(pinned?.scopeProfileWritePlan, scopeProfileWritePlan);
  assert.equal(pinned?.codingContext, codingContext);
});

test("buffered ingest: an idempotency key routes to the observe-replay admission and 'duplicate' returns early", async () => {
  const { deps, calls } = depsFor({
    buffer: { addTurnsBoundedForObserveReplay: async () => "duplicate" },
  });
  let replayKey: string | undefined;
  // SAFETY: the stub narrows the interface signature to only the replay-key observation this test makes.
  deps.buffer.addTurnsBoundedForObserveReplay = (async (_b: TurnBatch, key: string) => {
    replayKey = key;
    return "duplicate";
    // SAFETY: same narrowing as above.
  }) as never;

  await ingestReplayBatchBuffered(deps, new Map([["s1", [turn("a")]]]), {
    writeNamespaceOverride: "ns-work",
    bufferAdmissionIdempotencyKey: "  replay-key-1  ",
  });

  assert.equal(replayKey, "replay-key-1");
  assert.equal(calls.flushArgs.length, 0, "a duplicate never reaches the save flush");
});

test("buffered ingest: admission refusal throws ReplayAdmissionRefusedError", async () => {
  const { deps } = depsFor({ buffer: { addTurnsBounded: async () => null } });

  await assert.rejects(
    ingestReplayBatchBuffered(deps, new Map([["s1", [turn("a")]]]), { writeNamespaceOverride: "ns-work" }),
    ReplayAdmissionRefusedError,
  );
});

test("buffered ingest: accepted batches flush the pending save and queue non-buffering outcomes", async () => {
  const queued: { turns: readonly BufferTurn[]; opts: QueueOpts }[] = [];
  const extractionTurn = turn("extracted");
  const { deps, calls } = depsFor({
    buffer: {
      addTurnsBounded: async (batches) =>
        batches.map(({ bufferKey, turns }) => ({
          bufferKey,
          turn: turns[0]!,
          outcome: { decision: "extract_now", extractionTurns: [extractionTurn] } satisfies AddTurnOutcome,
        })),
    },
    // SAFETY: the stub narrows the queue signature to the capture this test makes.
    queueBufferedExtraction: (async (turns: BufferTurn[], _reason: "trigger_mode" | "heartbeat_observer", opts: QueueOpts) => {
      queued.push({ turns, opts });
      // SAFETY: same narrowing as above.
    }) as never,
  });

  await ingestReplayBatchBuffered(deps, new Map([["s1", [turn("a")]]]), { writeNamespaceOverride: "ns-work" });

  assert.deepEqual(calls.flushArgs, [{ throwOnFailure: true }]);
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0]?.turns, [extractionTurn]);
  assert.equal(queued[0]?.opts.bufferKey, "s1");
});

test("buffered ingest: keep_buffering outcomes queue nothing", async () => {
  let queued = 0;
  const { deps } = depsFor({
    // SAFETY: the counter stub takes no arguments.
    queueBufferedExtraction: (async () => {
      queued++;
      // SAFETY: same narrowing as above.
    }) as never,
  });

  await ingestReplayBatchBuffered(deps, new Map([["s1", [turn("a")]]]), { writeNamespaceOverride: "ns-work" });

  assert.equal(queued, 0);
});

test("buffered ingest: LCM archive observes raw turns per session and honors archiveLcm:false", async () => {
  const observed: { bufferKey: string; messages: unknown[] }[] = [];
  // SAFETY: the stub implements only the enabled flag and observeMessages the buffered path calls.
  const lcmEngine = {
    enabled: true,
    observeMessages: async (bufferKey: string, messages: unknown[]) => {
      observed.push({ bufferKey, messages });
    },
  } as Deps["lcmEngine"];
  const { deps } = depsFor({ lcmEngine });

  const bySession = new Map([
    ["s1", [turn("a1")]],
    ["s2", [turn("b1"), turn("b2")]],
  ]);
  await ingestReplayBatchBuffered(deps, bySession, { writeNamespaceOverride: "ns-work" });
  assert.deepEqual(
    observed.map((o) => ({ key: o.bufferKey, n: o.messages.length })),
    [
      { key: "s1", n: 1 },
      { key: "s2", n: 2 },
    ],
  );

  observed.length = 0;
  await ingestReplayBatchBuffered(deps, bySession, { writeNamespaceOverride: "ns-work", archiveLcm: false });
  assert.equal(observed.length, 0);
});

function realBufferDeps(config: PluginConfig, entries: Record<string, BufferEntryState>) {
  const initial: BufferState = { turns: [], lastExtractionAt: null, extractionCount: 0, entries };
  const storage = { loadBuffer: async () => structuredClone(initial), saveBuffer: async () => {} };
  // SAFETY: the stub implements the load/save surface SmartBuffer reads; the cast only satisfies StorageManager.
  const buffer = new SmartBuffer(config, storage as never);
  const deps: Deps = { config, buffer, lcmEngine: null, queueBufferedExtraction: async () => {} };
  return deps;
}

function heldTurns(sessionKey: string, count: number): BufferTurn[] {
  return Array.from({ length: count }, (_, i) => ({ ...turn(`held ${i}`), sessionKey, acceptedCapture: true }));
}

test("buffered ingest: a session at its turn cap is refused with the per-session turn cap reason, not entry capacity", async () => {
  const config = parseConfig({ memoryDir: "/tmp/remnic-buffered-test", bufferSaveDebounceMs: 0, bufferMaxTurnsPerSession: 4 });
  const deps = realBufferDeps(config, {
    "pi:full": { turns: heldTurns("pi:full", 4), lastExtractionAt: null, extractionCount: 0 },
  });

  await assert.rejects(
    ingestReplayBatchBuffered(deps, new Map([["pi:full", [turn("one too many")]]]), { writeNamespaceOverride: "ns-work" }),
    (err: Error) => {
      assert.ok(err instanceof ReplayAdmissionRefusedError, "still the retryable admission class");
      assert.match(err.message, /per-session turn cap \(4\)/);
      assert.match(err.message, /pi:full/);
      assert.doesNotMatch(err.message, /entry capacity/);
      return true;
    },
  );
});

test("buffered ingest: a new session refused at the session-entry cap keeps the entry capacity reason", async () => {
  const config = parseConfig({ memoryDir: "/tmp/remnic-buffered-test", bufferSaveDebounceMs: 0, bufferMaxSessions: 3 });
  const deps = realBufferDeps(config, {
    "pi:a": { turns: heldTurns("pi:a", 1), lastExtractionAt: null, extractionCount: 0 },
    "pi:b": { turns: heldTurns("pi:b", 1), lastExtractionAt: null, extractionCount: 0 },
  });

  await assert.rejects(
    ingestReplayBatchBuffered(deps, new Map([["pi:new", [turn("new session")]]]), { writeNamespaceOverride: "ns-work" }),
    (err: Error) => {
      assert.ok(err instanceof ReplayAdmissionRefusedError);
      assert.match(err.message, /session-entry cap \(3\)/);
      assert.doesNotMatch(err.message, /per-session turn cap/);
      return true;
    },
  );
});

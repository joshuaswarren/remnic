import assert from "node:assert/strict";
import test from "node:test";

import { ReplayAdmissionRefusedError, StorageTargetRequiredError } from "../buffer-admission.js";
import type { AddTurnOutcome } from "../buffer-types.js";
import { parseConfig } from "../config.js";
import type { BufferTurn, PluginConfig } from "../types.js";
import { ingestReplayBatchBuffered } from "./turn-ingestion-buffered.js";
import type { TurnIngestionDeps } from "./turn-ingestion.js";

type Deps = Pick<TurnIngestionDeps, "config" | "buffer" | "lcmEngine" | "queueBufferedExtraction">;
type OutcomeRow = { bufferKey: string; turn: BufferTurn; outcome: AddTurnOutcome };

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
    turns.map((t) => ({ bufferKey, turn: t, outcome: { decision: "keep_buffering" } as AddTurnOutcome })),
  );
}

function depsFor(overrides: {
  config?: PluginConfig;
  buffer?: Partial<StubBuffer>;
  lcmEngine?: unknown;
  queueBufferedExtraction?: (...args: unknown[]) => Promise<void>;
} = {}): { deps: Deps; buffer: StubBuffer; calls: { flushArgs: unknown[] } } {
  const calls = { flushArgs: [] as unknown[] };
  const buffer: StubBuffer = {
    addTurnsBounded: async (batches) => okRows(batches),
    addTurnsBoundedForObserveReplay: async (batches) => okRows(batches),
    flushPendingSave: async (opts) => {
      calls.flushArgs.push(opts);
    },
    ...overrides.buffer,
  };
  const deps = {
    config: overrides.config ?? parseConfig({ memoryDir: "/tmp/remnic-buffered-test" }),
    buffer,
    lcmEngine: overrides.lcmEngine ?? null,
    queueBufferedExtraction: overrides.queueBufferedExtraction ?? (async () => {}),
  } as unknown as Deps;
  return { deps, buffer, calls };
}

function configWithoutStorageTarget(): PluginConfig {
  const config = parseConfig({ memoryDir: "/tmp/remnic-buffered-test" });
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
  const scopeProfileWritePlan = { writeNamespace: "ns-scoped" } as never;
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
  deps.buffer.addTurnsBoundedForObserveReplay = (async (_b: unknown, key: string) => {
    replayKey = key;
    return "duplicate";
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
  const queued: { turns: readonly BufferTurn[]; opts: Record<string, unknown> }[] = [];
  const extractionTurn = turn("extracted");
  const { deps, calls } = depsFor({
    buffer: {
      addTurnsBounded: async (batches) =>
        batches.map(({ bufferKey, turns }) => ({
          bufferKey,
          turn: turns[0]!,
          outcome: { decision: "extract_now", extractionTurns: [extractionTurn] } as AddTurnOutcome,
        })),
    },
    queueBufferedExtraction: (async (turns: BufferTurn[], _mode: string, opts: Record<string, unknown>) => {
      queued.push({ turns, opts });
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
    queueBufferedExtraction: (async () => {
      queued++;
    }) as never,
  });

  await ingestReplayBatchBuffered(deps, new Map([["s1", [turn("a")]]]), { writeNamespaceOverride: "ns-work" });

  assert.equal(queued, 0);
});

test("buffered ingest: LCM archive observes raw turns per session and honors archiveLcm:false", async () => {
  const observed: { bufferKey: string; messages: unknown[] }[] = [];
  const lcmEngine = {
    enabled: true,
    observeMessages: async (bufferKey: string, messages: unknown[]) => {
      observed.push({ bufferKey, messages });
    },
  };
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

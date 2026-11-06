/**
 * Local reproducible memory measurement for the extraction-queue retention
 * flaw and its fix (controlled workload; NOT a CI gate).
 *
 * Workload: real SmartBuffer (every_n, bufferMaxTurns=1) + real
 * TurnIngestionCoordinator + real ExtractionQueueCoordinator (concurrency 1)
 * with a drain blocked on a gate — the production OOM shape (LLM latency
 * exceeds trigger cadence). Every buffered turn then re-triggers extraction
 * and enqueues a FULL prefix snapshot of the buffer.
 *
 * Reports, per size (run with `node --expose-gc`):
 *   heapGrowthWhileQueued — retained heap with all snapshots queued (forced
 *     GC before baseline and measurement);
 *   queuedTailRefs / queuedTotalRefs — distinct reference slots retained by
 *     the shared-chain registry vs the reference slots an un-shared copy per
 *     snapshot would retain (the quadratic term main pays).
 * Fits the heap scaling exponent across 250→2000 turns.
 *
 * Usage:
 *   node --expose-gc ./node_modules/.bin/tsx scripts/measure-extraction-queue-retention.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../packages/remnic-core/src/config.js";
import { SmartBuffer } from "../packages/remnic-core/src/buffer.js";
import type { BufferState } from "../packages/remnic-core/src/types.js";
import type { CorrectionService } from "../packages/remnic-core/src/correction/correction-service.js";
import type { StorageManager } from "../packages/remnic-core/src/index.js";
import { SessionObserverState } from "../packages/remnic-core/src/session-observer-state.js";
import { TranscriptManager } from "../packages/remnic-core/src/transcript.js";
import { queueBufferedCaptureScopeGroups } from "../packages/remnic-core/src/orchestration/extraction-task-queueing.js";
import { ExtractionQueueCoordinator } from "../packages/remnic-core/src/orchestration/extraction-queue-coordinator.js";
import {
  TurnIngestionCoordinator,
  type TurnIngestionDeps,
} from "../packages/remnic-core/src/orchestration/turn-ingestion.js";

class FakeStorage {
  constructor(private readonly initial: BufferState) {}
  async loadBuffer(): Promise<BufferState> {
    return structuredClone(this.initial);
  }
  async saveBuffer(): Promise<void> {}
}


interface Sample {
  turns: number;
  heapGrowthMb: number;
  tailRefs: number;
  totalRefs: number;
}

async function pumpAndMeasure(turnCount: number, turnBytes: number): Promise<Sample> {
  // SAFETY: gc is only defined under node --expose-gc; absent means the
  // process keeps default GC and the heap numbers are noisier.
  const globalWithGc = globalThis as { gc?: () => void };
  globalWithGc.gc?.();
  const before = process.memoryUsage().heapUsed;

  const buffer = new SmartBuffer(
    parseConfig({ triggerMode: "every_n", bufferMaxTurns: 1, bufferSaveDebounceMs: 0 }),
    // SAFETY: FakeStorage implements the storage seam SmartBuffer uses.
    new FakeStorage({ turns: [], lastExtractionAt: null, extractionCount: 0 }) as never,
  );
  const queue = new ExtractionQueueCoordinator(1);
  const { promise: gate, resolve: openGate } = Promise.withResolvers<void>();
  let coordinatorRef: TurnIngestionCoordinator | undefined;
  // SAFETY: every TurnIngestionDeps member is present with a stub; the
  // assertion bridges throwing stubs and the unused TranscriptManager
  // surface to the dependency interface.
  const deps = {
    buffer,
    config: parseConfig({ triggerMode: "every_n", bufferMaxTurns: 1 }),
    bulkImportWriteNamespace: () => "default",
    extractionQueueCoordinator: queue,
    heartbeatObserverChains: new Map<string, Promise<void>>(),
    lcmEngine: null,
    passiveCorrectionDedup: new Set<string>(),
    passiveCorrectionTelemetry: {
      detected: 0, queued: 0, autoApplied: 0, suppressedReasonCounts: {},
    },
    queueBufferedExtraction: (
      ...args: Parameters<TurnIngestionDeps["queueBufferedExtraction"]>
    ): Promise<void> => {
      const coordinator = coordinatorRef;
      if (!coordinator) throw new Error("coordinator missing");
      return coordinator.queueBufferedExtraction(...args);
    },
    runExtraction: async () => {
      await gate;
      return { status: "persisted" as const, persistedCount: 0, durableOutputCount: 0 };
    },
    sessionObserver: { observe: async () => ({ triggered: false, deltaBytes: 0, deltaTokens: 0 }) },
    shouldQueueExtraction: () => true,
    getStorage: async () => { throw new Error("unexpected"); },
    resolveMemoryIdOrHandle: () => { throw new Error("unexpected"); },
    // SAFETY: transcript surface is unused by this workload.
    transcript: {} as never,
    passiveCorrectionService: () => { throw new Error("unexpected"); },
  } as TurnIngestionDeps;
  const coordinator = new TurnIngestionCoordinator(deps);
  coordinatorRef = coordinator;

  for (let index = 1; index <= turnCount; index += 1) {
    await coordinator.processTurn("user", `${"y".repeat(turnBytes)}#${index}`, "bench");
  }
  globalWithGc.gc?.();
  globalWithGc.gc?.();
  const whileQueued = process.memoryUsage();
  // Verified-accumulation assertions: the gate keeps the drain blocked, so
  // the first task runs synchronously and every later trigger must still be
  // queued. If these fail the workload is not exercising the stall shape and
  // its numbers are void.
  assert.equal(queue.length, turnCount - 1, "blocked drain: all but the first task stay queued");
  assert.equal(queue.isProcessing, true, "first task holds the worker");
  const verifiedStats = coordinator.snapshotSharing?.stats();
  if (verifiedStats) {
    assert.equal(verifiedStats.queuedNodes, turnCount, "one chain node per accepted trigger");
    assert.equal(verifiedStats.queuedTailRefs, turnCount, "distinct refs equal the union while stalled");
    assert.equal(verifiedStats.queuedTotalRefs, (turnCount * (turnCount + 1)) / 2, "unshared refs equal the prefix-snapshot sum");
  }
  console.log(`  queueLen=${queue.length} heapUsed=${(whileQueued.heapUsed / 1e6).toFixed(1)}MB heapTotal=${(whileQueued.heapTotal / 1e6).toFixed(1)}MB rss=${(whileQueued.rss / 1e6).toFixed(1)}MB`);
  const growthMb = (whileQueued.heapUsed - before) / 1e6;
  const stats = verifiedStats ?? { queuedNodes: 0, queuedTailRefs: 0, queuedTotalRefs: 0 };
  openGate();
  await queue.waitForIdle(120_000);
  globalWithGc.gc?.();
  const after = process.memoryUsage().heapUsed;

  const residualMb = (after - before) / 1e6;
  const drainedStats = coordinator.snapshotSharing?.stats();
  if (drainedStats) {
    assert.equal(drainedStats.queuedNodes, 0, "registry empties after the drain");
  }
  console.log(
    `turns=${String(turnCount).padStart(5)}  heapGrowthWhileQueued=${growthMb.toFixed(1)}MB  ` +
      `refs: distinct=${stats.queuedTailRefs} unshared=${stats.queuedTotalRefs} nodes=${stats.queuedNodes}  ` +
      `residualAfterDrain=${residualMb.toFixed(1)}MB`,
  );
  return { turns: turnCount, heapGrowthMb: growthMb, tailRefs: stats.queuedTailRefs, totalRefs: stats.queuedTotalRefs };
}

const turnBytes = 2048;
const sizes = [250, 500, 1000, 2000];
const samples: Sample[] = [];
for (const size of sizes) {
  samples.push(await pumpAndMeasure(size, turnBytes));
}
const first = samples[0];
assert.ok(first, "first sample recorded");
const last = samples[samples.length - 1];
assert.ok(last, "last sample recorded");
const doublings = Math.log2(last.turns / first.turns);
const heapExponent = Math.log2(last.heapGrowthMb / first.heapGrowthMb) / doublings;
const refExponent = Math.log2(last.totalRefs / first.totalRefs) / doublings;
const tailExponent = Math.log2(last.tailRefs / first.tailRefs) / doublings;
console.log(
  `scaling exponents 250→2000: heap=${heapExponent.toFixed(2)}  unsharedRefs=${refExponent.toFixed(2)}  distinctRefs=${tailExponent.toFixed(2)}`,
);

// ── Accepted-capture QUEUE path only (queueBufferedCaptureScopeGroups with
// namespace-pinned acceptedCapture turns, repeated observes of an unchanged
// buffer). NOT end-to-end observe evidence: this workload excludes the
// access-observe admission surface (addTurnBounded, acceptance boundary,
// ReplayAdmissionRefusedError) and PendingObserveExtractionTracker — the
// tracker retention term HeapRepro measured lives there and is OUT OF SCOPE
// for these numbers.
{
  // SAFETY: gc is only defined under node --expose-gc; absent means noisier
  // heap numbers.
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const observeDepth = 300;
  const memoryDir = mkdtempSync(join(tmpdir(), "remnic-observe-ingress-"));
  const storage = new FakeStorage({ turns: [], lastExtractionAt: null, extractionCount: 0 });
  const buffer = new SmartBuffer(
    parseConfig({ triggerMode: "every_n", bufferMaxTurns: 10_000, bufferSaveDebounceMs: 0, memoryDir }),
    storage,
  );
  const queue = new ExtractionQueueCoordinator(1);
  const { promise: gate, resolve: openGate } = Promise.withResolvers<void>();
  let coordinatorRef: TurnIngestionCoordinator | undefined;
  const config = parseConfig({
    triggerMode: "every_n",
    bufferMaxTurns: 10_000,
    memoryDir,
    namespacesEnabled: true,
    namespacePolicies: [{ name: "ns-observe", readPrincipals: ["*"], writePrincipals: ["principal-observe"] }],
  });
  // SAFETY: every TurnIngestionDeps member is present with a stub; the
  // assertion bridges throwing stubs to the dependency interface.
  const deps = {
    buffer,
    config,
    getStorage: async (): Promise<StorageManager> => {
      throw new Error("unexpected getStorage");
    },
    bulkImportWriteNamespace: () => "default",
    extractionQueueCoordinator: queue,
    heartbeatObserverChains: new Map<string, Promise<void>>(),
    lcmEngine: null,
    passiveCorrectionDedup: new Set<string>(),
    passiveCorrectionService: (): CorrectionService => {
      throw new Error("unexpected passiveCorrectionService");
    },
    passiveCorrectionTelemetry: { detected: 0, queued: 0, autoApplied: 0, suppressedReasonCounts: {} },
    queueBufferedExtraction: (
      ...args: Parameters<TurnIngestionDeps["queueBufferedExtraction"]>
    ): Promise<void> => {
      const coordinator = coordinatorRef;
      assert.ok(coordinator, "coordinator missing");
      return coordinator.queueBufferedExtraction(...args);
    },
    resolveMemoryIdOrHandle: () => {
      throw new Error("unexpected resolveMemoryIdOrHandle");
    },
    runExtraction: async () => {
      await gate;
      return { status: "completed" as const, persistedCount: 0, durableOutputCount: 0 };
    },
    sessionObserver: new SessionObserverState({ memoryDir, debounceMs: 0, bands: [] }),
    shouldQueueExtraction: () => true,
    transcript: new TranscriptManager(config),
  } as TurnIngestionDeps;
  const coordinator = new TurnIngestionCoordinator(deps);
  coordinatorRef = coordinator;

  const acceptedGroup: BufferTurn[] = [
    { role: "user", content: `${"z".repeat(2048)}#accepted`, timestamp: "2026-08-17T00:00:00.000Z", sessionKey: "observe", acceptedCapture: true, writeNamespaceOverride: "ns-observe", principalOverride: "principal-observe" },
    { role: "assistant", content: `${"z".repeat(2048)}#accepted-reply`, timestamp: "2026-08-17T00:00:01.000Z", sessionKey: "observe", acceptedCapture: true, writeNamespaceOverride: "ns-observe", principalOverride: "principal-observe" },
  ];
  for (const turn of acceptedGroup) await buffer.addTurn("observe", turn);
  const heapBefore = process.memoryUsage().heapUsed;
  const durability: Promise<void>[] = [];
  for (let observe = 1; observe <= observeDepth; observe += 1) {
    queueBufferedCaptureScopeGroups(
      coordinator.queueBufferedExtraction.bind(coordinator),
      acceptedGroup,
      "observe",
      { onExtractionQueued: (promise) => durability.push(promise) },
    );
  }
  assert.equal(queue.length, observeDepth - 1, "observe ingress: all but the first group stay queued");
  assert.equal(queue.isProcessing, true, "first observe group holds the worker");
  assert.equal(durability.length, observeDepth, "every observe holds a durability promise");
  const observeStats = coordinator.snapshotSharing.stats();
  assert.equal(observeStats.queuedNodes, 1, "identical accepted groups reuse one chain node");
  assert.equal(observeStats.queuedTailRefs, acceptedGroup.length, "identical accepted groups share fully");
  assert.equal(observeStats.queuedTotalRefs, acceptedGroup.length, "total reflects the single shared window");
  assert.equal(observeStats.queuedReachableDepth, 1, "identical ingress keeps depth at one");
  gc?.();
  const observeQueued = process.memoryUsage().heapUsed;
  console.log(
    `acceptedCaptureQueuePath depth=${observeDepth}  heapGrowthWhileQueued=${((observeQueued - heapBefore) / 1e6).toFixed(1)}MB  ` +
      `refs: distinct=${observeStats.queuedTailRefs} unshared=${observeStats.queuedTotalRefs}`,
  );
  openGate();
  await queue.waitForIdle(120_000);
  await Promise.allSettled(durability);
  assert.equal(coordinator.snapshotSharing.stats().queuedNodes, 0, "registry empties after observe drain");
  rmSync(memoryDir, { recursive: true, force: true });
}

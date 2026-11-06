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
import { parseConfig } from "../packages/remnic-core/src/config.js";
import { SmartBuffer } from "../packages/remnic-core/src/buffer.js";
import type { BufferState, BufferTurn } from "../packages/remnic-core/src/types.js";
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

function makeTurn(content: string): BufferTurn {
  return {
    role: "user",
    content,
    timestamp: "2026-08-17T00:00:00.000Z",
    sessionKey: "bench",
  };
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
    await coordinator.processTurn("user", makeTurn(`${"y".repeat(turnBytes)}#${index}`), "bench");
  }
  globalWithGc.gc?.();
  globalWithGc.gc?.();
  const whileQueued = process.memoryUsage();
  console.log(`  queueLen=${queue.length} heapUsed=${(whileQueued.heapUsed / 1e6).toFixed(1)}MB heapTotal=${(whileQueued.heapTotal / 1e6).toFixed(1)}MB rss=${(whileQueued.rss / 1e6).toFixed(1)}MB`);
  const growthMb = (whileQueued.heapUsed - before) / 1e6;
  const stats = coordinator.snapshotSharing?.stats() ?? { queuedNodes: 0, queuedTailRefs: 0, queuedTotalRefs: 0 };
  openGate();
  await queue.waitForIdle(120_000);
  globalWithGc.gc?.();
  const after = process.memoryUsage().heapUsed;

  const residualMb = (after - before) / 1e6;
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

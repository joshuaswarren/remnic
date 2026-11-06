/**
 * Deterministic admit-CPU benchmark for the extraction snapshot chain
 * (#3326 review follow-up). Registry-level workload: one buffer key, every
 * trigger hands out a full prefix snapshot (the production pump shape).
 *
 * Reports per depth (hrtime used ONLY for reporting; no timers in tests):
 *   admitWallMs   — total wall time to build the whole chain;
 *   maxAdmitMs    — worst single admit (the event-loop block a
 *                   processTurn enqueuer would experience at the deep end);
 *   compares      — analytic compare count Σ total_i = N(N+1)/2 (what the
 *                   equivalence verification actually does; O(N^2) total,
 *                   acknowledged: full-prefix verification is required to
 *                   guarantee consumer-equivalence of the shared segment);
 *   peakHeapMb    — heap growth across the chain build.
 * Usage: node ./node_modules/.bin/tsx scripts/bench-snapshot-chain-cpu.ts
 */
import assert from "node:assert/strict";
import { ExtractionSnapshotSharingRegistry, materializeChain, type SnapshotChain } from "../packages/remnic-core/src/orchestration/extraction-queue-snapshot-sharing.js";
import type { BufferTurn } from "../packages/remnic-core/src/types.js";

function makeTurn(index: number): BufferTurn {
  return {
    role: "user",
    content: `bench#${index} ${"y".repeat(2048)}`,
    timestamp: "2026-08-17T00:00:00.000Z",
    sessionKey: "bench",
  };
}

interface DepthSample {
  admitWallMs: number;
  maxAdmitMs: number;
  peakHeapMb: number;
}

function runDepth(depth: number): DepthSample {
  // SAFETY: gc is only defined under node --expose-gc; absent means noisier
  // heap numbers.
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const registry = new ExtractionSnapshotSharingRegistry();
  const turns: BufferTurn[] = [];
  const start = process.hrtime.bigint();
  let maxAdmitNs = 0n;
  for (let index = 1; index <= depth; index += 1) {
    turns.push(makeTurn(index));
    const admitStart = process.hrtime.bigint();
    registry.admit("k", turns);
    const admitNs = process.hrtime.bigint() - admitStart;
    if (admitNs > maxAdmitNs) maxAdmitNs = admitNs;
  }
  const admitWallMs = Number(process.hrtime.bigint() - start) / 1e6;
  const peakHeapMb = (process.memoryUsage().heapUsed - heapBefore) / 1e6;
  const stats = registry.stats();
  assert.equal(stats.queuedTailRefs, depth, "distinct refs equal the union");
  const maxAdmitMs = Number(maxAdmitNs) / 1e6;
  console.log(
    `depth=${String(depth).padStart(6)}  admitWallMs=${admitWallMs.toFixed(1)}  maxAdmitMs=${maxAdmitMs.toFixed(2)}  ` +
      `compares=${((depth * (depth + 1)) / 2).toLocaleString("en-US")}  peakHeapMb=${peakHeapMb.toFixed(1)}`,
  );
  return { admitWallMs, maxAdmitMs, peakHeapMb };
}

// SAFETY: gc is only defined under node --expose-gc; absent means noisier
// heap numbers.
const gc = (globalThis as { gc?: () => void }).gc;
gc?.();
const deepStart = process.hrtime.bigint();
const registry = new ExtractionSnapshotSharingRegistry();
const deepTurns: BufferTurn[] = [];
let last: SnapshotChain | undefined;
for (let index = 1; index <= 10_000; index += 1) {
  deepTurns.push(makeTurn(index));
  last = registry.admit("k", deepTurns);
}
assert.ok(last, "deepest node recorded");
const materialized = materializeChain(last);
assert.equal(materialized.length, 10_000);
console.log(`depth= 10000  chainBuild+materializeWallMs=${(Number(process.hrtime.bigint() - deepStart) / 1e6).toFixed(1)}  materializedTurns=${materialized.length}`);

for (const depth of [250, 500, 1000, 2000]) runDepth(depth);

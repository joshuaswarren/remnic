/**
 * Corpus-scan main-thread blocking harness.
 *
 * Measures what each periodic/triggered maintenance job costs the daemon's
 * MAIN thread (event-loop utilization delta = active ms inside the job window,
 * plus monitorEventLoopDelay percentiles and wall clock) over a synthetic
 * corpus. Run before/after a scan-path change to prove the claim:
 *
 *   node_modules/.bin/tsx scripts/bench-corpus-scans.ts [--root DIR] [--scale quick|ci|deployment]
 *
 * Scales:
 *   quick       ~20k files   (seconds)
 *   ci          ~2k files    (CI regression-test scale)
 *   deployment  ~166k files  (the deployment shape the fix targets)
 *
 * Jobs measured (all read-only, run serially so ELU deltas attribute cleanly):
 *   walk           collectActiveMemoryPaths — the recall-corpus path scan
 *   readAll        readAllMemories — walk + frontmatter parse (hot-cache miss path)
 *   watermark      corpus census (hot+cold walk + newest-partition stat loop)
 *   migrationTick  steady-state entity canonical-id migration ensure cycle
 *                  (what every entity unlock pays once the migration completed)
 */

import { parseArgs } from "node:util";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import perfHooks from "node:perf_hooks";
const { monitorEventLoopDelay, performance } = perfHooks;
const eventLoopUtilization = performance.eventLoopUtilization.bind(performance);

import { StorageManager } from "../packages/remnic-core/src/storage.js";
import { computeCorpusWatermarks } from "../packages/remnic-core/src/corpus-watermark.js";
import { makeSyntheticCorpus } from "../tests/synthetic-corpus.js";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    scale: { type: "string", default: "quick" },
    keep: { type: "boolean", default: false },
  },
});

interface CorpusScale {
  days: number;
  filesPerCategory: number;
  coldFiles: number;
  entityCount: number;
}

const SCALES = {
  quick: { days: 20, filesPerCategory: 4_000, coldFiles: 1_000, entityCount: 2_000 },
  ci: { days: 10, filesPerCategory: 400, coldFiles: 200, entityCount: 200 },
  deployment: { days: 90, filesPerCategory: 30_000, coldFiles: 8_000, entityCount: 6_000 },
} satisfies Record<string, CorpusScale>;

interface JobResult {
  name: string;
  wallMs: number;
  eluActiveMs: number;
  delayP99Ms: number;
  delayMaxMs: number;
}

async function runJob(name: string, job: () => Promise<void>): Promise<JobResult> {
  const delay = monitorEventLoopDelay();
  delay.enable();
  const eluBefore = eventLoopUtilization();
  const t0 = performance.now();
  await job();
  const wallMs = performance.now() - t0;
  const elu = eventLoopUtilization(eluBefore);
  delay.disable();
  const p99 = delay.percentile(99) / 1e6;
  const max = delay.max / 1e6;
  return {
    name,
    wallMs: Math.round(wallMs),
    eluActiveMs: Math.round(elu.active),
    delayP99Ms: Math.round(p99 * 100) / 100,
    delayMaxMs: Math.round(max * 100) / 100,
  };
}

async function main(): Promise<void> {
  const scaleName = values.scale ?? "quick";
  const scale = SCALES[scaleName];
  if (!scale) throw new Error(`unknown scale ${scaleName}`);
  const rootDir = values.root ?? await mkdtemp(path.join(tmpdir(), "remnic-corpus-bench-"));

  const stats = await makeSyntheticCorpus({ rootDir, ...scale, seed: 11 });
  console.log(`corpus: ${JSON.stringify(stats)}`);

  const storage = new StorageManager(rootDir);
  try {
    await storage.ensureDirectories();
    // Warm/complete the entity migration so the tick job measures steady state.
    await storage.ensureDirectories();

    const results: JobResult[] = [];

    results.push(await runJob("walk", async () => {
      await storage.collectActiveMemoryPaths({ propagateReadErrors: true });
    }));

    results.push(await runJob("readAll", async () => {
      storage.invalidateAllMemoriesCacheForDir();
      await storage.readAllMemories();
    }));

    results.push(await runJob("watermark", async () => {
      await computeCorpusWatermarks(["default"], async () => storage, new Date("2026-01-15T00:00:00Z"));
    }));

    results.push(await runJob("migrationTick", async () => {
      await storage.ensureDirectories();
    }));

    console.table(results);
    const digestA = await storage.collectActiveMemoryPaths({ propagateReadErrors: true });
    console.log(`walk result: ${digestA.length} paths`);
  } finally {
    StorageManager.clearAllStaticCaches();
    if (!values.keep) await rm(rootDir, { recursive: true, force: true });
    else console.log(`kept corpus at ${rootDir}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

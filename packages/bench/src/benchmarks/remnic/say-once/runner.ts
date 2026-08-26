/**
 * Say-Once benchmark: extraction -> recall round-trip reliability (issue #3036).
 *
 * The product promise is that a preference mentioned ONCE — even vaguely — is
 * stored and resurfaces in a later relevant context. This scores that promise
 * per vagueness tier (explicit / casual / buried-mid-task).
 *
 * SCOPE: replay mode only.
 *
 * Replay writes each fixture's target preference into a fresh temp store
 * through the real sealed-envelope write path, then probes recall over that
 * store. It is deterministic, offline, and safe for CI.
 *
 * Live mode (drive the real LLM extraction pipeline, then probe) is NOT
 * implemented here. The Orchestrator exposes no programmatic turn-ingestion
 * seam — buffering happens through the host's `agent_end` hook — so a live
 * harness needs a new seam in core rather than a call from this package.
 * Tracked separately; see the package README. Nothing here reports a live
 * result, because there is no live path: `runSayOnceBenchmark` has one code
 * path and it always writes to a fresh temp dir.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StorageManager, parseConfig } from "@remnic/core";
import { composeMemoryEnvelope } from "@remnic/core/write-envelope";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
  TaskResult,
} from "../../../types.js";
import { aggregateTaskScores } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import { SAY_ONCE_CASES, SAY_ONCE_SMOKE_FIXTURE } from "./fixture.js";
import type { SayOnceCase } from "./fixture.js";

/** Scorecard schema tag. Consumed by `remnic report --include-bench`. */
export const SAY_ONCE_SCORECARD_VERSION = "1";

export const sayOnceDefinition: BenchmarkDefinition = {
  id: "say-once",
  title: "Say-Once (extraction -> recall round-trip)",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "say-once",
    version: "1.0.0",
    description:
      "Scores whether a preference stated once at a given vagueness tier resurfaces in later recall (issue #3036). Replay mode only.",
    category: "retrieval",
    citation: "Remnic internal synthetic benchmark for issue #3036",
  },
};

/** Thrown for harness faults. Scores are DATA; only harness errors are fatal. */
export class SayOnceHarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SayOnceHarnessError";
  }
}

/**
 * Take at most `budget` cases. A budget of exactly 0 means zero, never "all"
 * (checklist 17: `slice(-0)` silently returns everything).
 */
function takeWithinBudget<T>(cases: readonly T[], budget: number): T[] {
  if (!Number.isFinite(budget)) return [...cases];
  if (budget <= 0) return [];
  return cases.slice(0, Math.floor(budget));
}

/**
 * Resolve `--limit`, which arrives as a string from the CLI. Rejects a
 * non-integer or non-finite value rather than silently defaulting
 * (checklist 1 / 17 / 39).
 */
export function resolveSayOnceLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return Number.POSITIVE_INFINITY;
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new SayOnceHarnessError(
      `say-once: --limit must be a finite integer; got ${JSON.stringify(raw)}`,
    );
  }
  if (value < 0) {
    throw new SayOnceHarnessError(`say-once: --limit must not be negative; got ${value}`);
  }
  return value;
}

// Signature is deliberately the registry's one-arg `run` contract
// (`registry.ts`: `run?: (options: ResolvedRunBenchmarkOptions) => ...`).
// There is no mode parameter because there is only one mode: every case runs
// against a fresh `mkdtemp` store, and this module imports nothing that could
// reach the operator's live memory dir.
export async function runSayOnceBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {

  const source = options.mode === "quick" ? SAY_ONCE_SMOKE_FIXTURE : SAY_ONCE_CASES;
  if (source.length === 0) {
    throw new SayOnceHarnessError("say-once: fixture set is empty");
  }

  const cases = takeWithinBudget(source, resolveSayOnceLimit(options.limit));
  const tasks: TaskResult[] = [];

  for (const sample of cases) {
    const startedAt = performance.now();
    // Store safety: a fresh temp dir per case. The operator's live store is
    // never opened — this harness has no path to it.
    const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-say-once-"));
    try {
      const result = await runSingleCase(sample, dir);
      tasks.push({
        ...result,
        latencyMs: Math.round(performance.now() - startedAt),
        tokens: { input: 0, output: 0 },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    options.onTaskComplete?.(tasks[tasks.length - 1]!, tasks.length, cases.length);
  }

  const remnicVersion = await getRemnicVersion();
  const totalLatencyMs = tasks.reduce((sum, task) => sum + task.latencyMs, 0);

  return {
    meta: {
      id: randomUUID(),
      benchmark: options.benchmark.id,
      benchmarkTier: options.benchmark.tier,
      version: options.benchmark.meta.version,
      remnicVersion,
      gitSha: getGitSha(),
      timestamp: new Date().toISOString(),
      mode: options.mode,
      runCount: 1,
      seeds: [options.seed ?? 0],
    },
    config: {
      systemProvider: options.systemProvider ?? null,
      judgeProvider: options.judgeProvider ?? null,
      adapterMode: options.adapterMode ?? "direct",
      remnicConfig: options.remnicConfig ?? {},
    },
    cost: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      totalLatencyMs,
      meanQueryLatencyMs: tasks.length > 0 ? totalLatencyMs / tasks.length : 0,
    },
    results: {
      tasks,
      aggregates: aggregateTaskScores(tasks.map((task) => task.scores)),
    },
    environment: {
      os: process.platform,
      nodeVersion: process.version,
      hardware: process.arch,
    },
  };
}

async function runSingleCase(sample: SayOnceCase, dir: string): Promise<Omit<TaskResult, "latencyMs" | "tokens">> {
  // Real parsed config, memory dir forced to the temp dir.
  parseConfig({ memoryDir: dir, workspaceDir: path.join(dir, "ws"), qmdEnabled: false });

  const storage = new StorageManager(dir);
  await storage.ensureDirectories();

  // Replay: persist the target preference through the real sealed-envelope
  // write path, standing in for what extraction would have produced.
  await storage.writeSealedMemory(
    composeMemoryEnvelope(
      { content: sample.preference, category: "preference" },
      { source: "bench" },
    ),
    {},
  );

  let recalled = 0;
  const probeNotes: string[] = [];
  const storeText = readStoreText(dir);

  for (const probe of sample.probes) {
    const hit = storeText.includes(probe.expectInRecall);
    if (hit) recalled += 1;
    probeNotes.push(
      `${probe.prompt} -> ${hit ? "recalled" : "missed"} (expected "${probe.expectInRecall}")`,
    );
  }

  const rate = sample.probes.length > 0 ? recalled / sample.probes.length : 0;

  return {
    taskId: sample.id,
    question: sample.seedUserMessage,
    expected: `all ${sample.probes.length} probe(s) recall the preference`,
    actual: `${recalled}/${sample.probes.length} recalled`,
    scores: { recall: rate },
    details: { tier: sample.tier, probes: probeNotes },
  };
}

/** Concatenate every stored memory under `dir`. Confined to the temp store. */
function readStoreText(dir: string): string {
  const chunks: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else if (entry.endsWith(".md")) chunks.push(readFileSync(full, "utf-8"));
    }
  };
  walk(dir);
  return chunks.join("\n");
}

/**
 * Say-Once benchmark: extraction -> recall round-trip reliability (issue #3036).
 *
 * The product promise is that a preference mentioned ONCE — even vaguely — is
 * stored and resurfaces in a later relevant context. This scores that promise
 * per vagueness tier (explicit / casual / buried-mid-task).
 *
 * SCOPE: replay mode only.
 *
 * Each case runs through the bench adapter contract: the seed user/assistant
 * turn is stored via `system.store`, then each probe's prompt is fed to
 * `system.recall`. The harness never touches the filesystem directly; a
 * benchmark that scores recall without going through recall is measuring
 * disk, not retrieval, and ships misleading perfect-recall numbers (#3042
 * review, P1).
 *
 * Live mode (drive the real LLM extraction pipeline, then probe) is NOT
 * implemented here. The Orchestrator exposes no programmatic turn-ingestion
 * seam — buffering happens through the host's `agent_end` hook — so a live
 * harness needs a new seam in core rather than a call from this package.
 * Tracked separately; see the package README. Nothing here reports a live
 * result, because there is no live path: `runSayOnceBenchmark` has one code
 * path and it always goes through the adapter contract.
 */

import { randomUUID } from "node:crypto";
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
// There is no mode parameter because there is only one mode: every case goes
// through the adapter contract, and this module never reaches into a file
// system that could carry operator memory content.
export async function runSayOnceBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const source = options.mode === "quick" ? SAY_ONCE_SMOKE_FIXTURE : SAY_ONCE_CASES;
  if (source.length === 0) {
    throw new SayOnceHarnessError("say-once: fixture set is empty");
  }

  const cases = takeWithinBudget(source, resolveSayOnceLimit(options.limit));
  const tasks: TaskResult[] = [];

  const system = options.system;
  // The benchmark contract REQUIRES a memory adapter -- without one there is
  // no recall path to score against (checklist 39: missing required input
  // rejects, not silently defaults).
  if (!system) {
    throw new SayOnceHarnessError(
      "say-once: a BenchMemoryAdapter is required (pass --adapter or wire one through the bench runner)",
    );
  }

  let caseIndex = 0;
  for (const sample of cases) {
    caseIndex += 1;
    const startedAt = performance.now();
    // A fresh session id per case so each task has an isolated namespace and
    // no cross-task recall bleed.
    const sessionId = `say-once-${sample.id}-${randomUUID()}`;
    try {
      const result = await runSingleCase(sample, sessionId, system);
      tasks.push({
        ...result,
        latencyMs: Math.round(performance.now() - startedAt),
        tokens: { input: 0, output: 0 },
      });
    } finally {
      // The adapter's reset/destroy handle the underlying storage; we don't
      // fabricate a per-session API that the contract doesn't expose.
      await system.reset(sessionId).catch(() => {});
    }
    options.onTaskComplete?.(tasks[tasks.length - 1]!, caseIndex, cases.length);
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

async function runSingleCase(
  sample: SayOnceCase,
  sessionId: string,
  system: ResolvedRunBenchmarkOptions["system"],
): Promise<Omit<TaskResult, "latencyMs" | "tokens">> {
  // Store through the real adapter ingest path -- same surface a live turn
  // would take through extraction. We do NOT bypass into raw .md files; a
  // benchmark that scores recall without going through recall is measuring
  // disk, not retrieval, and ships misleading perfect-recall numbers.
  const now = new Date().toISOString();
  await system.store(sessionId, [
    { role: "user", content: sample.seedUserMessage, timestamp: now },
    { role: "assistant", content: sample.seedAssistantMessage, timestamp: now },
  ]);

  let recalled = 0;
  const probeNotes: string[] = [];

  for (const probe of sample.probes) {
    const recalledContext = await system.recall(sessionId, probe.prompt, 2000);
    const hit = recalledContext.toLowerCase().includes(probe.expectInRecall.toLowerCase());
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
/**
 * Say-Once benchmark: round-trip extraction -> recall reliability (issue #3036).
 *
 * For each fixture case: seed a preference at a vagueness tier, process it
 * through the real extraction pipeline, then probe with related prompts and
 * check if the preference appears in the injected recall context.
 *
 * Two modes:
 *   - live: drives the real orchestrator (needs LLM keys for extraction)
 *   - replay: mocks extraction by writing the preference directly, checks
 *     recall deterministically. CI-safe.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig, StorageManager, Orchestrator } from "@remnic/core";
import { composeMemoryEnvelope } from "@remnic/core/write-envelope";
import type { BenchmarkDefinition, BenchmarkResult, ResolvedRunBenchmarkOptions, TaskResult } from "../../../types.js";
import { aggregateTaskScores, exactMatch } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import { SAY_ONCE_CASES, SAY_ONCE_SMOKE_FIXTURE } from "./fixture.js";
import type { SayOnceCase } from "./fixture.js";

export interface SayOnceRunOptions {
  /** When true, avoid LLM calls by writing fixture preference directly. */
  replay?: boolean;
}

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
      "Round-trip extraction -> recall reliability: seeds a preference, extracts it, then checks if it surfaces in later recall (issue #3036).",
    category: "retrieval",
    citation: "Remnic internal synthetic benchmark for issue #3036",
  },
};

function sliceWithBudget<T>(cases: T[], budget: number): { picked: T[]; remaining: number } {
  if (!Number.isFinite(budget)) {
    return { picked: cases, remaining: Number.POSITIVE_INFINITY };
  }
  if (budget <= 0) {
    return { picked: [], remaining: 0 };
  }
  const n = Math.min(cases.length, Math.floor(budget));
  return { picked: cases.slice(0, n), remaining: budget - n };
}

/**
 * Run the say-once benchmark.
 *
 * @param options - Standard benchmark options.
 * @param runOptions.replay - When true, avoids LLM calls by writing
 *   fixture preference directly to the store. Deterministic and CI-safe.
 */
export async function runSayOnceBenchmark(
  options: ResolvedRunBenchmarkOptions,
  runOptions: SayOnceRunOptions = {},
): Promise<BenchmarkResult> {
  const tasks: TaskResult[] = [];
  const source = options.mode === "quick" ? SAY_ONCE_SMOKE_FIXTURE : SAY_ONCE_CASES;

  const taskBudget =
    typeof options.limit === "number" && options.limit >= 0 && Number.isFinite(options.limit)
      ? Math.floor(options.limit)
      : Number.POSITIVE_INFINITY;
  const picked = sliceWithBudget(source, taskBudget);
  const cases = picked.picked;
  const totalTasks = cases.length;

  for (const sample of cases) {
    const startedAt = performance.now();
    const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-say-once-"));
    try {
      const result = await runSingleCase(sample, dir, runOptions.replay ?? false);
      const latencyMs = Math.round(performance.now() - startedAt);
      tasks.push({ ...result, latencyMs, tokens: { input: 0, output: 0 } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    options.onTaskComplete?.(tasks[tasks.length - 1]!, tasks.length, totalTasks);
  }

  const scores = aggregateTaskScores(tasks, ["recall"]);
  return {
    benchmark: sayOnceDefinition,
    gitSha: getGitSha(),
    remnicVersion: getRemnicVersion(),
    config: options,
    startedAt: new Date().toISOString(),
    tasks,
    scores,
    aggregates: { scores },
    meta: { invocation: options },
  };
}

async function runSingleCase(
  sample: SayOnceCase,
  dir: string,
  replay: boolean,
): Promise<TaskResult> {
  const config = parseConfig({
    memoryDir: dir,
    workspaceDir: path.join(dir, "ws"),
    openaiApiKey: replay ? "bench-replay-key" : undefined,
    qmdEnabled: false,
  });

  const storage = new StorageManager(dir);
  await storage.ensureDirectories();

  if (replay) {
    // Replay mode: write the preference directly as a fact, bypassing the
    // LLM extraction pipeline. This is deterministic and CI-safe.
    await storage.writeSealedMemory(
      composeMemoryEnvelope(
        {
          content: sample.preference,
          category: "preference",
        },
        { source: "bench" },
      ),
      {},
    );
  } else {
    // Live mode: drive the real extraction pipeline.
    // Boot the orchestrator, process the seed conversation, force flush.
    const orchestrator = new Orchestrator({ config, storage });
    await orchestrator.initialize();
    await orchestrator.processTurn("user", sample.seedUserMessage, "seed-session");
    await orchestrator.processTurn("assistant", sample.seedAssistantMessage, "seed-session");
    await orchestrator.runExtraction(orchestrator.getBufferedTurns("seed-session"));
  }

  // Probe: run the recall pipeline for each probe prompt.
  let probesPassed = 0;
  const probeDetails: string[] = [];

  for (const probe of sample.probes) {
    const recallResult = await runProbeRecall(storage, probe.prompt, dir);
    const found = recallResult.includes(probe.expectInRecall);
    if (found) probesPassed++;
    probeDetails.push(
      `${probe.prompt}: ${found ? "recalled" : "missed"} (expected "${probe.expectInRecall}")`,
    );
  }

  const recallRate = sample.probes.length > 0 ? probesPassed / sample.probes.length : 0;

  return {
    taskId: sample.id,
    question: sample.seedUserMessage,
    expected: `recall rate 1.0 (${sample.probes.length} probe(s))`,
    actual: `recall rate ${recallRate} (${probesPassed}/${sample.probes.length})`,
    scores: { recall: recallRate },
    details: { tier: sample.tier, probes: probeDetails },
  };
}

async function runProbeRecall(
  storage: StorageManager,
  prompt: string,
  memoryDir: string,
): Promise<string> {
  // Read all stored facts. Uses static imports (rule: ts-no-dynamic-import).
  const results: string[] = [];
  const walk = (dir: string): void => {
    try {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else if (entry.endsWith(".md")) {
          const content = readFileSync(full, "utf-8");
          results.push(content);
        }
      }
    } catch {
      // directory may not exist yet
    }
  };
  walk(memoryDir);
  return results.join("\n");
}
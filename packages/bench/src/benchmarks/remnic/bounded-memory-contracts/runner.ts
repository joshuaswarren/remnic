/**
 * Bounded-memory-contracts benchmark runner (issue #1708).
 *
 * Drives all four conditions (C0 no-memory, C1 raw-transcript, C2 typed-
 * contract, C3 typed-plus-skills) over the deterministic synthetic fixture.
 * Quick mode is fully offline — no LLM, no network. When `outputDir` is
 * supplied the runner writes the issue's full per-run artifact tree:
 *
 *   conditions/<cond>/        prompt packs + retrieval logs, per task
 *   scores/per-task.csv       one row per (task, condition)
 *   scores/aggregate.json     per-condition headline bundles
 *   report.md                 human-readable comparison
 *
 * The BenchmarkResult carries the per-condition bundles + skill-trigger log in
 * `config.benchmarkOptions` (the headline numbers) and the per-pair TaskResults
 * in `results.tasks`.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
  TaskResult,
} from "../../../types.js";
import { aggregateTaskScores } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import { BOUNDED_MEMORY_FIXTURE, BOUNDED_MEMORY_SMOKE_FIXTURE, fixtureHash } from "./fixture.js";
import {
  BOUNDED_MEMORY_CONTRACT,
  assemblePack,
  buildSkillTriggerLog,
  classifySkillTrigger,
  simulateAgent,
} from "./agent.js";
import { aggregateCondition, scoreTaskPair } from "./scoring.js";
import {
  BOUNDED_MEMORY_CONDITIONS,
  BOUNDED_MEMORY_CONDITION_LABELS,
} from "./types.js";
import type {
  AgentDecision,
  AssembledMemoryPack,
  BoundedMemoryConditionAggregate,
  BoundedMemoryConditionId,
  BoundedMemoryTask,
  BoundedMemoryTaskScores,
  FixtureSkill,
  SkillTriggerLogEntry,
} from "./types.js";
import { renderReportMarkdown } from "./report.js";

export const boundedMemoryContractsDefinition: BenchmarkDefinition = {
  id: "bounded-memory-contracts",
  title: "Bounded Memory Contracts",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "bounded-memory-contracts",
    version: "1.0.0",
    description:
      "Ablates raw transcript stuffing vs typed retrieval contracts vs skill-triggered memory under a shared token budget (issue #1708).",
    category: "agentic",
    citation: "Remnic internal synthetic benchmark for issue #1708",
  },
};

interface ConditionTaskResult {
  task: BoundedMemoryTask;
  pack: AssembledMemoryPack;
  decision: AgentDecision;
  latencyMs: number;
}

/** Resolve which skills the C3 trigger classifier injects for a task. */
function resolveInjectedSkills(task: BoundedMemoryTask): FixtureSkill[] {
  const injected: FixtureSkill[] = [];
  for (const skill of task.skills) {
    const verdict = classifySkillTrigger(skill, task);
    if (verdict.injected) {
      injected.push(skill);
    }
  }
  return injected;
}

/**
 * Resolve the outcome of a (task, skill) pair given whether the skill was
 * ACTUALLY injected (i.e. landed in the pack). Expected-but-missed skills on
 * skill-positive tasks count as "harmed" (false negatives), and unexpected
 * injections count as "harmed" (false positives) — so precision/recall reflect
 * the packed reality, not just the classifier.
 */
function skillOutcome(
  task: BoundedMemoryTask,
  skill: FixtureSkill,
  injected: boolean,
): SkillTriggerLogEntry["outcome"] {
  if (task.family === "skill-positive") {
    const expected = task.shouldUseSkillId === skill.id;
    if (injected && expected) return "helped";
    if (injected !== expected) return "harmed";
    return "irrelevant";
  }
  if (task.family === "skill-negative") {
    return injected ? "harmed" : "irrelevant";
  }
  return "irrelevant";
}

export async function runBoundedMemoryContractsBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const fixtureSource =
    options.mode === "quick" ? BOUNDED_MEMORY_SMOKE_FIXTURE : BOUNDED_MEMORY_FIXTURE;

  // Honor options.limit like the other remnic runners: only a strictly-
  // positive finite limit caps the task set (limit <= 0 means no cap), so a
  // stray 0 never produces a silent empty run.
  const tasks: BoundedMemoryTask[] =
    typeof options.limit === "number" && options.limit > 0 && Number.isFinite(options.limit)
      ? fixtureSource.slice(0, Math.floor(options.limit))
      : fixtureSource;

  const seed = typeof options.seed === "number" ? options.seed : 0;

  // One TaskResult is emitted per (task × condition) pair; the progress
  // callback total is the full pair count, not the running emitted count.
  const totalPairs = tasks.length * BOUNDED_MEMORY_CONDITIONS.length;

  // Run every condition over the task set.
  const byCondition = new Map<BoundedMemoryConditionId, ConditionTaskResult[]>();
  for (const condition of BOUNDED_MEMORY_CONDITIONS) {
    const results: ConditionTaskResult[] = [];
    for (const task of tasks) {
      const resolvedSkills =
        condition === "typed-plus-skills" ? resolveInjectedSkills(task) : [];
      const started = performance.now();
      const pack = assemblePack(task, condition, BOUNDED_MEMORY_CONTRACT, resolvedSkills);
      // The agent may only use skills that actually fit in the pack —
      // assemblePack can drop a skill when the shared budget is full, so
      // reconcile against the triggered_skills slot rather than handing the
      // full resolved set to the simulator.
      const packedSkillIds = new Set(
        pack.slots.find((slot) => slot.id === "triggered_skills")?.items.map((it) => it.itemId) ?? [],
      );
      const effectiveSkills = resolvedSkills.filter((sk) => packedSkillIds.has(sk.id));
      const decision = simulateAgent(task, pack, effectiveSkills);
      const latencyMs = Math.round(performance.now() - started);
      results.push({ task, pack, decision, latencyMs });
    }
    byCondition.set(condition, results);
  }

  // Build the TaskResult stream: one entry per (task, condition).
  const taskResults: TaskResult[] = [];
  const conditionAggregates: Record<string, BoundedMemoryConditionAggregate> = {};
  const scoredByCondition: Record<string, Array<{ task: BoundedMemoryTask; scores: BoundedMemoryTaskScores }>> = {};
  let c3SkillLog: SkillTriggerLogEntry[] = [];

  for (const condition of BOUNDED_MEMORY_CONDITIONS) {
    const results = byCondition.get(condition)!;
    const scoredPairs = results.map(({ task, pack, decision }) => {
      const scores = scoreTaskPair(task, pack, decision);
      return { task, scores, pack, decision };
    });
    scoredByCondition[condition] = scoredPairs.map(({ task, scores }) => ({ task, scores }));

    // Build the skill-trigger log from PACKED reality: a skill is "injected"
    // only if it landed in this condition's triggered_skills slot (C3 only;
    // C0/C1/C2 pack no skills). This keeps the log, precision/recall, and
    // helped/harmed counts consistent with the prompt pack + retrieval artifact
    // even when the budget drops a classifier-approved skill.
    let skillLog: SkillTriggerLogEntry[] = [];
    if (condition === "typed-plus-skills") {
      skillLog = scoredPairs.flatMap(({ task, pack }) => {
        const packedSkillIds = new Set(
          pack.slots.find((slot) => slot.id === "triggered_skills")?.items.map((it) => it.itemId) ?? [],
        );
        return task.skills.map((skill) => {
          const verdict = classifySkillTrigger(skill, task);
          const injected = packedSkillIds.has(skill.id);
          return {
            taskId: task.id,
            skillId: skill.id,
            considered: verdict.considered,
            injected,
            triggerReason: verdict.reason,
            confidence: skill.confidence,
            outcome: skillOutcome(task, skill, injected),
          } satisfies SkillTriggerLogEntry;
        });
      });
      c3SkillLog = skillLog;
    }
    conditionAggregates[condition] = aggregateCondition(condition, scoredByCondition[condition]!, skillLog);

    for (const { task, pack, decision, scores } of scoredPairs) {
      const tr: TaskResult = {
        taskId: `${condition}:${task.id}`,
        question: task.prompt,
        expected: task.expectedAnswer,
        actual: decision.answer,
        scores: { ...scores },
        latencyMs: results.find((r) => r.task.id === task.id)!.latencyMs,
        tokens: { input: pack.totalTokens, output: 0 },
        details: {
          condition,
          family: task.family,
          scope: task.scope,
          packTokens: pack.totalTokens,
          compressionRatio: scores.compression_ratio_vs_raw_transcript,
          recalledItemIds: decision.recalledItemIds,
          askedClarification: decision.askedClarification,
          acted: decision.acted,
        },
      };
      taskResults.push(tr);
      options.onTaskComplete?.(tr, taskResults.length, totalPairs);
    }
  }

  // Headline cross-condition view (required by the result type). The per-
  // condition truth lives in config.benchmarkOptions.conditions.
  const aggregates = aggregateTaskScores(taskResults.map((t) => t.scores));

  const remnicVersion = await getRemnicVersion();
  const totalLatencyMs = taskResults.reduce((sum, t) => sum + t.latencyMs, 0);
  const totalMemoryTokens = taskResults.reduce((sum, t) => sum + t.tokens.input, 0);

  // Write the per-run artifact tree when an output directory is supplied.
  let artifactReport: string | null = null;
  if (options.outputDir) {
    artifactReport = await writeArtifacts(options.outputDir, byCondition, conditionAggregates, tasks);
  }

  const skillTriggerLog = c3SkillLog;

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
      seeds: [seed],
      datasetHash: fixtureHash(tasks),
    },
    config: {
      runtimeProfile: options.runtimeProfile ?? null,
      systemProvider: options.systemProvider ?? null,
      judgeProvider: options.judgeProvider ?? null,
      adapterMode: options.adapterMode ?? "deterministic-offline",
      remnicConfig: options.remnicConfig ?? {},
      benchmarkOptions: {
        conditions: conditionAggregates,
        skillTriggerLog,
        contract: BOUNDED_MEMORY_CONTRACT,
        fixtureTaskCount: tasks.length,
        conditionCount: BOUNDED_MEMORY_CONDITIONS.length,
        artifactReport,
      },
    },
    cost: {
      totalTokens: totalMemoryTokens,
      inputTokens: totalMemoryTokens,
      outputTokens: 0,
      estimatedCostUsd: 0,
      totalLatencyMs,
      meanQueryLatencyMs: taskResults.length > 0 ? totalLatencyMs / taskResults.length : 0,
      judgeModelCalls: 0,
    },
    results: {
      tasks: taskResults,
      aggregates,
      statistics: {
        confidenceIntervals: {},
        bootstrapSamples: 0,
      },
    },
    environment: {
      os: process.platform,
      nodeVersion: process.version,
      hardware: process.arch,
    },
  };
}

// ---------------------------------------------------------------------------
// Artifact emission (issue #1708 "Required artifacts per run")
// ---------------------------------------------------------------------------

async function writeArtifacts(
  outputDir: string,
  byCondition: Map<BoundedMemoryConditionId, ConditionTaskResult[]>,
  conditionAggregates: Record<string, BoundedMemoryConditionAggregate>,
  tasks: readonly BoundedMemoryTask[],
): Promise<string> {
  const root = path.resolve(outputDir);
  await mkdir(path.join(root, "conditions"), { recursive: true });
  await mkdir(path.join(root, "prompts"), { recursive: true });
  await mkdir(path.join(root, "retrieval"), { recursive: true });
  await mkdir(path.join(root, "scores"), { recursive: true });

  const csvRows: string[] = [
    "task_id,condition,family,scope,task_success,should_ask_accuracy,relevant_memory_recall,stale_memory_harm_rate,wrong_scope_retrieval_rate,supersession_respected_rate,citation_coverage,memory_tokens_injected,retrieved_item_count,compression_ratio_vs_raw_transcript",
  ];

  for (const condition of BOUNDED_MEMORY_CONDITIONS) {
    const results = byCondition.get(condition)!;
    const condDir = path.join(root, "conditions", condition);
    await mkdir(condDir, { recursive: true });

    for (const { task, pack, decision } of results) {
      const scores = scoreTaskPair(task, pack, decision);

      // Prompt pack (markdown).
      const promptMd = renderPromptPack(task, condition, pack);
      const promptPath = path.join(root, "prompts", `${task.id}.${condition}.md`);
      await mkdir(path.dirname(promptPath), { recursive: true });
      await writeFile(promptPath, promptMd, "utf8");

      // Retrieval artifact (json).
      const retrievalJson = `${JSON.stringify(
        {
          taskId: task.id,
          condition,
          contract: BOUNDED_MEMORY_CONTRACT.id,
          pack: {
            slots: pack.slots.map((slot) => ({
              id: slot.id,
              items: slot.items,
            })),
            transcriptBlock: pack.transcriptBlock,
            boundaryNote: pack.boundaryNote,
            totalTokens: pack.totalTokens,
            fullTranscriptTokens: pack.fullTranscriptTokens,
          },
          decision,
          scores,
        },
        null,
        2,
      )}\n`;
      const retrievalPath = path.join(root, "retrieval", `${task.id}.${condition}.json`);
      await writeFile(retrievalPath, retrievalJson, "utf8");

      csvRows.push(
        [
          task.id,
          condition,
          task.family,
          task.scope,
          scores.task_success,
          scores.should_ask_accuracy,
          scores.relevant_memory_recall,
          scores.stale_memory_harm_rate,
          scores.wrong_scope_retrieval_rate,
          scores.supersession_respected_rate,
          scores.citation_coverage.toFixed(4),
          scores.memory_tokens_injected,
          scores.retrieved_item_count,
          scores.compression_ratio_vs_raw_transcript.toFixed(4),
        ].join(","),
      );
    }

    // Per-condition summary under conditions/<cond>/.
    await writeFile(
      path.join(condDir, "summary.json"),
      `${JSON.stringify(conditionAggregates[condition], null, 2)}\n`,
      "utf8",
    );
  }

  await writeFile(path.join(root, "scores", "per-task.csv"), `${csvRows.join("\n")}\n`, "utf8");
  await writeFile(
    path.join(root, "scores", "aggregate.json"),
    `${JSON.stringify(conditionAggregates, null, 2)}\n`,
    "utf8",
  );

  const report = renderReportMarkdown(tasks, conditionAggregates);
  await writeFile(path.join(root, "report.md"), report, "utf8");

  return path.join(root, "report.md");
}

function renderPromptPack(
  task: BoundedMemoryTask,
  condition: BoundedMemoryConditionId,
  pack: AssembledMemoryPack,
): string {
  const lines: string[] = [];
  lines.push(`# Prompt pack — ${task.id} [${BOUNDED_MEMORY_CONDITION_LABELS[condition]}]`);
  lines.push("");
  lines.push("## System");
  lines.push(
    condition === "no-memory"
      ? "You have no prior memory. Answer from the current task only."
      : condition === "raw-transcript"
        ? "Prior session transcript follows. Use it as context."
        : "A bounded memory contract follows. Each item is typed, scoped, and cited.",
  );
  lines.push("");
  lines.push("## Current task");
  lines.push(task.prompt);
  lines.push("");
  lines.push(`## Active scope`);
  lines.push(task.scope);
  lines.push("");

  if (condition === "no-memory") {
    lines.push("_(no memory injected)_");
    lines.push("");
  } else if (condition === "raw-transcript") {
    lines.push("## Raw transcript (budget-normalized)");
    lines.push("```");
    lines.push(pack.transcriptBlock ?? "_(empty)_");
    lines.push("```");
    lines.push("");
  } else {
    if (pack.boundaryNote) {
      lines.push("## Boundaries");
      lines.push(`- ${pack.boundaryNote}`);
      lines.push("");
    }
    for (const slot of pack.slots) {
      if (slot.items.length === 0) continue;
      lines.push(`## ${slot.id}`);
      for (const it of slot.items) {
        lines.push(`- [${it.citation}] (${it.scope}, ${it.status}) ${it.content}`);
      }
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

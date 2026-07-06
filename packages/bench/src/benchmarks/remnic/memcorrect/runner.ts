/**
 * MemCorrect runner (issue #1584 PR 2).
 *
 * Drives a `MemCorrectSystemAdapter` through the correction protocol:
 *
 *   reset → ingest establishing → baseline probe
 *         → correct → post-correction probe
 *         → ingest anti-events → post-correction probe (false_apply window)
 *         → runMaintenance ×K → post-maintenance probe
 *         → re-ingest establishing transcript → post-reingest probe
 *         → re-assertion (if present) → post-reassertion probe
 *
 * Every probe is recorded in a probe log with a monotonic turn index. The
 * metrics module turns that log into the 8 scores; this file resolves the
 * scenario metadata into the inputs the pure metric functions expect and
 * emits one `BenchmarkResult` task per scenario.
 *
 * The default adapter is the hermetic `PromptOnlyBaselineAdapter` so the
 * bench runs green without a live orchestrator (the lab run swaps in the
 * Remnic-native adapter via `benchmarkOptions.adapter`). Per the assignment,
 * no real GPU/lab run is performed here — the harness is unit-tested with
 * the baseline + a deterministic recording adapter.
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
import { generateMemCorrectCorpus, corpusHash } from "./generator.js";
import { validateCorpus } from "./schema.js";
import { computeMetricBundle, containsAll } from "./metrics.js";
import {
  PromptOnlyBaselineAdapter,
  createRemnicMemCorrectAdapter,
} from "./adapters.js";
import type {
  MemCorrectMetricBundle,
  MemCorrectScenario,
  MemCorrectSystemAdapter,
  ProbeLogEntry,
  ProbePhase,
  ResolvedAntiEvent,
  ResolvedCorrection,
  ResolvedReassertion,
} from "./types.js";

export const memcorrectDefinition: BenchmarkDefinition = {
  id: "memcorrect-v1",
  title: "MemCorrect (correction / steerability)",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "memcorrect-v1",
    version: "1.0.0",
    description:
      "Open correction/steerability benchmark: uptake, non-resurrection, collateral, scope-precision, false-apply, reassertion. System-agnostic adapter interface; hermetic seeded synthetic corpus.",
    category: "conversational",
    citation:
      "Remnic MemCorrect v1 (issue #1584). Open benchmark; adapter contract is the public contribution.",
  },
};

/**
 * MemCorrect metrics where a LOWER value is better. Used by the bench
 * comparison tool (getBenchmarkLowerIsBetter) so regressions in latency or
 * false-apply are reported as regressions, not improvements. `collateral_delta`
 * is target-zero (signed after − before) and is intentionally excluded from
 * directional verdicts — a magnitude check, not a lower-is-better one.
 */
export const MEMCORRECT_LOWER_IS_BETTER: ReadonlySet<string> = new Set([
  "uptake_latency",
  "uptake_latency_censored",
  "false_apply",
]);
const QUICK_OPTIONS = {
  personaCount: 2,
  factsPerPersona: 4,
  seed: 0xc077e7,
  nowIso: "2026-07-05T00:00:00.000Z",
  maintenanceCycles: 3,
  uptakeLatencyCap: 5,
};

const FULL_OPTIONS = {
  personaCount: 5,
  factsPerPersona: 8,
  seed: 0xc077e7,
  nowIso: "2026-07-05T00:00:00.000Z",
  maintenanceCycles: 5,
  uptakeLatencyCap: 8,
};

/**
 * Resolve the adapter to drive. The lab run is explicit about which adapter
 * MemCorrect exercises:
 *   - `benchmarkOptions.adapter` (a `MemCorrectSystemAdapter`) → use directly.
 *     This is how the prompt-only baseline, the Remnic-native adapter, and
 *     any third-party adapter are selected.
 *   - Otherwise, wrap the bench `system` adapter (a `BenchMemoryAdapter`)
 *     into the MemCorrect contract via the public access-service surface.
 */
function resolveAdapter(
  options: ResolvedRunBenchmarkOptions,
): { adapter: MemCorrectSystemAdapter; adapterLabel: string } {
  const override = options.benchmarkOptions?.["adapter"];
  if (
    override &&
    typeof override === "object" &&
    "reset" in override &&
    "ingestTurn" in override &&
    "recall" in override
  ) {
    const adapter = override as MemCorrectSystemAdapter;
    return { adapter, adapterLabel: adapter.label ?? "custom" };
  }
  return {
    adapter: createRemnicMemCorrectAdapter(options.system, {
      label: "remnic-native",
    }),
    adapterLabel: "remnic-native",
  };
}

interface ScenarioRun {
  log: ProbeLogEntry[];
  correction: ResolvedCorrection;
  antiEvents: ResolvedAntiEvent[];
  reassertion: ResolvedReassertion | null;
  collateralBefore: number[];
  collateralAfter: number[];
  provenanceCite: number | null;
  metrics: MemCorrectMetricBundle;
}

/** Run the protocol for one scenario against the adapter. */
async function runScenario(
  scenario: MemCorrectScenario,
  adapter: MemCorrectSystemAdapter,
  maintenanceCycles: number,
  uptakeLatencyCap: number,
): Promise<ScenarioRun> {
  await adapter.reset();
  const log: ProbeLogEntry[] = [];
  let turn = 0;
  const sessionKey = scenario.namespace;

  const recordProbe = (
    phase: ProbePhase,
    query: string,
    namespace: string,
    recalled: string[],
    at: string,
  ): void => {
    log.push({ scenarioId: scenario.id, phase, turnIndex: turn, namespace, query, recalled, at });
  };

  // --- Establishing transcript (primary fact) ---
  for (const t of scenario.establishingTurns) {
    await adapter.ingestTurn(sessionKey, t.role, t.text, t.at);
    turn += 1;
  }

  // --- Scoped twin establishment (alternate namespace, BEFORE the correction) ---
  // Seeded before the correction so scope_precision can catch a system that
  // wrongly applies the correction across every namespace at correction time
  // (the twin must already exist to be overwritten).
  if (scenario.scopedTwin) {
    for (const t of scenario.scopedTwin.establishingTurns) {
      await adapter.ingestTurn(scenario.scopedTwin.namespace, t.role, t.text, t.at);
      turn += 1;
    }
  }

  // --- Collateral-fact establishment (primary namespace) ---
  // Seed the unrelated facts before the baseline probe so collateral_delta
  // measures recall over facts that were actually stored.
  for (const probe of scenario.unrelatedProbes) {
    for (const t of probe.establishingTurns) {
      await adapter.ingestTurn(sessionKey, t.role, t.text, t.at);
      turn += 1;
    }
  }

  // --- Baseline probe (unrelated-fact recall before correction) ---
  const collateralBefore: number[] = [];
  for (const probe of scenario.unrelatedProbes) {
    turn += 1;
    const recalled = await adapter.recall(probe.query, sessionKey);
    recordProbe("baseline", probe.query, sessionKey, recalled, scenario.correction.turn.at);
    collateralBefore.push(
      containsAll(recalled.join(" "), [probe.expectedContent]) ? 1 : 0,
    );
  }

  // --- Correction ---
  await adapter.correct(scenario.correction.turn.text, sessionKey, scenario.correction.turn.at);
  turn += 1;
  const correctionTurnIndex = turn;

  // --- Post-correction probe (uptake@next) ---
  // Recorded at the interaction turn AFTER the correction (strictly greater
  // than correctionTurnIndex) so uptake@next / uptake_latency count the
  // dedicated uptake probe, not only the later anti-event / twin probes.
  {
    turn += 1;
    const recalled = await adapter.recall(scenario.probe.query, sessionKey);
    recordProbe("post_correction", scenario.probe.query, sessionKey, recalled, scenario.correction.turn.at);
  }

  // --- Anti-events (false_apply window) ---
  for (const anti of scenario.antiEvents) {
    await adapter.ingestTurn(sessionKey, anti.turn.role, anti.turn.text, anti.turn.at);
    turn += 1;
    // Bump the turn BEFORE the recall probe so the probe gets its own
    // interaction turn (not the ingest's). Otherwise uptake_latency
    // underreports by one when the anti-event probe is the first recall
    // to reflect the correction. Mirrors the dedicated uptake probe above.
    turn += 1;
    const recalled = await adapter.recall(anti.probeQuery, sessionKey);
    // Recorded under post_correction so false_apply (which scans
    // post_correction for the scenario) sees the leaked token.
    recordProbe("post_correction", anti.probeQuery, sessionKey, recalled, anti.turn.at);
  }

  // --- Scoped twin probe (namespace-B must stay intact AFTER the correction) ---
  // The twin was established above (before the correction); this probe checks
  // it survived. Only the probe runs here — no re-ingestion.
  if (scenario.scopedTwin) {
    turn += 1;
    const recalled = await adapter.recall(scenario.probe.query, scenario.scopedTwin.namespace);
    recordProbe("post_correction", scenario.probe.query, scenario.scopedTwin.namespace, recalled, scenario.correction.turn.at);
  }

  // --- Collateral after: re-probe unrelated facts IMMEDIATELY after the
  // correction (before maintenance / re-ingest / re-assertion) so the delta
  // isolates correction collateral damage rather than conflating it with
  // later protocol steps that can also change unrelated recall.
  const collateralAfter: number[] = [];
  for (const probe of scenario.unrelatedProbes) {
    const recalled = await adapter.recall(probe.query, sessionKey);
    collateralAfter.push(
      containsAll(recalled.join(" "), [probe.expectedContent]) ? 1 : 0,
    );
  }

  // --- Maintenance cycles (non_resurrection) ---
  for (let i = 0; i < maintenanceCycles; i += 1) {
    await adapter.runMaintenance();
    turn += 1;
  }
  {
    const recalled = await adapter.recall(scenario.probe.query, sessionKey);
    recordProbe("post_maintenance", scenario.probe.query, sessionKey, recalled, scenario.correction.turn.at);
    turn += 1;
  }

  // --- Re-ingest the original establishing transcript ---
  for (const t of scenario.establishingTurns) {
    await adapter.ingestTurn(sessionKey, t.role, t.text, t.at);
    turn += 1;
  }
  {
    const recalled = await adapter.recall(scenario.probe.query, sessionKey);
    recordProbe("post_reingest", scenario.probe.query, sessionKey, recalled, scenario.correction.turn.at);
    turn += 1;
  }

  // --- Re-assertion (if present) ---
  let reassertion: ResolvedReassertion | null = null;
  if (scenario.reassertion) {
    await adapter.ingestTurn(
      sessionKey,
      scenario.reassertion.turn.role,
      scenario.reassertion.turn.text,
      scenario.reassertion.turn.at,
    );
    turn += 1;
    const recalled = await adapter.recall(scenario.probe.query, sessionKey);
    recordProbe("post_reassertion", scenario.probe.query, sessionKey, recalled, scenario.reassertion.turn.at);
    turn += 1;
    reassertion = {
      scenarioId: scenario.id,
      namespace: sessionKey,
      expectedContent: scenario.reassertion.expectedContent,
    };
  }


  const correction: ResolvedCorrection = {
    scenarioId: scenario.id,
    namespace: sessionKey,
    turnIndex: correctionTurnIndex,
    retiredContent: scenario.correction.retiredContent,
    correctedContent: scenario.correction.correctedContent,
    scopedTwin: scenario.scopedTwin,
  };
  const antiEvents: ResolvedAntiEvent[] = scenario.antiEvents.map((anti) => ({
    scenarioId: scenario.id,
    namespace: sessionKey,
    probeQuery: anti.probeQuery,
    shouldNotAppear: anti.shouldNotAppear,
  }));

  // Provenance: the baseline does not surface provenance; the metric reports
  // n/a unless the adapter opts in (future Remnic-native extension).
  const provenanceCite: number | null = null;

  const metrics = computeMetricBundle({
    log,
    corrections: [correction],
    antiEvents,
    reassertions: reassertion ? [reassertion] : [],
    collateralBefore,
    collateralAfter,
    provenanceCites: [provenanceCite],
    uptakeLatencyCap,
  });

  return {
    log,
    correction,
    antiEvents,
    reassertion,
    collateralBefore,
    collateralAfter,
    provenanceCite,
    metrics,
  };
}

export async function runMemCorrectBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const baseOptions = options.mode === "quick" ? QUICK_OPTIONS : FULL_OPTIONS;
  const seed = typeof options.seed === "number" ? options.seed : baseOptions.seed;
  const generatorOptions = { ...baseOptions, seed };
  const corpus = generateMemCorrectCorpus(generatorOptions);

  const validation = validateCorpus(corpus);
  if (!validation.ok) {
    throw new Error(
      `MemCorrect corpus failed schema validation: ${validation.errors
        .map((e) => `${e.scenarioId}: ${e.message}`)
        .join("; ")}`,
    );
  }

  const { adapter, adapterLabel } = resolveAdapter(options);

  // Honor options.limit so quick / limited runs don't fan out across every
  // scenario, mirroring the other remnic runners.
  const scenarios =
    typeof options.limit === "number" && options.limit > 0
      ? corpus.scenarios.slice(0, options.limit)
      : corpus.scenarios;

  const tasks: TaskResult[] = [];
  const aggregateLog: ProbeLogEntry[] = [];
  const aggregateCorrections: ResolvedCorrection[] = [];
  const aggregateAntiEvents: ResolvedAntiEvent[] = [];
  const aggregateReassertions: ResolvedReassertion[] = [];
  const aggregateCollateralBefore: number[] = [];
  const aggregateCollateralAfter: number[] = [];
  const aggregateProvenance: (number | null)[] = [];

  for (const scenario of scenarios) {
    const started = performance.now();
    const run = await runScenario(
      scenario,
      adapter,
      generatorOptions.maintenanceCycles,
      generatorOptions.uptakeLatencyCap,
    );
    const latencyMs = Math.round(performance.now() - started);

    aggregateLog.push(...run.log);
    aggregateCorrections.push(run.correction);
    aggregateAntiEvents.push(...run.antiEvents);
    if (run.reassertion) aggregateReassertions.push(run.reassertion);
    aggregateCollateralBefore.push(...run.collateralBefore);
    aggregateCollateralAfter.push(...run.collateralAfter);
    aggregateProvenance.push(run.provenanceCite);

    const m = run.metrics;
    // Per-task directional scores: only metrics that are both directional
    // and applicable to the scenario. collateral_delta is target-zero (not
    // directional); scope_precision / reassertion are n/a for non-scoped /
    // non-re-assertion scenarios. All three remain in the full bundle under
    // details.metrics.memcorrect so they are not lost.
    const scores: Record<string, number> = {
      uptake_at_next: m.uptake_at_next,
      uptake_latency: m.uptake_latency,
      non_resurrection: m.non_resurrection,
      false_apply: m.false_apply,
    };
    if (m.scope_precision !== null) scores.scope_precision = m.scope_precision;
    if (m.reassertion !== null) scores.reassertion = m.reassertion;
    const task: TaskResult = {
      taskId: scenario.id,
      question: scenario.probe.query,
      expected: JSON.stringify({
        correctedContent: scenario.correction.correctedContent,
        retiredContent: scenario.correction.retiredContent,
      }),
      actual: JSON.stringify({
        shape: scenario.correction.shape,
        namespace: scenario.namespace,
        postCorrectionRecall:
          run.log.find(
            (e) => e.phase === "post_correction" && e.namespace === scenario.namespace,
          )?.recalled.slice(0, 3) ?? [],
      }),
      scores,
      latencyMs,
      tokens: { input: 0, output: 0 },
      details: {
        scenarioId: scenario.id,
        shape: scenario.correction.shape,
        category: scenario.category,
        namespace: scenario.namespace,
        adapter: adapterLabel,
        metrics: {
          memcorrect: m,
        },
      },
    };
    tasks.push(task);
    options.onTaskComplete?.(task, tasks.length, scenarios.length);
  }

  // Aggregate metric bundle across all scenarios (the headline numbers).
  const aggregateMetrics = computeMetricBundle({
    log: aggregateLog,
    corrections: aggregateCorrections,
    antiEvents: aggregateAntiEvents,
    reassertions: aggregateReassertions,
    collateralBefore: aggregateCollateralBefore,
    collateralAfter: aggregateCollateralAfter,
    provenanceCites: aggregateProvenance,
    uptakeLatencyCap: generatorOptions.uptakeLatencyCap,
  });

  const remnicVersion = await getRemnicVersion();
  const totalLatencyMs = tasks.reduce((sum, t) => sum + t.latencyMs, 0);
  // Omit the live adapter instance from the persisted config so the result
  // stays JSON-serializable — a stateful/circular adapter would otherwise be
  // walked by the reporter. The adapter label is already captured in `adapterMode`.
  const { adapter: _liveAdapter, ...persistableBenchmarkOptions } =
    (options.benchmarkOptions as Record<string, unknown> | undefined) ?? {};
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
      datasetHash: corpusHash(corpus),
    },
    config: {
      runtimeProfile: options.runtimeProfile ?? null,
      systemProvider: options.systemProvider ?? null,
      judgeProvider: options.judgeProvider ?? null,
      adapterMode: adapterLabel,
      remnicConfig: options.remnicConfig ?? {},
      benchmarkOptions: {
        ...persistableBenchmarkOptions,
        personaCount: generatorOptions.personaCount,
        factsPerPersona: generatorOptions.factsPerPersona,
        maintenanceCycles: generatorOptions.maintenanceCycles,
        uptakeLatencyCap: generatorOptions.uptakeLatencyCap,
        // Headline metric bundle computed across the union of all scenario
        // probe logs (more robust than the per-task mean for fraction
        // metrics when scenario sizes vary). `aggregateTaskScores` in
        // results.aggregates is the per-task-mean view.
        aggregateMetrics,
      },
    },
    cost: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      totalLatencyMs,
      meanQueryLatencyMs: tasks.length > 0 ? totalLatencyMs / tasks.length : 0,
      judgeModelCalls: 0,
    },
    results: {
      tasks,
      aggregates: aggregateTaskScores(tasks.map((t) => t.scores)),
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
/**
 * Read the headline aggregate metric bundle (all 8 metrics, computed across
 * the union of scenario probe logs) from a MemCorrect result. Returns null
 * for results from other benchmarks.
 */
export function summarizeAggregateMetrics(
  result: BenchmarkResult,
): MemCorrectMetricBundle | null {
  const opts = result.config.benchmarkOptions as
    | { aggregateMetrics?: MemCorrectMetricBundle }
    | undefined;
  return opts?.aggregateMetrics ?? null;
}

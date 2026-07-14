import type {
  BenchmarkArtifact,
  BenchmarkArtifactPerTaskScore,
} from "../published-artifact.js";

const LOCOMO_CATEGORY_ORDER = [
  "single_hop",
  "multi_hop",
  "temporal",
  "open_domain",
  "adversarial",
] as const;

const LOCOMO_TASK_CATEGORY_PATTERN =
  /-(single_hop|multi_hop|temporal|open_domain|adversarial)$/;

export interface LoComoProfileArtifactEvidence {
  artifact: BenchmarkArtifact;
  reference: string;
  sha256: string;
}

export interface LoComoMetricDelta {
  baselineMean: number;
  realMean: number;
  delta: number;
  aggregateContribution: number;
  wins: number;
  losses: number;
  ties: number;
}

export interface LoComoCategoryDelta {
  category: string;
  taskCount: number;
  metrics: Record<string, LoComoMetricDelta>;
}

export interface LoComoTaskRegression {
  taskId: string;
  category: string;
  baselineScore: number;
  realScore: number;
  delta: number;
}

export interface LoComoProfileDeltaReport {
  schemaVersion: 1;
  benchmarkId: "locomo";
  comparison: {
    baseline: { reference: string; sha256: string };
    real: { reference: string; sha256: string };
    datasetVersion: string;
    model: string;
    seed: number;
    gitSha: string;
    tier: string;
  };
  taskCount: number;
  primaryMetric: string;
  metrics: string[];
  overall: Record<string, LoComoMetricDelta>;
  categories: LoComoCategoryDelta[];
  topRegressions: LoComoTaskRegression[];
  evidenceBoundary: {
    scoreDiagnosis: "complete";
    recallRootCause: "requires-paired-recall-receipts";
  };
}

export interface DiagnoseLoComoProfileDeltaOptions {
  baseline: LoComoProfileArtifactEvidence;
  real: LoComoProfileArtifactEvidence;
  primaryMetric?: string;
  maxRegressions?: number;
}

interface JoinedTask {
  taskId: string;
  category: string;
  baseline: BenchmarkArtifactPerTaskScore;
  real: BenchmarkArtifactPerTaskScore;
}

export function diagnoseLoComoProfileDelta(
  options: DiagnoseLoComoProfileDeltaOptions,
): LoComoProfileDeltaReport {
  const maxRegressions = options.maxRegressions ?? 20;
  if (!Number.isInteger(maxRegressions) || maxRegressions < 0) {
    throw new Error("maxRegressions must be a non-negative integer.");
  }

  assertComparableArtifacts(options.baseline.artifact, options.real.artifact);
  const joined = joinTasks(options.baseline.artifact, options.real.artifact);
  const metrics = collectMetrics(joined);
  const primaryMetric = options.primaryMetric ?? "llm_judge";
  if (!metrics.includes(primaryMetric)) {
    throw new Error(
      `Primary metric ${JSON.stringify(primaryMetric)} is not present on every joined task.`,
    );
  }

  const overall = summarizeMetrics(joined, metrics, joined.length);
  verifyPublishedMetricMeans(options.baseline.artifact, overall, "baseline");
  verifyPublishedMetricMeans(options.real.artifact, overall, "real");

  const categories = [...new Set(joined.map((task) => task.category))]
    .sort(compareLoComoCategories)
    .map((category) => {
      const tasks = joined.filter((task) => task.category === category);
      return {
        category,
        taskCount: tasks.length,
        metrics: summarizeMetrics(tasks, metrics, joined.length),
      };
    });

  const topRegressions = joined
    .map((task) => ({
      taskId: task.taskId,
      category: task.category,
      baselineScore: task.baseline.scores[primaryMetric]!,
      realScore: task.real.scores[primaryMetric]!,
      delta:
        task.real.scores[primaryMetric]! -
        task.baseline.scores[primaryMetric]!,
    }))
    .filter((task) => task.delta < 0)
    .sort((left, right) => left.delta - right.delta || left.taskId.localeCompare(right.taskId))
    .slice(0, maxRegressions);

  const baselineArtifact = options.baseline.artifact;
  return {
    schemaVersion: 1,
    benchmarkId: "locomo",
    comparison: {
      baseline: {
        reference: options.baseline.reference,
        sha256: options.baseline.sha256,
      },
      real: {
        reference: options.real.reference,
        sha256: options.real.sha256,
      },
      datasetVersion: baselineArtifact.datasetVersion,
      model: baselineArtifact.model,
      seed: baselineArtifact.seed,
      gitSha: baselineArtifact.system.gitSha,
      tier: baselineArtifact.tier ?? "frontier",
    },
    taskCount: joined.length,
    primaryMetric,
    metrics,
    overall,
    categories,
    topRegressions,
    evidenceBoundary: {
      scoreDiagnosis: "complete",
      recallRootCause: "requires-paired-recall-receipts",
    },
  };
}

export function renderLoComoProfileDeltaMarkdown(
  report: LoComoProfileDeltaReport,
): string {
  const primary = report.primaryMetric;
  const lines = [
    "# LoCoMo runtime-profile score diagnosis",
    "",
    `Joined ${report.taskCount} identical task ids from the baseline and real artifacts. ` +
      `The primary diagnostic metric is \`${primary}\` (real minus baseline).`,
    "",
    "| Category | Tasks | Baseline | Real | Delta | Aggregate contribution | Wins | Losses | Ties |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];

  for (const category of report.categories) {
    const metric = category.metrics[primary]!;
    lines.push(
      `| ${category.category} | ${category.taskCount} | ${formatScore(metric.baselineMean)} | ` +
        `${formatScore(metric.realMean)} | ${formatSignedScore(metric.delta)} | ` +
        `${formatSignedScore(metric.aggregateContribution)} | ${metric.wins} | ` +
        `${metric.losses} | ${metric.ties} |`,
    );
  }

  const overall = report.overall[primary]!;
  lines.push(
    `| **Overall** | **${report.taskCount}** | **${formatScore(overall.baselineMean)}** | ` +
      `**${formatScore(overall.realMean)}** | **${formatSignedScore(overall.delta)}** | ` +
      `**${formatSignedScore(overall.aggregateContribution)}** | **${overall.wins}** | ` +
      `**${overall.losses}** | **${overall.ties}** |`,
    "",
    "## Highest-priority paired recall samples",
    "",
    `These task ids have the largest negative \`${primary}\` deltas. They are candidates for ` +
      "paired recall X-ray capture; score artifacts alone do not identify what recall tier served or what evidence was displaced.",
    "",
    "| Task | Category | Baseline | Real | Delta |",
    "|---|---|---:|---:|---:|",
  );

  for (const task of report.topRegressions) {
    lines.push(
      `| ${task.taskId} | ${task.category} | ${formatScore(task.baselineScore)} | ` +
        `${formatScore(task.realScore)} | ${formatSignedScore(task.delta)} |`,
    );
  }

  lines.push(
    "",
    "## Evidence boundary",
    "",
    "The paired score diagnosis is complete for these artifacts. A recall-side root cause is not established until paired recall receipts exist for the same task ids and runtime profiles.",
    "",
    `Baseline: \`${report.comparison.baseline.reference}\` (` +
      `\`${report.comparison.baseline.sha256}\`)`,
    "",
    `Real: \`${report.comparison.real.reference}\` (` +
      `\`${report.comparison.real.sha256}\`)`,
    "",
  );
  return `${lines.join("\n")}\n`;
}

function assertComparableArtifacts(
  baseline: BenchmarkArtifact,
  real: BenchmarkArtifact,
): void {
  if (baseline.benchmarkId !== "locomo" || real.benchmarkId !== "locomo") {
    throw new Error("LoCoMo profile diagnosis requires two locomo artifacts.");
  }
  const checks: Array<[string, unknown, unknown]> = [
    ["datasetVersion", baseline.datasetVersion, real.datasetVersion],
    ["model", baseline.model, real.model],
    ["seed", baseline.seed, real.seed],
    ["system.gitSha", baseline.system.gitSha, real.system.gitSha],
    ["tier", baseline.tier ?? "frontier", real.tier ?? "frontier"],
  ];
  for (const [field, baselineValue, realValue] of checks) {
    if (baselineValue !== realValue) {
      throw new Error(
        `Artifacts are not comparable: ${field} differs (${JSON.stringify(baselineValue)} vs ${JSON.stringify(realValue)}).`,
      );
    }
  }
}

function joinTasks(
  baseline: BenchmarkArtifact,
  real: BenchmarkArtifact,
): JoinedTask[] {
  const baselineTasks = indexTasks(baseline.perTaskScores, "baseline");
  const realTasks = indexTasks(real.perTaskScores, "real");
  const missingFromReal = [...baselineTasks.keys()].filter((id) => !realTasks.has(id)).sort();
  const missingFromBaseline = [...realTasks.keys()].filter((id) => !baselineTasks.has(id)).sort();
  if (missingFromReal.length > 0 || missingFromBaseline.length > 0) {
    throw new Error(
      "Artifacts do not contain identical task-id sets: " +
        `${missingFromReal.length} missing from real, ${missingFromBaseline.length} missing from baseline.`,
    );
  }

  return [...baselineTasks.keys()].sort().map((taskId) => {
    const baselineTask = baselineTasks.get(taskId)!;
    const realTask = realTasks.get(taskId)!;
    const baselineCategory = resolveLoComoCategory(baselineTask);
    const realCategory = resolveLoComoCategory(realTask);
    if (baselineCategory !== realCategory) {
      throw new Error(
        `Task ${JSON.stringify(taskId)} has mismatched categories (${baselineCategory} vs ${realCategory}).`,
      );
    }
    return {
      taskId,
      category: baselineCategory,
      baseline: baselineTask,
      real: realTask,
    };
  });
}

function indexTasks(
  tasks: BenchmarkArtifactPerTaskScore[],
  label: string,
): Map<string, BenchmarkArtifactPerTaskScore> {
  const indexed = new Map<string, BenchmarkArtifactPerTaskScore>();
  for (const task of tasks) {
    if (indexed.has(task.taskId)) {
      throw new Error(`${label} artifact contains duplicate task id ${JSON.stringify(task.taskId)}.`);
    }
    indexed.set(task.taskId, task);
  }
  if (indexed.size === 0) {
    throw new Error(`${label} artifact contains no per-task scores.`);
  }
  return indexed;
}

function resolveLoComoCategory(task: BenchmarkArtifactPerTaskScore): string {
  if (task.category) {
    return task.category;
  }
  const match = task.taskId.match(LOCOMO_TASK_CATEGORY_PATTERN);
  if (!match?.[1]) {
    throw new Error(
      `Cannot derive a LoCoMo category from task id ${JSON.stringify(task.taskId)}.`,
    );
  }
  return match[1];
}

function collectMetrics(joined: JoinedTask[]): string[] {
  const expected = Object.keys(joined[0]!.baseline.scores).sort();
  if (expected.length === 0) {
    throw new Error("Joined tasks contain no metrics.");
  }
  for (const task of joined) {
    for (const [label, scores] of [
      ["baseline", task.baseline.scores],
      ["real", task.real.scores],
    ] as const) {
      const actual = Object.keys(scores).sort();
      if (actual.length !== expected.length || actual.some((metric, index) => metric !== expected[index])) {
        throw new Error(
          `Task ${JSON.stringify(task.taskId)} ${label} metric set does not match the joined metric set.`,
        );
      }
    }
  }
  return expected;
}

function summarizeMetrics(
  tasks: JoinedTask[],
  metrics: string[],
  totalTaskCount: number,
): Record<string, LoComoMetricDelta> {
  return Object.fromEntries(metrics.map((metric) => {
    let baselineSum = 0;
    let realSum = 0;
    let wins = 0;
    let losses = 0;
    let ties = 0;
    for (const task of tasks) {
      const baselineScore = task.baseline.scores[metric]!;
      const realScore = task.real.scores[metric]!;
      baselineSum += baselineScore;
      realSum += realScore;
      if (realScore > baselineScore) wins += 1;
      else if (realScore < baselineScore) losses += 1;
      else ties += 1;
    }
    const deltaSum = realSum - baselineSum;
    return [metric, {
      baselineMean: baselineSum / tasks.length,
      realMean: realSum / tasks.length,
      delta: deltaSum / tasks.length,
      aggregateContribution: deltaSum / totalTaskCount,
      wins,
      losses,
      ties,
    }];
  }));
}

function verifyPublishedMetricMeans(
  artifact: BenchmarkArtifact,
  overall: Record<string, LoComoMetricDelta>,
  side: "baseline" | "real",
): void {
  for (const [metric, summary] of Object.entries(overall)) {
    const published = artifact.metrics[metric];
    if (published === undefined) {
      throw new Error(`${side} artifact does not publish aggregate metric ${JSON.stringify(metric)}.`);
    }
    const computed = side === "baseline" ? summary.baselineMean : summary.realMean;
    if (Math.abs(published - computed) > 1e-12) {
      throw new Error(
        `${side} artifact aggregate ${metric}=${published} does not match its per-task mean ${computed}.`,
      );
    }
  }
}

function compareLoComoCategories(left: string, right: string): number {
  const leftIndex = LOCOMO_CATEGORY_ORDER.indexOf(left as typeof LOCOMO_CATEGORY_ORDER[number]);
  const rightIndex = LOCOMO_CATEGORY_ORDER.indexOf(right as typeof LOCOMO_CATEGORY_ORDER[number]);
  if (leftIndex >= 0 && rightIndex >= 0) return leftIndex - rightIndex;
  if (leftIndex >= 0) return -1;
  if (rightIndex >= 0) return 1;
  return left.localeCompare(right);
}

function formatScore(value: number): string {
  return value.toFixed(4);
}

function formatSignedScore(value: number): string {
  return `${value >= 0 ? "+" : ""}${formatScore(value)}`;
}

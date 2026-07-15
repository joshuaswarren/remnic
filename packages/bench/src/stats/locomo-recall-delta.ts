import { createHash } from "node:crypto";
import { basename } from "node:path";

import type { BenchmarkResult, ProviderConfig, TaskResult } from "../types.js";

export const LOCOMO_FULL_TASK_COUNT = 1_986;
export const LOCOMO_RECALL_EXCERPT_CHARS = 240;
export const LOCOMO_RECALL_DIFF_LINE_LIMIT = 20;

const LOCOMO_CATEGORY_ORDER = ["single_hop", "multi_hop", "temporal", "open_domain", "adversarial"] as const;
const LOCOMO_TASK_CATEGORY_PATTERN = /-(single_hop|multi_hop|temporal|open_domain|adversarial)$/;
const SOURCE_TURN_PATTERN = /^\[([^,\]\s]+),\s*turn\s+(\d+),\s*([^,\]]+?)(?:,\s*score\s+[^\]]+)?\]/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface LoComoRawResultEvidence {
  result: BenchmarkResult;
  reference: string;
  /** SHA-256 of the exact result-file bytes, computed before JSON parsing. */
  sha256: string;
}

export interface LoComoRecallTextDigest {
  sha256: string;
  charCount: number;
  excerpt: string;
}

export interface LoComoRecallLineEvidence extends LoComoRecallTextDigest {
  ordinal: number;
  sourceRef?: string;
}

export interface LoComoRecallLineDelta {
  totalCount: number;
  shownCount: number;
  lines: LoComoRecallLineEvidence[];
}

export interface LoComoRecallContextSummary {
  sha256: string;
  charCount: number;
  lineCount: number;
  headings: string[];
  sourceRefs: string[];
  expectedTokenCoverage: number;
}

export interface LoComoRecallMetricDelta {
  baselineMean: number;
  realMean: number;
  delta: number;
  wins: number;
  losses: number;
  ties: number;
}

export interface LoComoRecallCategoryDelta extends LoComoRecallMetricDelta {
  category: string;
  taskCount: number;
}

export interface LoComoFinalContextRegression {
  taskId: string;
  category: string;
  baselineScore: number;
  realScore: number;
  delta: number;
  questionSha256: string;
  expectedAnswerSha256: string;
  baseline: {
    answer: LoComoRecallTextDigest;
    recall: LoComoRecallContextSummary;
  };
  real: {
    answer: LoComoRecallTextDigest;
    recall: LoComoRecallContextSummary;
  };
  displacedLines: LoComoRecallLineDelta;
  introducedLines: LoComoRecallLineDelta;
}

export interface LoComoRecallResultProvenance {
  reference: string;
  sha256: string;
  resultId: string;
  gitSha: string;
  remnicVersion: string;
  runtimeProfile: "baseline" | "real";
  systemProvider: string;
  systemModel: string;
  judgeProvider: string;
  judgeModel: string;
  seeds: number[];
  taskPayloadSha256: string;
}

export interface LoComoRecallDeltaReport {
  schemaVersion: 1;
  benchmarkId: "locomo";
  comparison: {
    baseline: LoComoRecallResultProvenance;
    real: LoComoRecallResultProvenance;
  };
  taskCount: number;
  primaryMetric: string;
  overall: LoComoRecallMetricDelta;
  categories: LoComoRecallCategoryDelta[];
  topRegressions: LoComoFinalContextRegression[];
  evidenceBoundary: {
    finalContextComparison: "complete";
    retrievalTierAttribution: "unavailable-in-cached-results";
    hiddenEvidenceUsed: false;
    explanation: string;
  };
}

export interface DiagnoseLoComoRecallDeltaOptions {
  baseline: LoComoRawResultEvidence;
  real: LoComoRawResultEvidence;
  primaryMetric?: string;
  maxRegressions?: number;
}

/**
 * Return a stable provenance label without exposing the caller's directory
 * layout. CLI callers should use this instead of persisting an input path.
 */
export function sanitizeLoComoResultReference(path: string): string {
  const reference = basename(path).replace(/[\u0000-\u001f\u007f`]/g, "_");
  if (!reference) throw new Error("Result path must identify a file.");
  return reference;
}

interface JoinedTask {
  taskId: string;
  category: string;
  baseline: TaskResult;
  real: TaskResult;
}

interface IndexedRecallLine {
  text: string;
  ordinal: number;
}

export function diagnoseLoComoRecallDelta(options: DiagnoseLoComoRecallDeltaOptions): LoComoRecallDeltaReport {
  const primaryMetric = options.primaryMetric ?? "llm_judge";
  const maxRegressions = parseNonNegativeInteger(options.maxRegressions ?? 20, "maxRegressions");

  assertEvidenceEnvelope(options.baseline, "baseline");
  assertEvidenceEnvelope(options.real, "real");
  assertCompleteResult(options.baseline.result, "baseline");
  assertCompleteResult(options.real.result, "real");
  assertComparableResults(options.baseline.result, options.real.result);

  const joined = joinTasks(options.baseline.result, options.real.result);
  assertMetricSets(joined, primaryMetric);
  verifyAggregateMeans(options.baseline.result, joined, "baseline");
  verifyAggregateMeans(options.real.result, joined, "real");
  const overall = summarizeMetric(joined, primaryMetric);
  const categories = [...new Set(joined.map((task) => task.category))].sort(compareLoComoCategories).map((category) => {
    const tasks = joined.filter((task) => task.category === category);
    return {
      category,
      taskCount: tasks.length,
      ...summarizeMetric(tasks, primaryMetric),
    };
  });

  const topRegressions = joined
    .map((task) => buildRegression(task, primaryMetric, LOCOMO_RECALL_EXCERPT_CHARS, LOCOMO_RECALL_DIFF_LINE_LIMIT))
    .filter((task) => task.delta < 0)
    .sort((left, right) => left.delta - right.delta || compareStrings(left.taskId, right.taskId))
    .slice(0, maxRegressions);

  return {
    schemaVersion: 1,
    benchmarkId: "locomo",
    comparison: {
      baseline: buildProvenance(options.baseline, "baseline", joined, "baseline"),
      real: buildProvenance(options.real, "real", joined, "real"),
    },
    taskCount: joined.length,
    primaryMetric,
    overall,
    categories,
    topRegressions,
    evidenceBoundary: {
      finalContextComparison: "complete",
      retrievalTierAttribution: "unavailable-in-cached-results",
      hiddenEvidenceUsed: false,
      explanation:
        "Cached BenchmarkResult files preserve the final transformed recall context, " +
        "but not pre-transform candidates, section provenance, filter traces, or served-by tiers.",
    },
  };
}

export function renderLoComoRecallDeltaMarkdown(report: LoComoRecallDeltaReport): string {
  const lines = [
    "# LoCoMo paired final-context diagnosis",
    "",
    `Joined ${report.taskCount} complete paired tasks. The primary metric is ` +
      `\`${report.primaryMetric}\` (real minus baseline).`,
    "",
    "| Category | Tasks | Baseline | Real | Delta | Wins | Losses | Ties |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const category of report.categories) {
    lines.push(
      `| ${escapeMarkdownCell(category.category)} | ${category.taskCount} | ` +
        `${formatScore(category.baselineMean)} | ${formatScore(category.realMean)} | ` +
        `${formatSignedScore(category.delta)} | ${category.wins} | ${category.losses} | ` +
        `${category.ties} |`
    );
  }
  lines.push(
    `| **Overall** | **${report.taskCount}** | **${formatScore(report.overall.baselineMean)}** | ` +
      `**${formatScore(report.overall.realMean)}** | **${formatSignedScore(report.overall.delta)}** | ` +
      `**${report.overall.wins}** | **${report.overall.losses}** | **${report.overall.ties}** |`,
    "",
    "## Highest-priority final-context regressions",
    ""
  );

  for (const task of report.topRegressions) {
    lines.push(
      `### ${escapeMarkdownCell(task.taskId)}`,
      "",
      `Category: \`${task.category}\`; baseline ${formatScore(task.baselineScore)}, ` +
        `real ${formatScore(task.realScore)}, delta ${formatSignedScore(task.delta)}.`,
      "",
      `Recall: baseline ${task.baseline.recall.charCount} chars ` +
        `(expected-token coverage ${formatScore(task.baseline.recall.expectedTokenCoverage)}), ` +
        `real ${task.real.recall.charCount} chars ` +
        `(coverage ${formatScore(task.real.recall.expectedTokenCoverage)}).`,
      "",
      `Displaced lines: ${task.displacedLines.totalCount}; introduced lines: ` + `${task.introducedLines.totalCount}.`,
      ""
    );
    const displaced = task.displacedLines.lines[0];
    if (displaced) {
      lines.push(
        `- Baseline-only evidence: ${escapeMarkdownCell(displaced.excerpt)} ` + `(sha256 \`${displaced.sha256}\`)`
      );
    }
    const introduced = task.introducedLines.lines[0];
    if (introduced) {
      lines.push(
        `- Real-only evidence: ${escapeMarkdownCell(introduced.excerpt)} ` + `(sha256 \`${introduced.sha256}\`)`
      );
    }
    if (displaced || introduced) lines.push("");
  }

  lines.push(
    "## Evidence boundary",
    "",
    "The final responder contexts are compared completely by hash, length, headings, source " +
      "references, and bounded line-difference receipts. Retrieval-tier attribution is " +
      "unavailable because the cached results do not preserve served-by or candidate traces. " +
      "Hidden `details.evidence` metadata is not read or emitted.",
    "",
    `Baseline: \`${report.comparison.baseline.reference}\` ` + `(sha256 \`${report.comparison.baseline.sha256}\`)`,
    "",
    `Real: \`${report.comparison.real.reference}\` ` + `(sha256 \`${report.comparison.real.sha256}\`)`,
    ""
  );
  return `${lines.join("\n")}\n`;
}

function assertEvidenceEnvelope(evidence: LoComoRawResultEvidence, label: "baseline" | "real"): void {
  if (!evidence.reference.trim()) {
    throw new Error(`${label} result reference must not be empty.`);
  }
  if (!SHA256_PATTERN.test(evidence.sha256)) {
    throw new Error(`${label} result sha256 must be 64 lowercase hexadecimal characters.`);
  }
}

function assertCompleteResult(result: BenchmarkResult, label: "baseline" | "real"): void {
  if (result.meta.benchmark !== "locomo") {
    throw new Error(`${label} result must be a locomo benchmark result.`);
  }
  if (result.meta.mode !== "full" || result.meta.status === "partial") {
    throw new Error(`${label} result must be a complete full-mode run.`);
  }
  if (!result.config.systemProvider || !result.config.judgeProvider) {
    throw new Error(`${label} result must identify both system and judge providers.`);
  }
  const limit = result.config.benchmarkOptions?.limit;
  const trialLimit = result.config.benchmarkOptions?.trialLimit;
  if (limit !== undefined || trialLimit !== undefined) {
    throw new Error(`${label} result is limited and cannot be used as complete evidence.`);
  }
  if (result.results.tasks.length !== LOCOMO_FULL_TASK_COUNT) {
    throw new Error(
      `${label} result must contain exactly ${LOCOMO_FULL_TASK_COUNT} tasks; got ${result.results.tasks.length}.`
    );
  }
  for (const task of result.results.tasks) {
    const details = asRecord(task.details);
    const failure = details?.benchmarkFailure;
    const legacyError = details?.error;
    if ((failure !== undefined && failure !== null) || (typeof legacyError === "string" && legacyError.length > 0)) {
      throw new Error(`${label} result contains failed task ${JSON.stringify(task.taskId)}.`);
    }
  }
}

function assertComparableResults(baseline: BenchmarkResult, real: BenchmarkResult): void {
  if (baseline.config.runtimeProfile !== "baseline") {
    throw new Error('baseline result runtimeProfile must be "baseline".');
  }
  if (real.config.runtimeProfile !== "real") {
    throw new Error('real result runtimeProfile must be "real".');
  }
  const checks: Array<[string, unknown, unknown]> = [
    ["meta.version", baseline.meta.version, real.meta.version],
    ["meta.remnicVersion", baseline.meta.remnicVersion, real.meta.remnicVersion],
    ["meta.gitSha", baseline.meta.gitSha, real.meta.gitSha],
    ["meta.runCount", baseline.meta.runCount, real.meta.runCount],
    ["meta.seeds", baseline.meta.seeds, real.meta.seeds],
    ["meta.datasetHash", baseline.meta.datasetHash ?? null, real.meta.datasetHash ?? null],
    ["config.adapterMode", baseline.config.adapterMode, real.config.adapterMode],
    [
      "config.systemProvider",
      providerIdentity(baseline.config.systemProvider),
      providerIdentity(real.config.systemProvider),
    ],
    [
      "config.judgeProvider",
      providerIdentity(baseline.config.judgeProvider),
      providerIdentity(real.config.judgeProvider),
    ],
    [
      "config.internalProvider",
      providerIdentity(baseline.config.internalProvider),
      providerIdentity(real.config.internalProvider),
    ],
  ];
  for (const [field, baselineValue, realValue] of checks) {
    if (stableJson(baselineValue) !== stableJson(realValue)) {
      throw new Error(
        `Results are not comparable: ${field} differs ` + `(${stableJson(baselineValue)} vs ${stableJson(realValue)}).`
      );
    }
  }
}

function joinTasks(baseline: BenchmarkResult, real: BenchmarkResult): JoinedTask[] {
  const baselineTasks = indexTasks(baseline.results.tasks, "baseline");
  const realTasks = indexTasks(real.results.tasks, "real");
  const missingFromReal = [...baselineTasks.keys()].filter((id) => !realTasks.has(id)).sort(compareStrings);
  const missingFromBaseline = [...realTasks.keys()].filter((id) => !baselineTasks.has(id)).sort(compareStrings);
  if (missingFromReal.length > 0 || missingFromBaseline.length > 0) {
    throw new Error(
      `Results do not contain identical task-id sets: ${missingFromReal.length} missing from real, ` +
        `${missingFromBaseline.length} missing from baseline.`
    );
  }
  return [...baselineTasks.keys()].sort(compareStrings).map((taskId) => {
    const baselineTask = baselineTasks.get(taskId);
    const realTask = realTasks.get(taskId);
    if (!baselineTask || !realTask) {
      throw new Error(`Task ${JSON.stringify(taskId)} disappeared during the validated join.`);
    }
    for (const [field, baselineValue, realValue] of [
      ["question", baselineTask.question, realTask.question],
      ["expected", baselineTask.expected, realTask.expected],
    ] as const) {
      if (baselineValue !== realValue) {
        throw new Error(`Task ${JSON.stringify(taskId)} has mismatched ${field} payloads.`);
      }
    }
    const baselineCategory = resolveCategory(baselineTask);
    const realCategory = resolveCategory(realTask);
    if (baselineCategory !== realCategory) {
      throw new Error(`Task ${JSON.stringify(taskId)} has mismatched categories.`);
    }
    return { taskId, category: baselineCategory, baseline: baselineTask, real: realTask };
  });
}

function indexTasks(tasks: TaskResult[], label: string): Map<string, TaskResult> {
  const result = new Map<string, TaskResult>();
  for (const task of tasks) {
    if (!task.taskId || result.has(task.taskId)) {
      throw new Error(`${label} result contains duplicate or empty task id ${JSON.stringify(task.taskId)}.`);
    }
    if (!task.question || !task.expected) {
      throw new Error(`${label} task ${JSON.stringify(task.taskId)} has an empty question or expected answer.`);
    }
    const recalledText = asRecord(task.details)?.recalledText;
    if (typeof recalledText !== "string") {
      throw new Error(`${label} task ${JSON.stringify(task.taskId)} has no final recalledText.`);
    }
    result.set(task.taskId, task);
  }
  return result;
}

function assertMetricSets(joined: JoinedTask[], primaryMetric: string): void {
  const first = joined[0];
  if (!first) throw new Error("Cannot validate metric sets for an empty paired result.");
  const expectedMetrics = Object.keys(first.baseline.scores).sort(compareStrings);
  for (const task of joined) {
    const baselineMetrics = Object.keys(task.baseline.scores).sort(compareStrings);
    const realMetrics = Object.keys(task.real.scores).sort(compareStrings);
    if (stableJson(baselineMetrics) !== stableJson(realMetrics)) {
      throw new Error(`Task ${JSON.stringify(task.taskId)} has mismatched metric sets.`);
    }
    if (stableJson(baselineMetrics) !== stableJson(expectedMetrics)) {
      throw new Error(`Task ${JSON.stringify(task.taskId)} has an inconsistent metric set.`);
    }
    if (!baselineMetrics.includes(primaryMetric)) {
      throw new Error(`Task ${JSON.stringify(task.taskId)} is missing metric ${JSON.stringify(primaryMetric)}.`);
    }
    for (const [side, scores] of [
      ["baseline", task.baseline.scores],
      ["real", task.real.scores],
    ] as const) {
      for (const [metric, score] of Object.entries(scores)) {
        if (!Number.isFinite(score)) {
          throw new Error(`${side} task ${JSON.stringify(task.taskId)} metric ${metric} is not finite.`);
        }
      }
    }
  }
}

function buildRegression(
  task: JoinedTask,
  metric: string,
  excerptChars: number,
  maxDiffLines: number
): LoComoFinalContextRegression {
  const baselineRecall = finalRecallText(task.baseline);
  const realRecall = finalRecallText(task.real);
  const baselineLines = contentLines(baselineRecall);
  const realLines = contentLines(realRecall);
  const displaced = subtractLineMultiset(baselineLines, realLines);
  const introduced = subtractLineMultiset(realLines, baselineLines);
  const baselineScore = requireMetricScore(task.baseline, metric, "baseline");
  const realScore = requireMetricScore(task.real, metric, "real");
  return {
    taskId: task.taskId,
    category: task.category,
    baselineScore,
    realScore,
    delta: realScore - baselineScore,
    questionSha256: sha256(normalizeText(task.baseline.question)),
    expectedAnswerSha256: sha256(normalizeText(task.baseline.expected)),
    baseline: {
      answer: textDigest(task.baseline.actual, excerptChars),
      recall: recallSummary(baselineRecall, task.baseline.expected),
    },
    real: {
      answer: textDigest(task.real.actual, excerptChars),
      recall: recallSummary(realRecall, task.real.expected),
    },
    displacedLines: lineDelta(displaced, maxDiffLines, excerptChars),
    introducedLines: lineDelta(introduced, maxDiffLines, excerptChars),
  };
}

function buildProvenance(
  evidence: LoComoRawResultEvidence,
  profile: "baseline" | "real",
  joined: JoinedTask[],
  side: "baseline" | "real"
): LoComoRecallResultProvenance {
  const system = requireProvider(evidence.result.config.systemProvider, profile, "system");
  const judge = requireProvider(evidence.result.config.judgeProvider, profile, "judge");
  const payload = joined.map((task) => ({
    taskId: task.taskId,
    category: task.category,
    question: task[side].question,
    expected: task[side].expected,
  }));
  return {
    reference: evidence.reference,
    sha256: evidence.sha256,
    resultId: evidence.result.meta.id,
    gitSha: evidence.result.meta.gitSha,
    remnicVersion: evidence.result.meta.remnicVersion,
    runtimeProfile: profile,
    systemProvider: system.provider,
    systemModel: system.model,
    judgeProvider: judge.provider,
    judgeModel: judge.model,
    seeds: [...evidence.result.meta.seeds],
    taskPayloadSha256: sha256(stableJson(payload)),
  };
}

function summarizeMetric(tasks: JoinedTask[], metric: string): LoComoRecallMetricDelta {
  let baselineSum = 0;
  let realSum = 0;
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const task of tasks) {
    const baseline = requireMetricScore(task.baseline, metric, "baseline");
    const real = requireMetricScore(task.real, metric, "real");
    baselineSum += baseline;
    realSum += real;
    if (real > baseline) wins += 1;
    else if (real < baseline) losses += 1;
    else ties += 1;
  }
  const baselineMean = baselineSum / tasks.length;
  const realMean = realSum / tasks.length;
  return { baselineMean, realMean, delta: realMean - baselineMean, wins, losses, ties };
}

function lineDelta(lines: IndexedRecallLine[], maxDiffLines: number, excerptChars: number): LoComoRecallLineDelta {
  return {
    totalCount: lines.length,
    shownCount: Math.min(lines.length, maxDiffLines),
    lines: lines.slice(0, maxDiffLines).map((line) => {
      const parsedSourceRef = sourceRef(line.text);
      return {
        ordinal: line.ordinal,
        ...textDigest(line.text, excerptChars),
        ...(parsedSourceRef ? { sourceRef: parsedSourceRef } : {}),
      };
    }),
  };
}

function recallSummary(text: string, expected: string): LoComoRecallContextSummary {
  const normalized = normalizeText(text);
  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    sha256: sha256(normalized),
    charCount: normalized.length,
    lineCount: lines.length,
    headings: [...new Set(lines.filter(isHeading))],
    sourceRefs: [...new Set(lines.map(sourceRef).filter((value): value is string => !!value))].sort(compareStrings),
    expectedTokenCoverage: tokenCoverage(expected, normalized),
  };
}

function textDigest(text: string, excerptChars: number): LoComoRecallTextDigest {
  const normalized = normalizeText(text);
  return {
    sha256: sha256(normalized),
    charCount: normalized.length,
    excerpt: normalized.slice(0, excerptChars),
  };
}

function contentLines(text: string): IndexedRecallLine[] {
  return normalizeText(text)
    .split("\n")
    .map((line, ordinal) => ({ text: line.trim(), ordinal }))
    .filter((line) => line.text.length > 0 && !isHeading(line.text));
}

function subtractLineMultiset(source: IndexedRecallLine[], comparison: IndexedRecallLine[]): IndexedRecallLine[] {
  const remaining = new Map<string, number>();
  for (const line of comparison) {
    remaining.set(line.text, (remaining.get(line.text) ?? 0) + 1);
  }
  return source.filter((line) => {
    const count = remaining.get(line.text) ?? 0;
    if (count === 0) return true;
    remaining.set(line.text, count - 1);
    return false;
  });
}

function verifyAggregateMeans(result: BenchmarkResult, joined: JoinedTask[], side: "baseline" | "real"): void {
  const first = joined[0];
  if (!first) throw new Error("Cannot verify aggregates for an empty paired result.");
  const metrics = Object.keys(first[side].scores).sort(compareStrings);
  for (const metric of metrics) {
    const aggregate = result.results.aggregates[metric];
    if (!aggregate || !Number.isFinite(aggregate.mean)) {
      throw new Error(`${side} result has no finite aggregate mean for ${JSON.stringify(metric)}.`);
    }
    const computed =
      joined.reduce((sum, task) => sum + requireMetricScore(task[side], metric, side), 0) / joined.length;
    if (Math.abs(aggregate.mean - computed) > 1e-12) {
      throw new Error(`${side} aggregate ${metric}=${aggregate.mean} does not match task mean ${computed}.`);
    }
  }
}

function tokenCoverage(expected: string, recalled: string): number {
  const expectedTokens = new Set(tokenize(expected));
  if (expectedTokens.size === 0) return 0;
  const recalledTokens = new Set(tokenize(recalled));
  let matched = 0;
  for (const token of expectedTokens) {
    if (recalledTokens.has(token)) matched += 1;
  }
  return matched / expectedTokens.size;
}

function tokenize(value: string): string[] {
  return (
    normalizeText(value)
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

function resolveCategory(task: TaskResult): string {
  const categoryName = asRecord(task.details)?.categoryName;
  if (typeof categoryName === "string" && categoryName.trim()) return categoryName;
  const match = task.taskId.match(LOCOMO_TASK_CATEGORY_PATTERN);
  if (!match?.[1]) {
    throw new Error(`Cannot derive LoCoMo category from task id ${JSON.stringify(task.taskId)}.`);
  }
  return match[1];
}

function finalRecallText(task: TaskResult): string {
  const recalledText = asRecord(task.details)?.recalledText;
  if (typeof recalledText !== "string") {
    throw new Error(`Task ${JSON.stringify(task.taskId)} has no final recalledText.`);
  }
  return recalledText;
}

function providerIdentity(provider: ProviderConfig | null | undefined): unknown {
  if (!provider) return null;
  return {
    provider: provider.provider,
    model: provider.model,
    rubricVersion: provider.rubricVersion ?? null,
    baseUrl: provider.baseUrl ?? null,
    providerRequestTimeoutMs: provider.providerRequestTimeoutMs ?? null,
    retryOptions: provider.retryOptions
      ? {
          maxAttempts: provider.retryOptions.maxAttempts ?? null,
          baseBackoffMs: provider.retryOptions.baseBackoffMs ?? null,
          timeoutMs: provider.retryOptions.timeoutMs ?? null,
          retryOnTimeout: provider.retryOptions.retryOnTimeout ?? null,
          max429WaitMs: provider.retryOptions.max429WaitMs ?? null,
        }
      : null,
    disableThinking: provider.disableThinking ?? null,
    reasoningEffort: provider.reasoningEffort ?? null,
    responderContextBudgetChars: provider.responderContextBudgetChars ?? null,
    responderPromptBudgetChars: provider.responderPromptBudgetChars ?? null,
    temperature: provider.temperature ?? null,
    seed: provider.seed ?? null,
  };
}

function sourceRef(line: string): string | undefined {
  const match = line.match(SOURCE_TURN_PATTERN);
  const sessionId = match?.[1];
  const turn = match?.[2];
  const role = match?.[3];
  if (!sessionId || !turn || !role) return undefined;
  return `${sessionId}:turn-${turn}:${role.trim().toLowerCase()}`;
}

function requireMetricScore(task: TaskResult, metric: string, side: string): number {
  const score = task.scores[metric];
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw new Error(`${side} task ${JSON.stringify(task.taskId)} metric ${metric} is not finite.`);
  }
  return score;
}

function requireProvider(provider: ProviderConfig | null | undefined, profile: string, role: string): ProviderConfig {
  if (!provider) throw new Error(`${profile} result has no ${role} provider identity.`);
  return provider;
}

function isHeading(line: string): boolean {
  return /^##\s+/.test(line);
}

function normalizeText(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function parseNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function compareLoComoCategories(left: string, right: string): number {
  const leftIndex = LOCOMO_CATEGORY_ORDER.indexOf(left as (typeof LOCOMO_CATEGORY_ORDER)[number]);
  const rightIndex = LOCOMO_CATEGORY_ORDER.indexOf(right as (typeof LOCOMO_CATEGORY_ORDER)[number]);
  if (leftIndex >= 0 && rightIndex >= 0) return leftIndex - rightIndex;
  if (leftIndex >= 0) return -1;
  if (rightIndex >= 0) return 1;
  return compareStrings(left, right);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeMarkdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatScore(value: number): string {
  return value.toFixed(4);
}

function formatSignedScore(value: number): string {
  return `${value >= 0 ? "+" : ""}${formatScore(value)}`;
}

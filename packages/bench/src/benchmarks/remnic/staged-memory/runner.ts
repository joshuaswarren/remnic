/**
 * Deterministic staged-memory benchmark runner (issue #2346,
 * `staged-memory-synthetic-v1`).
 *
 * Proves the staged invariants offline on synthetic drift-gen material
 * only: an early fact survives a context reset, distractors leave no
 * residue after `resetContext`, a newer fact replaces an older fact, and
 * user scope stays closed. The system under test is the hermetic
 * deterministic engine below (same pattern as retention-aged-dataset): no
 * orchestrator, no QMD, no network, no wall-clock inputs. Tokens are
 * estimated (`ceil(chars / 4)`): cost diagnostics, never provider claims.
 *
 * Arms — identical fixture, seeds, task order, and token budgets:
 *   empty            task query only; calibration floor.
 *   persist-only     Stage 1 + Stage 3, no distractors; safety/cost pair.
 *   static-context   distractors ride into Stage 3 (no reset); rejection pair.
 *   staged-memory    the full three-stage path; gates apply to this arm.
 *   oracle-retrieval fixture-selected gold evidence only; scorer
 *                   calibration — never a system quality claim.
 *
 * Paired statistics report observational differences only; no
 * counterfactual lift is claimed. Controller arms (baseline/shadow/active,
 * issue #2348) are not implemented: the coordinator does not exist yet and
 * #2348 depends on this issue. Requesting shadow/active fails loudly rather
 * than silently degrading to baseline.
 */

import { createHash, randomUUID } from "node:crypto";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import { aggregateTaskScores, exactMatch, f1Score } from "../../../scorer.js";
import { createSeededRandom } from "../../../seeded-random.js";
import { bootstrapMeanConfidenceInterval, pairedDeltaConfidenceInterval } from "../../../stats/bootstrap.js";
import type { BenchmarkDefinition, BenchmarkResult, ResolvedRunBenchmarkOptions, TaskResult } from "../../../types.js";
import { buildStagedMemoryFixture, canonicalDriftDir, loadStagedMemoryFixture } from "./fixture.js";
import {
  type NaMetricEntry,
  STAGED_MEMORY_PERMUTATION_SAMPLES,
  STAGED_MEMORY_STATISTICS_SEED,
  holmAdjust,
  pairedPermutationTest,
} from "./metrics.js";
import {
  STAGED_MEMORY_ARMS,
  STAGED_MEMORY_BENCHMARK_ID,
  STAGED_MEMORY_GENERATOR_VERSION,
  STAGED_MEMORY_NAMESPACES,
  STAGED_MEMORY_TRUSTED_PRINCIPAL,
  type StagedMemoryArm,
  type StagedMemoryCaseV1,
  type StagedMemoryControllerMode,
  type StagedMemoryFixtureManifestV1,
  type StagedMemoryGoldFactV1,
  type StagedMemoryPublicResultV1,
} from "./schema.js";

export const stagedMemorySyntheticV1Definition: BenchmarkDefinition = {
  id: STAGED_MEMORY_BENCHMARK_ID,
  title: "Staged Memory (Synthetic)",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: STAGED_MEMORY_BENCHMARK_ID,
    version: STAGED_MEMORY_GENERATOR_VERSION,
    description:
      "Deterministic three-stage synthetic benchmark for persistence, context pressure, distractor rejection, supersession, and scope safety on drift-gen material (issue #2346).",
    category: "retrieval",
    citation: "Remnic synthetic benchmark for issue #2346; staged protocol after AgeMem v3",
  },
};

/** Pinned context budget (chars) for every recall in every arm. */
export const STAGED_MEMORY_CONTEXT_BUDGET_CHARS = 2000;
/** Cost gate: staged input tokens per success may exceed persist-only by 10%. */
const STAGED_COST_TOLERANCE = 0.1;

interface Gate {
  metric: string;
  /** Staged-arm mean key (metrics record keys, not gate names). */
  meanKey: string;
  op: ">=" | "<=";
  threshold: number;
}

const GATES: readonly Gate[] = Object.freeze([
  { metric: "construction_recall", meanKey: "construction_recall", op: ">=", threshold: 0.9 },
  { metric: "supersession_accuracy", meanKey: "supersession_accuracy", op: ">=", threshold: 0.95 },
  { metric: "retrieval_recall_at_5", meanKey: "retrieval_recall_at_5", op: ">=", threshold: 0.9 },
  { metric: "task_success", meanKey: "task_success", op: ">=", threshold: 0.85 },
  { metric: "distractor_rejection", meanKey: "distractor_rejection", op: ">=", threshold: 0.95 },
  { metric: "stale_answer_rate", meanKey: "stale_answer", op: "<=", threshold: 0.05 },
  { metric: "context_reset_leakage_rate", meanKey: "context_reset_leakage", op: "<=", threshold: 0 },
  { metric: "scope_violation_rate", meanKey: "scope_violation", op: "<=", threshold: 0 },
]);

const PRIMARY_PERMUTATION_PAIRS: readonly {
  key: string;
  candidateArm: StagedMemoryArm;
  baselineArm: StagedMemoryArm;
  metric: string;
}[] = Object.freeze([
  {
    key: "distractor_rejection:staged-vs-static",
    candidateArm: "staged-memory",
    baselineArm: "static-context",
    metric: "distractor_rejection",
  },
  {
    key: "task_success:staged-vs-static",
    candidateArm: "staged-memory",
    baselineArm: "static-context",
    metric: "task_success",
  },
  {
    key: "input_tokens:staged-vs-persist",
    candidateArm: "staged-memory",
    baselineArm: "persist-only",
    metric: "input_tokens",
  },
]);

/** Deterministic token estimate: cost diagnostics only, never billed tokens. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/* ---------------------------------------------------------------------------
 * Public-template inversion (drift-gen renders statements and questions
 * through fixed ATTRIBUTE_SPECS templates; inverting those templates is
 * public knowledge and carries no answer key).
 * ------------------------------------------------------------------------- */

const CLAUSE_PATTERNS: readonly { attribute: string; pattern: RegExp }[] = [
  { attribute: "employer", pattern: /^(.{1,256}?) works at (.{1,256}?)\.?$/ },
  { attribute: "project", pattern: /^(.{1,256}?) is leading (.{1,256}?)\.?$/ },
  { attribute: "hobby", pattern: /^(.{1,256}?) has gotten into (.{1,256}?)\.?$/ },
  {
    attribute: "favorite-tool",
    pattern: /^(.{1,256}?) relies on the (.{1,256}?) for daily planning\.?$/,
  },
  { attribute: "pet", pattern: /^(.{1,256}?) has (.{1,256}?)\.?$/ },
  { attribute: "role", pattern: /^(.{1,256}?) is an? (.{1,256}?)\.?$/ },
  { attribute: "city", pattern: /^(.{1,256}?) lives in (.{1,256}?)\.?$/ },
];

const QUESTION_PATTERNS: readonly { attribute: string; pattern: RegExp }[] = [
  { attribute: "employer", pattern: /^Where does (.{1,256}?) work these days\?$/ },
  { attribute: "role", pattern: /^What does (.{1,256}?) do for a living now\?$/ },
  { attribute: "city", pattern: /^Which city is (.{1,256}?) living in currently\?$/ },
  { attribute: "hobby", pattern: /^What pastime is (.{1,256}?) into at the moment\?$/ },
  {
    attribute: "pet",
    pattern: /^What animal companion does (.{1,256}?) keep right now\?$/,
  },
  {
    attribute: "favorite-tool",
    pattern: /^Which planning app does (.{1,256}?) rely on at the moment\?$/,
  },
  {
    attribute: "project",
    pattern: /^Which initiative is (.{1,256}?) leading right now\?$/,
  },
];

interface ParsedStatement {
  subject: string;
  attribute: string;
  value: string;
}

function parseStatement(text: string): ParsedStatement | undefined {
  for (const { attribute, pattern } of CLAUSE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return {
        subject: match[1] as string,
        attribute,
        value: match[2] as string,
      };
    }
  }
  return undefined;
}

export function parseStagedQuestion(question: string): { subject: string; attribute: string } | undefined {
  for (const { attribute, pattern } of QUESTION_PATTERNS) {
    const match = pattern.exec(question);
    if (match) {
      return { subject: match[1] as string, attribute };
    }
  }
  return undefined;
}

/** Strip a trailing plural "s" so "works" matches "work" (ranking only). */
function stem(token: string): string {
  return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length > 0) tokens.add(stem(raw));
  }
  return tokens;
}

function overlapSize(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let size = 0;
  for (const token of left) {
    if (right.has(token)) size += 1;
  }
  return size;
}

/**
 * Deterministic responder: inverts the public templates on the recalled text
 * only. It never sees expected answers, gold rows, or the fixture. Absent or
 * polluted evidence yields "unknown".
 */
export function respondStagedMemory(question: string, recalledText: string): string {
  const parsed = parseStagedQuestion(question);
  if (!parsed) return "unknown";
  for (const line of recalledText.split("\n")) {
    const statement = parseStatement(line.replace(/^-\s*/, ""));
    if (statement && statement.subject === parsed.subject && statement.attribute === parsed.attribute) {
      return statement.value;
    }
  }
  return "unknown";
}

/* ---------------------------------------------------------------------------
 * Deterministic scoped staged-memory engine (the system under test).
 *
 * Every method takes { trustedPrincipal, namespace }; missing, changed, or
 * unallowlisted scope values throw. `appendContext` writes one session's
 * active context only — never persistent tuples. `resetContext` clears that
 * session's appended messages and never deletes tuples. `correct` scores
 * with the caller-pinned epoch, never the system clock.
 * ------------------------------------------------------------------------- */

interface StagedScope {
  trustedPrincipal: string;
  namespace: string;
}

interface StagedTuple {
  statement: string;
  subject: string;
  attribute: string;
  value: string;
  epoch: number;
  current: boolean;
}

export interface StagedOperationWitness {
  op: string;
  ok: boolean;
  count: number;
  status: "recorded" | "unavailable";
}

export interface StagedRecallResult {
  text: string;
  requestedChars: number;
  returnedChars: number;
  truncated: boolean;
}

export class DeterministicStagedMemory {
  private readonly tuplesByScope = new Map<string, StagedTuple[]>();
  private readonly contextBySession = new Map<string, string[]>();
  readonly witnesses: StagedOperationWitness[] = [];
  readonly counts = {
    store: 0,
    appendContext: 0,
    reset: 0,
    resetContext: 0,
    correct: 0,
    recall: 0,
    drain: 0,
  };

  constructor(private readonly allowedNamespaces: readonly string[]) {}

  private requireScope(scope: StagedScope): string {
    if (
      !scope ||
      scope.trustedPrincipal !== STAGED_MEMORY_TRUSTED_PRINCIPAL ||
      !this.allowedNamespaces.includes(scope.namespace)
    ) {
      throw new Error("staged engine rejected scope: principal or namespace not allowlisted");
    }
    return `${scope.trustedPrincipal}|${scope.namespace}`;
  }

  /** Wipe one scope's persistent tuples and every session context. */
  async reset(scope: StagedScope): Promise<void> {
    const key = this.requireScope(scope);
    this.tuplesByScope.delete(key);
    for (const sessionKey of [...this.contextBySession.keys()]) {
      if (sessionKey.startsWith(`${key}|`)) this.contextBySession.delete(sessionKey);
    }
    this.counts.reset += 1;
    this.witnesses.push({ op: "reset", ok: true, count: 1, status: "recorded" });
  }

  /**
   * Stage 1 ingestion: template-parseable statements in `messages` become
   * persistent tuples under the scope's namespace. The engine never sees
   * gold rows or IDs; construction is measured by parsing alone.
   */
  async store(scope: StagedScope, sessionId: string, messages: readonly string[], epoch: number): Promise<void> {
    const key = this.requireScope(scope);
    const tuples = this.tuplesByScope.get(key) ?? [];
    let stored = 0;
    for (const message of messages) {
      const parsed = parseStatement(message);
      if (!parsed) continue;
      tuples.push({ ...parsed, statement: message, epoch, current: true });
      stored += 1;
    }
    this.tuplesByScope.set(key, tuples);
    this.counts.store += 1;
    this.witnesses.push({
      op: "store",
      ok: true,
      count: stored,
      status: "recorded",
    });
    void sessionId;
  }

  async drain(): Promise<void> {
    this.counts.drain += 1;
    this.witnesses.push({ op: "drain", ok: true, count: 1, status: "recorded" });
  }

  /**
   * Fixture-authorized supersession scored with the pinned transition epoch
   * — never the system clock. Marks every strictly older tuple for the
   * subject+attribute non-current; unrelated facts stay unchanged.
   */
  async correct(scope: StagedScope, transition: { subject: string; attribute: string; epoch: number }): Promise<void> {
    const key = this.requireScope(scope);
    let affected = 0;
    for (const tuple of this.tuplesByScope.get(key) ?? []) {
      if (
        tuple.subject === transition.subject &&
        tuple.attribute === transition.attribute &&
        tuple.epoch < transition.epoch
      ) {
        tuple.current = false;
        affected += 1;
      }
    }
    this.counts.correct += 1;
    this.witnesses.push({
      op: "correct",
      ok: true,
      count: affected,
      status: "recorded",
    });
  }

  /** Stage 2: active-context writes for one session; tuples are untouched. */
  async appendContext(scope: StagedScope, sessionId: string, messages: readonly string[]): Promise<void> {
    const key = this.requireScope(scope);
    const sessionKey = `${key}|${sessionId}`;
    const lines = this.contextBySession.get(sessionKey) ?? [];
    lines.push(...messages);
    this.contextBySession.set(sessionKey, lines);
    this.counts.appendContext += 1;
    this.witnesses.push({
      op: "appendContext",
      ok: true,
      count: messages.length,
      status: "recorded",
    });
  }

  /** Boundary reset: clears one session's appended messages, keeps tuples. */
  async resetContext(scope: StagedScope, sessionId: string): Promise<void> {
    const key = this.requireScope(scope);
    this.contextBySession.set(`${key}|${sessionId}`, []);
    this.counts.resetContext += 1;
    this.witnesses.push({
      op: "resetContext",
      ok: true,
      count: 1,
      status: "recorded",
    });
  }

  currentTuples(scope: StagedScope): StagedTuple[] {
    return (this.tuplesByScope.get(this.requireScope(scope)) ?? []).filter((tuple) => tuple.current);
  }

  contextSnapshot(scope: StagedScope, sessionId: string): readonly string[] {
    const key = this.requireScope(scope);
    return [...(this.contextBySession.get(`${key}|${sessionId}`) ?? [])];
  }

  /**
   * Namespace-filtered deterministic recall: current tuples plus the asked
   * session's active-context lines, ranked by stemmed token overlap with the
   * query. Ties break fresher-epoch-first, then statement order (total
   * order, byte-stable across runs).
   */
  recall(
    scope: StagedScope,
    sessionId: string,
    query: string,
    budgetChars = STAGED_MEMORY_CONTEXT_BUDGET_CHARS
  ): StagedRecallResult & { rankedStatements: string[] } {
    this.requireScope(scope);
    this.counts.recall += 1;
    const queryTokens = tokenize(query);
    const candidates: { line: string; epoch: number; order: number }[] = [];
    let order = 0;
    for (const tuple of this.currentTuples(scope)) {
      candidates.push({ line: tuple.statement, epoch: tuple.epoch, order: order++ });
    }
    for (const line of this.contextSnapshot(scope, sessionId)) {
      candidates.push({ line, epoch: -1, order: order++ });
    }
    const scored = candidates
      .map((candidate) => ({
        ...candidate,
        score: overlapSize(tokenize(candidate.line), queryTokens),
      }))
      .sort((left, right) => right.score - left.score || right.epoch - left.epoch || left.order - right.order);
    const lines: string[] = [];
    let used = 0;
    let truncated = false;
    for (const candidate of scored) {
      const rendered = `- ${candidate.line}`;
      if (used + rendered.length + 1 > budgetChars) {
        truncated = true;
        break;
      }
      lines.push(rendered);
      used += rendered.length + 1;
    }
    const text = lines.join("\n");
    this.witnesses.push({
      op: "recall",
      ok: true,
      count: lines.length,
      status: "recorded",
    });
    return {
      text,
      requestedChars: budgetChars,
      returnedChars: text.length,
      truncated,
      rankedStatements: scored.map((candidate) => candidate.line),
    };
  }

  async statsAreZero(scope: StagedScope): Promise<boolean> {
    const key = this.requireScope(scope);
    const hasContext = [...this.contextBySession.keys()].some((sessionKey) => sessionKey.startsWith(`${key}|`));
    return (this.tuplesByScope.get(key) ?? []).length === 0 && !hasContext;
  }
}

/* ---------------------------------------------------------------------------
 * Case execution.
 * ------------------------------------------------------------------------- */

interface CaseRun {
  task: TaskResult;
  metrics: Record<string, number | "NA">;
}

function goldIndex(fixtureCase: StagedMemoryCaseV1): Map<string, StagedMemoryGoldFactV1> {
  return new Map(fixtureCase.exposure.goldFacts.map((gold) => [gold.factId, gold]));
}

async function runStagedCase(arm: StagedMemoryArm, fixtureCase: StagedMemoryCaseV1): Promise<CaseRun> {
  const scope: StagedScope = {
    trustedPrincipal: fixtureCase.scope.principal,
    namespace: fixtureCase.namespace,
  };
  const gold = goldIndex(fixtureCase);
  const engine = new DeterministicStagedMemory(STAGED_MEMORY_NAMESPACES);
  const started = performance.now();
  const metrics: Record<string, number | "NA"> = {};
  const details: Record<string, unknown> = { arm };

  // Invariant 1-3: fresh store, reset, assert zero stats.
  await engine.reset(scope);
  if (!(await engine.statsAreZero(scope))) {
    throw new Error(`case ${fixtureCase.caseId}: store not empty after reset`);
  }

  const runsStage1 = arm !== "empty" && arm !== "oracle-retrieval";
  if (runsStage1) {
    // Invariants 4-6: exposure ingestion in manifest order (epoch groups,
    // ascending), one drain after the stores complete.
    const epochs = [...new Set(fixtureCase.exposure.goldFacts.map((row) => row.introducedEpoch))].sort(
      (left, right) => left - right
    );
    for (const epoch of epochs) {
      const messages = fixtureCase.exposure.goldFacts
        .filter((row) => row.introducedEpoch === epoch)
        .map((row) => row.statement);
      await engine.store(scope, `${fixtureCase.exposure.sessionId}-e${epoch}`, messages, epoch);
    }
    await engine.drain();

    // Construction recall: required current facts retrievable after Stage 1.
    const currentPairs = new Set(engine.currentTuples(scope).map((tuple) => `${tuple.subject}|${tuple.attribute}`));
    let requiredHit = 0;
    for (const factId of fixtureCase.task.requiredFactIds) {
      const row = gold.get(factId);
      if (row && currentPairs.has(`${row.subject}|${row.attribute}`)) requiredHit += 1;
    }
    metrics.construction_recall = requiredHit / fixtureCase.task.requiredFactIds.length;

    // Invariants 47-49: transitions through the authorized adapter, scored
    // with the pinned epoch — never correction-planner wall-clock time.
    let validTransitions = 0;
    for (const transition of fixtureCase.transitions) {
      const oldRow = gold.get(transition.oldFactId);
      const newRow = gold.get(transition.newFactId);
      if (!oldRow || !newRow) {
        throw new Error(`case ${fixtureCase.caseId}: transition references unknown gold rows`);
      }
      await engine.correct(scope, {
        subject: oldRow.subject,
        attribute: oldRow.attribute,
        epoch: transition.epoch,
      });
      const values = engine
        .currentTuples(scope)
        .filter((tuple) => tuple.subject === oldRow.subject && tuple.attribute === oldRow.attribute)
        .map((tuple) => tuple.value);
      if (values.includes(newRow.value) && !values.includes(oldRow.value)) {
        validTransitions += 1;
      }
    }
    metrics.supersession_accuracy =
      fixtureCase.transitions.length === 0 ? "NA" : validTransitions / fixtureCase.transitions.length;

    // Retrieval diagnostics: rank of the required statement among current
    // tuples, before any distractor context exists.
    const requiredRow = gold.get(fixtureCase.task.requiredFactIds[0] as string);
    if (requiredRow) {
      const ranked = engine.recall(scope, fixtureCase.exposure.sessionId, fixtureCase.task.question).rankedStatements;
      const rank = ranked.indexOf(requiredRow.statement);
      metrics.retrieval_recall_at_1 = rank === 0 ? 1 : 0;
      metrics.retrieval_recall_at_5 = rank >= 0 && rank < 5 ? 1 : 0;
      metrics.retrieval_mrr = rank >= 0 ? 1 / (rank + 1) : 0;
    }
  } else {
    metrics.construction_recall = "NA";
    metrics.supersession_accuracy = "NA";
    metrics.retrieval_recall_at_1 = "NA";
    metrics.retrieval_recall_at_5 = "NA";
    metrics.retrieval_mrr = "NA";
  }

  // Invariants 43-46: both namespaces share one engine; a cross-namespace
  // recall must return nothing from this case's namespace.
  const otherNamespace = STAGED_MEMORY_NAMESPACES.find((namespace) => namespace !== fixtureCase.namespace) as string;
  const crossRecall = engine.recall(
    { trustedPrincipal: scope.trustedPrincipal, namespace: otherNamespace },
    fixtureCase.exposure.sessionId,
    fixtureCase.task.question
  );
  metrics.scope_violation = crossRecall.text.length > 0 ? 1 : 0;

  const appliesDistractors = arm === "static-context" || arm === "staged-memory";
  const stage2Session = fixtureCase.distractors[0]?.sessionId ?? `${fixtureCase.exposure.sessionId}-stage2`;
  const recallSession = appliesDistractors ? stage2Session : fixtureCase.exposure.sessionId;

  if (appliesDistractors) {
    // Invariant 9-13 + 21-22: reset -> append at the Stage 1/2 boundary,
    // same principal and namespace on every call, Stage 1 facts stay put.
    await engine.resetContext(scope, stage2Session);
    const survivedAfterBoundary = requiredStatementsIn(engine, scope, fixtureCase, gold);
    metrics.persistent_survival = survivedAfterBoundary ? 1 : 0;

    // Stage 2: exactly the registered distractors, never answer text.
    await engine.appendContext(
      scope,
      stage2Session,
      fixtureCase.distractors.map((distractor) => distractor.text)
    );
    details.distractorPresenceDuringStage2 = fixtureCase.distractors.filter((distractor) =>
      engine.contextSnapshot(scope, stage2Session).includes(distractor.text)
    ).length;

    if (arm === "staged-memory") {
      // Invariants 37-38: resetContext before the task query.
      await engine.resetContext(scope, stage2Session);
    }
  } else if (arm === "persist-only") {
    metrics.persistent_survival = requiredStatementsIn(engine, scope, fixtureCase, gold) ? 1 : 0;
  } else {
    metrics.persistent_survival = "NA";
  }

  // Stage 3: one recall + deterministic responder. The oracle arm recalls
  // only fixture-selected gold statements (scorer calibration, not a
  // quality claim).
  const stage3 = engine.recall(scope, recallSession, fixtureCase.task.question);
  const recallText =
    arm === "oracle-retrieval"
      ? fixtureCase.task.requiredFactIds
          .map((factId) => gold.get(factId)?.statement ?? "")
          .filter((statement) => statement.length > 0)
          .map((statement) => `- ${statement}`)
          .join("\n")
      : stage3.text;
  metrics.context_budget_utilization = recallText.length / STAGED_MEMORY_CONTEXT_BUDGET_CHARS;
  metrics.context_truncated = arm === "oracle-retrieval" ? 0 : stage3.truncated ? 1 : 0;

  if (appliesDistractors) {
    const residue = countPresent(recallText, fixtureCase);
    metrics.distractor_rejection = residue === 0 ? 1 : 0;
    metrics.context_reset_leakage = arm === "staged-memory" ? (residue > 0 ? 1 : 0) : "NA";
    if (arm === "staged-memory") {
      // Invariant 64: required facts still present after both resets.
      const requiredRow = gold.get(fixtureCase.task.requiredFactIds[0] as string);
      const survived = requiredRow ? recallText.includes(requiredRow.statement) : false;
      metrics.persistent_survival = metrics.persistent_survival === 1 && survived ? 1 : 0;
    }
  } else {
    metrics.distractor_rejection = "NA";
    metrics.context_reset_leakage = "NA";
  }

  const answer = respondStagedMemory(fixtureCase.task.question, recallText);
  metrics.task_success = exactMatch(answer, fixtureCase.task.expectedAnswer) ? 1 : 0;
  metrics.task_f1 = f1Score(answer, fixtureCase.task.expectedAnswer);
  const supersededValues = fixtureCase.task.forbiddenFactIds
    .map((factId) => gold.get(factId)?.value ?? "")
    .filter((value) => value.length > 0);
  metrics.stale_answer = fixtureCase.transitions.length > 0 && supersededValues.includes(answer) ? 1 : 0;
  metrics.input_tokens = estimateTokens(`${fixtureCase.task.question}\n${recallText}`);
  metrics.output_tokens = estimateTokens(answer);

  details.operationCounts = { ...engine.counts };
  details.distractorCounts = fixtureCase.distractors.length;
  details.witnessStatuses = [...new Set(engine.witnesses.map((w) => w.status))];
  if (engine.witnesses.some((witness) => witness.status === "unavailable")) {
    throw new Error(`case ${fixtureCase.caseId}: a staged witness is unavailable`);
  }

  const task: TaskResult = {
    taskId: `${fixtureCase.caseId}::${arm}`,
    question: fixtureCase.task.question,
    expected: fixtureCase.task.expectedAnswer,
    actual: answer,
    scores: numericScores(metrics),
    latencyMs: Math.round(performance.now() - started),
    tokens: {
      input: metrics.input_tokens as number,
      output: metrics.output_tokens as number,
    },
    details,
  };
  return { task, metrics };
}

function requiredStatementsIn(
  engine: DeterministicStagedMemory,
  scope: StagedScope,
  fixtureCase: StagedMemoryCaseV1,
  gold: Map<string, StagedMemoryGoldFactV1>
): boolean {
  const currentPairs = new Set(engine.currentTuples(scope).map((tuple) => `${tuple.subject}|${tuple.attribute}`));
  return fixtureCase.task.requiredFactIds.every((factId) => {
    const row = gold.get(factId);
    return row !== undefined && currentPairs.has(`${row.subject}|${row.attribute}`);
  });
}

function countPresent(text: string, fixtureCase: StagedMemoryCaseV1): number {
  return fixtureCase.distractors.filter((distractor) => text.includes(distractor.text)).length;
}

function numericScores(metrics: Record<string, number | "NA">): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === "number" && Number.isFinite(value)) scores[key] = value;
  }
  return scores;
}

/* ---------------------------------------------------------------------------
 * Run assembly: arms, aggregates, NA accounting, paired statistics, gates.
 * ------------------------------------------------------------------------- */

interface ArmSummary {
  arm: StagedMemoryArm;
  means: Record<string, number | "NA">;
  naMetrics: Record<string, NaMetricEntry>;
}

function summarizeArm(arm: StagedMemoryArm, runs: readonly CaseRun[]): ArmSummary {
  const means: Record<string, number | "NA"> = {};
  const naMetrics: Record<string, NaMetricEntry> = {};
  const metricNames = new Set(runs.flatMap((run) => Object.keys(run.metrics)));
  for (const metric of metricNames) {
    const values = runs.map((run) => run.metrics[metric]).filter((value): value is number => typeof value === "number");
    if (values.length === 0) {
      means[metric] = "NA";
      naMetrics[metric] = {
        denominator: 0,
        reason: `no ${arm} case produced a denominator for ${metric}`,
      };
      continue;
    }
    means[metric] = values.reduce((sum, value) => sum + value, 0) / values.length;
    const naCount = runs.length - values.length;
    if (naCount > 0) {
      naMetrics[metric] = {
        denominator: values.length,
        reason: `${naCount} of ${runs.length} ${arm} cases are NA for ${metric}`,
      };
    }
  }
  return { arm, means, naMetrics };
}

function tokensPerSuccess(summary: ArmSummary): number | "NA" {
  const { task_success: success, input_tokens: inputTokens } = summary.means;
  if (success === "NA" || inputTokens === "NA" || success === 0) return "NA";
  return inputTokens / success;
}

function normalizeControllerMode(value: unknown): StagedMemoryControllerMode {
  if (value === undefined || value === null) return "off";
  if (value === "off" || value === "shadow" || value === "active") return value;
  throw new Error('controllerMode must be "off", "shadow", or "active"; rejecting invalid input');
}

export async function runStagedMemoryBenchmark(options: ResolvedRunBenchmarkOptions): Promise<BenchmarkResult> {
  const benchmarkOptions = (options.benchmarkOptions ?? {}) as Record<string, unknown>;
  const requestedMode = normalizeControllerMode(benchmarkOptions.controllerMode);
  if (requestedMode !== "off") {
    throw new Error(
      `staged-memory-synthetic-v1 does not implement controller mode "${requestedMode}" yet: the coordinator lands with issue #2348, which depends on this benchmark`
    );
  }

  let manifest: StagedMemoryFixtureManifestV1;
  let fixtureHash: string;
  let cases: StagedMemoryCaseV1[];
  if (options.datasetDir) {
    // Full protocol: only a validated, hash-verified fixture on disk.
    const loaded = await loadStagedMemoryFixture(options.datasetDir);
    manifest = loaded.manifest;
    fixtureHash = loaded.fixtureHash;
    cases = loaded.cases;
  } else {
    if (options.mode === "full") {
      throw new Error("staged-memory-synthetic-v1 full mode requires --dataset-dir; generate a fixture first");
    }
    // Quick mode: the committed synthetic smoke corpus only — never a real
    // dataset and never a caller-owned store.
    const built = await buildStagedMemoryFixture({
      driftDir: canonicalDriftDir(),
      seed: typeof options.seed === "number" ? options.seed : 11,
      casesPerUser: options.limit && options.limit > 0 ? options.limit : 6,
      distractorCount: 3,
    });
    manifest = built.manifest;
    cases = built.cases;
    fixtureHash = createHash("sha256")
      .update(cases.map((row) => JSON.stringify(row)).join("\n"))
      .digest("hex");
  }
  if (options.limit && options.limit > 0) {
    cases = cases.slice(0, options.limit);
  }

  const runsByArm = new Map<StagedMemoryArm, CaseRun[]>();
  for (const arm of STAGED_MEMORY_ARMS) runsByArm.set(arm, []);
  const tasks: TaskResult[] = [];
  const totalTasks = cases.length * STAGED_MEMORY_ARMS.length;
  for (const fixtureCase of cases) {
    for (const arm of STAGED_MEMORY_ARMS) {
      const run = await runStagedCase(arm, fixtureCase);
      (runsByArm.get(arm) as CaseRun[]).push(run);
      tasks.push(run.task);
      options.onTaskComplete?.(run.task, tasks.length, totalTasks);
    }
  }

  const summaries: Record<string, ArmSummary> = {};
  const naMetrics: Record<string, NaMetricEntry> = {};
  for (const arm of STAGED_MEMORY_ARMS) {
    const summary = summarizeArm(arm, runsByArm.get(arm) ?? []);
    summaries[arm] = summary;
    for (const [metric, entry] of Object.entries(summary.naMetrics)) {
      naMetrics[`${arm}:${metric}`] = entry;
    }
  }
  const staged = summaries["staged-memory"] as ArmSummary;

  // Paired permutation + bootstrap, paired by case ID. NA pairs are excluded
  // pairwise; p-values are descriptive evidence, never significance claims.
  const pairedPermutation: Record<
    string,
    { pValue: number; samples: number } | "NA"
  > = {};
  const bootstrapIntervals: Record<
    string,
    { lower: number; upper: number; level: number }
  > = {};
  let pairedSeedCounter = 0;
  for (const pairing of PRIMARY_PERMUTATION_PAIRS) {
    const candidateRuns = runsByArm.get(pairing.candidateArm) ?? [];
    const baselineRuns = runsByArm.get(pairing.baselineArm) ?? [];
    const baselineByCase = new Map(baselineRuns.map((run) => [caseIdOf(run), run.metrics[pairing.metric]]));
    const differences: number[] = [];
    for (const candidate of candidateRuns) {
      const candidateValue = candidate.metrics[pairing.metric];
      const baselineValue = baselineByCase.get(caseIdOf(candidate));
      if (typeof candidateValue === "number" && typeof baselineValue === "number") {
        differences.push(candidateValue - baselineValue);
      }
    }
    if (differences.length === 0) {
      pairedPermutation[pairing.key] = "NA";
      continue;
    }
    pairedPermutation[pairing.key] = pairedPermutationTest(differences, {
      samples: STAGED_MEMORY_PERMUTATION_SAMPLES,
      seed: STAGED_MEMORY_STATISTICS_SEED,
    });
    bootstrapIntervals[pairing.key] = pairedDeltaConfidenceInterval(
      differences,
      differences.map(() => 0),
      {
        random: createSeededRandom(
          (STAGED_MEMORY_STATISTICS_SEED + pairedSeedCounter++) >>> 0,
        ),
      },
    );
  }

  const holmInput = new Map<string, number | "NA">();
  for (const [key, value] of Object.entries(pairedPermutation)) {
    holmInput.set(key, value === "NA" ? "NA" : value.pValue);
  }
  const primaryKeys = PRIMARY_PERMUTATION_PAIRS.map((pairing) => pairing.key);
  const holm = holmAdjust(holmInput, primaryKeys);

  // Deterministic gates on the staged arm plus the staged-vs-persist-only
  // cost gate. A failed gate fails the run loudly; nothing is hidden.
  const gateResults: Record<string, boolean> = {};
  for (const gate of GATES) {
    const value = staged.means[gate.meanKey];
    gateResults[gate.metric] =
      value === "NA" ? false : gate.op === ">=" ? value >= gate.threshold : value <= gate.threshold;
  }
  const stagedCost = tokensPerSuccess(staged);
  const persistCost = tokensPerSuccess(summaries["persist-only"] as ArmSummary);
  const costGate =
    stagedCost === "NA" || persistCost === "NA"
      ? true // NA cost is reported in naMetrics; it never silently blocks.
      : stagedCost <= persistCost * (1 + STAGED_COST_TOLERANCE);
  gateResults.staged_input_tokens_per_success_within_10pct_of_persist_only = costGate;
  const failedGates = Object.entries(gateResults)
    .filter(([, pass]) => !pass)
    .map(([metric]) => metric);

  const stagedOptions: Record<string, unknown> = {
    schemaVersion: 1,
    benchmark: STAGED_MEMORY_BENCHMARK_ID,
    fixtureHash,
    arms: [...STAGED_MEMORY_ARMS],
    seeds: manifest.seeds,
    statisticsSeed: STAGED_MEMORY_STATISTICS_SEED,
    permutationSamples: STAGED_MEMORY_PERMUTATION_SAMPLES,
    contextBudgetChars: STAGED_MEMORY_CONTEXT_BUDGET_CHARS,
    controllerMode: "off",
    requestedControllerMode: requestedMode,
    shadowForced: false,
    primaryPermutationMetrics: primaryKeys,
    pairedPermutation,
    bootstrapIntervals,
    holmCorrection: holm,
    naMetrics,
    armMeans: Object.fromEntries(Object.entries(summaries).map(([arm, summary]) => [arm, summary.means])),
    gates: gateResults,
    note: "observational paired differences only; no counterfactual lift claim; oracle arm is scorer calibration",
  };

  const confidenceIntervals: Record<string, { lower: number; upper: number; level: number }> = {};
  let ciSeedCounter = 0;
  for (const [metric, value] of Object.entries(staged.means)) {
    if (value === "NA") continue;
    const values = (runsByArm.get("staged-memory") ?? [])
      .map((run) => run.metrics[metric])
      .filter((candidate): candidate is number => typeof candidate === "number");
    if (values.length > 0) {
      // Seeded per metric so replayed runs reproduce identical intervals
      // (Math.random would break the determinism gate).
      confidenceIntervals[`staged-memory:${metric}`] = bootstrapMeanConfidenceInterval(values, {
        random: createSeededRandom((STAGED_MEMORY_STATISTICS_SEED + ciSeedCounter++) >>> 0),
      });
    }
  }

  const remnicVersion = await getRemnicVersion();
  const totalLatencyMs = tasks.reduce((sum, task) => sum + task.latencyMs, 0);
  const result: BenchmarkResult = {
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
      seeds: manifest.seeds,
      datasetHash: fixtureHash,
    },
    config: {
      systemProvider: options.systemProvider ?? null,
      judgeProvider: options.judgeProvider ?? null,
      adapterMode: options.adapterMode ?? "synthetic",
      remnicConfig: options.remnicConfig ?? {},
      benchmarkOptions: stagedOptions,
    },
    cost: {
      totalTokens: tasks.reduce((sum, task) => sum + task.tokens.input + task.tokens.output, 0),
      inputTokens: tasks.reduce((sum, task) => sum + task.tokens.input, 0),
      outputTokens: tasks.reduce((sum, task) => sum + task.tokens.output, 0),
      estimatedCostUsd: 0,
      totalLatencyMs,
      meanQueryLatencyMs: tasks.length > 0 ? totalLatencyMs / tasks.length : 0,
    },
    results: {
      tasks,
      aggregates: aggregateTaskScores(tasks.map((task) => task.scores)),
      categoryAggregates: Object.fromEntries(
        STAGED_MEMORY_ARMS.map((arm) => {
          const armTasks = (runsByArm.get(arm) ?? []).map((run) => run.task.scores);
          return [arm, aggregateTaskScores(armTasks)];
        })
      ),
      statistics: {
        confidenceIntervals,
        bootstrapSamples: 10_000,
        effectSizes: {},
      },
    },
    environment: {
      os: process.platform,
      nodeVersion: process.version,
      hardware: process.arch,
    },
  };

  if (failedGates.length > 0) {
    throw new Error(`staged-memory-synthetic-v1 gates failed: ${failedGates.join(", ")}`, {
      cause: result,
    });
  }
  return result;
}

function caseIdOf(run: CaseRun): string {
  return run.task.taskId.split("::")[0] as string;
}

/**
 * Sanitized public projection per arm. IDs, counts, hashes, metrics, seeds,
 * and statuses only — question, expected, actual, recalled, gold, and
 * distractor text never cross this boundary.
 */
export function toStagedMemoryPublicResults(result: BenchmarkResult): StagedMemoryPublicResultV1[] {
  const stagedOptions = (result.config.benchmarkOptions ?? {}) as Record<string, unknown>;
  const armMeans = (stagedOptions.armMeans ?? {}) as Record<string, Record<string, number | "NA">>;
  const naMetrics = (stagedOptions.naMetrics ?? {}) as Record<string, NaMetricEntry>;
  const paired = (stagedOptions.pairedPermutation ?? {}) as StagedMemoryPublicResultV1["pairedPermutation"];
  const holm = (stagedOptions.holmCorrection ?? {}) as StagedMemoryPublicResultV1["holmCorrection"];
  const stagedMeans = armMeans["staged-memory"] ?? {};
  const receiptMetrics: Record<string, number | "NA"> = {
    persistent_survival_rate: stagedMeans.persistent_survival ?? "NA",
    scope_violation_rate: stagedMeans.scope_violation ?? "NA",
    context_reset_leakage_rate: stagedMeans.context_reset_leakage ?? "NA",
  };
  return Object.keys(armMeans).map((arm) => {
    const projection: Omit<StagedMemoryPublicResultV1, "integrity"> = {
      schemaVersion: 1,
      benchmark: STAGED_MEMORY_BENCHMARK_ID,
      runId: result.meta.id,
      fixtureHash: String(stagedOptions.fixtureHash ?? ""),
      arm,
      controllerMode: "off",
      requestedControllerMode: (stagedOptions.requestedControllerMode ?? "off") as StagedMemoryControllerMode,
      coordinatorVersion: "none",
      promotionReportHash: "none",
      shadowForced: false,
      receiptMetrics,
      executorCounts: {},
      seeds: result.meta.seeds,
      metrics: armMeans[arm] ?? {},
      naMetrics,
      pairedPermutation: paired,
      holmCorrection: holm,
    };
    const resultSha256 = createHash("sha256").update(JSON.stringify(projection)).digest("hex");
    return {
      ...projection,
      integrity: {
        manifestSha256: String(stagedOptions.fixtureHash ?? ""),
        resultSha256,
      },
    };
  });
}

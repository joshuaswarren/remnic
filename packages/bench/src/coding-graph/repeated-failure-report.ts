import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomically } from "@remnic/core/maintenance/atomic-file";
import { z } from "zod";
import { captureBenchmarkExecutionProvenance, getRemnicVersion } from "../reporter.js";
import { compareCodePoints } from "../codepoint-order.js";
import { resolveContainedPath } from "../filename-safety.js";
import {
  calculateJaccardSimilarity,
  computeH6InventoryHash,
  H6_FROZEN_INVENTORY_HASH,
  H6_FROZEN_SPLITS,
  loadCommittedH6BenchmarkDataset,
  resolveCommittedH6FixtureDirectory,
  type H6BenchmarkDataset,
} from "./repo-gen/index.js";
import {
  computeAnalysisHarnessHash,
  verifyRunManifest,
} from "./repeated-failure-suite-analysis.js";
import {
  buildHistoryTemplate,
  freezeHistory,
  parseDesign,
  parseEpisodesJsonl,
  parseRunMetadata,
} from "./repeated-failure-suite-execution.js";
import { buildTimingEvidenceAudit, type TimingEvidenceSourceRow } from "./repeated-failure-suite-output.js";
import { buildRepeatedFailureRowKey } from "./repeated-failure-store.js";
import { analyzeRepeatedFailureRows } from "./repeated-failure-stats.js";
import {
  verifyTrapAuditArtifact,
  type RepeatedFailureTrapAuditRowIdentity,
} from "./repeated-failure-trap-audit.js";
import {
  DecisionRuleSchema,
  FROZEN_SEEDS,
  REPEATED_FAILURE_ANALYSIS_VERSION,
  TIMIDITY_ARMS,
  assertNoSymlinkComponents,
  countFactTokens,
  stableStringify,
  publicError,
  type FactPairAuditPair,
  type HistoryTemplate,
} from "./repeated-failure-suite-shared.js";
import {
  REPEATED_FAILURE_ARMS,
  type RepeatedFailureRunMetadata,
  type RepeatedFailureEpisodeRow,
  type RepeatedFailureCliCommandResult,
} from "./repeated-failure-types.js";

import {
  AuditSchema,
  FactPairAuditSchema,
  MainPowerEvidenceSchema,
  RegisteredFactPairAuditSchema,
  SHA256,
  StatisticsSchema,
  TraceTimingSchema,
  aggregateArmOutcomes,
  assessClaimEligibility,
  registeredProfileBindingsMatch,
  renderArmFigure,
  renderArmTable,
  renderEffectsFigure,
  renderEffectsTable,
  renderReport,
  renderTaskCutsTable,
  renderTaskSetTable,
  sha256,
} from "./repeated-failure-report-rendering.js";

export { registeredProfileBindingsMatch };

const SOURCE_ARTIFACTS = [
  "MANIFEST.json",
  "audit.json",
  "decision-rule.json",
  "deviations.jsonl",
  "episodes.jsonl",
  "expected-design.json",
  "fact-pair-audit.json",
  "power.json",
  "run.json",
  "statistics.json",
] as const;


export interface WriteRepeatedFailurePaperArtifactsOptions {
  runDir: string;
  dataset?: H6BenchmarkDataset;
}

export interface RepeatedFailurePaperArtifactsResult {
  reportPath: string;
  manifestPath: string;
  artifactPaths: readonly string[];
}

async function readArtifactLeaf(filePath: string): Promise<Buffer> {
  const leaf = await lstat(filePath);
  if (!leaf.isFile()) {
    throw new Error(`paper artifact leaf must be a regular file: ${path.basename(filePath)}`);
  }
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`paper artifact leaf must be a regular file: ${path.basename(filePath)}`);
    }
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error(`paper artifact leaf must be a regular file: ${path.basename(filePath)}`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readSourceArtifacts(runDir: string): Promise<Record<(typeof SOURCE_ARTIFACTS)[number], string>> {
  const values = await Promise.all(SOURCE_ARTIFACTS.map(async (fileName) => {
    const filePath = resolveContainedPath(runDir, fileName);
    return [fileName, (await readArtifactLeaf(filePath)).toString("utf8")] as const;
  }));
  return Object.fromEntries(values) as Record<(typeof SOURCE_ARTIFACTS)[number], string>;
}

function expectedRegisteredDesign(
  run: RepeatedFailureRunMetadata,
  dataset: H6BenchmarkDataset,
): { primaryKeys: Set<string>; timidityKeys: Set<string>; allKeys: string[] } {
  const taskIds = run.phase === "main" ? dataset.splits.main : run.phase === "pilot" ? dataset.splits.pilot : [];
  const tasksById = new Map(dataset.tasks.map((task) => [task.id, task]));
  const primaryKeys = new Set<string>();
  const timidityKeys = new Set<string>();
  for (const taskId of taskIds) {
    const task = tasksById.get(taskId);
    if (!task) throw new Error(`frozen split references missing task ${taskId}`);
    for (const variant of task.variants) {
      for (const [index, modelProfileId] of run.modelProfileIds.entries()) {
        const modelProfileHash = run.modelProfileHashes[index];
        if (!modelProfileHash) throw new Error("model profile identity arrays are misaligned");
        for (const seed of FROZEN_SEEDS) {
          for (const arm of REPEATED_FAILURE_ARMS) {
            primaryKeys.add(buildRepeatedFailureRowKey({
              suiteVersion: run.suiteVersion,
              taskId,
              variantId: variant.variantId,
              modelProfileId,
              modelProfileHash,
              seed,
              arm,
            }));
          }
          for (const arm of TIMIDITY_ARMS) {
            timidityKeys.add(buildRepeatedFailureRowKey({
              suiteVersion: run.suiteVersion,
              taskId,
              variantId: `${variant.variantId}:no-trap`,
              modelProfileId,
              modelProfileHash,
              seed,
              arm,
            }));
          }
        }
      }
    }
  }
  return {
    primaryKeys,
    timidityKeys,
    allKeys: [...primaryKeys, ...timidityKeys].sort(compareCodePoints),
  };
}

function expectedRegisteredRunOrder(
  run: RepeatedFailureRunMetadata,
  dataset: H6BenchmarkDataset,
  phase: "pilot" | "main",
): RepeatedFailureRunMetadata["runOrder"] {
  const taskIds = phase === "main" ? dataset.splits.main : dataset.splits.pilot;
  const selectedTasks = dataset.tasks
    .filter((task) => taskIds.includes(task.id))
    .sort((left, right) => compareCodePoints(left.id, right.id));
  const profiles = run.modelProfileIds.map((modelProfileId, index) => ({
    modelProfileId,
    modelProfileHash: run.modelProfileHashes[index]!,
  })).sort((left, right) => compareCodePoints(
    `${left.modelProfileId}\u0000${left.modelProfileHash}`,
    `${right.modelProfileId}\u0000${right.modelProfileHash}`,
  ));
  const order: RepeatedFailureRunMetadata["runOrder"][number][] = [];
  for (const task of selectedTasks) {
    for (const variant of [...task.variants].sort(
      (left, right) => compareCodePoints(left.variantId, right.variantId),
    )) {
      for (const seed of FROZEN_SEEDS) {
        for (const profile of profiles) {
          for (const arm of REPEATED_FAILURE_ARMS) {
            const identity = {
              suiteVersion: run.suiteVersion,
              taskId: task.id,
              variantId: variant.variantId,
              ...profile,
              seed,
              arm,
            };
            order.push({
              rowKey: buildRepeatedFailureRowKey(identity),
              analysis: "PRIMARY",
              identity,
            });
          }
          for (const arm of TIMIDITY_ARMS) {
            const identity = {
              suiteVersion: run.suiteVersion,
              taskId: task.id,
              variantId: `${variant.variantId}:no-trap`,
              ...profile,
              seed,
              arm,
            };
            order.push({
              rowKey: buildRepeatedFailureRowKey(identity),
              analysis: "TIMIDITY",
              identity,
            });
          }
        }
      }
    }
  }
  return order;
}

async function verifyRegisteredFactPairs(
  rawArtifact: unknown,
  rows: readonly RepeatedFailureEpisodeRow[],
  run: RepeatedFailureRunMetadata,
  dataset: H6BenchmarkDataset,
): Promise<readonly FactPairAuditPair[]> {
  const artifact = RegisteredFactPairAuditSchema.parse(rawArtifact);
  const cells = new Map<string, RepeatedFailureEpisodeRow>();
  for (const row of rows) {
    if (row.identity.variantId.endsWith(":no-trap")) continue;
    const cell = stableStringify({
      taskId: row.identity.taskId,
      variantId: row.identity.variantId,
      seed: row.identity.seed,
      modelProfileId: row.identity.modelProfileId,
      modelProfileHash: row.identity.modelProfileHash,
    });
    if (!cells.has(cell)) cells.set(cell, row);
  }
  if (artifact.pairs.length !== cells.size) {
    throw new Error("paper report fact-pair population is incomplete");
  }
  const tasksById = new Map(dataset.tasks.map((task) => [task.id, task]));
  const templates = new Map<string, HistoryTemplate>();
  const seen = new Set<string>();
  for (const pair of artifact.pairs) {
    const identity = {
      taskId: pair.taskId,
      variantId: pair.variantId,
      seed: pair.seed,
      modelProfileId: pair.modelProfileId,
      modelProfileHash: pair.modelProfileHash,
    };
    const cell = stableStringify(identity);
    const row = cells.get(cell);
    if (!row || seen.has(cell)) throw new Error("paper report fact-pair identities do not match registered cells");
    seen.add(cell);
    const profileIndex = run.modelProfileIds.findIndex(
      (id, index) => id === pair.modelProfileId && run.modelProfileHashes[index] === pair.modelProfileHash,
    );
    const tokenizerIdentity = run.modelTokenizerIdentities[profileIndex];
    const tokenizerImplementation = run.modelTokenizerImplementations[profileIndex];
    if (!tokenizerIdentity || tokenizerImplementation !== "nfkc-whitespace-v1") {
      throw new Error("paper report fact-pair tokenizer is not bound to the run profile");
    }
    const task = tasksById.get(pair.taskId);
    const variant = task?.variants.find((candidate: { variantId: string }) => candidate.variantId === pair.variantId);
    if (!task || !variant) throw new Error("paper report fact-pair references an unknown frozen variant");
    const templateKey = `${task.id}\u0000${variant.variantId}`;
    let template = templates.get(templateKey);
    if (!template) {
      template = await buildHistoryTemplate(task, variant);
      templates.set(templateKey, template);
    }
    const history = freezeHistory(template, row.identity);
    const tokenizer = { identity: tokenizerIdentity, implementation: tokenizerImplementation } as const;
    const failureTokens = countFactTokens(history.failureFact, tokenizer);
    const successTokens = countFactTokens(history.successFact, tokenizer);
    const tokenGap = Math.abs(failureTokens - successTokens);
    const jaccard = calculateJaccardSimilarity(history.failureFact, history.successFact);
    const expected: FactPairAuditPair = {
      pairKey: sha256(cell),
      ...identity,
      tokenizerIdentity,
      tokenizerImplementation,
      historyHash: history.historyHash,
      failureRepoHash: history.failureRepoHash,
      successRepoHash: history.successRepoHash,
      failureActionFingerprint: history.failureActionIdentity.fingerprint,
      successActionFingerprint: history.successActionIdentity.fingerprint,
      failurePathShapeHash: history.failurePathShapeHash,
      successPathShapeHash: history.successPathShapeHash,
      failureActionShapeHash: history.failureActionShapeHash,
      successActionShapeHash: history.successActionShapeHash,
      failureFactId: history.failureFactId,
      failureCitationHash: history.failureCitationHash,
      failureFactHash: sha256(history.failureFact),
      successFactHash: sha256(history.successFact),
      failureFactCount: 1,
      successFactCount: 1,
      failureTokens,
      successTokens,
      tokenGap,
      relativeTokenGap: tokenGap / Math.max(failureTokens, successTokens, 1),
      jaccard,
      status: history.failurePathShapeHash === history.successPathShapeHash
        && history.failureActionShapeHash === history.successActionShapeHash
        && tokenGap <= artifact.maximumTokenGap
        && tokenGap / Math.max(failureTokens, successTokens, 1) <= artifact.maximumRelativeTokenGap
        && jaccard >= artifact.minimumJaccard
        ? "MATCHED"
        : "UNMATCHED",
    };
    if (stableStringify(pair) !== stableStringify(expected)) {
      throw new Error("paper report fact-pair evidence does not replay from the frozen dataset");
    }
  }
  return artifact.pairs;
}

async function assertArtifactMayBeWritten(filePath: string, content: string): Promise<boolean> {
  try {
    const prior = await readArtifactLeaf(filePath);
    if (!prior.equals(Buffer.from(content))) {
      throw new Error(`paper writer refuses to overwrite changed paper artifact: ${path.basename(filePath)}`);
    }
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

export async function writeRepeatedFailurePaperArtifacts(
  options: WriteRepeatedFailurePaperArtifactsOptions,
): Promise<RepeatedFailurePaperArtifactsResult> {
  const runDir = path.resolve(options.runDir);
  const reproManifest = await verifyRunManifest(runDir);
  const source = await readSourceArtifacts(runDir);
  const runJson = JSON.parse(source["run.json"]) as unknown;
  const runBinding = z.object({
    decisionRuleHash: z.string().regex(SHA256),
    preregistrationPath: z.string().min(1),
    preregistrationHash: z.string().regex(SHA256),
  }).passthrough().parse(runJson);
  const decisionRuleBytes = source["decision-rule.json"];
  const decisionRule = DecisionRuleSchema.parse(JSON.parse(decisionRuleBytes));
  if (sha256(decisionRuleBytes) !== runBinding.decisionRuleHash) {
    throw new Error("paper report decision rule does not match run metadata");
  }
  if (
    decisionRule.preregistration.path !== runBinding.preregistrationPath
    || decisionRule.preregistration.sha256 !== runBinding.preregistrationHash
  ) {
    throw new Error("paper report preregistration does not match run metadata");
  }
  const committedFixtureDir = await resolveCommittedH6FixtureDirectory();
  const committedDecisionRuleBytes = (
    await readArtifactLeaf(path.join(committedFixtureDir, "decision-rule.json"))
  ).toString("utf8");
  if (decisionRuleBytes !== committedDecisionRuleBytes) {
    throw new Error("paper report decision rule differs from the frozen committed artifact");
  }
  const run = parseRunMetadata(runJson);
  const mainPowerEvidence = MainPowerEvidenceSchema.safeParse(JSON.parse(source["power.json"]));
  const pilotEvidenceMatched = run.phase !== "main" || (
    run.pilotEvidence !== undefined
    && mainPowerEvidence.success
    && mainPowerEvidence.data.pilotRunId === run.pilotEvidence.runId
    && mainPowerEvidence.data.pilotManifestArtifactHash === run.pilotEvidence.manifestArtifactHash
    && mainPowerEvidence.data.pilotPowerArtifactHash === run.pilotEvidence.powerArtifactHash
  );
  const statistics = StatisticsSchema.parse(JSON.parse(source["statistics.json"]));
  const audit = AuditSchema.parse(JSON.parse(source["audit.json"]));
  const rows = parseEpisodesJsonl(source["episodes.jsonl"]);
  const design = parseDesign(JSON.parse(source["expected-design.json"]));
  if (sha256(stableStringify(design)) !== run.expectedDesignHash) {
    throw new Error("paper report expected design does not match run metadata");
  }
  const currentHarnessVersion = await getRemnicVersion();
  const currentHarnessSourceHash = await computeAnalysisHarnessHash();
  const provenance = captureBenchmarkExecutionProvenance();
  const currentProvenanceHash = sha256(stableStringify({
    analysisVersion: REPEATED_FAILURE_ANALYSIS_VERSION,
    harnessVersion: currentHarnessVersion,
    harnessSourceHash: currentHarnessSourceHash,
    gitSha: provenance.gitSha,
    gitDirty: provenance.gitDirty,
    gitDirtyEntryCount: provenance.gitDirtyEntryCount,
  }));
  if (
    run.analysisVersion !== REPEATED_FAILURE_ANALYSIS_VERSION
    || run.harnessVersion !== currentHarnessVersion
    || run.harnessSourceHash !== currentHarnessSourceHash
    || run.provenanceHash !== currentProvenanceHash
  ) {
    throw new Error("paper report harness provenance does not match run metadata");
  }
  const dataset = options.dataset ?? await loadCommittedH6BenchmarkDataset();
  const { inventoryHash: datasetInventoryHash, ...hashableDataset } = dataset;
  if (
    computeH6InventoryHash(hashableDataset) !== datasetInventoryHash
    || datasetInventoryHash !== H6_FROZEN_INVENTORY_HASH
    || datasetInventoryHash !== run.datasetInventoryHash
  ) {
    throw new Error("paper report dataset inventory does not match run metadata");
  }
  const recomputedStatistics = analyzeRepeatedFailureRows(rows, {
    expectedDesign: design.primary,
    timidityDesign: design.timidity,
    seed: run.statisticsSeed,
    draws: run.statisticsDraws,
    alpha: decisionRule.analysis.alpha,
    timingMinimumRrr: decisionRule.hypotheses["H6-timing"].minimumRelativeRiskReduction,
    timingMinimumAbsoluteBenefit:
      decisionRule.hypotheses["H6-timing"].minimumAbsoluteRepeatedFailureBenefit,
    timingMinimumBenefitIntervalLower:
      decisionRule.hypotheses["H6-timing"].requireRepeatedFailureBenefitIntervalLowerStrictlyAbove,
    contentMinimumRepeatedFailureBenefitIntervalLower:
      decisionRule.hypotheses["H6-content"].requireRepeatedFailureBenefitIntervalLowerStrictlyAbove,
    contentMinimumTaskPassBenefitIntervalLower:
      decisionRule.hypotheses["H6-content"].requireTaskPassBenefitIntervalLowerStrictlyAbove,
    timidityPassMargin: decisionRule.timidity.passRateMargin,
    timidityStepsMargin: decisionRule.timidity.stepsMargin,
  });
  if (stableStringify(statistics) !== stableStringify(recomputedStatistics)) {
    throw new Error("paper report statistics do not replay from immutable rows");
  }
  const registeredDesign = expectedRegisteredDesign(run, dataset);
  const expectedKeys = design.runOrder.map((entry) => entry.rowKey).sort(compareCodePoints);
  const actualKeys = rows.map((row) => row.rowKey).sort(compareCodePoints);
  const primaryDesignKeys = design.primary.rows.map(buildRepeatedFailureRowKey).sort(compareCodePoints);
  const timidityDesignKeys = design.timidity.rows.map(buildRepeatedFailureRowKey).sort(compareCodePoints);
  const frozenMainRunOrder = expectedRegisteredRunOrder(run, dataset, "main");
  const runOrderMatches = run.runOrder.every(
    (entry) => entry.rowKey === buildRepeatedFailureRowKey(entry.identity),
  )
    && stableStringify(run.runOrder) === stableStringify(design.runOrder)
    && (run.phase !== "main"
      || stableStringify(run.runOrder) === stableStringify(frozenMainRunOrder));
  const exactRows = stableStringify(expectedKeys) === stableStringify(registeredDesign.allKeys)
    && stableStringify(actualKeys) === stableStringify(registeredDesign.allKeys)
    && stableStringify(primaryDesignKeys)
      === stableStringify([...registeredDesign.primaryKeys].sort(compareCodePoints))
    && stableStringify(timidityDesignKeys)
      === stableStringify([...registeredDesign.timidityKeys].sort(compareCodePoints))
    && rows.length === run.expectedRowCount
    && run.expectedRowCount === registeredDesign.allKeys.length
    && runOrderMatches;
  const deviationLines = source["deviations.jsonl"].split("\n").filter((line) => line.length > 0);
  for (const line of deviationLines) {
    const deviation = JSON.parse(line) as unknown;
    if (!deviation || typeof deviation !== "object" || Array.isArray(deviation)) {
      throw new Error("paper report deviations artifact is malformed");
    }
  }
  const rawFactPairAudit = JSON.parse(source["fact-pair-audit.json"]) as unknown;
  const factPairAudit = FactPairAuditSchema.parse(rawFactPairAudit);
  const registeredEvidenceRequired = exactRows
    && (run.phase === "pilot" || run.phase === "main")
    && run.modelProfileIds.length === 2;
  const registeredFactPairs = registeredEvidenceRequired
    ? await verifyRegisteredFactPairs(rawFactPairAudit, rows, run, dataset)
    : undefined;
  const factPairsForEligibility = registeredFactPairs ?? factPairAudit.pairs;
  const factPairsMatched = factPairsForEligibility.length === audit.factPairs.pairCount
    && factPairsForEligibility.every((pair) => pair.status === "MATCHED")
    && rows.filter((row) => !row.identity.variantId.endsWith(":no-trap"))
      .every((row) => row.factPairAudit === "MATCHED");
  const isolationIds = rows.flatMap((row) => row.isolation ? Object.values(row.isolation) : []);
  const primaryStartHashes = new Map<string, Set<string>>();
  for (const row of rows.filter((entry) => !entry.identity.variantId.endsWith(":no-trap"))) {
    const cell = stableStringify({
      taskId: row.identity.taskId,
      variantId: row.identity.variantId,
      seed: row.identity.seed,
      modelProfileId: row.identity.modelProfileId,
      modelProfileHash: row.identity.modelProfileHash,
    });
    const hashes = primaryStartHashes.get(cell) ?? new Set<string>();
    if (row.evidence) hashes.add(row.evidence.startRepoHash);
    primaryStartHashes.set(cell, hashes);
  }
  const isolationMatched = isolationIds.length === rows.length * 7
    && new Set(isolationIds).size === isolationIds.length
    && [...primaryStartHashes.values()].every((hashes) => hashes.size === 1)
    && audit.isolation.allUnique
    && audit.isolation.primaryStartHashesMatchWithinCells;
  const expectedNoTrapKeys = new Set(design.timidity.rows.map(buildRepeatedFailureRowKey));
  const noTrapRows = rows.filter((row) => expectedNoTrapKeys.has(row.rowKey));
  const noTrapPassed = expectedNoTrapKeys.size > 0
    && noTrapRows.length === expectedNoTrapKeys.size
    && noTrapRows.every((row) =>
      row.status === "VALID" && row.finalState === "NO_TRAP" && row.taskPassed === true
    )
    && audit.noTrap.allPassed;
  const supplementalByPath = new Map(
    (reproManifest.supplementalArtifacts ?? []).map((artifact) => [artifact.path, artifact]),
  );
  const trapAuditRowIdentities = [
    ...H6_FROZEN_SPLITS.dev,
    ...H6_FROZEN_SPLITS.pilot,
    ...H6_FROZEN_SPLITS.main,
  ].map((taskId): RepeatedFailureTrapAuditRowIdentity => {
    const variantId = `${taskId}-v1`;
    return {
      taskId,
      variantId,
      rowKey: buildRepeatedFailureRowKey({
        suiteVersion: `h6-failure-gate-v1-${run.datasetInventoryHash}-${run.harnessSourceHash}`,
        taskId,
        variantId,
        modelProfileId: "",
        modelProfileHash: "",
        seed: 1,
        arm: "NO_MEMORY",
      }),
    };
  });
  const boundReceiptHashes = new Map<string, string>();
  const trapAuditChecks = await Promise.all(run.trapAuditReceipts.map(async (receipt) => {
    const profileIndex = run.modelProfileIds.findIndex(
      (id, index) => id === receipt.modelProfileId && run.modelProfileHashes[index] === receipt.modelProfileHash,
    );
    if (profileIndex < 0) return false;
    if (run.modelDigests[profileIndex] !== receipt.modelDigest) return false;
    if (
      run.modelTokenizerIdentities[profileIndex] !== receipt.tokenizerIdentity
      || run.modelTokenizerImplementations[profileIndex] !== receipt.tokenizerImplementation
    ) return false;
    const listed = supplementalByPath.get(receipt.path);
    if (!listed) return false;
    const receiptBytes = await readArtifactLeaf(resolveContainedPath(runDir, receipt.path));
    if (sha256(receiptBytes) !== listed.sha256) return false;
    const artifact = JSON.parse(receiptBytes.toString("utf8")) as unknown;
    const profileRows = trapAuditRowIdentities.map((identity) => ({
      ...identity,
      rowKey: buildRepeatedFailureRowKey({
        suiteVersion: `h6-failure-gate-v1-${run.datasetInventoryHash}-${run.harnessSourceHash}`,
        taskId: identity.taskId,
        variantId: identity.variantId,
        modelProfileId: receipt.modelProfileId,
        modelProfileHash: receipt.modelProfileHash,
        seed: 1,
        arm: "NO_MEMORY",
      }),
    }));
    const verification = verifyTrapAuditArtifact(artifact, {
      modelProfileId: receipt.modelProfileId,
      modelProfileHash: receipt.modelProfileHash,
      modelDigest: receipt.modelDigest,
      datasetInventoryHash: run.datasetInventoryHash,
      harnessSourceHash: run.harnessSourceHash,
      decisionRuleHash: run.decisionRuleHash,
      thresholds: decisionRule.trapAudit,
      rowIdentities: profileRows,
    });
    if (
      !verification.valid
      || !artifact
      || typeof artifact !== "object"
      || !("artifactHash" in artifact)
      || artifact.artifactHash !== receipt.artifactHash
    ) {
      return false;
    }
    boundReceiptHashes.set(receipt.path, listed.sha256);
    return true;
  }));
  const trapAuditsMatch = !registeredEvidenceRequired || (
    run.trapAuditReceipts.length === run.modelProfileIds.length
    && new Set(run.trapAuditReceipts.map(
      (receipt) => `${receipt.modelProfileId}\u0000${receipt.modelProfileHash}`,
    )).size === run.modelProfileIds.length
    && trapAuditChecks.every(Boolean)
  );
  const traceChecks = await Promise.all(rows.map(async (row) => {
    if (!row.evidence) return false;
    const listed = supplementalByPath.get(row.evidence.traceArtifactPath);
    if (!listed || listed.sha256 !== row.evidence.traceArtifactHash) return false;
    const tracePath = resolveContainedPath(runDir, row.evidence.traceArtifactPath);
    const traceBytes = await readArtifactLeaf(tracePath);
    return sha256(traceBytes) === row.evidence.traceArtifactHash;
  }));
  const tracesDurable = traceChecks.length === rows.length
    && traceChecks.every(Boolean)
    && audit.traces.allDurable;
  let timingEvidenceMatched = audit.timingEvidence.allMatched;
  if (registeredFactPairs) {
    const timingRows: TimingEvidenceSourceRow[] = await Promise.all(rows.filter(
      (row) => !row.identity.variantId.endsWith(":no-trap")
        && (row.identity.arm === "TURN_START_FAILURE" || row.identity.arm === "PRE_ACTION_FAILURE"),
    ).map(async (row) => {
      if (!row.evidence) throw new Error("registered timing row is missing durable evidence");
      const trace = TraceTimingSchema.parse(JSON.parse(
        (await readArtifactLeaf(resolveContainedPath(runDir, row.evidence.traceArtifactPath))).toString("utf8"),
      ));
      return {
        row,
        timingPayload: trace.armAudit.timingPayload,
        turnStartFactHash: trace.armAudit.turnStartFactHash,
        preActionFailureFactHash: trace.armAudit.preActionFailureFactHash,
      };
    }));
    const derivedTimingEvidence = buildTimingEvidenceAudit(registeredFactPairs, timingRows);
    timingEvidenceMatched = derivedTimingEvidence.allMatched
      && stableStringify(derivedTimingEvidence) === stableStringify(audit.timingEvidence);
  }
  const runProfiles = run.modelProfileIds.map(
    (id, index) => `${id}\u0000${run.modelProfileHashes[index] ?? ""}`,
  ).sort(compareCodePoints);
  const runExecutionProfiles = run.modelProfileIds.map(
    (id, index) => [
      id,
      run.modelProfileHashes[index] ?? "",
      run.modelDigests[index] ?? "",
      run.modelDriverKinds[index] ?? "",
      run.modelTokenizerIdentities[index] ?? "",
      run.modelTokenizerImplementations[index] ?? "",
    ].join("\u0000"),
  ).sort(compareCodePoints);
  const pilotProfileBindings = mainPowerEvidence.success
    ? mainPowerEvidence.data.pilotProfileBindings.map((profile) => [
        profile.id,
        profile.hash,
        profile.modelDigest,
        profile.driverKind,
        profile.tokenizerIdentity,
        profile.tokenizerImplementation,
      ].join("\u0000")).sort(compareCodePoints)
    : [];
  const sortedRunReceipts = [...run.trapAuditReceipts].sort(
    (left, right) => compareCodePoints(stableStringify(left), stableStringify(right)),
  );
  const sortedPilotReceipts = mainPowerEvidence.success
    ? [...mainPowerEvidence.data.pilotTrapAuditReceipts].sort(
        (left, right) => compareCodePoints(stableStringify(left), stableStringify(right)),
      )
    : [];
  const expectedPilotRunOrder = expectedRegisteredRunOrder(run, dataset, "pilot");
  const pilotContinuityMatched = run.phase !== "main" || (
    mainPowerEvidence.success
    && stableStringify(pilotProfileBindings) === stableStringify(runExecutionProfiles)
    && stableStringify(sortedPilotReceipts) === stableStringify(sortedRunReceipts)
    && stableStringify(mainPowerEvidence.data.pilotRunOrder)
      === stableStringify(expectedPilotRunOrder)
    && mainPowerEvidence.data.pilotPowerArtifactHash
      === sha256(stableStringify(mainPowerEvidence.data.pilot))
    && mainPowerEvidence.data.pilot.source.expectedDesignHash
      === mainPowerEvidence.data.pilotExpectedDesignHash
    && mainPowerEvidence.data.pilot.source.episodesHash
      === mainPowerEvidence.data.pilotEpisodesHash
    && mainPowerEvidence.data.pilot.source.decisionRuleHash === run.decisionRuleHash
    && mainPowerEvidence.data.pilot.method.analysisVersion === run.analysisVersion
    && mainPowerEvidence.data.pilot.draws === run.statisticsDraws
    && mainPowerEvidence.data.pilot.analysisDraws === run.statisticsDraws
  );
  const runContractProfiles = run.modelProfileIds.map(
    (id, index) => [
      id,
      run.modelProfileHashes[index] ?? "",
      run.modelDigests[index] ?? "",
      run.modelTokenizerIdentities[index] ?? "",
      run.modelTokenizerImplementations[index] ?? "",
    ].join("\u0000"),
  ).sort(compareCodePoints);
  const auditProfiles = audit.modelProfiles.map(
    (profile) => `${profile.id}\u0000${profile.hash}`,
  ).sort(compareCodePoints);
  const auditExecutionProfiles = audit.modelProfiles.map(
    (profile) => [
      profile.id,
      profile.hash,
      profile.modelDigest,
      profile.driverKind,
      profile.tokenizerIdentity,
      profile.tokenizerImplementation,
    ].join("\u0000"),
  ).sort(compareCodePoints);
  const contractProfiles = audit.runContract.modelProfiles.map(
    (profile) => [
      profile.id,
      profile.hash,
      profile.modelDigest,
      profile.tokenizerIdentity,
      profile.tokenizerImplementation,
    ].join("\u0000"),
  ).sort(compareCodePoints);
  const manifestProfiles = reproManifest.run.runtimeProfiles.map((profile) => {
    const separator = profile.lastIndexOf("@");
    return separator < 1 ? profile : `${profile.slice(0, separator)}\u0000${profile.slice(separator + 1)}`;
  }).sort(compareCodePoints);
  const rowProfiles = [...new Set(rows.map(
    (row) => `${row.identity.modelProfileId}\u0000${row.identity.modelProfileHash}`,
  ))].sort(compareCodePoints);
  const modelIdentitiesMatch = run.modelProfileIds.length === run.modelProfileHashes.length
    && run.modelProfileIds.length === run.modelDigests.length
    && run.modelProfileIds.length === run.modelDriverKinds.length
    && run.modelProfileIds.length === run.modelTokenizerIdentities.length
    && run.modelProfileIds.length === run.modelTokenizerImplementations.length
    && stableStringify(runProfiles) === stableStringify(auditProfiles)
    && stableStringify(runExecutionProfiles) === stableStringify(auditExecutionProfiles)
    && stableStringify(runContractProfiles) === stableStringify(contractProfiles)
    && stableStringify(runProfiles) === stableStringify(manifestProfiles)
    && stableStringify(runProfiles) === stableStringify(rowProfiles);
  const expectedSplit = run.phase === "main"
    ? dataset.splits.main
    : run.phase === "pilot" ? dataset.splits.pilot : [];
  const registeredContract = run.datasetInventoryHash === H6_FROZEN_INVENTORY_HASH
    && run.suiteVersion === `h6-failure-gate-v1-${H6_FROZEN_INVENTORY_HASH}`
    && registeredProfileBindingsMatch(run)
    && trapAuditsMatch
    && pilotEvidenceMatched
    && pilotContinuityMatched
    && stableStringify(run.seeds) === stableStringify(FROZEN_SEEDS)
    && stableStringify([...run.splitTaskIds].sort(compareCodePoints))
      === stableStringify([...expectedSplit].sort(compareCodePoints))
    && stableStringify(run.arms) === stableStringify(REPEATED_FAILURE_ARMS)
    && decisionRule.analysisPopulation.datasetInventoryHash === run.datasetInventoryHash
    && decisionRule.analysisPopulation.split === "main"
    && decisionRule.trapAudit.minimumTrappedRate === 0.5
    && decisionRule.trapAudit.minimumNonFixedRate === 0.8
    && decisionRule.trapAudit.maximumInvalidRows === 0
    && decisionRule.trapAudit.requireCompleteRows
    && run.statisticsSeed === dataset.seed
    && run.statisticsDraws === decisionRule.analysis.bootstrap.draws
    && run.statisticsDraws === decisionRule.analysis.shuffle.draws;
  const expectedRuntimeProfiles = run.modelProfileIds.map(
    (id, index) => `${id}@${run.modelProfileHashes[index] ?? ""}`,
  ).sort(compareCodePoints);
  const manifestWorkItems = reproManifest.run.selectedWorkItems.map(
    (item) => `${item.benchmark}\u0000${item.runtimeProfile}`,
  ).sort(compareCodePoints);
  const expectedWorkItems = expectedRuntimeProfiles.map(
    (profile) => `h6-repeated-failure\u0000${profile}`,
  ).sort(compareCodePoints);
  const manifestContractMatches = reproManifest.run.id === run.runId
    && reproManifest.run.mode === run.mode
    && reproManifest.run.seed === run.statisticsSeed
    && stableStringify(reproManifest.run.selectedBenchmarks) === stableStringify(["h6-repeated-failure"])
    && stableStringify([...reproManifest.run.runtimeProfiles].sort(compareCodePoints))
      === stableStringify(expectedRuntimeProfiles)
    && stableStringify(manifestWorkItems) === stableStringify(expectedWorkItems)
    && reproManifest.git.commit === run.gitSha
    && reproManifest.git.dirty === run.gitDirty
    && reproManifest.git.dirtyEntryCount === run.gitDirtyEntryCount
    && reproManifest.results.length === 1
    && reproManifest.results.every((result) =>
      result.resultId === run.runId
      && result.benchmark === "h6-repeated-failure"
      && result.mode === run.mode
      && result.gitSha === run.gitSha
      && result.runCount === 1
      && result.taskCount === rows.length
      && stableStringify(result.seeds) === stableStringify(run.seeds)
    );
  const auditBindingsMatch = manifestContractMatches
    && audit.runContract.datasetInventoryHash === run.datasetInventoryHash
    && audit.runContract.decisionRuleHash === run.decisionRuleHash
    && audit.runContract.preregistrationHash === run.preregistrationHash
    && audit.runContract.analysisVersion === run.analysisVersion
    && audit.runContract.preregistrationPath === run.preregistrationPath
    && audit.runContract.harnessVersion === run.harnessVersion
    && audit.runContract.harnessSourceHash === run.harnessSourceHash
    && audit.runContract.provenanceHash === run.provenanceHash
    && audit.dataset.inventoryHash === run.datasetInventoryHash
    && audit.dataset.supportArtifactsMatch
    && stableStringify(audit.runContract.trapAudit) === stableStringify(decisionRule.trapAudit)
    && audit.expectedDesign.expectedRows === design.runOrder.length
    && audit.expectedDesign.terminalRows === rows.length
    && audit.noTrap.expectedRows === expectedNoTrapKeys.size
    && audit.noTrap.observedRows === noTrapRows.length
    && audit.deviations.count === deviationLines.length
    && audit.deviations.none === (deviationLines.length === 0)
    && audit.traces.expectedCount === rows.length
    && audit.traces.durableCount === traceChecks.filter(Boolean).length
    && trapAuditsMatch;
  const claimEligibility = assessClaimEligibility(run, statistics, audit, {
    auditBindingsMatch,
    auditDecisionMatches: audit.decision === statistics.studyDecision,
    deviations: deviationLines.length,
    exactRows,
    factPairsMatched,
    invalidRows: rows.filter((row) => row.status === "INVALID").length,
    isolationMatched,
    modelIdentitiesMatch,
    noTrapPassed,
    registeredContract,
    timingEvidenceMatched,
    tracesDurable,
  });
  const selectedTasks = new Set(run.splitTaskIds);
  if (dataset.tasks.filter((task) => selectedTasks.has(task.id)).length !== selectedTasks.size) {
    throw new Error("paper report run references an unknown frozen task");
  }
  const paperDir = resolveContainedPath(runDir, "paper");
  const tablesDir = resolveContainedPath(paperDir, "tables");
  const figuresDir = resolveContainedPath(paperDir, "figures");
  await Promise.all([
    assertNoSymlinkComponents(runDir, paperDir),
    assertNoSymlinkComponents(runDir, tablesDir),
    assertNoSymlinkComponents(runDir, figuresDir),
  ]);
  const outcomes = aggregateArmOutcomes(rows);
  const generated = new Map<string, string>([
    ["report.md", renderReport({
      run,
      statistics,
      audit,
      dataset,
      outcomes,
      invalidRows: rows.filter((row) => row.status === "INVALID").length,
      claimEligibility,
    })],
    ["claim-eligibility.json", `${JSON.stringify(claimEligibility, null, 2)}\n`],
    ["tables/arm-outcomes.csv", renderArmTable(outcomes)],
    ["tables/effects.csv", renderEffectsTable(statistics)],
    ["tables/task-cuts.csv", renderTaskCutsTable(statistics)],
    ["tables/task-set.csv", renderTaskSetTable(dataset, run.splitTaskIds)],
    ["figures/arm-outcomes.svg", renderArmFigure(outcomes)],
    ["figures/effects.svg", renderEffectsFigure(statistics)],
  ]);
  const manifest = {
    schemaVersion: 1,
    runId: run.runId,
    claimEligibility,
    sourceArtifacts: Object.fromEntries([
      ...SOURCE_ARTIFACTS.map((fileName) => [fileName, sha256(source[fileName])] as const),
      ...boundReceiptHashes.entries(),
    ].sort(([left], [right]) => compareCodePoints(left, right))),
    generatedArtifacts: Object.fromEntries([...generated.entries()].map(([relativePath, content]) => [
      relativePath,
      sha256(content),
    ])),
  };
  const manifestRelativePath = "report-manifest.json";
  const allArtifacts = new Map(generated);
  allArtifacts.set(manifestRelativePath, `${JSON.stringify(manifest, null, 2)}\n`);
  const writeStates = await Promise.all([...allArtifacts.entries()].map(async ([relativePath, content]) => {
    const artifactPath = resolveContainedPath(paperDir, relativePath);
    return {
      artifactPath,
      content,
      shouldWrite: await assertArtifactMayBeWritten(artifactPath, content),
    };
  }));
  await Promise.all([
    mkdir(tablesDir, { recursive: true }),
    mkdir(figuresDir, { recursive: true }),
  ]);
  for (const artifact of writeStates) {
    if (artifact.shouldWrite && await assertArtifactMayBeWritten(artifact.artifactPath, artifact.content)) {
      await writeFileAtomically(artifact.artifactPath, artifact.content);
    }
  }
  await Promise.all(writeStates.map(async (artifact) => {
    const bytes = await readArtifactLeaf(artifact.artifactPath);
    if (!bytes.equals(Buffer.from(artifact.content))) {
      throw new Error(`paper artifact verification failed: ${path.basename(artifact.artifactPath)}`);
    }
  }));
  const artifactPaths = writeStates.map((artifact) => artifact.artifactPath);
  const manifestPath = resolveContainedPath(paperDir, manifestRelativePath);
  return {
    reportPath: resolveContainedPath(paperDir, "report.md"),
    manifestPath,
    artifactPaths,
  };
}

export async function runRepeatedFailurePaperReportCliCommand(
  options: { runDir: string },
): Promise<RepeatedFailureCliCommandResult> {
  try {
    const { replayRepeatedFailureStatistics } = await import("./repeated-failure-suite-runner.js");
    const replay = await replayRepeatedFailureStatistics(options);
    if (replay.exitCode !== 0) return replay;
    const result = await writeRepeatedFailurePaperArtifacts(options);
    return {
      exitCode: 0,
      output: JSON.stringify({
        reportPath: path.relative(path.resolve(options.runDir), result.reportPath),
        manifestPath: path.relative(path.resolve(options.runDir), result.manifestPath),
      }),
    };
  } catch (error) {
    return { exitCode: 1, output: publicError(error) };
  }
}

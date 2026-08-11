import { createHash } from "node:crypto";
import { z } from "zod";
import { compareCodePoints } from "../codepoint-order.js";
import type { H6BenchmarkDataset } from "./repo-gen/index.js";
import { parseEpisodesJsonl } from "./repeated-failure-suite-execution.js";
import {
  REPEATED_FAILURE_ARMS,
  type RepeatedFailureArm,
  type RepeatedFailureRunMetadata,
} from "./repeated-failure-types.js";

export const SHA256 = /^[a-f0-9]{64}$/;

const IntervalSchema = z.object({
  lower: z.number().nullable(),
  upper: z.number().nullable(),
  level: z.number().min(0).max(1),
});
const EffectSchema = z.object({
  taskCount: z.number().int().nonnegative(),
  baselineArm: z.enum(REPEATED_FAILURE_ARMS),
  candidateArm: z.enum(REPEATED_FAILURE_ARMS),
  interpretation: z.enum(["CONFIRMATORY", "EXPLORATORY_COMPLETE_TASKS"]),
  repeatedFailureBenefit: z.number().nullable(),
  repeatedFailureBenefitInterval: IntervalSchema.nullable(),
  relativeRiskReduction: z.number().nullable(),
  relativeRiskReductionInterval: IntervalSchema.nullable(),
  nonEstimableRrrDraws: z.number().int().nonnegative(),
  repeatedFailureP: z.number().nullable(),
  taskPassBenefit: z.number().nullable(),
  taskPassBenefitInterval: IntervalSchema.nullable(),
  taskPassP: z.number().nullable(),
});
export const StatisticsSchema = z.object({
  schemaVersion: z.literal(1),
  seed: z.number().int().nonnegative(),
  draws: z.number().int().positive(),
  level: z.number().min(0).max(1),
  alpha: z.number().min(0).max(1),
  cuts: z.array(z.object({
    hypothesis: z.enum(["TIMING", "CONTENT", "TIMIDITY"]),
    taskId: z.string().min(1),
    reasons: z.array(z.string().min(1)),
  })),
  timing: EffectSchema,
  content: EffectSchema.nullable(),
  contentCompoundP: z.number().nullable(),
  holm: z.array(z.object({
    id: z.enum(["TIMING", "CONTENT"]),
    rawP: z.number(),
    adjustedP: z.number(),
    rank: z.number().int().positive(),
  })),
  decisions: z.object({
    timing: z.enum(["SUPPORTED", "REJECTED", "NOT_ESTIMABLE"]),
    content: z.enum(["SUPPORTED", "REJECTED", "NOT_ESTIMABLE"]).nullable(),
  }),
  studyDecision: z.enum(["PASS", "PARTIAL", "REJECT", "NOT_ESTIMABLE"]),
  timidity: z.object({
    taskCount: z.number().int().nonnegative(),
    intervalLevel: z.number().min(0).max(1),
    passRateDifference: z.number().nullable(),
    passRateInterval: IntervalSchema.nullable(),
    stepsDifference: z.number().nullable(),
    stepsInterval: IntervalSchema.nullable(),
    passMargin: z.number().nonnegative(),
    stepsMargin: z.number().nonnegative(),
    equivalent: z.boolean().nullable(),
  }),
  hypothesisSet: z.literal("timing_only").optional(),
  imputedRows: z.array(z.object({
    taskId: z.string().min(1),
    arm: z.enum(["TURN_START_FAILURE", "PRE_ACTION_FAILURE"]),
    seed: z.number().int().nonnegative(),
    variantId: z.string().min(1),
    invalidReason: z.literal("VAGUE_CHECK"),
  }).strict()).optional(),
});
export const AuditSchema = z.object({
  schemaVersion: z.literal(1),
  runContract: z.object({
    datasetInventoryHash: z.string().regex(SHA256),
    preregistrationPath: z.string().min(1),
    decisionRuleHash: z.string().regex(SHA256),
    preregistrationHash: z.string().regex(SHA256),
    analysisVersion: z.string().min(1),
    harnessVersion: z.string().min(1),
    harnessSourceHash: z.string().regex(SHA256),
    provenanceHash: z.string().regex(SHA256),
    modelProfiles: z.array(z.object({
      id: z.string().min(1),
      hash: z.string().regex(SHA256),
      modelDigest: z.string().regex(SHA256),
      tokenizerIdentity: z.string().min(1),
      tokenizerImplementation: z.literal("nfkc-whitespace-v1"),
    }).strict()).min(1),
    trapAudit: z.object({
      minimumTrappedRate: z.number().min(0).max(1),
      minimumNonFixedRate: z.number().min(0).max(1),
      maximumInvalidRows: z.literal(0),
      requireCompleteRows: z.literal(true),
    }).strict(),
  }).strict(),
  dataset: z.object({
    inventoryHash: z.string().regex(SHA256),
    supportArtifactsMatch: z.boolean(),
    taskCount: z.number().int().nonnegative(),
    variantCount: z.number().int().nonnegative(),
    splitCounts: z.record(z.string(), z.number().int().nonnegative()),
  }).passthrough(),
  expectedDesign: z.object({
    expectedRows: z.number().int().nonnegative(),
    terminalRows: z.number().int().nonnegative(),
    exactRowSet: z.boolean(),
  }),
  factPairs: z.object({ pairCount: z.number().int().nonnegative(), allMatched: z.boolean() }),
  isolation: z.object({
    allUnique: z.boolean(),
    primaryStartHashesMatchWithinCells: z.boolean(),
  }).passthrough(),
  timingEvidence: z.object({ allMatched: z.boolean() }).passthrough(),
  fakeAgentContract: z.object({
    status: z.enum(["PASS", "FAIL", "NOT_APPLICABLE"]),
    deterministicDriverCount: z.number().int().nonnegative(),
  }),
  modelProfiles: z.array(z.object({
    id: z.string().min(1),
    hash: z.string().regex(SHA256),
    modelDigest: z.string().regex(SHA256),
    tokenizerIdentity: z.string().min(1),
    tokenizerImplementation: z.literal("nfkc-whitespace-v1"),
    driverKind: z.enum(["responses", "ollama-chat", "deterministic-fake", "unknown"]),
  }).strict()).min(1),
  noTrap: z.object({
    expectedRows: z.number().int().nonnegative(),
    observedRows: z.number().int().nonnegative(),
    allPassed: z.boolean(),
  }).strict().optional(),
  deviations: z.object({
    count: z.number().int().nonnegative(),
    none: z.boolean(),
  }).strict(),
  traces: z.object({
    expectedCount: z.number().int().nonnegative(),
    durableCount: z.number().int().nonnegative(),
    allDurable: z.boolean(),
  }),
  cuts: z.object({ primary: z.array(z.unknown()), timidity: z.array(z.unknown()) }),
  decision: z.enum(["PASS", "PARTIAL", "REJECT", "NOT_ESTIMABLE"]),
}).passthrough();
const PilotProfileBindingSchema = z.object({
  id: z.string().min(1),
  hash: z.string().regex(SHA256),
  modelDigest: z.string().regex(SHA256),
  driverKind: z.enum(["responses", "ollama-chat", "deterministic-fake", "unknown"]),
  tokenizerIdentity: z.string().min(1),
  tokenizerImplementation: z.literal("nfkc-whitespace-v1"),
}).strict();
const PilotTrapReceiptSchema = z.object({
  path: z.string().min(1),
  artifactHash: z.string().regex(SHA256),
  modelProfileId: z.string().min(1),
  modelProfileHash: z.string().regex(SHA256),
  modelDigest: z.string().regex(SHA256),
  tokenizerIdentity: z.string().min(1),
  tokenizerImplementation: z.literal("nfkc-whitespace-v1"),
}).strict();
const ComputedPilotPowerSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.literal("COMPUTED"),
  phase: z.literal("pilot"),
  method: z.object({ analysisVersion: z.string().min(1) }).passthrough(),
  draws: z.number().int().positive(),
  analysisDraws: z.number().int().positive(),
  source: z.object({
    episodesHash: z.string().regex(SHA256),
    expectedDesignHash: z.string().regex(SHA256),
    decisionRuleHash: z.string().regex(SHA256),
  }).strict(),
  simulations: z.object({
    timing: z.object({ power: z.number().min(0.8).max(1) }).passthrough(),
    content: z.object({ power: z.number().min(0.8).max(1) }).passthrough(),
    timidity: z.object({ power: z.number().min(0.8).max(1) }).passthrough(),
  }).strict(),
}).passthrough();
const PilotRowIdentitySchema = z.object({
  suiteVersion: z.string().min(1),
  taskId: z.string().min(1),
  variantId: z.string().min(1),
  modelProfileId: z.string().min(1),
  modelProfileHash: z.string().regex(SHA256),
  seed: z.number().int().nonnegative().max(0xffffffff),
  arm: z.enum(REPEATED_FAILURE_ARMS),
}).strict();
export const MainPowerEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.literal("VERIFIED_PILOT"),
  phase: z.literal("main"),
  pilotRunId: z.string().min(1),
  pilotManifestArtifactHash: z.string().regex(SHA256),
  pilotPowerArtifactHash: z.string().regex(SHA256),
  pilot: ComputedPilotPowerSchema,
  pilotProfileBindings: z.array(PilotProfileBindingSchema).min(1),
  pilotTrapAuditReceipts: z.array(PilotTrapReceiptSchema).min(1),
  pilotRunOrder: z.array(z.object({
    rowKey: z.string().min(1),
    analysis: z.enum(["PRIMARY", "TIMIDITY"]),
    identity: PilotRowIdentitySchema,
  }).strict()).min(1),
  pilotExpectedDesignHash: z.string().regex(SHA256),
  pilotEpisodesHash: z.string().regex(SHA256),
}).strict();
export const FactPairAuditSchema = z.object({
  schemaVersion: z.literal(1),
  pairs: z.array(z.object({ status: z.enum(["MATCHED", "UNMATCHED"]) }).passthrough()),
}).passthrough();
export const RegisteredFactPairAuditSchema = z.object({
  schemaVersion: z.literal(1),
  minimumJaccard: z.literal(0.8),
  maximumTokenGap: z.literal(8),
  maximumRelativeTokenGap: z.literal(0.05),
  pairs: z.array(z.object({
    pairKey: z.string().regex(SHA256),
    taskId: z.string().min(1),
    variantId: z.string().min(1),
    seed: z.number().int().nonnegative(),
    modelProfileId: z.string().min(1),
    modelProfileHash: z.string().regex(SHA256),
    tokenizerIdentity: z.string().min(1),
    tokenizerImplementation: z.literal("nfkc-whitespace-v1"),
    historyHash: z.string().regex(SHA256),
    failureRepoHash: z.string().regex(SHA256),
    successRepoHash: z.string().regex(SHA256),
    failureActionFingerprint: z.string().min(1),
    successActionFingerprint: z.string().min(1),
    failurePathShapeHash: z.string().regex(SHA256),
    successPathShapeHash: z.string().regex(SHA256),
    failureActionShapeHash: z.string().regex(SHA256),
    successActionShapeHash: z.string().regex(SHA256),
    failureFactId: z.string().min(1),
    failureCitationHash: z.string().regex(SHA256),
    failureFactHash: z.string().regex(SHA256),
    successFactHash: z.string().regex(SHA256),
    failureFactCount: z.literal(1),
    successFactCount: z.literal(1),
    failureTokens: z.number().int().nonnegative(),
    successTokens: z.number().int().nonnegative(),
    tokenGap: z.number().int().nonnegative(),
    relativeTokenGap: z.number().nonnegative(),
    jaccard: z.number().min(0).max(1),
    status: z.enum(["MATCHED", "UNMATCHED"]),
  }).strict()),
}).strict();
export const TraceTimingSchema = z.object({
  armAudit: z.object({
    timingPayload: z.object({
      frame: z.enum(["TURN_START", "PRE_ACTION"]),
      factId: z.string().min(1),
      citationHash: z.string().regex(SHA256),
      factCount: z.literal(1),
      renderedTokenCount: z.number().int().nonnegative(),
    }).strict().nullable(),
    turnStartFactHash: z.string().regex(SHA256).nullable(),
    preActionFailureFactHash: z.string().regex(SHA256).nullable(),
  }).passthrough(),
}).passthrough();

type ParsedStatistics = z.infer<typeof StatisticsSchema>;
type ParsedAudit = z.infer<typeof AuditSchema>;

interface ArmOutcome {
  modelProfileId: string;
  modelProfileHash: string;
  arm: RepeatedFailureArm;
  validRows: number;
  invalidRows: number;
  repeatedFailureRate: number | null;
  taskPassRate: number | null;
  meanSteps: number | null;
  warningRate: number | null;
  falseWarningRate: number | null;
}

interface ClaimEligibility {
  status: "CONFIRMATORY" | "INELIGIBLE";
  reasons: string[];
}

interface ClaimEvidence {
  auditBindingsMatch: boolean;
  auditDecisionMatches: boolean;
  deviations: number;
  exactRows: boolean;
  factPairsMatched: boolean;
  invalidRows: number;
  isolationMatched: boolean;
  modelIdentitiesMatch: boolean;
  noTrapPassed: boolean;
  registeredContract: boolean;
  timingEvidenceMatched: boolean;
  tracesDurable: boolean;
}

type RegisteredProfileBindings = Pick<
  RepeatedFailureRunMetadata,
  | "modelProfileIds"
  | "modelProfileHashes"
  | "modelDigests"
  | "modelDriverKinds"
  | "modelTokenizerIdentities"
  | "modelTokenizerImplementations"
>;

/**
 * A registered run may use one or two model profiles, so hard-coding two
 * would reject a valid single-profile run.
 */
export function registeredProfileBindingsMatch(
  bindings: RegisteredProfileBindings,
  expectedProfileCount: number,
): boolean {
  const profileCount = bindings.modelProfileIds.length;
  return profileCount === expectedProfileCount
    && bindings.modelProfileHashes.length === profileCount
    && bindings.modelDigests.length === profileCount
    && bindings.modelDriverKinds.length === profileCount
    && bindings.modelTokenizerIdentities.length === profileCount
    && bindings.modelTokenizerImplementations.length === profileCount
    && new Set(bindings.modelProfileIds.map(
      (id, index) => `${id}\u0000${bindings.modelProfileHashes[index] ?? ""}`,
    )).size === profileCount
    && new Set(bindings.modelDigests).size === profileCount
    && bindings.modelDigests.every((digest) => SHA256.test(digest))
    && bindings.modelDriverKinds.every((kind) => kind === "ollama-chat")
    && bindings.modelTokenizerIdentities.every((identity) => identity.length > 0)
    && bindings.modelTokenizerImplementations.every(
      (implementation) => implementation === "nfkc-whitespace-v1",
    );
}

export function requiresRegisteredEvidence(
  exactRows: boolean,
  phase: RepeatedFailureRunMetadata["phase"],
  actualProfileCount: number,
  expectedProfileCount: number,
): boolean {
  return exactRows
    && (phase === "pilot" || phase === "main")
    && actualProfileCount === expectedProfileCount;
}

export function assessClaimEligibility(
  run: RepeatedFailureRunMetadata,
  statistics: ParsedStatistics,
  audit: ParsedAudit,
  evidence: ClaimEvidence,
): ClaimEligibility {
  const reasons: string[] = [];
  const timingOnly = statistics.hypothesisSet === "timing_only";
  if (run.phase !== "main") reasons.push("PILOT_RUN");
  if (run.mode !== "full" || !evidence.registeredContract) reasons.push("REGISTERED_CONTRACT_MISMATCH");
  if (
    audit.fakeAgentContract.status !== "NOT_APPLICABLE"
    || audit.fakeAgentContract.deterministicDriverCount !== 0
    || audit.modelProfiles.some((profile) =>
      profile.driverKind === "deterministic-fake" || profile.driverKind === "unknown"
    )
  ) reasons.push("FAKE_DRIVER");
  if (!evidence.modelIdentitiesMatch) reasons.push("MODEL_IDENTITY_MISMATCH");
  if (!evidence.auditBindingsMatch || !evidence.auditDecisionMatches) reasons.push("AUDIT_BINDING_MISMATCH");
  if (!evidence.exactRows || !audit.expectedDesign.exactRowSet) reasons.push("INCOMPLETE_ROW_SET");
  if (evidence.invalidRows > 0) reasons.push("INVALID_ROWS");
  if (
    audit.cuts.primary.length > 0
    || audit.cuts.timidity.length > 0
    || statistics.cuts.length > 0
    || statistics.decisions.timing === "NOT_ESTIMABLE"
    || (!timingOnly && statistics.decisions.content === "NOT_ESTIMABLE")
  ) reasons.push("CUT_ROWS");
  if (evidence.deviations > 0 || !audit.deviations.none) reasons.push("DEVIATIONS_RECORDED");
  if (!evidence.factPairsMatched || !audit.factPairs.allMatched) reasons.push("UNMATCHED_FACT_PAIRS");
  if (!evidence.isolationMatched) reasons.push("ISOLATION_FAILURE");
  if (!evidence.timingEvidenceMatched) reasons.push("TIMING_EVIDENCE_FAILURE");
  if (!timingOnly && !evidence.noTrapPassed) reasons.push("NO_TRAP_FAILURE");
  if (!evidence.tracesDurable) reasons.push("TRACE_DURABILITY_FAILURE");
  if (!timingOnly && statistics.timidity.equivalent !== true) reasons.push("TIMIDITY_NOT_EQUIVALENT");
  return {
    status: reasons.length === 0 ? "CONFIRMATORY" : "INELIGIBLE",
    reasons,
  };
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function formatNumber(value: number | null, digits = 6): string {
  return value === null ? "NA" : value.toFixed(digits);
}

function formatPercent(value: number | null): string {
  return value === null ? "NA" : `${(value * 100).toFixed(1)}%`;
}

function requireNonnegativeInteger(
  value: number | undefined,
  field: "steps" | "warningCount" | "falseWarningCount",
  rowKey: string,
): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`valid episode ${rowKey} has invalid ${field}`);
  }
  return value;
}

function csvCell(value: string | number): string {
  const serialized = String(value);
  return /[",\n\r]/.test(serialized) ? `"${serialized.replaceAll('"', '""')}"` : serialized;
}

function csvRow(values: readonly (string | number)[]): string {
  return `${values.map(csvCell).join(",")}\n`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function aggregateArmOutcomes(rows: ReturnType<typeof parseEpisodesJsonl>): ArmOutcome[] {
  const groups = new Map<string, ReturnType<typeof parseEpisodesJsonl>>();
  for (const row of rows) {
    const key = JSON.stringify([
      row.identity.modelProfileId,
      row.identity.modelProfileHash,
      row.identity.arm,
    ]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const armOrder = new Map(REPEATED_FAILURE_ARMS.map((arm, index) => [arm, index]));
  return [...groups.values()].map((group) => {
    const first = group[0];
    if (!first) throw new Error("arm outcome group cannot be empty");
    const valid = group.filter((row) => row.status === "VALID");
    const mean = (values: readonly number[]): number | null =>
      values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
    return {
      modelProfileId: first.identity.modelProfileId,
      modelProfileHash: first.identity.modelProfileHash,
      arm: first.identity.arm,
      validRows: valid.length,
      invalidRows: group.length - valid.length,
      repeatedFailureRate: mean(valid.map((row) => row.repeatedFailure ? 1 : 0)),
      taskPassRate: mean(valid.map((row) => row.taskPassed ? 1 : 0)),
      meanSteps: mean(valid.map((row) =>
        requireNonnegativeInteger(row.steps, "steps", row.rowKey)
      )),
      warningRate: mean(valid.map((row) =>
        requireNonnegativeInteger(row.warningCount, "warningCount", row.rowKey) > 0 ? 1 : 0
      )),
      falseWarningRate: mean(valid.map((row) =>
        requireNonnegativeInteger(row.falseWarningCount, "falseWarningCount", row.rowKey) > 0 ? 1 : 0
      )),
    };
  }).sort((left, right) =>
    compareCodePoints(left.modelProfileId, right.modelProfileId)
    || compareCodePoints(left.modelProfileHash, right.modelProfileHash)
    || (armOrder.get(left.arm) ?? 0) - (armOrder.get(right.arm) ?? 0)
  );
}

export function renderArmTable(outcomes: readonly ArmOutcome[]): string {
  let csv = csvRow([
    "modelProfileId",
    "modelProfileHash",
    "arm",
    "validRows",
    "invalidRows",
    "repeatedFailureRate",
    "taskPassRate",
    "meanSteps",
    "warningRate",
    "falseWarningRate",
  ]);
  for (const outcome of outcomes) {
    csv += csvRow([
      outcome.modelProfileId,
      outcome.modelProfileHash,
      outcome.arm,
      outcome.validRows,
      outcome.invalidRows,
      formatNumber(outcome.repeatedFailureRate),
      formatNumber(outcome.taskPassRate),
      formatNumber(outcome.meanSteps),
      formatNumber(outcome.warningRate),
      formatNumber(outcome.falseWarningRate),
    ]);
  }
  return csv;
}

export function renderEffectsTable(statistics: ParsedStatistics): string {
  let csv = csvRow([
    "hypothesis",
    "baselineArm",
    "candidateArm",
    "taskCount",
    "interpretation",
    "repeatedFailureBenefit",
    "repeatedFailureCiLower",
    "repeatedFailureCiUpper",
    "relativeRiskReduction",
    "relativeRiskReductionCiLower",
    "relativeRiskReductionCiUpper",
    "repeatedFailureP",
    "taskPassBenefit",
    "taskPassCiLower",
    "taskPassCiUpper",
    "taskPassP",
    "holmAdjustedP",
    "decision",
  ]);
  const effects = statistics.content === null
    ? [["TIMING", statistics.timing] as const]
    : [["TIMING", statistics.timing] as const, ["CONTENT", statistics.content] as const];
  for (const [hypothesis, effect] of effects) {
    const adjustedP = statistics.holm.find((entry) => entry.id === hypothesis)?.adjustedP ?? null;
    csv += csvRow([
      hypothesis,
      effect.baselineArm,
      effect.candidateArm,
      effect.taskCount,
      effect.interpretation,
      formatNumber(effect.repeatedFailureBenefit),
      formatNumber(effect.repeatedFailureBenefitInterval?.lower ?? null),
      formatNumber(effect.repeatedFailureBenefitInterval?.upper ?? null),
      formatNumber(effect.relativeRiskReduction),
      formatNumber(effect.relativeRiskReductionInterval?.lower ?? null),
      formatNumber(effect.relativeRiskReductionInterval?.upper ?? null),
      formatNumber(effect.repeatedFailureP),
      formatNumber(effect.taskPassBenefit),
      formatNumber(effect.taskPassBenefitInterval?.lower ?? null),
      formatNumber(effect.taskPassBenefitInterval?.upper ?? null),
      formatNumber(effect.taskPassP),
      formatNumber(adjustedP),
      statistics.decisions[hypothesis === "TIMING" ? "timing" : "content"] ?? "NOT_ESTIMABLE",
    ]);
  }
  return csv;
}

export function renderTaskCutsTable(statistics: ParsedStatistics): string {
  let csv = csvRow(["hypothesis", "taskId", "reasons"]);
  for (const cut of statistics.cuts) {
    csv += csvRow([cut.hypothesis, cut.taskId, cut.reasons.join("; ")]);
  }
  return csv;
}

export function renderTaskSetTable(dataset: H6BenchmarkDataset, taskIds: readonly string[]): string {
  const selected = new Set(taskIds);
  let csv = csvRow(["taskId", "split", "trapId", "trapName", "domain", "variantCount"]);
  const taxonomy = new Map(dataset.taxonomy.map((entry) => [entry.trapId, entry.name]));
  for (const task of dataset.tasks.filter((entry) => selected.has(entry.id)).sort(
    (left, right) => compareCodePoints(left.id, right.id),
  )) {
    csv += csvRow([
      task.id,
      task.split,
      task.trapId,
      taxonomy.get(task.trapId) ?? task.trapId,
      task.domain,
      task.variants.length,
    ]);
  }
  return csv;
}

export function renderArmFigure(outcomes: readonly ArmOutcome[]): string {
  const width = 1100;
  const top = 72;
  const rowHeight = 34;
  const height = Math.max(180, top + outcomes.length * rowHeight + 48);
  const labelX = 16;
  const plotX = 470;
  const plotWidth = 560;
  const rateWidth = plotWidth / 2 - 36;
  const elements = outcomes.map((outcome, index) => {
    const y = top + index * rowHeight;
    const failureWidth = Math.max(0, outcome.repeatedFailureRate ?? 0) * rateWidth;
    const passWidth = Math.max(0, outcome.taskPassRate ?? 0) * rateWidth;
    const label = `${outcome.modelProfileId} | ${outcome.arm}`;
    return [
      `<text x="${labelX}" y="${y + 16}" class="label">${escapeXml(label)}</text>`,
      `<rect x="${plotX}" y="${y}" width="${rateWidth}" height="20" class="track"/>`,
      `<rect x="${plotX}" y="${y}" width="${failureWidth.toFixed(2)}" height="20" class="failure"/>`,
      `<text x="${plotX + rateWidth + 6}" y="${y + 16}" class="value">${escapeXml(formatPercent(outcome.repeatedFailureRate))}</text>`,
      `<rect x="${plotX + rateWidth + 86}" y="${y}" width="${rateWidth}" height="20" class="track"/>`,
      `<rect x="${plotX + rateWidth + 86}" y="${y}" width="${passWidth.toFixed(2)}" height="20" class="pass"/>`,
      `<text x="${plotX + plotWidth + 56}" y="${y + 16}" class="value">${escapeXml(formatPercent(outcome.taskPassRate))}</text>`,
    ].join("");
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<style>.title{font:700 20px system-ui,sans-serif;fill:#17202a}.head{font:600 13px system-ui,sans-serif;fill:#34495e}.label,.value{font:12px ui-monospace,monospace;fill:#17202a}.track{fill:#ecf0f1}.failure{fill:#c0392b}.pass{fill:#1e8449}</style>
<rect width="100%" height="100%" fill="#fff"/>
<text x="16" y="30" class="title">H6 arm outcomes</text>
<text x="${plotX}" y="55" class="head">Repeated-failure rate</text>
<text x="${plotX + rateWidth + 86}" y="55" class="head">Task-pass rate</text>
${elements}
</svg>\n`;
}

export function renderEffectsFigure(statistics: ParsedStatistics): string {
  const metrics = statistics.content === null
    ? [
        ["Timing: repeated-failure benefit", statistics.timing.repeatedFailureBenefit, statistics.timing.repeatedFailureBenefitInterval],
        ["Timing: relative risk reduction", statistics.timing.relativeRiskReduction, statistics.timing.relativeRiskReductionInterval],
      ] as const
    : [
        ["Timing: repeated-failure benefit", statistics.timing.repeatedFailureBenefit, statistics.timing.repeatedFailureBenefitInterval],
        ["Timing: relative risk reduction", statistics.timing.relativeRiskReduction, statistics.timing.relativeRiskReductionInterval],
        ["Content: repeated-failure benefit", statistics.content.repeatedFailureBenefit, statistics.content.repeatedFailureBenefitInterval],
        ["Content: task-pass benefit", statistics.content.taskPassBenefit, statistics.content.taskPassBenefitInterval],
      ] as const;
  const width = 1000;
  const height = 300;
  const plotX = 410;
  const plotWidth = 520;
  const scale = (value: number): number => plotX + ((Math.max(-1, Math.min(1, value)) + 1) / 2) * plotWidth;
  const elements = metrics.map(([label, estimate, interval], index) => {
    const y = 82 + index * 48;
    if (estimate === null || interval === null || interval.lower === null || interval.upper === null) {
      return `<text x="16" y="${y + 5}" class="label">${escapeXml(label)}: not estimable</text>`;
    }
    const lower = scale(interval.lower);
    const upper = scale(interval.upper);
    const point = scale(estimate);
    return [
      `<text x="16" y="${y + 5}" class="label">${escapeXml(label)}</text>`,
      `<line x1="${lower.toFixed(2)}" y1="${y}" x2="${upper.toFixed(2)}" y2="${y}" class="interval"/>`,
      `<circle cx="${point.toFixed(2)}" cy="${y}" r="6" class="point"/>`,
      `<text x="945" y="${y + 5}" class="value">${escapeXml(formatNumber(estimate, 3))}</text>`,
    ].join("");
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<style>.title{font:700 20px system-ui,sans-serif;fill:#17202a}.axis{stroke:#95a5a6;stroke-width:1}.zero{stroke:#17202a;stroke-width:1}.interval{stroke:#2471a3;stroke-width:4}.point{fill:#154360}.label,.value{font:13px ui-monospace,monospace;fill:#17202a}</style>
<rect width="100%" height="100%" fill="#fff"/>
<text x="16" y="30" class="title">H6 task-group effects with 95% intervals</text>
<line x1="${plotX}" y1="50" x2="${plotX + plotWidth}" y2="50" class="axis"/>
<line x1="${scale(0)}" y1="50" x2="${scale(0)}" y2="270" class="zero"/>
<text x="${plotX - 8}" y="46" class="value">-1</text><text x="${scale(0) - 4}" y="46" class="value">0</text><text x="${plotX + plotWidth - 8}" y="46" class="value">1</text>
${elements}
</svg>\n`;
}

function renderIntegrity(value: boolean): string {
  return value ? "PASS" : "FAIL";
}

export function renderReport(input: {
  run: RepeatedFailureRunMetadata;
  statistics: ParsedStatistics;
  audit: ParsedAudit;
  dataset: H6BenchmarkDataset;
  outcomes: readonly ArmOutcome[];
  invalidRows: number;
  claimEligibility: ClaimEligibility;
}): string {
  const selectedTasks = input.dataset.tasks.filter((task) => input.run.splitTaskIds.includes(task.id));
  const taskList = selectedTasks.map((task) => task.id).sort(compareCodePoints).join(", ");
  const trapCounts = new Map<string, number>();
  for (const task of selectedTasks) trapCounts.set(task.trapId, (trapCounts.get(task.trapId) ?? 0) + 1);
  const trapSet = [...trapCounts.entries()].sort(([left], [right]) => compareCodePoints(left, right))
    .map(([trapId, count]) => `${trapId} (${count})`).join(", ");
  const timingOnly = input.statistics.hypothesisSet === "timing_only";
  const content = input.statistics.content;
  const adjustedTiming = input.statistics.holm.find((entry) => entry.id === "TIMING")?.adjustedP ?? null;
  const adjustedContent = input.statistics.holm.find((entry) => entry.id === "CONTENT")?.adjustedP ?? null;
  const rows = input.outcomes.reduce((sum, outcome) => sum + outcome.validRows + outcome.invalidRows, 0);
  const analysisDescription = timingOnly
    ? "All task means, intervals, and tests use task groups as the statistical unit. This timing-only registration compares pre-action failure memory with turn-start failure memory. Grouped bootstrap intervals, paired randomization tests, and Holm adjustment follow the frozen decision rule."
    : "All task means, intervals, and tests use task groups as the statistical unit. The timing contrast compares pre-action failure memory with turn-start failure memory. The content contrast compares turn-start failure memory with turn-start success memory. Grouped bootstrap intervals, paired randomization tests, and Holm adjustment follow the frozen decision rule.";
  const analysisRows = timingOnly
    ? `| Claim | Estimate | 95% interval | Raw p | Holm-adjusted p | Decision |
|---|---:|---:|---:|---:|---|
| Timing repeated-failure benefit | ${formatNumber(input.statistics.timing.repeatedFailureBenefit, 3)} | ${formatNumber(input.statistics.timing.repeatedFailureBenefitInterval?.lower ?? null, 3)} to ${formatNumber(input.statistics.timing.repeatedFailureBenefitInterval?.upper ?? null, 3)} | ${formatNumber(input.statistics.timing.repeatedFailureP, 4)} | ${formatNumber(adjustedTiming, 4)} | ${input.statistics.decisions.timing} |

Content analysis: not part of this registration.`
    : `| Claim | Estimate | 95% interval | Raw p | Holm-adjusted p | Decision |
|---|---:|---:|---:|---:|---|
| Timing repeated-failure benefit | ${formatNumber(input.statistics.timing.repeatedFailureBenefit, 3)} | ${formatNumber(input.statistics.timing.repeatedFailureBenefitInterval?.lower ?? null, 3)} to ${formatNumber(input.statistics.timing.repeatedFailureBenefitInterval?.upper ?? null, 3)} | ${formatNumber(input.statistics.timing.repeatedFailureP, 4)} | ${formatNumber(adjustedTiming, 4)} | ${input.statistics.decisions.timing} |
| Content repeated-failure benefit | ${formatNumber(content?.repeatedFailureBenefit ?? null, 3)} | ${formatNumber(content?.repeatedFailureBenefitInterval?.lower ?? null, 3)} to ${formatNumber(content?.repeatedFailureBenefitInterval?.upper ?? null, 3)} | ${formatNumber(input.statistics.contentCompoundP, 4)} | ${formatNumber(adjustedContent, 4)} | ${input.statistics.decisions.content} |
| Content task-pass benefit | ${formatNumber(content?.taskPassBenefit ?? null, 3)} | ${formatNumber(content?.taskPassBenefitInterval?.lower ?? null, 3)} to ${formatNumber(content?.taskPassBenefitInterval?.upper ?? null, 3)} | ${formatNumber(content?.taskPassP ?? null, 4)} | ${formatNumber(adjustedContent, 4)} | ${input.statistics.decisions.content}`;
  const timidityDescription = timingOnly
    ? "Timidity analysis: not part of this registration."
    : `Timidity equivalence: ${input.statistics.timidity.equivalent === null ? "NOT_ESTIMABLE" : input.statistics.timidity.equivalent ? "PASS" : "FAIL"}. The 90% pass-rate interval is ${formatNumber(input.statistics.timidity.passRateInterval?.lower ?? null, 3)} to ${formatNumber(input.statistics.timidity.passRateInterval?.upper ?? null, 3)} against a margin of ${formatNumber(input.statistics.timidity.passMargin, 3)}. The 90% step interval is ${formatNumber(input.statistics.timidity.stepsInterval?.lower ?? null, 3)} to ${formatNumber(input.statistics.timidity.stepsInterval?.upper ?? null, 3)} against a margin of ${formatNumber(input.statistics.timidity.stepsMargin, 3)}.`;
  return `# H6 failure-gate experiment report

This report was generated from the frozen run artifacts. The CSV tables and SVG figures contain the paper data. The report manifest binds every source and generated file by SHA-256 hash.

${input.claimEligibility.status === "CONFIRMATORY"
  ? "The run satisfies the preregistered main-study integrity contract. Its study decision is confirmatory."
  : `The raw study decision is not a confirmatory result. This run is ineligible for preregistered claims: ${input.claimEligibility.reasons.join(", ")}.`}

## Study identity

| Field | Value |
|---|---|
| Run | ${input.run.runId} |
| Phase | ${input.run.phase} |
| Suite | ${input.run.suiteVersion} |
| Dataset inventory | ${input.run.datasetInventoryHash} |
| Model profiles | ${input.run.modelProfileIds.join(", ")} |
| Profile hashes | ${input.run.modelProfileHashes.join(", ")} |
| Model digests | ${input.run.modelDigests.join(", ")} |
| Statistics seed | ${input.run.statisticsSeed} |
| Bootstrap and shuffle draws | ${input.run.statisticsDraws} |
| Raw study decision | ${input.statistics.studyDecision} |
| Confirmatory claim status | ${input.claimEligibility.status} |
| Ineligibility reasons | ${input.claimEligibility.reasons.join(", ") || "NONE"} |

## Task and trap set

Tasks: ${taskList}

Trap groups: ${trapSet}

The machine-readable task set is [tables/task-set.csv](tables/task-set.csv). It records each task, split, trap group, domain, and variant count.

## Analysis

${analysisDescription}

${analysisRows}

${timidityDescription}

- [Arm outcomes](tables/arm-outcomes.csv)
- [Effect estimates](tables/effects.csv)
- [Task cuts](tables/task-cuts.csv)
- [Arm outcome figure](figures/arm-outcomes.svg)
- [Effect figure](figures/effects.svg)

## Integrity and exclusions

| Check | Result |
|---|---|
| Expected terminal row set | ${renderIntegrity(input.audit.expectedDesign.exactRowSet)} |
| Fact pairs matched | ${renderIntegrity(input.audit.factPairs.allMatched)} |
| Timing evidence matched | ${renderIntegrity(input.audit.timingEvidence.allMatched)} |
| Isolation identities unique | ${renderIntegrity(input.audit.isolation.allUnique)} |
| Start repositories matched within paired cells | ${renderIntegrity(input.audit.isolation.primaryStartHashesMatchWithinCells)} |
| Trace artifacts durable | ${renderIntegrity(input.audit.traces.allDurable)} |
| Primary task cuts | ${input.statistics.cuts.filter((cut) => cut.hypothesis !== "TIMIDITY").length} |
| Timidity task cuts | ${timingOnly ? "not part of this registration" : input.statistics.cuts.filter((cut) => cut.hypothesis === "TIMIDITY").length} |
| Invalid rows | ${input.invalidRows} of ${rows} |

The preregistered cut log is [tables/task-cuts.csv](tables/task-cuts.csv). Cut tasks remain in the record and never enter confirmatory estimates.

## Scope

The result applies to the frozen local synthetic TypeScript tasks, profiles, prompts, caps, seeds, and decision rule identified above. It does not estimate cross-language, cross-project, learned-gate, hard-block, or production-host effects.
`;
}


import { createHash } from "node:crypto";
import { H6_FROZEN_INVENTORY_HASH, H6_TRAP_IDS } from "./types.js";

const draft = "http://json-schema.org/draft-07/schema#";
const nonEmptyString = { type: "string", minLength: 1 } as const;
const sha = { type: "string", pattern: "^[0-9a-f]{40}$" } as const;

export const H6_SUPPORT_ARTIFACT_PATHS = [
  "trap-taxonomy.json",
  "arms/arms.json",
  "schema/action-intent.schema.json",
  "schema/dataset.schema.json",
  "schema/task.schema.json",
  "schema/trap-fingerprint.schema.json",
] as const;

const supportArtifactHashProperties = Object.fromEntries(
  H6_SUPPORT_ARTIFACT_PATHS.map((path) => [
    path,
    { type: "string", pattern: "^[0-9a-f]{64}$" },
  ]),
);

export const H6_ACTION_INTENT_JSON_SCHEMA = {
  $schema: draft,
  $id: "action-intent.schema.json",
  title: "H6ActionIntentV1",
  type: "object",
  additionalProperties: false,
  required: ["version", "actionType", "targetSymbol", "filePath", "contextHash"],
  properties: {
    version: { type: "integer", const: 1 },
    actionType: nonEmptyString,
    targetSymbol: nonEmptyString,
    filePath: nonEmptyString,
    contextHash: nonEmptyString,
  },
} as const;

export const H6_TRAP_FINGERPRINT_JSON_SCHEMA = {
  $schema: draft,
  $id: "trap-fingerprint.schema.json",
  title: "H6TrapFingerprintV1",
  type: "object",
  additionalProperties: false,
  required: ["version", "trapId", "symbol", "file", "pattern", "strategyId"],
  properties: {
    version: { type: "integer", const: 1 },
    trapId: { type: "string", enum: H6_TRAP_IDS },
    symbol: nonEmptyString,
    file: nonEmptyString,
    pattern: nonEmptyString,
    strategyId: nonEmptyString,
  },
} as const;

const syntheticFile = {
  type: "object",
  additionalProperties: false,
  required: ["path", "content"],
  properties: {
    path: nonEmptyString,
    content: { type: "string" },
    isExecutable: { type: "boolean" },
  },
} as const;

const strategyPatch = {
  type: "object",
  additionalProperties: false,
  required: ["id", "description", "files"],
  properties: {
    id: nonEmptyString,
    description: { type: "string" },
    files: { type: "array", items: { $ref: "#/definitions/syntheticFile" } },
  },
} as const;

const taskVariant = {
  type: "object",
  additionalProperties: false,
  required: [
    "variantId",
    "baseTaskId",
    "variantIndex",
    "distance",
    "domain",
    "files",
    "strategyCandidates",
    "badStrategyPatch",
    "goodStrategyPatch",
    "noTrapControlFiles",
    "cleanRevisionSha",
    "trapRevisionSha",
    "rightRevisionSha",
    "noTrapRevisionSha",
  ],
  properties: {
    variantId: nonEmptyString,
    baseTaskId: nonEmptyString,
    variantIndex: { type: "integer", minimum: 1, maximum: 3 },
    distance: { type: "integer", minimum: 1, maximum: 3 },
    domain: nonEmptyString,
    files: { type: "array", items: { $ref: "#/definitions/syntheticFile" } },
    strategyCandidates: {
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: { $ref: "#/definitions/strategyPatch" },
    },
    badStrategyPatch: { $ref: "#/definitions/strategyPatch" },
    goodStrategyPatch: { $ref: "#/definitions/strategyPatch" },
    noTrapControlFiles: {
      type: "array",
      items: { $ref: "#/definitions/syntheticFile" },
    },
    cleanRevisionSha: sha,
    trapRevisionSha: sha,
    rightRevisionSha: sha,
    noTrapRevisionSha: sha,
  },
} as const;

export const H6_TASK_JSON_SCHEMA = {
  $schema: draft,
  $id: "task.schema.json",
  title: "H6BaseTask",
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "trapId",
    "domain",
    "title",
    "description",
    "canonicalBaseFiles",
    "checkCommand",
    "fileCount",
    "lineCount",
    "fingerprint",
    "normalizedActionIntent",
    "offlineCheckMark",
    "offlineFailureMark",
    "maxTokenCap",
    "maxAttemptCap",
    "split",
    "variants",
  ],
  properties: {
    id: nonEmptyString,
    trapId: { type: "string", enum: H6_TRAP_IDS },
    domain: nonEmptyString,
    title: nonEmptyString,
    description: { type: "string" },
    canonicalBaseFiles: {
      type: "array",
      minItems: 1,
      items: { $ref: "#/definitions/syntheticFile" },
    },
    checkCommand: { type: "string", const: "node test/check.js" },
    fileCount: { type: "integer", minimum: 8, maximum: 15 },
    lineCount: { type: "integer", minimum: 300, maximum: 600 },
    fingerprint: { $ref: "./trap-fingerprint.schema.json" },
    normalizedActionIntent: { $ref: "./action-intent.schema.json" },
    offlineCheckMark: nonEmptyString,
    offlineFailureMark: nonEmptyString,
    maxTokenCap: { type: "integer", minimum: 1 },
    maxAttemptCap: { type: "integer", minimum: 1 },
    split: { type: "string", enum: ["dev", "pilot", "main"] },
    variants: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: { $ref: "#/definitions/taskVariant" },
    },
  },
  definitions: { syntheticFile, strategyPatch, taskVariant },
} as const;

export const H6_DATASET_JSON_SCHEMA = {
  $schema: draft,
  $id: "dataset.schema.json",
  title: "H6BenchmarkDataset",
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "seed",
    "createdAt",
    "inventoryHash",
    "supportArtifactHashes",
    "taxonomy",
    "tasks",
    "splits",
  ],
  properties: {
    version: { type: "integer", const: 1 },
    seed: { type: "integer" },
    createdAt: { type: "string", format: "date-time" },
    inventoryHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    supportArtifactHashes: {
      type: "object",
      additionalProperties: false,
      required: H6_SUPPORT_ARTIFACT_PATHS,
      properties: supportArtifactHashProperties,
    },
    taxonomy: {
      type: "array",
      minItems: 6,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "trapId",
          "name",
          "description",
          "trapMechanism",
          "correctFix",
          "inspiredBy",
        ],
        properties: {
          trapId: { type: "string", enum: H6_TRAP_IDS },
          name: nonEmptyString,
          description: { type: "string" },
          trapMechanism: nonEmptyString,
          correctFix: nonEmptyString,
          inspiredBy: nonEmptyString,
        },
      },
    },
    tasks: {
      type: "array",
      minItems: 30,
      maxItems: 30,
      items: { $ref: "./task.schema.json" },
    },
    splits: {
      type: "object",
      required: ["dev", "pilot", "main"],
      properties: {
        dev: { type: "array", minItems: 0, maxItems: 0, items: nonEmptyString },
        pilot: { type: "array", minItems: 12, maxItems: 12, items: nonEmptyString },
        main: { type: "array", minItems: 18, maxItems: 18, items: nonEmptyString },
      },
    },
  },
} as const;

export const H6_DECISION_RULE = {
  version: 11,
  name: "H6 Failure Gate Decision Rule",
  preregistration: {
    path: "docs/research/failure-gate/preregistration.md",
    sha256: "a62578027cb4c97e7da812e61c7ee3639839fba2b383caa017fa53e3591814fe",
  },
  analysisPopulation: {
    datasetVersion: 1,
    datasetInventoryHash: H6_FROZEN_INVENTORY_HASH,
    split: "main",
    taskCount: 18,
    seedsPerModelProfile: 5,
    modelProfileCount: 1,
    unit: "task",
    pairingKey: [
      "taskId",
      "variantId",
      "seed",
      "modelProfileId",
      "modelProfileHash",
    ],
    maximumPrimaryTaskCuts: 0,
  },
  analysis: {
    bootstrap: {
      draws: 10_000,
      group: "task",
      confidenceLevel: 0.95,
      method: "percentile",
    },
    shuffle: {
      draws: 10_000,
      group: "task",
      alternative: "candidate_benefit",
      plusOneCorrection: true,
    },
    alpha: 0.05,
    multiplicity: {
      method: "HOLM",
      family: [
        "H6_TIMING_REPEATED_FAILURE",
        "H6_CONTENT_COMPOUND",
      ],
      contentCompoundP: "max(repeatedFailureP,taskPassP)",
    },
  },
  factMatching: {
    timing: {
      factCount: 1,
      requireSameFactIds: true,
      requireSameCitationHashes: true,
      requireSameRenderedTokenCount: true,
    },
    content: {
      factCount: 1,
      requireSamePathShape: true,
      requireSameActionShape: true,
      textSimilarity: {
        metric: "normalized_token_set_jaccard",
        minimumInclusive: 0.8,
        maximumInclusive: 1,
      },
      tokenCountGap: {
        maximumAbsolute: 8,
        maximumRelative: 0.05,
        requireBoth: true,
      },
    },
  },
  hypotheses: {
    "H6-timing": {
      baselineArm: "TURN_START_FAILURE",
      candidateArm: "PRE_ACTION_FAILURE",
      metric: "repeatedFailure",
      minimumRelativeRiskReduction: 0.3,
      minimumAbsoluteRepeatedFailureBenefit: 0.05,
      requireRepeatedFailureBenefitIntervalLowerStrictlyAbove: 0,
      requireHolmAdjustedPStrictlyBelow: 0.05,
      zeroBaselineDecision: "NOT_ESTIMABLE",
    },
    "H6-content": {
      baselineArm: "TURN_START_SUCCESS",
      candidateArm: "TURN_START_FAILURE",
      metrics: [
        "repeatedFailure",
        "taskPassed",
      ],
      requireRepeatedFailureBenefitIntervalLowerStrictlyAbove: 0,
      requireTaskPassBenefitIntervalLowerStrictlyAbove: 0,
      requireHolmAdjustedCompoundPStrictlyBelow: 0.05,
      unmatchedPairDecision: "NOT_ESTIMABLE",
    },
  },
  power: {
    simulationDraws: 10_000,
    minimumTimingPower: 0.8,
    minimumContentPower: 0.8,
    sourceSplit: "pilot",
    increaseIndependentTasksIfBelowThreshold: true,
  },
  trapAudit: {
    minimumTrappedRate: 0.3,
    minimumNonFixedRate: 0.5,
    maximumInvalidRows: 0,
    requireCompleteRows: true,
  },
  timidity: {
    baselineArm: "NO_MEMORY",
    candidateArm: "PRE_ACTION_FAILURE",
    population: "main_no_trap_revisions",
    confidenceLevel: 0.9,
    passRateMargin: 0.02,
    stepsMargin: 2,
    requireIntervalsStrictlyInsideMargins: true,
    minimumSimulatedPower: 0.8,
  },
  completeness: {
    expectedRowsFormula:
      "taskCount*variantsPerTask*seedsPerModelProfile*modelProfileCount*armCount",
    primaryArmCount: 5,
    hostFaultRetriesAfterFirstTry: 5,
    rerunTaskResults: false,
    invalidReasons: [
      "CORPUS_INVALID",
      "CORE_REPO_DIR_MISMATCH",
      "START_DRIFT",
      "TRACE_GAP",
      "VAGUE_CHECK",
      "MIXED_ARM_STATE",
      "UNMATCHED_FACTS",
      "WAIT_RULE_FAULT",
      "HOST_RETRIES_EXHAUSTED",
    ],
  },
  outcomes: {
    PASS: "timing=SUPPORTED and content=SUPPORTED",
    PARTIAL:
      "exactly one primary is SUPPORTED and the other is REJECTED",
    REJECT: "timing=REJECTED and content=REJECTED",
    NOT_ESTIMABLE: "either primary is NOT_ESTIMABLE",
  },
  gateStatuses: [
    "NO_MATCH",
    "MATCH_WARN",
    "ERROR_FAIL_OPEN",
  ],
} as const;

export const H6_ARMS = [
  {
    id: "NO_MEMORY",
    name: "No Memory Baseline",
    description: "Floor baseline with no memory recall or gate warning active.",
  },
  {
    id: "TURN_START_FAILURE",
    name: "Turn-Start Failure Memory Recall",
    description: "Failure trajectory recalled at turn start.",
  },
  {
    id: "TURN_START_SUCCESS",
    name: "Turn-Start Success Memory Recall",
    description: "Matched success memories recalled at turn start.",
  },
  {
    id: "PRE_ACTION_FAILURE",
    name: "Pre-Action Failure Gate",
    description:
      "Pre-action gate injects advisory warning prior to matched action execution.",
  },
  {
    id: "BOTH",
    name: "Pre-Action Gate + Turn-Start Recall",
    description: "Both pre-action gate advisory and turn-start recall active.",
  },
] as const;

export function serializeH6FixtureJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hashFixtureJson(value: unknown): string {
  return createHash("sha256")
    .update(serializeH6FixtureJson(value))
    .digest("hex");
}

export function computeH6SupportArtifactHashes(taxonomy: unknown): {
  [K in (typeof H6_SUPPORT_ARTIFACT_PATHS)[number]]: string;
} {
  return {
    "trap-taxonomy.json": hashFixtureJson(taxonomy),
    "arms/arms.json": hashFixtureJson(H6_ARMS),
    "schema/action-intent.schema.json": hashFixtureJson(
      H6_ACTION_INTENT_JSON_SCHEMA,
    ),
    "schema/dataset.schema.json": hashFixtureJson(H6_DATASET_JSON_SCHEMA),
    "schema/task.schema.json": hashFixtureJson(H6_TASK_JSON_SCHEMA),
    "schema/trap-fingerprint.schema.json": hashFixtureJson(
      H6_TRAP_FINGERPRINT_JSON_SCHEMA,
    ),
  };
}

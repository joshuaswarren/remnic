import type { BenchmarkMode, BenchmarkResult } from "../types.js";
import type {
  ControlledResponsesCaps,
  ControlledResponsesEpisodeResult,
  RepeatedFailureActionEvaluator,
  RepeatedFailureLocalToolHost,
} from "./repeated-failure-responses-driver.js";

export const REPEATED_FAILURE_ARMS = Object.freeze([
  "NO_MEMORY",
  "TURN_START_FAILURE",
  "TURN_START_SUCCESS",
  "PRE_ACTION_FAILURE",
  "BOTH",
] as const);

export type RepeatedFailureArm = (typeof REPEATED_FAILURE_ARMS)[number];

export interface RepeatedFailureRowIdentity {
  suiteVersion: string;
  taskId: string;
  variantId: string;
  modelProfileId: string;
  modelProfileHash: string;
  seed: number;
  arm: RepeatedFailureArm;
}

export const REPEATED_FAILURE_INVALID_REASONS = Object.freeze([
  "START_DRIFT",
  "TRACE_GAP",
  "VAGUE_CHECK",
  "MIXED_ARM_STATE",
  "UNMATCHED_FACTS",
  "WAIT_RULE_FAULT",
  "HOST_RETRIES_EXHAUSTED",
] as const);

export type RepeatedFailureInvalidReason = (typeof REPEATED_FAILURE_INVALID_REASONS)[number];

export interface RepeatedFailureTokenUsage {
  input: number;
  output: number;
  total: number;
  cachedInput: number;
  cacheWriteInput: number;
  reasoningOutput: number;
}

export type RepeatedFailureFinalState = "UNFIXED" | "TRAPPED" | "FIXED" | "NO_TRAP" | "INVALID";
export type RepeatedFailureFactPairAudit = "MATCHED" | "UNMATCHED" | "NOT_APPLICABLE";

export interface RepeatedFailureIsolationIdentity {
  repoId: string;
  memoryId: string;
  codingScopeId: string;
  codeGraphId: string;
  chatId: string;
  sessionId: string;
  cacheId: string;
}

export interface RepeatedFailureGateEvent {
  status: "NO_MATCH" | "MATCH_WARN" | "ERROR_FAIL_OPEN";
  fingerprintHash: string;
  warningHash?: string;
  faultCode?: string;
}

export interface RepeatedFailureEpisodeEvidence {
  startRepoHash: string;
  startMemoryHash: string;
  historyHash: string;
  askedActionHash: string;
  traceArtifactPath: string;
  traceArtifactHash: string;
  gate: RepeatedFailureGateEvent;
  actionExecuted: boolean;
  checkResult: "PASS" | "FAIL" | "INDETERMINATE";
  repeatedFailure: boolean;
  taskPassed: boolean;
  steps: number;
  warningCount: number;
  falseWarningCount: number;
  factPairAudit: RepeatedFailureFactPairAudit;
  faults: readonly string[];
}

export type RepeatedFailureEpisode =
  | {
      status: "VALID";
      finalState: Exclude<RepeatedFailureFinalState, "INVALID">;
      evidence: RepeatedFailureEpisodeEvidence;
      isolation: RepeatedFailureIsolationIdentity;
    }
  | {
      status: "INVALID";
      finalState: "INVALID";
      invalidReason: RepeatedFailureInvalidReason;
      evidence?: RepeatedFailureEpisodeEvidence;
      isolation?: RepeatedFailureIsolationIdentity;
    };

export interface RepeatedFailureTry {
  attempt: 1 | 2 | 3;
  durationMs: number;
  tokens: RepeatedFailureTokenUsage;
  outcome:
    | {
        kind: "HOST_API_FAULT";
        code: string;
        messageHash: string;
        exhausted?: boolean;
        evidence?: RepeatedFailureEpisodeEvidence;
        isolation?: RepeatedFailureIsolationIdentity;
      }
    | { kind: "TASK_RESULT"; episode: RepeatedFailureEpisode };
}

export interface RepeatedFailureEpisodeRow {
  schemaVersion: 1;
  rowKey: string;
  identity: RepeatedFailureRowIdentity;
  status: "VALID" | "INVALID";
  finalState: RepeatedFailureFinalState;
  invalidReason?: RepeatedFailureInvalidReason;
  repeatedFailure?: boolean;
  taskPassed?: boolean;
  steps?: number;
  warningCount?: number;
  falseWarningCount?: number;
  factPairAudit?: RepeatedFailureFactPairAudit;
  durationMs: number;
  tokens: RepeatedFailureTokenUsage;
  tryCount: number;
  evidence?: RepeatedFailureEpisodeEvidence;
  isolation?: RepeatedFailureIsolationIdentity;
}

export interface RepeatedFailureRowCheckpoint {
  schemaVersion: 1;
  rowKey: string;
  identity: RepeatedFailureRowIdentity;
  tries: RepeatedFailureTry[];
  terminal?: RepeatedFailureEpisodeRow;
}

export type RepeatedFailureCheckpointLoadResult =
  | { kind: "MISSING" }
  | { kind: "MALFORMED"; error: Error }
  | { kind: "VALID"; checkpoint: RepeatedFailureRowCheckpoint };


export interface RepeatedFailureToolDefinition {
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
}

export interface RepeatedFailureProposedAction {
  callId: string;
  tool: string;
  arguments: Readonly<Record<string, unknown>>;
}


export interface RepeatedFailureEpisodeInput {
  identity: RepeatedFailureRowIdentity;
  prompt: string;
  caps: ControlledResponsesCaps;
  toolHost: RepeatedFailureLocalToolHost;
  evaluator: RepeatedFailureActionEvaluator;
  signal?: AbortSignal;
}

export interface RepeatedFailureTokenizer {
  readonly identity: string;
  readonly implementation: "nfkc-whitespace-v1";
}

export interface RepeatedFailureEpisodeDriver {
  readonly driverKind?: "responses" | "ollama-chat" | "deterministic-fake";
  readonly modelProfileId: string;
  readonly modelProfileHash: string;
  readonly developerInstructions: string;
  readonly tokenizer: RepeatedFailureTokenizer;
  runEpisode(request: RepeatedFailureEpisodeInput): Promise<ControlledResponsesEpisodeResult>;
}

export interface RepeatedFailureSuiteManifest {
  suiteVersion: string;
  datasetInventoryHash: string;
  tasks: readonly {
    taskId: string;
    variantIds: readonly string[];
  }[];
}

export interface RunRepeatedFailureSuiteOptions {
  outputDir: string;
  drivers: readonly RepeatedFailureEpisodeDriver[];
  seeds: readonly number[];
  mode: BenchmarkMode;
  phase?: "pilot" | "main";
  pilotRunDir?: string;
  fixtureDir?: string;
  runId?: string;
  taskIds?: readonly string[];
  variantIds?: readonly string[];
  resume?: boolean;
  maxHostRetries?: 0 | 1 | 2;
  statisticsSeed?: number;
  statisticsDraws?: number;
  caps?: Partial<ControlledResponsesCaps>;
  maxToolOutputChars?: number;
  clock?: () => number;
  now?: () => Date;
}

export interface RepeatedFailureRunMetadata {
  schemaVersion: 1;
  runId: string;
  suiteVersion: string;
  datasetInventoryHash: string;
  resumeContractHash: string;
  expectedDesignHash: string;
  decisionRuleHash: string;
  analysisVersion: string;
  harnessVersion: string;
  harnessSourceHash: string;
  provenanceHash: string;
  gitSha: string;
  gitDirty: boolean;
  gitDirtyEntryCount: number;
  phase: "pilot" | "main" | "unspecified";
  pilotEvidence?: {
    runId: string;
    manifestArtifactHash: string;
    powerArtifactHash: string;
  };
  mode: BenchmarkMode;
  arms: readonly RepeatedFailureArm[];
  modelProfileIds: readonly string[];
  modelProfileHashes: readonly string[];
  seeds: readonly number[];
  splitTaskIds: readonly string[];
  taskRevisions: readonly {
    taskId: string;
    variantId: string;
    cleanRevisionSha: string;
    trapRevisionSha: string;
    rightRevisionSha: string;
    noTrapRevisionSha: string;
  }[];
  caps: ControlledResponsesCaps & { maxToolOutputChars: number };
  toolLocks: {
    allowedTools: readonly string[];
    taskToolSchemaHashes: readonly {
      taskId: string;
      variantId: string;
      sha256: string;
    }[];
  };
  sandboxFlags: {
    networkDisabled: true;
    isolatedRepoPerArm: true;
    isolatedMemoryPerArm: true;
    isolatedSessionPerArm: true;
    rejectSymlinks: true;
  };
  retryRule: {
    hostApiFaultRetriesAfterFirstTry: 0 | 1 | 2;
    rerunTaskResults: false;
    retainAllTries: true;
  };
  runOrder: readonly {
    rowKey: string;
    analysis: "PRIMARY" | "TIMIDITY";
    identity: RepeatedFailureRowIdentity;
  }[];
  expectedRowCount: number;
  statisticsSeed: number;
  statisticsDraws: number;
}

export interface RunRepeatedFailureSuiteResult {
  result: BenchmarkResult;
  resultPath: string;
  episodesPath: string;
  statisticsPath: string;
  runMetadataPath: string;
  expectedDesignPath: string;
  factPairAuditPath: string;
  powerPath: string;
  auditPath: string;
  deviationsPath: string;
  decisionRulePath: string;
  manifestPath: string;
  completed: number;
  resumed: number;
  invalid: number;
}

export interface RunRepeatedFailureCliCommandInput {
  phase: "pilot" | "main";
  seedCount: number;
  profilePaths: readonly string[];
  outputDir: string;
  fixtureDir?: string;
  resumeRunDir?: string;
  pilotRunDir?: string;
  maxSteps?: number;
  maxToolCalls?: number;
  maxOutputChars?: number;
  statisticsDraws?: number;
  statisticsSeed?: number;
}

export interface RepeatedFailureCliCommandResult {
  exitCode: number;
  output: string;
}

export interface ReplayRepeatedFailureStatisticsOptions {
  runDir: string;
}

export interface RepeatedFailureExpectedDesign {
  rows: readonly RepeatedFailureRowIdentity[];
}

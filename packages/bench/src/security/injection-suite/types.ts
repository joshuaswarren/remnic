/**
 * H5 injection-suite identities and artifacts (#1962).
 *
 * Resume contract copies the H6 lessons from issue #1963 / PR #2312:
 * per-row checkpoints, terminal rows are immutable, host/API faults retry
 * then pause the suite instead of cutting the row, and a resume-contract
 * hash refuses to continue a drifted run.
 */

export const INJECTION_SUITE_VERSION = "h5-injection-suite-v3";
export const HOST_FAULT_RETRY_LIMIT = 6;
export const INJECTION_SUITE_STAGES = [
  "base",
  "adaptive-r1",
  "adaptive-r2",
  "adaptive-r3",
  "benign",
  "benign-use",
  "adaptive-online-r1",
] as const;
export const INJECTION_SUITE_ARMS = [
  "none",
  "fencing",
  "quarantine",
  "both",
] as const;
export const INJECTION_SUITE_PUBLICATION_ARMS = [
  "none",
  "structured-boundary",
  "spotlighting-marking",
  "source-authenticated-fencing",
  "control-data-isolation",
  "layered-fence-quarantine",
] as const;
export const INJECTION_SUITE_FAMILIES = [
  "minja",
  "sleeper",
  "cross-session",
  "tool-hijack",
] as const;

export type InjectionSuiteArm =
  | (typeof INJECTION_SUITE_ARMS)[number]
  | (typeof INJECTION_SUITE_PUBLICATION_ARMS)[number];
export type InjectionSuiteFamily = (typeof INJECTION_SUITE_FAMILIES)[number];
export type InjectionSuiteStage = (typeof INJECTION_SUITE_STAGES)[number];

export function injectionSuiteArmUsesFence(arm: InjectionSuiteArm): boolean {
  return (
    arm === "fencing" ||
    arm === "both" ||
    arm === "source-authenticated-fencing" ||
    arm === "layered-fence-quarantine"
  );
}

export function injectionSuiteArmUsesQuarantine(
  arm: InjectionSuiteArm,
): boolean {
  return (
    arm === "quarantine" || arm === "both" || arm === "layered-fence-quarantine"
  );
}

export interface InjectionSuitePlantTurn {
  role: "user" | "assistant";
  originRole: "user" | "assistant" | "tool";
  content: string;
}

export interface InjectionSuiteCanary {
  type: "string" | "tool" | "url";
  value: string;
}

export interface InjectionSuiteRowIdentity {
  suiteVersion: string;
  stage: InjectionSuiteStage;
  modelProfileId: string;
  arm: InjectionSuiteArm;
  family: InjectionSuiteFamily;
  variantId: string;
  seed: number;
}

export interface InjectionSuiteVariant {
  stage: InjectionSuiteStage;
  family: InjectionSuiteFamily;
  templateId: string;
  variantId: string;
  payload: string;
  plantTurns: InjectionSuitePlantTurn[];
  triggerPrompt: string;
  canary: string;
  canarySpec: InjectionSuiteCanary;
  livenessCanary: string;
  livenessPrompt: string;
  benign: boolean;
  /** benign-use only: benign canary whose emission proves the memory was used. */
  useCanary?: string;
}

export type InjectionSuiteTrialOutcome =
  "ATTACK_SUCCEEDED" | "BLOCKED" | "VOID";
export type InjectionSuiteStopStage =
  | "write"
  | "recall"
  | "render"
  | "behavior"
  | "use"
  | "complete";

export interface InjectionSuiteTraceEvent {
  stage: InjectionSuiteStopStage;
  status: "ok" | "blocked" | "void";
  sha256?: string;
  count?: number;
}

export interface InjectionSuiteMemoryEvidence {
  memoryId: string;
  contentSha256: string;
  contentLength: number;
  origin: string;
  status: string;
  category: string;
}

export interface InjectionSuiteProductEvidence {
  viable: boolean;
  outcome: InjectionSuiteTrialOutcome;
  stoppedAt: InjectionSuiteStopStage;
  livenessCanaryEmitted: boolean;
  memories: InjectionSuiteMemoryEvidence[];
  preRenderSha256: string;
  renderedRecallSha256: string;
  recallTraceSha256: string | null;
  recalledChars: number;
  responseSha256: string;
  responseChars: number;
  toolCalls: string[];
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  model: string;
  trace: InjectionSuiteTraceEvent[];
}

export type InjectionSuiteTryOutcome =
  | { kind: "HOST_API_FAULT"; message: string }
  /** Online-adaptive attacker phase completed; the corpus line is the durable result. */
  | { kind: "ATTACKER_RESULT"; valid: boolean; attackerOutputSha256: string }
  | {
      kind: "TASK_RESULT";
      attackSucceeded: boolean;
      canaryEmitted: boolean;
      quarantined: boolean;
      fenced: boolean;
    };

export interface InjectionSuiteTry {
  attempt: number;
  durationMs: number;
  outcome: InjectionSuiteTryOutcome;
}

export interface InjectionSuiteEpisodeRow {
  rowKey: string;
  identity: InjectionSuiteRowIdentity;
  attackSucceeded: boolean;
  canaryEmitted: boolean;
  quarantined: boolean;
  fenced: boolean;
  evidence?: InjectionSuiteProductEvidence;
}

export interface InjectionSuiteCheckpoint {
  rowKey: string;
  identity: InjectionSuiteRowIdentity;
  tries: InjectionSuiteTry[];
  inFlight?: { attempt: number; startedAt: string };
  terminal?: InjectionSuiteEpisodeRow;
}

export interface InjectionSuiteRunMetadata {
  schemaVersion: 3;
  suiteVersion: string;
  resumeContractHash: string;
  modelProfileId: string;
  seeds: number[];
  variantsPerFamily: number;
  family?: InjectionSuiteFamily | null;
  limit: number | null;
  expectedRows: number;
  executor: string;
  model: string;
  baseUrl: string;
  requestTimeoutMs: number;
  stage: InjectionSuiteStage;
  runKind: "dev" | "pilot" | "main";
  modelProfileHash: string;
  modelDigest: string;
  corpusManifestHash: string;
  expectedDesignHash: string;
  decisionRuleHash: string;
  gitSha: string;
  cleanTree: boolean;
  /** Run option, not evidence: raw-response capture file was requested. */
  captureResponses?: boolean;
  /** adaptive-online-r1 only: disclosed attacker configuration. */
  attackerExecutor?: string;
  attackerModel?: string;
  attackerModelDigest?: string;
  attackerPromptSha256?: string;
  attackerIterations?: number;
}

export interface InjectionSuiteCliInput {
  seeds: number;
  seedBase?: number;
  variantsPerFamily: number;
  family?: InjectionSuiteFamily;
  arms?: InjectionSuiteArm[];
  modelProfileId: string;
  outputDir: string;
  resume?: boolean;
  limit?: number;
  /** Explicit operator override after an ambiguous paid request is investigated. */
  retryAmbiguous?: boolean;
  stage?: InjectionSuiteStage;
  runKind?: "dev" | "pilot" | "main";
  modelDigest?: string;
  modelContextTokens?: number;
  /** Test-only: inject host faults for the first N attempts of every row. */
  faultFirstAttempts?: number;
  executor?: "local" | "ollama" | "openai-compat";
  baseUrl?: string;
  model?: string;
  requestTimeoutMs?: number;
  /** Opt-in raw-response capture: write responses.jsonl beside the checkpoints. */
  captureResponses?: boolean;
  /** adaptive-online-r1 only: attacker model transport and disclosure set. */
  attackerExecutor?: "openai-compat" | "ollama";
  attackerBaseUrl?: string;
  attackerModel?: string;
  attackerModelDigest?: string;
  /** Path to the frozen attacker system prompt (hashed into the resume contract). */
  attackerPromptPath?: string;
  /** K: attacker rewrites per base variant; iteration 0 re-runs the base payload. */
  attackerIterations?: number;
}

export interface InjectionSuiteCliResult {
  exitCode: number;
  output: string;
  completed: number;
  resumed: number;
  paused?: boolean;
}

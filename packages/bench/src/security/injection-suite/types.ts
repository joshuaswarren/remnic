/**
 * H5 injection-suite identities and artifacts (#1962).
 *
 * Resume contract copies the H6 lessons from issue #1963 / PR #2312:
 * per-row checkpoints, terminal rows are immutable, host/API faults retry
 * then pause the suite instead of cutting the row, and a resume-contract
 * hash refuses to continue a drifted run.
 */

export const INJECTION_SUITE_VERSION = "h5-injection-suite-v1";
export const HOST_FAULT_RETRY_LIMIT = 6;
export const INJECTION_SUITE_ARMS = ["none", "fencing", "quarantine", "both"] as const;
export const INJECTION_SUITE_FAMILIES = [
  "minja",
  "sleeper",
  "cross-session",
  "tool-hijack",
] as const;

export type InjectionSuiteArm = (typeof INJECTION_SUITE_ARMS)[number];
export type InjectionSuiteFamily = (typeof INJECTION_SUITE_FAMILIES)[number];

export interface InjectionSuiteRowIdentity {
  suiteVersion: string;
  modelProfileId: string;
  arm: InjectionSuiteArm;
  family: InjectionSuiteFamily;
  variantId: string;
  seed: number;
}

export interface InjectionSuiteVariant {
  family: InjectionSuiteFamily;
  variantId: string;
  payload: string;
  canary: string;
}

export type InjectionSuiteTryOutcome =
  | { kind: "HOST_API_FAULT"; message: string }
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
}

export interface InjectionSuiteCheckpoint {
  rowKey: string;
  identity: InjectionSuiteRowIdentity;
  tries: InjectionSuiteTry[];
  inFlight?: { attempt: number; startedAt: string };
  terminal?: InjectionSuiteEpisodeRow;
}

export interface InjectionSuiteRunMetadata {
  schemaVersion: 2;
  suiteVersion: string;
  resumeContractHash: string;
  modelProfileId: string;
  seeds: number[];
  variantsPerFamily: number;
  limit: number | null;
  expectedRows: number;
  executor: string;
  model: string;
  baseUrl: string;
  requestTimeoutMs: number;
}

export interface InjectionSuiteCliInput {
  seeds: number;
  variantsPerFamily: number;
  modelProfileId: string;
  outputDir: string;
  resume?: boolean;
  limit?: number;
  /** Explicit operator override after an ambiguous paid request is investigated. */
  retryAmbiguous?: boolean;
  /** Test-only: inject host faults for the first N attempts of every row. */
  faultFirstAttempts?: number;
  executor?: "local" | "ollama" | "openai-compat";
  baseUrl?: string;
  model?: string;
  requestTimeoutMs?: number;
}

export interface InjectionSuiteCliResult {
  exitCode: number;
  output: string;
  completed: number;
  resumed: number;
  paused?: boolean;
}

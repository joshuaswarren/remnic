import { createHash, randomUUID } from "node:crypto";
import { planRecallMode } from "./intent.js";
import { evaluateMemoryActionPolicy } from "./memory-action-policy.js";
import type { RuntimePolicyValues } from "./policy-runtime.js";
import type { UtilityRuntimeValues } from "./utility-runtime.js";
import type { MemoryActionEligibilityContext, MemoryActionType, RecallPlanMode } from "./types.js";

/**
 * Gated unified memory controller (#2348).
 *
 * One state enters, one choice leaves. Host-free: every effectful collaborator
 * (adapters, executors, report reader, recorder, telemetry, clock) is injected.
 * The coordinator creates no store and claims no counterfactual lift.
 */

export type MemoryControllerMode = "off" | "shadow" | "active";

export type MemoryControllerActionFamily = "persistent_memory" | "recall" | "active_context" | "no_op";

/** #2347 adapter seam: the host supplies plans, core only picks one. */
export interface ActiveContextMessage {
  id: string;
  text: string;
}

export interface ActiveContextPlan {
  transform: "SUMMARY" | "FILTER";
  messageIds: string[];
  planId: string;
}

export interface ActiveContextAdapter {
  plan(messages: ActiveContextMessage[]): ActiveContextPlan | null;
}

/** #2345 report + #2346 paired-seed evidence, read through one port. */
export interface MemoryControllerEvidenceReport {
  status: "pass" | "fail";
  version: string;
  configHash: string;
  generatedAt: string;
  /** sha256 over the canonical report fields; recomputed on verification. */
  reportHash: string;
}

export interface MemoryControllerPairedSeedEvidence {
  status: "pass" | "fail";
  seedCount: number;
  generatedAt: string;
}

export interface MemoryControllerEvidence {
  report: MemoryControllerEvidenceReport;
  pairedSeed: MemoryControllerPairedSeedEvidence;
}

export interface MemoryControllerReportReader {
  read(): Promise<MemoryControllerEvidence | null>;
}

export interface MemoryControllerReceipt {
  decisionId: string;
  ok: boolean;
  detail?: string;
}

export interface MemoryControllerExecutors {
  executePersistentMemory?(input: {
    decisionId: string;
    action: MemoryActionType;
    eligibility: MemoryActionEligibilityContext;
    stateHash: string;
  }): Promise<MemoryControllerReceipt>;
  executeRecall?(input: { decisionId: string; mode: RecallPlanMode }): Promise<MemoryControllerReceipt>;
  executeActiveContext?(input: {
    decisionId: string;
    plan: ActiveContextPlan;
  }): Promise<MemoryControllerReceipt>;
}

export interface MemoryControllerEvent {
  schemaVersion: 1;
  phase: "choice" | "outcome";
  decisionId: string;
  timestamp: string;
  requestedMode: MemoryControllerMode;
  effectiveMode: MemoryControllerMode;
  stateHash: string;
  choice: MemoryControllerChoice;
  scores: Record<MemoryControllerActionFamily, number>;
  executed: boolean;
  reviewOnly?: boolean;
  demotionReasons?: string[];
  failureClass?: "record_failed" | "executor_error" | "bad_receipt" | "no_executor";
  receipt?: MemoryControllerReceipt;
}

export interface MemoryControllerRecorder {
  record(event: MemoryControllerEvent): Promise<void>;
  /** Prior shadow choice records; active promotion requires shadow history. */
  countShadowRecords(): Promise<number>;
}

export interface MemoryControllerConfig {
  mode: MemoryControllerMode;
  /** Expected #2345 report schema version. */
  reportVersion: string;
  /** Evidence older than this is stale and forces shadow. */
  evidenceMaxAgeMs: number;
  /** Paired-seed arms must cover at least this many seeds (#2346). */
  minPairedSeeds: number;
  /** Active promotion requires at least this many prior shadow records. */
  shadowMinRecords: number;
}

export interface MemoryControllerState {
  prompt: string;
  persistentMemoryCandidate?: {
    action: MemoryActionType;
    eligibility: MemoryActionEligibilityContext;
  };
  contextMessages?: ActiveContextMessage[];
  /** 0..1 host-measured context pressure. */
  contextPressure?: number;
}

export type MemoryControllerChoice =
  | { family: "persistent_memory"; action: MemoryActionType; eligibility: MemoryActionEligibilityContext }
  | { family: "recall"; mode: RecallPlanMode }
  | { family: "active_context"; plan: ActiveContextPlan }
  | { family: "no_op" };

export interface MemoryControllerRunResult {
  decisionId: string;
  requestedMode: MemoryControllerMode;
  effectiveMode: MemoryControllerMode;
  stateHash: string;
  choice: MemoryControllerChoice;
  scores: Record<MemoryControllerActionFamily, number>;
  executed: boolean;
  reviewOnly: boolean;
  recorded: boolean;
  receipt?: MemoryControllerReceipt;
  demotionReasons: string[];
}

export interface MemoryControllerDeps {
  config: MemoryControllerConfig;
  reportReader?: MemoryControllerReportReader;
  recorder?: MemoryControllerRecorder;
  executors?: MemoryControllerExecutors;
  activeContextAdapter?: ActiveContextAdapter;
  policyRuntime?: { loadRuntimeValues(): Promise<RuntimePolicyValues | null> };
  readUtilityRuntime?: () => Promise<UtilityRuntimeValues | null>;
  telemetry?: (event: MemoryControllerEvent) => void;
  clock?: () => Date;
}

const NO_OP_FLOOR = 0.35;
/** `discard` (and any destructive change) stays review-only in active mode. */
const REVIEW_ONLY_ACTIONS: Partial<Record<MemoryActionType, true>> = { discard: true };

export function controllerConfigHash(config: MemoryControllerConfig): string {
  return sha256(
    JSON.stringify({
      mode: config.mode,
      reportVersion: config.reportVersion,
      evidenceMaxAgeMs: config.evidenceMaxAgeMs,
      minPairedSeeds: config.minPairedSeeds,
      shadowMinRecords: config.shadowMinRecords,
    })
  );
}

export function hashControllerState(state: MemoryControllerState): string {
  return sha256(
    JSON.stringify({
      prompt: state.prompt,
      persistentMemoryCandidate: state.persistentMemoryCandidate ?? null,
      contextMessages: state.contextMessages ?? null,
      contextPressure: state.contextPressure ?? null,
    })
  );
}

/** Canonical #2345 report hash; producers sign with this, the controller verifies. */
export function computeEvidenceReportHash(fields: {
  status: MemoryControllerEvidenceReport["status"];
  version: string;
  configHash: string;
  generatedAt: string;
}): string {
  return sha256(JSON.stringify(fields));
}

/** Verifies the #2345 report hash over its canonical fields. */
export function verifyEvidenceReport(report: MemoryControllerEvidenceReport): boolean {
  return (
    computeEvidenceReportHash({
      status: report.status,
      version: report.version,
      configHash: report.configHash,
      generatedAt: report.generatedAt,
    }) === report.reportHash
  );
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return Number.NaN;
  return Math.max(0, Math.min(1, value));
}

/**
 * Bad scores fail closed to `no_op`.
 */
export function chooseAction(input: {
  state: MemoryControllerState;
  activeContextAdapter?: ActiveContextAdapter;
  runtimeValues?: RuntimePolicyValues | null;
  utilityValues?: UtilityRuntimeValues | null;
}): { choice: MemoryControllerChoice; scores: Record<MemoryControllerActionFamily, number> } {
  const { state, activeContextAdapter, runtimeValues, utilityValues } = input;

  // recall: current recall path.
  const recallMode = planRecallMode(state.prompt ?? "");
  const recallScore =
    recallMode === "no_recall" ? 0 : recallMode === "minimal" ? 0.4 : 0.6 + 0.2 * (runtimeValues?.recencyWeight ?? 0);

  // persistent_memory: current action path + policy.
  let persistentScore = 0;
  const candidate = state.persistentMemoryCandidate;
  if (candidate) {
    const policy = evaluateMemoryActionPolicy({
      action: candidate.action,
      eligibility: candidate.eligibility,
      options: { actionsEnabled: true, maxCompressionTokensPerHour: Number.POSITIVE_INFINITY },
    });
    if (policy.decision === "allow") {
      persistentScore = 0.4 + 0.4 * (candidate.eligibility.confidence ?? 0);
    } else if (policy.decision === "defer") {
      persistentScore = 0.2;
    }
    // Utility runtime may suppress the persistent family.
    if (utilityValues && utilityValues.rankingSuppressMultiplier > 1) {
      persistentScore *= 1 / utilityValues.rankingSuppressMultiplier;
    }
  }

  // active_context: current context path through the #2347 adapter.
  let contextScore = 0;
  let contextPlan: ActiveContextPlan | null = null;
  const pressure = state.contextPressure;
  if (activeContextAdapter && typeof pressure === "number" && Number.isFinite(pressure) && pressure > 0.5) {
    contextPlan = activeContextAdapter.plan(state.contextMessages ?? []);
    if (contextPlan && contextPlan.messageIds.length > 0) {
      contextScore = 0.3 + 0.5 * Math.max(0, Math.min(1, pressure));
    }
  }

  const scores: Record<MemoryControllerActionFamily, number> = {
    recall: clampScore(recallScore),
    persistent_memory: clampScore(persistentScore),
    active_context: clampScore(contextScore),
    no_op: NO_OP_FLOOR,
  };

  // Bad scores fail closed.
  if (Object.values(scores).some((score) => !Number.isFinite(score) || score < 0 || score > 1)) {
    return { choice: { family: "no_op" }, scores };
  }

  let choice: MemoryControllerChoice = { family: "no_op" };
  let best = scores.no_op;
  if (scores.recall > best) {
    best = scores.recall;
    choice = { family: "recall", mode: recallMode };
  }
  if (scores.persistent_memory > best) {
    best = scores.persistent_memory;
    choice = {
      family: "persistent_memory",
      action: candidate!.action,
      eligibility: candidate!.eligibility,
    };
  }
  if (scores.active_context > best) {
    choice = { family: "active_context", plan: contextPlan! };
  }
  return { choice, scores };
}

/** Returns the demotion reasons when active-mode gates fail; empty means go. */
export async function evaluateActiveGates(input: {
  config: MemoryControllerConfig;
  reportReader?: MemoryControllerReportReader;
  recorder?: MemoryControllerRecorder;
  consecutiveReceiptFailures: number;
  now: Date;
}): Promise<string[]> {
  const { config, reportReader, recorder, consecutiveReceiptFailures, now } = input;
  const reasons: string[] = [];

  if (!reportReader) return ["no_report_reader"];

  const evidence = await reportReader.read();
  if (!evidence) return ["no_evidence"];

  const { report, pairedSeed } = evidence;
  if (report.status !== "pass") reasons.push("report_not_passing");
  if (report.version !== config.reportVersion) reasons.push("report_version_mismatch");
  if (report.configHash !== controllerConfigHash(config)) reasons.push("report_config_unbound");
  if (!verifyEvidenceReport(report)) reasons.push("report_hash_invalid");
  const reportGeneratedAt = Date.parse(report.generatedAt);
  if (!Number.isFinite(reportGeneratedAt) || now.getTime() - reportGeneratedAt > config.evidenceMaxAgeMs) {
    reasons.push("report_stale");
  }

  if (pairedSeed.status !== "pass") reasons.push("paired_seed_not_passing");
  if (pairedSeed.seedCount < config.minPairedSeeds) reasons.push("paired_seed_count_low");
  const seedGeneratedAt = Date.parse(pairedSeed.generatedAt);
  if (!Number.isFinite(seedGeneratedAt) || now.getTime() - seedGeneratedAt > config.evidenceMaxAgeMs) {
    reasons.push("paired_seed_stale");
  }

  const shadowRecords = recorder ? await recorder.countShadowRecords() : 0;
  if (shadowRecords < config.shadowMinRecords) reasons.push("shadow_history_insufficient");

  if (consecutiveReceiptFailures > 0) reasons.push("recent_receipt_failures");

  return reasons;
}

export class MemoryControllerCoordinator {
  private readonly deps: MemoryControllerDeps;
  private readonly clock: () => Date;
  private consecutiveReceiptFailures = 0;

  constructor(deps: MemoryControllerDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? (() => new Date());
  }

  async run(state: MemoryControllerState): Promise<MemoryControllerRunResult> {
    const decisionId = randomUUID();
    const stateHash = hashControllerState(state);
    const requestedMode = this.deps.config.mode;

    // off: no choice, no read, no write, no call.
    if (requestedMode === "off") {
      return {
        decisionId,
        requestedMode,
        effectiveMode: "off",
        stateHash,
        choice: { family: "no_op" },
        scores: { persistent_memory: 0, recall: 0, active_context: 0, no_op: 0 },
        executed: false,
        reviewOnly: false,
        recorded: false,
        demotionReasons: ["mode_off"],
      };
    }

    const [runtimeValues, utilityValues] = await Promise.all([
      this.deps.policyRuntime?.loadRuntimeValues() ?? null,
      this.deps.readUtilityRuntime?.() ?? null,
    ]);
    const { choice, scores } = chooseAction({
      state,
      activeContextAdapter: this.deps.activeContextAdapter,
      runtimeValues,
      utilityValues,
    });

    let demotionReasons: string[] = [];
    let effectiveMode = requestedMode;
    if (requestedMode === "active") {
      demotionReasons = await evaluateActiveGates({
        config: this.deps.config,
        reportReader: this.deps.reportReader,
        recorder: this.deps.recorder,
        consecutiveReceiptFailures: this.consecutiveReceiptFailures,
        now: this.clock(),
      });
      if (demotionReasons.length > 0) effectiveMode = "shadow";
    }

    const baseEvent: MemoryControllerEvent = {
      schemaVersion: 1,
      phase: "choice",
      decisionId,
      timestamp: this.clock().toISOString(),
      requestedMode,
      effectiveMode,
      stateHash,
      choice,
      scores,
      executed: false,
      ...(demotionReasons.length > 0 ? { demotionReasons } : {}),
    };

    // Shadow records before any active dispatch.
    let recorded = false;
    if (this.deps.recorder) {
      try {
        await this.deps.recorder.record(baseEvent);
        this.deps.telemetry?.(baseEvent);
        recorded = true;
      } catch {
        // Bad recorder stops work: no dispatch, no outcome event.
        return {
          decisionId,
          requestedMode,
          effectiveMode,
          stateHash,
          choice,
          scores,
          executed: false,
          reviewOnly: false,
          recorded: false,
          demotionReasons: [...demotionReasons, "record_failed"],
        };
      }
    }

    if (effectiveMode !== "active") {
      return {
        decisionId,
        requestedMode,
        effectiveMode,
        stateHash,
        choice,
        scores,
        executed: false,
        reviewOnly: false,
        recorded,
        demotionReasons,
      };
    }

    // First active scope: reversible actions only.
    if (choice.family === "persistent_memory" && REVIEW_ONLY_ACTIONS[choice.action]) {
      const event: MemoryControllerEvent = {
        ...baseEvent,
        phase: "outcome",
        reviewOnly: true,
        demotionReasons: ["review_only_action"],
      };
      await this.recordOutcome(event);
      return {
        decisionId,
        requestedMode,
        effectiveMode,
        stateHash,
        choice,
        scores,
        executed: false,
        reviewOnly: true,
        recorded,
        demotionReasons,
      };
    }

    const receipt = await this.dispatch(choice, stateHash, decisionId, baseEvent);
    return {
      decisionId,
      requestedMode,
      effectiveMode,
      stateHash,
      choice,
      scores,
      executed: receipt?.ok === true,
      reviewOnly: false,
      recorded,
      ...(receipt ? { receipt } : {}),
      demotionReasons,
    };
  }

  private async dispatch(
    choice: MemoryControllerChoice,
    stateHash: string,
    decisionId: string,
    baseEvent: MemoryControllerEvent
  ): Promise<MemoryControllerReceipt | undefined> {
    const executors = this.deps.executors ?? {};
    try {
      let receipt: MemoryControllerReceipt | undefined;
      if (choice.family === "persistent_memory") {
        if (!executors.executePersistentMemory) throw new Error("no_executor:persistent_memory");
        receipt = await executors.executePersistentMemory({
          decisionId,
          action: choice.action,
          eligibility: choice.eligibility,
          stateHash,
        });
      } else if (choice.family === "recall") {
        if (!executors.executeRecall) throw new Error("no_executor:recall");
        receipt = await executors.executeRecall({ decisionId, mode: choice.mode });
      } else if (choice.family === "active_context") {
        if (!executors.executeActiveContext) throw new Error("no_executor:active_context");
        receipt = await executors.executeActiveContext({ decisionId, plan: choice.plan });
      } else {
        // no_op executed trivially; no executor call.
        receipt = { decisionId, ok: true };
      }
      if (!isValidReceipt(receipt, decisionId)) {
        this.consecutiveReceiptFailures += 1;
        await this.recordOutcome({ ...baseEvent, phase: "outcome", failureClass: "bad_receipt" });
        return undefined;
      }
      this.consecutiveReceiptFailures = 0;
      await this.recordOutcome({ ...baseEvent, phase: "outcome", executed: receipt.ok, receipt });
      return receipt;
    } catch (error) {
      this.consecutiveReceiptFailures += 1;
      await this.recordOutcome({
        ...baseEvent,
        phase: "outcome",
        failureClass: (error as Error)?.message?.startsWith("no_executor:") ? "no_executor" : "executor_error",
      });
      return undefined;
    }
  }

  private async recordOutcome(event: MemoryControllerEvent): Promise<void> {
    if (!this.deps.recorder) return;
    await this.deps.recorder.record(event);
    this.deps.telemetry?.(event);
  }
}

function isValidReceipt(receipt: unknown, decisionId: string): boolean {
  return (
    typeof receipt === "object" &&
    receipt !== null &&
    (receipt as MemoryControllerReceipt).decisionId === decisionId &&
    typeof (receipt as MemoryControllerReceipt).ok === "boolean"
  );
}

// ponytail: consecutiveReceiptFailures is per-instance, not persisted; persist
// with the recorder if coordinator restarts must carry receipt health forward.

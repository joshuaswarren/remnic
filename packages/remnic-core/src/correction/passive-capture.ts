/**
 * correction/passive-capture.ts — routes detected passive corrections to the
 * Correction Contract (#1580) by mode: queue, auto, or off (issue #1581).
 *
 * This module is the thin handoff between the extraction post-processing step
 * (which calls `detectPassiveCorrections`) and the CorrectionService's
 * `plan()` / `apply()` pipeline. It adds NO parallel correction logic (rule 22)
 * — the planner does all the locating/classifying; this module only decides
 * whether to queue the resulting plan for review or auto-apply it.
 *
 * Guards (auto mode):
 *   - plan confidence ≥ confidenceFloor
 *   - classification ∈ {outdated, wrong}
 *   - affected.length ≤ autoApplyMaxAffected
 *   - every action ∈ {supersede, edit, retract} (never auto-apply
 *     rescope/redaction_rule/never_store — those are policy changes)
 * If ANY guard fails, the plan falls back to queue.
 *
 * Session scoping (rule 42): a correction detected in session S plans only
 * against S's readable namespaces. The CorrectionService already enforces this
 * through its namespace policy; this module passes the session-scoped context.
 *
 * Dedup: fingerprint detected corrections by `bufferKey + normalizedCorrectionText`
 * so parallel sessions / re-flushes don't double-plan.
 */

import { log } from "../logger.js";
import type { PassiveCorrection } from "./passive-correction-detector.js";
import type {
  CorrectionClassification,
  CorrectionOutcome,
  CorrectionPlan,
  CorrectionRequest,
  CorrectionAction,
} from "./correction-contract.js";
import {
  enqueuePassiveCorrectionNotification,
} from "./passive-correction-notifications.js";

// ---------------------------------------------------------------------------
// Config + context
// ---------------------------------------------------------------------------

export type CorrectionCaptureMode = "off" | "queue" | "auto";

export interface PassiveCaptureConfig {
  mode: CorrectionCaptureMode;
  confidenceFloor: number;
  autoApplyMaxAffected: number;
}

export interface PassiveCaptureContext {
  /** The correction feature must be enabled for capture to run. */
  correctionEnabled: boolean;
  /** Whether this is a live session (not replay/import). Auto-apply is
   *  live-session only — replayed history may contain corrections the user
   *  later re-reverted; queue those. */
  isLiveSession: boolean;
  /** Buffer key for dedup fingerprinting. */
  bufferKey: string;
  /** Session key for namespace/principal resolution. */
  sessionKey?: string;
  /** Authenticated principal. */
  principal?: string;
  /** Authorized namespace the extraction wrote to. */
  namespace: string;
  /** Shared extraction deadline/cancellation signal. */
  abortSignal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Deps (injected — the orchestrator wires these)
// ---------------------------------------------------------------------------

export interface PassiveCaptureDeps {
  /** Plan a correction through the Correction Contract. */
  planCorrection(
    request: CorrectionRequest,
    opts?: { abortSignal?: AbortSignal },
  ): Promise<CorrectionPlan>;
  /** Apply a planned correction (auto mode only). */
  applyCorrection(
    planId: string,
    opts: {
      confirm: true;
      namespace?: string;
      sessionKey?: string;
      principal?: string;
      abortSignal?: AbortSignal;
    },
  ): Promise<CorrectionOutcome>;
  /** Resolve the storage dir for notification enqueue (per namespace). */
  storageDir(namespace: string): Promise<string>;
  /**
   * Resolve a memory handle (`[m:xxxx]`) to a concrete memory id, returning
   * null when the handle is unresolvable in the session (graceful — the
   * planner then falls back to text search). Wired to the orchestrator single
   * shared `resolveMemoryIdOrHandle` helper (#1582) so handle resolution has
   * one path (rule 22). Review: "memory handles not resolved".
   */
  resolveHandle?(ref: string, sessionKey?: string): string | null;
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export interface PassiveCaptureTelemetry {
  detected: number;
  queued: number;
  autoApplied: number;
  /** Reason → count for auto-apply suppressions. */
  suppressedReasons: Record<string, number>;
}

export function emptyTelemetry(): PassiveCaptureTelemetry {
  return { detected: 0, queued: 0, autoApplied: 0, suppressedReasons: {} };
}

// ---------------------------------------------------------------------------
// Dedup fingerprint
// ---------------------------------------------------------------------------

/** Normalize correction text for fingerprinting (case + whitespace + punctuation). */
function normalizeForFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function correctionFingerprint(bufferKey: string, correction: PassiveCorrection): string {
  return `${bufferKey}::${correction.polarity}::${normalizeForFingerprint(correction.targetHint)}`;
}

// ---------------------------------------------------------------------------
// Auto-apply guards
// ---------------------------------------------------------------------------

/** Action kinds that are safe to auto-apply (state-preserving, not policy changes). */
const AUTO_APPLICABLE_ACTION_KINDS = new Set(["supersede", "edit", "retract"]);

/** Classifications safe for auto-apply. */
const AUTO_APPLICABLE_CLASSIFICATIONS = new Set<CorrectionClassification>(["outdated", "wrong"]);

export type AutoApplySuppressionReason =
  | "non_live_session"
  | "confidence_below_floor"
  | "classification_not_allowed"
  | "affected_too_large"
  | "disallowed_action_kind"
  | "empty_plan";

/**
 * Evaluate all auto-apply guards. Returns the suppression reason (if any), or
 * null if auto-apply may proceed.
 */
export function evaluateAutoApplyGuards(
  plan: CorrectionPlan,
  config: PassiveCaptureConfig,
  isLiveSession: boolean,
): AutoApplySuppressionReason | null {
  if (!isLiveSession) return "non_live_session";
  if (plan.confidence < config.confidenceFloor) return "confidence_below_floor";
  if (!AUTO_APPLICABLE_CLASSIFICATIONS.has(plan.classification)) {
    return "classification_not_allowed";
  }
  if (plan.affected.length > config.autoApplyMaxAffected) {
    return "affected_too_large";
  }
  // An empty action list is a no-op plan (review: "queue plans that contain no
  // actions"). Auto-applying it would mark a correction as applied, write an
  // audit record + notification, and record the dedup fingerprint — yet nothing
  // changed. Suppress so it queues for human review instead.
  if (plan.actions.length === 0) {
    return "empty_plan";
  }
  for (const action of plan.actions) {
    if (!AUTO_APPLICABLE_ACTION_KINDS.has(action.kind)) {
      return "disallowed_action_kind";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main entry: capture passive corrections
// ---------------------------------------------------------------------------

export interface PassiveCaptureResult {
  telemetry: PassiveCaptureTelemetry;
  /** Plans created (both queued and auto-applied). */
  plans: CorrectionPlan[];
}

/**
 * Process a batch of detected passive corrections. For each correction:
 *   1. Check dedup fingerprint — skip if already processed for this bufferKey.
 *   2. Build a CorrectionRequest and call the planner.
 *   3. Dispatch by mode: queue → plan is left pending; auto → apply if all
 *      guards pass, else fall back to queue.
 *   4. Record telemetry.
 *
 * Fail-open: a planning or apply error for ONE correction never blocks the
 * others. The error is logged and the correction is counted as suppressed.
 */
export async function capturePassiveCorrections(
  corrections: readonly PassiveCorrection[],
  ctx: PassiveCaptureContext,
  config: PassiveCaptureConfig,
  deps: PassiveCaptureDeps,
  dedupState: Set<string>,
): Promise<PassiveCaptureResult> {
  const telemetry = emptyTelemetry();
  const plans: CorrectionPlan[] = [];
  telemetry.detected = corrections.length;

  for (const correction of corrections) {
    if (ctx.abortSignal?.aborted) return { telemetry, plans };
    // 1. Dedup — checked before planning, but the fingerprint is only
    //    recorded AFTER a successful plan so a transient planning failure
    //    can be retried on a later flush (review: "dedup blocks retry
    //    after failure").
    const fp = correctionFingerprint(ctx.bufferKey, correction);
    if (dedupState.has(fp)) {
      continue;
    }

    // 2. Resolve `[m:xxxx]` handles to concrete memory ids (review:
    //    "memory handles not resolved"). The planner resolveTargetMemories
    //    expects memory ids, not raw handle tokens — passing a handle
    //    string would throw "target memory not found". Unresolvable handles
    //    are dropped so the planner falls back to text search (graceful
    //    degradation; a correction without a resolved target is still valid).
    let targetIds: string[] | undefined;
    if (correction.handles.length > 0 && deps.resolveHandle && ctx.sessionKey) {
      const resolved: string[] = [];
      for (const handle of correction.handles) {
        const id = deps.resolveHandle(handle, ctx.sessionKey);
        if (id) resolved.push(id);
      }
      if (resolved.length > 0) targetIds = resolved;
    }

    // 3. Build + plan
    const request: CorrectionRequest = {
      text: correction.correctedAssertion || correction.sourceExcerpt,
      ...(targetIds ? { targetIds } : {}),
      ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
      ...(ctx.principal ? { principal: ctx.principal } : {}),
      namespace: ctx.namespace,
    };

    let plan: CorrectionPlan;
    try {
      plan = await deps.planCorrection(request, { abortSignal: ctx.abortSignal });
    } catch (err) {
      log.warn(
        `passive-correction: planning failed for "${correction.targetHint.slice(0, 60)}": ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    plans.push(plan);
    // Record the fingerprint only after a successful plan.
    dedupState.add(fp);
    if (ctx.abortSignal?.aborted) return { telemetry, plans };

    // 3. Dispatch by mode
    if (config.mode === "queue") {
      telemetry.queued += 1;
      continue;
    }

    // mode === "auto"
    const suppression = evaluateAutoApplyGuards(plan, config, ctx.isLiveSession);
    if (suppression) {
      telemetry.suppressedReasons[suppression] =
        (telemetry.suppressedReasons[suppression] ?? 0) + 1;
      telemetry.queued += 1;
      continue;
    }

    // Guards passed — auto-apply
    try {
      const outcome = await deps.applyCorrection(plan.planId, {
        confirm: true,
        namespace: ctx.namespace,
        ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
        ...(ctx.principal ? { principal: ctx.principal } : {}),
        abortSignal: ctx.abortSignal,
      });
      // A partial outcome means some actions failed (per-action races or
      // storage failures). Don't count it as auto-applied or notify — queue
      // for human review instead (review: "partial outcomes as failures").
      if (outcome.status !== "applied") {
        // Partial outcome: some actions applied, some failed. The plan is
        // consumed (status 'partial', not 'pending'), so it won't appear in
        // listPending — do NOT increment queued (review: "partial not
        // re-queued"). The audit record captures which actions failed.
        log.warn(
          `passive-correction: plan ${plan.planId} applied partially — some actions failed (see audit record)`,
        );
        continue;
      }
      telemetry.autoApplied += 1;

      // Enqueue notification for the next briefing
      try {
        const dir = await deps.storageDir(ctx.namespace);
        await enqueuePassiveCorrectionNotification(dir, {
          planId: plan.planId,
          summary: buildNotificationSummary(plan),
          undoCommand: `auto-applied (plan ${plan.planId})`,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        // Notification is best-effort — never block on it.
        log.debug(`passive-correction: notification enqueue failed (non-fatal): ${err}`);
      }
    } catch (err) {
      log.warn(
        `passive-correction: auto-apply failed for plan ${plan.planId}: ${err instanceof Error ? err.message : String(err)} — plan left in queue`,
      );
      telemetry.queued += 1;
    }
  }

  return { telemetry, plans };
}

// ---------------------------------------------------------------------------
// Notification summary builder
// ---------------------------------------------------------------------------

function buildNotificationSummary(plan: CorrectionPlan): string {
  const action = plan.actions[0];
  if (!action) {
    return plan.request.text.slice(0, 80);
  }
  const target =
    action.kind === "supersede"
      ? action.loserId
      : action.kind === "edit" || action.kind === "retract" || action.kind === "rescope"
        ? action.memoryId
        : "pattern";
  return `${plan.classification}: ${plan.request.text.slice(0, 60)}${plan.request.text.length > 60 ? "..." : ""} (${target})`;
}

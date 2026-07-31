/**
 * correction/correction-service.ts — thin orchestration for the Correction
 * Contract (issue #1580 PR 3).
 *
 * Owns the single plan/apply pipeline every correction surface (MCP / HTTP /
 * CLI) calls. Authorizes the caller through the existing namespace policy,
 * constructs the planner + executor with their collaborators, and exposes
 * `plan` / `apply` / `listPending` / `discard`.
 *
 * The service NEVER accepts a caller-supplied namespace without policy
 * validation (rule 42; checklist §16 foreign-ID guard): a principal may only
 * PLAN against namespaces they can READ and APPLY against namespaces they can
 * WRITE — both resolved through the injected namespace policy.
 */

import { throwIfAborted } from "../abort-error.js";
import {
  CorrectionContractError,
  type CorrectionOutcome,
  type CorrectionPlan,
  type CorrectionRequest,
} from "./correction-contract.js";
import { CorrectionPlanner, type PlannerDeps } from "./correction-planner.js";
import { CorrectionExecutor, type ExecutorDeps } from "./correction-executor.js";

// ---------------------------------------------------------------------------
// Injected collaborators — the access-service wires these from the orchestrator.
// ---------------------------------------------------------------------------

/**
 * Namespace policy façade. The access-service already implements these via
 * `resolveWritableNamespace` / `canReadNamespace` / `canWriteNamespace`; the
 * correction service consumes them through this narrow interface so the
 * correction modules stay decoupled from the access-service's surface area.
 */
export interface CorrectionNamespacePolicy {
  /**
   * Resolve the AUTHORIZED effective namespace for a plan/apply request.
   * Throws when the caller lacks read+write scope. The returned namespace is
   * the ONE the planner + executor operate in.
   */
  resolveAuthorizedNamespace(request: {
    namespace?: string;
    sessionKey?: string;
    principal?: string;
  }): Promise<string>;
  /**
   * Whether the caller may WRITE a given namespace. Used to authorize rescope
   * destinations before the executor moves a memory across namespaces.
   */
  canWriteNamespace(request: {
    namespace: string;
    sessionKey?: string;
    principal?: string;
    abortSignal?: AbortSignal;
  }): Promise<boolean>;
  /** Namespaces the caller may read — scopes the planner's search. */
  readableNamespaces(request: {
    namespace?: string;
    sessionKey?: string;
    principal?: string;
  }): Promise<readonly string[]>;
}

/**
 * Factory wiring for the planner + executor deps. The service holds ONE
 * planner + ONE executor for its lifetime; both are stateless across requests
 * (per-request scope is threaded through method parameters, rules 11/47).
 */
export interface CorrectionServiceDeps {
  readonly policy: CorrectionNamespacePolicy;
  /**
   * Planner collaborators. The planner takes `readableNamespaces` per call to
   * `plan()`, so a single deps instance serves callers with different scopes.
   */
  plannerDeps(): PlannerDeps;
  /** Executor collaborators (one per service). */
  executorDeps(): ExecutorDeps;
  /** Whether the correction feature is enabled (gate). */
  isEnabled(): boolean;
  /** Whether apply requires explicit confirmation (rule 48). */
  applyRequiresConfirm(): boolean;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CorrectionService {
  private readonly planner: CorrectionPlanner;
  private readonly executor: CorrectionExecutor;

  constructor(private readonly deps: CorrectionServiceDeps) {
    this.planner = new CorrectionPlanner(deps.plannerDeps());
    this.executor = new CorrectionExecutor(deps.executorDeps(), this.planner);
  }

  /**
   * Plan a correction. Read-only — produces + persists a {@link CorrectionPlan}.
   * Safe to run with the gate ON (default) since the plan writes no memory state.
   *
   * The plan is stored under the AUTHORIZED (writable) namespace — the same
   * namespace apply/listPending/discard resolve — so the plan is always
   * found by the caller that created it (review threads: plan-stored-wrong-
   * namespace + cross-namespace candidate mismatch). Candidates are located
   * within that single namespace too: a correction can only affect memories
   * the principal can write, so reading from a non-writable namespace to
   * draft a correction that can never be applied would be misleading.
   */
  async plan(
    request: CorrectionRequest,
    opts?: { abortSignal?: AbortSignal },
  ): Promise<CorrectionPlan> {
    this.requireEnabled();
    throwIfAborted(opts?.abortSignal, "correction planning aborted");
    const authorized = await this.deps.policy.resolveAuthorizedNamespace(request);
    throwIfAborted(opts?.abortSignal, "correction planning aborted");
    return this.planner.plan(request, [authorized], opts);
  }
  async apply(
    planId: string,
    opts: {
      confirm?: boolean;
      namespace?: string;
      sessionKey?: string;
      principal?: string;
      abortSignal?: AbortSignal;
    },
  ): Promise<CorrectionOutcome> {
    this.requireEnabled();
    throwIfAborted(opts.abortSignal, "correction apply aborted");
    if (this.deps.applyRequiresConfirm() && opts.confirm !== true) {
      throw new CorrectionContractError(
        "Correction apply requires explicit confirmation (pass `confirm: true`).",
      );
    }
    const namespace = await this.deps.policy.resolveAuthorizedNamespace({
      ...(opts.namespace ? { namespace: opts.namespace } : {}),
      ...(opts.sessionKey ? { sessionKey: opts.sessionKey } : {}),
      ...(opts.principal ? { principal: opts.principal } : {}),
    });
    throwIfAborted(opts.abortSignal, "correction apply aborted");
    return this.executor.apply(namespace, planId, {
      confirm: true,
      abortSignal: opts.abortSignal,
      // Authorize rescope destinations through the namespace policy bound to
      // THIS caller's principal (review thread: authorize-rescope-destination).
      canWriteDestination: (dest, abortSignal) =>
        this.deps.policy.canWriteNamespace({
          namespace: dest,
          ...(opts.sessionKey ? { sessionKey: opts.sessionKey } : {}),
          ...(opts.principal ? { principal: opts.principal } : {}),
          ...(abortSignal ? { abortSignal } : {}),
        }),
    });
  }

  /** List pending (not-yet-applied) plans for the caller's namespace. */
  async listPending(opts: {
    namespace?: string;
    sessionKey?: string;
    principal?: string;
  }): Promise<CorrectionPlan[]> {
    this.requireEnabled();
    const namespace = await this.deps.policy.resolveAuthorizedNamespace(opts);
    return this.planner.listPending(namespace);
  }

  /** Discard a pending plan. Idempotent. */
  async discard(
    planId: string,
    opts: { namespace?: string; sessionKey?: string; principal?: string },
  ): Promise<void> {
    this.requireEnabled();
    const namespace = await this.deps.policy.resolveAuthorizedNamespace(opts);
    await this.planner.markConsumed(namespace, planId, "discarded");
    await this.planner.deletePlan(namespace, planId);
  }

  /**
   * Recover stale `applying` plans across the given namespaces (#1713 Item 2).
   *
   * Startup maintenance: scans each namespace for plans stuck in `applying`
   * past the stale-applying TTL (process died mid-apply) and discards+scrubs
   * them. Unlike plan/apply/listPending, this is NOT a per-caller request —
   * it operates on all supplied namespaces directly because it is an
   * internal maintenance operation invoked by the orchestrator at init.
   *
   * @returns the total count of recovered plans across all namespaces.
   */
  async recoverStaleApplyingPlans(namespaces: readonly string[]): Promise<number> {
    // Intentionally NOT gated on isEnabled(): stale-applying recovery is a
    // maintenance/cleanup operation, not a user-facing correction. Plans left
    // in 'applying' after a mid-apply crash hold unscrubbed redaction_rule
    // patterns on disk; they must be discarded+scrubbed even if the correction
    // feature is currently disabled (review thread 9e1f07f0).
    let recovered = 0;
    for (const namespace of namespaces) {
      try {
        const ids = await this.planner.recoverStaleApplyingPlans(namespace);
        recovered += ids.length;
      } catch {
        // Best-effort: a single namespace failure must not abort the sweep.
      }
    }
    return recovered;
  }

  private requireEnabled(): void {
    if (!this.deps.isEnabled()) {
      throw new CorrectionContractError(
        "Correction Contract is disabled (set correction.enabled = true to enable).",
      );
    }
  }
}

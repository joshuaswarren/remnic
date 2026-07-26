/**
 * correction/correction-executor.ts — the only writer for corrections
 * (issue #1580 PR 2).
 *
 * Applies a {@link CorrectionPlan} in NON-DESTRUCTIVE ORDER
 * (rule 25 / checklist §14 — new state confirmed before old state destroyed):
 *
 *   1. Write replacement / edited memories first (through the injected
 *      persist pipeline so catalog/reindex/dedup fire — rule 43; edits go
 *      through page-versioning so every change is revertable).
 *   2. Then supersede / retract losers: status flip + `validUntil` stamp
 *      (#1578, when gated on) + tombstone append (#1579).
 *   3. Then propagation: QMD reindex for touched files, graph edge updates,
 *      belief-ledger claim status (optional-package dynamic import, rule 57),
 *      profile.md line removal when an affected memory was profile-sourced.
 *   4. Append an audit record to `corrections/` capturing plan + outcome —
 *      corrections are themselves memories, searchable and namespaced.
 *   5. Partial failure → tagged partial result (rule 34; checklist §22):
 *      never a half-applied plan reported as success, and never old state
 *      destroyed for an action whose replacement write failed.
 *
 * Concurrency: a plan may be applied exactly once. A second apply of the same
 * plan is rejected (plan consumed). Backed by the planner's atomic plan-store
 * (`markConsumed`) under `serializeMutations` keyed by plan id (rule 40).
 */

import { throwIfAborted } from "../abort-error.js";
import { serializeMutations } from "../utils/serialize-mutations.js";
import type { CorrectionPlanner } from "./correction-planner.js";
import {
  CorrectionContractError,
  validateCorrectionAction,
  validateRedactionPattern,
  type CorrectionAction,
  type CorrectionActionResult,
  type CorrectionOutcome,
  type CorrectionPlan,
} from "./correction-contract.js";

// ---------------------------------------------------------------------------
// Injected collaborators
// ---------------------------------------------------------------------------

/** A memory the executor is operating on (subset of MemoryFile). */
export interface ExecutorMemory {
  memoryId: string;
  content: string;
  category: string;
  /** True when the memory has frontmatter provenance (#1575 sourceQuote). */
  sourceQuote?: string;
  /** Structured-attribute supersession key, when one exists (legacy single-key). */
  supersessionKey?: string;
  /**
   * ALL derived supersession keys for the memory's structuredAttributes
   * (#1672 item 4). A paraphrased re-observation may place the tombstoned
   * attribute at a different position in structuredAttributes; without an
   * entry for every matched key the keyed tier misses and the fact
   * resurrects. Mirrors temporal-supersession's per-key emission.
   */
  supersessionKeys?: string[];
  /**
   * Canonical contentHash from the retired memory's frontmatter (#1672 item
   * 4 / #1579). Carried into the tombstone so the exact tier matches
   * re-extraction rather than recomputing from a citation-annotated body.
   */
  contentHash?: string;
  entityRef?: string;
  /** Raw content used for the tombstone hash (rule 23). */
  rawContent: string;
}

export interface ExecutorDeps {
  getMemory(namespace: string, memoryId: string, abortSignal?: AbortSignal): Promise<ExecutorMemory | null>;
  /**
   * Persist a NEW memory through the orchestrator's normal write pipeline
   * (catalog/reindex/dedup fire — rule 43). Returns the new memory id.
   * Used by `supersede` (the replacement).
   */
  writeReplacement(
    namespace: string,
    draft: {
      content: string;
      category?: string;
      confidence?: number;
      tags?: string[];
      entityRef?: string;
      validAt?: string;
      observedAt?: string;
      structuredAttributes?: Record<string, string>;
      supersedes?: string;
    },
    abortSignal?: AbortSignal,
  ): Promise<string>;
  /**
   * Apply a versioned edit to an existing memory (page-versioning — every
   * change revertable). Returns the memory id. The patch is the NEW full
   * content; the implementation snapshots the prior version.
   */
  applyEdit(
    namespace: string,
    memoryId: string,
    patch: string,
    abortSignal?: AbortSignal,
  ): Promise<string>;
  /**
   * Flip a memory's status to superseded/retracted and stamp `validUntil`
   * when bi-temporal is gated on (#1578). Idempotent.
   */
  retireMemory(
    namespace: string,
    memoryId: string,
    opts: {
      status: "superseded" | "retracted";
      supersededBy?: string;
      validUntil?: string;
    },
    abortSignal?: AbortSignal,
  ): Promise<void>;
  /**
   * Move a memory to a different namespace (rescope). The destination
   * namespace is re-authorized by the service before the executor runs; the
   * implementation performs the move atomically (write-then-unlink).
   */
  rescopeMemory(
    namespace: string,
    memoryId: string,
    toNamespace: string,
    abortSignal?: AbortSignal,
  ): Promise<string>;
  /**
   * Append a tombstone (#1579) for a retired memory. Returns the tombstone
   * id, or null if tombstones are disabled (off = pre-feature behavior).
   */
  appendTombstone(
    namespace: string,
    input: {
      reason: "correction" | "supersession" | "retraction";
      sourceMemoryId: string;
      rawContent: string;
      entityRef?: string;
      supersessionKey?: string;
      /**
       * ALL derived supersession keys (#1672 item 4). When present, the
       * implementation emits one tombstone per key so a paraphrased
       * re-observation placing the attribute at a different key position is
       * still blocked at the keyed tier.
       */
      supersessionKeys?: string[];
      /** Canonical contentHash from the retired memory's frontmatter (#1672 item 4). */
      contentHash?: string;
    },
    abortSignal?: AbortSignal,
  ): Promise<string | null>;
  /**
   * Persist a redaction rule so extraction consults it the same way tombstones
   * are consulted (route through the same chokepoint check). Idempotent.
   */
  registerRedactionRule(namespace: string, pattern: string, abortSignal?: AbortSignal): Promise<void>;
  /**
   * Append an audit record under `corrections/` (existing storage category)
   * capturing plan + outcome. Returns the audit memory id.
   */
  appendAuditRecord(
    namespace: string,
    record: {
      planId: string;
      classification: CorrectionPlan["classification"];
      outcome: CorrectionOutcome;
      requestText: string;
    },
    abortSignal?: AbortSignal,
  ): Promise<string>;
  /**
   * Post-write propagation: QMD reindex for touched files (checklist §31),
   * graph edge updates, belief-ledger claim status. Best-effort — a failure
   * here is recorded as a warning, never as a failed action (propagation is
   * not part of the §14 non-destructive-order guarantee; it runs after).
   */
  propagate(
    namespace: string,
    touchedMemoryIds: readonly string[],
    abortSignal?: AbortSignal,
  ): Promise<void>;
  /** Whether the bi-temporal gate (#1578) is on. When off, validUntil is omitted. */
  readonly biTemporalEnabled: boolean;
  /** Injected clock for deterministic tests. */
  now(): Date;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class CorrectionExecutor {
  constructor(
    private readonly deps: ExecutorDeps,
    private readonly planner: CorrectionPlanner,
  ) {}

  /**
   * Apply a persisted plan by id. Idempotent-once: a second apply of the same
   * plan is rejected. Returns the {@link CorrectionOutcome}.
   */
  async apply(
    namespace: string,
    planId: string,
    opts: {
      confirm: boolean;
      abortSignal?: AbortSignal;
      /**
       * Authorize a rescope destination namespace. Bound per-request by the
       * service from the namespace policy + principal so a plan can never
       * write into a namespace the caller lacks write scope for (review
       * thread: authorize-rescope-destination). Defaults to allow when the
       * source namespace already resolves to a writable scope (single-tenant).
       */
      canWriteDestination?: (namespace: string) => Promise<boolean>;
    },
  ): Promise<CorrectionOutcome> {
    throwIfAborted(opts.abortSignal, "correction apply aborted");
    if (!opts.confirm) {
      throw new CorrectionContractError(
        "Correction apply requires explicit confirmation (correction.applyRequiresConfirm).",
      );
    }
    // serializeMutations on the plan id so two concurrent applies of the SAME
    // plan serialize — the second observes the consumed status and rejects.
    return serializeMutations(`correction-apply:${namespace}:${planId}`, () =>
      this.applyInternal(
        namespace,
        planId,
        opts.canWriteDestination,
        opts.abortSignal,
      ),
    );
  }

  private async applyInternal(
    namespace: string,
    planId: string,
    canWriteDestination?: (namespace: string) => Promise<boolean>,
    abortSignal?: AbortSignal,
  ): Promise<CorrectionOutcome> {
    throwIfAborted(abortSignal, "correction apply aborted");
    const plan = await this.planner.loadPlan(namespace, planId);
    throwIfAborted(abortSignal, "correction apply aborted");
    if (!plan) {
      throw new CorrectionContractError(`Correction plan not found: ${planId}`);
    }
    if (plan.namespace !== namespace) {
      // Cross-namespace foreign-id guard (rule 42 / checklist §16).
      throw new CorrectionContractError(
        `Correction plan ${planId} belongs to namespace '${plan.namespace}', not '${namespace}'.`,
      );
    }
    if (plan.status === "applied" || plan.status === "partial" || plan.status === "applying") {
      throw new CorrectionContractError(
        `Correction plan ${planId} has already been applied or is in progress (status=${plan.status}).`,
      );
    }
    if (plan.status === "discarded") {
      throw new CorrectionContractError(`Correction plan ${planId} has been discarded.`);
    }
    // TTL check — expired plans are rejected with a clear error.
    if (this.deps.now().getTime() > new Date(plan.expiresAt).getTime()) {
      await this.planner.markConsumed(namespace, planId, "discarded");
      throw new CorrectionContractError(
        `Correction plan ${planId} expired at ${plan.expiresAt} and has been discarded.`,
      );
    }

    // Re-validate every action shape before applying (defense in depth).
    for (const action of plan.actions) {
      validateCorrectionAction(action);
      if (action.kind === "redaction_rule") {
        validateRedactionPattern(action.pattern);
      }
    }

    // Optimistically mark the plan `applying` BEFORE any mutation (review
    // thread OgIqt). If the process dies mid-apply — or the final
    // markConsumed("applied"|"partial") fails — the plan stays `applying`
    // and is NOT silently retryable. A partially-applied plan must never be
    // re-applied wholesale: re-running succeeded actions would duplicate
    // replacements, tombstones, and audits. The operator inspects the
    // outcome and files a NEW plan for any failed actions. This mark runs
    // inside the serializeMutations lock so concurrent applies serialize.
    throwIfAborted(abortSignal, "correction apply aborted");
    try {
      await this.planner.markConsumed(namespace, planId, "applying");
    } catch {
      // If we cannot even mark the plan in-progress, the filesystem is
      // likely unwritable and mutations would fail too — fail closed now.
      throw new CorrectionContractError(
        `Correction plan ${planId}: cannot mark in-progress (filesystem unwritable?) — aborting before any mutation.`,
      );
    }
    throwIfAborted(abortSignal, "correction apply aborted");

    const results: CorrectionActionResult[] = [];
    const appliedTouched: string[] = [];
    const retiredReplacementActions = new Set<CorrectionAction>();
    const removeFailedResultsFor = (action: CorrectionAction): void => {
      for (let i = results.length - 1; i >= 0; i -= 1) {
        if (results[i]?.action === action && results[i]?.status === "failed") {
          results.splice(i, 1);
        }
      }
    };

    // ── Phase 1: replacement / edit writes (new state first) ───────────────
    // For each supersede with a replacement, write the replacement FIRST. If
    // the write fails, the loser is NOT superseded (§14: never destroy old
    // state for an action whose replacement write failed).
    for (const action of plan.actions) {
      throwIfAborted(abortSignal, "correction apply aborted");
      if (action.kind === "supersede" && action.replacement) {
        // Preflight the loser BEFORE writing the replacement (review thread
        // Of0pz): if the loser was deleted between plan and apply, writing a
        // replacement creates an orphan fact that supersedes nothing. Phase 2
        // (retireAndTombstone) re-checks via getMemory, so verifying here
        // keeps the two phases in agreement and avoids the orphan write.
        const loser = await this.deps.getMemory(namespace, action.loserId, abortSignal);
        if (!loser) {
          results.push({
            action,
            status: "failed",
            error: `supersede loser not found: ${action.loserId}`,
          });
          continue;
        }
        try {
          const newId = await this.deps.writeReplacement(namespace, {
            content: action.replacement.content,
            ...(action.replacement.category ? { category: action.replacement.category } : {}),
            ...(action.replacement.confidence !== undefined ? { confidence: action.replacement.confidence } : {}),
            ...(action.replacement.tags ? { tags: action.replacement.tags } : {}),
            ...(action.replacement.entityRef ? { entityRef: action.replacement.entityRef } : {}),
            ...(action.replacement.validAt ? { validAt: action.replacement.validAt } : {}),
            ...(action.replacement.observedAt ? { observedAt: action.replacement.observedAt } : {}),
            ...(action.replacement.structuredAttributes
              ? { structuredAttributes: action.replacement.structuredAttributes }
              : {}),
            supersedes: action.loserId,
          }, abortSignal);
          results.push({ action, status: "applied", memoryId: newId });
          appliedTouched.push(newId);
          // A replacement and retirement form one non-destructive transaction.
          // Once the replacement is durable, cancellation cannot interrupt the
          // retirement half and leave both memories active. This remains inside
          // the apply plan's serializeMutations lock.
          const retirementResultBeforePhase2 = results.at(-1);
          await this.retireAndTombstone(
            namespace,
            action,
            "supersession",
            results,
            appliedTouched,
            { supersededBy: newId },
          );
          const retirementResult = results.at(-1);
          if (
            retirementResult !== retirementResultBeforePhase2 &&
            retirementResult?.action === action &&
            retirementResult.status === "applied"
          ) {
            retiredReplacementActions.add(action);
          }
        } catch (err) {
          if (abortSignal?.aborted) throw err;
          results.push({
            action,
            status: "failed",
            error: errMsg(err),
          });
        }
      } else if (action.kind === "edit") {
        try {
          const editedId = await this.deps.applyEdit(namespace, action.memoryId, action.patch, abortSignal);
          results.push({ action, status: "applied", memoryId: editedId });
          appliedTouched.push(editedId);
        } catch (err) {
          if (abortSignal?.aborted) throw err;
          results.push({ action, status: "failed", error: errMsg(err) });
        }
      } else if (action.kind === "redaction_rule") {
        try {
          await this.deps.registerRedactionRule(namespace, action.pattern, abortSignal);
          results.push({ action, status: "applied" });
        } catch (err) {
          if (abortSignal?.aborted) throw err;
          results.push({ action, status: "failed", error: errMsg(err) });
        }
      }
    }

    // ── Phase 2: retire losers + tombstones ───────────────────────────────
    // Only run for supersede/retract actions whose replacement write (if any)
    // succeeded. A supersede WITHOUT a replacement is a pure retract.
    for (const action of plan.actions) {
      throwIfAborted(abortSignal, "correction apply aborted");
      if (action.kind === "supersede" && retiredReplacementActions.has(action)) continue;
      if (action.kind === "supersede") {
        const replacementResult = results.find(
          (r) => r.action === action && r.status === "applied",
        );
        // If the replacement write failed, skip retirement (§14).
        if (action.replacement && !replacementResult) {
          continue;
        }
        await this.retireAndTombstone(
          namespace,
          action,
          "supersession",
          results,
          appliedTouched,
          { supersededBy: replacementResult?.memoryId },
          abortSignal,
        );
        if (results.at(-1)?.action === action && results.at(-1)?.status === "applied") {
          removeFailedResultsFor(action);
        }
      } else if (action.kind === "retract") {
        await this.retireAndTombstone(
          namespace,
          action,
          "retraction",
          results,
          appliedTouched,
          {},
          abortSignal,
        );
        if (results.at(-1)?.action === action && results.at(-1)?.status === "applied") {
          removeFailedResultsFor(action);
        }
      } else if (action.kind === "rescope") {
        try {
          // Authorize the destination namespace BEFORE the move — the plan's
          // toNamespace comes from the LLM/persisted plan and must not bypass
          // the write ACL (review thread: authorize-rescope-destination).
          // canWriteDestination defaults to allow when absent (single-tenant,
          // where the source namespace already resolved to a writable scope).
          const allowed = canWriteDestination ? await canWriteDestination(action.toNamespace) : true;
          if (!allowed) {
            results.push({
              action,
              status: "failed",
              error: `rescope destination namespace not writable: ${action.toNamespace}`,
            });
            continue;
          }
          const destId = await this.deps.rescopeMemory(
            namespace,
            action.memoryId,
            action.toNamespace,
            abortSignal,
          );
          // #1678 (thread OiiV6): report the DESTINATION memory id, not the
          // source. The source is archived by the move; callers that re-fetch
          // the reported id need the live (destination) memory, otherwise they
          // observe an archived fact and the correction looks like a no-op.
          results.push({ action, status: "applied", memoryId: destId });
          appliedTouched.push(action.memoryId); // source id for source-side propagation
          // Propagate the destination memory in its namespace too (review
          // thread: propagate-rescoped-destination) — best-effort.
          try {
            await this.deps.propagate(action.toNamespace, [destId], abortSignal);
          } catch (err) {
            if (abortSignal?.aborted) throw err;
            // non-fatal — the source propagation still fires.
          }
        } catch (err) {
          if (abortSignal?.aborted) throw err;
          results.push({ action, status: "failed", error: errMsg(err) });
        }
      }
    }
    throwIfAborted(abortSignal, "correction apply aborted");

    // ── Phase 3: propagation (post-write reindex + graph) ─────────────────
    // Best-effort: a propagation failure is recorded as a warning on the
    // outcome, never as a failed action (it runs AFTER the §14 guarantee).
    const propagationWarnings: string[] = [];
    if (appliedTouched.length > 0) {
      try {
        await this.deps.propagate(namespace, appliedTouched, abortSignal);
      } catch (err) {
        if (abortSignal?.aborted) throw err;
        propagationWarnings.push(`propagation failed (non-fatal): ${errMsg(err)}`);
      }
    }

    throwIfAborted(abortSignal, "correction apply aborted");
    // ── Phase 4: audit record ─────────────────────────────────────────────
    const anyFailed = results.some((r) => r.status === "failed");
    const status: CorrectionOutcome["status"] = anyFailed ? "partial" : "applied";
    const appliedAt = this.deps.now().toISOString();
    const outcome: CorrectionOutcome = {
      planId,
      status,
      results,
      auditMemoryId: "", // filled after the audit write
      appliedAt,
    };
    if (propagationWarnings.length > 0) {
      (outcome as CorrectionOutcome & { warnings?: string[] }).warnings = propagationWarnings;
    }
    try {
      const auditId = await this.deps.appendAuditRecord(namespace, {
        planId,
        classification: plan.classification,
        outcome,
        requestText: plan.request.text,
      }, abortSignal);
      outcome.auditMemoryId = auditId;
    } catch (err) {
      if (abortSignal?.aborted) throw err;
      // The audit record is part of the contract but a failure to write it
      // must NOT undo the applied corrections. Record as a warning.
      (outcome as CorrectionOutcome & { warnings?: string[] }).warnings = [
        ...propagationWarnings,
        `audit record write failed (non-fatal): ${errMsg(err)}`,
      ];
    }
    throwIfAborted(abortSignal, "correction apply aborted");

    // ── Phase 5: mark plan consumed ───────────────────────────────────────
    // Corrections are already applied (phases 1-4 succeeded). A markConsumed
    // failure must NOT propagate — that would make a client retry re-apply all
    // corrections (review thread: applyInternal-plan-unconsumed). Record as a
    // warning; the pending plan is reconciled by TTL discard on the next pass.
    try {
      await this.planner.markConsumed(namespace, planId, status);
    } catch (err) {
      const w = outcome as CorrectionOutcome & { warnings?: string[] };
      w.warnings = [...(w.warnings ?? []), `plan mark-consumed failed (non-fatal): ${errMsg(err)}`];
    }
    return outcome;
  }

  private async retireAndTombstone(
    namespace: string,
    action: CorrectionAction,
    reason: "supersession" | "retraction",
    results: CorrectionActionResult[],
    appliedTouched: string[],
    opts: { supersededBy?: string } = {},
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const memoryId =
      action.kind === "supersede" ? action.loserId : action.kind === "retract" ? action.memoryId : null;
    if (!memoryId) return;
    try {
      const memory = await this.deps.getMemory(namespace, memoryId, abortSignal);
      if (!memory) {
        results.push({
          action,
          status: "failed",
          error: `memory not found: ${memoryId}`,
        });
        return;
      }
      const validUntil = this.deps.biTemporalEnabled ? this.deps.now().toISOString() : undefined;
      // Write the tombstone BEFORE retiring the source memory (review thread
      // PG9): if appendTombstone throws here, retireMemory has not run yet, so
      // the source stays active, the action fails cleanly, and a retry
      // operates on un-mutated state with no resurrection window. A tombstone
      // for a still-active memory (if retire later fails) is benign — it only
      // blocks re-ingestion of the same content, which is exactly the intent.
      const tombstoneId = await this.deps.appendTombstone(namespace, {
        reason,
        sourceMemoryId: memoryId,
        rawContent: memory.rawContent,
        ...(memory.entityRef ? { entityRef: memory.entityRef } : {}),
        ...(memory.supersessionKey ? { supersessionKey: memory.supersessionKey } : {}),
        // #1672 item 4: carry the canonical contentHash (exact tier) and the
        // full supersession-key set (keyed tier) so paraphrased re-observations
        // of the same supersession identity are blocked, not just the literal
        // body. Without these the tombstone projected from a structured fact
        // dropped both fields and the fact could resurrect.
        ...(memory.contentHash ? { contentHash: memory.contentHash } : {}),
        ...(memory.supersessionKeys && memory.supersessionKeys.length > 0
          ? { supersessionKeys: memory.supersessionKeys }
          : {}),
      }, abortSignal);
      // A committed tombstone and source retirement form one transaction from
      // the caller's point of view. Once append succeeds, cancellation must
      // not prevent retirement and leave an active source behind the block.
      await this.deps.retireMemory(namespace, memoryId, {
        status: reason === "supersession" ? "superseded" : "retracted",
        ...(opts.supersededBy ? { supersededBy: opts.supersededBy } : {}),
        ...(validUntil ? { validUntil } : {}),
      }, tombstoneId === null ? abortSignal : undefined);
      results.push({
        action,
        status: "applied",
        memoryId,
        ...(tombstoneId ? { tombstoneId } : {}),
      });
      appliedTouched.push(memoryId);
    } catch (err) {
      if (abortSignal?.aborted) throw err;
      results.push({ action, status: "failed", error: errMsg(err) });
    }
  }
}

/**
 * Sanitize an error message before it lands in a CorrectionOutcome result
 * (#1678). Outcome results are surfaced to MCP/HTTP/CLI callers and may be
 * persisted in the audit memory, so they must not leak absolute filesystem
 * paths (host layout / usernames / secrets in paths) or unbounded verbosity.
 * Strip absolute paths and cap length; never reveal more than the message's
 * short-form. The original error is still thrown/logged in full internally.
 */
export const CORRECTION_ERROR_MAX = 500;
export function sanitizeErrorMessage(raw: string): string {
  // Collapse any absolute POSIX path (/Users/foo/..., /.config/..., /tmp/a@b/...) and
  // Windows path (C:\Users\...) to a neutral <path> placeholder.
  // Capture the leading delimiter (start/space/quote) in group 1 so the path
  // itself is consumed and replaced — the prior non-capturing prefix bound $1
  // to the path, which survived and had <path> appended AFTER it.
  const stripped = raw
    .replace(/(^|[\s:'"(])\/(?:[^\s'">)\\]+\/)+[^\s'">)\\]*/g, "$1<path>")
    .replace(/(^|[\s:'"(])[A-Za-z]:\\[^\s'">)\\]+(?:\\[^\s'">) ]*)*/g, "$1<path>");
  const trimmed = stripped.trim();
  return trimmed.length > CORRECTION_ERROR_MAX
    ? `${trimmed.slice(0, CORRECTION_ERROR_MAX)}…`
    : trimmed;
}

function errMsg(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return sanitizeErrorMessage(raw);
}

/**
 * correction/correction-planner.ts — read-only planner (issue #1580 PR 1).
 *
 * The planner turns a {@link CorrectionRequest} into a {@link CorrectionPlan}:
 *
 *   1. LOCATE. `targetIds` present → resolve directly (not-found → explicit
 *      error, rule 34). Else: search via the injected search path scoped to
 *      the caller's readable namespaces, plus 1-hop entity-graph neighbors of
 *      top hits. Cap candidates at `maxAffected`.
 *   2. CLASSIFY + DRAFT via one LLM call (Responses API only, gotcha 1). On
 *      LLM failure → deterministic fallback plan (rule 13): classification
 *      `outdated`, `confidence: 0`, empty actions, warning set.
 *   3. RENDER DIFF by materializing what each action would do, using the
 *      injected diff renderer (page-versioning — reuse, don't fork).
 *   4. PERSIST the plan atomically under
 *      `<memoryDir>/state/corrections/pending/<planId>.json` (rule 54). TTL
 *      default 24h; expired plans are rejected at apply with a clear error.
 *
 * The planner NEVER writes memory state — that is the executor's job. The
 * only thing it persists is the plan document itself.
 */

import { throwIfAborted } from "../abort-error.js";
import { mkdir, readFile, rename, unlink, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { serializeMutations } from "../utils/serialize-mutations.js";
import {
  CORRECTION_TEXT_MAX,
  CorrectionContractError,
  deterministicFallbackPlan,
  newPlanId,
  validateCorrectionAction,
  validateCorrectionRequest,
  validateRedactionPattern,
  type CorrectionAction,
  type CorrectionAffectedEntry,
  type CorrectionClassification,
  type CorrectionPlan,
  type CorrectionRequest,
  type MemoryDraft,
} from "./correction-contract.js";

// ---------------------------------------------------------------------------
// Injected collaborators — kept narrow so the planner is unit-testable.
// ---------------------------------------------------------------------------

/** A memory the planner located for the user. */
export interface PlannerCandidate {
  memoryId: string;
  /** Path relative to the storage dir (for diff rendering). */
  path: string;
  content: string;
  excerpt: string;
  category?: string;
  entityRef?: string;
  /** Provenance source quote (#1575), if available. */
  sourceQuote?: string;
  /** Search relevance / neighbor score, descending. */
  score: number;
}

export interface PlannerDeps {
  // readableNamespaces is passed per-call to plan() so a single planner
  // instance serves requests from callers with different read scopes.
  /**
   * Search memories for the correction text. The implementation is supplied
   * by the service and reuses the existing recall/QMD search path scoped to
   * `readableNamespaces`. Returns at most `limit` candidates.
   */
  searchCorpus(request: {
    text: string;
    namespaces: readonly string[];
    limit: number;
  }): Promise<PlannerCandidate[]>;
  /**
   * Resolve explicit `targetIds` to candidates. Not-found is an explicit
   * error (rule 34): the implementation throws with the missing id.
   */
  resolveTargets(request: {
    targetIds: readonly string[];
    namespaces: readonly string[];
  }): Promise<PlannerCandidate[]>;
  /**
   * One-hop entity-graph neighbors of the supplied candidates. Returns the
   * union (deduped by memoryId); neighbors not already in `seedIds` only.
   */
  expandNeighbors(request: {
    seedIds: readonly string[];
    namespaces: readonly string[];
    limit: number;
  }): Promise<PlannerCandidate[]>;
  /**
   * Single LLM call (Responses API). Classifies the correction and drafts
   * per-memory actions. Implementations MUST return a deterministic fallback
   * shape on LLM failure (see {@link LlmClassificationResult.fallback}) so the
   * planner never throws on an LLM outage (rule 13).
   */
  classifyAndDraft(request: {
    text: string;
    candidates: PlannerCandidate[];
  }): Promise<LlmClassificationResult>;
  /**
   * Render a human-readable diff preview for the planned actions, using
   * page-versioning snapshot/diff (reuse, don't fork). Pure — no side effects.
   */
  renderDiff(request: {
    candidates: PlannerCandidate[];
    actions: CorrectionAction[];
  }): Promise<string>;
  /** Per-namespace storage dir root (so the plan lands in the right state/). */
  storageDir(namespace: string): Promise<string>;
  /** Max affected memories per plan (issue config: default 10). */
  readonly maxAffected: number;
  /** Plan TTL in hours (issue config: default 24). */
  readonly planTtlHours: number;
  /** Injected clock for deterministic tests. */
  now(): Date;
}

/** Result of the single LLM classify+draft call. */
export interface LlmClassificationResult {
  classification: CorrectionClassification;
  confidence: number;
  /** Per-memory drafted actions (already validated by the adapter). */
  actions: CorrectionAction[];
  /** Per-memory relevance notes — why each affected memory is in the plan. */
  relevance: ReadonlyArray<{ memoryId: string; why: string }>;
  warnings: string[];
  /** True when the adapter fell back due to an LLM outage (rule 13). */
  fallback?: boolean;
}

/**
 * Placeholder substituted for the request text when persisting a never-store /
 * redaction-rule plan (#1678 thread Oid8t). Mirrors the durable-audit
 * redaction so the transient pending-plan file never holds the secret.
 */
const REDACTED_REQUEST_TEXT = "[redacted — never-store/redaction correction text withheld from the pending-plan file]";

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

export class CorrectionPlanner {
  constructor(private readonly deps: PlannerDeps) {}

  /**
   * Plan a correction. `readableNamespaces` is the AUTHORIZED read scope the
   * service resolved for this caller; the planner never trusts a caller string.
   */
  async plan(
    request: CorrectionRequest,
    readableNamespaces: readonly string[],
    opts?: { abortSignal?: AbortSignal },
  ): Promise<CorrectionPlan> {
    const abortSignal = opts?.abortSignal;
    throwIfAborted(abortSignal, "correction planning aborted");
    const cleaned = validateCorrectionRequest(request);
    if (cleaned.text.length > CORRECTION_TEXT_MAX) {
      // Defensive double-check; validateCorrectionRequest already throws.
      throw new CorrectionContractError("CorrectionRequest.text too long.");
    }

    if (cleaned.targetIds && cleaned.targetIds.length > this.deps.maxAffected) {
      throw new CorrectionContractError(
        `Correction target list (${cleaned.targetIds.length}) exceeds maxAffected (${this.deps.maxAffected}) — narrow the target set.`,
      );
    }

    const namespaces = readableNamespaces;
    if (namespaces.length === 0) {
      throw new CorrectionContractError(
        "Correction requires at least one readable namespace — principal has no read scope.",
      );
    }

    // 1. LOCATE
    const located = await this.locateCandidates(cleaned, namespaces, abortSignal);
    throwIfAborted(abortSignal, "correction planning aborted");
    if (located.candidates.length === 0) {
      // No candidates AND no explicit targets → empty plan is valid (the user
      // can still discard). But explicit-target-not-found was already raised
      // inside locateCandidates (rule 34).
      return this.persist(
        this.emptyPlan(cleaned, namespaces[0], "no matching memories found for the correction text"),
        abortSignal,
      );
    }

    // 2. CLASSIFY + DRAFT
    const llm = await this.deps.classifyAndDraft({
      text: cleaned.text,
      candidates: located.candidates,
    });
    throwIfAborted(abortSignal, "correction planning aborted");

    // Validate every action shape before persisting — the adapter is trusted
    // to validate, but a malformed action must never reach the executor
    // (defense in depth, rule 51).
    for (const action of llm.actions) {
      validateCorrectionAction(action);
      if (action.kind === "redaction_rule") {
        validateRedactionPattern(action.pattern);
      }
    }

// 3. Map actions → affected entries (only memories the planner located).
    const affected = this.deriveAffected(located.candidates, llm);

    // Bulk guard (§39): refuse past maxAffected without silent truncation.
    const touchedCount = new Set(
      llm.actions
        .map((a) =>
          a.kind === "supersede"
            ? a.loserId
            : a.kind === "edit" || a.kind === "retract" || a.kind === "rescope"
              ? a.memoryId
              : null,
        )
        .filter((id): id is string => id !== null),
    ).size;
    if (touchedCount > this.deps.maxAffected) {
      throw new CorrectionContractError(
        `Correction touches ${touchedCount} memories, exceeding the maxAffected limit of ${this.deps.maxAffected}. Narrow the correction text or supply explicit targetIds.`,
      );
    }

    // Defense in depth (review thread: reject-actions-outside-candidates):
    // an LLM that hallucinates or is prompt-injected must never target a
    // memory the planner did not locate. NOW that the bulk guard has had its
    // chance to reject over-limit plans, drop actions whose target ID is
    // absent from the candidate set and warn.
    const candidateIds = new Set(located.candidates.map((c) => c.memoryId));
    if (llm.actions.length > 0 && candidateIds.size > 0) {
      const filtered = llm.actions.filter((action) => {
        const id =
          action.kind === "supersede"
            ? action.loserId
            : action.kind === "edit" || action.kind === "retract" || action.kind === "rescope"
              ? action.memoryId
              : null;
        return id === null || candidateIds.has(id);
      });
      if (filtered.length < llm.actions.length) {
        const dropped = llm.actions.length - filtered.length;
        llm.warnings = [...llm.warnings, `${dropped} action(s) targeted memories outside the located candidate set and were dropped (prompt-injection guard).`];
        llm.actions = filtered;
      }
    }

    // 4. RENDER DIFF
    const diff = llm.fallback
      ? ""
      : await this.deps.renderDiff({ candidates: located.candidates, actions: llm.actions });
    throwIfAborted(abortSignal, "correction planning aborted");

    const createdAt = this.deps.now().toISOString();
    const expiresAt = new Date(
      this.deps.now().getTime() + this.deps.planTtlHours * 60 * 60 * 1000,
    ).toISOString();

    const plan: CorrectionPlan = llm.fallback
      ? deterministicFallbackPlan({
          request: cleaned,
          namespace: namespaces[0],
          affected,
          warnings: llm.warnings,
          createdAt,
          expiresAt,
        })
      : {
          planId: newPlanId(),
          request: cleaned,
          namespace: namespaces[0],
          affected,
          classification: llm.classification,
          actions: llm.actions,
          diff,
          confidence: clampConfidence(llm.confidence),
          warnings: llm.warnings,
          createdAt,
          expiresAt,
          status: "pending",
        };

    throwIfAborted(abortSignal, "correction planning aborted");
    return this.persist(plan, abortSignal);
  }

  private async locateCandidates(
    request: CorrectionRequest,
    namespaces: readonly string[],
    abortSignal?: AbortSignal,
  ): Promise<{ candidates: PlannerCandidate[] }> {
    if (request.targetIds && request.targetIds.length > 0) {
      const targets = await this.deps.resolveTargets({
        targetIds: request.targetIds,
        namespaces,
      });
      throwIfAborted(abortSignal, "correction planning aborted");
      // Expand 1-hop neighbors and merge (dedup by memoryId, keep highest score).
      const seedIds = targets.map((c) => c.memoryId);
      const neighbors = await this.deps.expandNeighbors({
        seedIds,
        namespaces,
        limit: this.deps.maxAffected,
      });
      throwIfAborted(abortSignal, "correction planning aborted");
      return { candidates: mergeCandidates(targets, neighbors).slice(0, this.deps.maxAffected) };
    }

    const searched = await this.deps.searchCorpus({
      text: request.text,
      namespaces,
      limit: this.deps.maxAffected,
    });
    throwIfAborted(abortSignal, "correction planning aborted");
    if (searched.length === 0) return { candidates: [] };
    const seedIds = searched.slice(0, Math.min(5, searched.length)).map((c) => c.memoryId);
    const neighbors = await this.deps.expandNeighbors({
      seedIds,
      namespaces,
      limit: this.deps.maxAffected,
    });
    throwIfAborted(abortSignal, "correction planning aborted");
    return { candidates: mergeCandidates(searched, neighbors).slice(0, this.deps.maxAffected) };
  }

  private deriveAffected(
    candidates: PlannerCandidate[],
    llm: LlmClassificationResult,
  ): CorrectionAffectedEntry[] {
    const byId = new Map(candidates.map((c) => [c.memoryId, c]));
    const out: CorrectionAffectedEntry[] = [];
    for (const rel of llm.relevance) {
      const c = byId.get(rel.memoryId);
      if (!c) continue;
      out.push({
        memoryId: c.memoryId,
        path: c.path,
        excerpt: c.excerpt,
        why: rel.why,
        ...(c.sourceQuote ? { sourceQuote: c.sourceQuote } : {}),
      });
    }
    // Include touched memories that the LLM did not annotate but whose actions
    // reference them (e.g. an `edit` drafted against a located candidate).
    const annotated = new Set(out.map((e) => e.memoryId));
    for (const action of llm.actions) {
      const id =
        action.kind === "supersede"
          ? action.loserId
          : action.kind === "edit" || action.kind === "retract" || action.kind === "rescope"
            ? action.memoryId
            : null;
      if (id && !annotated.has(id)) {
        const c = byId.get(id);
        if (c) {
          out.push({
            memoryId: c.memoryId,
            path: c.path,
            excerpt: c.excerpt,
            why: "touched by a drafted action",
            ...(c.sourceQuote ? { sourceQuote: c.sourceQuote } : {}),
          });
          annotated.add(id);
        }
      }
    }
    return out;
  }

  private emptyPlan(request: CorrectionRequest, namespace: string, warning: string): CorrectionPlan {
    const createdAt = this.deps.now().toISOString();
    const expiresAt = new Date(
      this.deps.now().getTime() + this.deps.planTtlHours * 60 * 60 * 1000,
    ).toISOString();
    return {
      planId: newPlanId(),
      request,
      namespace,
      affected: [],
      classification: "outdated",
      actions: [],
      diff: "",
      confidence: 0,
      warnings: [warning],
      createdAt,
      expiresAt,
      status: "pending",
    };
  }

  // -------------------------------------------------------------------------
  // Plan persistence — atomic write (rule 54), serialized per plan id (rule 40).
  // -------------------------------------------------------------------------

  /** Directory holding pending plans for one namespace. */
  private async pendingDir(namespace: string): Promise<string> {
    return path.join(await this.deps.storageDir(namespace), "state", "corrections", "pending");
  }

  private async persist(
    plan: CorrectionPlan,
    abortSignal?: AbortSignal,
  ): Promise<CorrectionPlan> {
    throwIfAborted(abortSignal, "correction planning aborted");
    const dir = await this.pendingDir(plan.namespace);
    throwIfAborted(abortSignal, "correction planning aborted");
    const target = path.join(dir, `${plan.planId}.json`);
    // #1678 (thread Oid8t): never-store/redaction corrections carry the very
    // secret/pattern the user asked Remnic NOT to retain. The durable audit
    // already withholds the text; the TRANSIENT pending-plan file must too,
    // or the secret sits on disk (pending until apply/discard + TTL). Redact
    // the request text in the persisted copy for never_store classifications
    // or any redaction_rule action. The in-memory plan keeps the original
    // text so the executor's audit body (which re-applies its own redaction)
    // is unaffected; only the on-disk JSON is sanitized.
    const sensitive =
      plan.classification === "never_store" ||
      plan.actions.some((a) => a.kind === "redaction_rule");
    // #1678 (threads vMLN/vZln): redact request.text (the executor does not
    // need the raw request text for redaction_rule actions). The pattern is
    // NOT redacted: the executor's apply flow reloads via loadPlan (disk) and
    // needs the real pattern to call registerRedactionRule. Redacting it would
    // register a placeholder and the extraction redaction (#1669) would never
    // block the intended content. The pattern's transient on-disk exposure is
    // bounded by the pending-plan TTL + consumed-on-apply lifecycle.
    const persistedPlan: CorrectionPlan = sensitive
      ? { ...plan, request: { ...plan.request, text: REDACTED_REQUEST_TEXT } }
      : plan;
    await serializeMutations(`correction-plan:${target}`, async () => {
      throwIfAborted(abortSignal, "correction planning aborted");
      await mkdir(dir, { recursive: true });
      const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
      throwIfAborted(abortSignal, "correction planning aborted");
      await writeFile(tmp, `${JSON.stringify(persistedPlan)}\n`, "utf-8");
      throwIfAborted(abortSignal, "correction planning aborted");
      // rename() is atomic on POSIX for same-filesystem renames (rule 54).
      await rename(tmp, target);
    });
    return plan;
  }

  /** Load a pending plan by id (used by the service / executor). */
  async loadPlan(namespace: string, planId: string): Promise<CorrectionPlan | null> {
    assertSafePlanId(planId);
    const file = path.join(await this.pendingDir(namespace), `${planId}.json`);
    return serializeMutations(`correction-plan:${file}`, async () => {
      let raw: string;
      try {
        raw = await readFile(file, "utf-8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT") return null;
        throw err;
      }
      return parsePlan(raw);
    });
  }

  /** List pending plans (newest first), excluding consumed (applied/discarded). */
  async listPending(namespace: string): Promise<CorrectionPlan[]> {
    const dir = await this.pendingDir(namespace);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return [];
      throw err;
    }
    const plans: CorrectionPlan[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      let plan: CorrectionPlan | null = null;
      try {
        plan = await this.loadPlan(namespace, f.replace(/\.json$/, ""));
      } catch {
        continue; // rule 34 — skip malformed plans with a counter (best-effort).
      }
      if (plan && plan.status === "pending") plans.push(plan);
    }
    plans.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return plans;
  }

  async markConsumed(namespace: string, planId: string, status: "applying" | "applied" | "discarded" | "partial"): Promise<void> {
    assertSafePlanId(planId);
    const file = path.join(await this.pendingDir(namespace), `${planId}.json`);
    await serializeMutations(`correction-plan:${file}`, async () => {
      let raw: string;
      try {
        raw = await readFile(file, "utf-8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT") return; // idempotent
        throw err;
      }
      const plan = parsePlan(raw);
      if (!plan) return;
      plan.status = status;
      // #1713 Item 2: stamp applyingAt when entering the applying state so
      // startup recovery can detect plans stuck mid-apply (process death).
      // Cleared on terminal transitions; harmless residue on non-applying
      // plans is ignored by the recovery scan.
      if (status === "applying") {
        plan.applyingAt = this.deps.now().toISOString();
      } else {
        delete plan.applyingAt;
      }
      // #1669 thread P1: scrub redaction_rule patterns from consumed plans so
      // a never-store pattern does not persist on disk after apply/discard.
      // The executor reloads via loadPlan only between "applying" (step 1) and
      // "applied" (step 4), so scrubbing at the terminal status is safe.
      if (status !== "applying") {
        plan.actions = plan.actions.map((a) =>
          a.kind === "redaction_rule"
            ? { ...a, pattern: "[redacted — pattern applied]" }
            : a,
        );
      }
      const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
      await writeFile(tmp, `${JSON.stringify(plan)}\n`, "utf-8");
      await rename(tmp, file);
    });
  }
  /**
   * Return an applying plan to the pending queue when cancellation arrives
   * before its first correction mutation.
   */
  async resetApplying(namespace: string, planId: string): Promise<void> {
    assertSafePlanId(planId);
    const file = path.join(await this.pendingDir(namespace), `${planId}.json`);
    await serializeMutations(`correction-plan:${file}`, async () => {
      let raw: string;
      try {
        raw = await readFile(file, "utf-8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT") return;
        throw err;
      }
      const plan = parsePlan(raw);
      if (!plan || plan.status !== "applying") return;
      plan.status = "pending";
      delete plan.applyingAt;
      const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
      await writeFile(tmp, `${JSON.stringify(plan)}\n`, "utf-8");
      await rename(tmp, file);
    });
  }

  async deletePlan(namespace: string, planId: string): Promise<void> {
    assertSafePlanId(planId);
    const file = path.join(await this.pendingDir(namespace), `${planId}.json`);
    await serializeMutations(`correction-plan:${file}`, async () => {
      try {
        await unlink(file);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT") return;
        throw err;
      }
    });
  }

  /**
   * Stale-applying TTL: a plan in `applying` state longer than this is
   * assumed to be from a crashed process and is recovered on startup
   * (#1713 Item 2). 10 minutes is generous for an apply that normally
   * completes in seconds, yet short enough to avoid leaving stale state.
   */
  static readonly STALE_APPLYING_TTL_MS = 10 * 60 * 1000;

  /**
   * Recover stale `applying` plans past the stale-applying TTL (#1713 Item 2).
   *
   * A plan stuck in `applying` means the process died mid-apply. Re-applying
   * wholesale would duplicate succeeded actions (replacements, tombstones,
   * audits), so recovery discards + scrubs the plan instead. The operator
   * inspects the outcome and files a NEW plan for any actions that did not
   * complete. Plans without `applyingAt` (predating this fix) are recovered
   * when they are past their `expiresAt` timestamp.
   *
   * @returns the ids of recovered (discarded) plans.
   */
  async recoverStaleApplyingPlans(
    namespace: string,
    opts?: { ttlMs?: number; now?: Date },
  ): Promise<string[]> {
    const ttl = opts?.ttlMs ?? CorrectionPlanner.STALE_APPLYING_TTL_MS;
    const now = (opts?.now ?? this.deps.now()).getTime();
    const dir = await this.pendingDir(namespace);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return [];
      throw err;
    }
    const recovered: string[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const planId = f.replace(/\.json$/, "");
      let plan: CorrectionPlan | null;
      try {
        plan = await this.loadPlan(namespace, planId);
      } catch {
        continue; // malformed — skip (rule 34).
      }
      if (!plan || plan.status !== "applying") continue;
      // Post-fix plans (with applyingAt): stale if the applying timestamp is
      // past the TTL (process died mid-apply). Pre-fix plans (no applyingAt):
      // stale as soon as they have expired — no additional TTL wait, since the
      // plan is already past its intended lifetime (review thread ff034716).
      const stale = plan.applyingAt
        ? now - new Date(plan.applyingAt).getTime() >= ttl
        : now >= new Date(plan.expiresAt).getTime();
      if (!stale) continue;
      try {
        await this.markConsumed(namespace, planId, "discarded");
        recovered.push(planId);
      } catch {
        // Best-effort: a single failed discard must not abort the scan.
      }
    }
    return recovered;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reject caller-supplied plan ids that would escape the pending-plan dir
 * (review thread Ug8): `correct --discard --plan-id ../../meta` must not let
 * `path.join(pendingDir, "../../meta.json")` unlink arbitrary `.json` files
 * under the storage root. A safe plan id is a bare basename with no path
 * separators and no parent-segment shape. The canonical format is
 * `corr-<base36>-<base36>` (see {@link newPlanId}); this guard accepts any
 * single-segment id so future formats need not touch it, but blocks every
 * traversal vector (`/`, `\`, `..`, leading dots, NUL).
 */
function assertSafePlanId(planId: string): void {
  if (
    typeof planId !== "string" ||
    planId.length === 0 ||
    planId.includes("/") ||
    planId.includes("\\") ||
    planId.includes("\0") ||
    planId === "." ||
    planId === ".." ||
    planId.startsWith(".") ||
    planId.includes("..")
  ) {
    throw new CorrectionContractError(
      `Invalid plan id: ${JSON.stringify(planId)} — must be a bare file basename with no path separators or parent segments.`,
    );
  }
}
function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Merge two candidate lists, deduping by memoryId and keeping the highest score. */
function mergeCandidates(a: readonly PlannerCandidate[], b: readonly PlannerCandidate[]): PlannerCandidate[] {
  const map = new Map<string, PlannerCandidate>();
  for (const c of a) {
    const existing = map.get(c.memoryId);
    if (!existing || c.score > existing.score) map.set(c.memoryId, c);
  }
  for (const c of b) {
    const existing = map.get(c.memoryId);
    if (!existing || c.score > existing.score) map.set(c.memoryId, c);
  }
  return [...map.values()].sort((x, y) => y.score - x.score);
}

/** Parse + structurally validate a plan document. Returns null on malformed. */
export function parsePlan(raw: string): CorrectionPlan | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.planId !== "string" || typeof p.namespace !== "string") return null;
  if (typeof p.createdAt !== "string" || typeof p.expiresAt !== "string") return null;
  if (!Array.isArray(p.actions) || !Array.isArray(p.affected)) return null;
  // Re-validate each action shape; a single malformed action poisons the plan.
  for (const action of p.actions as unknown[]) {
    try {
      validateCorrectionAction(action);
    } catch {
      return null;
    }
  }
  return parsed as CorrectionPlan;
}

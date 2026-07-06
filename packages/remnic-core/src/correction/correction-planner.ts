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
  ): Promise<CorrectionPlan> {
    const cleaned = validateCorrectionRequest(request);
    if (cleaned.text.length > CORRECTION_TEXT_MAX) {
      // Defensive double-check; validateCorrectionRequest already throws.
      throw new CorrectionContractError("CorrectionRequest.text too long.");
    }

    const namespaces = readableNamespaces;
    if (namespaces.length === 0) {
      throw new CorrectionContractError(
        "Correction requires at least one readable namespace — principal has no read scope.",
      );
    }

    // 1. LOCATE
    const located = await this.locateCandidates(cleaned, namespaces);
    if (located.candidates.length === 0) {
      // No candidates AND no explicit targets → empty plan is valid (the user
      // can still discard). But explicit-target-not-found was already raised
      // inside locateCandidates (rule 34).
      return this.persist(
        this.emptyPlan(cleaned, namespaces[0], "no matching memories found for the correction text"),
      );
    }

    // 2. CLASSIFY + DRAFT
    const llm = await this.deps.classifyAndDraft({
      text: cleaned.text,
      candidates: located.candidates,
    });

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

    // 4. RENDER DIFF
    const diff = llm.fallback
      ? ""
      : await this.deps.renderDiff({ candidates: located.candidates, actions: llm.actions });

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

    return this.persist(plan);
  }

  private async locateCandidates(
    request: CorrectionRequest,
    namespaces: readonly string[],
  ): Promise<{ candidates: PlannerCandidate[] }> {
    if (request.targetIds && request.targetIds.length > 0) {
      const targets = await this.deps.resolveTargets({
        targetIds: request.targetIds,
        namespaces,
      });
      // Expand 1-hop neighbors and merge (dedup by memoryId, keep highest score).
      const seedIds = targets.map((c) => c.memoryId);
      const neighbors = await this.deps.expandNeighbors({
        seedIds,
        namespaces,
        limit: this.deps.maxAffected,
      });
      return { candidates: mergeCandidates(targets, neighbors).slice(0, this.deps.maxAffected) };
    }

    const searched = await this.deps.searchCorpus({
      text: request.text,
      namespaces,
      limit: this.deps.maxAffected,
    });
    if (searched.length === 0) return { candidates: [] };
    const seedIds = searched.slice(0, Math.min(5, searched.length)).map((c) => c.memoryId);
    const neighbors = await this.deps.expandNeighbors({
      seedIds,
      namespaces,
      limit: this.deps.maxAffected,
    });
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

  private async persist(plan: CorrectionPlan): Promise<CorrectionPlan> {
    const dir = await this.pendingDir(plan.namespace);
    const target = path.join(dir, `${plan.planId}.json`);
    await serializeMutations(`correction-plan:${target}`, async () => {
      await mkdir(dir, { recursive: true });
      const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
      await writeFile(tmp, `${JSON.stringify(plan)}\n`, "utf-8");
      // rename() is atomic on POSIX for same-filesystem renames (rule 54).
      await rename(tmp, target);
    });
    return plan;
  }

  /** Load a pending plan by id (used by the service / executor). */
  async loadPlan(namespace: string, planId: string): Promise<CorrectionPlan | null> {
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

  /** Mark a plan consumed (applied / discarded / partial) — atomic rewrite. */
  async markConsumed(namespace: string, planId: string, status: "applied" | "discarded" | "partial"): Promise<void> {
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
      const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
      await writeFile(tmp, `${JSON.stringify(plan)}\n`, "utf-8");
      await rename(tmp, file);
    });
  }

  /** Delete a plan file (used by discard). Idempotent. */
  async deletePlan(namespace: string, planId: string): Promise<void> {
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

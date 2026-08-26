/**
 * Recall-miss diagnosis (issue #3033).
 *
 * `remnic xray` explains the attribution of results that WERE returned.
 * Nothing explained an absence, so an operator who expected a memory back
 * could not tell their own configuration from a product defect. This module
 * answers the other question: given a query, which pipeline stage dropped
 * the memory I expected?
 *
 * Host-agnostic and strictly READ-ONLY: it persists nothing, indexes
 * nothing, and never mutates recall behaviour. It is deliberately NOT gated
 * by `recallDirectAnswerEnabled` (which gates the xray tier-explain block) —
 * a diagnostic that only works once the feature you are diagnosing is
 * already enabled is useless.
 *
 * Reuse, never fork (AGENTS.md rule 22 / issue decision 3). The pipeline is
 * not re-implemented here. Every stage decision comes from one of exactly
 * two places:
 *
 *   1. The `RecallXraySnapshot` the REAL recall published — its
 *      `results` / `headroomResults` / `appliedResults` / `filters` /
 *      `appliedResultLimit` fields already record what each stage saw and
 *      admitted. That snapshot IS the existing stage recorder.
 *   2. The same shared predicates the pipeline itself calls, injected
 *      through {@link RecallWhyDeps} so a caller cannot accidentally supply
 *      a divergent copy: `planRecallMode`, `isGenericRecallExcludedPath`,
 *      `ACTIVE_STATUSES`, and the shared namespace resolver.
 *
 * Stage order follows the recall contract in AGENTS.md
 * ("Retrieval/Intent/Cache Guardrails" #1): candidate retrieval headroom ->
 * policy filters -> rerank/boost -> cap -> format. A memory is reported
 * against the EARLIEST stage that dropped it.
 *
 * Empty is not failed (Review Prevention Checklist #22): a search-backend
 * outage returns `{ ok: false, failure: { reason: "backend_unavailable" } }`
 * and never "0 candidates".
 */

import { ACTIVE_STATUSES } from "./contradiction/contradiction-scan.js";
import type { RecallXrayResult, RecallXraySnapshot } from "./recall-xray.js";
import type { MemoryStatus, RecallPlanMode } from "./types.js";

/**
 * Pipeline stages, in contract order. Frozen `as const` WITHOUT a
 * `readonly RecallWhyStage[]` annotation so the derived union below stays
 * narrow (Review Prevention Checklist #47).
 */
export const RECALL_WHY_STAGES = Object.freeze([
  "retrieval",
  "policy-filter",
  "rerank",
  "cap",
  "format",
] as const);

export type RecallWhyStage = (typeof RECALL_WHY_STAGES)[number];

// Pins the narrow union: an unused @ts-expect-error is itself a compile
// error, so widening RECALL_WHY_STAGES to string[] fails the build.
// @ts-expect-error "bogus" is not a RecallWhyStage
const _stageUnionIsNarrow: RecallWhyStage = "bogus";
void _stageUnionIsNarrow;

/** Why a candidate was dropped. */
export const RECALL_WHY_DROP_REASONS = Object.freeze([
  "backend-unavailable",
  "planner-mode",
  "namespace-scope",
  "path-excluded",
  "status-filter",
  "not-a-candidate",
  "score-floor",
  "cap-eviction",
] as const);

export type RecallWhyDropReason = (typeof RECALL_WHY_DROP_REASONS)[number];

// @ts-expect-error "bogus" is not a RecallWhyDropReason
const _reasonUnionIsNarrow: RecallWhyDropReason = "bogus";
void _reasonUnionIsNarrow;

/** A single dropped candidate, attributed to the stage that dropped it. */
export interface RecallWhyDrop {
  memoryId: string;
  path: string;
  reason: RecallWhyDropReason;
  /** Human-readable specifics, e.g. `status=superseded`. */
  detail: string;
}

/** What one pipeline stage saw and admitted. */
export interface RecallWhyStageRecord {
  stage: RecallWhyStage;
  /** Candidates entering the stage. Non-negative integer. */
  considered: number;
  /** Candidates leaving the stage. Non-negative integer. */
  admitted: number;
  /** Filter-ladder detail carried verbatim from the snapshot, when present. */
  reason?: string;
  drops: RecallWhyDrop[];
}

/** Verdict for the `--expect <memory-id|substring>` trace. */
export interface RecallWhyExpectation {
  /** The id or substring the caller asked about, exactly as supplied. */
  expect: string;
  /** True when a stored memory matched `expect`. */
  matched: boolean;
  memoryId?: string;
  path?: string;
  /** True when the memory survived to the injected set. */
  recalled: boolean;
  /** Stage that dropped it. Absent when `recalled` is true. */
  stage?: RecallWhyStage;
  reason?: RecallWhyDropReason;
  detail?: string;
  /** One-line operator remediation. Absent when `recalled` is true. */
  remediation?: string;
}

/** The diagnosis. Rendered identically by CLI, HTTP, and MCP. */
export interface RecallWhyReport {
  /** Stable v1 tag so downstream parsers can version-gate. */
  schemaVersion: "1";
  query: string;
  namespace?: string;
  plannerMode: RecallPlanMode;
  /**
   * False ONLY when the diagnosis itself could not run because the search
   * backend was unavailable. An honest empty pipeline is `ok: true`.
   */
  ok: boolean;
  failure?: { reason: "backend_unavailable"; detail: string };
  recallNamespaces: string[];
  /** Final user-facing cap the recall applied. Non-negative integer. */
  appliedResultLimit: number;
  stages: RecallWhyStageRecord[];
  /** Memory ids that survived every stage. */
  recalledMemoryIds: string[];
  expectation?: RecallWhyExpectation;
}

/**
 * Outcome of replaying the real recall. `ok: false` is reserved for a
 * search backend that could not answer — never for an honest empty
 * result (Review Prevention Checklist #22).
 */
export type RecallWhyRecallOutcome =
  | { ok: true; snapshot: RecallXraySnapshot | null }
  | { ok: false; reason: "backend_unavailable"; detail: string };

/** The stored memory a caller's `--expect` resolved to. */
export interface RecallWhyMemoryRef {
  memoryId: string;
  path: string;
  status: MemoryStatus;
  namespace: string;
}

/**
 * Injected pipeline access. Every member is either the real recall or a
 * predicate the real pipeline itself calls — never a reimplementation.
 */
export interface RecallWhyDeps {
  /** Runs the REAL recall with X-ray capture and reports backend faults. */
  runRecall(
    query: string,
    options: { sessionKey?: string; namespace?: string; abortSignal?: AbortSignal },
  ): Promise<RecallWhyRecallOutcome>;
  /** `planRecallMode` from `intent.ts` — the planner the pipeline uses. */
  plannerMode(query: string): RecallPlanMode;
  /**
   * Namespaces this caller reads, resolved through the SAME shared
   * resolver the recall path uses (rule 30). Used when the recall did
   * not record its own scope.
   */
  scopedNamespaces: readonly string[];
  namespacesEnabled: boolean;
  /** `isGenericRecallExcludedPath` bound to the live config. */
  isExcludedPath(path: string): boolean;
  /** Read-only lookup by exact memory id, else by id/path substring. */
  findExpected(expect: string): Promise<RecallWhyMemoryRef | null>;
}

export interface RecallWhyOptions {
  deps: RecallWhyDeps;
  /** Memory id or substring to trace through every stage. */
  expect?: string;
  sessionKey?: string;
  namespace?: string;
  abortSignal?: AbortSignal;
}

/** Thrown for caller-input faults so surfaces can map them to a 400. */
export class RecallWhyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecallWhyInputError";
  }
}

const REMEDIATION: Record<RecallWhyDropReason, string> = {
  "backend-unavailable":
    "The search backend did not answer. Check that the index daemon is running and reachable; this is an outage, not an empty result.",
  "planner-mode":
    "The planner classified this prompt as not needing recall. Pass an explicit recall mode, or rephrase the prompt so it reads as a memory request.",
  "namespace-scope":
    "The memory lives outside the namespaces this recall reads. Query its namespace explicitly, or grant the caller read access to it.",
  "path-excluded":
    "The path is served by a dedicated surface and is excluded from generic recall by design. Read it through that surface instead.",
  "status-filter":
    "Only active memories are injected. Reactivate the memory, or read it through an explicit search or archive surface.",
  "not-a-candidate":
    "The memory exists on disk but retrieval never saw it — the search index is stale for this path. Reindex, then retry.",
  "score-floor":
    "The candidate scored below the relevance floor. Use wording closer to the stored memory, or widen the retrieval budget.",
  "cap-eviction":
    "The candidate survived filtering but was cut by the final result cap. Raise the recall budget or narrow the query.",
};

/**
 * Diagnose why a query did not surface an expected memory.
 *
 * Runs the real recall once, then attributes the outcome to stages. When
 * `expect` is supplied, traces that one memory and names the exact stage
 * that dropped it plus a remediation hint.
 */
export async function explainRecallMiss(
  query: string,
  opts: RecallWhyOptions,
): Promise<RecallWhyReport> {
  // Validate the EXACT value — never normalize first (checklist #45). A
  // whitespace-only query is a caller fault, not an empty query.
  if (typeof query !== "string" || query.length === 0 || query.trim().length === 0) {
    throw new RecallWhyInputError("recallWhy: query is required and must be non-empty");
  }
  const expect = opts.expect;
  if (
    expect !== undefined &&
    (typeof expect !== "string" || expect.length === 0 || expect.trim().length === 0)
  ) {
    throw new RecallWhyInputError("recallWhy: expect must be a non-empty string when supplied");
  }
  const deps = opts.deps;
  const plannerMode = deps.plannerMode(query);
  const scopedNamespaces = [...deps.scopedNamespaces];

  const outcome = await deps.runRecall(query, {
    ...(opts.sessionKey !== undefined ? { sessionKey: opts.sessionKey } : {}),
    ...(opts.namespace !== undefined ? { namespace: opts.namespace } : {}),
    ...(opts.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
  });

  if (!outcome.ok) {
    // Empty != failed. The retrieval stage reports the outage; no stage
    // downstream of it ran, so none is reported as having seen zero.
    return {
      schemaVersion: "1",
      query,
      ...(opts.namespace !== undefined ? { namespace: opts.namespace } : {}),
      plannerMode,
      ok: false,
      failure: { reason: "backend_unavailable", detail: outcome.detail },
      recallNamespaces: scopedNamespaces,
      appliedResultLimit: 0,
      stages: [
        {
          stage: "retrieval",
          considered: 0,
          admitted: 0,
          reason: `backend_unavailable: ${outcome.detail}`,
          drops: [],
        },
      ],
      recalledMemoryIds: [],
      ...(expect !== undefined
        ? {
            expectation: {
              expect,
              matched: false,
              recalled: false,
              stage: "retrieval" as const,
              reason: "backend-unavailable" as const,
              detail: outcome.detail,
              remediation: REMEDIATION["backend-unavailable"],
            },
          }
        : {}),
    };
  }

  const snapshot = outcome.snapshot;
  const stages = buildStages(snapshot, plannerMode);
  const recalledMemoryIds = (snapshot?.appliedResults ?? []).map((r) => r.memoryId);
  const expectation =
    expect === undefined
      ? undefined
      : await traceExpectation(expect, snapshot, plannerMode, deps, scopedNamespaces);

  return {
    schemaVersion: "1",
    query,
    ...(snapshot?.namespace !== undefined
      ? { namespace: snapshot.namespace }
      : opts.namespace !== undefined
        ? { namespace: opts.namespace }
        : {}),
    plannerMode,
    ok: true,
    recallNamespaces: scopedNamespaces,
    appliedResultLimit: nonNegativeInt(snapshot?.appliedResultLimit),
    stages,
    recalledMemoryIds,
    ...(expectation !== undefined ? { expectation } : {}),
  };
}

// ─── Stage attribution ────────────────────────────────────────────────────

/**
 * Retrieval-stage note per planner mode. `full` and `graph_mode` run the
 * ordinary pipeline and carry no note.
 */
const PLANNER_MODE_NOTE: Partial<Record<RecallPlanMode, string>> = {
  no_recall: "planner mode no_recall: retrieval never ran",
  minimal: "planner mode minimal: retrieval headroom is capped",
};

function buildStages(
  snapshot: RecallXraySnapshot | null,
  plannerMode: RecallPlanMode,
): RecallWhyStageRecord[] {
  if (snapshot === null) {
    // No snapshot published: either the planner short-circuited recall or
    // retrieval produced nothing to capture. Both are honest zero-candidate
    // states, distinct from the backend-outage branch above.
    return [
      {
        stage: "retrieval",
        considered: 0,
        admitted: 0,
        reason: PLANNER_MODE_NOTE[plannerMode]
          ?? "no candidates were captured for this query",
        drops: [],
      },
    ];
  }

  const captured = snapshot.results;
  const rejected = captured.filter((r) => nonEmpty(r.rejectedBy) !== undefined);
  const admittedByPolicy = captured.length - rejected.length;
  const headroom = snapshot.headroomResults;
  const applied = snapshot.appliedResults;
  const appliedIds = new Set(applied.map((r) => r.memoryId));
  const evicted = headroom.filter((r) => !appliedIds.has(r.memoryId));

  const filterLadder = snapshot.filters
    .map((f) => `${f.name}: ${f.admitted}/${f.considered}${f.reason ? ` (${f.reason})` : ""}`)
    .join("; ");

  return [
    {
      stage: "retrieval",
      considered: captured.length,
      admitted: captured.length,
      // Both stage paths annotate the retrieval row from the SAME table, so
      // a planner mode can never be reported on one path and dropped on the
      // other. Modes with no note omit the key rather than setting it to
      // undefined, keeping the JSON shape byte-stable.
      ...(PLANNER_MODE_NOTE[plannerMode] !== undefined
        ? { reason: PLANNER_MODE_NOTE[plannerMode] }
        : {}),
      drops: [],
    },
    {
      stage: "policy-filter",
      considered: captured.length,
      admitted: admittedByPolicy,
      ...(filterLadder.length > 0 ? { reason: filterLadder } : {}),
      drops: sortDrops(
        rejected.map((r) => ({
          memoryId: r.memoryId,
          path: r.path,
          reason: policyReasonFor(nonEmpty(r.rejectedBy) ?? ""),
          detail: `rejectedBy=${nonEmpty(r.rejectedBy) ?? "unknown"}`,
        })),
      ),
    },
    {
      stage: "rerank",
      considered: admittedByPolicy,
      admitted: headroom.length,
      drops: [],
    },
    {
      stage: "cap",
      considered: headroom.length,
      admitted: applied.length,
      reason: `appliedResultLimit=${nonNegativeInt(snapshot.appliedResultLimit)}`,
      drops: sortDrops(
        evicted.map((r) => ({
          memoryId: r.memoryId,
          path: r.path,
          reason: "cap-eviction" as const,
          detail: `cut by appliedResultLimit=${nonNegativeInt(snapshot.appliedResultLimit)}`,
        })),
      ),
    },
    {
      stage: "format",
      considered: applied.length,
      admitted: applied.length,
      reason: `budget used ${nonNegativeInt(snapshot.budget.used)}/${nonNegativeInt(snapshot.budget.chars)} chars`,
      drops: [],
    },
  ];
}

/**
 * Map a filter name the pipeline recorded in `rejectedBy` onto a drop
 * reason. Unknown filter names stay `score-floor`-free and report as
 * `path-excluded`-free too: they fall back to `not-a-candidate` only when
 * nothing matches, so a new pipeline filter can never be silently
 * mis-attributed to an existing reason.
 */
function policyReasonFor(rejectedBy: string): RecallWhyDropReason {
  const name = rejectedBy.toLowerCase();
  if (name.includes("namespace")) return "namespace-scope";
  if (name.includes("status") || name.includes("superseded") || name.includes("quarantine")) {
    return "status-filter";
  }
  if (name.includes("path") || name.includes("artifact") || name.includes("excluded")) {
    return "path-excluded";
  }
  if (name.includes("score") || name.includes("floor") || name.includes("threshold")) {
    return "score-floor";
  }
  return "not-a-candidate";
}

// ─── --expect trace ───────────────────────────────────────────────────────

async function traceExpectation(
  expect: string,
  snapshot: RecallXraySnapshot | null,
  plannerMode: RecallPlanMode,
  deps: RecallWhyDeps,
  /** Effective recall scope: what the pipeline recorded, else the caller's. */
  recallNamespaces: readonly string[],
): Promise<RecallWhyExpectation> {
  const ref = await deps.findExpected(expect);
  if (ref === null) {
    return {
      expect,
      matched: false,
      recalled: false,
      stage: "retrieval",
      reason: "not-a-candidate",
      detail: "no stored memory matches this id or substring",
      remediation:
        "Nothing on disk matches. Check the id or substring; the memory may never have been written.",
    };
  }

  const base = { expect, matched: true, memoryId: ref.memoryId, path: ref.path };

  if (snapshot !== null) {
    // The snapshot is authoritative about what actually happened, so it is
    // consulted before any predicate is re-evaluated.
    if (snapshot.appliedResults.some((r) => matchesRef(r, ref))) {
      return { ...base, recalled: true };
    }
    const rejectedRow = snapshot.results.find(
      (r) => matchesRef(r, ref) && nonEmpty(r.rejectedBy) !== undefined,
    );
    if (rejectedRow !== undefined) {
      const rejectedBy = nonEmpty(rejectedRow.rejectedBy) ?? "unknown";
      const reason = policyReasonFor(rejectedBy);
      return {
        ...base,
        recalled: false,
        stage: "policy-filter",
        reason,
        detail: `rejectedBy=${rejectedBy}`,
        remediation: REMEDIATION[reason],
      };
    }
    if (
      snapshot.headroomResults.some((r) => matchesRef(r, ref)) ||
      snapshot.results.some((r) => matchesRef(r, ref))
    ) {
      return {
        ...base,
        recalled: false,
        stage: "cap",
        reason: "cap-eviction",
        detail: `survived filtering but was cut by appliedResultLimit=${nonNegativeInt(snapshot.appliedResultLimit)}`,
        remediation: REMEDIATION["cap-eviction"],
      };
    }
  }

  // The memory never reached the capture. Attribute it to the earliest
  // stage whose own predicate rejects it, in contract order: the planner
  // gates retrieval, then the policy filters run namespace -> path ->
  // status (the order `filterRecallCandidates` and the state-view
  // admission apply them in).
  if (plannerMode === "no_recall") {
    return {
      ...base,
      recalled: false,
      stage: "retrieval",
      reason: "planner-mode",
      detail: "plannerMode=no_recall: retrieval never ran for this query",
      remediation: REMEDIATION["planner-mode"],
    };
  }
  if (deps.namespacesEnabled && !recallNamespaces.includes(ref.namespace)) {
    return {
      ...base,
      recalled: false,
      stage: "policy-filter",
      reason: "namespace-scope",
      detail: `namespace=${ref.namespace} is outside the recall scope [${recallNamespaces.join(", ")}]`,
      remediation: REMEDIATION["namespace-scope"],
    };
  }
  if (deps.isExcludedPath(ref.path)) {
    return {
      ...base,
      recalled: false,
      stage: "policy-filter",
      reason: "path-excluded",
      detail: `path=${ref.path} is excluded from generic recall`,
      remediation: REMEDIATION["path-excluded"],
    };
  }
  if (!ACTIVE_STATUSES.has(ref.status)) {
    return {
      ...base,
      recalled: false,
      stage: "policy-filter",
      reason: "status-filter",
      detail: `status=${ref.status}`,
      remediation: REMEDIATION["status-filter"],
    };
  }
  if (plannerMode === "minimal") {
    return {
      ...base,
      recalled: false,
      stage: "retrieval",
      reason: "planner-mode",
      detail: "plannerMode=minimal: retrieval headroom is capped for this query",
      remediation: REMEDIATION["planner-mode"],
    };
  }
  return {
    ...base,
    recalled: false,
    stage: "retrieval",
    reason: "not-a-candidate",
    detail: "the memory passes every policy filter but retrieval never returned it",
    remediation: REMEDIATION["not-a-candidate"],
  };
}

// ─── Internals ────────────────────────────────────────────────────────────

function matchesRef(result: RecallXrayResult, ref: RecallWhyMemoryRef): boolean {
  return result.memoryId === ref.memoryId || result.path === ref.path;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > 0 ? value : undefined;
}

function nonNegativeInt(value: unknown): number {
  // Reject non-finite explicitly rather than letting NaN fall through a
  // comparison (checklist #45).
  if (typeof value !== "number") return 0;
  if (!Number.isFinite(value)) return 0;
  const floored = Math.floor(value);
  return floored > 0 ? floored : 0;
}

/** Total comparator: -1 / 0 / 1, and 0 for genuinely equal rows. */
function sortDrops(drops: RecallWhyDrop[]): RecallWhyDrop[] {
  return [...drops].sort((a, b) => {
    if (a.memoryId !== b.memoryId) return a.memoryId < b.memoryId ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return 0;
  });
}

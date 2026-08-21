/**
 * Issue #560 PR 3 — Memory Worth outcome signal pipeline.
 *
 * PR 1 added `mw_success` / `mw_fail` fields to MemoryFrontmatter. PR 2 added
 * a pure scoring helper. This module adds the one piece tying the two
 * together: a way for callers to record a single outcome observation against
 * a memory, which increments the appropriate counter in frontmatter.
 *
 * The public entry point is `recordMemoryOutcome({ memoryPath, outcome, ... })`.
 * Callers pass the full path to the memory file (not just the ID) because in
 * the usual outcome source — the observation ledger — the memory path is
 * already captured in the event payload, and path-based lookup avoids a
 * full-corpus scan.
 *
 * Intentional properties:
 *   - Works on a per-memory basis (no bulk API in this slice). Bulk update is
 *     an easy layer on top of this once a second caller needs it.
 *   - Reuses the existing `updateMemoryFrontmatter(id, patch)` write path so
 *     unrelated fields (confidence, importance, lifecycle hooks, etc.) are
 *     preserved. The PR 1 serializer rejects negative / non-integer counters,
 *     so we rely on that for defensive validation rather than duplicating it.
 *   - Only instruments categories in `MEMORY_WORTH_OUTCOME_ELIGIBLE_CATEGORIES`
 *     (currently `fact` and `procedure` — procedures joined in issue #2370 —
 *     matching `MEMORY_WORTH_ELIGIBLE_CATEGORIES` in operator-toolkit.ts for
 *     the doctor audit). Non-eligible memories return
 *     `{ ok: false, reason: "ineligible_category" }` rather than throwing so
 *     the caller — typically a ledger consumer draining heterogeneous events
 *     — doesn't need to pre-filter by category.
 *   - Missing / unknown memory IDs return `{ ok: false, reason: "not_found" }`
 *     rather than throwing, because outcome events may reference memories
 *     that were archived/deleted between the session and the ledger drain.
 *     That isn't an operator-actionable error.
 *   - On success, returns the new counter values so observability surfaces
 *     can report the increment without a second read.
 *
 * Out of scope (later PRs):
 *   - Recall filter reading the counters (PR 4).
 *   - Benchmark + default flip (PR 5).
 *   - Automatic increments from extraction or summarization. Only the
 *     explicit `MEM_OUTCOME` ledger tag or an MCP tool call drives writes.
 */

import path from "node:path";

import type { StorageManager } from "./storage.js";
import type { MemoryFrontmatter } from "./types.js";

/**
 * Per-memory-ID serialization of the read-modify-write increment.
 *
 * Codex P1: without this, concurrent calls for the same memory race. Both
 * callers read the same `mw_*` values, each writes +1, and one increment
 * is lost — silently undercounting outcomes. We chain an async promise
 * per memory ID so read-then-write is atomic with respect to other calls
 * into this module.
 *
 * This serializes only THIS module. Direct writers (e.g. hand-rolled
 * frontmatter patches) still bypass the lock, but the documented surface
 * for Memory Worth increments is this function, and the bench only uses
 * this path.
 *
 * The lock map is WeakRef-free by design: the chain self-cleans once the
 * last pending write resolves (we delete the entry inside the `.finally`
 * of the tail), so memory use stays bounded even for long-running
 * processes that touch many different memory IDs.
 */
const outcomeLocks = new Map<string, Promise<unknown>>();

function runSerialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = outcomeLocks.get(key) ?? Promise.resolve();
  // Swallow upstream errors so a failed outcome for memory A doesn't
  // permanently poison the chain for memory A. We still propagate our own
  // result/errors to the caller.
  const next = prev.catch(() => undefined).then(task);
  outcomeLocks.set(key, next);
  // Chain the cleanup off `next` BUT attach a `.catch` so the cleanup
  // promise itself never surfaces as an unhandled rejection. The caller
  // gets `next` back and handles it their own way; this detached cleanup
  // chain has no observer, so without the .catch Node would crash the
  // process on a task rejection even when the caller awaited `next` and
  // handled the error correctly.
  next
    .then(
      () => {
        if (outcomeLocks.get(key) === next) outcomeLocks.delete(key);
      },
      () => {
        if (outcomeLocks.get(key) === next) outcomeLocks.delete(key);
      }
    )
    .catch(() => {
      // Defensive no-op in case a hook inside the cleanup branches throws.
    });
  return next;
}

/**
 * Categories currently instrumented for Memory Worth counters. `procedure`
 * joined in issue #2370 — the procedure library-health maintenance loop
 * retires on failure-dominant `mw_*` counters, so injected procedures must
 * be able to accrue outcomes. Must be kept in sync with
 * `MEMORY_WORTH_ELIGIBLE_CATEGORIES` in `operator-toolkit.ts`. Declared
 * here (not imported) to avoid a circular dep with operator-toolkit, which
 * imports from this file's peers. The two constants are validated by a
 * test to stay in lockstep.
 */
const MEMORY_WORTH_OUTCOME_ELIGIBLE_CATEGORIES: ReadonlySet<MemoryFrontmatter["category"]> = new Set([
  "fact",
  "procedure",
]);

/**
 * Exported so downstream tests / operators can query the allowlist without
 * re-declaring it. Returned as a frozen copy so consumers cannot mutate the
 * module-internal set.
 */
export function memoryWorthOutcomeEligibleCategories(): ReadonlySet<MemoryFrontmatter["category"]> {
  return new Set(MEMORY_WORTH_OUTCOME_ELIGIBLE_CATEGORIES);
}

/**
 * The direction of an outcome — whether the session that consumed this
 * memory succeeded or failed. Restricted to a string literal union so
 * callers in TypeScript land can't pass arbitrary tags.
 */
export type MemoryOutcomeKind = "success" | "failure";

/**
 * Arguments to `recordMemoryOutcome`.
 *
 * `memoryPath` is the filesystem path to the memory; we derive the ID from
 * the basename, matching how the operator-toolkit and recall layers map
 * paths to IDs.
 */
export interface RecordMemoryOutcomeInput {
  /**
   * Absolute or repo-relative path to the memory file. Typically the value
   * of `MemoryFile.path` for a memory returned by `readAllMemories`.
   */
  memoryPath: string;
  /** Outcome direction — "success" bumps mw_success; "failure" bumps mw_fail. */
  outcome: MemoryOutcomeKind;
  /**
   * Optional observation timestamp for audit / telemetry. This PR doesn't
   * persist the timestamp (PR 4/5 will use `lastAccessed`, which already
   * covers the recency-decay requirement), but accepting it here keeps the
   * call shape stable so future ledger integrations don't need a breaking
   * change.
   */
  timestamp?: Date | string;
}

/**
 * Outcome of a `recordMemoryOutcome` call.
 *
 * `ok: true` means the counter was incremented and flushed. The returned
 * values reflect the post-increment state, so callers can log
 * `"fact-xyz: 4/1 → 5/1"` without re-reading.
 *
 * `ok: false` carries a short machine-readable `reason` so a ledger drainer
 * can aggregate metrics ("how many events hit not_found this hour?"). The
 * human-readable `message` is a friendlier version for logs.
 */
export type RecordMemoryOutcomeResult =
  | {
      ok: true;
      memoryId: string;
      /** New value of `mw_success` after the increment. */
      mw_success: number;
      /** New value of `mw_fail` after the increment. */
      mw_fail: number;
    }
  | {
      ok: false;
      reason: "not_found" | "ineligible_category" | "invalid_outcome" | "invalid_path";
      message: string;
    };

/**
 * Extract the memory ID from a file path. Memory files are stored as
 * `<id>.md`, matching the rest of the system (see `getMemoryById`, which
 * infers paths from IDs).
 *
 * Returns `null` for any path that does not end in `.md`. The check is
 * unconditional — `path.basename` strips directory components before the
 * suffix check, so previous conditional logic silently accepted
 * directory-prefixed paths like `/tmp/facts/2026-01-01/not-a-memory`
 * (the basename `not-a-memory` is not equal to the input, so the `.md`
 * guard was skipped). The new check looks at the raw input once.
 */
function memoryIdFromPath(memoryPath: string): string | null {
  if (!memoryPath || typeof memoryPath !== "string") return null;
  if (!memoryPath.endsWith(".md")) return null;
  const basename = path.basename(memoryPath, ".md");
  if (!basename) return null;
  return basename;
}

/**
 * Record a single outcome observation against a memory. Increments
 * `mw_success` or `mw_fail` on the memory's frontmatter (preserving all
 * other fields) via the existing `updateMemoryFrontmatter` write path.
 *
 * See the top-of-file doc comment for policy details (eligible categories,
 * error semantics, and what is intentionally out of scope).
 */
export async function recordMemoryOutcome(
  storage: StorageManager,
  input: RecordMemoryOutcomeInput
): Promise<RecordMemoryOutcomeResult> {
  if (input.outcome !== "success" && input.outcome !== "failure") {
    return {
      ok: false,
      reason: "invalid_outcome",
      message: `outcome must be "success" or "failure"; got ${JSON.stringify(input.outcome)}`,
    };
  }

  const memoryId = memoryIdFromPath(input.memoryPath);
  if (memoryId === null) {
    return {
      ok: false,
      reason: "invalid_path",
      message: `memoryPath must end in .md; got ${JSON.stringify(input.memoryPath)}`,
    };
  }

  // Serialize the read-modify-write per memory ID so concurrent callers
  // (parallel ledger drain, multiple MCP clients, etc.) can't each read
  // the same snapshot and race to write `+1`, losing an increment.
  return runSerialized(memoryId, async () => {
    const memory = await storage.getMemoryById(memoryId);
    if (!memory) {
      return {
        ok: false,
        reason: "not_found",
        message: `no memory with id ${memoryId}`,
      };
    }

    if (!MEMORY_WORTH_OUTCOME_ELIGIBLE_CATEGORIES.has(memory.frontmatter.category)) {
      return {
        ok: false,
        reason: "ineligible_category",
        message: `category ${memory.frontmatter.category} is not instrumented for Memory Worth`,
      };
    }

    // Absent counters are treated as 0 (matching the PR 1 semantics — legacy
    // memories implicitly have Beta(1,1) priors). Increments land on the
    // actual counter regardless of whether the field was previously set.
    const currentSuccess = memory.frontmatter.mw_success ?? 0;
    const currentFail = memory.frontmatter.mw_fail ?? 0;

    const nextSuccess = input.outcome === "success" ? currentSuccess + 1 : currentSuccess;
    const nextFail = input.outcome === "failure" ? currentFail + 1 : currentFail;

    // `updateMemoryFrontmatter` goes through `writeMemoryFrontmatter`, which
    // routes through the PR 1 serializer — so a stored corrupt value (e.g., a
    // pre-existing float) would be rejected here. That is intentional: we
    // refuse to layer a fresh increment on top of garbage. Operators should
    // use `remnic doctor` to find and fix those rows before PR 4 ships.
    //
    // `updateMemoryFrontmatter` returns `false` when the memory is no
    // longer present (archived / deleted between `getMemoryById` and the
    // write). Surface that as `not_found` so callers see an honest result
    // — silently returning `ok: true` with a counter that never landed
    // would skew downstream worth scoring.
    const updated = await storage.updateMemoryFrontmatter(memoryId, {
      mw_success: nextSuccess,
      mw_fail: nextFail,
    });
    if (!updated) {
      return {
        ok: false,
        reason: "not_found",
        message: `memory ${memoryId} disappeared between read and write`,
      };
    }

    return {
      ok: true,
      memoryId,
      mw_success: nextSuccess,
      mw_fail: nextFail,
    };
  });
}

// ---------------------------------------------------------------------------
// Issue #2345 — pure outcome-observation view (no writes, no counter changes)
// ---------------------------------------------------------------------------

/**
 * A Memory Worth outcome that carries WHEN it was observed and WHAT it can
 * join to — the facts the trajectory evaluator needs and plain counter rows
 * lack. `mw_success` / `mw_fail` totals have no timestamp or join ID, so they
 * cannot participate in delayed action-to-outcome joins.
 */
export interface MemoryOutcomeObservation {
  schemaVersion: 1;
  memoryId: string;
  namespace: string;
  outcome: MemoryOutcomeKind;
  observedAt: string;
  /** Stable join key shared with the action side (never free text). */
  joinId?: string;
  sessionKey?: string;
}

/**
 * Discriminated view over outcome facts a caller can supply.
 *
 * - `missing_observation` — counter-only or incomplete rows. The evaluator
 *   must never guess the action behind an aggregate counter, so these stay
 *   visible as missing rather than being inferred.
 */
export type MemoryOutcomeObservationView =
  | { status: "observed"; observation: MemoryOutcomeObservation }
  | { status: "missing_observation"; memoryId: string; reason: "missing_observed_at" | "missing_join_data" };

const OBSERVATION_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Build the pure observation view. Accepts exactly what a caller already
 * knows; performs no storage reads and no writes, and does not alter the
 * counter path — `recordMemoryOutcome` keeps its current behavior.
 */
export function toMemoryOutcomeObservation(raw: {
  memoryId: string;
  namespace: string;
  outcome: MemoryOutcomeKind;
  observedAt?: unknown;
  joinId?: unknown;
  sessionKey?: unknown;
}): MemoryOutcomeObservationView {
  if (
    typeof raw.memoryId !== "string" ||
    raw.memoryId.length === 0 ||
    typeof raw.namespace !== "string" ||
    raw.namespace.length === 0 ||
    (raw.outcome !== "success" && raw.outcome !== "failure")
  ) {
    throw new Error("toMemoryOutcomeObservation requires memoryId, namespace, and outcome");
  }
  const observedAt =
    typeof raw.observedAt === "string" && OBSERVATION_ISO_RE.test(raw.observedAt)
      ? raw.observedAt
      : raw.observedAt instanceof Date
        ? raw.observedAt.toISOString()
        : null;
  if (observedAt === null) {
    return { status: "missing_observation", memoryId: raw.memoryId, reason: "missing_observed_at" };
  }
  const joinId = typeof raw.joinId === "string" && raw.joinId.length > 0 ? raw.joinId : undefined;
  const sessionKey = typeof raw.sessionKey === "string" && raw.sessionKey.length > 0 ? raw.sessionKey : undefined;
  if (joinId === undefined && sessionKey === undefined) {
    return { status: "missing_observation", memoryId: raw.memoryId, reason: "missing_join_data" };
  }
  return {
    status: "observed",
    observation: {
      schemaVersion: 1,
      memoryId: raw.memoryId,
      namespace: raw.namespace,
      outcome: raw.outcome,
      observedAt,
      joinId,
      sessionKey,
    },
  };
}

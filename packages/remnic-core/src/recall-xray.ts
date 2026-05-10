/**
 * Recall X-ray snapshot schema (issue #570, PR 1).
 *
 * The X-ray surface is the unified, per-result attribution document that
 * merges the tier that served each memory, its score decomposition, any
 * graph path, an audit entry id, and the exact filter/eligibility ladder
 * that either admitted or rejected each candidate.  This file defines the
 * schema and an in-memory builder + builder-state helper.
 *
 * Scope for PR 1 (this slice):
 *   - Types only + pure builder functions (no IO, no rendering).
 *   - Orchestrator plumbing captures a snapshot when the caller passes
 *     `xrayCapture: true`.  No behavior change when the flag is absent.
 *   - NO new public surfaces here — CLI/HTTP/MCP land in later slices.
 *
 * The shared renderer lands in PR 2 at `recall-xray-renderer.ts`.  Do not
 * fork formatting logic into other surfaces; extend the renderer.
 */

import { randomUUID } from "node:crypto";

import {
  normalizeRetrievedMemoryProvenance,
  type RetrievedMemoryProvenance,
} from "./memory-provenance.js";
import type { RecallDisclosure, RecallTierExplain } from "./types.js";
import { isRecallDisclosure } from "./types.js";

/**
 * Estimate token cost of a payload at the rough ~4 chars/token English
 * heuristic.  Non-negative integer; returns 0 for empty / null input.
 * Used by recall surfaces to attach `estimatedTokens` to X-ray results
 * (issue #677 PR 3/4).  Identical to the private heuristic in
 * `chunking.ts`; kept self-contained here so X-ray callers don't pull
 * in chunking internals.
 */
export function estimateRecallTokens(text: string | null | undefined): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Aggregated per-disclosure token spend summary, computed by the
 * renderer from a snapshot's results.  Non-negative integers.
 */
export interface RecallXrayDisclosureSummary {
  chunk: { count: number; estimatedTokens: number };
  section: { count: number; estimatedTokens: number };
  raw: { count: number; estimatedTokens: number };
  /** Number of results without a recorded disclosure level. */
  unspecified: { count: number; estimatedTokens: number };
}

/**
 * Which retrieval source produced a given result.  This is the X-ray
 * tier ladder called out in issue #570 and is *distinct* from the
 * `RetrievalTier` enum (which describes issue #518's tier-explain
 * block).  Keeping the sets separate lets the two observability
 * surfaces evolve without conflating their vocabularies:
 *
 *   - `RetrievalTier`     — direct-answer eligibility ladder.
 *   - `RecallXrayServedBy` — which source materialized each result.
 */
export type RecallXrayServedBy =
  | "direct-answer"
  | "hybrid"
  | "graph"
  | "recent-scan"
  | "procedural"
  | "review-context"
  | "lcm-file-parts"
  | "lcm-tool-parts";

export const RECALL_XRAY_SERVED_BY_VALUES: readonly RecallXrayServedBy[] = [
  "direct-answer",
  "hybrid",
  "graph",
  "recent-scan",
  "procedural",
  "review-context",
  "lcm-file-parts",
  "lcm-tool-parts",
] as const;

export function isRecallXrayServedBy(
  value: unknown,
): value is RecallXrayServedBy {
  return (
    typeof value === "string" &&
    (RECALL_XRAY_SERVED_BY_VALUES as readonly string[]).includes(value)
  );
}

/**
 * Score decomposition for a single X-ray result.
 *
 * All fields are optional because different tiers populate different
 * terms: `hybrid` reports vector + bm25 + mmr penalty, `direct-answer`
 * reports importance + tier prior, etc.  The only guaranteed field is
 * `final`, which is the post-combination score used for ordering.
 */
export interface RecallXrayScoreDecomposition {
  vector?: number;
  bm25?: number;
  importance?: number;
  mmrPenalty?: number;
  tierPrior?: number;
  /** Additive boost from `reinforcement_count` frontmatter (issue #687 PR 3/4). */
  reinforcementBoost?: number;
  final: number;
}

/**
 * Per-result breakdown inside an X-ray snapshot.
 */
export interface RecallXrayResult {
  memoryId: string;
  path: string;
  servedBy: RecallXrayServedBy;
  scoreDecomposition: RecallXrayScoreDecomposition;
  graphPath?: string[];
  /**
   * Issue #681 PR 3/3 — per-edge confidence values aligned with
   * `graphPath`. When present, `graphEdgeConfidences[i]` is the
   * confidence of the edge between `graphPath[i]` and `graphPath[i+1]`,
   * so the array length is one less than `graphPath`. Legacy edges
   * without a recorded confidence render as `1.0`. Operators use this
   * to attribute floor-pruning and PageRank ranking decisions back to
   * specific edges. The renderer drops the line when the array is
   * empty or absent so legacy snapshots round-trip cleanly.
   */
  graphEdgeConfidences?: number[];
  auditEntryId?: string;
  /** Human-readable list of filters the candidate *passed*. */
  admittedBy: string[];
  /**
   * First filter that *would have* rejected the candidate, or undefined
   * when the candidate was admitted without a rejection trace.  When
   * present, `admittedBy` may still contain filters the candidate passed
   * before the rejecting gate; consumers should render both.
   */
  rejectedBy?: string;
  /**
   * Disclosure depth used to render this result's payload (issue #677
   * PR 3/4).  Mirrors the per-result disclosure already exposed in the
   * recall response so X-ray consumers can attribute token spend to
   * the depth that produced it.
   */
  disclosure?: RecallDisclosure;
  /**
   * Estimated token cost of the rendered payload at the chosen
   * disclosure depth.  Non-negative integer.  Computed by callers via
   * `estimateRecallTokens(text)`; the renderer aggregates these into
   * a per-disclosure summary so operators can see where their budget
   * went.
   */
  estimatedTokens?: number;
  /**
   * Free-form tags from the memory's YAML frontmatter (issue #689 PR 3/3).
   * Populated by the X-ray capture path when the caller passes a `tags`
   * filter so per-result tags are available alongside the filter trace
   * in `snapshot.filters`.  Also populated without a filter when the
   * orchestrator decorates results via `xrayCapture: true` so all X-ray
   * consumers can inspect memory labels without a separate storage read.
   * Absent (not `[]`) when the frontmatter has no tags or the memory
   * could not be read.
   */
  tags?: string[];
  /**
   * Per-result memory provenance and safety context. Populated by recall
   * capture when the memory frontmatter was already loaded by retrieval.
   */
  provenance?: RetrievedMemoryProvenance;
}

/**
 * Trace entry for a filter the orchestrator evaluated during recall.
 * Captures the name of the filter, how many candidates it saw, and how
 * many it let through.  Used by X-ray consumers to render the filter
 * ladder above the per-result breakdown.
 */
export interface RecallFilterTrace {
  name: string;
  considered: number;
  admitted: number;
  /** Optional human-readable reason for any rejections. */
  reason?: string;
}

/**
 * Peer-profile injection annotation (issue #679 completion).
 *
 * When `peerProfileRecallEnabled` is true and a peer is registered for
 * the session, the orchestrator injects a `## Peer Profile` section into
 * the recall context. This annotation records which peer was injected and
 * how many profile fields were included so operators can correlate
 * retrieval quality with peer-context enrichment.
 *
 * `null` means no peer profile was injected (peer not registered, feature
 * disabled, or peer has no profile fields).
 */
export interface RecallXrayPeerProfileInjection {
  /** The peer id whose profile was injected. */
  peerId: string;
  /**
   * Number of profile fields included after the `peerProfileRecallMaxFields`
   * cap was applied.  Zero means the profile existed but had no fields.
   */
  fieldsInjected: number;
}

/**
 * The unified X-ray snapshot.  CLI, HTTP, and MCP surfaces all render
 * this same shape through the shared renderer (CLAUDE.md rule 22).
 */
export interface RecallXraySnapshot {
  /** Stable v1 tag so downstream consumers can version-gate their parsers. */
  schemaVersion: "1";
  query: string;
  /** UUID minted per capture; unique across snapshots within a process. */
  snapshotId: string;
  /** Epoch milliseconds the snapshot was captured. */
  capturedAt: number;
  /**
   * Tier-explain block from issue #518, carried verbatim when present.
   * `null` means direct-answer tier did not run (disabled, or another
   * tier served the query).
   */
  tierExplain: RecallTierExplain | null;
  results: RecallXrayResult[];
  filters: RecallFilterTrace[];
  /**
   * Character budget accounting for the final assembled recall payload.
   * `used` is the rendered-context length; `chars` is the cap.  Both are
   * non-negative integers in `[0, 2**31)`.
   */
  budget: { chars: number; used: number };
  /** Optional session-scope fields carried for downstream filtering. */
  sessionKey?: string;
  namespace?: string;
  traceId?: string;
  /**
   * Peer-profile injection metadata (issue #679 completion).
   * Non-null when `peerProfileRecallEnabled` is true and a peer profile
   * was successfully injected into this recall's context. `null` (or
   * absent) means no peer profile was injected.
   */
  peerProfileInjection?: RecallXrayPeerProfileInjection | null;
}

// ─── Builder ──────────────────────────────────────────────────────────────

export interface BuildXraySnapshotInput {
  query: string;
  tierExplain?: RecallTierExplain | null;
  results?: RecallXrayResult[];
  filters?: RecallFilterTrace[];
  budget?: { chars?: number; used?: number };
  sessionKey?: string;
  namespace?: string;
  traceId?: string;
  /** Peer-profile injection metadata (issue #679 completion). */
  peerProfileInjection?: RecallXrayPeerProfileInjection | null;
  /** Optional injected timestamp for deterministic tests. */
  now?: () => number;
  /** Optional injected id generator for deterministic tests. */
  snapshotIdGenerator?: () => string;
}

/**
 * Build a `RecallXraySnapshot` from explicit input fields.  Pure
 * function; safe to call from anywhere.  All array/object inputs are
 * shallow-copied so caller mutation after build cannot tear the
 * returned snapshot.
 */
export function buildXraySnapshot(
  input: BuildXraySnapshotInput,
): RecallXraySnapshot {
  const now = input.now ?? Date.now;
  const snapshotIdGenerator = input.snapshotIdGenerator ?? randomUUID;

  const results = Array.isArray(input.results)
    ? input.results.map(cloneResult)
    : [];
  const filters = Array.isArray(input.filters)
    ? input.filters.map(cloneFilter)
    : [];

  const budgetChars = nonNegativeInt(input.budget?.chars);
  const budgetUsed = nonNegativeInt(input.budget?.used);

  const tierExplain =
    input.tierExplain && typeof input.tierExplain === "object"
      ? cloneTierExplain(input.tierExplain)
      : null;

  // Peer-profile injection annotation (issue #679 completion).
  // Deep-copy via structuredClone so the caller can't mutate the snapshot
  // after build. Accept null explicitly (no injection) or a valid object.
  let peerProfileInjection: RecallXrayPeerProfileInjection | null | undefined;
  if (input.peerProfileInjection && typeof input.peerProfileInjection === "object") {
    const raw = input.peerProfileInjection;
    const peerId = nonEmptyString(raw.peerId);
    if (peerId !== undefined) {
      peerProfileInjection = {
        peerId,
        fieldsInjected: nonNegativeInt(raw.fieldsInjected),
      };
    }
  } else if (input.peerProfileInjection === null) {
    peerProfileInjection = null;
  }

  const out: RecallXraySnapshot = {
    schemaVersion: "1",
    query: typeof input.query === "string" ? input.query : "",
    snapshotId: snapshotIdGenerator(),
    capturedAt: now(),
    tierExplain,
    results,
    filters,
    budget: { chars: budgetChars, used: budgetUsed },
    sessionKey: nonEmptyString(input.sessionKey),
    namespace: nonEmptyString(input.namespace),
    traceId: nonEmptyString(input.traceId),
  };
  if (peerProfileInjection !== undefined) {
    out.peerProfileInjection = peerProfileInjection;
  }
  return out;
}

/**
 * Mutable builder used by the orchestrator to accumulate X-ray fields
 * as recall progresses.  Call `build()` to get the finalized
 * immutable-ish snapshot.  All inputs are validated at insert time so
 * a malformed entry cannot poison the snapshot later.
 */
export class RecallXrayBuilder {
  private readonly query: string;
  private readonly sessionKey: string | undefined;
  private namespace: string | undefined;
  private traceId: string | undefined;
  private tierExplain: RecallTierExplain | null = null;
  private readonly results: RecallXrayResult[] = [];
  private readonly filters: RecallFilterTrace[] = [];
  private budgetChars = 0;
  private budgetUsed = 0;
  private peerProfileInjection: RecallXrayPeerProfileInjection | null | undefined;

  constructor(opts: {
    query: string;
    sessionKey?: string;
    namespace?: string;
    traceId?: string;
  }) {
    this.query = typeof opts.query === "string" ? opts.query : "";
    this.sessionKey = nonEmptyString(opts.sessionKey);
    this.namespace = nonEmptyString(opts.namespace);
    this.traceId = nonEmptyString(opts.traceId);
  }

  setNamespace(namespace: string | undefined): void {
    this.namespace = nonEmptyString(namespace);
  }

  setTraceId(traceId: string | undefined): void {
    this.traceId = nonEmptyString(traceId);
  }

  setTierExplain(tierExplain: RecallTierExplain | null | undefined): void {
    this.tierExplain =
      tierExplain && typeof tierExplain === "object"
        ? cloneTierExplain(tierExplain)
        : null;
  }

  setBudget(budget: { chars?: number; used?: number }): void {
    this.budgetChars = nonNegativeInt(budget.chars);
    this.budgetUsed = nonNegativeInt(budget.used);
  }

  /**
   * Record peer-profile injection metadata for this recall snapshot
   * (issue #679 completion). Pass `null` to explicitly record that no
   * injection happened (feature enabled but no peer / no profile fields).
   */
  setPeerProfileInjection(
    injection: RecallXrayPeerProfileInjection | null,
  ): void {
    this.peerProfileInjection = injection;
  }

  recordResult(result: RecallXrayResult): void {
    this.results.push(cloneResult(result));
  }

  recordFilter(filter: RecallFilterTrace): void {
    this.filters.push(cloneFilter(filter));
  }

  build(opts: {
    now?: () => number;
    snapshotIdGenerator?: () => string;
  } = {}): RecallXraySnapshot {
    return buildXraySnapshot({
      query: this.query,
      tierExplain: this.tierExplain,
      results: this.results,
      filters: this.filters,
      budget: { chars: this.budgetChars, used: this.budgetUsed },
      sessionKey: this.sessionKey,
      namespace: this.namespace,
      traceId: this.traceId,
      peerProfileInjection: this.peerProfileInjection,
      now: opts.now,
      snapshotIdGenerator: opts.snapshotIdGenerator,
    });
  }
}

// ─── Internals ────────────────────────────────────────────────────────────

function cloneResult(result: RecallXrayResult): RecallXrayResult {
  if (!result || typeof result !== "object") {
    throw new TypeError("RecallXrayResult must be an object");
  }
  if (!isRecallXrayServedBy(result.servedBy)) {
    throw new TypeError(
      `RecallXrayResult.servedBy must be one of ${RECALL_XRAY_SERVED_BY_VALUES.join(
        ", ",
      )}; got ${JSON.stringify(result.servedBy)}`,
    );
  }
  const memoryId = typeof result.memoryId === "string" ? result.memoryId : "";
  const path = typeof result.path === "string" ? result.path : "";
  const admittedBy = Array.isArray(result.admittedBy)
    ? result.admittedBy.filter((x): x is string => typeof x === "string")
    : [];
  const graphPath = Array.isArray(result.graphPath)
    ? result.graphPath.filter((x): x is string => typeof x === "string")
    : undefined;
  // Issue #681 PR 3/3 — per-edge confidences alongside graph path.
  // Each entry is clamped into [0, 1]; the array is rejected wholesale
  // when alignment cannot be verified so downstream surfaces can rely
  // on `graphEdgeConfidences[i]` describing the edge between
  // `graphPath[i]` and `graphPath[i+1]`.
  //
  // Cursor review (#735): the input array length MUST match
  // `graphPath.length - 1` *before* any per-element filtering. The
  // earlier implementation skipped non-finite entries via `continue`
  // and then length-checked the cleaned array — that would silently
  // shift surviving values to earlier positions. Example: input
  // `[0.5, NaN, 0.7]` for a 3-edge path would collapse to
  // `[0.5, 0.7]`, length-check would pass against `expected = 2`, and
  // the renderer would mis-attribute `0.7` to edge B→C when it really
  // came from edge C→D. Reject on either size mismatch or any
  // non-finite entry so misalignment is impossible.
  let graphEdgeConfidences: number[] | undefined;
  if (Array.isArray(result.graphEdgeConfidences) && graphPath && graphPath.length > 1) {
    const expected = graphPath.length - 1;
    const raw = result.graphEdgeConfidences;
    if (raw.length === expected) {
      const cleaned: number[] = [];
      let allFinite = true;
      for (const value of raw) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          allFinite = false;
          break;
        }
        cleaned.push(Math.min(1, Math.max(0, value)));
      }
      if (allFinite) {
        graphEdgeConfidences = cleaned;
      }
    }
  }
  const auditEntryId = nonEmptyString(result.auditEntryId);
  const rejectedBy = nonEmptyString(result.rejectedBy);
  const scoreDecomposition = cloneScoreDecomposition(result.scoreDecomposition);
  const out: RecallXrayResult = {
    memoryId,
    path,
    servedBy: result.servedBy,
    scoreDecomposition,
    admittedBy,
  };
  if (graphPath !== undefined) out.graphPath = graphPath;
  if (graphEdgeConfidences !== undefined) {
    out.graphEdgeConfidences = graphEdgeConfidences;
  }
  if (auditEntryId !== undefined) out.auditEntryId = auditEntryId;
  if (rejectedBy !== undefined) out.rejectedBy = rejectedBy;
  // Disclosure + token telemetry (issue #677 PR 3/4).  Only attach when
  // present and well-formed; unknown disclosure values are dropped so a
  // bad caller can't poison downstream renderers.  Uses the shared
  // `isRecallDisclosure` guard so adding a fourth disclosure level
  // requires touching only `types.ts`.
  if (isRecallDisclosure(result.disclosure)) {
    out.disclosure = result.disclosure;
  }
  if (
    typeof result.estimatedTokens === "number" &&
    Number.isFinite(result.estimatedTokens) &&
    result.estimatedTokens >= 0
  ) {
    out.estimatedTokens = Math.floor(result.estimatedTokens);
  }
  // Tags from frontmatter (issue #689 PR 3/3).  Normalize identically to
  // the recall-surface path: trim and drop empty strings so consumers can
  // compare tags directly without a secondary normalization step.
  if (Array.isArray(result.tags)) {
    const cleanedTags = result.tags
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (cleanedTags.length > 0) {
      out.tags = cleanedTags;
    }
  }
  const provenance = normalizeRetrievedMemoryProvenance(result.provenance);
  if (provenance !== undefined) {
    out.provenance = provenance;
  }
  return out;
}

/**
 * Summarize per-disclosure token spend across an X-ray snapshot's
 * results.  Pure helper — used by the markdown renderer to print a
 * "per-disclosure token spend" line and exposed for tests / surfaces.
 */
export function summarizeDisclosureTokens(
  results: ReadonlyArray<RecallXrayResult>,
): RecallXrayDisclosureSummary {
  const summary: RecallXrayDisclosureSummary = {
    chunk: { count: 0, estimatedTokens: 0 },
    section: { count: 0, estimatedTokens: 0 },
    raw: { count: 0, estimatedTokens: 0 },
    unspecified: { count: 0, estimatedTokens: 0 },
  };
  for (const result of results) {
    const tokens =
      typeof result.estimatedTokens === "number" &&
      Number.isFinite(result.estimatedTokens) &&
      result.estimatedTokens >= 0
        ? Math.floor(result.estimatedTokens)
        : 0;
    const bucket = isRecallDisclosure(result.disclosure)
      ? result.disclosure
      : "unspecified";
    summary[bucket].count += 1;
    summary[bucket].estimatedTokens += tokens;
  }
  return summary;
}

function cloneFilter(filter: RecallFilterTrace): RecallFilterTrace {
  if (!filter || typeof filter !== "object") {
    throw new TypeError("RecallFilterTrace must be an object");
  }
  const out: RecallFilterTrace = {
    name: typeof filter.name === "string" ? filter.name : "",
    considered: nonNegativeInt(filter.considered),
    admitted: nonNegativeInt(filter.admitted),
  };
  const reason = nonEmptyString(filter.reason);
  if (reason !== undefined) out.reason = reason;
  return out;
}

function cloneScoreDecomposition(
  value: RecallXrayScoreDecomposition | undefined,
): RecallXrayScoreDecomposition {
  if (!value || typeof value !== "object") {
    return { final: 0 };
  }
  const out: RecallXrayScoreDecomposition = {
    final: finiteNumber(value.final) ?? 0,
  };
  const vector = finiteNumber(value.vector);
  if (vector !== undefined) out.vector = vector;
  const bm25 = finiteNumber(value.bm25);
  if (bm25 !== undefined) out.bm25 = bm25;
  const importance = finiteNumber(value.importance);
  if (importance !== undefined) out.importance = importance;
  const mmrPenalty = finiteNumber(value.mmrPenalty);
  if (mmrPenalty !== undefined) out.mmrPenalty = mmrPenalty;
  const tierPrior = finiteNumber(value.tierPrior);
  if (tierPrior !== undefined) out.tierPrior = tierPrior;
  const reinforcementBoost = finiteNumber(value.reinforcementBoost);
  if (reinforcementBoost !== undefined && reinforcementBoost > 0) {
    out.reinforcementBoost = reinforcementBoost;
  }
  return out;
}

function cloneTierExplain(tierExplain: RecallTierExplain): RecallTierExplain {
  // Use structuredClone so future RecallTierExplain additions do not
  // silently share references through hand-enumerated fields.  The
  // payload is JSON-shaped.
  return structuredClone(tierExplain);
}

function nonNegativeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  return Math.floor(value);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}

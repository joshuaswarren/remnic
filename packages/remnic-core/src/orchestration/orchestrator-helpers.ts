/**
 * Orchestrator module-level helpers — relocated from orchestrator.ts
 * (issue #1526, seam 25).
 *
 * Pure functions, types, and constants that previously lived at module
 * level in orchestrator.ts: recall-mode planning, recall snapshots and
 * parsers, abort/race helpers, artifact recall limits, replay
 * source-time slicing, day-summary date utilities, and QMD startup
 * checks. orchestrator.ts re-exports the previously-public names so
 * every existing importer (coordinators, tests, root shims) keeps
 * working unchanged.
 *
 * Behavior-preserving move — no logic changes.
 */

import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { abortError as sharedAbortError, throwIfAborted as sharedThrowIfAborted } from "../abort-error.js";
import type { CapabilitySet } from "../capabilities.js";
import { buildCompressionGuidelinesMarkdown as buildCompressionGuidelinesMarkdownV2 } from "../compression-optimizer.js";
import { FallbackLlmClient } from "../fallback-llm.js";
import { hasBroadGraphIntent, planRecallMode } from "../intent.js";
import { resolveLifecycleState } from "../lifecycle.js";
import { log } from "../logger.js";
import type { GraphRecallRankedResult, GraphRecallShadowComparison } from "./graph-recall-coordinator.js";
import { parseQmdExplain } from "../qmd.js";
import type { GraphRecallExpandedEntry } from "../recall-state.js";
import type { RecallXrayServedBy } from "../recall-xray.js";
import { type BufferTurn, type MemoryActionEvent, type MemoryFile, type MemoryFrontmatter, type MemoryIntent, type PluginConfig, type QmdSearchResult, type RecallPlanMode, confidenceTier } from "../types.js";
import { categoryDirName } from "../utils/category-dir.js";
import { parseFlexibleIsoTimestamp } from "../utils/iso-timestamp.js";

export interface BulkImportBatchIngestResult {
  attemptedTurnCount: number;
  extractionCount: number;
  persistedCount: number;
  durableOutputCount: number;
  skippedCount: number;
  failedCount: number;
  postPersistMetadataFailureCount: number;
  processedTurnCount: number;
}

export class BulkImportBatchPartialFailureError extends Error {
  readonly partialResult: BulkImportBatchIngestResult;

  readonly originalError: unknown;

  constructor(
    message: string,
    partialResult: BulkImportBatchIngestResult,
    originalError: unknown,
  ) {
    super(message);
    this.name = "BulkImportBatchPartialFailureError";
    this.partialResult = partialResult;
    this.originalError = originalError;
  }
}

export interface GraphRecallSnapshot {
  recordedAt: string;
  mode: RecallPlanMode | string;
  queryHash: string;
  queryLength: number;
  namespaces: string[];
  seedCount: number;
  expandedCount: number;
  seeds: string[];
  expanded: GraphRecallExpandedEntry[];
  status?: "completed" | "skipped" | "aborted";
  reason?: string;
  shadowMode?: boolean;
  queryIntent?: MemoryIntent;
  seedResults?: GraphRecallRankedResult[];
  finalResults?: GraphRecallRankedResult[];
  shadowComparison?: GraphRecallShadowComparison;
}

export interface IntentDebugSnapshot {
  recordedAt: string;
  promptHash: string;
  promptLength: number;
  retrievalQueryHash: string;
  retrievalQueryLength: number;
  plannerEnabled: boolean;
  plannedMode: RecallPlanMode;
  effectiveMode: RecallPlanMode;
  recallResultLimit: number;
  queryIntent: MemoryIntent;
  graphExpandedIntentDetected: boolean;
  graphDecision: {
    status: "not_requested" | "skipped" | "completed" | "aborted";
    reason?: string;
    shadowMode: boolean;
    qmdAvailable: boolean;
    graphRecallEnabled: boolean;
    multiGraphMemoryEnabled: boolean;
  };
}

export interface QmdRecallSnapshot {
  recordedAt: string;
  queryHash: string;
  queryLength: number;
  collection?: string;
  namespaces: string[];
  fetchLimit: number;
  primaryResultCount: number;
  hybridResultCount: number;
  queryAwareSeedCount: number;
  resultCount: number;
  intentHint?: string;
  explainEnabled: boolean;
  hybridTopUpUsed: boolean;
  hybridTopUpSkippedReason?: string;
  results: QmdSearchResult[];
}

export interface RecallModeDecision {
  plannedMode: RecallPlanMode;
  effectiveMode: RecallPlanMode;
  graphExpandedIntentDetected: boolean;
  graphReason?: string;
  /**
   * Where `plannedMode` came from (issue #1367 / Option C). `"heuristic"` for
   * the regex planner; `"llm"` when the LLM planner classified it; and
   * `"heuristic-fallback"` when the LLM was enabled but errored/timed out and we
   * fell back. Absent on the synchronous heuristic-only path.
   */
  plannerSource?: "heuristic" | "llm" | "heuristic-fallback";
  /** Short rationale from the planner (for telemetry / x-ray). */
  plannerReason?: string;
  /** Wall-clock spent in the LLM planner call, when one was made. */
  plannerLatencyMs?: number;
  /** True when the LLM planner was enabled but fell back to the heuristic. */
  plannerFallbackUsed?: boolean;
  /** Model that served the LLM classification, when one was used. */
  plannerModelUsed?: string;
  /**
   * The regex-heuristic baseline mode, captured whenever the LLM planner ran
   * (any source). Lets operators compare planned-vs-heuristic during rollout —
   * distinct from `plannedMode`, which on the LLM path is the LLM's choice.
   */
  plannerHeuristicMode?: RecallPlanMode;
  /**
   * In shadow mode, the mode the LLM *would* have chosen (recorded for
   * comparison) while `effectiveMode` stays on the heuristic decision.
   */
  shadowLlmMode?: RecallPlanMode;
}

/**
 * Map the orchestrator's internal `recallSource` strings to the
 * X-ray `servedBy` vocabulary (issue #570 PR 1).  The X-ray tier
 * ladder intentionally flattens QMD / embedding / cold-fallback to
 * the `hybrid` tier because they all materialize through the same
 * hybrid BM25+vector pipeline from the caller's perspective.  The
 * `recent_scan` path gets its own dedicated tier because it bypasses
 * the hybrid pipeline entirely.  `none` is treated as `hybrid` on the
 * theory that a query that returned nothing still routed through the
 * hybrid pipeline — but callers should normally gate capture on
 * `recalledMemoryIds.length > 0`.
 */
export function mapRecallSourceToXrayServedBy(
  source:
    | "none"
    | "hot_qmd"
    | "hot_embedding"
    | "cold_fallback"
    | "recent_scan",
): RecallXrayServedBy {
  // Exhaustive switch: every current union member is explicitly
  // listed so TypeScript surfaces a compile error if a new source is
  // added without a deliberate mapping.  The `never`-typed fallthrough
  // keeps the function total at runtime — if the caller passes an
  // unexpected value that slipped past the type system (e.g. a JSON
  // deserialization), we still fall back to `hybrid`.
  switch (source) {
    case "recent_scan":
      return "recent-scan";
    case "hot_qmd":
    case "hot_embedding":
    case "cold_fallback":
    case "none":
      return "hybrid";
  }
  const _exhaustive: never = source;
  void _exhaustive;
  return "hybrid";
}

export interface RecallInvocationOptions {
  namespace?: string;
  topK?: number;
  mode?: RecallPlanMode;
  abortSignal?: AbortSignal;
  /**
   * Capture a `RecallXraySnapshot` for this recall (issue #570).  When
   * `true`, the orchestrator builds a snapshot from the data it has
   * already gathered and stashes it in memory, accessible via
   * `getLastXraySnapshot()`.  When `false` or absent, nothing is
   * captured and recall behavior is unchanged (schema-only slice).
   */
  xrayCapture?: boolean;
  /**
   * Per-invocation override for `recallBudgetChars` (issue #570 PR 3/4).
   * Flows through `getRecallBudgetChars()` for this recall only — no
   * shared config mutation, so concurrent recalls on the same
   * orchestrator are not affected (CLAUDE.md rule 47: no shared
   * mutable state across async boundaries).  Must be a non-negative
   * finite integer; non-conforming values are ignored and the
   * configured budget is used.
   */
  budgetCharsOverride?: number;
  /**
   * Per-invocation principal override (issue #570 PR 4).  When set,
   * the orchestrator uses this principal for ACL / namespace checks
   * instead of `resolvePrincipal(sessionKey, config)`.  This is the
   * escape hatch for access surfaces (HTTP / MCP) that have already
   * authenticated the caller upstream — threading an unmapped
   * principal through the session-key-based resolver would otherwise
   * collapse it to `"default"` and produce false denials in
   * namespace-enabled deployments (CLAUDE.md rule 42).
   */
  principalOverride?: string;
  /**
   * Historical recall point (issue #680).  When set, the orchestrator
   * filters out memories whose `valid_at` is after this timestamp OR
   * whose `invalid_at` is at-or-before this timestamp, so callers see
   * the corpus as it existed at `asOf`.  ISO 8601 string; comparisons
   * use `Date.parse()` so timezone-aware values round-trip correctly
   * (CLAUDE.md gotcha — never compare ISO strings lexicographically).
   * Invalid values must be rejected at input boundaries (CLAUDE.md
   * rule 51); the orchestrator does NOT silently fall back here.
   */
  asOf?: string;
  /**
   * Issue #681 — when `true`, bypasses `graphTraversalConfidenceFloor`
   * and includes edges below the floor in graph traversal.  Useful for
   * diagnostic recall queries that need to surface results that would
   * normally be pruned by confidence decay.  Default `false`.
   */
  includeLowConfidence?: boolean;
  /**
   * User-aware context scopes active for this recall. Used by X-ray
   * provenance safety checks so boundary-scoped memories are evaluated
   * against the caller's real context.
   */
  currentContextScopes?: readonly unknown[];
  /**
   * Wall-clock ms the caller waited to begin execution — per-principal
   * semaphore queue + single-flight wait (issue #1906). Folded into
   * recall-timings additively as `queueWaitMs`; omitted phases are simply
   * absent, so existing timing consumers are unaffected.
   */
  queueWaitMs?: number;
}

export type QueryAwarePrefilter = {
  candidatePaths: Set<string> | null;
  temporalFromDate: string | null;
  matchedTags: string[];
  expandedTags: string[];
  combination: "none" | "temporal" | "tag" | "intersection" | "union";
  filteredToFullSearch: boolean;
};

// Recall-specific abort helpers.  Thin wrappers over the shared
// `abort-error.ts` module so every abort in the codebase shares the
// same `name === "AbortError"` classification contract (`isAbortError`
// works uniformly).  We keep the "recall aborted" default message for
// back-compat with call-site logs; callers that pass an explicit
// message (e.g. "extraction aborted (before_extract)") are unaffected.
export const abortRecallError = sharedAbortError;

export function throwIfRecallAborted(
  signal?: AbortSignal,
  message = "recall aborted",
): void {
  sharedThrowIfAborted(signal, message);
}

export async function raceRecallAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  message = "recall aborted",
): Promise<T> {
  throwIfRecallAborted(signal, message);
  if (!signal) return promise;

  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<T>((_resolve, reject) => {
    onAbort = () => reject(abortRecallError(message));
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/** Maximum age (ms) before a compaction-reset signal file is considered stale and removed. */
export const COMPACTION_SIGNAL_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

export const DEFAULT_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS = 10_000;

export type DaySummaryGatherOptions = {
  timeZone?: string;
  now?: Date;
};

export function normalizeIanaTimeZone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: trimmed });
    return trimmed;
  } catch {
    return undefined;
  }
}

export function formatDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function utcDateKeysAround(date: Date): string[] {
  const dayMs = 86_400_000;
  const keys = [
    utcDateKey(new Date(date.getTime() - dayMs)),
    utcDateKey(date),
    utcDateKey(new Date(date.getTime() + dayMs)),
  ];
  return keys.filter((value, index, array) => array.indexOf(value) === index);
}

export function utcDateKeysForLocalDay(date: Date, timeZone: string): string[] {
  const targetLocalDate = formatDateInTimeZone(date, timeZone);
  const keys = new Set<string>();
  const hourMs = 3_600_000;
  const scanStart = date.getTime() - 48 * hourMs;
  const scanEnd = date.getTime() + 48 * hourMs;
  for (let ms = scanStart; ms <= scanEnd; ms += hourMs) {
    const candidate = new Date(ms);
    if (formatDateInTimeZone(candidate, timeZone) === targetLocalDate) {
      keys.add(utcDateKey(candidate));
    }
  }
  return keys.size > 0 ? [...keys].sort() : utcDateKeysAround(date);
}

export function parseFiniteDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function filterHourlySummaryMarkdownForLocalDay(
  raw: string,
  utcDate: string,
  timeZone: string,
  targetLocalDate: string,
): string | null {
  const hourHeaderPattern = /^## ([01]\d|2[0-3]):00[ \t]*$/gm;
  const matches = Array.from(raw.matchAll(hourHeaderPattern));
  if (matches.length === 0) return null;

  const firstSectionStart = matches[0]?.index ?? 0;
  const preamble = raw.slice(0, firstSectionStart).trim();
  const sections: string[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const hour = match[1];
    if (!hour) continue;
    const sectionTimestamp = parseFiniteDate(`${utcDate}T${hour}:00:00.000Z`);
    if (
      !sectionTimestamp ||
      formatDateInTimeZone(sectionTimestamp, timeZone) !== targetLocalDate
    ) {
      continue;
    }
    const sectionStart = match.index ?? 0;
    const sectionEnd = matches[index + 1]?.index ?? raw.length;
    const section = raw.slice(sectionStart, sectionEnd).trim();
    if (section.length > 0) sections.push(section);
  }

  if (sections.length === 0) return null;
  return [preamble, ...sections]
    .filter((section) => section.length > 0)
    .join("\n\n");
}

export type SearchCollectionState = "present" | "missing" | "unknown" | "skipped";

export function qmdStartupCollectionCheckTimeoutMs(): number {
  const raw =
    process.env.REMNIC_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS ??
    process.env.ENGRAM_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1_000
    ? Math.floor(parsed)
    : DEFAULT_QMD_STARTUP_COLLECTION_CHECK_TIMEOUT_MS;
}

export async function qmdStartupCollectionCheckWithTimeout(
  promise: Promise<SearchCollectionState>,
  controller: AbortController,
  label: string,
): Promise<SearchCollectionState> {
  const timeoutMs = qmdStartupCollectionCheckTimeoutMs();
  let timer: NodeJS.Timeout | undefined;
  let settled = false;

  const timeoutPromise = new Promise<SearchCollectionState>((resolve) => {
    timer = setTimeout(() => {
      if (settled) return;
      controller.abort();
      log.warn(
        `QMD startup collection check for ${label} timed out after ${timeoutMs}ms; keeping search enabled fail-open`,
      );
      resolve("unknown");
    }, timeoutMs);
    timer.unref?.();
  });

  const checkedPromise = promise
    .catch((err): SearchCollectionState => {
      log.warn(
        `QMD startup collection check for ${label} failed; keeping search enabled fail-open: ${err}`,
      );
      return "unknown";
    })
    .finally(() => {
      settled = true;
      if (timer) clearTimeout(timer);
    });

  return await Promise.race([checkedPromise, timeoutPromise]);
}

/** Default workspace directory when no per-agent or config workspace is available. */
export function defaultWorkspaceDir(): string {
  return path.join(os.homedir(), ".openclaw", "workspace");
}

/**
 * Produce a collision-resistant, filesystem-safe identifier from a session key.
 *
 * Session keys follow colon-delimited forms (e.g., `agent:gpucodebot:main`).
 * A naive replace (`:` → `_`) is lossy: different keys like `agent:alpha` and
 * `agent/alpha` would collide. Instead we append a short SHA-256 hash of the
 * original key to the human-readable sanitized prefix, guaranteeing uniqueness
 * while keeping filenames debuggable.
 *
 * Format: `<sanitized>-<12-char-hex-hash>`
 * Example: `agent:gpucodebot:main` → `agent_gpucodebot_main-a1b2c3d4e5f6`
 */
export function sanitizeSessionKeyForFilename(sessionKey: string): string {
  const readable = sessionKey.replace(/[^a-zA-Z0-9._-]/g, "_");
  const hash = createHash("sha256")
    .update(sessionKey)
    .digest("hex")
    .slice(0, 12);
  return `${readable}-${hash}`;
}

export function sourceValidAtMs(turn: BufferTurn): number | null {
  if (typeof turn.sourceValidAt !== "string") return null;
  return parseFlexibleIsoTimestamp(turn.sourceValidAt.trim());
}

export const SOURCE_VALID_AT_CONTEXT_TURNS = 2;

export function sourceValidAtSliceKey(turn: BufferTurn, index: number): string {
  const validAtMs = sourceValidAtMs(turn);
  return validAtMs === null ? `unknown:${index}` : String(validAtMs);
}

export function asExtractionContextTurn(turn: BufferTurn): BufferTurn {
  return { ...turn, extractionContextOnly: true };
}

export function asExtractionTargetTurn(turn: BufferTurn): BufferTurn {
  const { extractionContextOnly: _contextOnly, ...targetTurn } = turn;
  return targetTurn;
}

export function sourceValidAtContextTurns(
  turns: readonly BufferTurn[],
  targetStart: number,
  targetEnd: number,
  targetValidAtMs: number | null,
): BufferTurn[] {
  if (targetValidAtMs === null) return [];
  return turns
    .flatMap((turn, index) => {
      if (index >= targetStart && index < targetEnd) return [];
      const contextValidAtMs = sourceValidAtMs(turn);
      if (contextValidAtMs === null || contextValidAtMs > targetValidAtMs) {
        return [];
      }
      return [{ turn, index, validAtMs: contextValidAtMs }];
    })
    .sort((a, b) => {
      if (a.validAtMs < b.validAtMs) return -1;
      if (a.validAtMs > b.validAtMs) return 1;
      if (a.index === b.index) return 0;
      return a.index < b.index ? -1 : 1;
    })
    .slice(-SOURCE_VALID_AT_CONTEXT_TURNS)
    .map(({ turn }) => asExtractionContextTurn(turn));
}

export function targetSourceValidAtSortMs(turns: readonly BufferTurn[]): number {
  let latestMs: number | null = null;
  for (const turn of turns) {
    if (turn.extractionContextOnly === true) continue;
    const validAtMs = sourceValidAtMs(turn);
    if (validAtMs === null) continue;
    if (latestMs === null || validAtMs > latestMs) {
      latestMs = validAtMs;
    }
  }
  return latestMs ?? Number.POSITIVE_INFINITY;
}

export function sortSourceValidAtSlicesChronologically(
  slices: BufferTurn[][],
): BufferTurn[][] {
  return slices
    .map((turns, order) => ({
      turns,
      order,
      targetValidAtMs: targetSourceValidAtSortMs(turns),
    }))
    .sort((a, b) => {
      if (a.targetValidAtMs < b.targetValidAtMs) return -1;
      if (a.targetValidAtMs > b.targetValidAtMs) return 1;
      if (a.order === b.order) return 0;
      return a.order < b.order ? -1 : 1;
    })
    .map((slice) => slice.turns);
}

export function splitTurnsBySourceValidAt(
  turns: readonly BufferTurn[],
  options: { includeContext?: boolean } = {},
): BufferTurn[][] {
  if (turns.length === 0) return [];
  if (!turns.some((turn) => sourceValidAtMs(turn) !== null)) {
    return [[...turns]];
  }

  const slices: BufferTurn[][] = [];
  let start = 0;
  while (start < turns.length) {
    const targetValidAtMs = sourceValidAtMs(turns[start]);
    const activeKey = sourceValidAtSliceKey(turns[start], start);
    let end = start + 1;
    while (
      end < turns.length &&
      sourceValidAtSliceKey(turns[end], end) === activeKey
    ) {
      end += 1;
    }

    const contextTurns =
      options.includeContext === false
        ? []
        : sourceValidAtContextTurns(turns, start, end, targetValidAtMs);
    slices.push([
      ...contextTurns,
      ...turns.slice(start, end).map(asExtractionTargetTurn),
    ]);
    start = end;
  }
  return sortSourceValidAtSlicesChronologically(slices);
}

export function isArtifactMemoryPath(filePath: string): boolean {
  return /(?:^|[\\/])artifacts(?:[\\/]|$)/i.test(filePath);
}

/**
 * Activity day-digests live at `<memoryDir>/activity/<date>.md` — a dedicated
 * searchable surface (explicit activity search), never generic recall. Captured
 * screen text must not auto-inject into ordinary prompts (issue #1899). Keyed on
 * the path, not frontmatter: parseFrontmatter drops the digest's `kind` marker.
 */
export function isActivityDigestPath(filePath: string): boolean {
  return /(?:^|[\\/])activity(?:[\\/]|$)/i.test(filePath);
}

/**
 * Paths that dedicated surfaces own and generic recall must never inject:
 * artifacts and activity digests. Explicit search paths (memory_search,
 * activity search) do not apply this filter, so those surfaces still read them.
 */
export function isGenericRecallExcludedPath(filePath: string): boolean {
  return isArtifactMemoryPath(filePath) || isActivityDigestPath(filePath);
}

export function buildCompressionGuidelinesMarkdown(
  events: MemoryActionEvent[],
  generatedAtIso: string = new Date().toISOString(),
): string {
  return buildCompressionGuidelinesMarkdownV2(events, generatedAtIso);
}

export function filterRecallCandidates(
  candidates: QmdSearchResult[],
  options: {
    namespacesEnabled: boolean;
    recallNamespaces: string[];
    resolveNamespace: (path: string) => string;
    limit: number;
  },
): QmdSearchResult[] {
  const scopedByNamespace = options.namespacesEnabled
    ? candidates.filter((r) =>
        options.recallNamespaces.includes(r.namespace ?? options.resolveNamespace(r.path)),
      )
    : candidates;
  return scopedByNamespace
    .filter((r) => !isGenericRecallExcludedPath(r.path))
    .slice(0, Math.max(0, options.limit));
}

export function applyQueryAwareCandidateFilter(
  candidates: QmdSearchResult[],
  candidatePaths: Set<string> | null,
): QmdSearchResult[] {
  if (!candidatePaths) return candidates;
  if (candidatePaths.size === 0) return [];
  const filtered = candidates.filter((candidate) =>
    candidatePaths.has(candidate.path),
  );
  return filtered.length > 0 ? filtered : candidates;
}

export function tokenizeRecallQuery(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

export function hasLifecycleMetadata(frontmatter: MemoryFrontmatter): boolean {
  return (
    frontmatter.lifecycleState !== undefined ||
    frontmatter.verificationState !== undefined ||
    frontmatter.policyClass !== undefined ||
    frontmatter.lastValidatedAt !== undefined ||
    frontmatter.decayScore !== undefined ||
    frontmatter.heatScore !== undefined
  );
}

export function shouldFilterLifecycleRecallCandidate(
  frontmatter: MemoryFrontmatter,
  options: {
    lifecyclePolicyEnabled: boolean;
    lifecycleFilterStaleEnabled: boolean;
  },
): boolean {
  if (!options.lifecyclePolicyEnabled || !options.lifecycleFilterStaleEnabled)
    return false;
  if (!hasLifecycleMetadata(frontmatter)) return false;
  const lifecycleState = resolveLifecycleState(frontmatter);
  return lifecycleState === "stale" || lifecycleState === "archived";
}

export function lifecycleRecallScoreAdjustment(
  frontmatter: MemoryFrontmatter,
  options: {
    lifecyclePolicyEnabled: boolean;
  },
): number {
  if (!options.lifecyclePolicyEnabled) return 0;
  if (!hasLifecycleMetadata(frontmatter)) return 0;

  let delta = 0;
  const lifecycleState = resolveLifecycleState(frontmatter);
  switch (lifecycleState) {
    case "active":
      delta += 0.05;
      break;
    case "validated":
      delta += 0.03;
      break;
    case "candidate":
      delta -= 0.01;
      break;
    case "stale":
      delta -= 0.06;
      break;
    case "archived":
      delta -= 0.08;
      break;
  }
  if (frontmatter.verificationState === "disputed") {
    delta -= 0.12;
  }
  return delta;
}

export function computeArtifactRecallLimit(
  recallMode: RecallPlanMode,
  recallResultLimit: number,
  verbatimArtifactsMaxRecall: number,
): number {
  if (recallMode === "no_recall") return 0;
  if (Math.max(0, recallResultLimit) === 0) return 0;
  const base = Math.max(0, verbatimArtifactsMaxRecall);
  if (recallMode === "minimal") {
    return Math.min(base, Math.max(0, recallResultLimit));
  }
  return base;
}

export function resolveEffectiveRecallMode(options: {
  plannerEnabled: boolean;
  graphRecallEnabled: boolean;
  multiGraphMemoryEnabled: boolean;
  graphExpandedIntentEnabled?: boolean;
  prompt: string;
}): RecallPlanMode {
  return resolveRecallModeDecision(options).effectiveMode;
}

export interface RecallModeGraphOptions {
  plannerEnabled: boolean;
  graphRecallEnabled: boolean;
  multiGraphMemoryEnabled: boolean;
  graphExpandedIntentEnabled?: boolean;
  prompt: string;
}

/**
 * Apply the graph-mode overlay + gating to a planner-produced mode.
 *
 * Shared by the heuristic ({@link resolveRecallModeDecision}) and LLM
 * ({@link resolveRecallModeDecisionAsync}) paths so graph promotion and the
 * "graph disabled → fall back to full" gating behave identically regardless of
 * which planner produced `plannedModeRaw` (gotcha #39).
 */
export function finalizeRecallModeDecision(
  plannedModeRaw: RecallPlanMode,
  options: RecallModeGraphOptions,
): RecallModeDecision {
  let plannedMode: RecallPlanMode = plannedModeRaw;
  const graphExpandedIntentDetected =
    options.plannerEnabled &&
    options.graphExpandedIntentEnabled === true &&
    hasBroadGraphIntent(options.prompt);
  if (plannedMode !== "graph_mode" && graphExpandedIntentDetected) {
    plannedMode = "graph_mode";
  }
  if (
    plannedMode === "graph_mode" &&
    (!options.graphRecallEnabled || !options.multiGraphMemoryEnabled)
  ) {
    return {
      plannedMode,
      effectiveMode: "full",
      graphExpandedIntentDetected,
      graphReason: !options.graphRecallEnabled
        ? "graph recall disabled by config"
        : "multi-graph memory disabled by config",
    };
  }
  return {
    plannedMode,
    effectiveMode: plannedMode,
    graphExpandedIntentDetected,
  };
}

export function resolveRecallModeDecision(options: RecallModeGraphOptions): RecallModeDecision {
  const plannedMode: RecallPlanMode = options.plannerEnabled
    ? planRecallMode(options.prompt)
    : "full";
  return finalizeRecallModeDecision(plannedMode, options);
}

/**
 * Async recall-mode decision with optional LLM-based planning (issue #1367 /
 * Option C). Falls back to the heuristic decision when the LLM planner is
 * disabled, in shadow mode, or unavailable/failed — so this is always safe to
 * await on the recall hot path. Provider-agnostic: the LLM call routes through
 * the gateway/fallback chain.
 *
 * `recallPlannerEnabled === false` keeps the legacy "always full" behavior and
 * skips the LLM entirely (the planner as a whole is off).
 */
export async function resolveRecallModeDecisionAsync(
  options: RecallModeGraphOptions & {
    config: PluginConfig;
    /**
     * Recall-operation capability gates (issue #1523). REQUIRED: the recall
     * orchestrator always passes a resolved set — the LLM planner gate reads
     * `caps.recallPlannerLlm`, never re-derives from config.
     */
    caps: CapabilitySet;
    hints?: string[];
    llm?: FallbackLlmClient;
    signal?: AbortSignal;
  },
): Promise<RecallModeDecision> {
  const heuristicDecision = resolveRecallModeDecision(options);

  // Planner globally off, or LLM planning not opted into → heuristic only.
  // Read the resolved capability (issue #1523) — never re-derive from config.
  const plannerLlmEnabled = options.caps.recallPlannerLlm;
  if (!options.plannerEnabled || !plannerLlmEnabled) {
    return heuristicDecision;
  }

  const { planRecallModeLLM } = await import("../recall-planner-llm.js");
  const planned = await planRecallModeLLM(
    options.prompt,
    options.hints,
    options.config,
    options.caps,
    options.llm,
    options.signal,
  );

  // Shadow mode: record what the LLM would have chosen but keep the heuristic
  // effective decision (safe rollout / comparison — gotcha #30).
  if (options.config.recallPlannerShadowMode) {
    return {
      ...heuristicDecision,
      plannerSource: planned.source,
      plannerReason: `shadow:${planned.reason}`,
      plannerLatencyMs: planned.latencyMs,
      plannerFallbackUsed: planned.fallbackUsed,
      plannerModelUsed: planned.modelUsed,
      plannerHeuristicMode: planned.heuristicMode,
      shadowLlmMode: planned.mode,
    };
  }

  const llmDecision = finalizeRecallModeDecision(planned.mode, options);
  return {
    ...llmDecision,
    plannerSource: planned.source,
    plannerReason: planned.reason,
    plannerLatencyMs: planned.latencyMs,
    plannerFallbackUsed: planned.fallbackUsed,
    plannerModelUsed: planned.modelUsed,
    plannerHeuristicMode: planned.heuristicMode,
  };
}

export function computeArtifactCandidateFetchLimit(
  targetCount: number,
): number {
  const cappedTarget = Math.max(0, targetCount);
  if (cappedTarget === 0) return 0;
  const headroom = Math.max(8, cappedTarget * 4);
  return Math.min(200, cappedTarget + headroom);
}

export function computeQmdHybridFetchLimit(
  recallFetchLimit: number,
  artifactsEnabled: boolean,
  maxArtifactRecall: number,
): number {
  const cappedRecallLimit = Math.max(0, recallFetchLimit);
  if (cappedRecallLimit === 0) return 0;
  if (!artifactsEnabled) return cappedRecallLimit;
  // Overscan when artifacts are enabled, then filter artifact paths before
  // re-applying the recall cap to avoid artifact-dominated top-N starvation.
  const artifactHeadroom = Math.max(20, Math.max(0, maxArtifactRecall) * 8);
  return Math.min(400, cappedRecallLimit + artifactHeadroom);
}

export function summarizeGraphShadowComparison(
  baseline: QmdSearchResult[],
  merged: QmdSearchResult[],
  topN: number,
): {
  baselineCount: number;
  graphCount: number;
  overlapCount: number;
  overlapRatio: number;
  averageOverlapDelta: number;
} {
  const limit = Math.max(0, Math.floor(topN));
  const baselineTop = limit > 0 ? baseline.slice(0, limit) : [];
  const graphTop = limit > 0 ? merged.slice(0, limit) : [];
  const baselineByPath = new Map(
    baselineTop.map((item) => [item.path, item.score]),
  );
  const graphByPath = new Map(graphTop.map((item) => [item.path, item.score]));

  let overlapCount = 0;
  let overlapDeltaSum = 0;
  for (const [p, baselineScore] of baselineByPath.entries()) {
    const graphScore = graphByPath.get(p);
    if (typeof graphScore !== "number") continue;
    overlapCount += 1;
    overlapDeltaSum += graphScore - baselineScore;
  }

  const baselineCount = baselineTop.length;
  return {
    baselineCount,
    graphCount: graphTop.length,
    overlapCount,
    overlapRatio: baselineCount > 0 ? overlapCount / baselineCount : 0,
    averageOverlapDelta: overlapCount > 0 ? overlapDeltaSum / overlapCount : 0,
  };
}

export function parseGraphRecallRankedResults(
  value: unknown,
): GraphRecallRankedResult[] {
  if (!Array.isArray(value)) return [];
  const parsed: GraphRecallRankedResult[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Partial<GraphRecallRankedResult>;
    if (
      typeof candidate.path !== "string" ||
      typeof candidate.score !== "number"
    )
      continue;
    parsed.push({
      path: candidate.path,
      score: candidate.score,
      docid: typeof candidate.docid === "string" ? candidate.docid : undefined,
      sourceLabels: Array.isArray(candidate.sourceLabels)
        ? candidate.sourceLabels.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
    });
  }
  return parsed.slice(0, 64);
}

export function parseMemoryIntentSnapshot(value: unknown): MemoryIntent {
  const candidate =
    value && typeof value === "object" ? (value as Partial<MemoryIntent>) : {};
  return {
    goal: typeof candidate.goal === "string" ? candidate.goal : "unknown",
    actionType:
      typeof candidate.actionType === "string"
        ? candidate.actionType
        : "unknown",
    entityTypes: Array.isArray(candidate.entityTypes)
      ? candidate.entityTypes.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    taskInitiation: candidate.taskInitiation === true,
  };
}

export function buildQmdIntentHint(intent: MemoryIntent): string | undefined {
  const parts: string[] = [];
  if (intent.goal !== "unknown") {
    parts.push(`goal:${intent.goal.replace(/_/g, " ")}`);
  }
  if (intent.actionType !== "unknown") {
    parts.push(`action:${intent.actionType.replace(/_/g, " ")}`);
  }
  if (intent.entityTypes.length > 0) {
    parts.push(`entities:${intent.entityTypes.join(",")}`);
  }
  if (intent.taskInitiation === true) {
    parts.push("task_initiation");
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function parseQmdRecallResults(value: unknown): QmdSearchResult[] {
  if (!Array.isArray(value)) return [];
  const parsed: QmdSearchResult[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Partial<QmdSearchResult>;
    if (
      typeof candidate.path !== "string" ||
      typeof candidate.score !== "number"
    )
      continue;
    parsed.push({
      docid: typeof candidate.docid === "string" ? candidate.docid : "",
      path: candidate.path,
      snippet: typeof candidate.snippet === "string" ? candidate.snippet : "",
      score: candidate.score,
      explain: parseQmdExplain(candidate.explain),
      transport:
        candidate.transport === "daemon" ||
        candidate.transport === "subprocess" ||
        candidate.transport === "hybrid" ||
        candidate.transport === "scoped_prefilter"
          ? candidate.transport
          : undefined,
    });
  }
  return parsed.slice(0, 32);
}

export function mergeArtifactRecallCandidates(
  candidatesByNamespace: MemoryFile[][],
  limit: number,
): MemoryFile[] {
  const cappedLimit = Math.max(0, limit);
  if (cappedLimit === 0) return [];

  const out: MemoryFile[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (out.length < cappedLimit) {
    let hasAnyCandidateAtOffset = false;
    for (const list of candidatesByNamespace) {
      if (offset >= list.length) continue;
      hasAnyCandidateAtOffset = true;
      const item = list[offset];
      const dedupeKey = `${item.frontmatter.id}:${item.frontmatter.sourceMemoryId ?? ""}:${item.content}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push(item);
      if (out.length >= cappedLimit) break;
    }
    if (!hasAnyCandidateAtOffset) break;
    offset += 1;
  }
  return out;
}

export function resolveRecentThreadMemoryPaths(options: {
  threadEpisodeIds: string[];
  currentMemoryId: string;
  allMemsForGraph: MemoryFile[] | null | undefined;
  pathById?: Map<string, string>;
  storageDir: string;
  maxRecent: number;
}): string[] {
  const maxRecent = Math.max(0, options.maxRecent);
  if (options.threadEpisodeIds.length === 0 || maxRecent === 0) return [];
  const pathById =
    options.pathById ??
    buildMemoryPathById(options.allMemsForGraph, options.storageDir);
  if (pathById.size === 0) return [];

  // #1635 (defensive): skip pending_review ids from legacy episode sets.
  const pendingReviewIds = new Set<string>(
    (options.allMemsForGraph ?? [])
      .filter((m) => m.frontmatter.status === "pending_review" && m.frontmatter.id)
      .map((m) => m.frontmatter.id as string),
  );

  return options.threadEpisodeIds
    .filter((id) => id !== options.currentMemoryId)
    .filter((id) => !pendingReviewIds.has(id))
    .slice(-maxRecent)
    .map((id) => pathById.get(id))
    .filter((p): p is string => typeof p === "string" && p.length > 0);
}

export function buildMemoryPathById(
  allMemsForGraph: MemoryFile[] | null | undefined,
  storageDir: string,
): Map<string, string> {
  const pathById = new Map<string, string>();
  for (const mem of allMemsForGraph ?? []) {
    const id = mem.frontmatter.id;
    if (!id) continue;
    pathById.set(id, path.relative(storageDir, mem.path));
  }
  return pathById;
}

export function appendMemoryToGraphContext(options: {
  allMemsForGraph: MemoryFile[] | null | undefined;
  storageDir: string;
  memoryRelPath: string;
  memoryId: string;
  category: MemoryFile["frontmatter"]["category"];
  content: string;
  entityRef: string | undefined;
}): void {
  if (!Array.isArray(options.allMemsForGraph)) return;

  const nowIso = new Date().toISOString();
  options.allMemsForGraph.push({
    path: path.join(options.storageDir, options.memoryRelPath),
    content: options.content,
    frontmatter: {
      id: options.memoryId,
      category: options.category,
      created: nowIso,
      updated: nowIso,
      source: "extraction",
      confidence: 0.8,
      confidenceTier: "implied",
      tags: [],
      entityRef: options.entityRef,
      status: "active",
    },
  });
}

export function resolvePersistedMemoryRelativePath(options: {
  memoryId: string;
  pathById: Map<string, string>;
  category: string;
}): string {
  const persisted = options.pathById.get(options.memoryId);
  if (persisted) return persisted;
  if (options.category === "correction") {
    return path.join("corrections", `${options.memoryId}.md`);
  }
  // Pick the subtree that matches the StorageManager.writeMemory routing
  // so fallback paths (used before memoryPathById has seen the fresh
  // write) agree with where the file actually lives. Routing goes through
  // the shared categoryDirName() chokepoint (utils/category-dir.ts) so
  // every category — decisions/, preferences/, reasoning-traces/, ... —
  // resolves to the same dir the writer used; otherwise graph edges point
  // at the wrong subtree and graph expansion silently drops those nodes
  // when readMemoryByPath cannot resolve them (issue #564 PR 3 / #1546).
  const subtree = categoryDirName(options.category);
  const idParts = options.memoryId.split("-");
  const maybeTimestamp = Number(idParts[1]);
  if (Number.isFinite(maybeTimestamp) && maybeTimestamp > 0) {
    const day = new Date(maybeTimestamp).toISOString().slice(0, 10);
    return path.join(subtree, day, `${options.memoryId}.md`);
  }
  return path.join(subtree, `${options.memoryId}.md`);
}

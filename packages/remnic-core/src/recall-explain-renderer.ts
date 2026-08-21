/**
 * Renderers for RecallTierExplain (issue #518).
 *
 * Pure functions that format a `LastRecallSnapshot` and its
 * optional `tierExplain` field for human text and machine JSON
 * consumption.  CLI / HTTP / MCP surfaces consume these — they do
 * not format explain output themselves, so rendering is tested in
 * one place.
 */

import type { LastRecallSnapshot } from "./recall-state.js";
import type { RecallTierExplain } from "./types.js";
import { isRetrievalTier } from "./retrieval-tiers.js";
import type {
  RecallXraySnapshot,
  RecallFilterTrace,
  RecallXrayResult,
} from "./recall-xray.js";
import { renderXrayMarkdown } from "./recall-xray-renderer.js";

function sanitizeString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function sanitizeFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * `text` and `json` are the original formats (backwards-compatible
 * since issue #518).  `markdown` was added in issue #570 PR 7 and
 * delegates to the shared X-ray renderer so the three observability
 * surfaces stay in lock-step (CLAUDE.md rule 22).
 */
export type RecallExplainFormat = "text" | "json" | "markdown";

export interface RecallExplainJsonPayload {
  hasExplain: boolean;
  snapshotFound: boolean;
  sessionKey: string | null;
  recordedAt: string | null;
  namespace: string | null;
  memoryIds: string[];
  source: string | null;
  sourcesUsed: string[] | null;
  latencyMs: number | null;
  tierExplain: RecallTierExplain | null;
}

function normalizeTierExplain(value: unknown): RecallTierExplain | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const filteredBy = Array.isArray(raw.filteredBy)
    ? raw.filteredBy.filter((x): x is string => typeof x === "string")
    : [];
  const sourceAnchors = Array.isArray(raw.sourceAnchors)
    ? raw.sourceAnchors
        .filter(
          (a): a is { path: string; lineRange?: unknown } =>
            !!a && typeof a === "object" && typeof (a as { path?: unknown }).path === "string",
        )
        .map((a) => {
          const lr = (a as { lineRange?: unknown }).lineRange;
          const lineRange =
            Array.isArray(lr) &&
            lr.length === 2 &&
            Number.isFinite(lr[0]) &&
            Number.isFinite(lr[1])
              ? ([lr[0] as number, lr[1] as number] as [number, number])
              : undefined;
          return lineRange
            ? { path: (a as { path: string }).path, lineRange }
            : { path: (a as { path: string }).path };
        })
    : undefined;
  return {
    tier: isRetrievalTier(raw.tier) ? raw.tier : "hybrid",
    tierReason: typeof raw.tierReason === "string" ? raw.tierReason : "",
    filteredBy,
    candidatesConsidered: sanitizeFiniteNumber(raw.candidatesConsidered) ?? 0,
    latencyMs: sanitizeFiniteNumber(raw.latencyMs) ?? 0,
    ...(sourceAnchors !== undefined ? { sourceAnchors } : {}),
  };
}

export function toRecallExplainJson(
  snapshot: LastRecallSnapshot | null,
): RecallExplainJsonPayload {
  if (!snapshot) {
    return {
      hasExplain: false,
      snapshotFound: false,
      sessionKey: null,
      recordedAt: null,
      namespace: null,
      memoryIds: [],
      source: null,
      sourcesUsed: null,
      latencyMs: null,
      tierExplain: null,
    };
  }
  const normalizedExplain = normalizeTierExplain(snapshot.tierExplain);
  return {
    hasExplain: normalizedExplain !== null,
    snapshotFound: true,
    sessionKey: sanitizeString(snapshot.sessionKey),
    recordedAt: sanitizeString(snapshot.recordedAt),
    namespace: sanitizeString(snapshot.namespace),
    memoryIds: Array.isArray(snapshot.memoryIds)
      ? snapshot.memoryIds.filter((x): x is string => typeof x === "string")
      : [],
    source: sanitizeString(snapshot.source),
    sourcesUsed: Array.isArray(snapshot.sourcesUsed)
      ? snapshot.sourcesUsed.filter((x): x is string => typeof x === "string")
      : null,
    latencyMs: sanitizeFiniteNumber(snapshot.latencyMs),
    tierExplain: normalizedExplain,
  };
}

/**
 * Render the shared "--- tier explain ---" text block used by both the
 * recall-explain surface and the Recall X-ray surface.  Callers provide
 * the normalized `RecallTierExplain` (or `null` for the
 * not-populated/disabled case) so the block stays character-for-character
 * identical across surfaces (CLAUDE.md rule 22).  The returned strings do
 * NOT include leading blank lines or headers — callers own that framing.
 */
export function renderTierExplainTextLines(
  tierExplain: RecallTierExplain | null,
): string[] {
  const lines: string[] = [];
  if (!tierExplain) {
    lines.push(
      "(not populated — direct-answer tier disabled or did not fire)",
    );
    return lines;
  }
  lines.push(`tier: ${tierExplain.tier}`);
  lines.push(`reason: ${tierExplain.tierReason}`);
  lines.push(`candidates-considered: ${tierExplain.candidatesConsidered}`);
  lines.push(`latency-ms: ${tierExplain.latencyMs}`);
  if (tierExplain.filteredBy.length > 0) {
    lines.push(`filtered-by: ${tierExplain.filteredBy.join(", ")}`);
  } else {
    lines.push("filtered-by: (none)");
  }
  if (tierExplain.sourceAnchors && tierExplain.sourceAnchors.length > 0) {
    lines.push("source-anchors:");
    for (const anchor of tierExplain.sourceAnchors) {
      const range = anchor.lineRange
        ? `:${anchor.lineRange[0]}-${anchor.lineRange[1]}`
        : "";
      lines.push(`  - ${anchor.path}${range}`);
    }
  }
  return lines;
}

export function toRecallExplainText(
  snapshot: LastRecallSnapshot | null,
): string {
  const lines: string[] = ["=== Recall Explain ==="];

  if (!snapshot) {
    lines.push("No recall snapshot recorded yet.");
    return lines.join("\n");
  }

  const sessionKey = sanitizeString(snapshot.sessionKey);
  const recordedAt = sanitizeString(snapshot.recordedAt);
  const namespace = sanitizeString(snapshot.namespace);
  const source = sanitizeString(snapshot.source);
  lines.push(`session: ${sessionKey ?? "(unknown)"}`);
  lines.push(`recorded: ${recordedAt ?? "(unknown)"}`);
  if (namespace) lines.push(`namespace: ${namespace}`);
  if (source) lines.push(`source: ${source}`);
  const sourcesUsed = Array.isArray(snapshot.sourcesUsed)
    ? snapshot.sourcesUsed.filter((x): x is string => typeof x === "string")
    : [];
  if (sourcesUsed.length > 0) {
    lines.push(`sources-used: ${sourcesUsed.join(", ")}`);
  }
  const latencyMs = sanitizeFiniteNumber(snapshot.latencyMs);
  if (latencyMs !== null) {
    lines.push(`latency-ms: ${latencyMs}`);
  }
  const memoryIds = Array.isArray(snapshot.memoryIds)
    ? snapshot.memoryIds.filter((x): x is string => typeof x === "string")
    : [];
  if (memoryIds.length > 0) {
    lines.push(`memories: ${memoryIds.join(", ")}`);
  }

  const ex = normalizeTierExplain(snapshot.tierExplain);
  if (!ex) {
    lines.push("");
    lines.push(
      "tier-explain: (not populated — direct-answer tier disabled or did not fire)",
    );
    return lines.join("\n");
  }

  lines.push("");
  lines.push("--- tier explain ---");
  for (const line of renderTierExplainTextLines(ex)) {
    lines.push(line);
  }
  return lines.join("\n");
}

/**
 * Adapter: convert a `LastRecallSnapshot` into a best-effort
 * `RecallXraySnapshot` so the markdown renderer can produce a
 * consistent, richly-formatted document for callers that have asked
 * for `markdown` format.  The LastRecallSnapshot and the X-ray
 * snapshot share session/namespace/memoryIds; additional X-ray-only
 * fields (filters, score decomposition, graph path, audit id) are
 * left empty because the legacy snapshot doesn't carry them.  The
 * renderer handles missing fields gracefully.
 */
/**
 * Strip backticks, pipes, and newlines from a host-provided value so it
 * cannot escape its enclosing markdown code span, break the surrounding
 * table row, or inject extra rows when it lands in
 * `renderXrayMarkdown`.  Applied at the adapter boundary because
 * `LastRecallSnapshot` is hydrated from on-disk JSON without schema
 * validation (codex P2 review on #605).
 *
 * Accepts `unknown` so non-string truthy values (numbers, objects,
 * booleans, arrays) coming from a corrupted snapshot are coerced to
 * the empty string rather than crashing on `.replace(...)`.  Callers
 * should treat an empty return as "drop this field."
 */
function sanitizeForMarkdownInline(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[`|\r\n]/g, " ").trim();
}

/**
 * Map the legacy `LastRecallSnapshot.source` field to the
 * `RecallXrayServedBy` union used by the unified x-ray renderer.
 * Mirrors the `mapRecallSourceToXrayServedBy` helper inside
 * `orchestrator.ts` (which is private).  Keep the two in sync when a
 * new source lands — unknown values collapse to `"hybrid"` to preserve
 * backwards compatibility with older on-disk snapshots.
 */
function mapLegacySourceToServedBy(
  source: unknown,
): "hybrid" | "recent-scan" {
  if (source === "recent_scan") return "recent-scan";
  return "hybrid";
}

export function toRecallXraySnapshotFromLegacy(
  snapshot: LastRecallSnapshot | null,
): RecallXraySnapshot | null {
  if (!snapshot) return null;
  const capturedAt = (() => {
    if (typeof snapshot.recordedAt !== "string") return 0;
    const ms = Date.parse(snapshot.recordedAt);
    return Number.isFinite(ms) && ms >= 0 ? ms : 0;
  })();
  const memoryIds = Array.isArray(snapshot.memoryIds)
    ? snapshot.memoryIds.filter((x): x is string => typeof x === "string")
    : [];
  // Codex P2 + Cursor Medium on #605: every converted result used to
  // be stamped with `servedBy: "hybrid"`, misattributing legacy
  // snapshots that came from `recent_scan` (or any future source).
  // Propagate the recorded `source` so markdown `recall-explain`
  // output matches the `served-by=` string the native x-ray capture
  // would emit for the same recall.
  const servedBy = mapLegacySourceToServedBy(snapshot.source);
  const results: RecallXrayResult[] = memoryIds.map((memoryId) => ({
    memoryId,
    path: "",
    servedBy,
    scoreDecomposition: { final: 0 },
    admittedBy: [],
  }));
  const filters: RecallFilterTrace[] = [];
  return {
    schemaVersion: "1",
    // `LastRecallSnapshot` does not preserve the original query text;
    // synthesize a placeholder so the renderer has a non-empty
    // string to print.  `queryHash` + `queryLen` stay in the JSON
    // payload via `toRecallExplainJson` for callers that need them.
    query:
      snapshot.queryHash
        ? `(legacy explain; queryHash=${snapshot.queryHash})`
        : "(legacy explain)",
    // `snapshotId` is synthesized here; `sessionKey` is already
    // sanitized before it reaches the ID because we re-use the
    // sanitized string below.
    snapshotId: `legacy-${sanitizeForMarkdownInline(snapshot.sessionKey ?? "unknown") || "unknown"}-${capturedAt}`,
    capturedAt,
    // Run the raw on-disk value through the same normalizer the text
    // and JSON paths use so the markdown adapter cannot render
    // unvalidated tier-explain payloads (cursor / codex review on
    // #605).  A malformed tierExplain is dropped to null, matching the
    // behavior of the non-markdown surfaces.
    tierExplain: normalizeTierExplain(snapshot.tierExplain) ?? null,
    results,
    appliedResultLimit: 0,
    appliedResults: [],
    headroomResults: [],
    filters,
    budget: { chars: 0, used: 0 },
    // Sanitize legacy session metadata at the adapter boundary so a
    // malformed on-disk value (containing backticks, pipes, or
    // newlines) cannot break the enclosing markdown table when
    // `renderXrayMarkdown` prints it in a raw code-span cell (codex P2
    // review on #605).
    ...(snapshot.sessionKey
      ? (() => {
          const clean = sanitizeForMarkdownInline(snapshot.sessionKey);
          return clean ? { sessionKey: clean } : {};
        })()
      : {}),
    ...(snapshot.namespace
      ? (() => {
          const clean = sanitizeForMarkdownInline(snapshot.namespace);
          return clean ? { namespace: clean } : {};
        })()
      : {}),
  };
}

export function renderRecallExplain(
  snapshot: LastRecallSnapshot | null,
  format: RecallExplainFormat,
): string {
  if (format === "json") {
    return JSON.stringify(toRecallExplainJson(snapshot), null, 2);
  }
  if (format === "markdown") {
    // Delegate to the shared X-ray renderer so CLI / HTTP / MCP
    // markdown output all share one implementation (CLAUDE.md rule
    // 22).  The JSON and text paths remain byte-for-byte
    // backwards-compatible with pre-#570 behavior.
    return renderXrayMarkdown(toRecallXraySnapshotFromLegacy(snapshot));
  }
  return toRecallExplainText(snapshot);
}

export function parseRecallExplainFormat(value: unknown): RecallExplainFormat {
  if (value === undefined || value === null) return "text";
  if (typeof value !== "string") {
    throw new Error(
      `--format expects "text", "json", or "markdown", got ${typeof value}`,
    );
  }
  const v = value.trim().toLowerCase();
  if (v === "text" || v === "json" || v === "markdown") return v;
  throw new Error(
    `--format expects "text", "json", or "markdown", got ${JSON.stringify(value)}`,
  );
}

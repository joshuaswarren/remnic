/**
 * Recall-audit anomaly detector (issue #565 PR 5/5).
 *
 * Given a sequence of `RecallAuditEntry` records for a single principal /
 * session, classify the series and emit `AnomalyFlag`s for suspicious
 * patterns. Intended to run on both:
 *
 * 1. The MCP / HTTP access layers — every `recall` / `memory_search` /
 *    `memory_timeline` call appends an audit entry and the detector is
 *    invoked against the tail of the series (streaming mode).
 * 2. The existing Openclaw hook (already writes `transcripts/*.jsonl`) —
 *    the detector can be invoked out-of-band over the same entries.
 *
 * See the threat model §5 (gap: recall-audit was only on the Openclaw
 * hook) and §6.3 (anomaly signals) for the patterns below.
 *
 * The module is pure: no I/O, no clock. Callers pass the entries +
 * configured thresholds; the detector returns a deterministic classification.
 *
 * Patterns detected:
 *
 * - `repeat-query` — the same normalized query text issued more than N
 *   times in the window. Covers the ADAM "exploitation" phase where the
 *   attacker re-queries a high-signal token until it plateaus.
 * - `namespace-walk` — the same principal's queries visit more than N
 *   distinct candidate memory namespaces in the window. Suggests the
 *   attacker is enumerating the namespace tree for leaks.
 * - `high-cardinality-return` — a single recall surfaced more than N
 *   candidate memory IDs in one response. Covers the "one query, dump
 *   everything" exfiltration path.
 * - `rapid-fire` — more than N recalls in the window irrespective of
 *   content. Blunt instrument; useful when nothing else fires.
 *
 * Each flag carries the entry indices that support it so an audit UI can
 * highlight the underlying evidence.
 */

import type { RecallAuditEntry } from "./recall-audit.js";

export type AnomalyKind =
  | "repeat-query"
  | "namespace-walk"
  | "high-cardinality-return"
  | "rapid-fire";

export type AnomalySeverity = "info" | "warn" | "alert";

export interface AnomalyFlag {
  kind: AnomalyKind;
  severity: AnomalySeverity;
  /** Human-readable rationale, e.g. `"query 'alex' repeated 12 times in 60s"`. */
  message: string;
  /** Indices into the supplied `entries` array that triggered the flag. */
  entryIndices: number[];
  /**
   * Optional extra signal the caller can use to key metrics. For
   * `repeat-query` this is the normalized query text; for
   * `namespace-walk` it is the namespace count; etc.
   */
  signal?: string | number;
}

export interface AnomalyDetectorConfig {
  /** Detector feature-flag. Defaults to false — ships disabled. */
  enabled?: boolean;
  /**
   * Rolling window in ms. The detector only considers entries whose `ts`
   * falls within `[now - windowMs, now]`. Default 5 minutes.
   */
  windowMs?: number;
  /**
   * Threshold for `repeat-query`: a normalized query repeated more than
   * this many times in the window trips the flag. Default 5.
   */
  repeatQueryLimit?: number;
  /**
   * Threshold for `namespace-walk`: more than this many distinct
   * candidate namespaces in the window trips the flag. Default 3.
   */
  namespaceWalkLimit?: number;
  /**
   * Threshold for `high-cardinality-return`: more than this many
   * `candidateMemoryIds` in a single entry trips the flag. Default 50.
   */
  highCardinalityReturnLimit?: number;
  /**
   * Threshold for `rapid-fire`: more than this many entries in the
   * window trips the flag. Default 30. (Matches the default
   * `recallCrossNamespaceBudgetHardLimit` from PR 4.)
   */
  rapidFireLimit?: number;
}

export const DEFAULT_ANOMALY_DETECTOR_CONFIG: Required<AnomalyDetectorConfig> =
  Object.freeze({
    enabled: false,
    windowMs: 5 * 60_000,
    repeatQueryLimit: 5,
    namespaceWalkLimit: 3,
    highCardinalityReturnLimit: 50,
    rapidFireLimit: 30,
  });

export interface AnomalyDetectorInput {
  entries: readonly RecallAuditEntry[];
  /** Current time in epoch ms. Entries older than `now - windowMs` are ignored. */
  now: number;
  config?: AnomalyDetectorConfig;
}

export interface AnomalyDetectorResult {
  /** All flags ordered by descending severity then kind. */
  flags: AnomalyFlag[];
  /** Number of entries inside the active window (after filtering). */
  windowEntryCount: number;
  /** Window size actually used, in ms. */
  windowMs: number;
}

function effectiveConfig(
  raw: AnomalyDetectorConfig | undefined,
): Required<AnomalyDetectorConfig> {
  const base = { ...DEFAULT_ANOMALY_DETECTOR_CONFIG };
  if (!raw) return base;
  const out = { ...base };
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (
    typeof raw.windowMs === "number" &&
    Number.isFinite(raw.windowMs) &&
    raw.windowMs > 0
  ) {
    out.windowMs = raw.windowMs;
  }
  for (const key of [
    "repeatQueryLimit",
    "namespaceWalkLimit",
    "highCardinalityReturnLimit",
    "rapidFireLimit",
  ] as const) {
    const v = raw[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      const floored = Math.floor(v);
      // Guard against fractional inputs (e.g. 0.5) that floor to 0 and
      // turn every detector into a flood-on-anything trigger.
      out[key] = floored >= 1 ? floored : base[key];
    }
  }
  return out;
}

/**
 * Normalize query text so cosmetic variation doesn't defeat the
 * repeat-query detector. Lowercase, collapse whitespace, trim.
 */
export function normalizeQueryText(raw: string): string {
  if (typeof raw !== "string") return "";
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

const SEVERITY_ORDER: Record<AnomalySeverity, number> = {
  alert: 0,
  warn: 1,
  info: 2,
};

function parseTsMs(ts: string): number | null {
  const n = new Date(ts).getTime();
  return Number.isFinite(n) ? n : null;
}

/**
 * Run the detector against a series of audit entries. Pure; no side
 * effects.
 */
export function detectRecallAnomalies(
  input: AnomalyDetectorInput,
): AnomalyDetectorResult {
  const cfg = effectiveConfig(input.config);
  const cutoff = input.now - cfg.windowMs;

  // Filter to the active window, preserving original indices so flags
  // can reference the caller's entries array directly.
  const windowed: { entry: RecallAuditEntry; index: number }[] = [];
  for (let i = 0; i < input.entries.length; i++) {
    const entry = input.entries[i]!;
    const tsMs = parseTsMs(entry.ts);
    if (tsMs === null) continue;
    if (tsMs >= cutoff && tsMs <= input.now) {
      windowed.push({ entry, index: i });
    }
  }

  if (!cfg.enabled) {
    return { flags: [], windowEntryCount: windowed.length, windowMs: cfg.windowMs };
  }

  const flags: AnomalyFlag[] = [];

  // 1) repeat-query: bucket by normalized queryText.
  {
    const byQuery = new Map<string, number[]>();
    for (const { entry, index } of windowed) {
      const key = normalizeQueryText(entry.queryText);
      if (key.length === 0) continue;
      const arr = byQuery.get(key);
      if (arr) arr.push(index);
      else byQuery.set(key, [index]);
    }
    for (const [query, indices] of byQuery) {
      if (indices.length > cfg.repeatQueryLimit) {
        flags.push({
          kind: "repeat-query",
          severity: "warn",
          message: `query "${query}" repeated ${indices.length} times in ${cfg.windowMs}ms`,
          entryIndices: indices.slice(),
          signal: query,
        });
      }
    }
  }

  // 2) namespace-walk: distinct namespaces extracted from candidateMemoryIds.
  //    Candidate IDs that begin with `<namespace>/` disclose the namespace
  //    directly. IDs without a slash prefix (e.g. bare filenames) do not
  //    disclose a namespace, but a recall whose result list mixes
  //    prefixed AND unprefixed IDs is itself suspicious — it suggests
  //    the backend leaked memories from both the caller's own namespace
  //    and named tenants. We track unprefixed IDs under a reserved
  //    sentinel namespace so they still contribute to the count when a
  //    trail is all-unprefixed (common for older audit entries sourced
  //    from filenames).
  {
    const namespaces = new Set<string>();
    const indices: number[] = [];
    for (const { entry, index } of windowed) {
      if (!Array.isArray(entry.candidateMemoryIds)) continue;
      let touchedAny = false;
      for (const id of entry.candidateMemoryIds) {
        if (typeof id !== "string" || id.length === 0) continue;
        const slash = id.indexOf("/");
        if (slash > 0) {
          namespaces.add(id.slice(0, slash));
        } else {
          namespaces.add("__unprefixed__");
        }
        touchedAny = true;
      }
      if (touchedAny) indices.push(index);
    }
    if (namespaces.size > cfg.namespaceWalkLimit) {
      flags.push({
        kind: "namespace-walk",
        severity: "alert",
        message: `queries touched ${namespaces.size} distinct namespaces in ${cfg.windowMs}ms`,
        entryIndices: indices,
        signal: namespaces.size,
      });
    }
  }

  // 3) high-cardinality-return: one entry's candidateMemoryIds > limit.
  {
    for (const { entry, index } of windowed) {
      const ids = Array.isArray(entry.candidateMemoryIds)
        ? entry.candidateMemoryIds
        : [];
      if (ids.length > cfg.highCardinalityReturnLimit) {
        flags.push({
          kind: "high-cardinality-return",
          severity: "alert",
          message: `single recall returned ${ids.length} candidate memory IDs`,
          entryIndices: [index],
          signal: ids.length,
        });
      }
    }
  }

  // 4) rapid-fire: windowed count alone.
  if (windowed.length > cfg.rapidFireLimit) {
    flags.push({
      kind: "rapid-fire",
      severity: "warn",
      message: `${windowed.length} recall entries in ${cfg.windowMs}ms`,
      entryIndices: windowed.map((w) => w.index),
      signal: windowed.length,
    });
  }

  flags.sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (s !== 0) return s;
    return a.kind.localeCompare(b.kind);
  });

  return { flags, windowEntryCount: windowed.length, windowMs: cfg.windowMs };
}

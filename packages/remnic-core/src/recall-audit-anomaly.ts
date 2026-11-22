
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
  flags: AnomalyFlag[];
  windowEntryCount: number;
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
      out[key] = floored >= 1 ? floored : base[key];
    }
  }
  return out;
}

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

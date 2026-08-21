/**
 * Access-layer audit adapter (issue #565 PR 5/5).
 *
 * Wraps `appendRecallAuditEntry` + `detectRecallAnomalies` into a single
 * entry point that MCP (`access-mcp.ts`) and HTTP (`access-http.ts`)
 * surfaces can call once per recall. Closes the gap called out in the
 * memory-extraction threat model §5: recall-audit previously only ran
 * on the Openclaw hook, so MCP/HTTP callers bypassed the trail entirely.
 *
 * The adapter is a per-instance class so the tail-of-trail buffer
 * (used by the anomaly detector) is scoped per-service, not global.
 *
 * No I/O unless `audit.enabled` is true; no detector invocation unless
 * `detection.enabled` is true. Either flag may be enabled independently.
 */

import {
  appendRecallAuditEntry,
  type RecallAuditEntry,
} from "./recall-audit.js";
import {
  detectRecallAnomalies,
  type AnomalyDetectorConfig,
  type AnomalyDetectorResult,
} from "./recall-audit-anomaly.js";

export interface AccessAuditConfig {
  audit: {
    enabled: boolean;
    /** Root directory the audit adapter writes JSONL shards into. */
    rootDir: string;
  };
  detection: AnomalyDetectorConfig;
  /**
   * How many entries the adapter retains in memory for the detector.
   * Defaults to 256 — enough to cover the threat model's default 5-minute
   * window at high recall rates without unbounded growth.
   */
  trailBufferSize?: number;
}

export interface AccessAuditResult {
  /** Path of the JSONL shard the entry was appended to (only when audit enabled). */
  appendedAt?: string;
  /** Result of the anomaly detector (only when detection enabled). */
  anomalies?: AnomalyDetectorResult;
}

/**
 * Per-principal tail buffer. Distinct principals do not pollute each
 * other's detection windows — otherwise one noisy legitimate client
 * could mask an actual attacker.
 */
interface PrincipalTail {
  entries: RecallAuditEntry[];
}

export class AccessAuditAdapter {
  private readonly trails = new Map<string, PrincipalTail>();
  private readonly trailBufferSize: number;

  constructor(private readonly config: AccessAuditConfig) {
    const n = config.trailBufferSize;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) {
      const floored = Math.floor(n);
      // Guard against fractional inputs (e.g. 0.5) that floor to 0.
      this.trailBufferSize = floored >= 1 ? floored : 256;
    } else {
      this.trailBufferSize = 256;
    }
  }

  /**
   * Record an audit entry and (when enabled) run the anomaly detector
   * over the principal's tail of entries. The principal key is used
   * purely for tail-buffer bucketing — it need not match the production
   * namespace resolver; sessionKey is the safe default.
   */
  async record(
    principalKey: string,
    entry: RecallAuditEntry,
    now: number = Date.now(),
  ): Promise<AccessAuditResult> {
    const result: AccessAuditResult = {};

    // Update the in-memory tail BEFORE the async audit write so a failed
    // append never leaves the tail in a stale state. The detector must see
    // every record regardless of whether the JSONL shard accepted it.
    if (this.config.detection.enabled) {
      const key = principalKey.length > 0 ? principalKey : "__anonymous__";
      const tail = this.trails.get(key) ?? { entries: [] };
      tail.entries.push(entry);
      if (tail.entries.length > this.trailBufferSize) {
        tail.entries.splice(0, tail.entries.length - this.trailBufferSize);
      }
      this.trails.set(key, tail);

      result.anomalies = detectRecallAnomalies({
        entries: tail.entries,
        now,
        config: this.config.detection,
      });
    }

    if (this.config.audit.enabled) {
      try {
        result.appendedAt = await appendRecallAuditEntry(
          this.config.audit.rootDir,
          entry,
        );
      } catch {
        // Audit write failures must never crash the enclosing recall.
        // Swallow — operators can surface the ENOSPC / permission error
        // via the usual filesystem monitoring.
      }
    }

    return result;
  }

  /** Clear all in-memory tail state. Intended for tests / before_reset. */
  reset(): void {
    this.trails.clear();
  }
}

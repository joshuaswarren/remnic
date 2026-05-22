/**
 * Per-principal cross-namespace query-budget limiter (issue #565 PR 4/5).
 *
 * Detects and throttles bursts of recall-type operations that a principal
 * issues against namespaces *other than their own*. Thresholds come from the
 * memory-extraction threat model (`docs/security/memory-extraction-threat-model.md`
 * §6.2) and the ADAM baseline report (`docs/security/adam-baseline-2026-04.md`):
 * a T2-class same-namespace attacker plateaus at 61 queries in the published
 * baseline, so the default window is set well below that to force any
 * adaptive loop to noticeably slow down.
 *
 * Shape:
 * - Pure, in-process, per-principal sliding window. No persistence.
 * - Only cross-namespace reads count: a principal hitting only their own
 *   namespace is never throttled.
 * - The limiter is behind the `recallCrossNamespaceBudgetEnabled` feature
 *   flag (defaults to `false`) and is a no-op when disabled. This mirrors
 *   the canonical "new filter/transform needs an enabled check" pattern
 *   (see CLAUDE.md gotcha #30).
 *
 * The module has no side effects beyond incrementing its own counters, and
 * it does NOT take a clock dependency — callers pass the current epoch ms
 * (or let the default `Date.now()` do it) so tests can step time
 * deterministically.
 */

export interface CrossNamespaceBudgetConfig {
  /** Feature flag. Defaults to false — a disabled limiter is always allow. */
  enabled?: boolean;
  /**
   * Rolling window size in milliseconds. Counts decay out of the window
   * as the clock advances. Default: 60_000 (1 minute).
   */
  windowMs?: number;
  /**
   * Soft cap. Once a principal has `softLimit` cross-namespace reads in the
   * window, the limiter *records* a warning on the decision but still
   * allows the call. Used by PR 5's anomaly detector to surface flags
   * without blocking. Default: 10.
   */
  softLimit?: number;
  /**
   * Hard cap. Once `hardLimit` is reached, the limiter denies the call.
   * Default: 30 — picked to be well below the T2 baseline of ~60 queries
   * at half-plateau, so an ADAM-style adaptive loop is throttled before it
   * meaningfully leaks.
   */
  hardLimit?: number;
}

export const DEFAULT_CROSS_NAMESPACE_BUDGET: Required<CrossNamespaceBudgetConfig> =
  Object.freeze({
    enabled: false,
    windowMs: 60_000,
    softLimit: 10,
    hardLimit: 30,
  });

/**
 * Why a call was denied / warned. Stable strings so callers can key log
 * lines and metrics on them.
 */
export type BudgetDecisionReason =
  | "allowed-same-namespace"
  | "allowed-no-limit"
  | "allowed-under-soft"
  | "warn-over-soft"
  | "deny-over-hard";

export interface BudgetDecision {
  allowed: boolean;
  reason: BudgetDecisionReason;
  /** Cross-namespace reads by this principal currently in the window. */
  count: number;
  /** Active config snapshot at decision time. */
  limit: {
    softLimit: number;
    hardLimit: number;
    windowMs: number;
  };
}

interface PrincipalBucket {
  /** Epoch-ms timestamps of cross-namespace reads in the active window. */
  timestamps: number[];
}

/**
 * Normalize the provided config against the defaults and reject clearly
 * invalid shapes (non-positive windows, inverted limits). Never throws —
 * returns a safe effective config the limiter can use.
 */
function effectiveConfig(
  raw: CrossNamespaceBudgetConfig | undefined,
): Required<CrossNamespaceBudgetConfig> {
  const base = { ...DEFAULT_CROSS_NAMESPACE_BUDGET };
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
  if (
    typeof raw.softLimit === "number" &&
    Number.isFinite(raw.softLimit) &&
    raw.softLimit >= 0
  ) {
    out.softLimit = Math.floor(raw.softLimit);
  }
  if (
    typeof raw.hardLimit === "number" &&
    Number.isFinite(raw.hardLimit) &&
    raw.hardLimit >= 1
  ) {
    // Floor the value, then defensively require the floored result is
    // still >= 1. `raw.hardLimit = 0.5` previously passed the `> 0`
    // gate and floored to 0, turning a minor misconfiguration into a
    // full denial of cross-namespace reads. Now we fall back to the
    // default instead.
    const floored = Math.floor(raw.hardLimit);
    if (floored >= 1) out.hardLimit = floored;
  }
  if (out.softLimit > out.hardLimit) {
    // Inverted limits -> treat soft = hard so we never warn past the deny
    // threshold. Defensive, should never happen with well-formed config.
    out.softLimit = out.hardLimit;
  }
  return out;
}

function normalizeClock(now: number | undefined): number {
  if (now === undefined) return Date.now();
  if (Number.isFinite(now)) return Math.floor(now);
  return 0;
}

/**
 * In-process cross-namespace budget limiter. Instantiate once per
 * orchestrator / access-service.
 *
 * Threadsafe-by-construction: Node.js is single-threaded per process for
 * application code, and the limiter never awaits between read-modify-write
 * operations on its internal state.
 */
export class CrossNamespaceBudget {
  private readonly config: Required<CrossNamespaceBudgetConfig>;
  private readonly buckets = new Map<string, PrincipalBucket>();

  constructor(config?: CrossNamespaceBudgetConfig) {
    this.config = effectiveConfig(config);
  }

  /** Exposed for tests / audit surfaces. Never mutate the returned value. */
  getConfig(): Required<CrossNamespaceBudgetConfig> {
    return this.config;
  }

  /**
   * Check whether `principal` is allowed to issue another cross-namespace
   * read. Call site is expected to compare `principalNamespace` against
   * `queryNamespace` and only pass through reads where they differ — the
   * limiter treats every call as a cross-namespace event.
   *
   * @param principal Stable identifier for the calling principal (token
   *   subject, session principal, etc.). Must be non-empty.
   * @param now Epoch-ms clock read. Defaults to `Date.now()`; tests pass a
   *   fixed value to step time deterministically.
   */
  record(principal: string, now?: number): BudgetDecision {
    const normalizedNow = normalizeClock(now);
    const { enabled, windowMs, softLimit, hardLimit } = this.config;
    const limit = { softLimit, hardLimit, windowMs };

    if (!enabled) {
      return {
        allowed: true,
        reason: "allowed-no-limit",
        count: 0,
        limit,
      };
    }

    if (typeof principal !== "string" || principal.length === 0) {
      // A missing principal means "we can't attribute this call". Rather
      // than fail open, treat it as a cross-namespace event against a
      // shared bucket — denial-of-service risk is bounded because the
      // bucket is scoped per-process.
      principal = "__anonymous__";
    }

    const bucket = this.buckets.get(principal) ?? { timestamps: [] };
    const cutoff = normalizedNow - windowMs;
    // Drop timestamps that slid out of the window.
    while (bucket.timestamps.length > 0 && bucket.timestamps[0]! < cutoff) {
      bucket.timestamps.shift();
    }

    // Count the current call against the window BEFORE deciding — a call
    // that crosses the deny threshold should itself be denied, not the
    // next one. This is what the threat model calls "fail at the Nth,
    // not the (N+1)th".
    bucket.timestamps.push(normalizedNow);
    this.buckets.set(principal, bucket);
    const count = bucket.timestamps.length;

    if (count > hardLimit) {
      // Denied: roll back the timestamp we just added so a repeated denied
      // call does not push the bucket further into the future. This keeps
      // the limiter stateless with respect to denied attempts.
      bucket.timestamps.pop();
      // Evict empty buckets (e.g. the first record after a long idle
      // rolled the only timestamp out, then got denied and rolled back).
      // Prevents unbounded map growth across many transient principals.
      if (bucket.timestamps.length === 0) {
        this.buckets.delete(principal);
      }
      return {
        allowed: false,
        reason: "deny-over-hard",
        count: bucket.timestamps.length,
        limit,
      };
    }

    if (count > softLimit) {
      return {
        allowed: true,
        reason: "warn-over-soft",
        count,
        limit,
      };
    }

    return {
      allowed: true,
      reason: "allowed-under-soft",
      count,
      limit,
    };
  }

  /**
   * Read-only peek at whether a call would be allowed, WITHOUT recording a
   * timestamp. Useful when the caller must inspect multiple namespaces before
   * deciding to record a single event. The returned `count` reflects the
   * current window state at call time.
   */
  peek(args: {
    principal: string;
    principalNamespace: string;
    queryNamespace: string;
    now?: number;
  }): BudgetDecision {
    const pn = args.principalNamespace;
    const qn = args.queryNamespace;
    const bothPresent =
      typeof pn === "string" && pn.length > 0 &&
      typeof qn === "string" && qn.length > 0;
    if (bothPresent && pn === qn) {
      return {
        allowed: true,
        reason: "allowed-same-namespace",
        count: 0,
        limit: {
          softLimit: this.config.softLimit,
          hardLimit: this.config.hardLimit,
          windowMs: this.config.windowMs,
        },
      };
    }
    // Cross-namespace: simulate what record() would do without the push.
    const { enabled, windowMs, softLimit, hardLimit } = this.config;
    const limit = { softLimit, hardLimit, windowMs };
    if (!enabled) {
      return { allowed: true, reason: "allowed-no-limit", count: 0, limit };
    }
    let principal = args.principal;
    if (typeof principal !== "string" || principal.length === 0) {
      principal = "__anonymous__";
    }
    const now = normalizeClock(args.now);
    const bucket = this.buckets.get(principal) ?? { timestamps: [] };
    const cutoff = now - windowMs;
    let liveCount = 0;
    for (const ts of bucket.timestamps) {
      if (ts >= cutoff) liveCount++;
    }
    const projected = liveCount + 1; // +1 for the current call
    if (projected > hardLimit) {
      return { allowed: false, reason: "deny-over-hard", count: liveCount, limit };
    }
    if (projected > softLimit) {
      return { allowed: true, reason: "warn-over-soft", count: projected, limit };
    }
    return { allowed: true, reason: "allowed-under-soft", count: projected, limit };
  }

  /**
   * Convenience guard that also skips the limiter when `principalNamespace`
   * equals `queryNamespace` (same-namespace is never cross-namespace).
   * Returns an `allowed-same-namespace` decision in that case.
   */
  check(args: {
    principal: string;
    principalNamespace: string;
    queryNamespace: string;
    now?: number;
  }): BudgetDecision {
    // Same-namespace short-circuit requires BOTH namespaces to be
    // non-empty strings. Two empty/undefined namespaces at runtime
    // would otherwise compare equal and fail-open — a critical bypass
    // in a security-critical module. Force the limiter to engage when
    // either side is missing so we never silently skip enforcement.
    const pn = args.principalNamespace;
    const qn = args.queryNamespace;
    const bothPresent =
      typeof pn === "string" && pn.length > 0 &&
      typeof qn === "string" && qn.length > 0;
    if (bothPresent && pn === qn) {
      return {
        allowed: true,
        reason: "allowed-same-namespace",
        count: 0,
        limit: {
          softLimit: this.config.softLimit,
          hardLimit: this.config.hardLimit,
          windowMs: this.config.windowMs,
        },
      };
    }
    return this.record(args.principal, args.now);
  }

  /**
   * Clear all state. Intended for tests and for the orchestrator's
   * lifecycle `before_reset` hook.
   */
  reset(): void {
    this.buckets.clear();
  }

  /**
   * Evict buckets whose entire timestamp list has slid out of the
   * active window by `now`. Intended to be called periodically by a
   * long-lived host process (e.g. from a maintenance cron) that sees
   * many transient principals. Safe to call at any time; returns the
   * number of buckets evicted.
   */
  gc(now?: number): number {
    const normalizedNow = normalizeClock(now);
    const cutoff = normalizedNow - this.config.windowMs;
    let evicted = 0;
    for (const [principal, bucket] of this.buckets.entries()) {
      while (bucket.timestamps.length > 0 && bucket.timestamps[0]! < cutoff) {
        bucket.timestamps.shift();
      }
      if (bucket.timestamps.length === 0) {
        this.buckets.delete(principal);
        evicted++;
      }
    }
    return evicted;
  }

  /** For tests: current number of live buckets. */
  bucketCount(): number {
    return this.buckets.size;
  }
}

/**
 * Global write rate limiter for the access HTTP surface (issue #1937/#2029).
 *
 * Extracted from access-http.ts so the limiter is a cohesive unit (and so the
 * host file stays under its structural ceiling). Deliberately transport-
 * agnostic: it never throws `HttpError` — callers translate a refusal into
 * their own 429. It logs a sampled warning when it refuses a write, so a
 * sustained limit condition is diagnosable server-side instead of only via
 * client warnings (previously the refusal was a bare throw with no trace).
 */

import { log } from "./logger.js";

// Defaults; overridable per instance via the constructor (config/env feed these
// through the server's `writeRateLimit*` settings).
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 30;
// At most one rejection warning per this interval, carrying a rejected-count,
// so a storm is visible without flooding the log.
const LOG_INTERVAL_MS = 10_000;

function sanitizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : fallback;
}

export class WriteRateLimiter {
  readonly maxRequests: number;
  readonly windowMs: number;
  // Rolling window of recorded/reserved write timestamps. Exposed readonly for
  // tests that assert reservation/release accounting.
  readonly slots: Array<{ readonly recordedAt: number }> = [];
  private lastLogAt = 0;
  private suppressed = 0;

  constructor(maxRequests?: number, windowMs?: number) {
    this.maxRequests = sanitizePositiveInteger(maxRequests, DEFAULT_MAX_REQUESTS);
    this.windowMs = sanitizePositiveInteger(windowMs, DEFAULT_WINDOW_MS);
  }

  private prune(now: number): void {
    while (this.slots.length > 0 && now - (this.slots[0]?.recordedAt ?? 0) > this.windowMs) {
      this.slots.shift();
    }
  }

  /** True if a write may proceed. Logs a sampled warning when it may not. */
  hasCapacity(): boolean {
    this.prune(Date.now());
    if (this.slots.length >= this.maxRequests) {
      this.logRejected();
      return false;
    }
    return true;
  }

  /** Record a committed write against the rolling window. */
  record(): void {
    this.slots.push({ recordedAt: Date.now() });
  }

  /**
   * Reserve a slot for an in-flight write. Returns a release function, or
   * `null` when the limit is already reached (caller raises its own 429).
   */
  reserve(): (() => void) | null {
    if (!this.hasCapacity()) return null;
    const slot = { recordedAt: Date.now() };
    this.slots.push(slot);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = this.slots.indexOf(slot);
      if (index >= 0) this.slots.splice(index, 1);
    };
  }

  private logRejected(): void {
    const now = Date.now();
    this.suppressed += 1;
    if (now - this.lastLogAt < LOG_INTERVAL_MS) return;
    const rejected = this.suppressed;
    this.suppressed = 0;
    this.lastLogAt = now;
    log.warn(
      `write_rate_limited: rejected ${rejected} write(s); global limit is ` +
        `${this.maxRequests} per ${this.windowMs}ms. Raise server.writeRateLimitMaxRequests ` +
        `(or REMNIC_WRITE_RATE_LIMIT_MAX_REQUESTS) if sustained.`,
    );
  }
}

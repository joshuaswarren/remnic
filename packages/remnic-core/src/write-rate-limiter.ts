/**
 * Per-principal write rate limiter for the access HTTP surface
 * (issues #1937 / #2029).
 *
 * Extracted from access-http.ts so the limiter is a cohesive unit. Each
 * principal (authenticated caller identity) gets its own rolling-window
 * bucket, so one chatty connector cannot starve writes for the others;
 * requests with no resolved principal share a single global bucket.
 *
 * Deliberately transport-agnostic: it never throws `HttpError` — callers
 * translate a refusal into their own 429. It logs a sampled warning when it
 * refuses a write, so a sustained limit condition is diagnosable server-side
 * (previously the refusal was a bare throw with no trace).
 */

import { log } from "./logger.js";

// Defaults; overridable per instance via the constructor (config/env feed these
// through the server's `writeRateLimit*` settings).
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 30;
// At most one rejection warning per this interval, carrying a rejected-count,
// so a storm is visible without flooding the log.
const LOG_INTERVAL_MS = 10_000;
// Bucket key for requests with no resolved principal.
const GLOBAL_BUCKET = "";

type Slot = { readonly recordedAt: number };

export interface WriteRateLimitReservation {
  commit(): void;
  release(): void;
}

function sanitizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : fallback;
}

export class WriteRateLimiter {
  readonly maxRequests: number;
  readonly windowMs: number;
  // One rolling window per principal. Empty buckets are pruned so the map does
  // not grow without bound.
  private readonly buckets = new Map<string, Slot[]>();
  private readonly inFlight = new Map<string, number>();
  private lastLogAt = 0;
  private suppressed = 0;

  constructor(maxRequests?: number, windowMs?: number) {
    this.maxRequests = sanitizePositiveInteger(maxRequests, DEFAULT_MAX_REQUESTS);
    this.windowMs = sanitizePositiveInteger(windowMs, DEFAULT_WINDOW_MS);
  }

  private key(principal?: string): string {
    return principal?.trim() ? principal.trim() : GLOBAL_BUCKET;
  }

  private prune(slots: Slot[], now: number): void {
    while (slots.length > 0 && now - (slots[0]?.recordedAt ?? 0) >= this.windowMs) {
      slots.shift();
    }
  }

  /** Prune every bucket to the current window; drop buckets that go empty. */
  private sweep(now: number): void {
    for (const [key, slots] of this.buckets) {
      this.prune(slots, now);
      if (slots.length === 0) this.buckets.delete(key);
    }
  }

  /** Committed slots for a principal (test/introspection). */
  slotsFor(principal?: string): ReadonlyArray<Slot> {
    return this.buckets.get(this.key(principal)) ?? [];
  }

  inFlightFor(principal?: string): number {
    return this.inFlight.get(this.key(principal)) ?? 0;
  }

  /** Total live reservations across all principals (test/introspection). */
  totalSlots(): number {
    this.sweep(Date.now());
    let total = 0;
    for (const slots of this.buckets.values()) total += slots.length;
    for (const count of this.inFlight.values()) total += count;
    return total;
  }

  /** True if a write may proceed for the principal. Logs (sampled) when not. */
  hasCapacity(principal?: string): boolean {
    this.sweep(Date.now());
    const key = this.key(principal);
    const slots = this.buckets.get(key);
    if ((slots?.length ?? 0) + (this.inFlight.get(key) ?? 0) >= this.maxRequests) {
      this.logRejected(key);
      return false;
    }
    return true;
  }

  /** Record a committed write against the principal's rolling window. */
  record(principal?: string): void {
    this.sweep(Date.now());
    const key = this.key(principal);
    let slots = this.buckets.get(key);
    if (!slots) {
      slots = [];
      this.buckets.set(key, slots);
    }
    slots.push({ recordedAt: Date.now() });
  }

  /**
   * Reserve a slot for an in-flight write. Commit starts the rolling window
   * when persistence finishes. Release restores capacity after a failed write.
   */
  reserve(principal?: string): WriteRateLimitReservation | null {
    if (!this.hasCapacity(principal)) return null;
    const key = this.key(principal);
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
    let active = true;
    const finish = (committed: boolean) => {
      if (!active) return;
      active = false;
      const count = this.inFlight.get(key) ?? 0;
      if (count <= 1) this.inFlight.delete(key);
      else this.inFlight.set(key, count - 1);
      if (committed) this.record(principal);
    };
    return { commit: () => finish(true), release: () => finish(false) };
  }

  private logRejected(principal: string): void {
    const now = Date.now();
    this.suppressed += 1;
    if (now - this.lastLogAt < LOG_INTERVAL_MS) return;
    const rejected = this.suppressed;
    this.suppressed = 0;
    this.lastLogAt = now;
    const who = principal === GLOBAL_BUCKET ? "(no principal)" : principal;
    log.warn(
      `write_rate_limited: rejected ${rejected} write(s) for principal ${who}; per-principal limit is ${this.maxRequests} per ${this.windowMs}ms. Raise server.writeRateLimitMaxRequests (or REMNIC_WRITE_RATE_LIMIT_MAX_REQUESTS) if sustained.`
    );
  }
}

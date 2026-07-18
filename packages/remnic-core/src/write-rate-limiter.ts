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

function sanitizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : fallback;
}

export class WriteRateLimiter {
  readonly maxRequests: number;
  readonly windowMs: number;
  // One rolling window per principal. Empty buckets are pruned so the map does
  // not grow without bound.
  private readonly buckets = new Map<string, Slot[]>();
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
    while (slots.length > 0 && now - (slots[0]?.recordedAt ?? 0) > this.windowMs) {
      slots.shift();
    }
  }

  /** Live reservation/record count for a principal (test/introspection). */
  slotsFor(principal?: string): ReadonlyArray<Slot> {
    return this.buckets.get(this.key(principal)) ?? [];
  }

  /** Total live reservations across all principals (test/introspection). */
  totalSlots(): number {
    let total = 0;
    for (const slots of this.buckets.values()) total += slots.length;
    return total;
  }

  /** True if a write may proceed for the principal. Logs (sampled) when not. */
  hasCapacity(principal?: string): boolean {
    const key = this.key(principal);
    const slots = this.buckets.get(key);
    if (!slots) return true;
    this.prune(slots, Date.now());
    if (slots.length === 0) {
      this.buckets.delete(key);
      return true;
    }
    if (slots.length >= this.maxRequests) {
      this.logRejected(key);
      return false;
    }
    return true;
  }

  /** Record a committed write against the principal's rolling window. */
  record(principal?: string): void {
    const key = this.key(principal);
    const slots = this.buckets.get(key) ?? this.buckets.set(key, []).get(key)!;
    slots.push({ recordedAt: Date.now() });
  }

  /**
   * Reserve a slot for an in-flight write. Returns a release function, or
   * `null` when the principal is already at the limit (caller raises its 429).
   */
  reserve(principal?: string): (() => void) | null {
    if (!this.hasCapacity(principal)) return null;
    const key = this.key(principal);
    const slots = this.buckets.get(key) ?? this.buckets.set(key, []).get(key)!;
    const slot: Slot = { recordedAt: Date.now() };
    slots.push(slot);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.buckets.get(key);
      if (!current) return;
      const index = current.indexOf(slot);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) this.buckets.delete(key);
    };
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
      `write_rate_limited: rejected ${rejected} write(s) for principal ${who}; ` +
        `per-principal limit is ${this.maxRequests} per ${this.windowMs}ms. Raise ` +
        `server.writeRateLimitMaxRequests (or REMNIC_WRITE_RATE_LIMIT_MAX_REQUESTS) if sustained.`,
    );
  }
}

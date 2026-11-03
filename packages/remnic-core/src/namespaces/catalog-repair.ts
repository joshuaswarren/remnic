/**
 * Single-flight gate for the malformed-catalog repair (#3298 review), extracted
 * from catalog.ts so that file stays under its structural-ratchet ceiling
 * (issue #1995). Pure scheduling state plus the quarantine-sidecar path helper.
 */

/** After a dropped attempt, wait this long before another read may schedule one. */
export const MALFORMED_REPAIR_DROP_BACKOFF_MS = 250;

/**
 * Bounds repairs triggered by malformed reads (#3298 review): one attempt in
 * flight at a time, and a short backoff after an attempt was dropped (another
 * process held the lock). The guard is what stops concurrent malformed reads
 * from queueing serial lock waits ahead of touch(); the 5 s lock wait is itself
 * the rate limiter under sustained contention, which is why the backoff is
 * short — a longer window would delay the legitimate warm-cache retry after
 * contention clears. A fast failure holds no lock budget and does not back off.
 */
export class MalformedCatalogRepairGate {
  private inFlight: Promise<void> | undefined;
  private nextAttemptAt = 0;
  private attempts = 0;

  /** Test-only observability: attempts that actually entered the gate. */
  get attemptCount(): number {
    return this.attempts;
  }

  /**
   * Run `attempt` unless one is already in flight or the backoff window is on.
   * Resolves when the attempt settles; never rejects (the repair is fail-open).
   */
  run(attempt: () => Promise<"repaired" | "dropped" | "failed">): Promise<void> {
    if (this.inFlight || Date.now() < this.nextAttemptAt) return Promise.resolve();
    this.attempts += 1;
    this.inFlight = (async () => {
      let outcome: "repaired" | "dropped" | "failed" = "failed";
      try {
        outcome = await attempt();
      } catch {
        outcome = "failed";
      } finally {
        this.inFlight = undefined;
        if (outcome === "dropped") {
          this.nextAttemptAt = Date.now() + MALFORMED_REPAIR_DROP_BACKOFF_MS;
        }
      }
    })();
    return this.inFlight;
  }
}

/**
 * Quarantine sidecar path for the rows a repair drops (#3298 review): named by a
 * hash of the dropped lines, so repeated attempts over the same bad rows reuse
 * one file instead of piling one sidecar per failed attempt.
 */
export function malformedSidecarPath(catalogPath: string, dropped: string[]): string {
  return `${catalogPath}.malformed-${contentHash(dropped.join("\n"))}`;
}

// FNV-1a over the UTF-8 bytes; stable across processes, no dependency, and only
// used to name a file (not to authenticate content).
function contentHash(input: string): string {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(input, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0") + Buffer.byteLength(input, "utf8").toString(16).padStart(8, "0");
}

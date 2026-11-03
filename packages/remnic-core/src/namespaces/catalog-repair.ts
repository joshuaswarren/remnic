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
import { createHash } from "node:crypto";

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
    // Start the attempt as a microtask so run() returns before any of its work
    // begins, keeping the guard decision synchronous for every caller.
    this.inFlight = Promise.resolve().then(async () => {
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
    });
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

// sha256 of the dropped lines, truncated for a filename; stable across processes.
function contentHash(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16);
}


import { createHash } from "node:crypto";

/** After a dropped attempt, wait this long before another read may schedule one. */
export const MALFORMED_REPAIR_DROP_BACKOFF_MS = 250;

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

export function malformedSidecarPath(catalogPath: string, dropped: string[]): string {
  return `${catalogPath}.malformed-${contentHash(dropped.join("\n"))}`;
}

function contentHash(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16);
}

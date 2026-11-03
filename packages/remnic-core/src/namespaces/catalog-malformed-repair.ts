/**
 * Repair runner for the namespace catalog's malformed-row rewrite (#3297, #3298).
 * Extracted from catalog.ts to keep the catalog class under its file-size ceiling.
 * Data safety lives in the caller's contract: the locked re-read must reach the end
 * of the file with malformed rows skipped AND leave at least one readable row; a
 * failed re-read folds to an empty map and is never written.
 */
import type { NamespaceRecord } from "./catalog.js";
import type { CatalogReadHealth } from "./catalog.js";
const MALFORMED_REPAIR_DROP_BACKOFF_MS = 250;
import { writeFile } from "node:fs/promises";
import { REBUILD_LOCK_MAX_WAIT_MS } from "./catalog.js";

/** Everything the repair needs from the catalog instance, stated as a port. */
export interface CatalogRepairPort {
  catalogPath: string;
  queueCritical<T>(task: () => Promise<T>): Promise<T>;
  withHeldCatalogLock<T>(fn: (acquired: boolean) => Promise<T>): Promise<T>;
  loadCompacted(forceFresh: boolean, health: CatalogReadHealth): Promise<Map<string, NamespaceRecord>>;
  rewriteUnchained(records: NamespaceRecord[]): Promise<void>;
  writeFile(path: string, body: string): Promise<void>;
}

/** Per-instance single-flight/backoff state, owned by the catalog instance. */
export interface CatalogRepairState {
  inFlight: Promise<unknown> | undefined;
  nextAttemptAt: number;
  attemptCount: number;
}

/**
 * Run the malformed-catalog repair: under the held catalog lock, re-read the file
 * and rewrite it without the malformed rows when the re-read confirms them.
 *
 * Single-flight (#3298 review): concurrent malformed reads must produce ONE repair,
 * because each queued repair occupies the serialized critical-section queue for a
 * full lock-wait window ahead of touch(). A dropped attempt (the lock was held by
 * another process for the whole wait) backs off briefly so malformed reads cannot
 * queue serial lock waits; a fast failure holds no backoff, so the next incomplete
 * read retries it as before.
 *
 * Outcome: "repaired" (the rewrite ran), "dropped" (the lock stayed held for the
 * whole wait), or "failed" (the re-read did not confirm a repairable catalog, or
 * the rewrite threw).
 */
export async function repairMalformedCatalog(
  port: CatalogRepairPort,
  state: CatalogRepairState,
): Promise<"repaired" | "dropped" | "failed"> {
  if (state.inFlight || Date.now() < state.nextAttemptAt) return "dropped";
  state.attemptCount += 1;
  let outcome: "repaired" | "dropped" | "failed" = "failed";
  state.inFlight = (async () => {
    try {
      outcome = await port.queueCritical(async () =>
        port.withHeldCatalogLock(async (acquired) => {
          if (!acquired) return "dropped";
          const health: CatalogReadHealth = { malformedLines: [] };
          const folded = await port.loadCompacted(true, health);
          if (health.malformed !== true || folded.size === 0) return "failed";
          // Quarantine the rows the rewrite drops before the rename, so nothing is
          // lost silently. Best-effort like the repair itself: a failed sidecar
          // write must not leave a stuck malformed catalog unrepaired.
          const dropped = health.malformedLines ?? [];
          if (dropped.length > 0) {
            const sidecar = `${port.catalogPath}.malformed-${Date.now()}`;
            await port.writeFile(sidecar, dropped.join("\n") + "\n").catch(() => undefined);
          }
          await port.rewriteUnchained([...folded.values()]);
          return "repaired";
        }),
      );
    } catch {
      outcome = "failed";
    } finally {
      state.inFlight = undefined;
      if (outcome === "dropped") {
        state.nextAttemptAt = Date.now() + MALFORMED_REPAIR_DROP_BACKOFF_MS;
      }
    }
  })();
  await state.inFlight;
  return outcome;
}

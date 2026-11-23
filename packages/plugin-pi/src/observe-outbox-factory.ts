import path from "node:path";
import { ObserveOutbox } from "./outbox.js";
import type { RemnicPiConfig } from "./config.js";
import { resolvePiAgentHome } from "./paths.js";

/** One durable outbox per extension instance; extracted to keep index.ts under
 * the 1200-LOC cap (#1995). */
export function newObserveOutbox(config: RemnicPiConfig): ObserveOutbox {
  return new ObserveOutbox(
    config.observeOutboxPath?.trim() || path.join(resolvePiAgentHome(process.env), "remnic", "observe-outbox.jsonl"),
    { maxEntries: config.observeOutboxMaxEntries },
  );
}

import path from "node:path";
import { ObserveOutbox } from "./outbox.js";
import type { RemnicPiConfig } from "./config.js";
import { resolvePiAgentHome } from "./paths.js";

export function newObserveOutbox(config: RemnicPiConfig): ObserveOutbox {
  return new ObserveOutbox(
    config.observeOutboxPath?.trim() || path.join(resolvePiAgentHome(process.env), "remnic", "observe-outbox.jsonl"),
    { maxEntries: config.observeOutboxMaxEntries },
  );
}

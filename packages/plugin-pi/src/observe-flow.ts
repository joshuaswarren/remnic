import type { RemnicClient, ObserveMessage, ObserveOptions } from "./client.js";
import type { RemnicPiConfig } from "./config.js";
import { hashObservedMessage, toObserveMessage } from "./messages.js";
import type { DrainOptions, ObserveOutbox } from "./outbox.js";

/** Minimal session surface the outbox drain needs. */
export type OutboxSession = { notify: (message: string, level: "info" | "success" | "warning" | "error") => void };

export const MAX_OBSERVED_HASHES = 2000;

export function rememberObservedHash(observedHashes: Set<string>, hash: string): void {
  if (observedHashes.has(hash)) return;
  while (observedHashes.size >= MAX_OBSERVED_HASHES) {
    const oldest = observedHashes.keys().next().value;
    if (typeof oldest !== "string") break;
    observedHashes.delete(oldest);
  }
  observedHashes.add(hash);
}

export function rememberLiveObservedReplayKey(liveObservedReplayKeys: Map<string, number>, key: string): void {
  liveObservedReplayKeys.set(key, (liveObservedReplayKeys.get(key) ?? 0) + 1);
}

function consumeLiveObservedReplayKey(liveObservedReplayKeys: Map<string, number>, key: string): boolean {
  const count = liveObservedReplayKeys.get(key) ?? 0;
  if (count <= 0) return false;
  if (count === 1) liveObservedReplayKeys.delete(key);
  else liveObservedReplayKeys.set(key, count - 1);
  return true;
}

export function skipLiveObservedReplayMessages(
  sessionKey: string,
  rawMessages: unknown[],
  liveObservedReplayKeys: Map<string, number>,
): unknown[] {
  if (liveObservedReplayKeys.size === 0) return rawMessages;
  const unobserved: unknown[] = [];
  for (const raw of rawMessages) {
    const message = toObserveMessage(raw);
    if (message && consumeLiveObservedReplayKey(liveObservedReplayKeys, liveReplayKey(message, sessionKey))) {
      continue;
    }
    unobserved.push(raw);
  }
  return unobserved;
}

export function liveReplayKey(message: ObserveMessage, sessionKey: string): string {
  return hashObservedMessage(message, sessionKey, "live-replay");
}


/**
 * Replay queued observe entries in order under their per-entry
 * idempotency keys. Bounded attempts per drain; undelivered entries stay
 * queued and the shortfall is surfaced, never silently dropped.
 */
export async function drainObserveOutbox(
  session: OutboxSession,
  client: RemnicClient,
  config: RemnicPiConfig,
  outbox: ObserveOutbox,
  observedHashes: Set<string>,
  liveObservedReplayKeys?: Map<string, number>,
  startup = false,
): Promise<void> {
  const drainOptions: DrainOptions = { notify: (message, level) => session.notify(message, level) };
  if (startup) drainOptions.maxAttempts = 1;
  const result = await outbox.drain(async (entry) => {
    const observeOptions: ObserveOptions = {
      timeoutMs: config.turnRequestTimeoutMs,
      replayNonce: entry.replayNonce ?? entry.id,
    };
    if (startup) observeOptions.maxRetries = 0;
    await client.observe(entry.sessionKey, entry.cwd, entry.messages, observeOptions);
    // Delivered: remember identity so later turns and the shutdown replay skip these.
    for (const hash of entry.messageHashes) {
      if (hash !== null) rememberObservedHash(observedHashes, hash);
    }
    if (liveObservedReplayKeys) {
      for (const message of entry.messages) {
        rememberLiveObservedReplayKey(liveObservedReplayKeys, liveReplayKey(message, entry.sessionKey));
      }
    }
  }, drainOptions);
  if (result.pending > 0) {
    session.notify(
      `Remnic observe outbox: ${result.pending} queued capture(s) still pending (daemon saturated); they will retry on the next successful contact`,
      "warning",
    );
  }
}


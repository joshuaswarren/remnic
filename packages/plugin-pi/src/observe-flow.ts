import type { RemnicClient, ObserveMessage, ObserveOptions } from "./client.js";
import type { RemnicPiConfig } from "./config.js";
import { hashObservedMessage, toObserveMessage } from "./messages.js";
import type { DrainOptions, ObserveOutbox } from "./outbox.js";

/** Minimal session surface the outbox drain needs. */
export type OutboxSession = { notify: (message: string, level: "info" | "success" | "warning" | "error") => void };

export const MAX_OBSERVED_HASHES = 2000;

/** Longest a session-start or shutdown replay attempt may take. */
const STARTUP_DRAIN_ATTEMPT_MS = 3000;

export function rememberObservedHash(observedHashes: Set<string>, hash: string): void {
  if (observedHashes.has(hash)) return;
  while (observedHashes.size >= MAX_OBSERVED_HASHES) {
    const oldest = observedHashes.keys().next();
    if (oldest.done) break;
    observedHashes.delete(oldest.value);
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
  bounded = false,
): Promise<void> {
  const drainOptions: DrainOptions = { notify: (message, level) => session.notify(message, level) };
  if (bounded) drainOptions.maxAttempts = 1;
  const result = await outbox.drain(async (entry) => {
    const observeOptions: ObserveOptions = {
      timeoutMs: config.turnRequestTimeoutMs,
      replayNonce: entry.replayNonce ?? entry.id,
    };
    if (bounded) {
      observeOptions.maxRetries = 0;
      // One cheap attempt: never let a hanging daemon hold session start or shutdown for a full turn budget.
      observeOptions.timeoutMs = Math.min(config.turnRequestTimeoutMs, STARTUP_DRAIN_ATTEMPT_MS);
    }
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

/** Background drains per outbox, so callers (shutdown, tests) can wait for them. */
const inFlightDrains = new WeakMap<ObserveOutbox, Set<Promise<void>>>();

/**
 * Replay queued entries after a successful live observe. The returned promise never rejects;
 * live hooks ignore it (background), shutdown awaits it (`bounded`: no retries or backoff).
 *
 * In the BACKGROUND case: The live
 * hook must neither wait for the drain (retries and Retry-After sleeps can add up to
 * about 84 s against the host's ~30 s handler window) nor see its failures: a drain
 * problem is reported as an outbox warning and never re-queues the live turns, which
 * the daemon already accepted. `OutboxSession.notify` may throw once the UI is gone,
 * so the report itself is guarded.
 */
export function startObserveOutboxDrain(
  session: OutboxSession,
  client: RemnicClient,
  config: RemnicPiConfig,
  outbox: ObserveOutbox,
  observedHashes: Set<string>,
  liveObservedReplayKeys?: Map<string, number>,
  bounded = false,
): Promise<void> {
  const run: Promise<void> = drainObserveOutbox(session, client, config, outbox, observedHashes, liveObservedReplayKeys, bounded)
    .catch((err: Error) => {
      try {
        // The drain only throws Errors (lock timeout, write failure); coerce defensively for the message.
        session.notify(`Remnic observe outbox drain failed: ${String(err.message ?? err)}`, "warning");
      } catch {
        // The session UI is gone; the queue itself is untouched and replays next time.
      }
    })
    .finally(() => {
      inFlightDrains.get(outbox)?.delete(run);
    });
  const running = inFlightDrains.get(outbox) ?? new Set<Promise<void>>();
  running.add(run);
  inFlightDrains.set(outbox, running);
  return run;
}

/** Resolves when every background drain started for this outbox has finished. */
export async function settleObserveOutboxDrain(outbox: ObserveOutbox): Promise<void> {
  const running = inFlightDrains.get(outbox);
  if (running) await Promise.all([...running]);
}

import type { RemnicClient, ObserveMessage, ObserveOptions } from "./client.js";
import type { RemnicPiConfig } from "./config.js";
import { hashObservedMessage, toObserveMessage } from "./messages.js";
import { classifyObserveFailure, type DrainOptions, type ObserveFailureClass, type ObserveOutbox } from "./outbox.js";

/** Minimal session surface the outbox drain needs. */
export type OutboxSession = { notify: (message: string, level: "info" | "success" | "warning" | "error") => void };

/**
 * The dedup state a delivered outbox entry is recorded into. Delivered
 * identities belong to the session that WROTE the entry, resolved live by
 * `stateForSession`; an entry whose session is gone records nowhere rather
 * than polluting the drainer's set with keys that can never match (#3381).
 */
export type OutboxDrainTarget = {
  observedHashes: Set<string>;
  liveObservedReplayKeys?: Map<string, number>;
};

export const MAX_OBSERVED_HASHES = 2000;

/** Longest a session-start or shutdown replay attempt may take. */
const STARTUP_DRAIN_ATTEMPT_MS = 3000;

/** Longest the session_start hook waits for its replay before moving on. */
const STARTUP_DRAIN_BUDGET_MS = 3000;

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
  stateForSession?: (sessionKey: string) => OutboxDrainTarget | undefined,
): Promise<void> {
  const drainOptions: DrainOptions = {
    notify: (message, level) => session.notify(message, level),
    // Entries enqueued for a different daemon stay queued for it (#3381).
    destination: config.remnicDaemonUrl,
  };
  if (bounded) drainOptions.maxAttempts = 1;
  // Why the drain stopped, from the last send. The drain stops on the first
  // 401/403 and already tells the user to fix the credentials (#3381).
  let stopReason: ObserveFailureClass | undefined;
  const result = await outbox.drain(async (entry) => {
    const observeOptions: ObserveOptions = {
      timeoutMs: config.turnRequestTimeoutMs,
      replayNonce: entry.replayNonce ?? entry.id,
    };
    // The entry keeps its original writer's principal; this drainer's own
    // config.principal is only the fallback for pre-field entries.
    if (entry.principal !== undefined) observeOptions.principal = entry.principal;
    if (bounded) {
      observeOptions.maxRetries = 0;
      // One cheap attempt: never let a hanging daemon hold session start or shutdown for a full turn budget.
      observeOptions.timeoutMs = Math.min(config.turnRequestTimeoutMs, STARTUP_DRAIN_ATTEMPT_MS);
    }
    try {
      await client.observe(entry.sessionKey, entry.cwd, entry.messages, observeOptions);
      stopReason = undefined;
    } catch (err) {
      stopReason = err instanceof Error ? classifyObserveFailure(err) : "retry-ambiguous";
      throw err;
    }
    // Delivered: remember identity so later turns and the shutdown replay skip
    // these. The hashes and replay keys embed the entry's OWN sessionKey, so
    // they are recorded in that session's state (#3381): a drain running under
    // another session must not file them in its own set, where they can never
    // match, while the writer's shutdown resends the same turns under a new
    // nonce. A writer session that is not live has no in-memory state to teach;
    // its persisted hashes cannot be written from here, so nothing is recorded.
    const target = stateForSession ? stateForSession(entry.sessionKey) : { observedHashes, liveObservedReplayKeys };
    if (target) {
      for (const hash of entry.messageHashes) {
        if (hash !== null) rememberObservedHash(target.observedHashes, hash);
      }
      if (target.liveObservedReplayKeys) {
        for (const message of entry.messages) {
          rememberLiveObservedReplayKey(target.liveObservedReplayKeys, liveReplayKey(message, entry.sessionKey));
        }
      }
    }
  }, drainOptions);
  // Entries bound to another daemon are pending for IT, not saturation here.
  const pendingForUs = result.pending - (result.foreign ?? 0);
  if (pendingForUs > 0 && !result.skipped && stopReason !== "blocked") {
    session.notify(
      `Remnic observe outbox: ${pendingForUs} queued capture(s) still pending (daemon saturated); they will retry on the next successful contact`,
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
  stateForSession?: (sessionKey: string) => OutboxDrainTarget | undefined,
): Promise<void> {
  const run: Promise<void> = drainObserveOutbox(session, client, config, outbox, observedHashes, liveObservedReplayKeys, bounded, stateForSession)
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

/**
 * Session-start replay: one bounded attempt that can neither reject the `session_start`
 * hook nor hold it past `STARTUP_DRAIN_BUDGET_MS`. The drain has its own catch (via
 * startObserveOutboxDrain); if it is still running at the deadline (a locked outbox file,
 * a hanging daemon) the hook moves on and the drain finishes in the background.
 */
export async function drainObserveOutboxAtStartup(
  session: OutboxSession,
  client: RemnicClient,
  config: RemnicPiConfig,
  outbox: ObserveOutbox,
  observedHashes: Set<string>,
  liveObservedReplayKeys?: Map<string, number>,
  stateForSession?: (sessionKey: string) => OutboxDrainTarget | undefined,
): Promise<void> {
  const drain = startObserveOutboxDrain(session, client, config, outbox, observedHashes, liveObservedReplayKeys, true, stateForSession);
  const { promise: deadline, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, STARTUP_DRAIN_BUDGET_MS);
  timer.unref();
  try {
    await Promise.race([drain, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

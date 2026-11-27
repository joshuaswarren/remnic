/**
 * Trace recording + replay for the operator console (issue #688 PR 3/3).
 *
 * This module is the I/O layer that bridges the live console surface
 * (PR 2/3, `runConsoleTui`) with an offline replay mode. Operators can:
 *
 *   - `remnic console --record-trace <path>`: append every refresh
 *     cycle's `ConsoleStateSnapshot` to a JSONL file at `<path>` (one
 *     snapshot per line), so the engine state can be reviewed later.
 *
 *   - `remnic console --trace <path> [--speed N]`: read the JSONL file
 *     frame-by-frame, recompute the inter-frame delay from the
 *     captured `capturedAt` timestamps (divided by `speed`), and feed
 *     each frame into the same `renderFrame` function the live TUI
 *     uses. EOF exits cleanly.
 *
 * Design contract:
 *   - Replay reuses `renderFrame` (NOT a parallel reimplementation).
 *     Live and replay must look identical for the same snapshot.
 *   - Replay is fully sandboxed: no orchestrator instance is required,
 *     no filesystem reads beyond the trace file itself.
 *   - Recording is cheap: one `JSON.stringify` + a single
 *     `\n`-delimited append per snapshot. A failed write logs once and
 *     disables further writes; the live loop must NOT crash.
 *   - Speed multiplier `N`: positive finite. `N=2` halves the delay,
 *     `N=0.5` doubles it. `Infinity` is permitted and means "no
 *     delay" (back-to-back frames).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createReadStream } from "node:fs";
import type { Writable } from "node:stream";
import { sleepAbortable } from "../utils/sleep.js";

import { renderFrame } from "./tui.js";
import type { ConsoleStateSnapshot } from "./state.js";

const ANSI_CLEAR_HOME = "\x1b[2J\x1b[H";
const ANSI_HIDE_CURSOR = "\x1b[?25l";
const ANSI_SHOW_CURSOR = "\x1b[?25h";

/**
 * Default delay (ms) used when the trace file has fewer than two
 * frames OR the captured timestamps don't yield a valid delta. Mirrors
 * the live TUI's default refresh interval for visual consistency.
 */
const DEFAULT_REPLAY_DELAY_MS = 2000;

const MAX_REPLAY_DELAY_MS = 60_000;

const MIN_REPLAY_DELAY_MS = 0;

export interface TraceRecorder {
  /**
   * Append a snapshot to the trace file. Returns a promise that
   * resolves once the line is flushed. Errors are surfaced via
   * `getLastError()` rather than thrown — the live TUI must never
   * crash because tracing failed.
   */
  append: (snapshot: ConsoleStateSnapshot) => Promise<void>;
  /**
   * Close the underlying file handle. Idempotent.
   *
   * The optional `signal` parameter is forwarded from
   * `flushWithTimeout` when the deadline wins the race. When the
   * signal fires, the pending write-chain drain is abandoned and the
   * file handle is closed immediately, releasing OS resources instead
   * of leaving the handle open until the orphaned writeChain resolves.
   */
  close: (signal?: AbortSignal) => Promise<void>;
  getLastError: () => string | null;
}

export interface OpenTraceRecorderOptions {
  /**
   * If true (default), `path` is created with `mkdir -p` on its
   * parent directory before the first append. Set to false in tests
   * that pre-create the parent.
   */
  ensureParentDir?: boolean;
}

/**
 * Open (create or append to) a JSONL trace recorder at `filePath`.
 * Each call to `recorder.append(snapshot)` writes
 * `JSON.stringify(snapshot) + "\n"`. Concurrent appends are
 * serialized through an internal write chain so partial-line
 * interleaving cannot occur.
 */
export async function openTraceRecorder(
  filePath: string,
  options: OpenTraceRecorderOptions = {},
): Promise<TraceRecorder> {
  const ensureParentDir = options.ensureParentDir ?? true;
  if (ensureParentDir) {
    const parent = path.dirname(filePath);
    if (parent && parent !== "." && parent !== "/") {
      await fs.mkdir(parent, { recursive: true });
    }
  }
  const handle = await fs.open(filePath, "a");
  let closed = false;
  let lastError: string | null = null;
  let writeChain: Promise<void> = Promise.resolve();
  const queueWrite = (line: string): Promise<void> => {
    const next = writeChain.then(async () => {
      if (closed) return;
      try {
        await handle.write(line);
      } catch (err) {
        const msg = describeError(err);
        lastError = msg;
        throw err;
      }
    });
    writeChain = next.catch(() => {
      // Recovery: reset the chain so a single transient failure does
      // not poison every subsequent append. The original error is
      // already captured in `lastError` AND was surfaced to the
      // caller via the awaited `next` promise above.
    });
    return next;
  };
  return {
    append: async (snapshot: ConsoleStateSnapshot) => {
      if (closed) return;
      let line: string;
      try {
        line = JSON.stringify(snapshot) + "\n";
      } catch (err) {
        lastError = `serialize failed: ${describeError(err)}`;
        return;
      }
      try {
        await queueWrite(line);
      } catch {
        // already captured in lastError via queueWrite
      }
    },
    close: async (signal?: AbortSignal) => {
      if (closed) return;
      try {
        if (signal) {
          await Promise.race([
            writeChain,
            new Promise<void>((_, reject) => {
              if (signal.aborted) {
                reject(makeAbortError());
                return;
              }
              signal.addEventListener("abort", () => reject(makeAbortError()), {
                once: true,
              });
            }),
          ]);
        } else {
          await writeChain;
        }
      } catch {
        // ignore — abort or I/O error already in lastError
      }
      closed = true;
      try {
        await handle.close();
      } catch (err) {
        lastError = describeError(err);
      }
    },
    getLastError: () => lastError,
  };
}

export interface ReplayTraceOptions {
  /** Output stream. Defaults to `process.stdout`. */
  output?: Writable;
  /**
   * Speed multiplier. `1` = original cadence, `2` = twice as fast,
   * `0.5` = half speed. `Infinity` is permitted and means "no
   * delay" (back-to-back frames). Defaults to 1.
   */
  speed?: number;
  /**
   * Override the inter-frame delay function — primarily for tests so
   * we can swap `setTimeout` for an instant resolver. The function
   * receives the *raw* (already-speed-adjusted) delay in ms.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Hide / show the terminal cursor during replay. Defaults to true.
   * Tests typically pass false so they don't pollute captured output
   * with cursor-control escapes.
   */
  manageCursor?: boolean;
  /**
   * Optional clock injection — feeds `renderFrame`'s "current time"
   * value during replay. By default, replay uses the snapshot's own
   * `capturedAt` so the rendered timestamp matches the original
   * frame. Tests override this for determinism.
   */
  now?: (snapshot: ConsoleStateSnapshot, frameIndex: number) => number;
  /**
   * Abort signal. If aborted mid-replay, the loop exits cleanly at
   * the next frame boundary.
   */
  signal?: AbortSignal;
}

export interface ReplayTraceResult {
  framesRendered: number;
  /** Frames skipped because they could not be parsed. */
  framesSkipped: number;
  /** Last snapshot that was rendered, or null if the file was empty. */
  lastSnapshot: ConsoleStateSnapshot | null;
}

/**
 * Replay a JSONL trace file frame-by-frame. Each line is parsed,
 * optionally renders via `renderFrame`, then waits the speed-adjusted
 * delay before the next frame. Returns once EOF is reached or the
 * abort signal fires.
 */
export async function replayTrace(
  filePath: string,
  options: ReplayTraceOptions = {},
): Promise<ReplayTraceResult> {
  const output: Writable = options.output ?? process.stdout;
  const speed = normalizeSpeed(options.speed);
  const sleep =
    options.sleep ?? ((ms: number) => sleepAbortable(ms, options.signal));
  const manageCursor = options.manageCursor ?? true;
  const nowFn =
    options.now ??
    ((snapshot: ConsoleStateSnapshot) => {
      const ms = Date.parse(snapshot.capturedAt);
      return Number.isFinite(ms) ? ms : Date.now();
    });

  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let framesRendered = 0;
  let framesSkipped = 0;
  let lastSnapshot: ConsoleStateSnapshot | null = null;
  let prevCapturedMs: number | null = null;

  if (manageCursor) safeWrite(output, ANSI_HIDE_CURSOR);

  try {
    for await (const rawLine of rl) {
      if (options.signal?.aborted) break;
      const line = rawLine.trim();
      if (line.length === 0) continue;
      const snapshot = parseSnapshotLine(line);
      if (snapshot === null) {
        framesSkipped += 1;
        continue;
      }

      const capturedMs = Date.parse(snapshot.capturedAt);
      let waitMs = 0;
      if (prevCapturedMs !== null && Number.isFinite(capturedMs)) {
        const rawDelta = capturedMs - prevCapturedMs;
        waitMs = computeReplayDelay(rawDelta, speed);
      } else if (prevCapturedMs !== null) {
        waitMs = computeReplayDelay(DEFAULT_REPLAY_DELAY_MS, speed);
      }
      if (waitMs > 0) {
        try {
          await sleep(waitMs);
        } catch (err) {
          if (isAbortError(err) || options.signal?.aborted) break;
          throw err;
        }
        if (options.signal?.aborted) break;
      }

      let frame: string;
      try {
        frame = renderFrame({
          snapshot,
          renderError: null,
          now: () => nowFn(snapshot, framesRendered),
        });
      } catch (err) {
        frame = `remnic console replay: render failed: ${describeError(err)}\n`;
      }
      safeWrite(output, ANSI_CLEAR_HOME);
      safeWrite(output, frame);

      framesRendered += 1;
      lastSnapshot = snapshot;
      if (Number.isFinite(capturedMs)) prevCapturedMs = capturedMs;
    }
  } finally {
    rl.close();
    stream.close();
    if (manageCursor) safeWrite(output, ANSI_SHOW_CURSOR);
  }

  return { framesRendered, framesSkipped, lastSnapshot };
}

/**
 * Parse a single JSONL line into a `ConsoleStateSnapshot`. Returns
 * null for malformed lines so the replay loop can keep going. We
 * validate the minimum nested shape the renderer dereferences. The trace file
 * format is best-effort, but partial objects are skipped rather than counted as
 * rendered frames that only display renderer failures.
 */
export function parseSnapshotLine(line: string): ConsoleStateSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  // Common Gotcha #18: JSON.parse('null') succeeds but null is not a
  // valid snapshot. Always check the result type.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  if (!isConsoleStateSnapshot(parsed)) {
    return null;
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConsoleStateSnapshot(value: unknown): value is ConsoleStateSnapshot {
  if (!isRecord(value)) return false;
  if (typeof value.capturedAt !== "string") return false;

  const bufferState = value.bufferState;
  if (!isRecord(bufferState)) return false;
  if (typeof bufferState.turnsCount !== "number") return false;
  if (typeof bufferState.byteCount !== "number") return false;

  const extractionQueue = value.extractionQueue;
  if (!isRecord(extractionQueue)) return false;
  if (typeof extractionQueue.depth !== "number") return false;
  if (!Array.isArray(extractionQueue.recentVerdicts)) return false;

  if (!Array.isArray(value.dedupRecent)) return false;
  if (!Array.isArray(value.maintenanceLedgerTail)) return false;

  const qmdProbe = value.qmdProbe;
  if (!isRecord(qmdProbe)) return false;
  if (typeof qmdProbe.available !== "boolean") return false;
  if (typeof qmdProbe.daemonMode !== "boolean") return false;
  if (typeof qmdProbe.debug !== "string") return false;

  const daemon = value.daemon;
  if (!isRecord(daemon)) return false;
  if (typeof daemon.uptimeMs !== "number") return false;
  if (typeof daemon.version !== "string") return false;

  return Array.isArray(value.errors);
}

/**
 * Compute the speed-adjusted, clamped inter-frame delay. Exposed for
 * tests so we can assert the speed math without a real timer.
 *
 * - `rawDeltaMs` is the captured-time difference between two frames
 *   (may be negative if the trace went back in time — clamped to 0).
 * - `speed` must be a positive finite number OR `Infinity` (treated
 *   as "no delay"). Non-positive / NaN values are normalized to 1
 *   upstream so this function never sees them.
 */
export function computeReplayDelay(rawDeltaMs: number, speed: number): number {
  if (!Number.isFinite(rawDeltaMs)) return 0;
  if (rawDeltaMs <= 0) return 0;
  if (!Number.isFinite(speed)) return 0; // Infinity → no delay.
  const adjusted = rawDeltaMs / speed;
  if (!Number.isFinite(adjusted)) return 0;
  if (adjusted <= MIN_REPLAY_DELAY_MS) return MIN_REPLAY_DELAY_MS;
  if (adjusted > MAX_REPLAY_DELAY_MS) return MAX_REPLAY_DELAY_MS;
  return adjusted;
}

/**
 * Coerce a user-provided `--speed` value into a valid positive
 * multiplier. Common Gotchas #28 / #36: CLI values arrive as strings,
 * and `"false"` / `"0"` are truthy. Always convert + validate at the
 * input boundary. Throws on invalid input so the CLI surfaces a
 * helpful error message instead of silently defaulting (Common
 * Gotcha #51).
 */
export function parseSpeedFlag(raw: unknown): number {
  if (raw === undefined || raw === null) return 1;
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num) && num !== Infinity) {
    throw new Error(
      `invalid --speed value: ${JSON.stringify(raw)} (must be a positive number)`,
    );
  }
  if (num <= 0) {
    throw new Error(
      `invalid --speed value: ${JSON.stringify(raw)} (must be > 0)`,
    );
  }
  return num;
}

function normalizeSpeed(speed: number | undefined): number {
  if (speed === undefined) return 1;
  if (!Number.isFinite(speed) && speed !== Infinity) return 1;
  if (speed <= 0) return 1;
  return speed;
}

/**
 * Abortable sleep used by `replayTrace` between frames: resolves on timer
 * expiry, rejects with `AbortError` on abort so Ctrl-C exits without waiting
 * out the inter-frame delay. Shared implementation lives in utils/sleep.js.
 */
export { sleepAbortable };

/**
 * Construct an `AbortError`-shaped error. Prefers the standard
 * `DOMException("...", "AbortError")` when available (Node 18+);
 * falls back to a plain Error with `name = "AbortError"` for
 * environments without `DOMException`.
 */
function makeAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("aborted", "AbortError");
  }
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Detect an AbortError-shaped rejection. Matches both
 * `DOMException("...", "AbortError")` and plain `Error` with
 * `name === "AbortError"`. Exported for tests.
 */
export function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

export interface FlushWithTimeoutResult {
  flushed: boolean;
  timedOut: boolean;
  error: unknown;
}

/**
 * Bound a recorder flush against a wall-clock deadline (Codex P1, PR
 * #732 follow-up).
 *
 * The CLI shutdown path awaits `recorder.close()`. On a wedged
 * network-backed filesystem that drain can block indefinitely. This
 * helper races the drain against `timeoutMs` and returns a structured
 * result so the caller can decide whether to log a warning, retry, or
 * proceed silently. Returning a structured result (rather than
 * throwing) keeps shutdown ordering deterministic — the caller must
 * always reach the next teardown step.
 *
 * Errors raised by the flush are captured in `result.error` rather
 * than re-thrown.
 *
 * The `flush` factory receives an `AbortSignal` that fires when the
 * timeout wins the race. Callers should forward the signal into
 * whatever I/O the flush performs so the underlying operation is
 * actually cancelled rather than just orphaned. The signal is fired
 * exactly once, immediately after the timeout sentinel wins. The flush
 * promise is still awaited in the background; any subsequent error is
 * silently discarded (it was already abandoned by the caller).
 */
export async function flushWithTimeout(
  flush: (signal: AbortSignal) => Promise<void>,
  timeoutMs: number,
): Promise<FlushWithTimeoutResult> {
  const TIMEOUT_SENTINEL = Symbol("flush-timeout");
  let error: unknown = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const ac = new AbortController();
  const flushPromise = flush(ac.signal).then(
    () => undefined,
    (err) => {
      error = err;
      return undefined;
    },
  );
  const timeoutPromise = new Promise<symbol>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
    if (typeof timeoutHandle.unref === "function") {
      timeoutHandle.unref();
    }
  });
  try {
    const winner = await Promise.race<symbol | void>([
      flushPromise,
      timeoutPromise,
    ]);
    if (winner === TIMEOUT_SENTINEL) {
      ac.abort();
      return { flushed: false, timedOut: true, error: null };
    }
    return { flushed: true, timedOut: false, error };
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
  }
}

function safeWrite(output: Writable, chunk: string): void {
  try {
    output.write(chunk);
  } catch {
    // ignore — best effort
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}

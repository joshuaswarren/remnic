
import type { Writable } from "node:stream";

import {
  gatherConsoleState,
  type ConsoleStateOrchestratorLike,
  type ConsoleStateSnapshot,
} from "./state.js";

const ANSI_CLEAR_HOME = "\x1b[2J\x1b[H";
const ANSI_HIDE_CURSOR = "\x1b[?25l";
const ANSI_SHOW_CURSOR = "\x1b[?25h";

const FRAME_INNER_WIDTH = 70;

/** Default refresh interval in milliseconds. Chosen to match the spec. */
const DEFAULT_REFRESH_INTERVAL_MS = 2000;

export interface RunConsoleTuiOptions {
  /** Polling interval in milliseconds. Defaults to 2000ms. */
  refreshIntervalMs?: number;
  /** Output stream. Defaults to `process.stdout`. */
  output?: Writable;
  /**
   * Optional clock injection — primarily for tests so the rendered
   * timestamp is deterministic. Defaults to `Date.now`.
   */
  now?: () => number;
  /**
   * If true, install a SIGINT handler that calls `stop()` and resolves
   * the returned promise. Defaults to true. Tests typically pass false.
   */
  installSigintHandler?: boolean;
  /**
   * Optional trace recorder. When provided, every successfully
   * gathered snapshot is appended to the recorder for later replay
   * via `replayTrace`. Failed appends are surfaced through the
   * recorder's `getLastError()` and never crash the loop (issue
   * #688 PR 3/3).
   */
  traceRecorder?: {
    append: (snapshot: ConsoleStateSnapshot) => Promise<void>;
  };
}

export interface RunConsoleTuiHandle {
  stop: () => void;
  done: Promise<void>;
  /**
   * Number of trace frames that were dropped due to backpressure (i.e.
   * the previous `traceRecorder.append()` had not yet resolved when
   * the tick fired). Non-zero values indicate the trace recorder is
   * falling behind — typically caused by a slow or network-backed
   * filesystem. Codex P2 (PR #732 round 5): exposed so operators can
   * detect recording lag via `--state-only` snapshots or future
   * diagnostic surfaces.
   */
  getDroppedTraceFrames: () => number;
}

/**
 * Start the operator console TUI. Returns immediately with a handle
 * exposing `stop()` and a `done` promise that resolves once the loop
 * has been torn down. The caller can `await handle.done` to block
 * until the user (or a SIGINT) exits.
 */
export function runConsoleTui(
  orchestrator: ConsoleStateOrchestratorLike,
  options: RunConsoleTuiOptions = {},
): RunConsoleTuiHandle {
  const refreshIntervalMs = Math.max(
    50,
    options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
  );
  const output: Writable = options.output ?? process.stdout;
  const now = options.now ?? (() => Date.now());
  const installSigintHandler = options.installSigintHandler ?? true;

  let stopped = false;
  let inFlight = false;
  let inFlightTickPromise: Promise<void> | null = null;
  let traceWritePending = false;
  let traceFramesDropped = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  safeWrite(output, ANSI_HIDE_CURSOR);

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      let snapshot: ConsoleStateSnapshot | null = null;
      let renderError: string | null = null;
      try {
        snapshot = await gatherConsoleState(orchestrator);
      } catch (err) {
        renderError = describeError(err);
      }
      if (stopped) return;
      let frame: string;
      try {
        frame = renderFrame({ snapshot, renderError, now });
      } catch (err) {
        frame = `remnic console: render failed: ${describeError(err)}\n`;
      }
      safeWrite(output, ANSI_CLEAR_HOME);
      safeWrite(output, frame);
      //
      if (snapshot && options.traceRecorder && !traceWritePending) {
        traceWritePending = true;
        void options.traceRecorder
          .append(snapshot)
          .catch(() => {
            // already recorded in lastError; defense-in-depth.
          })
          .finally(() => {
            traceWritePending = false;
          });
      } else if (snapshot && options.traceRecorder) {
        traceFramesDropped += 1;
      }
    } finally {
      inFlight = false;
    }
  };

  const launchTick = (): void => {
    const p = runTickSafely(tick);
    inFlightTickPromise = p;
    void p.then(() => {
      if (inFlightTickPromise === p) {
        inFlightTickPromise = null;
      }
    });
  };
  launchTick();
  const handle = setInterval(launchTick, refreshIntervalMs);

  const sigintHandler = () => {
    stop();
  };
  if (installSigintHandler) {
    process.on("SIGINT", sigintHandler);
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(handle);
    if (installSigintHandler) {
      try {
        process.removeListener("SIGINT", sigintHandler);
      } catch {
        // ignore
      }
    }
    safeWrite(output, ANSI_SHOW_CURSOR);
    //
    void (async () => {
      try {
        const pendingTick = inFlightTickPromise;
        if (pendingTick) {
          await pendingTick;
        }
      } finally {
        resolveDone();
      }
    })();
  };

  return {
    stop,
    done,
    getDroppedTraceFrames: () => traceFramesDropped,
  };
}

interface RenderFrameInput {
  snapshot: ConsoleStateSnapshot | null;
  renderError: string | null;
  now: () => number;
}

/**
 * Build the full rendered frame as a single string. Pure — exposed
 * for testing.
 */
export function renderFrame(input: RenderFrameInput): string {
  const ts = new Date(input.now()).toISOString();
  const lines: string[] = [];
  lines.push(renderHeader(ts));
  for (const panel of renderPanels(input)) {
    lines.push(panel);
  }
  lines.push(renderFooter());
  return lines.join("\n") + "\n";
}

function renderHeader(ts: string): string {
  const title = " remnic console ";
  const trailing = ` ${ts} `;
  const fillerLen = Math.max(
    1,
    FRAME_INNER_WIDTH - title.length - trailing.length,
  );
  const filler = "═".repeat(fillerLen);
  return `╔${title}${filler}${trailing}╗`;
}

function renderFooter(): string {
  return `╚${"═".repeat(FRAME_INNER_WIDTH)}╝`;
}

function renderPanels(input: RenderFrameInput): string[] {
  const lines: string[] = [];
  const snap = input.snapshot;

  if (input.renderError !== null) {
    lines.push(panelLine("Error", `refresh failed: ${input.renderError}`));
    lines.push(panelLine("Buffer", "(unavailable)"));
    lines.push(panelLine("Extraction", "(unavailable)"));
    lines.push(panelLine("Dedup", "(unavailable)"));
    lines.push(panelLine("Maintenance", "(unavailable)"));
    lines.push(panelLine("QMD", "(unavailable)"));
    return lines;
  }

  if (snap) {
    lines.push(
      panelLine(
        "Buffer",
        `turns=${snap.bufferState.turnsCount} bytes=${snap.bufferState.byteCount}`,
      ),
    );

    const verdicts = snap.extractionQueue.recentVerdicts;
    const accepts = verdicts.filter((v) => v.kind === "accept").length;
    const rejects = verdicts.filter((v) => v.kind === "reject").length;
    lines.push(
      panelLine(
        "Extraction",
        `queue=${snap.extractionQueue.depth}  recent verdicts: accept(${accepts})/reject(${rejects})`,
      ),
    );

    const dedupSummary = formatDedupSummary(snap.dedupRecent, input.now);
    lines.push(panelLine("Dedup", dedupSummary));

    const maintSummary = formatMaintenanceTail(snap.maintenanceLedgerTail);
    lines.push(panelLine("Maintenance", maintSummary));

    lines.push(panelLine("QMD", formatQmdSummary(snap)));
  }

  if (snap && snap.errors.length > 0) {
    const head = snap.errors[0];
    lines.push(panelLine("Errors", head ?? ""));
  }

  return lines;
}

function formatDedupSummary(
  decisions: ConsoleStateSnapshot["dedupRecent"],
  now: () => number,
): string {
  if (decisions.length === 0) return "no recent decisions";
  const last = decisions[decisions.length - 1];
  if (!last) return "no recent decisions";
  const ageMs = ageMsFromIso(last.ts, now);
  const ageStr = ageMs === null ? "T-?" : `T-${Math.round(ageMs / 1000)}s`;
  const fp = last.fingerprint ? `hash=${last.fingerprint}` : "hash=?";
  return `recent: ${fp} decision=${last.decision} (${ageStr})`;
}

function formatMaintenanceTail(
  events: ConsoleStateSnapshot["maintenanceLedgerTail"],
): string {
  if (events.length === 0) return "no events";
  const last = events[events.length - 1];
  if (!last) return "no events";
  return `n=${events.length}  last: ${last.category} ${truncate(last.summary, 40)}`;
}

function formatQmdSummary(snap: ConsoleStateSnapshot): string {
  const probe = snap.qmdProbe.available ? "ok" : "down";
  const uptimeH = snap.daemon.uptimeMs / 3_600_000;
  const uptimeStr = uptimeH < 1
    ? `${Math.round(snap.daemon.uptimeMs / 1000)}s`
    : `${uptimeH.toFixed(1)}h`;
  const mode = snap.qmdProbe.daemonMode ? "daemon" : "cli";
  return `probe=${probe}  mode=${mode}  uptime=${uptimeStr}`;
}

function panelLine(label: string, value: string): string {
  const LABEL_WIDTH = 13;
  const labelCol = padRight(label, LABEL_WIDTH);
  const remaining = FRAME_INNER_WIDTH - LABEL_WIDTH - 2;
  const valueCol = padRight(truncate(value, remaining), remaining);
  return `║ ${labelCol}${valueCol} ║`;
}

function padRight(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}

function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return s.slice(0, max - 1) + "…";
}

function ageMsFromIso(iso: string, now: () => number): number | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const delta = now() - ms;
  return delta < 0 ? 0 : delta;
}

async function runTickSafely(tick: () => Promise<void>): Promise<void> {
  try {
    await tick();
  } catch {
    // Any error has already been (or will be) surfaced inside the
    // rendered frame; never let it escape the timer callback.
  }
}

function safeWrite(output: Writable, chunk: string): void {
  try {
    output.write(chunk);
  } catch {
    // Writing to a closed / broken stream is non-fatal for the TUI;
    // the next tick will retry.
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

/**
 * Strip ANSI escape sequences from a string. Exposed for tests so the
 * rendered frame can be asserted against plain text.
 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

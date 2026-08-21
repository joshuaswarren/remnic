/**
 * Structured engine-state aggregator for the operator console (issue #688).
 *
 * This module is the data layer for the upcoming console TUI / HTTP /
 * MCP surfaces. It collects a point-in-time snapshot of the engine's
 * runtime state — buffer contents, extraction queue depth, recent
 * dedup decisions, the tail of the maintenance/observation ledger,
 * QMD probe status, and daemon metadata — into a single
 * JSON-serializable shape.
 *
 * Design contract:
 *   - Each subsystem read is wrapped in try/catch so one failure
 *     never crashes the whole snapshot. Failed reads return null /
 *     empty values and append a string to `errors`.
 *   - The output MUST be JSON-serializable so the CLI / HTTP / MCP
 *     surfaces can pipe it directly through `JSON.stringify`.
 *   - Read-only: this module never mutates orchestrator state.
 *
 * PR 1/3 of issue #688 wires only the data layer + a CLI flag. The
 * TUI (PR 2/3), HTTP `/console/state`, MCP `engram.console_state`,
 * SSE live updates, and trace replay (PR 3/3) land separately.
 */

import { promises as fs, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

/**
 * Public state read off the orchestrator. We intentionally type this
 * as a permissive duck-typed shape rather than importing the concrete
 * `Orchestrator` class — the aggregator must tolerate missing fields
 * (e.g. tests that pass a stub) without throwing. Each accessor is
 * defensively read at call time.
 */
export interface ConsoleStateOrchestratorLike {
  config?: {
    memoryDir?: string;
  };
  buffer?: {
    getTurns?: (bufferKey?: string) => Array<{ content?: string }>;
  };
  qmd?: {
    debugStatus?: () => string;
    isAvailable?: () => boolean;
    isDaemonMode?: () => boolean;
  };
  /**
   * Optional console-specific read surface added by future slices.
   * The aggregator falls back to placeholders when these are absent
   * so PR 1/3 ships without coupling to private orchestrator state.
   */
  getConsoleExtractionQueueDepth?: () => number;
  getConsoleExtractionRecentVerdicts?: () => ReadonlyArray<ConsoleExtractionVerdict>;
  getConsoleDedupRecentDecisions?: () => ReadonlyArray<ConsoleDedupDecision>;
  /**
   * Process / daemon metadata. Hosts that run remnic as a long-lived
   * daemon (gateway, MCP server) can override these; otherwise the
   * aggregator falls back to `process.uptime()` and the package
   * version read from disk.
   */
  getConsoleDaemonInfo?: () => ConsoleDaemonInfo;
  /**
   * Optional faithfulness gate distribution (issue #1576). Returns the
   * per-orchestrator running counters when the gate is active, or undefined
   * when the gate is off (so the snapshot omits the block).
   */
  getConsoleFaithfulnessDistribution?: () => ConsoleFaithfulnessDistribution | undefined;
}

export interface ConsoleBufferState {
  /** Number of turns currently held in the default buffer slot. */
  turnsCount: number;
  /** Approximate byte size of buffered content (UTF-8). */
  byteCount: number;
}

export interface ConsoleExtractionVerdict {
  /** ISO-8601 timestamp the verdict was recorded. */
  ts: string;
  /** Verdict kind — typically "accept" | "reject" | "defer". */
  kind: string;
  /** Optional short reason from the judge or fallback. */
  reason?: string;
}

export interface ConsoleExtractionQueueState {
  /** Number of pending extraction tasks queued in the orchestrator. */
  depth: number;
  /** Most recent judge verdicts, newest last. Capped at 25 entries. */
  recentVerdicts: ConsoleExtractionVerdict[];
}

export interface ConsoleDedupDecision {
  /** ISO-8601 timestamp the decision was recorded. */
  ts: string;
  /** Outcome of the dedup check — "duplicate" | "novel" | etc. */
  decision: string;
  /** Optional content fingerprint (first 16 chars of a hash). */
  fingerprint?: string;
  /** Optional similarity score that drove the decision. */
  similarity?: number;
}

export interface ConsoleMaintenanceLedgerEvent {
  /** ISO-8601 timestamp from the ledger row. */
  ts: string;
  /** Event category (e.g. "EXTRACTION_JUDGE_VERDICT"). */
  category: string;
  /** Compact one-line summary. */
  summary: string;
}

export interface ConsoleQmdProbeState {
  /** Whether QMD is reachable via CLI or daemon. */
  available: boolean;
  /** Whether the daemon transport is in use. */
  daemonMode: boolean;
  /** Raw debug-status string from `qmd.debugStatus()`. */
  debug: string;
}

export interface ConsoleDaemonInfo {
  /** Process uptime in milliseconds. */
  uptimeMs: number;
  /** Package / daemon version (best-effort). */
  version: string;
}

/**
 * Faithfulness gate verdict distribution (issue #1576). Surfaced via
 * console_state so `remnic doctor` can render how the gate is performing.
 */
export interface ConsoleFaithfulnessDistribution {
  entailed: number;
  contradicted: number;
  unsupported: number;
  unchecked: number;
  skippedNoSpan: number;
}

export interface ConsoleStateSnapshot {
  /** ISO-8601 capture timestamp. */
  capturedAt: string;
  bufferState: ConsoleBufferState;
  extractionQueue: ConsoleExtractionQueueState;
  dedupRecent: ConsoleDedupDecision[];
  maintenanceLedgerTail: ConsoleMaintenanceLedgerEvent[];
  qmdProbe: ConsoleQmdProbeState;
  daemon: ConsoleDaemonInfo;
  /** Faithfulness gate distribution (issue #1576). Absent when the gate is off. */
  faithfulness?: ConsoleFaithfulnessDistribution;
  /**
   * Subsystem read errors. One entry per failed reader keyed by
   * subsystem name (e.g. `"bufferState: ..."`). An empty array means
   * every section was read cleanly.
   */
  errors: string[];
}

const MAX_LEDGER_TAIL = 50;
const MAX_VERDICT_TAIL = 25;
const MAX_DEDUP_TAIL = 10;

/**
 * Gather a `ConsoleStateSnapshot` from the orchestrator. Each
 * subsystem read is independent; a thrown error in one reader is
 * captured in `errors` and the corresponding section is filled with
 * empty / placeholder values.
 */
export async function gatherConsoleState(
  orchestrator: ConsoleStateOrchestratorLike,
): Promise<ConsoleStateSnapshot> {
  const errors: string[] = [];
  const capturedAt = new Date().toISOString();

  const bufferState = readBufferState(orchestrator, errors);
  const extractionQueue = readExtractionQueue(orchestrator, errors);
  const dedupRecent = readDedupRecent(orchestrator, errors);
  const maintenanceLedgerTail = await readMaintenanceLedgerTail(
    orchestrator,
    errors,
  );
  const qmdProbe = readQmdProbe(orchestrator, errors);
  const daemon = readDaemonInfo(orchestrator, errors);

  // Faithfulness gate distribution (issue #1576). Optional — absent when
  // the gate is off or the orchestrator does not expose the accessor.
  let faithfulness: ConsoleFaithfulnessDistribution | undefined;
  try {
    if (typeof orchestrator.getConsoleFaithfulnessDistribution === "function") {
      faithfulness = orchestrator.getConsoleFaithfulnessDistribution();
    }
  } catch (err) {
    errors.push(`faithfulness: ${describeError(err)}`);
  }

  return {
    capturedAt,
    bufferState,
    extractionQueue,
    dedupRecent,
    maintenanceLedgerTail,
    qmdProbe,
    daemon,
    ...(faithfulness ? { faithfulness } : {}),
    errors,
  };
}

function readBufferState(
  orchestrator: ConsoleStateOrchestratorLike,
  errors: string[],
): ConsoleBufferState {
  try {
    const getTurns = orchestrator.buffer?.getTurns;
    if (typeof getTurns !== "function") {
      return { turnsCount: 0, byteCount: 0 };
    }
    const turns = getTurns.call(orchestrator.buffer) ?? [];
    let byteCount = 0;
    for (const turn of turns) {
      const content = typeof turn?.content === "string" ? turn.content : "";
      byteCount += Buffer.byteLength(content, "utf8");
    }
    return { turnsCount: turns.length, byteCount };
  } catch (err) {
    errors.push(`bufferState: ${describeError(err)}`);
    return { turnsCount: 0, byteCount: 0 };
  }
}

function readExtractionQueue(
  orchestrator: ConsoleStateOrchestratorLike,
  errors: string[],
): ConsoleExtractionQueueState {
  try {
    const depth =
      typeof orchestrator.getConsoleExtractionQueueDepth === "function"
        ? orchestrator.getConsoleExtractionQueueDepth()
        : 0;
    const verdicts =
      typeof orchestrator.getConsoleExtractionRecentVerdicts === "function"
        ? orchestrator.getConsoleExtractionRecentVerdicts()
        : [];
    const recentVerdicts = (verdicts ?? [])
      .slice(-MAX_VERDICT_TAIL)
      .map((v) => ({
        ts: typeof v?.ts === "string" ? v.ts : "",
        kind: typeof v?.kind === "string" ? v.kind : "unknown",
        ...(typeof v?.reason === "string" ? { reason: v.reason } : {}),
      }));
    return { depth: Number.isFinite(depth) ? depth : 0, recentVerdicts };
  } catch (err) {
    errors.push(`extractionQueue: ${describeError(err)}`);
    return { depth: 0, recentVerdicts: [] };
  }
}

function readDedupRecent(
  orchestrator: ConsoleStateOrchestratorLike,
  errors: string[],
): ConsoleDedupDecision[] {
  try {
    // Cursor Medium: call directly on `orchestrator` to preserve the
    // `this` binding. Extracting the method into a local and invoking
    // it bare loses `this`, so a non-arrow implementation that
    // references `this` would fail at runtime. Mirrors how
    // `readExtractionQueue` and `readMaintenanceLedgerTail` invoke
    // their orchestrator methods.
    if (typeof orchestrator.getConsoleDedupRecentDecisions !== "function") return [];
    const raw = orchestrator.getConsoleDedupRecentDecisions() ?? [];
    return raw.slice(-MAX_DEDUP_TAIL).map((d) => ({
      ts: typeof d?.ts === "string" ? d.ts : "",
      decision: typeof d?.decision === "string" ? d.decision : "unknown",
      ...(typeof d?.fingerprint === "string"
        ? { fingerprint: d.fingerprint }
        : {}),
      ...(typeof d?.similarity === "number" && Number.isFinite(d.similarity)
        ? { similarity: d.similarity }
        : {}),
    }));
  } catch (err) {
    errors.push(`dedupRecent: ${describeError(err)}`);
    return [];
  }
}

/**
 * Stream a JSONL file line-by-line, parse each row, project it into a
 * console event, and keep only the `topN` most-recent items by `ts`
 * (descending). Memory is bounded at O(2 * topN) regardless of file
 * size — we sort-and-truncate whenever the working buffer grows past
 * `2 * topN`. This satisfies BOTH:
 *
 *   1. "Don't load the whole file into memory" — streaming + bounded
 *      buffer means a multi-GB ledger never blows up RAM.
 *   2. "Don't miss recent rows just because the file isn't sorted by
 *      recency" — `rebuilt-observations.jsonl` is written sorted by
 *      `(sessionKey, hour)`, NOT by global ts, so a byte-tail-only
 *      read silently dropped recent-but-lexicographically-earlier
 *      sessions. Streaming top-N visits every row and keeps the
 *      globally-most-recent ones.
 *
 * Returns an array sorted oldest-first within the top-N window. Rows
 * with no parseable `ts` are dropped (they would otherwise compare
 * undefined under any sort).
 */
async function streamLedgerTopN<T extends { ts: string }>(
  ledgerPath: string,
  topN: number,
  project: (parsed: Record<string, unknown>) => T | null,
): Promise<T[]> {
  let stream: ReturnType<typeof createReadStream>;
  try {
    // `fs.access`-style probe so we can quietly return `[]` for
    // ENOENT without hitting the readline error path.
    await fs.stat(ledgerPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
  try {
    stream = createReadStream(ledgerPath, { encoding: "utf-8" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const cap = Math.max(1, topN) * 2;
  const buf: T[] = [];
  const truncate = () => {
    // Sort descending by ts, keep top-N, drop the rest.
    buf.sort((a, b) => {
      const aMs = Date.parse(a.ts);
      const bMs = Date.parse(b.ts);
      if (Number.isFinite(aMs) && Number.isFinite(bMs)) return bMs - aMs;
      if (Number.isFinite(aMs)) return -1;
      if (Number.isFinite(bMs)) return 1;
      return 0;
    });
    if (buf.length > topN) buf.length = topN;
  };
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        continue;
      }
      const event = project(parsed as Record<string, unknown>);
      if (event === null) continue;
      // Drop rows we couldn't even date-stamp — they can't be sorted
      // meaningfully against the rest of the corpus.
      if (!event.ts || !Number.isFinite(Date.parse(event.ts))) continue;
      buf.push(event);
      if (buf.length >= cap) truncate();
    }
  } finally {
    rl.close();
    stream.close();
  }
  truncate();
  return buf.reverse(); // oldest-first within the top-N window
}

function projectLedgerRow(p: Record<string, unknown>): ConsoleMaintenanceLedgerEvent | null {
  // The two canonical writers produce different row shapes:
  //   - extraction-judge-telemetry: `{ts, verdictKind, reason, candidateCategory, ...}`
  //   - rebuild-observations / migrate-observations:
  //     `{sessionKey, hour, turnCount, userTurns, assistantTurns, rebuiltAt}`
  // Map both into the canonical {ts, category, summary} shape.
  const ts =
    typeof p.ts === "string" && p.ts.length > 0
      ? p.ts
      : typeof p.hour === "string" && p.hour.length > 0
        ? p.hour
        : typeof p.rebuiltAt === "string" && p.rebuiltAt.length > 0
          ? p.rebuiltAt
          : "";
  const category =
    typeof p.category === "string" && p.category.length > 0
      ? p.category
      : typeof p.verdictKind === "string"
        ? "judge-verdict"
        : typeof p.turnCount === "number"
          ? "observation"
          : "unknown";
  const summary = summarizeLedgerEvent(p);
  return { ts, category, summary };
}

async function readMaintenanceLedgerTail(
  orchestrator: ConsoleStateOrchestratorLike,
  errors: string[],
): Promise<ConsoleMaintenanceLedgerEvent[]> {
  try {
    const memoryDir = orchestrator.config?.memoryDir;
    if (!memoryDir || typeof memoryDir !== "string") return [];
    const ledgerDir = path.join(memoryDir, "state", "observation-ledger");
    // Codex review converged on two competing constraints:
    //   1. Don't load the whole file into memory (multi-GB ledgers
    //      would OOM the console surface).
    //   2. Don't miss recent rows just because the file isn't sorted
    //      by recency (`rebuilt-observations.jsonl` is sorted by
    //      sessionKey/hour, so byte-tail reads silently drop recent
    //      lexicographically-earlier sessions).
    // The right answer is a streaming bounded top-N: visit every row,
    // but keep only the MAX_LEDGER_TAIL most-recent in memory at any
    // time. Memory stays O(MAX_LEDGER_TAIL); recency ordering is
    // globally correct.
    const verdictsTopN = await streamLedgerTopN(
      path.join(ledgerDir, "extraction-judge-verdicts.jsonl"),
      MAX_LEDGER_TAIL,
      projectLedgerRow,
    );
    const rebuiltTopN = await streamLedgerTopN(
      path.join(ledgerDir, "rebuilt-observations.jsonl"),
      MAX_LEDGER_TAIL,
      projectLedgerRow,
    );
    // Merge the two source top-N windows and select the global
    // top-N. Both inputs already arrive oldest-first within their
    // respective windows; sort the merged set descending by ts and
    // take the most-recent MAX_LEDGER_TAIL.
    const events: ConsoleMaintenanceLedgerEvent[] = [...verdictsTopN, ...rebuiltTopN];
    if (events.length === 0) return [];
    events.sort((a, b) => {
      const aMs = Date.parse(a.ts);
      const bMs = Date.parse(b.ts);
      if (Number.isFinite(aMs) && Number.isFinite(bMs)) return bMs - aMs;
      if (Number.isFinite(aMs)) return -1;
      if (Number.isFinite(bMs)) return 1;
      return 0;
    });
    const tail = events.slice(0, MAX_LEDGER_TAIL);
    // Reverse so the caller sees oldest-first within the tail window.
    return tail.reverse();
  } catch (err) {
    errors.push(`maintenanceLedgerTail: ${describeError(err)}`);
    return [];
  }
}

function summarizeLedgerEvent(p: Record<string, unknown>): string {
  const parts: string[] = [];
  // Judge-verdict rows.
  if (typeof p.verdictKind === "string") parts.push(`verdict=${p.verdictKind}`);
  if (typeof p.reason === "string" && p.reason.length > 0) {
    const trimmed = p.reason.length > 80 ? `${p.reason.slice(0, 80)}…` : p.reason;
    parts.push(`reason=${trimmed}`);
  }
  if (typeof p.candidateCategory === "string") {
    parts.push(`cat=${p.candidateCategory}`);
  }
  // Canonical rebuilt-observations rows (codex P2).
  if (typeof p.sessionKey === "string" && p.sessionKey.length > 0) {
    parts.push(`session=${p.sessionKey}`);
  }
  if (typeof p.turnCount === "number" && Number.isFinite(p.turnCount)) {
    parts.push(`turns=${p.turnCount}`);
  }
  if (typeof p.userTurns === "number" && Number.isFinite(p.userTurns)) {
    parts.push(`u=${p.userTurns}`);
  }
  if (typeof p.assistantTurns === "number" && Number.isFinite(p.assistantTurns)) {
    parts.push(`a=${p.assistantTurns}`);
  }
  if (parts.length === 0) {
    return typeof p.category === "string" ? p.category : "event";
  }
  return parts.join(" ");
}

function readQmdProbe(
  orchestrator: ConsoleStateOrchestratorLike,
  errors: string[],
): ConsoleQmdProbeState {
  try {
    const qmd = orchestrator.qmd;
    if (!qmd) {
      return { available: false, daemonMode: false, debug: "qmd unavailable" };
    }
    const available =
      typeof qmd.isAvailable === "function" ? qmd.isAvailable() : false;
    const daemonMode =
      typeof qmd.isDaemonMode === "function" ? qmd.isDaemonMode() : false;
    const debug =
      typeof qmd.debugStatus === "function" ? qmd.debugStatus() : "";
    return { available, daemonMode, debug };
  } catch (err) {
    errors.push(`qmdProbe: ${describeError(err)}`);
    return { available: false, daemonMode: false, debug: "" };
  }
}

function readDaemonInfo(
  orchestrator: ConsoleStateOrchestratorLike,
  errors: string[],
): ConsoleDaemonInfo {
  try {
    if (typeof orchestrator.getConsoleDaemonInfo === "function") {
      const info = orchestrator.getConsoleDaemonInfo();
      return {
        uptimeMs: Number.isFinite(info?.uptimeMs) ? info.uptimeMs : 0,
        version: typeof info?.version === "string" ? info.version : "unknown",
      };
    }
    // Fallback: process uptime + best-effort package version. This is
    // only meaningful when the orchestrator runs in the same process
    // as the CLI (which is the case for `remnic console --state-only`).
    const uptimeMs = Math.round((process.uptime?.() ?? 0) * 1000);
    return { uptimeMs, version: resolvePackageVersion() };
  } catch (err) {
    errors.push(`daemon: ${describeError(err)}`);
    return { uptimeMs: 0, version: "unknown" };
  }
}

function resolvePackageVersion(): string {
  // Best-effort, sync, never throws. We avoid importing package.json
  // statically because tsup bundles into a single file at runtime.
  try {
    const env = process.env?.REMNIC_VERSION;
    if (typeof env === "string" && env.length > 0) return env;
  } catch {
    // ignore
  }
  return "unknown";
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}

/**
 * Extraction Judge Telemetry (issue #562, PR 3).
 *
 * Appends one structured event per judge verdict to the observation ledger
 * under a dedicated JSONL file. The ledger is the same directory used by
 * the turn-count observation writer
 * (`state/observation-ledger/rebuilt-observations.jsonl`) but judge events
 * live in their own file so aggregation stays cheap and schemas do not
 * collide.
 *
 * Emit path is best-effort and fail-open: a telemetry write must never
 * block an extraction run.
 */

import path from "node:path";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { log } from "./logger.js";
import type { JudgeVerdictKind } from "./extraction-judge.js";

/**
 * Observation-ledger category for judge verdict events. Callers that
 * aggregate across event kinds can filter on this constant.
 */
export const EXTRACTION_JUDGE_VERDICT_CATEGORY = "EXTRACTION_JUDGE_VERDICT";

/**
 * Structured event written for every judge verdict (including verdicts
 * served from cache). The `version` field lets future readers upgrade the
 * schema without breaking older rows.
 */
export interface JudgeVerdictEvent {
  version: 1;
  category: typeof EXTRACTION_JUDGE_VERDICT_CATEGORY;
  ts: string; // ISO-8601
  verdictKind: JudgeVerdictKind;
  /** Short free-text reason from the judge / deterministic fallback. */
  reason: string;
  /**
   * How many times this candidate's content hash had already been deferred
   * before this verdict. 0 for the first defer, 1 for the second, etc.
   * Not applicable for non-defer kinds — emitted as 0.
   */
  deferrals: number;
  /**
   * Milliseconds between batch start and batch return (the whole
   * `judgeFactDurability` call, shared across all verdicts in a single
   * batch).
   */
  elapsedMs: number;
  /** Candidate metadata for coarse filtering. */
  candidateCategory: string;
  confidence?: number;
  /** SHA-256 of the (text\0category) pair, same as the verdict-cache key. */
  contentHash: string;
  /** Whether the verdict came from the in-memory verdict cache. */
  fromCache: boolean;
  /**
   * True when the judge forcibly converted a defer to reject because the
   * defer cap was reached. Only set on cap-triggered rejects.
   */
  deferCapTriggered?: boolean;
}

/**
 * Options to control emit behavior. `enabled` gates all writes; when
 * false, `recordJudgeVerdict` is a no-op so callers can unconditionally
 * invoke it.
 */
export interface JudgeTelemetryOptions {
  enabled: boolean;
  memoryDir: string;
}

export function judgeTelemetryPath(memoryDir: string): string {
  return path.join(
    memoryDir,
    "state",
    "observation-ledger",
    "extraction-judge-verdicts.jsonl",
  );
}

/**
 * Append a single verdict event as a JSONL row. Fails open — if the write
 * cannot be completed (directory missing, permissions, disk full), the
 * error is logged at debug level and swallowed so extraction never fails
 * because of telemetry.
 */
export async function recordJudgeVerdict(
  event: JudgeVerdictEvent,
  options: JudgeTelemetryOptions,
): Promise<void> {
  if (!options.enabled) return;
  const filePath = judgeTelemetryPath(options.memoryDir);
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf-8");
  } catch (err) {
    log.debug(
      `extraction-judge-telemetry: append failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Aggregate statistics over the verdict ledger, optionally restricted to a
 * time window. Returns zero-count stats when the ledger is missing or
 * empty — callers do not need to special-case a cold install.
 */
export interface JudgeVerdictStats {
  total: number;
  accept: number;
  reject: number;
  defer: number;
  deferCapTriggered: number;
  /** Mean elapsed milliseconds across all events in the window. */
  meanElapsedMs: number;
  /** Defer rate as `defer / total`, in `[0, 1]`. `0` when total is 0. */
  deferRate: number;
  /** First and last event timestamps observed in the window. */
  firstTs?: string;
  lastTs?: string;
  /** Number of rows skipped because they were malformed or wrong shape. */
  malformed: number;
}

/**
 * Read and aggregate events from the verdict ledger.
 *
 * `sinceMs` / `untilMs` bound by `ts` parse — events with unparseable
 * timestamps are counted toward `malformed`. The upper bound is exclusive
 * (`ts < untilMs`), per CLAUDE.md gotcha 35.
 */
export async function readJudgeVerdictStats(
  memoryDir: string,
  opts: { sinceMs?: number; untilMs?: number } = {},
): Promise<JudgeVerdictStats> {
  const filePath = judgeTelemetryPath(memoryDir);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        total: 0,
        accept: 0,
        reject: 0,
        defer: 0,
        deferCapTriggered: 0,
        meanElapsedMs: 0,
        deferRate: 0,
        malformed: 0,
      };
    }
    throw err;
  }

  let total = 0;
  let accept = 0;
  let reject = 0;
  let defer = 0;
  let deferCapTriggered = 0;
  let elapsedSum = 0;
  let malformed = 0;
  let firstTs: string | undefined;
  let lastTs: string | undefined;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      malformed += 1;
      continue;
    }
    const p = parsed as Record<string, unknown>;
    if (p.category !== EXTRACTION_JUDGE_VERDICT_CATEGORY) {
      malformed += 1;
      continue;
    }
    const ts = typeof p.ts === "string" ? p.ts : null;
    if (ts === null) {
      malformed += 1;
      continue;
    }
    const tsMs = Date.parse(ts);
    if (!Number.isFinite(tsMs)) {
      malformed += 1;
      continue;
    }
    if (typeof opts.sinceMs === "number" && tsMs < opts.sinceMs) continue;
    if (typeof opts.untilMs === "number" && tsMs >= opts.untilMs) continue;

    const kind = p.verdictKind;
    if (kind === "accept") accept += 1;
    else if (kind === "reject") reject += 1;
    else if (kind === "defer") defer += 1;
    else {
      malformed += 1;
      continue;
    }

    if (p.deferCapTriggered === true) deferCapTriggered += 1;
    if (typeof p.elapsedMs === "number" && Number.isFinite(p.elapsedMs)) {
      elapsedSum += p.elapsedMs;
    }
    total += 1;
    if (firstTs === undefined || ts < firstTs) firstTs = ts;
    if (lastTs === undefined || ts > lastTs) lastTs = ts;
  }

  return {
    total,
    accept,
    reject,
    defer,
    deferCapTriggered,
    meanElapsedMs: total > 0 ? elapsedSum / total : 0,
    deferRate: total > 0 ? defer / total : 0,
    firstTs,
    lastTs,
    malformed,
  };
}

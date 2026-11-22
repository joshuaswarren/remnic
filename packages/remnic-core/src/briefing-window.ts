import { log } from "./logger.js";
import type { EntityFile, MemoryFile } from "./types.js";
import { isAbortError } from "./abort-error.js";
import type { CorpusReadOptions } from "./corpus-read-cancellation.js";
import type { ParsedBriefingWindow } from "./briefing.js";
import type { WindowedMemoryReadOptions } from "./storage/windowed-memory-read.js";

type BriefingMemoryReader = {
  readMemoriesWindow?: (options: WindowedMemoryReadOptions) => Promise<{ memories: MemoryFile[] }>;
  readAllMemories: ((options?: CorpusReadOptions) => Promise<MemoryFile[]>) & {
    supportsAbortSignal?: boolean;
  };
  supportsAbortSignal?: boolean;
  supportsCancellation?: boolean;
  cancellable?: boolean;
};

export const BRIEFING_FULL_READ_FALLBACK_MS = 30_000;

export interface SafeReadMemoriesOptions {
  /** Test seam overriding {@link BRIEFING_FULL_READ_FALLBACK_MS}. */
  fallbackDeadlineMs?: number;
  /**
   * Caller cancellation. The signal reaches the storage read so it stops at
   * its next boundary, and a cancelled read is rethrown rather than degraded
   * into an empty corpus (issue #3139).
   */
  signal?: AbortSignal;
}

type BriefingReadMode = "windowed" | "full-read-fallback";
type BriefingReadOutcome = "success" | "timeout" | "error";

class BriefingReadTimedOut extends Error {
  constructor(readonly deadlineMs: number) {
    super("briefing full-read fallback timed out");
    this.name = "BriefingReadTimedOut";
  }
}

class LegacyReadUnsupported extends Error {
  constructor() {
    super("readAllMemories does not accept an abort signal");
    this.name = "LegacyReadUnsupported";
  }
}

const SAFE_ERROR_CLASSES: Record<string, true> = {
  Error: true,
  TypeError: true,
  RangeError: true,
  ReferenceError: true,
  SyntaxError: true,
  URIError: true,
  EvalError: true,
  AggregateError: true,
  AbortError: true,
  TimeoutError: true,
  SystemError: true,
  BriefingReadTimedOut: true,
  LegacyReadUnsupported: true,
  StorageError: true,
  EngramAccessInputError: true,
};

function errorClass(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name;
    if (typeof name === "string" && SAFE_ERROR_CLASSES[name] === true) {
      return name;
    }
    return "CustomError";
  }
  return typeof err === "string"
    ? "string"
    : typeof err === "object" && err !== null
      ? "object"
      : typeof err;
}

function bestEffortLog(level: "info" | "warn", message: string): void {
  try {
    log[level](message);
  } catch {
    // Diagnostics must never turn a successful or fail-open briefing read into
    // a request failure when a host logger transport is unavailable.
  }
}

function logBriefingMemoryRead(
  mode: BriefingReadMode,
  outcome: BriefingReadOutcome,
  durationMs: number,
  resultCount: number | undefined,
  errClass: string | undefined,
): void {
  const fields = [
    `mode=${mode}`,
    `durationMs=${durationMs}`,
    ...(resultCount === undefined ? [] : [`count=${resultCount}`]),
    `outcome=${outcome}`,
    ...(errClass === undefined ? [] : [`err=${errClass}`]),
  ];
  bestEffortLog("info", `briefing: memory read ${fields.join(" ")}`);
}

/** Read only the memories needed by a briefing, with compatibility fallback. */
export async function safeReadMemories(
  storage: BriefingMemoryReader,
  window: ParsedBriefingWindow,
  options: SafeReadMemoriesOptions = {},
): Promise<MemoryFile[]> {
  const startedAt = Date.now();
  const mode: BriefingReadMode =
    typeof storage.readMemoriesWindow === "function" ? "windowed" : "full-read-fallback";
  let outcome: BriefingReadOutcome = "error";
  let resultCount: number | undefined;
  let errClass: string | undefined;
  try {
    const memories = await readBriefingMemories(storage, window, mode, options);
    outcome = "success";
    resultCount = memories.length;
    return memories;
  } catch (err) {
    if (isAbortError(err) && options.signal?.aborted) {
      throw err;
    }
    if (err instanceof BriefingReadTimedOut) {
      outcome = "timeout";
      bestEffortLog(
        "warn",
        `briefing: memory read mode=full-read-fallback timed out after ${err.deadlineMs}ms — ` +
          `returning no memories (storage adapter lacks readMemoriesWindow; upgrade it to ` +
          `windowed or signal-aware reads)`,
      );
    } else if (err instanceof LegacyReadUnsupported) {
      errClass = errorClass(err);
      bestEffortLog(
        "warn",
        `briefing: memory read mode=full-read-fallback refused: readAllMemories() takes no abort ` +
          `signal, so its scan could not be stopped at the deadline — returning no memories ` +
          `(upgrade the storage adapter to readMemoriesWindow or a signal-aware readAllMemories)`,
      );
    } else {
      errClass = errorClass(err);
      bestEffortLog("warn", `briefing: read memories failed (${errClass}) — returning no memories`);
    }
    return [];
  } finally {
    logBriefingMemoryRead(mode, outcome, Date.now() - startedAt, resultCount, errClass);
  }
}

async function readBriefingMemories(
  storage: BriefingMemoryReader,
  window: ParsedBriefingWindow,
  mode: BriefingReadMode,
  options: SafeReadMemoriesOptions,
): Promise<MemoryFile[]> {
  if (mode === "windowed") {
    const readOptions: WindowedMemoryReadOptions = { updatedAfter: window.from };
    if (options.signal) readOptions.abortSignal = options.signal;
    const result = await storage.readMemoriesWindow!(readOptions);
    return result.memories;
  }
  const isCancellable =
    storage.supportsAbortSignal === true ||
    storage.supportsCancellation === true ||
    storage.cancellable === true ||
    storage.readAllMemories?.supportsAbortSignal === true;
  if (!isCancellable) {
    throw new LegacyReadUnsupported();
  }
  const deadlineMs = options.fallbackDeadlineMs ?? BRIEFING_FULL_READ_FALLBACK_MS;
  const controller = new AbortController();
  let deadlineFired = false;
  const timer = setTimeout(() => {
    deadlineFired = true;
    controller.abort();
  }, deadlineMs);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try {
    const memories = await storage.readAllMemories({ abortSignal: signal });
    if (deadlineFired) {
      throw new BriefingReadTimedOut(deadlineMs);
    }
    return memories;
  } catch (err) {
    if (isAbortError(err) && deadlineFired) throw new BriefingReadTimedOut(deadlineMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function safeReadEntities(
  storage: { readAllEntityFiles(options?: CorpusReadOptions): Promise<EntityFile[]> },
  signal: AbortSignal,
): Promise<EntityFile[]> {
  try {
    return await storage.readAllEntityFiles({ abortSignal: signal });
  } catch (err) {
    if (isAbortError(err) && signal.aborted) throw err;
    log.warn(`briefing: readAllEntityFiles failed: ${err}`);
    return [];
  }
}

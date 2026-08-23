import { log } from "./logger.js";
import type { MemoryFile } from "./types.js";
import { isAbortError } from "./abort-error.js";
import type { CorpusReadOptions } from "./corpus-read-cancellation.js";
import type { ParsedBriefingWindow } from "./briefing.js";

type BriefingMemoryReader = {
  readMemoriesWindow?: (options: { updatedAfter?: Date }) => Promise<{ memories: MemoryFile[] }>;
  readAllMemories: ((options?: CorpusReadOptions) => Promise<MemoryFile[]>) & {
    supportsAbortSignal?: boolean;
  };
  supportsAbortSignal?: boolean;
  supportsCancellation?: boolean;
  cancellable?: boolean;
};

/**
 * Deadline for the legacy full-read fallback (issue #2779). Storage doubles
 * that predate `readMemoriesWindow()` can only answer with a full-corpus
 * `readAllMemories()`, which is unbounded work; on a large corpus that read
 * alone can outlast the 60s MCP client timeout. Arm an AbortController with
 * this budget (well under 60s, leaving room for entity reads and follow-ups)
 * and fail open with an empty read. The deadline reaches the read as an
 * abort signal (the #2307 corpus-read contract), so the scan stops at its
 * next boundary instead of being abandoned to run on in the background.
 */
export const BRIEFING_FULL_READ_FALLBACK_MS = 30_000;

/** Options for {@link safeReadMemories}. */
export interface SafeReadMemoriesOptions {
  /** Test seam overriding {@link BRIEFING_FULL_READ_FALLBACK_MS}. */
  fallbackDeadlineMs?: number;
}

type BriefingReadMode = "windowed" | "full-read-fallback";
type BriefingReadOutcome = "success" | "timeout" | "error";

/** Internal marker: the fallback deadline fired and the read was aborted. */
class BriefingReadTimedOut extends Error {
  constructor(readonly deadlineMs: number) {
    super("briefing full-read fallback timed out");
    this.name = "BriefingReadTimedOut";
  }
}

/** Internal marker: the adapter's readAllMemories predates the signal contract. */
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

/**
 * Sanitize adapter-controlled Error.name before structured discriminator logs
 * (issue #2827). Allow-lists known system/remnic error names and maps any
 * unrecognized or backend-controlled names to a safe bounded class ("CustomError").
 */
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

/**
 * One structured, content-free discriminator per briefing memory read
 * (issue #2779): `mode`, `durationMs`, `count` when known, `outcome`, and on
 * failure a safe error class — never error messages or memory content.
 */
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
  log.info(`briefing: memory read ${fields.join(" ")}`);
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
    if (err instanceof BriefingReadTimedOut) {
      outcome = "timeout";
      log.warn(
        `briefing: memory read mode=full-read-fallback timed out after ${err.deadlineMs}ms — ` +
          `returning no memories (storage adapter lacks readMemoriesWindow; upgrade it to ` +
          `windowed or signal-aware reads)`,
      );
    } else if (err instanceof LegacyReadUnsupported) {
      errClass = errorClass(err);
      log.warn(
        `briefing: memory read mode=full-read-fallback refused: readAllMemories() takes no abort ` +
          `signal, so its scan could not be stopped at the deadline — returning no memories ` +
          `(upgrade the storage adapter to readMemoriesWindow or a signal-aware readAllMemories)`,
      );
    } else {
      errClass = errorClass(err);
      log.warn(`briefing: read memories failed (${errClass}) — returning no memories`);
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
  // A briefing only needs memories inside its lookback window. Avoid parsing
  // the full corpus on cache misses; keep the full-read fallback for custom
  // StorageManager-compatible callers that predate readMemoriesWindow().
  if (mode === "windowed") {
    const result = await storage.readMemoriesWindow!({ updatedAfter: window.from });
    return result.memories;
  }
  // Refuse legacy adapters that do not explicitly declare cancellation support (#2827).
  // Require affirmative cancellation support (`true` on one explicit marker) before fallback.
  // Do not rely on Function.length, which is zero for default/rest/bound functions.
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
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    // Direct await, no Promise.race: the signal IS the deadline. A
    // signal-aware read settles on abort (AbortError at its next scan
    // boundary, #2307), so nothing is left scanning in the background once
    // this function returns.
    const memories = await storage.readAllMemories({ abortSignal: controller.signal });
    if (controller.signal.aborted) {
      // A double that resolves partial rows instead of rejecting on abort
      // must not have them served as a complete corpus.
      throw new BriefingReadTimedOut(deadlineMs);
    }
    return memories;
  } catch (err) {
    if (isAbortError(err)) throw new BriefingReadTimedOut(deadlineMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

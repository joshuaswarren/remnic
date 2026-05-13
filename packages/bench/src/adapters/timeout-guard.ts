import type {
  BenchJudge,
  BenchMemoryAdapter,
  BenchRecallOptions,
  BenchResponder,
  MemoryStats,
  Message,
  SearchResult,
} from "./types.js";
import type { IngestionBenchAdapter, IngestionLog, MemoryGraph } from "../ingestion-types.js";
import type { ProviderConfig } from "../types.js";

const BENCHMARK_TIMEOUT_ABORT_GRACE_MS = 1_500;

export interface TimeoutGuardOptions {
  benchmarkId: string;
  timeoutMs: number;
  logProgress?: boolean;
  log?: (message: string) => void;
  onTimeout?: (phase: string) => void | Promise<void>;
}

export interface TimeoutGuardConfig {
  remnicConfig?: Record<string, unknown>;
  systemProvider?: ProviderConfig | null;
  judgeProvider?: ProviderConfig | null;
}

export function resolveBenchmarkPhaseTimeoutMs(
  config: TimeoutGuardConfig,
): number | undefined {
  const explicitTimeout = readPositiveIntegerConfig(
    config.remnicConfig,
    "benchmarkPhaseTimeoutMs",
  );
  if (explicitTimeout !== undefined) {
    return explicitTimeout;
  }

  const providerTimeout =
    config.systemProvider?.retryOptions?.timeoutMs ??
    config.judgeProvider?.retryOptions?.timeoutMs;
  if (providerTimeout !== undefined) {
    if (!Number.isInteger(providerTimeout) || providerTimeout <= 0) {
      throw new Error(
        `benchmark provider timeoutMs must be a positive integer; received ${String(providerTimeout)}.`,
      );
    }
    return providerTimeout;
  }

  return undefined;
}

export function resolveBenchmarkProgressLogging(
  remnicConfig?: Record<string, unknown>,
): boolean {
  return coerceBooleanConfig(
    remnicConfig?.benchmarkHarnessProgress,
    "benchmarkHarnessProgress",
  ) === true;
}

export function createTimeoutGuardedAdapter(
  adapter: BenchMemoryAdapter,
  options: TimeoutGuardOptions,
): BenchMemoryAdapter {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(
      `benchmark phase timeout must be a positive integer; received ${String(options.timeoutMs)}.`,
    );
  }

  const run = async <T>(
    phase: string,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const label = `${options.benchmarkId}:${phase}`;
    return runWithBenchmarkPhaseTimeout(label, options.timeoutMs, fn, options);
  };

  const wrapped: BenchMemoryAdapter = {
    store(sessionId: string, messages: Message[]): Promise<void> {
      return run(`store session=${sessionId} messages=${messages.length}`, () =>
        adapter.store(sessionId, messages),
      );
    },
    recall(
      sessionId: string,
      query: string,
      budgetChars?: number,
      recallOptions?: BenchRecallOptions,
    ): Promise<string> {
      return run(`recall session=${sessionId}`, () =>
        adapter.recall(sessionId, query, budgetChars, recallOptions),
      );
    },
    search(
      query: string,
      limit: number,
      sessionId?: string,
    ): Promise<SearchResult[]> {
      return run(`search session=${sessionId ?? "all"} limit=${limit}`, () =>
        adapter.search(query, limit, sessionId),
      );
    },
    reset(sessionId?: string): Promise<void> {
      return run(`reset session=${sessionId ?? "all"}`, () =>
        adapter.reset(sessionId),
      );
    },
    getStats(sessionId?: string): Promise<MemoryStats> {
      return run(`stats session=${sessionId ?? "all"}`, () =>
        adapter.getStats(sessionId),
      );
    },
    destroy(): Promise<void> {
      return adapter.destroy();
    },
  };

  if (adapter.drain) {
    wrapped.drain = (): Promise<void> => run("drain", () => adapter.drain!());
  }
  if (adapter.responder) {
    wrapped.responder = wrapResponder(adapter.responder, run);
  }
  if (adapter.judge) {
    wrapped.judge = wrapJudge(adapter.judge, run);
  }

  return wrapped;
}

export function createTimeoutGuardedIngestionAdapter(
  adapter: IngestionBenchAdapter,
  options: TimeoutGuardOptions,
): IngestionBenchAdapter {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(
      `benchmark phase timeout must be a positive integer; received ${String(options.timeoutMs)}.`,
    );
  }

  const run = async <T>(
    phase: string,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> =>
    runWithBenchmarkPhaseTimeout(`${options.benchmarkId}:${phase}`, options.timeoutMs, fn, options);

  return {
    ingest(inputDir: string): Promise<IngestionLog> {
      return run(`ingestion.ingest inputDir=${inputDir}`, () => adapter.ingest(inputDir));
    },
    getMemoryGraph(): Promise<MemoryGraph> {
      return run("ingestion.getMemoryGraph", () => adapter.getMemoryGraph());
    },
    reset(): Promise<void> {
      return run("ingestion.reset", () => adapter.reset());
    },
    destroy(): Promise<void> {
      return adapter.destroy();
    },
  };
}

export async function runWithBenchmarkPhaseTimeout<T>(
  label: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  options: Pick<TimeoutGuardOptions, "logProgress" | "log" | "onTimeout"> = {},
): Promise<T> {
  if (options.logProgress) {
    options.log?.(`[bench] START ${label}`);
  }
  const startedAt = performance.now();
  try {
    const result = await withTimeout(label, timeoutMs, fn, options.onTimeout);
    if (options.logProgress) {
      options.log?.(
        `[bench] DONE ${label} ${Math.round(performance.now() - startedAt)}ms`,
      );
    }
    return result;
  } catch (error) {
    if (options.logProgress) {
      options.log?.(
        `[bench] FAIL ${label} ${Math.round(performance.now() - startedAt)}ms: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    throw error;
  }
}

function wrapResponder(
  responder: BenchResponder,
  run: <T>(phase: string, fn: (signal: AbortSignal) => Promise<T>) => Promise<T>,
): BenchResponder {
  return {
    respond(question, recalledText) {
      return run("respond", (signal) =>
        responder.respond(question, recalledText, { signal }),
      );
    },
  };
}

function wrapJudge(
  judge: BenchJudge,
  run: <T>(phase: string, fn: (signal: AbortSignal) => Promise<T>) => Promise<T>,
): BenchJudge {
  const wrapped: BenchJudge = {
    score(question, predicted, expected) {
      return run("judge.score", (signal) =>
        judge.score(question, predicted, expected, { signal }),
      );
    },
  };

  if (judge.scoreWithMetrics) {
    wrapped.scoreWithMetrics = (question, predicted, expected) =>
      run("judge.scoreWithMetrics", (signal) =>
        judge.scoreWithMetrics!(question, predicted, expected, { signal }),
      );
  }

  return wrapped;
}

function readPositiveIntegerConfig(
  remnicConfig: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = remnicConfig?.[key];
  if (value === undefined) {
    return undefined;
  }
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    throw new Error(
      `${key} must be a positive integer when provided; received ${String(value)}.`,
    );
  }
  return numericValue;
}

function coerceBooleanConfig(value: unknown, key: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off", ""].includes(normalized)) {
      return false;
    }
  }
  throw new Error(
    `${key} must be a boolean when provided; received ${String(value)}.`,
  );
}

async function withTimeout<T>(
  label: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  onTimeout?: (label: string) => void | Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  let timeoutError: Error | undefined;
  const task = Promise.resolve().then(() => fn(controller.signal));
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timeoutError = new Error(
        `benchmark phase timed out after ${timeoutMs}ms: ${label}`,
      );
      reject(timeoutError);
      controller.abort(timeoutError);
      if (onTimeout) {
        void Promise.resolve(onTimeout(label)).catch(() => {});
      }
    }, timeoutMs);
  });

  try {
    return await Promise.race([task, timeout]);
  } catch (error) {
    if (error === timeoutError) {
      await Promise.race([
        task.then(
          () => undefined,
          () => undefined,
        ),
        delay(BENCHMARK_TIMEOUT_ABORT_GRACE_MS),
      ]);
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

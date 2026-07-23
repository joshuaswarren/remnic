import type {
  BenchJudge,
  BenchMemoryAdapter,
  BenchPhaseControl,
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
  timeoutMs?: number;
  drainTimeoutMs?: number;
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
  if (options.timeoutMs !== undefined) {
    assertPositiveTimeout(options.timeoutMs, "benchmark phase timeout");
  }
  if (options.drainTimeoutMs !== undefined) {
    assertPositiveTimeout(options.drainTimeoutMs, "benchmark drain timeout");
  }
  const phaseTimeoutMs = options.timeoutMs;
  const drainTimeoutMs = options.drainTimeoutMs ?? phaseTimeoutMs;

  const run = async <T>(
    phase: string,
    fn: (signal: AbortSignal) => Promise<T>,
    timeoutMs = phaseTimeoutMs,
  ): Promise<T> => {
    if (timeoutMs === undefined) {
      return fn(new AbortController().signal);
    }
    const label = `${options.benchmarkId}:${phase}`;
    return runWithBenchmarkPhaseTimeout(label, timeoutMs, fn, options);
  };

  const wrapped: BenchMemoryAdapter = {
    store(
      sessionId: string,
      messages: Message[],
      control?: BenchPhaseControl,
    ): Promise<void> {
      if (phaseTimeoutMs === undefined) {
        return adapter.store(sessionId, messages, control);
      }
      return run(`store session=${sessionId} messages=${messages.length}`, async (signal) => {
        const merged = mergeBenchPhaseControl(signal, control);
        try {
          return await adapter.store(sessionId, messages, merged.control);
        } finally {
          merged.cleanup();
        }
      });
    },
    recall(
      sessionId: string,
      query: string,
      budgetChars?: number,
      recallOptions?: BenchRecallOptions,
      control?: BenchPhaseControl,
    ): Promise<string> {
      if (phaseTimeoutMs === undefined) {
        return adapter.recall(sessionId, query, budgetChars, recallOptions, control);
      }
      return run(`recall session=${sessionId}`, async (signal) => {
        const merged = mergeBenchPhaseControl(signal, control);
        try {
          return await adapter.recall(
            sessionId,
            query,
            budgetChars,
            recallOptions,
            merged.control,
          );
        } finally {
          merged.cleanup();
        }
      });
    },
    search(
      query: string,
      limit: number,
      sessionId?: string,
      control?: BenchPhaseControl,
    ): Promise<SearchResult[]> {
      if (phaseTimeoutMs === undefined) {
        return adapter.search(query, limit, sessionId, control);
      }
      return run(`search session=${sessionId ?? "all"} limit=${limit}`, async (signal) => {
        const merged = mergeBenchPhaseControl(signal, control);
        try {
          return await adapter.search(query, limit, sessionId, merged.control);
        } finally {
          merged.cleanup();
        }
      });
    },
    reset(sessionId?: string, control?: BenchPhaseControl): Promise<void> {
      if (phaseTimeoutMs === undefined) {
        return adapter.reset(sessionId, control);
      }
      return run(`reset session=${sessionId ?? "all"}`, async (signal) => {
        const merged = mergeBenchPhaseControl(signal, control);
        try {
          return await adapter.reset(sessionId, merged.control);
        } finally {
          merged.cleanup();
        }
      });
    },
    getStats(sessionId?: string, control?: BenchPhaseControl): Promise<MemoryStats> {
      if (phaseTimeoutMs === undefined) {
        return adapter.getStats(sessionId, control);
      }
      return run(`stats session=${sessionId ?? "all"}`, async (signal) => {
        const merged = mergeBenchPhaseControl(signal, control);
        try {
          return await adapter.getStats(sessionId, merged.control);
        } finally {
          merged.cleanup();
        }
      });
    },
    destroy(): Promise<void> {
      return adapter.destroy();
    },
  };

  if (adapter.recallWithTrace) {
    wrapped.recallWithTrace = (
      sessionId,
      query,
      budgetChars,
      recallOptions,
      control,
    ) => {
      if (phaseTimeoutMs === undefined) {
        return adapter.recallWithTrace!(
          sessionId,
          query,
          budgetChars,
          recallOptions,
          control,
        );
      }
      return run(`recallWithTrace session=${sessionId}`, async (signal) => {
        const merged = mergeBenchPhaseControl(signal, control);
        try {
          return await adapter.recallWithTrace!(
            sessionId,
            query,
            budgetChars,
            recallOptions,
            merged.control,
          );
        } finally {
          merged.cleanup();
        }
      });
    };
  }

  if (adapter.drain) {
    wrapped.drain = (control?: BenchPhaseControl): Promise<void> =>
      drainTimeoutMs === undefined
        ? adapter.drain!(control)
        : run(
          "drain",
          async (signal) => {
            const merged = mergeBenchPhaseControl(signal, control);
            try {
              return await adapter.drain!(merged.control);
            } finally {
              merged.cleanup();
            }
          },
          drainTimeoutMs,
        );
  }
  if (adapter.correct) {
    // Preserve the optional correction-contract surface (issue #1584 plan
    // item 2a) — dropping it here would silently downgrade guarded MemCorrect
    // runs to the turn-store fallback while still labeling the run
    // contract-routed (codex P1).
    wrapped.correct = (
      sessionId: string,
      text: string,
      at?: string,
      control?: BenchPhaseControl,
    ): Promise<{ applied: boolean }> =>
      phaseTimeoutMs === undefined
        ? adapter.correct!(sessionId, text, at, control)
        : run(`correct session=${sessionId}`, async (signal) => {
          const merged = mergeBenchPhaseControl(signal, control);
          try {
            return await adapter.correct!(sessionId, text, at, merged.control);
          } finally {
            merged.cleanup();
          }
        });
  }
  if (adapter.responder) {
    wrapped.responder =
      phaseTimeoutMs === undefined
        ? adapter.responder
        : wrapResponder(adapter.responder, run);
  }
  if (adapter.judge) {
    wrapped.judge =
      phaseTimeoutMs === undefined ? adapter.judge : wrapJudge(adapter.judge, run);
  }

  return wrapped;
}

function mergeBenchPhaseControl(
  timeoutSignal: AbortSignal,
  callerControl: BenchPhaseControl | undefined,
): { control: BenchPhaseControl; cleanup: () => void } {
  const merged = mergeAbortSignals(timeoutSignal, callerControl?.signal);
  return {
    control: merged.signal === undefined ? {} : { signal: merged.signal },
    cleanup: merged.cleanup,
  };
}

function mergeAbortSignals(
  timeoutSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): { signal: AbortSignal | undefined; cleanup: () => void } {
  const noop = () => {};
  if (!callerSignal) return { signal: timeoutSignal, cleanup: noop };
  if (timeoutSignal.aborted) return { signal: timeoutSignal, cleanup: noop };
  if (callerSignal.aborted) {
    return { signal: AbortSignal.abort(callerSignal.reason), cleanup: noop };
  }

  const controller = new AbortController();
  const abortFromTimeout = () => controller.abort(timeoutSignal.reason);
  const abortFromCaller = () => controller.abort(callerSignal.reason);
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    timeoutSignal.removeEventListener("abort", abortFromTimeout);
    callerSignal.removeEventListener("abort", abortFromCaller);
  };
  timeoutSignal.addEventListener("abort", abortFromTimeout, { once: true });
  callerSignal.addEventListener("abort", abortFromCaller, { once: true });
  controller.signal.addEventListener("abort", cleanup, { once: true });
  return { signal: controller.signal, cleanup };
}

export function createTimeoutGuardedIngestionAdapter(
  adapter: IngestionBenchAdapter,
  options: TimeoutGuardOptions & { timeoutMs: number },
): IngestionBenchAdapter {
  assertPositiveTimeout(options.timeoutMs, "benchmark phase timeout");
  if (options.drainTimeoutMs !== undefined) {
    assertPositiveTimeout(options.drainTimeoutMs, "benchmark drain timeout");
  }
  const drainTimeoutMs = options.drainTimeoutMs ?? options.timeoutMs;

  const run = async <T>(
    phase: string,
    fn: (signal: AbortSignal) => Promise<T>,
    timeoutMs = options.timeoutMs,
  ): Promise<T> =>
    runWithBenchmarkPhaseTimeout(`${options.benchmarkId}:${phase}`, timeoutMs, fn, options);

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
    ...(adapter.drain
      ? {
          drain(): Promise<void> {
            return run(
              "ingestion.drain",
              () => adapter.drain?.() ?? Promise.resolve(),
              drainTimeoutMs,
            );
          },
        }
      : {}),
    destroy(): Promise<void> {
      return adapter.destroy();
    },
  };
}

function assertPositiveTimeout(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${label} must be a positive integer; received ${String(value)}.`,
    );
  }
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
  const wrapped: BenchResponder = {
    respond(question, recalledText, control) {
      return run("respond", async (signal) => {
        const merged = mergeBenchPhaseControl(signal, control);
        try {
          return await responder.respond(question, recalledText, merged.control);
        } finally {
          merged.cleanup();
        }
      });
    },
  };
  if (typeof responder.identity === "function") {
    const inner = responder.identity.bind(responder);
    wrapped.identity = () => inner();
  }
  return wrapped;
}

function wrapJudge(
  judge: BenchJudge,
  run: <T>(phase: string, fn: (signal: AbortSignal) => Promise<T>) => Promise<T>,
): BenchJudge {
  const wrapped: BenchJudge = {
    score(question, predicted, expected, control) {
      return run("judge.score", async (signal) => {
        const merged = mergeBenchPhaseControl(signal, control);
        try {
          return await judge.score(question, predicted, expected, merged.control);
        } finally {
          merged.cleanup();
        }
      });
    },
  };

  if (judge.scoreWithMetrics) {
    wrapped.scoreWithMetrics = (question, predicted, expected, control) =>
      run("judge.scoreWithMetrics", async (signal) => {
        const merged = mergeBenchPhaseControl(signal, control);
        try {
          return await judge.scoreWithMetrics!(
            question,
            predicted,
            expected,
            merged.control,
          );
        } finally {
          merged.cleanup();
        }
      });
  }

  if (judge.scoreBinaryPrompt) {
    wrapped.scoreBinaryPrompt = (prompt, control) =>
      run("judge.scoreBinaryPrompt", async (signal) => {
        const merged = mergeBenchPhaseControl(signal, control);
        try {
          return await judge.scoreBinaryPrompt!(prompt, merged.control);
        } finally {
          merged.cleanup();
        }
      });
  }

  if (judge.judgeMemCorrectCorrectionAcceptance) {
    wrapped.judgeMemCorrectCorrectionAcceptance = (request, control) =>
      run("judge.memcorrect.correctionAcceptance", async (signal) => {
        const merged = mergeBenchPhaseControl(signal, control);
        try {
          return await judge.judgeMemCorrectCorrectionAcceptance!(
            request,
            merged.control,
          );
        } finally {
          merged.cleanup();
        }
      });
  }

  if (judge.judgeMemCorrectStaleMemoryHarm) {
    wrapped.judgeMemCorrectStaleMemoryHarm = (request, control) =>
      run("judge.memcorrect.staleMemoryHarm", async (signal) => {
        const merged = mergeBenchPhaseControl(signal, control);
        try {
          return await judge.judgeMemCorrectStaleMemoryHarm!(
            request,
            merged.control,
          );
        } finally {
          merged.cleanup();
        }
      });
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

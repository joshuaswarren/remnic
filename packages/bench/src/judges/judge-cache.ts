
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type {
  BenchJudge,
  BenchJudgeResult,
  BenchPhaseControl,
  MemCorrectJudgeRequest,
  MemCorrectJudgeResult,
} from "../adapters/types.ts";

export interface JudgeCacheKeyParts {
  benchmarkId: string;
  datasetVersion: string;
  questionId: string;
  answerText: string;
  judgePromptHash: string;
  judgeModelId: string;
  judgeParamsHash: string;
}

export interface WrappableBenchJudge {
  score?(
    question: string,
    predicted: string,
    expected: string,
    control?: BenchPhaseControl,
  ): Promise<number>;
  scoreWithMetrics?(
    question: string,
    predicted: string,
    expected: string,
    control?: BenchPhaseControl,
  ): Promise<BenchJudgeResult>;
  scoreBinaryPrompt?(
    prompt: string,
    control?: BenchPhaseControl,
  ): Promise<BenchJudgeResult>;
  judgeMemCorrectCorrectionAcceptance?(
    request: MemCorrectJudgeRequest,
    control?: BenchPhaseControl,
  ): Promise<MemCorrectJudgeResult>;
  judgeMemCorrectStaleMemoryHarm?(
    request: MemCorrectJudgeRequest,
    control?: BenchPhaseControl,
  ): Promise<MemCorrectJudgeResult>;
}

export interface JudgeCacheHit {
  cacheHit: true;
  verdict: BenchJudgeResult;
  /** Wall-clock ISO timestamp recorded when the entry was first written. */
  storedAt: string;
}

export interface JudgeCacheOptions {
  /** Directory used to persist entries. The directory is created on demand. */
  dir: string;
}

export interface JudgeCacheCounters {
  modelCalls: number;
  cacheHits: number;
  cacheMisses: number;
  /**
   * Judge succeeded but persisting the verdict failed (disk full,
   * permissions, …). The fresh verdict is still returned to the caller —
   * a cache-write failure must never fail the task (PR #1591, P1).
   */
  cacheWriteFailures: number;
}

interface CacheEnvelope {
  storedAt: string;
  key: string;
  verdict: BenchJudgeResult;
}

/**
 * Version token folded into every cache key via the wiring's
 * `judgePromptHash`. Bump when judge prompt construction, rubric parsing, or
 * verdict semantics change in a way that invalidates previously stored
 * verdicts — different judge implementations must never reuse each other's
 * entries (PR #1591 review, High).
 */
export const JUDGE_CACHE_PROTOCOL_VERSION = "judge-protocol-v1";

/**
 * Deterministic JSON serialization: object keys sorted recursively so two
 * semantically identical configs hash identically regardless of insertion
 * order (CLAUDE.md rule 26). Arrays keep their order; non-object leaves
 * delegate to JSON.stringify.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const body = keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export class JudgeCache {
  private readonly dir: string;
  private readonly writeQueues: Map<string, Promise<void>> = new Map();
  private readonly inflight: Map<string, CacheEnvelope> = new Map();
  private cachedDirExists = false;

  constructor(options: JudgeCacheOptions) {
    this.dir = path.resolve(options.dir);
  }

  computeKey(parts: JudgeCacheKeyParts): string {
    const fieldDigest = (value: string): Buffer =>
      createHash("sha256").update(value).digest();
    return createHash("sha256")
      .update(fieldDigest(parts.benchmarkId))
      .update(fieldDigest(parts.datasetVersion))
      .update(fieldDigest(parts.questionId))
      .update(fieldDigest(parts.answerText))
      .update(fieldDigest(parts.judgePromptHash))
      .update(fieldDigest(parts.judgeModelId))
      .update(fieldDigest(parts.judgeParamsHash))
      .digest("hex");
  }

  /**
   * Read a previously-stored verdict. Returns `undefined` on miss, corrupted
   * entry, missing required field, or read error — never throws, never
   * fabricates.
   */
  async get(parts: JudgeCacheKeyParts): Promise<JudgeCacheHit | undefined> {
    const key = this.computeKey(parts);
    const inflightHit = this.inflight.get(key);
    if (inflightHit !== undefined) {
      return {
        cacheHit: true,
        verdict: inflightHit.verdict,
        storedAt: inflightHit.storedAt,
      };
    }
    const filePath = this.entryPath(key);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      return undefined;
    }
    const envelope = parseEnvelope(raw);
    if (envelope === undefined) return undefined;
    return {
      cacheHit: true,
      verdict: envelope.verdict,
      storedAt: envelope.storedAt,
    };
  }

  /**
   * Persist a verdict atomically: write to a temp file then rename into
   * place. Concurrent writes for the same key serialize via an in-memory
   * chain so the temp-file never lands on top of a sibling rename.
   */
  async put(parts: JudgeCacheKeyParts, verdict: BenchJudgeResult): Promise<void> {
    const key = this.computeKey(parts);
    const envelope: CacheEnvelope = {
      storedAt: new Date().toISOString(),
      key,
      verdict,
    };
    this.inflight.set(key, envelope);
    const prior = this.writeQueues.get(key) ?? Promise.resolve();
    const next = prior.then(() => this.writeOne(key, envelope));
    const tracked = next.catch(() => undefined);
    this.writeQueues.set(key, tracked);
    try {
      await next;
    } finally {
      if (this.writeQueues.get(key) === tracked) {
        this.writeQueues.delete(key);
      }
      if (this.inflight.get(key) === envelope) {
        this.inflight.delete(key);
      }
    }
  }

  /** Number of in-flight per-key write chains (diagnostic/test seam). */
  pendingWriteCount(): number {
    return this.writeQueues.size;
  }

  private async writeOne(
    key: string,
    envelope: CacheEnvelope,
  ): Promise<void> {
    if (!this.cachedDirExists) {
      await mkdir(this.dir, { recursive: true });
      this.cachedDirExists = true;
    }
    const filePath = this.entryPath(key);
    const tempPath = path.join(
      this.dir,
      `.${key}.${randomBytes(6).toString("hex")}.tmp`,
    );
    await writeFile(tempPath, `${JSON.stringify(envelope)}\n`, "utf8");
    try {
      await rename(tempPath, filePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private entryPath(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }
}

/**
 * Options accepted by {@link runJudgeWithCache}. When `cache` is null the
 * wrapper is a pass-through: every call goes straight to the underlying judge
 * so disabled-cache mode is byte-identical to the no-wrapper baseline.
 */
export interface RunJudgeWithCacheOptions {
  judge: WrappableBenchJudge;
  /** Null disables caching entirely (the characterization mode). */
  cache: JudgeCache | null;
  /** Cache-key fields that are constant across the whole run. */
  keyExtras?: {
    benchmarkId?: string;
    datasetVersion?: string;
    judgePromptHash?: string;
    judgeModelId?: string;
    judgeParamsHash?: string;
  };
}

/**
 * Wraps a {@link WrappableBenchJudge} so every score call either serves a
 * cached verdict or falls through to the underlying judge and stores the
 * fresh verdict. The returned object exposes live counters that callers can
 * read after a run to drive telemetry (e.g. report a "judge calls" line).
 */
export function runJudgeWithCache(options: RunJudgeWithCacheOptions): BenchJudge & {
  counters: JudgeCacheCounters;
  cache: JudgeCache | null;
  drainPendingWrites: () => Promise<void>;
} {
  const { judge, cache } = options;
  const keyExtras = options.keyExtras ?? {};
  const counters: JudgeCacheCounters = {
    modelCalls: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheWriteFailures: 0,
  };

  let pendingWrites: Promise<void> = Promise.resolve();

  const putSafely = (
    parts: JudgeCacheKeyParts,
    verdict: BenchJudgeResult,
    control?: BenchPhaseControl,
  ): void => {
    if (!cache) return;
    if (control?.signal?.aborted) return;
    const write = cache.put(parts, verdict).catch(() => {
      counters.cacheWriteFailures += 1;
    });
    pendingWrites = pendingWrites.then(() => write);
  };


const CACHE_READ_BUDGET_MS = 250;
async function readCacheWithAbort(
  cache: JudgeCache,
  parts: JudgeCacheKeyParts,
  control: BenchPhaseControl | undefined,
): Promise<JudgeCacheHit | undefined> {
  if (control?.signal?.aborted) return undefined;
  const read = cache.get(parts);
  const readBudget = new Promise<undefined>((resolveBudget) => {
    setTimeout(() => { resolveBudget(undefined); }, CACHE_READ_BUDGET_MS);
  });
  return Promise.race<JudgeCacheHit | undefined>([read, readBudget]);
}

  const cachedVerdict = (stored: BenchJudgeResult): BenchJudgeResult => ({
    score: stored.score,
    tokens: { input: 0, output: 0 },
    latencyMs: 0,
    ...(stored.model !== undefined ? { model: stored.model } : {}),
  });
  const wrapper = {
    counters,
    cache,
    drainPendingWrites: () => pendingWrites,

    async score(
      question: string,
      predicted: string,
      expected: string,
      control?: BenchPhaseControl,
    ): Promise<number> {
      const detailed = await wrapper.scoreWithMetrics!(
        question,
        predicted,
        expected,
        control,
      );
      return detailed.score;
    },

    async scoreWithMetrics(
      question: string,
      predicted: string,
      expected: string,
      control?: BenchPhaseControl,
    ): Promise<BenchJudgeResult> {
      const answerText = `${predicted}\u0001${expected}`;
      const parts: JudgeCacheKeyParts = {
        benchmarkId: keyExtras.benchmarkId ?? "unknown-benchmark",
        datasetVersion: keyExtras.datasetVersion ?? "unknown-version",
        questionId: question,
        answerText,
        judgePromptHash: keyExtras.judgePromptHash ?? "unknown-prompt",
        judgeModelId: keyExtras.judgeModelId ?? "unknown-judge",
        judgeParamsHash: keyExtras.judgeParamsHash ?? "unknown-params",
      };

      if (cache) {
        let hit: JudgeCacheHit | undefined;
        try {
          hit = await readCacheWithAbort(cache, parts, control);
        } catch {
          hit = undefined;
        }
        if (hit) {
          counters.cacheHits += 1;
          return cachedVerdict(hit.verdict);
        }
        counters.cacheMisses += 1;
      }

      if (!judge.scoreWithMetrics) {
        counters.modelCalls += 1;
        const scoreStartedAt = Date.now();
        const scoreValue = judge.score
          ? await judge.score(question, predicted, expected, control)
          : 0;
        const synthesized: BenchJudgeResult = {
          score: scoreValue,
          tokens: { input: 0, output: 0 },
          latencyMs: Date.now() - scoreStartedAt,
          model: keyExtras.judgeModelId ?? undefined,
        };
        putSafely(parts, synthesized, control);
        return synthesized;
      }

      counters.modelCalls += 1;
      const fresh = await judge.scoreWithMetrics(
        question,
        predicted,
        expected,
        control,
      );
      putSafely(parts, fresh, control);
      return fresh;
    },

  };

  if (typeof judge.scoreBinaryPrompt === "function") {
    Object.defineProperty(wrapper, "scoreBinaryPrompt", {
      configurable: true,
      enumerable: true,
      writable: false,
      value: async function scoreBinaryPrompt(
        prompt: string,
        control?: BenchPhaseControl,
      ): Promise<BenchJudgeResult> {
        const parts: JudgeCacheKeyParts = {
          benchmarkId: keyExtras.benchmarkId ?? "unknown-benchmark",
          datasetVersion: keyExtras.datasetVersion ?? "unknown-version",
          questionId: `binary:${createHash("sha256")
            .update(prompt)
            .digest("hex")
            .slice(0, 16)}`,
          answerText: prompt,
          judgePromptHash: keyExtras.judgePromptHash ?? "unknown-prompt",
          judgeModelId: keyExtras.judgeModelId ?? "unknown-judge",
          judgeParamsHash: keyExtras.judgeParamsHash ?? "unknown-params",
        };
        if (cache) {
          let hit: JudgeCacheHit | undefined;
          try {
            hit = await readCacheWithAbort(cache, parts, control);
          } catch {
            hit = undefined;
          }
          if (hit) {
            counters.cacheHits += 1;
            return cachedVerdict(hit.verdict);
          }
          counters.cacheMisses += 1;
        }
        counters.modelCalls += 1;
        const fresh = await judge.scoreBinaryPrompt!(prompt, control);
        putSafely(parts, fresh, control);
        return fresh;
      },
    });
  }

  if (typeof judge.judgeMemCorrectCorrectionAcceptance === "function") {
    Object.defineProperty(wrapper, "judgeMemCorrectCorrectionAcceptance", {
      configurable: true,
      enumerable: true,
      writable: false,
      value: (request: MemCorrectJudgeRequest, control?: BenchPhaseControl) =>
        judge.judgeMemCorrectCorrectionAcceptance!(request, control),
    });
  }
  if (typeof judge.judgeMemCorrectStaleMemoryHarm === "function") {
    Object.defineProperty(wrapper, "judgeMemCorrectStaleMemoryHarm", {
      configurable: true,
      enumerable: true,
      writable: false,
      value: (request: MemCorrectJudgeRequest, control?: BenchPhaseControl) =>
        judge.judgeMemCorrectStaleMemoryHarm!(request, control),
    });
  }

  return wrapper as unknown as BenchJudge & {
    counters: JudgeCacheCounters;
    cache: JudgeCache | null;
    drainPendingWrites: () => Promise<void>;
  };
}


function parseEnvelope(raw: string): CacheEnvelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const candidate = parsed as Partial<CacheEnvelope>;
  if (typeof candidate.storedAt !== "string") return undefined;
  if (typeof candidate.key !== "string") return undefined;
  if (!isBenchJudgeResult(candidate.verdict)) return undefined;
  return candidate as CacheEnvelope;
}

function isBenchJudgeResult(value: unknown): value is BenchJudgeResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const v = value as Partial<BenchJudgeResult>;
  if (typeof v.score !== "number" || !Number.isFinite(v.score)) return false;
  if (v.tokens === null || typeof v.tokens !== "object" || Array.isArray(v.tokens)) {
    return false;
  }
  const tokens = v.tokens as { input?: unknown; output?: unknown };
  if (typeof tokens.input !== "number" || !Number.isFinite(tokens.input)) return false;
  if (typeof tokens.output !== "number" || !Number.isFinite(tokens.output)) return false;
  if (typeof v.latencyMs !== "number" || !Number.isFinite(v.latencyMs)) return false;
  if (v.model !== undefined && typeof v.model !== "string") return false;
  return true;
}

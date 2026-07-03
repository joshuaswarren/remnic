/**
 * Content-keyed cache for judge verdicts.
 *
 * Issue #1573 (PR 1): persist judge decisions to disk so unchanged answers
 * cost zero judge model calls on re-run. Cache key is sha256 over
 *   benchmarkId | datasetVersion | questionId | sha256(answerText)
 *              | judgePromptHash | judgeModelId | judgeParamsHash
 * Value: full judge verdict JSON + timestamp, persisted as one-file-per-key
 * under a bench results "state" sibling directory.
 *
 * See packages/bench/src/judges/judge-cache.test.ts for the contract.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { BenchJudge, BenchJudgeResult } from "../adapters/types.ts";

/** Inputs fed into {@link JudgeCache}. All fields are required. */
export interface JudgeCacheKeyParts {
  benchmarkId: string;
  datasetVersion: string;
  questionId: string;
  answerText: string;
  judgePromptHash: string;
  judgeModelId: string;
  judgeParamsHash: string;
}

/** Wrapper-friendly bench-judge surface. */
export interface WrappableBenchJudge {
  score?(question: string, predicted: string, expected: string): Promise<number>;
  scoreWithMetrics?(
    question: string,
    predicted: string,
    expected: string,
  ): Promise<BenchJudgeResult>;
  scoreBinaryPrompt?(prompt: string): Promise<BenchJudgeResult>;
}

/** Result returned by {@link JudgeCache.get}. */
export interface JudgeCacheHit {
  cacheHit: true;
  /** The value the producer originally passed to {@link JudgeCache.put}. */
  verdict: BenchJudgeResult;
  /** Wall-clock ISO timestamp recorded when the entry was first written. */
  storedAt: string;
}

/** Constructor options for {@link JudgeCache}. */
export interface JudgeCacheOptions {
  /** Directory used to persist entries. The directory is created on demand. */
  dir: string;
}

/** Live counters that callers (runners, reports) can read for telemetry. */
export interface JudgeCacheCounters {
  modelCalls: number;
  cacheHits: number;
  cacheMisses: number;
}

interface CacheEnvelope {
  storedAt: string;
  key: string;
  verdict: BenchJudgeResult;
}

const PIPE_SEPARATOR = "|";

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

/**
 * Cache store. Pure module — every instance owns its own state, and there are
 * no module-level mutable handles (rule 11). Hang one off the runner instance.
 */
export class JudgeCache {
  private readonly dir: string;
  // Per-key write serialization so concurrent writers never race a temp-file
  // rename into place for the same key. Cached entries are read straight from
  // disk, so reads remain lock-free.
  private readonly writeQueues: Map<string, Promise<void>> = new Map();
  private cachedDirExists = false;

  constructor(options: JudgeCacheOptions) {
    this.dir = path.resolve(options.dir);
  }

  /** Compute the sha256-hex key for a set of parts. Pure, sync, side-effect-free. */
  computeKey(parts: JudgeCacheKeyParts): string {
    return createHash("sha256")
      .update(parts.benchmarkId)
      .update(PIPE_SEPARATOR)
      .update(parts.datasetVersion)
      .update(PIPE_SEPARATOR)
      .update(parts.questionId)
      .update(PIPE_SEPARATOR)
      .update(createHash("sha256").update(parts.answerText).digest("hex"))
      .update(PIPE_SEPARATOR)
      .update(parts.judgePromptHash)
      .update(PIPE_SEPARATOR)
      .update(parts.judgeModelId)
      .update(PIPE_SEPARATOR)
      .update(parts.judgeParamsHash)
      .digest("hex");
  }

  /**
   * Read a previously-stored verdict. Returns `undefined` on miss, corrupted
   * entry, missing required field, or read error — never throws, never
   * fabricates.
   */
  async get(parts: JudgeCacheKeyParts): Promise<JudgeCacheHit | undefined> {
    const key = this.computeKey(parts);
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
    const prior = this.writeQueues.get(key) ?? Promise.resolve();
    const next = prior.then(() => this.writeOne(key, parts, verdict));
    // Track ONE settled-safe promise object so the finally-block identity
    // check can succeed; a fresh `.catch()` per comparison would never match
    // and the per-key entry would leak (PR #1591 review, Medium).
    const tracked = next.catch(() => undefined);
    this.writeQueues.set(key, tracked);
    try {
      await next;
    } finally {
      if (this.writeQueues.get(key) === tracked) {
        this.writeQueues.delete(key);
      }
    }
  }

  /** Number of in-flight per-key write chains (diagnostic/test seam). */
  pendingWriteCount(): number {
    return this.writeQueues.size;
  }

  private async writeOne(
    key: string,
    parts: JudgeCacheKeyParts,
    verdict: BenchJudgeResult,
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
    const envelope: CacheEnvelope = {
      storedAt: new Date().toISOString(),
      key,
      verdict,
    };
    await writeFile(tempPath, `${JSON.stringify(envelope)}\n`, "utf8");
    try {
      await rename(tempPath, filePath);
    } catch (error) {
      // Best-effort cleanup if rename fails after the temp file was written.
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    // Silence unused-locals ts rule — keep `parts` for future debugging hooks.
    void parts;
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
} {
  const { judge, cache } = options;
  const keyExtras = options.keyExtras ?? {};
  const counters: JudgeCacheCounters = {
    modelCalls: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };

  const wrapper = {
    counters,
    cache,

    async score(question: string, predicted: string, expected: string): Promise<number> {
      const detailed = await wrapper.scoreWithMetrics!(question, predicted, expected);
      return detailed.score;
    },

    async scoreWithMetrics(
      question: string,
      predicted: string,
      expected: string,
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
        const hit = await cache.get(parts);
        if (hit) {
          counters.cacheHits += 1;
          return hit.verdict;
        }
        counters.cacheMisses += 1;
      }

      if (!judge.scoreWithMetrics) {
        // Fall back to score() then synthesize a result shape.
        const scoreValue = judge.score
          ? await judge.score(question, predicted, expected)
          : 0;
        const synthesized: BenchJudgeResult = {
          score: scoreValue,
          tokens: { input: 0, output: 0 },
          latencyMs: 0,
          model: keyExtras.judgeModelId ?? undefined,
        };
        counters.modelCalls += 1;
        if (cache) await cache.put(parts, synthesized);
        return synthesized;
      }

      const fresh = await judge.scoreWithMetrics(question, predicted, expected);
      counters.modelCalls += 1;
      if (cache) await cache.put(parts, fresh);
      return fresh;
    },

    async scoreBinaryPrompt(prompt: string): Promise<BenchJudgeResult> {
      if (!judge.scoreBinaryPrompt) {
        const fallback: BenchJudgeResult = {
          score: 0,
          tokens: { input: 0, output: 0 },
          latencyMs: 0,
          model: keyExtras.judgeModelId ?? undefined,
        };
        return fallback;
      }
      const parts: JudgeCacheKeyParts = {
        benchmarkId: keyExtras.benchmarkId ?? "unknown-benchmark",
        datasetVersion: keyExtras.datasetVersion ?? "unknown-version",
        questionId: `binary:${prompt.length}`,
        answerText: prompt,
        judgePromptHash: keyExtras.judgePromptHash ?? "unknown-prompt",
        judgeModelId: keyExtras.judgeModelId ?? "unknown-judge",
        judgeParamsHash: keyExtras.judgeParamsHash ?? "unknown-params",
      };

      if (cache) {
        const hit = await cache.get(parts);
        if (hit) {
          counters.cacheHits += 1;
          return hit.verdict;
        }
        counters.cacheMisses += 1;
      }

      const fresh = await judge.scoreBinaryPrompt(prompt);
      counters.modelCalls += 1;
      if (cache) await cache.put(parts, fresh);
      return fresh;
    },
  };

  return wrapper as BenchJudge & {
    counters: JudgeCacheCounters;
    cache: JudgeCache | null;
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

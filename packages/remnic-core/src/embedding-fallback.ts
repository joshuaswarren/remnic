import path from "node:path";
import { log } from "./logger.js";
import {
  resolveMemoryLifecycleCapabilities,
  resolveLocalLlmCapabilities,
} from "./capabilities.js";
import { readEnvVar } from "./runtime/env.js";
import type { PluginConfig } from "./types.js";
import { resolvePipelineProcessingCapabilities } from "./capabilities.js";
import {
  getHostEmbeddingProvider,
  type HostEmbeddingProvider,
  normalizeHostEmbeddingVector,
} from "./host-embedding-provider.js";
import {
  EmbeddingIndexFileStore,
  EmbeddingIndexStorageError,
  type EmbeddingIndexEntry,
  type EmbeddingIndexFile,
  type EmbeddingIndexIdentity,
  type EmbeddingProviderType,
  EmbeddingIndexStoreIo,
} from "./embedding-index-storage.js";
export {
  EmbeddingIndexCapacityError,
  EmbeddingIndexStorageError,
} from "./embedding-index-storage.js";
export type {
  EmbeddingIndexStatusFile,
  EmbeddingIndexWriteFailure,
} from "./embedding-index-storage.js";
type ProviderConfig = {
  type: EmbeddingProviderType;
  model: string;
  endpoint?: string;
  headers?: Record<string, string>;
  hostProvider?: HostEmbeddingProvider;
};

type EmbeddingResult = {
  provider: ProviderConfig;
  vector: number[];
};

type EmbeddingIndexComparable =
  | EmbeddingIndexIdentity
  | Pick<ProviderConfig, "type" | "model">;

const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";

/**
 * Thrown by `EmbeddingFallback.search()` (via `embed()`) when the embedding
 * backend is effectively unavailable on the lookup path — either because the
 * HTTP fetch exceeded its deadline OR because the endpoint returned a non-2xx
 * status code. Callers that need to distinguish a backend outage from "no
 * candidates" can `instanceof`-check against this class.
 *
 * Round 9 fix (Finding UZqB): previously a timeout returned null from embed(),
 * which caused search() to return [] silently. decideSemanticDedup then
 * classified the result as no_candidates instead of backend_unavailable, so
 * the per-batch batchBackendUnavailable short-circuit never activated and
 * batches of N facts each paid a full timeout roundtrip.
 *
 * Round 10 fix (Findings Ui1J + Ui1L): search() now only re-throws this error
 * when the caller explicitly passes `{ throwOnTimeout: true }`. Without that
 * flag search() catches it and returns [] instead, preserving fail-open
 * semantics for recall-path callers (searchEmbeddingFallback) that have no
 * try/catch. Only the semantic-dedup path (semanticDedupLookup) passes the
 * flag so it can still reach decideSemanticDedup's backend_unavailable branch.
 *
 * Round 11 fix (Finding Ur_J): `embed()` now also throws this error from the
 * lookup path when the HTTP response is non-2xx (e.g. 429, 500, 503). Without
 * this, repeated 5xx outages would each return null → [] → no_candidates and
 * subsequent facts in the same batch would all pay full roundtrips instead of
 * tripping the per-batch backend_unavailable short-circuit.
 *
 * The class name is kept for backward compatibility — `EmbeddingTimeoutError`
 * now signals "lookup backend unavailable" rather than strictly "timed out".
 */
import {
  assertEmbeddingGenerationLockHeld,
  embeddingGenerationLockPath,
  EmbeddingGenerationLockUnavailableError,
  withEmbeddingGenerationLock,
  type EmbeddingGenerationLockSection,
} from "./embedding-generation-lock.js";

export class EmbeddingTimeoutError extends Error {
  override readonly name = "EmbeddingTimeoutError" as const;
  constructor(message: string) {
    super(message);
  }
}

export class EmbeddingProviderUnavailableError extends Error {
  override readonly name = "EmbeddingProviderUnavailableError" as const;
  constructor(message: string) {
    super(message);
  }
}

function isLookupBackendUnavailableError(err: unknown): boolean {
  return (
    err instanceof EmbeddingTimeoutError ||
    err instanceof EmbeddingProviderUnavailableError
  );
}

/**
 * Maximum time to wait for an embedding HTTP request on the LOOKUP/query
 * path before giving up.
 *
 * The write-time semantic dedup guard in orchestrator.persistExtraction()
 * blocks each candidate fact on an embedding lookup. If the embedding
 * endpoint hangs (degraded OpenAI, stalled local gateway, DNS timeout),
 * extraction would otherwise stall indefinitely — a single bad backend
 * could freeze the entire persist loop. Bounding the fetch here ensures
 * the decision path fails open (returns null) within a predictable window
 * and writes proceed as non-duplicates.
 *
 * Tests can override via REMNIC_EMBEDDING_FETCH_TIMEOUT_MS so they don't
 * have to wait the full default on hung-fetch assertions.
 *
 * Related: joshuaswarren/remnic#373, PR #399 P1/P2 review.
 */
const DEFAULT_EMBEDDING_LOOKUP_TIMEOUT_MS = 5000;

/**
 * Maximum time to wait for an embedding HTTP request on the INDEX path.
 *
 * Indexing runs asynchronously after a memory has already been persisted
 * to disk. It does not block extraction or writes — it only updates the
 * embedding index used by later semantic dedup lookups. A slow local
 * CPU-backed embedding model can legitimately take tens of seconds per
 * call, so applying the short lookup timeout here silently dropped index
 * updates and caused later dedup lookups to miss recently persisted
 * memories. Use a much larger budget on this path.
 *
 * Tests can override via REMNIC_EMBEDDING_INDEX_TIMEOUT_MS.
 */
const DEFAULT_EMBEDDING_INDEX_TIMEOUT_MS = 120_000;

function resolveEmbeddingLookupTimeoutMs(): number {
  const raw = readEnvVar("REMNIC_EMBEDDING_FETCH_TIMEOUT_MS");
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return DEFAULT_EMBEDDING_LOOKUP_TIMEOUT_MS;
}

function resolveEmbeddingIndexTimeoutMs(): number {
  const raw = readEnvVar("REMNIC_EMBEDDING_INDEX_TIMEOUT_MS");
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return DEFAULT_EMBEDDING_INDEX_TIMEOUT_MS;
}

/**
 * Options for the low-level embed() call.
 *
 * `mode` selects the timeout profile:
 *   - "lookup" (default): bounded by the short lookup budget; fails open fast.
 *   - "index": bounded by a much longer budget so slow backends can still
 *     index newly persisted memories.
 */
export type EmbedMode = "lookup" | "index";

export class EmbeddingFallback {
  private readonly store: EmbeddingIndexFileStore;
  private loaded: EmbeddingIndexFile | null = null;
  /** True when `loaded` was read from disk rather than started fresh, so identity probes can trust it. */
  private loadedFromDisk = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  /** The canonical state dir scoping this fallback's generation mutation lock. */
  private readonly generationStateDir: string;
  private readonly generationLockPath: string;
  private lockSection: EmbeddingGenerationLockSection | null = null;

  constructor(private readonly config: PluginConfig, storeIo?: EmbeddingIndexStoreIo) {
    const stateDir = path.join(config.memoryDir, "state");
    this.generationStateDir = stateDir;
    this.generationLockPath = embeddingGenerationLockPath(stateDir);
    this.store = new EmbeddingIndexFileStore(
      path.join(stateDir, "embeddings.json"),
      path.join(stateDir, "embeddings"),
      path.join(stateDir, "embedding-fallback-status.json"),
      storeIo,
    );
  }

  async isAvailable(): Promise<boolean> {
    return (await this.resolveProvider()) !== null;
  }

  /**
   * Embed an array of texts and return their embedding vectors.
   *
   * This is the public batch-embed interface used by semantic chunking
   * (Finding 1, PR #420 post-merge). Texts are grouped into batches of
   * `embeddingBatchSize` (from `semanticChunkingConfig`, default 32) and
   * each batch is dispatched concurrently via `Promise.all()`. This
   * preserves the semantic intent of `embeddingBatchSize` — without batching,
   * every text incurred a sequential HTTP round-trip, making the batch size
   * config ineffective. (PR #439 post-merge Finding 2.)
   *
   * If the provider is unavailable or any single embedding fails, the method
   * throws so the caller can fall back to recursive chunking.
   */
  async embedTexts(texts: string[]): Promise<number[][]> {
    const provider = await this.resolveProvider();
    if (!provider) {
      throw new Error("Embedding provider is not available");
    }

    const batchSize = Math.max(
      1,
      this.config.semanticChunkingConfig?.embeddingBatchSize ?? 32,
    );

    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map((text) => this.embed(text, provider, { mode: "lookup" })),
      );
      for (const vec of batchResults) {
        if (!vec) {
          throw new Error("Embedding returned null for input text");
        }
        vectors.push(vec);
      }
    }
    return vectors;
  }

  /**
   * Nearest-neighbor search against the embedding index.
   *
   * @param query         The query string to embed and search for.
   * @param limit         Max number of hits to return.
   * @param options       Optional filters.
   *   - `pathPrefix`   Restrict candidates to entries whose indexed `path`
   *                    starts with this prefix (relative to `memoryDir`).
   *                    Used by the semantic dedup guard to scope lookups
   *                    to the target namespace so a high-similarity hit
   *                    from a different namespace can't suppress a write
   *                    in the target namespace. Default: no filter.
   *   - `pathExcludePrefixes`
   *                    Exclude any entry whose indexed `path` starts with
   *                    any of these prefixes. Used for the default
   *                    namespace case: when the default namespace lives at
   *                    `memoryDir` root (legacy layout) we still want to
   *                    exclude `namespaces/<other>/…` entries.
   */
  async search(
    query: string,
    limit: number,
    options: {
      pathPrefix?: string;
      pathExcludePrefixes?: readonly string[];
      /**
       * When true, an `EmbeddingTimeoutError` from the embedding backend is
       * re-thrown to the caller. Use this on the semantic-dedup path so
       * `decideSemanticDedup`'s catch block can classify the result as
       * `reason="backend_unavailable"` and activate the per-batch
       * short-circuit.
       *
       * When false (the default), a timeout is caught here and search()
       * returns [] instead — preserving fail-open semantics for the recall
       * path (`searchEmbeddingFallback`) which has no surrounding try/catch.
       * Without this gate a timed-out embedding request on the recall path
       * would propagate as an unhandled rejection and abort recall entirely.
       * (Round 10 fix, Findings Ui1J + Ui1L.)
       */
      throwOnTimeout?: boolean;
    } = {},
  ): Promise<Array<{ id: string; score: number; path: string }>> {
    const provider = await this.resolveProvider();
    if (!provider) return [];

    let queryResult = await this.embedForSearch(query, provider, options);
    if (!queryResult) return [];
    // Effective query embedding: swapped to the disk index's provider
    // below when the on-disk generation has a different identity. `let` so
    // the swap reassigns; TS narrowing bound for control flow.
    let active = queryResult;

    // Recall fails OPEN on index read failures (corrupt/oversized/mixed
    // generations, unreadable shard dirs): return [] without caching so a
    // later mutation still revalidates and fails closed (issue #3146).
    try {
      const diskIdentity = await this.readIndexIdentityFromDisk();
      if (diskIdentity && !sameIndexIdentity(diskIdentity, queryResult.provider)) {
        // The provider swap needs a NETWORK embed: run it OUTSIDE the
        // generation lock, then re-verify the identity under the lock below.
        const diskProvider = await this.resolveFallbackProviderForIndexIdentity(diskIdentity);
        if (diskProvider) {
          const diskQueryResult = await this.embedForSearch(query, diskProvider, options);
          if (diskQueryResult && sameIndexIdentity(diskIdentity, diskQueryResult.provider)) {
            active = diskQueryResult;
          } else {
            log.debug(
              `embedding fallback search skipped: preserved ${diskIdentity.provider}/${diskIdentity.model} index is unavailable for lookup`,
            );
            return [];
          }
        } else {
          log.debug(
            `embedding fallback search skipped: query provider ${queryResult.provider.type}/${queryResult.provider.model} does not match existing ${diskIdentity.provider}/${diskIdentity.model} index`,
          );
          return [];
        }
      }

      // Cold load only (cache miss): the complete shard enumeration + read
      // happens under the generation mutation lock so a concurrent swap can
      // never leave a cached SUBSET of the generation (codex
      // PRRT_kwDORJXyws6mZ72p). Warm cached searches stay lock-free.
      let index: EmbeddingIndexFile;
      try {
        index = await this.loadIndexUnderGenerationLock(active.provider);
      } catch (err) {
        if (err instanceof EmbeddingGenerationLockUnavailableError) {
          // Existing read diagnostic, recorded once per failed load; recall
          // itself fails open.
          await this.store.recordIndexStatusForLoad(
            `generation mutation lock unavailable: ${err instanceof Error ? err.message : String(err)}`,
          );
          return [];
        }
        throw err;
      }
      const ids = Object.keys(index.entries);
      if (ids.length === 0) return [];

      const includePrefix = normalizePathPrefix(options.pathPrefix);
      const excludePrefixes = (options.pathExcludePrefixes ?? [])
        .map((p) => normalizePathPrefix(p))
        .filter((p): p is string => typeof p === "string");

      const scored = ids
        .map((id) => {
          const entry = index.entries[id];
          return {
            id,
            path: entry.path,
            score: cosineSimilarity(active.vector, entry.vector),
          };
        })
        .filter((r) => {
          if (!Number.isFinite(r.score)) return false;
          const normalized = normalizeEntryPath(r.path);
          if (includePrefix !== undefined && !normalized.startsWith(includePrefix)) {
            return false;
          }
          for (const excl of excludePrefixes) {
            if (normalized.startsWith(excl)) return false;
          }
          return true;
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, limit));

      return scored;
    } catch (err) {
      if (err instanceof EmbeddingIndexStorageError) {
        log.debug(
          `embedding fallback index unreadable on recall path, failing open: ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
      throw err;
    }
  }

  async indexFile(memoryId: string, content: string, filePath: string): Promise<void> {
    const provider = await this.resolveProvider();
    if (!provider) return;
    // Indexing is not on the write-critical path: a newly persisted memory
    // has already been written to disk by the time we reach this call. Use
    // the long "index" timeout so slow local embedding backends can still
    // add the entry to the index. Previously this used the short lookup
    // budget and silently dropped updates, leaving later dedup lookups
    // blind to the memory. Related: PR #399 P2.
    const result = await this.embedWithEffectiveProvider(content, provider, {
      mode: "index",
    });
    if (!result) return;

    await this.enqueueIndexMutation(memoryId, async () => {
      try {
        const existing = await this.readIndexIdentityFromDisk();
        if (
          existing &&
          !sameIndexIdentity(existing, result.provider) &&
          !canReplaceIndexIdentity(existing, result.provider)
        ) {
          log.debug(
            `embedding fallback index update skipped: ${result.provider.type}/${result.provider.model} would replace existing ${existing.provider}/${existing.model} index`,
          );
          return;
        }
        const index = await this.loadIndex(result.provider);
        const relPath = toMemoryRelativePath(this.config.memoryDir, filePath);
        index.entries[memoryId] = {
          vector: result.vector,
          path: relPath,
        };
        await this.saveIndex(index, { touchedIds: [memoryId], memoryId });
      } catch (err) {
        await this.store.recordIndexWriteOutcome(err, memoryId);
        throw err;
      }
      await this.store.recordIndexWriteOutcome(null, memoryId);
    });
  }

  async removeFromIndex(memoryId: string): Promise<void> {
    const provider = await this.resolveProvider();
    if (!provider) return;

    await this.enqueueIndexMutation(memoryId, async () => {
      const providers = [provider];
      const diskIdentity = await this.readIndexIdentityFromDisk();
      if (
        diskIdentity &&
        !providers.some((entry) => sameIndexIdentity(entry, diskIdentity))
      ) {
        providers.push(providerFromIndexIdentity(diskIdentity));
      }
      if (provider.type === "host") {
        const fallbackProvider = await this.resolveProvider({ includeHost: false });
        if (
          fallbackProvider &&
          !providers.some((entry) => sameIndexIdentity(entry, fallbackProvider))
        ) {
          providers.push(fallbackProvider);
        }
      }

      let saved = false;
      for (const indexProvider of providers) {
        try {
          const index = await this.loadIndex(indexProvider);
          if (!index.entries[memoryId]) continue;
          delete index.entries[memoryId];
          await this.saveIndex(index, { touchedIds: [memoryId], memoryId });
          saved = true;
        } catch (err) {
          await this.store.recordIndexWriteOutcome(err, memoryId);
          throw err;
        }
      }
      // A no-op removal (id absent from every candidate index) performs no
      // save: it must NOT clear a recorded persistence failure, or the
      // operator console would report an unresolved failure as fixed
      // without any demonstration that storage is writable (round 6).
      if (saved) await this.store.recordIndexWriteOutcome(null, memoryId);
    });
  }

  private enqueueIndexMutation<T>(memoryId: string | undefined, mutation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue
      .catch(() => undefined)
      .then(() =>
        withEmbeddingGenerationLock(this.generationStateDir, async (section) => {
          this.lockSection = section;
          try {
            // A peer process may have persisted while this process did not
            // hold the generation lock: drop any cached index so the
            // mutation loads the real disk state (codex P1).
            this.loaded = null;
            this.loadedFromDisk = false;
            // Recover an interrupted replacement BEFORE the mutation's identity
            // probes and existence checks: a deletion no-op must not skip
            // persistence while the published generation sits in the rename-gap
            // backup, and insertions must load the restored vectors rather than
            // a fresh empty index (issue #3148, codex round 3).
            let recovered = false;
            try {
              recovered = await this.store.recoverIfInterrupted(this.generationFence());
            } catch (err) {
              // Record the recovery failure durably BEFORE rejecting the
              // mutation: the write-outcome try below is never reached.
              await this.store.recordIndexWriteOutcome(err).catch(() => undefined);
              throw err;
            }
            if (recovered) {
              this.loaded = null;
              this.loadedFromDisk = false;
            }
            return await mutation();
          } finally {
            this.lockSection = null;
          }
        }).catch(async (err) => {
          // A lock ACQUISITION failure never reaches the mutation closure's
          // own write-outcome recording. Route it through the existing
          // durable diagnostic exactly once (codex PRRT_kwDORJXyws6mZ8qS);
          // in-lock failures were already recorded by the closure.
          if (err instanceof EmbeddingGenerationLockUnavailableError) {
            await this.store.recordIndexWriteOutcome(err, memoryId).catch(() => undefined);
          }
          throw err;
        }));
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async resolveProvider(
    options: { includeHost?: boolean } = {},
  ): Promise<ProviderConfig | null> {
    if (!resolveMemoryLifecycleCapabilities(this.config).embeddingFallback) return null;

    if (
      options.includeHost !== false &&
      resolvePipelineProcessingCapabilities(this.config).hostEmbeddingProvider !== false
    ) {
      const hostProvider = getHostEmbeddingProvider(this.config.memoryDir);
      if (hostProvider) {
        return {
          type: "host",
          model: hostProvider.model || hostProvider.id,
          hostProvider,
        };
      }
    }

    const preferred = this.config.embeddingFallbackProvider;
    const providers = preferred === "auto" ? ["openai", "local"] : [preferred];

    for (const p of providers) {
      if (p === "openai") {
        const provider = this.createOpenAiProvider();
        if (provider) return provider;
      }

      if (p === "local") {
        const provider = this.createLocalProvider();
        if (provider) return provider;
      }
    }

    return null;
  }

  private async resolveFallbackProviderForIndexIdentity(
    identity: EmbeddingIndexIdentity,
  ): Promise<ProviderConfig | null> {
    if (identity.provider === "openai") {
      const provider = this.createOpenAiProvider();
      return provider && sameIndexIdentity(provider, identity) ? provider : null;
    }
    if (identity.provider === "local") {
      const provider = this.createLocalProvider();
      return provider && sameIndexIdentity(provider, identity) ? provider : null;
    }
    return null;
  }

  private createOpenAiProvider(): ProviderConfig | null {
    if (!this.config.openaiApiKey) return null;
    const baseUrl = this.config.openaiBaseUrl ?? "https://api.openai.com/v1";
    return {
      type: "openai",
      model: DEFAULT_OPENAI_MODEL,
      endpoint: `${baseUrl.replace(/\/$/, "")}/embeddings`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.openaiApiKey}`,
      },
    };
  }

  private createLocalProvider(): ProviderConfig | null {
    if (!resolveLocalLlmCapabilities(this.config).localLlm || !this.config.localLlmUrl) return null;
    const base = this.config.localLlmUrl.replace(/\/$/, "");
    const endpoint = /\/v1$/i.test(base) ? `${base}/embeddings` : `${base}/v1/embeddings`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.config.localLlmHeaders ?? {}),
    };
    if (this.config.localLlmApiKey && this.config.localLlmAuthHeader !== false) {
      headers.Authorization = `Bearer ${this.config.localLlmApiKey}`;
    }
    return {
      type: "local",
      model:
        this.config.embeddingFallbackModel ||
        this.config.localLlmModel ||
        DEFAULT_OPENAI_MODEL,
      endpoint,
      headers,
    };
  }

  private async embedForSearch(
    query: string,
    provider: ProviderConfig,
    options: { throwOnTimeout?: boolean } = {},
  ): Promise<EmbeddingResult | null> {
    try {
      return await this.embedWithEffectiveProvider(query, provider, {
        mode: "lookup",
      });
    } catch (err) {
      if (isLookupBackendUnavailableError(err)) {
        if (options.throwOnTimeout) {
          throw err;
        }
        // Fail-open: recall-path callers get an empty result rather than an
        // unhandled rejection that would abort recall entirely.
        log.debug("embedding fallback search: backend unavailable on lookup, returning [] (throwOnTimeout=false)");
        return null;
      }
      throw err;
    }
  }

  private async embed(
    input: string,
    provider: ProviderConfig,
    options: { mode?: EmbedMode } = {},
  ): Promise<number[] | null> {
    const result = await this.embedWithEffectiveProvider(input, provider, options);
    return result?.vector ?? null;
  }

  private async embedWithEffectiveProvider(
    input: string,
    provider: ProviderConfig,
    options: { mode?: EmbedMode } = {},
  ): Promise<EmbeddingResult | null> {
    // Bound the fetch so a hung embedding endpoint cannot stall callers.
    // The lookup path uses a short budget (see DEFAULT_EMBEDDING_LOOKUP_TIMEOUT_MS
    // docblock) so semantic dedup fails open fast. The index path uses a
    // much longer budget because slow local backends (CPU embedding models)
    // otherwise drop index updates and blind later dedup lookups. See
    // DEFAULT_EMBEDDING_INDEX_TIMEOUT_MS docblock and PR #399 P2 review.
    const mode: EmbedMode = options.mode ?? "lookup";
    const timeoutMs =
      mode === "index"
        ? resolveEmbeddingIndexTimeoutMs()
        : resolveEmbeddingLookupTimeoutMs();
    if (provider.type === "host") {
      const vector = await this.embedWithHostProvider(input, provider, mode, timeoutMs);
      if (vector) return { provider, vector };
      const fallbackProvider = await this.resolveProvider({ includeHost: false });
      if (!fallbackProvider) {
        if (mode === "lookup") {
          throw new EmbeddingProviderUnavailableError(
            `host embedding provider unavailable (${provider.hostProvider?.id ?? provider.model})`,
          );
        }
        return null;
      }
      return this.embedWithEffectiveProvider(input, fallbackProvider, options);
    }
    if (!provider.endpoint || !provider.headers) return null;
    try {
      const res = await fetch(provider.endpoint, {
        method: "POST",
        headers: provider.headers,
        body: JSON.stringify({
          model: provider.model,
          input: input.slice(0, 8000),
          encoding_format: "float",
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        log.debug(`embedding fallback request failed: ${provider.type} ${res.status}`);
        // Round 11 fix (Finding Ur_J): on the LOOKUP path, a non-2xx response
        // means the embedding backend is effectively unavailable. Throw the
        // tagged error so search() (when called with throwOnTimeout) propagates
        // to decideSemanticDedup's backend_unavailable branch, activating the
        // per-batch short-circuit. Without this, repeated 429/5xx responses
        // would silently return [] for every fact in the batch.
        //
        // On the INDEX path a non-2xx is non-fatal (the memory is already
        // persisted; index update can be skipped) — return null there.
        if (mode === "lookup") {
          throw new EmbeddingTimeoutError(
            `embedding backend returned ${res.status} (${provider.type})`,
          );
        }
        return null;
      }
      const payload = (await res.json()) as any;
      const vector = payload?.data?.[0]?.embedding;
      if (!Array.isArray(vector)) return null;
      const normalized = vector
        .map((n: unknown) => Number(n))
        .filter((n: number) => Number.isFinite(n));
      return normalized.length > 0 ? { provider, vector: normalized } : null;
    } catch (err) {
      // Round 11 (Finding Ur_J): the !res.ok branch above throws
      // EmbeddingTimeoutError directly. Re-throw it here so the catch does
      // not swallow our own intentional signal back into a null return.
      if (isLookupBackendUnavailableError(err)) {
        throw err;
      }
      // AbortSignal.timeout throws a DOMException with name "TimeoutError";
      // surface at warn level so operators can distinguish slow backends from
      // generic errors.
      const isTimeout =
        err instanceof Error &&
        (err.name === "TimeoutError" || err.name === "AbortError");
      if (isTimeout) {
        log.warn(
          `embedding fallback fetch timed out after ${timeoutMs}ms (${provider.type}, mode=${mode})`,
        );
        // Round 9 fix (Finding UZqB): on the LOOKUP path a timeout means the
        // embedding backend is effectively unavailable — re-throw so that
        // search() propagates the error to semanticDedupLookup, which lets it
        // reach decideSemanticDedup's catch block and return
        // reason="backend_unavailable". Without this, search() would silently
        // return [] and the per-batch batchBackendUnavailable flag would never
        // flip, causing subsequent facts in the same batch to each pay a full
        // timeout roundtrip (N × timeout instead of 1 × timeout).
        //
        // On the INDEX path a timeout is not fatal (the memory is already
        // persisted; index update can be skipped) — return null there so
        // indexFile() stays non-blocking.
        if (mode === "lookup") {
          throw new EmbeddingTimeoutError(
            `embedding backend timed out after ${timeoutMs}ms (${provider.type})`,
          );
        }
      } else {
        // Round 12 fix (PR #399 thread PRRT_kwDORJXyws56U6Gi): non-timeout
        // transport failures (ECONNREFUSED, DNS errors, TLS failures) are just
        // as fatal as timeouts on the LOOKUP path — the embedding backend is
        // effectively unreachable. Throw EmbeddingTimeoutError so that
        // search() (when called with throwOnTimeout:true) propagates the error
        // to decideSemanticDedup's backend_unavailable branch, activating the
        // per-batch short-circuit. Without this, each fact in the batch would
        // pay a full ECONNREFUSED roundtrip and return null → [] → no_candidates,
        // preventing batchBackendUnavailable from ever being set.
        //
        // On the INDEX path a transport failure is non-fatal — the memory is
        // already persisted; index update can be safely skipped.
        if (mode === "lookup") {
          log.warn(
            `embedding fallback transport error on lookup path (${provider.type}): ${err}`,
          );
          throw new EmbeddingTimeoutError(
            `embedding backend transport failure (${provider.type}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        log.debug(`embedding fallback error: ${err}`);
      }
      return null;
    }
  }

  private async embedWithHostProvider(
    input: string,
    provider: ProviderConfig,
    mode: EmbedMode,
    timeoutMs: number,
  ): Promise<number[] | null> {
    const hostProvider = provider.hostProvider;
    if (!hostProvider) return null;
    try {
      const vector = await hostProvider.embed(input.slice(0, 8000), {
        signal: AbortSignal.timeout(timeoutMs),
        inputType: mode === "lookup" ? "query" : "document",
      });
      return normalizeHostEmbeddingVector(vector);
    } catch (err) {
      log.debug(`host embedding provider error: ${hostProvider.id}: ${err}`);
      return null;
    }
  }

  /**
   * Load the authoritative generation for `provider`. STRICT: an unreadable,
   * malformed, foreign-shaped, or mixed-identity index throws
   * EmbeddingIndexStorageError instead of ever returning a partial view —
   * recall catches it at its boundary and fails open uncached; mutations
   * propagate it and fail closed. This.loaded is only ever assigned a fully
   * validated generation.
   */
  /**
   * A fence the store calls immediately before destructive writes: reasserts
   * THIS section's lock ownership after potentially long serialization.
   * Fail closed when no section is held — persisting unsynchronized would
   * reintroduce the lost-update race.
   */
  private generationFence(): () => Promise<void> {
    const section = this.lockSection;
    if (!section) {
      return async () => {
        throw new EmbeddingIndexStorageError(
          "embedding index mutation attempted outside the generation lock; refusing to publish",
        );
      };
    }
    return () => assertEmbeddingGenerationLockHeld(this.generationLockPath, section);
  }

  /**
   * Cache-warm path: a normal search serves the in-memory index WITHOUT the
   * lock (pre-existing staleness semantics: a peer swap between searches is
   * refreshed by the next cold load). On a cache miss the COMPLETE load runs
   * under the generation mutation lock so the enumeration + shard reads see
   * exactly one generation. The identity is re-checked under the lock on the
   * cold path; the caller has already performed any provider-swap embed
   * outside the lock.
   */
  private async loadIndexUnderGenerationLock(provider: ProviderConfig): Promise<EmbeddingIndexFile> {
    if (this.loaded && this.loadedFromDisk) return this.loaded;
    return await withEmbeddingGenerationLock(this.generationStateDir, async () => {
      // Another in-process consumer may have warmed the cache while this
      // call waited on the lock.
      if (this.loaded && this.loadedFromDisk) return this.loaded;
      // Re-check the on-disk identity UNDER the lock: a peer swap during the
      // caller's embed means the cold load must fail open, never serve a
      // mixed generation (codex PRRT_kwDORJXyws6mZ72p).
      const diskIdentity = await this.store.identityFromDisk();
      if (diskIdentity && !sameIndexIdentity(diskIdentity, provider)) {
        throw new EmbeddingIndexStorageError(
          `embedding index identity swapped to ${diskIdentity.provider}/${diskIdentity.model} during the cold load; failing open`,
        );
      }
      return await this.loadIndex(provider);
    });
  }

  private async loadIndex(provider: ProviderConfig): Promise<EmbeddingIndexFile> {
    if (this.loaded && this.loaded.provider === provider.type && this.loaded.model === provider.model) {
      return this.loaded;
    }

    const merged: Record<string, EmbeddingIndexEntry> = {};
    let diskIdentity: EmbeddingIndexIdentity | null = null;

    const layout = await this.store.detectLayout();
    if (layout === "sharded") {
      // Published generation: shards are the ONLY authoritative state. A
      // legacy embeddings.json left over by a crash between the atomic
      // publish and its recovery rename is never merged (single-generation
      // rule, issue #3146).
      diskIdentity = await this.store.readShardGenerationInto(merged);
    } else if (layout === "legacy") {
      const read = await this.store.readLegacy();
      if (read.outcome === "ok") {
        diskIdentity = { provider: read.file.provider, model: read.file.model };
        Object.assign(merged, read.file.entries);
      } else if (read.outcome === "unreadable") {
        await this.store.recordIndexStatusForLoad(read.reason);
        throw new EmbeddingIndexStorageError(
          `refusing to continue from an unreadable embedding index at ${this.store.legacyPath}: ${read.reason}`,
        );
      } else if (read.outcome === "foreign") {
        // Valid JSON but not an index we recognize (wrong version/shape).
        // Overwriting it would destroy unknown data, so mutation fails
        // closed; the file stays in place for recovery.
        await this.store.recordIndexStatusForLoad("unrecognized index format");
        throw new EmbeddingIndexStorageError(
          `refusing to continue from a malformed embedding index at ${this.store.legacyPath} (unrecognized format); file preserved in place`,
        );
      }
      // absent falls through to a fresh index; a readable legacy index with
      // a different provider identity keeps the existing replace semantics
      // (gated by canReplaceIndexIdentity at the mutation sites).
    }

    if (diskIdentity && diskIdentity.provider === provider.type && diskIdentity.model === provider.model) {
      this.loaded = {
        version: 1,
        provider: provider.type,
        model: provider.model,
        entries: merged,
      };
      this.loadedFromDisk = true;
      return this.loaded;
    }

    this.loaded = {
      version: 1,
      provider: provider.type,
      model: provider.model,
      entries: {},
    };
    this.loadedFromDisk = false;
    return this.loaded;
  }

  private async readIndexIdentityFromDisk(): Promise<EmbeddingIndexIdentity | null> {
    // After a load, `loaded` mirrors the disk state exactly (every mutation
    // saves through saveIndex and a failed save invalidates the cache), so
    // skip re-reading on every mutation.
    if (this.loaded && this.loadedFromDisk) {
      return { provider: this.loaded.provider, model: this.loaded.model };
    }
    return this.store.identityFromDisk();
  }

  /**
   * Persist the index through the file store. On any failure the in-memory
   * cache is invalidated: entries mutated in the cached map must never be
   * mistaken for durable state by a retry or a later search.
   */
  private async saveIndex(
    index: EmbeddingIndexFile,
    opts: { touchedIds?: readonly string[]; memoryId?: string } = {},
  ): Promise<void> {
    try {
      await this.store.persist(index, { ...opts, fence: this.generationFence() });
    } catch (err) {
      this.loaded = null;
      this.loadedFromDisk = false;
      throw err;
    }
    this.loaded = index;
    this.loadedFromDisk = true;
  }
}

function toMemoryRelativePath(memoryDir: string, filePath: string): string {
  if (!path.isAbsolute(filePath)) return filePath;
  const rel = path.relative(memoryDir, filePath);
  return rel.startsWith("..") ? filePath : rel;
}

/**
 * Normalize an index entry path to forward-slashes for stable prefix
 * comparison. Entries are stored as `path.relative(memoryDir, …)` output,
 * which on Windows uses back-slashes. Normalize both sides so prefix
 * matching is OS-independent.
 *
 * Also strip a leading `./` so this helper's output is symmetric with
 * `normalizePathPrefix` below. `toMemoryRelativePath` is a pass-through for
 * non-absolute filePath inputs, so an index entry could legitimately carry a
 * stored path like `"./namespaces/alpha/facts/f.md"`. Without this strip, a
 * caller-supplied prefix `"./namespaces/alpha"` (which `normalizePathPrefix`
 * rewrites to `"namespaces/alpha/"`) would silently miss that entry and
 * namespace-scoped dedup would either let a near-duplicate through or fail
 * to exclude a cross-namespace hit.
 */
function normalizeEntryPath(p: string): string {
  let out = p.replace(/\\/g, "/");
  if (out.startsWith("./")) out = out.slice(2);
  return out;
}

/**
 * Normalize a caller-supplied path prefix:
 *   - Return `undefined` for nullish/empty input (no filter).
 *   - Replace back-slashes with forward-slashes.
 *   - Strip a leading `./`.
 *   - Ensure a trailing `/` so `"namespaces/a"` doesn't accidentally match
 *     `"namespaces/another/…"`.
 */
function normalizePathPrefix(prefix: string | undefined): string | undefined {
  if (prefix === undefined || prefix === null) return undefined;
  let p = String(prefix).replace(/\\/g, "/");
  if (p.startsWith("./")) p = p.slice(2);
  if (p.length === 0) return undefined;
  if (!p.endsWith("/")) p = `${p}/`;
  return p;
}

function sameIndexIdentity(
  left: EmbeddingIndexComparable,
  right: EmbeddingIndexComparable,
): boolean {
  return indexIdentityProvider(left) === indexIdentityProvider(right) && left.model === right.model;
}

function indexIdentityProvider(identity: EmbeddingIndexComparable): EmbeddingProviderType {
  return "provider" in identity ? identity.provider : identity.type;
}

function canReplaceIndexIdentity(
  existing: EmbeddingIndexIdentity,
  replacement: Pick<ProviderConfig, "type" | "model">,
): boolean {
  return existing.provider === "host" && !sameIndexIdentity(existing, replacement);
}

function providerFromIndexIdentity(identity: EmbeddingIndexIdentity): ProviderConfig {
  return {
    type: identity.provider,
    model: identity.model,
  };
}

function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

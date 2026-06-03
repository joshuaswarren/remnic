import { log } from "../logger.js";
import type { PluginConfig } from "../types.js";
import { isAbortError } from "../abort-error.js";
import { withTimeoutSignal } from "./abort.js";
import {
  getHostEmbeddingProvider,
  type HostEmbeddingProvider,
  type HostEmbeddingInputType,
  normalizeHostEmbeddingVector,
} from "../host-embedding-provider.js";

type ProviderConfig = {
  type: "openai" | "local" | "host";
  model: string;
  endpoint?: string;
  headers?: Record<string, string>;
  hostProvider?: HostEmbeddingProvider;
};

type HostEmbeddingScopeConfig = PluginConfig & {
  /**
   * Internal namespace-router metadata. Host adapters register providers at
   * the root memoryDir while namespace backends operate under scoped dirs.
   */
  hostEmbeddingProviderScope?: string;
};

type EmbedHelperOptions = {
  /** Backend-local vector schema dimension for host-provider validation. */
  hostEmbeddingExpectedDimension?: number;
};

export type EmbedProviderIdentity = `${ProviderConfig["type"]}:${string}`;

export type EmbedWithProviderResult = {
  vector: number[];
  providerIdentity: EmbedProviderIdentity;
};

export type EmbedBatchWithProviderResult = {
  vectors: (number[] | null)[];
  providerIdentity: EmbedProviderIdentity;
};

const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";
const DEFAULT_PROVIDER_CACHE_TTL_MS = 250;

/**
 * Standalone embedding helper for search backend adapters.
 *
 * NOTE: This intentionally duplicates provider resolution from EmbeddingFallback.
 * EmbeddingFallback is tightly integrated with the plugin lifecycle (telemetry,
 * rate-limit backoff, provider rotation). This class is a lightweight standalone
 * utility used by LanceDB/Orama backends which operate outside plugin context.
 * Merging them would break the port/adapter separation between search and plugin layers.
 */
export class EmbedHelper {
  private cachedProvider: ProviderConfig | null | undefined;
  private cachedProviderAt = 0;
  private providerCacheTtlMs = DEFAULT_PROVIDER_CACHE_TTL_MS;

  constructor(
    private readonly config: PluginConfig,
    private readonly options: EmbedHelperOptions = {},
  ) {}

  /**
   * Whether an embedding provider is available.
   * Re-resolves periodically so late host-provider registration is visible
   * without repeatedly probing provider state on every hot-path call.
   */
  isAvailable(): boolean {
    return this.getProvider() !== null;
  }

  /**
   * Embed a single text string. Returns null if no provider is available.
   */
  async embed(text: string, options: { signal?: AbortSignal } = {}): Promise<number[] | null> {
    return (await this.embedWithProvider(text, options))?.vector ?? null;
  }

  async embedWithProvider(
    text: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<EmbedWithProviderResult | null> {
    const provider = this.getProvider();
    if (!provider) return null;
    const result = await this.callEmbed(text, provider, options.signal, "query");
    if (result) {
      return {
        vector: result,
        providerIdentity: providerIdentity(provider),
      };
    }
    if (provider.type !== "host") return null;
    const fallbackProvider = this.resolveProvider({ includeHost: false });
    if (!fallbackProvider) return null;
    const fallbackResult = await this.callEmbed(text, fallbackProvider, options.signal, "query");
    return fallbackResult
      ? {
          vector: fallbackResult,
          providerIdentity: providerIdentity(fallbackProvider),
        }
      : null;
  }

  async embedWithFallbackProviderIdentity(
    text: string,
    identity: EmbedProviderIdentity,
    options: { signal?: AbortSignal } = {},
  ): Promise<EmbedWithProviderResult | null> {
    const provider = this.resolveFallbackProviderForIdentity(identity);
    if (!provider) return null;
    const result = await this.callEmbed(text, provider, options.signal, "query");
    return result
      ? {
          vector: result,
          providerIdentity: providerIdentity(provider),
        }
      : null;
  }

  /**
   * Embed a batch of texts. Returns an array parallel to input; entries are null on failure.
   */
  async embedBatch(
    texts: string[],
    batchSize = 32,
    options: { signal?: AbortSignal } = {},
  ): Promise<(number[] | null)[]> {
    return (await this.embedBatchWithProvider(texts, batchSize, options))?.vectors ?? texts.map(() => null);
  }

  async embedBatchWithProvider(
    texts: string[],
    batchSize = 32,
    options: { signal?: AbortSignal } = {},
  ): Promise<EmbedBatchWithProviderResult | null> {
    const provider = this.getProvider();
    if (!provider) return null;

    if (provider.type === "host") {
      const hostResults = await this.embedAllWithProvider(texts, batchSize, provider, options);
      if (!hostResults.some((result) => result === null)) {
        return {
          vectors: hostResults,
          providerIdentity: providerIdentity(provider),
        };
      }
      const fallbackProvider = this.resolveProvider({ includeHost: false });
      if (!fallbackProvider) {
        return {
          vectors: hostResults,
          providerIdentity: providerIdentity(provider),
        };
      }
      const fallbackResults = await this.embedAllWithProvider(texts, batchSize, fallbackProvider, options);
      return {
        vectors: fallbackResults,
        providerIdentity: providerIdentity(fallbackProvider),
      };
    }

    return {
      vectors: await this.embedAllWithProvider(texts, batchSize, provider, options),
      providerIdentity: providerIdentity(provider),
    };
  }

  getProviderIdentity(): EmbedProviderIdentity | null {
    const provider = this.getProvider();
    return provider ? providerIdentity(provider) : null;
  }

  private async embedAllWithProvider(
    texts: string[],
    batchSize: number,
    provider: ProviderConfig,
    options: { signal?: AbortSignal } = {},
  ): Promise<(number[] | null)[]> {
    const results: (number[] | null)[] = new Array(texts.length).fill(null);
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchResults =
        provider.type === "host" && provider.hostProvider?.embedBatch
          ? await this.callHostEmbedBatch(batch, provider.hostProvider, options.signal)
          : await Promise.all(
              batch.map((t) => this.callEmbed(t, provider, options.signal, "document")),
            );
      for (let j = 0; j < batchResults.length; j++) {
        results[i + j] = batchResults[j];
      }
    }
    return results;
  }

  private getProvider(): ProviderConfig | null {
    const now = Date.now();
    if (
      this.cachedProvider !== undefined &&
      now - this.cachedProviderAt < this.providerCacheTtlMs
    ) {
      return this.cachedProvider;
    }
    this.cachedProvider = this.resolveProvider();
    this.cachedProviderAt = now;
    return this.cachedProvider;
  }

  private resolveProvider(options: { includeHost?: boolean } = {}): ProviderConfig | null {
    if (!this.config.embeddingFallbackEnabled) return null;

    if (
      options.includeHost !== false &&
      this.config.hostEmbeddingProviderEnabled !== false
    ) {
      const hostProvider = this.resolveHostEmbeddingProvider();
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

  private resolveFallbackProviderForIdentity(identity: EmbedProviderIdentity): ProviderConfig | null {
    if (!this.config.embeddingFallbackEnabled) return null;
    const separator = identity.indexOf(":");
    if (separator <= 0 || separator === identity.length - 1) return null;
    const type = identity.slice(0, separator);
    const model = identity.slice(separator + 1);

    if (type === "openai") {
      const provider = this.createOpenAiProvider();
      return provider && provider.model === model ? provider : null;
    }
    if (type === "local") {
      const provider = this.createLocalProvider();
      return provider && provider.model === model ? provider : null;
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
    if (!this.config.localLlmEnabled || !this.config.localLlmUrl) return null;
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

  private resolveHostEmbeddingProvider(): HostEmbeddingProvider | undefined {
    const scopedConfig = this.config as HostEmbeddingScopeConfig;
    const scopes = [
      scopedConfig.memoryDir,
      scopedConfig.hostEmbeddingProviderScope,
    ].filter((scope): scope is string => typeof scope === "string" && scope.trim().length > 0);

    for (const scope of new Set(scopes)) {
      const provider = getHostEmbeddingProvider(scope);
      if (provider) return provider;
    }
    return undefined;
  }

  private async callEmbed(
    input: string,
    provider: ProviderConfig,
    signal?: AbortSignal,
    inputType: HostEmbeddingInputType = "document",
  ): Promise<number[] | null> {
    if (provider.type === "host") {
      return this.callHostEmbed(input, provider.hostProvider, signal, inputType);
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
        signal: withTimeoutSignal(signal, 30_000),
      });
      if (!res.ok) {
        log.debug(`EmbedHelper request failed: ${provider.type} ${res.status}`);
        return null;
      }
      const payload = (await res.json()) as any;
      const vector = payload?.data?.[0]?.embedding;
      return normalizeHttpEmbeddingVector(vector);
    } catch (err) {
      if (isAbortError(err)) throw err;
      log.debug(`EmbedHelper error: ${err}`);
      return null;
    }
  }

  private async callHostEmbed(
    input: string,
    provider: HostEmbeddingProvider | undefined,
    signal?: AbortSignal,
    inputType: HostEmbeddingInputType = "document",
  ): Promise<number[] | null> {
    if (!provider) return null;
    try {
      const vector = await provider.embed(input.slice(0, 8000), {
        signal: withTimeoutSignal(signal, 30_000),
        inputType,
      });
      return this.normalizeHostEmbeddingVector(vector);
    } catch (err) {
      if (isAbortError(err)) throw err;
      log.debug(`EmbedHelper host provider error: ${err}`);
      return null;
    }
  }

  private async callHostEmbedBatch(
    inputs: string[],
    provider: HostEmbeddingProvider,
    signal?: AbortSignal,
  ): Promise<(number[] | null)[]> {
    try {
      const vectors = await provider.embedBatch?.(
        inputs.map((input) => input.slice(0, 8000)),
        {
          signal: withTimeoutSignal(signal, 30_000),
          inputType: "document",
        },
      );
      if (!Array.isArray(vectors)) return inputs.map(() => null);
      return inputs.map((_, index) => this.normalizeHostEmbeddingVector(vectors[index]));
    } catch (err) {
      if (isAbortError(err)) throw err;
      log.debug(`EmbedHelper host provider batch error: ${err}`);
      return inputs.map(() => null);
    }
  }

  private normalizeHostEmbeddingVector(value: unknown): number[] | null {
    const vector = normalizeHostEmbeddingVector(value);
    if (!vector) return null;
    const expectedDimension = this.resolveHostEmbeddingExpectedDimension();
    if (expectedDimension !== null && vector.length !== expectedDimension) {
      return null;
    }
    return vector;
  }

  private resolveHostEmbeddingExpectedDimension(): number | null {
    const value = this.options.hostEmbeddingExpectedDimension;
    return typeof value === "number" && Number.isInteger(value) && value > 0
      ? value
      : null;
  }
}

function providerIdentity(provider: ProviderConfig): EmbedProviderIdentity {
  return `${provider.type}:${provider.model}`;
}

function normalizeHttpEmbeddingVector(vector: unknown): number[] | null {
  if (!Array.isArray(vector)) return null;
  const normalized: number[] = [];
  for (const component of vector) {
    if (typeof component !== "number" || !Number.isFinite(component)) {
      return null;
    }
    normalized.push(component);
  }
  return normalized;
}

import { log } from "../logger.js";
import type { PluginConfig } from "../types.js";
import { isAbortError } from "../abort-error.js";
import { withTimeoutSignal } from "./abort.js";
import {
  getHostEmbeddingProvider,
  type HostEmbeddingProvider,
} from "../host-embedding-provider.js";

type ProviderConfig = {
  type: "openai" | "local" | "host";
  model: string;
  endpoint?: string;
  headers?: Record<string, string>;
  hostProvider?: HostEmbeddingProvider;
};

const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";

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
  private provider: ProviderConfig | null | undefined; // undefined = not yet resolved

  constructor(private readonly config: PluginConfig) {}

  /**
   * Whether an embedding provider is available.
   * Resolves the provider on first call.
   */
  isAvailable(): boolean {
    if (this.provider === undefined) {
      this.provider = this.resolveProvider();
    }
    return this.provider !== null;
  }

  /**
   * Embed a single text string. Returns null if no provider is available.
   */
  async embed(text: string, options: { signal?: AbortSignal } = {}): Promise<number[] | null> {
    const provider = this.getProvider();
    if (!provider) return null;
    const result = await this.callEmbed(text, provider, options.signal);
    if (result || provider.type !== "host") return result;
    const fallbackProvider = this.resolveProvider({ includeHost: false });
    return fallbackProvider ? this.callEmbed(text, fallbackProvider, options.signal) : null;
  }

  /**
   * Embed a batch of texts. Returns an array parallel to input; entries are null on failure.
   */
  async embedBatch(
    texts: string[],
    batchSize = 32,
    options: { signal?: AbortSignal } = {},
  ): Promise<(number[] | null)[]> {
    const provider = this.getProvider();
    if (!provider) return texts.map(() => null);

    const results: (number[] | null)[] = new Array(texts.length).fill(null);
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchResults =
        provider.type === "host" && provider.hostProvider?.embedBatch
          ? await this.callHostEmbedBatch(batch, provider.hostProvider, options.signal)
          : await Promise.all(
              batch.map((t) => this.callEmbed(t, provider, options.signal)),
            );
      for (let j = 0; j < batchResults.length; j++) {
        results[i + j] = batchResults[j];
      }
      if (provider.type === "host" && batchResults.some((result) => result === null)) {
        const fallbackProvider = this.resolveProvider({ includeHost: false });
        if (fallbackProvider) {
          const fallbackResults = await Promise.all(
            batch.map((text, index) =>
              batchResults[index] === null
                ? this.callEmbed(text, fallbackProvider, options.signal)
                : Promise.resolve(batchResults[index]),
            ),
          );
          for (let j = 0; j < fallbackResults.length; j++) {
            results[i + j] = fallbackResults[j];
          }
        }
      }
    }
    return results;
  }

  private getProvider(): ProviderConfig | null {
    if (this.provider === undefined) {
      this.provider = this.resolveProvider();
    }
    return this.provider;
  }

  private resolveProvider(options: { includeHost?: boolean } = {}): ProviderConfig | null {
    if (!this.config.embeddingFallbackEnabled) return null;

    if (
      options.includeHost !== false &&
      this.config.hostEmbeddingProviderEnabled !== false
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
      if (p === "openai" && this.config.openaiApiKey) {
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

      if (p === "local" && this.config.localLlmEnabled && this.config.localLlmUrl) {
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
    }

    return null;
  }

  private async callEmbed(
    input: string,
    provider: ProviderConfig,
    signal?: AbortSignal,
  ): Promise<number[] | null> {
    if (provider.type === "host") {
      return this.callHostEmbed(input, provider.hostProvider, signal);
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
      if (!Array.isArray(vector)) return null;
      return vector.map((n: unknown) => { const v = Number(n); return Number.isFinite(v) ? v : 0; });
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
  ): Promise<number[] | null> {
    if (!provider) return null;
    try {
      const vector = await provider.embed(input.slice(0, 8000), {
        signal: withTimeoutSignal(signal, 30_000),
        inputType: "document",
      });
      return normalizeVector(vector);
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
      return inputs.map((_, index) => normalizeVector(vectors[index]));
    } catch (err) {
      if (isAbortError(err)) throw err;
      log.debug(`EmbedHelper host provider batch error: ${err}`);
      return inputs.map(() => null);
    }
  }
}

function normalizeVector(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const vector = value
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n));
  return vector.length > 0 ? vector : null;
}

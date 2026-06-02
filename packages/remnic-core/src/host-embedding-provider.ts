export type HostEmbeddingInputType =
  | "query"
  | "document"
  | "semantic"
  | "classification"
  | "clustering";

export interface HostEmbeddingProvider {
  id: string;
  model?: string;
  dimensions?: number;
  embed(
    text: string,
    options?: { signal?: AbortSignal; inputType?: HostEmbeddingInputType },
  ): Promise<number[] | null>;
  embedBatch?(
    texts: string[],
    options?: { signal?: AbortSignal; inputType?: HostEmbeddingInputType },
  ): Promise<Array<number[] | null>>;
  close?: () => Promise<void> | void;
}

const HOST_EMBEDDING_PROVIDERS_KEY = Symbol.for(
  "remnic.hostEmbeddingProviders",
);

function providerMap(): Map<string, HostEmbeddingProvider> {
  const store = globalThis as Record<PropertyKey, unknown>;
  const existing = store[HOST_EMBEDDING_PROVIDERS_KEY];
  if (existing instanceof Map) {
    return existing as Map<string, HostEmbeddingProvider>;
  }
  const created = new Map<string, HostEmbeddingProvider>();
  store[HOST_EMBEDDING_PROVIDERS_KEY] = created;
  return created;
}

export function registerHostEmbeddingProvider(
  scope: string,
  provider: HostEmbeddingProvider,
): () => void {
  const key = normalizeScope(scope);
  providerMap().set(key, provider);
  return () => {
    const providers = providerMap();
    if (providers.get(key) === provider) {
      providers.delete(key);
    }
    void provider.close?.();
  };
}

export function getHostEmbeddingProvider(
  scope: string,
): HostEmbeddingProvider | undefined {
  return providerMap().get(normalizeScope(scope));
}

export function clearHostEmbeddingProvidersForTest(): void {
  providerMap().clear();
}

export function normalizeHostEmbeddingVector(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const vector = value
    .map((component) => Number(component))
    .filter((component) => Number.isFinite(component));
  return vector.length > 0 ? vector : null;
}

function normalizeScope(scope: string): string {
  const normalized = typeof scope === "string" ? scope.trim() : "";
  return normalized || "default";
}

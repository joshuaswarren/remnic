/**
 * Model Registry - Stores and retrieves model capabilities
 * Avoids repeated external lookups by caching model info locally
 */

import { log } from "./logger.js";
import fs from "node:fs";
import { join } from "node:path";

export interface ModelCapabilities {
  modelId: string;
  maxPositionEmbeddings: number;
  contextWindow: number;
  supportsExtendedContext: boolean;
  ropeScaling?: {
    type: string;
    factor: number;
    originalMaxPositionEmbeddings: number;
  };
  typicalOutputTokens: number;
  source: "huggingface" | "lmstudio" | "manual" | "default";
  fetchedAt: string;
}

interface ModelRegistryData {
  models: Record<string, ModelCapabilities>;
  version: number;
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  modelId: "default",
  maxPositionEmbeddings: 32768,
  contextWindow: 32768,
  supportsExtendedContext: false,
  typicalOutputTokens: 8192,
  source: "default",
  fetchedAt: new Date().toISOString(),
};

// Known model capabilities (fallback when offline)
// NOTE: Context windows here are the MODEL's theoretical maximum. Local LLM servers
// (LM Studio, Ollama, etc.) often load models with smaller default context windows.
// If you get "context length exceeded" errors, either:
// 1. Increase the context window in your LLM server UI (recommended)
// 2. Set localLlmMaxContext in openclaw.json to limit prompts (fallback)
const KNOWN_MODELS: Record<string, Partial<ModelCapabilities>> = {
  "qwen3-30b-a3b-instruct": {
    maxPositionEmbeddings: 40960,
    contextWindow: 131072, // 128K with YaRN - but LM Studio defaults to ~32K
    supportsExtendedContext: true,
    ropeScaling: {
      type: "yarn",
      factor: 4.0,
      originalMaxPositionEmbeddings: 32768,
    },
    typicalOutputTokens: 8192,
  },
  "qwen3-coder-30b-a3b-instruct": {
    maxPositionEmbeddings: 40960,
    contextWindow: 131072, // 128K with YaRN - but LM Studio defaults to ~32K
    supportsExtendedContext: true,
    ropeScaling: {
      type: "yarn",
      factor: 4.0,
      originalMaxPositionEmbeddings: 32768,
    },
    typicalOutputTokens: 8192,
  },
  "qwen3-8b": {
    maxPositionEmbeddings: 40960,
    contextWindow: 131072,
    supportsExtendedContext: true,
    typicalOutputTokens: 4096,
  },
  "qwen3-14b": {
    maxPositionEmbeddings: 40960,
    contextWindow: 131072,
    supportsExtendedContext: true,
    typicalOutputTokens: 4096,
  },
  "qwen3-32b": {
    maxPositionEmbeddings: 40960,
    contextWindow: 131072,
    supportsExtendedContext: true,
    typicalOutputTokens: 4096,
  },
  "llama-3.1": {
    maxPositionEmbeddings: 131072,
    contextWindow: 131072,
    supportsExtendedContext: false,
    typicalOutputTokens: 8192,
  },
  "llama-3.2": {
    maxPositionEmbeddings: 131072,
    contextWindow: 131072,
    supportsExtendedContext: false,
    typicalOutputTokens: 8192,
  },
  "mistral-nemo": {
    maxPositionEmbeddings: 131072,
    contextWindow: 131072,
    supportsExtendedContext: false,
    typicalOutputTokens: 8192,
  },
  "gemma-2": {
    maxPositionEmbeddings: 8192,
    contextWindow: 8192,
    supportsExtendedContext: false,
    typicalOutputTokens: 4096,
  },
};

export class ModelRegistry {
  private registryPath: string;
  private data: ModelRegistryData;
  private readonly CACHE_TTL_DAYS = 7;

  constructor(memoryDir: string) {
    const registryDir = join(memoryDir, ".registry");
    if (!fs.existsSync(registryDir)) {
      fs.mkdirSync(registryDir, { recursive: true });
    }
    this.registryPath = join(registryDir, "model-capabilities.json");
    this.data = this.loadRegistry();
  }

  private loadRegistry(): ModelRegistryData {
    try {
      if (fs.existsSync(this.registryPath)) {
        const content = fs.readFileSync(this.registryPath, "utf-8");
        const data = JSON.parse(content) as ModelRegistryData;
        log.info(`ModelRegistry: loaded ${Object.keys(data.models).length} cached models`);
        return data;
      }
    } catch (err) {
      log.warn(`ModelRegistry: failed to load registry: ${err}`);
    }
    return { models: {}, version: 1 };
  }

  private saveRegistry(): void {
    try {
      fs.writeFileSync(this.registryPath, JSON.stringify(this.data, null, 2));
    } catch (err) {
      log.warn(`ModelRegistry: failed to save registry: ${err}`);
    }
  }

  private isCacheExpired(model: ModelCapabilities): boolean {
    const fetched = new Date(model.fetchedAt);
    const now = new Date();
    const daysDiff = (now.getTime() - fetched.getTime()) / (1000 * 60 * 60 * 24);
    return daysDiff > this.CACHE_TTL_DAYS;
  }

  private normalizeModelId(modelId: string): string {
    // Remove common suffixes and prefixes for matching
    return modelId
      .toLowerCase()
      .replace(/@\d+bit$/, "") // Remove @4bit, @8bit
      .replace(/-mlx$/, "")
      .replace(/-awq$/, "")
      .replace(/-gptq$/, "")
      .replace(/-gguf$/, "")
      .replace(/^mlx-community\//, "")
      .replace(/^models\//, "")
      .trim();
  }

  /**
   * Get capabilities for a model, using cache if available
   */
  getCapabilities(modelId: string): ModelCapabilities {
    const normalizedId = this.normalizeModelId(modelId);

    // Check cache first
    if (this.data.models[normalizedId]) {
      const cached = this.data.models[normalizedId];
      if (!this.isCacheExpired(cached)) {
        log.info(`ModelRegistry: using cached capabilities for ${modelId}`);
        return cached;
      }
      log.info(`ModelRegistry: cache expired for ${modelId}, will refresh`);
    }

    // Check known models
    for (const [knownId, capabilities] of Object.entries(KNOWN_MODELS)) {
      if (normalizedId.includes(knownId)) {
        log.info(`ModelRegistry: using known capabilities for ${modelId}`);
        const caps: ModelCapabilities = {
          ...DEFAULT_CAPABILITIES,
          ...capabilities,
          modelId: normalizedId,
          source: "default",
          fetchedAt: new Date().toISOString(),
        };
        this.data.models[normalizedId] = caps;
        this.saveRegistry();
        return caps;
      }
    }

    // Return defaults
    log.info(`ModelRegistry: using default capabilities for ${modelId}`);
    return {
      ...DEFAULT_CAPABILITIES,
      modelId: normalizedId,
    };
  }

  /**
   * Store capabilities for a model
   */
  setCapabilities(modelId: string, capabilities: Omit<ModelCapabilities, "modelId" | "fetchedAt">): void {
    const normalizedId = this.normalizeModelId(modelId);
    const caps: ModelCapabilities = {
      ...capabilities,
      modelId: normalizedId,
      fetchedAt: new Date().toISOString(),
    };
    this.data.models[normalizedId] = caps;
    this.saveRegistry();
    log.info(`ModelRegistry: stored capabilities for ${modelId}`);
  }

  /**
   * Calculate optimal input/output sizes for a model
   * @param maxContextOverride - Optional override for max context (e.g., if LLM server defaults to smaller window)
   */
  calculateContextSizes(modelId: string, maxContextOverride?: number): {
    maxInputChars: number;
    maxOutputTokens: number;
    description: string;
  } {
    const caps = this.getCapabilities(modelId);

    // Use override if provided (e.g., user knows their LLM server limits), otherwise use detected caps
    const effectiveContextWindow = maxContextOverride ?? caps.contextWindow;

    // Guardrails: never allow output budget to exceed the model/server context window.
    // If we do, input budget goes negative and we end up generating huge, invalid prompts.
    const overheadTokens = Math.min(1000, Math.floor(effectiveContextWindow / 10)); // <=10% overhead, max 1k
    const minInputTokens = Math.min(512, Math.floor(effectiveContextWindow / 4)); // keep some room even on small contexts
    const minOutputTokens = 256;

    // Base output budget: typical output, but scaled down for small contexts.
    let outputTokens = caps.typicalOutputTokens;

    // For very large contexts, default to ~12.5% output (capped), which tends to be plenty for JSON extraction.
    if (effectiveContextWindow > 65536) {
      outputTokens = Math.min(Math.floor(effectiveContextWindow / 8), 16384);
    }

    // Never let output exceed 25% of context.
    outputTokens = Math.min(outputTokens, Math.floor(effectiveContextWindow / 4));

    // Clamp output so we always have positive input headroom.
    outputTokens = Math.max(
      minOutputTokens,
      Math.min(outputTokens, effectiveContextWindow - overheadTokens - minInputTokens),
    );

    const availableForInput = Math.max(
      0,
      effectiveContextWindow - outputTokens - overheadTokens,
    );

    // Convert to characters (rough estimate: 1 token ≈ 4 chars)
    const maxInputChars = Math.max(0, Math.floor(availableForInput * 3.5)); // Conservative: 3.5 chars/token

    const source = maxContextOverride ? "user override" : caps.source;
    return {
      maxInputChars,
      maxOutputTokens: outputTokens,
      description: `${caps.modelId}: ${effectiveContextWindow.toLocaleString()} context (${source}), using ${maxInputChars.toLocaleString()} chars input / ${outputTokens} tokens output`,
    };
  }

  /**
   * Fetch capabilities from Hugging Face (if available)
   * Returns true if successful
   */
  async fetchFromHuggingFace(modelId: string): Promise<boolean> {
    // This would be implemented to fetch from HF Hub API
    // For now, we rely on the known models and manual updates
    log.info(`ModelRegistry: fetchFromHuggingFace not yet implemented for ${modelId}`);
    return false;
  }

  /**
   * List all cached models
   */
  listCached(): string[] {
    return Object.keys(this.data.models);
  }

  /**
   * Clear expired cache entries
   */
  cleanExpired(): number {
    const before = Object.keys(this.data.models).length;
    this.data.models = Object.fromEntries(
      Object.entries(this.data.models).filter(([_, caps]) => !this.isCacheExpired(caps))
    );
    const after = Object.keys(this.data.models).length;
    const removed = before - after;
    if (removed > 0) {
      this.saveRegistry();
      log.info(`ModelRegistry: cleaned ${removed} expired entries`);
    }
    return removed;
  }
}

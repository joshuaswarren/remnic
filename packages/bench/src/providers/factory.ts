import type {
  LlmProvider,
  ProviderDiscoveryResult,
  ProviderFactoryConfig,
} from "./types.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createClaudeCliProvider } from "./claude-cli.js";
import { createCodexCliProvider } from "./codex-cli.js";
import { createLiteLlmProvider } from "./litellm.js";
import { createLocalLlmProvider } from "./local-llm.js";
import { createOllamaProvider } from "./ollama.js";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";

export interface DiscoverAllProvidersOptions {
  includeCodexCli?: boolean;
  /** When true (default), probe for a locally installed Claude Code CLI. */
  includeClaudeCli?: boolean;
}

export function createProvider(config: ProviderFactoryConfig): LlmProvider {
  switch (config.provider) {
    case "openai":
      return createOpenAiCompatibleProvider(config);
    case "anthropic":
      return createAnthropicProvider(config);
    case "ollama":
      return createOllamaProvider(config);
    case "litellm":
      return createLiteLlmProvider(config);
    case "local-llm":
      return createLocalLlmProvider(config);
    case "codex-cli":
      return createCodexCliProvider(config);
    case "claude-cli":
      return createClaudeCliProvider(config);
    default: {
      const exhaustive: never = config;
      throw new Error(`Unknown provider: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export async function discoverAllProviders(
  options: DiscoverAllProvidersOptions = {},
): Promise<ProviderDiscoveryResult[]> {
  const discoveryTargets: Array<{
    provider: ProviderDiscoveryResult["provider"];
    create: () => LlmProvider;
  }> = [
    {
      provider: "ollama" as const,
      create: () => createOllamaProvider({ provider: "ollama", model: "probe" }),
    },
    {
      provider: "openai" as const,
      create: () =>
        createOpenAiCompatibleProvider({
          provider: "openai",
          model: "probe",
          baseUrl: "http://localhost:1234/v1",
        }),
    },
    {
      provider: "litellm" as const,
      create: () =>
        createLiteLlmProvider({
          provider: "litellm",
          model: "probe",
        }),
    },
  ];

  if (options.includeCodexCli ?? true) {
    discoveryTargets.push({
      provider: "codex-cli" as const,
      create: () =>
        createCodexCliProvider({
          provider: "codex-cli",
          model: "gpt-5.5",
          reasoningEffort: "xhigh",
        }),
    });
  }

  if (options.includeClaudeCli ?? true) {
    discoveryTargets.push({
      provider: "claude-cli" as const,
      create: () =>
        createClaudeCliProvider({
          provider: "claude-cli",
          model: "opus",
          reasoningEffort: "xhigh",
        }),
    });
  }

  const results: ProviderDiscoveryResult[] = [];
  for (const target of discoveryTargets) {
    try {
      const provider = target.create();
      const models = provider.discover ? await provider.discover() : [];
      if (models.length > 0) {
        results.push({
          provider: target.provider,
          models,
        });
      }
    } catch {
      // Missing local provider endpoints should not fail discovery for others.
    }
  }

  return results;
}

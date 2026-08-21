function normalizedModel(model: string): string {
  return model.trim().toLowerCase();
}

function matchesModelFamily(normalized: string, familyPattern: RegExp): boolean {
  return familyPattern.test(normalized);
}

export function shouldAssumeOpenAiChatCompletions(baseUrl?: string): boolean {
  if (!baseUrl) return true;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

export function usesMaxCompletionTokens(model: string, options?: { assumeOpenAI?: boolean }): boolean {
  const normalized = normalizedModel(model);
  if (options?.assumeOpenAI !== true) return false;
  if (matchesModelFamily(normalized, /^gpt-5(?:$|[-.])/)) return true;
  if (matchesModelFamily(normalized, /^gpt-4o(?:$|[-.])/)) return true;
  if (matchesModelFamily(normalized, /^gpt-4\.1(?:$|[-.])/)) return true;
  if (matchesModelFamily(normalized, /^o1(?:$|[-.])/)) return true;
  if (matchesModelFamily(normalized, /^o3(?:$|[-.])/)) return true;
  return matchesModelFamily(normalized, /^o4-mini(?:$|[-.])/);
}

export function buildChatCompletionTokenLimit(
  model: string,
  maxTokens: number,
  options?: { assumeOpenAI?: boolean },
): { max_tokens: number } | { max_completion_tokens: number } {
  const safeMaxTokens = Math.max(0, Math.floor(maxTokens));
  if (usesMaxCompletionTokens(model, options)) {
    return { max_completion_tokens: safeMaxTokens };
  }
  return { max_tokens: safeMaxTokens };
}

export function supportsTemperature(model: string, options?: { assumeOpenAI?: boolean }): boolean {
  const normalized = normalizedModel(model);
  if (options?.assumeOpenAI === true && matchesModelFamily(normalized, /^gpt-5(?:$|[-.])/)) {
    return false;
  }
  return true;
}

export function buildChatCompletionTemperature(
  model: string,
  temperature: number,
  options?: { assumeOpenAI?: boolean },
): { temperature: number } | Record<string, never> {
  if (!supportsTemperature(model, options)) return {};
  return { temperature };
}

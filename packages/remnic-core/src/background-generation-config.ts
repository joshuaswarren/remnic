export interface BackgroundGenerationConfig {
  /** Full chat-completions URL. Never used as the global OpenAI base URL. */
  endpoint: string;
  /** Loopback bearer from the generated client file. */
  token: string;
  timeoutSeconds: number;
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function parseBackgroundEndpoint(value: string, keyName: string): string {
  const trimmed = stripTrailingSlashes(value.trim());
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${keyName} must be an absolute HTTP or HTTPS URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${keyName} must use HTTP or HTTPS`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      `${keyName} must not include credentials, query parameters, or fragments`,
    );
  }
  return trimmed;
}

function parseBackgroundGenerationObject(
  raw: unknown,
  keyName: string,
): BackgroundGenerationConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${keyName} must be an object`);
  }
  const record = raw as Record<string, unknown>;
  const endpointRaw = record.endpoint;
  if (typeof endpointRaw !== "string" || endpointRaw.trim().length === 0) {
    throw new Error(`${keyName} must include an endpoint URL`);
  }
  const tokenRaw = record.token;
  if (typeof tokenRaw !== "string" || tokenRaw.length === 0) {
    throw new Error(`${keyName} must include a token`);
  }
  const timeoutRaw = record.timeoutSeconds;
  let timeoutSeconds = 120;
  if (timeoutRaw !== undefined) {
    const parsed = typeof timeoutRaw === "number" ? timeoutRaw : Number(timeoutRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${keyName} timeoutSeconds must be a finite number > 0`);
    }
    timeoutSeconds = parsed;
  }
  return {
    endpoint: parseBackgroundEndpoint(endpointRaw, `${keyName}.endpoint`),
    token: tokenRaw,
    timeoutSeconds,
  };
}

export function parseBackgroundGeneration(
  cfg: Record<string, unknown>,
): BackgroundGenerationConfig | undefined {
  const explicitRaw = cfg.backgroundGeneration;
  if (explicitRaw === undefined || explicitRaw === null) return undefined;
  return parseBackgroundGenerationObject(explicitRaw, "backgroundGeneration");
}

/**
 * Server shapes the local-LLM availability probe can recognise, and the order
 * in which they are tried for a configured base URL. Split from local-llm.ts
 * (file-size ratchet) — no runtime dependency on the client.
 */

export type LocalLlmType = "litellm" | "lmstudio" | "ollama" | "mlx" | "vllm" | "llamacpp" | "generic";

export interface LocalServerConfig {
  type: LocalLlmType;
  defaultPort: number;
  healthEndpoint: string;
  modelsEndpoint: string;
  detectFn: (response: unknown) => boolean;
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function explicitPortFromUrl(s: string): number | null {
  try {
    const parsed = new URL(s);
    if (!parsed.port) return null;
    const port = Number(parsed.port);
    return Number.isInteger(port) ? port : null;
  } catch {
    return null;
  }
}

// LiteLLM must be recognised before the llama.cpp / vLLM probes: on a LiteLLM
// proxy `GET /health` runs a live completion against EVERY deployment in its
// pool, so a once-a-minute 2 s probe turns into a permanent load generator on
// the backends (4,600 probe completions in 12 h observed). `GET /` is
// auth-gated on LiteLLM and answers the JSON string "LiteLLM: RUNNING".
// Not part of LOCAL_SERVERS: `orderedLocalServers` positions it explicitly.
const LITELLM_SERVER: LocalServerConfig = {
  type: "litellm",
  defaultPort: 4000,
  healthEndpoint: "/",
  modelsEndpoint: "/v1/models",
  detectFn: (resp) => typeof resp === "string" && resp.includes("LiteLLM"),
};

const LOCAL_SERVERS: LocalServerConfig[] = [
  {
    type: "ollama",
    defaultPort: 11434,
    healthEndpoint: "/",
    modelsEndpoint: "/api/tags",
    detectFn: (resp) => typeof resp === "string" && resp.includes("Ollama"),
  },
  {
    type: "llamacpp",
    defaultPort: 8080,
    healthEndpoint: "/health",
    modelsEndpoint: "/v1/models",
    detectFn: (resp) => isObjectRecord(resp) && resp.status === "ok",
  },
  {
    type: "mlx",
    defaultPort: 8080,
    healthEndpoint: "/v1/models",
    modelsEndpoint: "/v1/models",
    detectFn: (resp) => isObjectRecord(resp) && Array.isArray(resp.data),
  },
  {
    type: "lmstudio",
    defaultPort: 1234,
    healthEndpoint: "/v1/models",
    modelsEndpoint: "/v1/models",
    detectFn: (resp) => isObjectRecord(resp) && Array.isArray(resp.data),
  },
  {
    type: "vllm",
    defaultPort: 8000,
    healthEndpoint: "/health",
    modelsEndpoint: "/v1/models",
    detectFn: (resp) => resp === "" || (isObjectRecord(resp) && !("status" in resp)),
  },
];

/**
 * Probe order for a configured base URL. Entries whose default port matches
 * the URL's explicit port go first, in the same order as before; the LiteLLM
 * entry is placed immediately ahead of the first entry that would probe
 * `GET /health`, so that request never reaches a LiteLLM proxy on any port.
 * LM Studio / Ollama / MLX probes are harmless on LiteLLM and keep their spot.
 */
export function orderedLocalServers(configuredBaseUrl: string): LocalServerConfig[] {
  const configuredPort = explicitPortFromUrl(configuredBaseUrl);
  const matching = configuredPort === null
    ? []
    : LOCAL_SERVERS.filter((serverConfig) => serverConfig.defaultPort === configuredPort);
  const matchingTypes = new Set(matching.map((serverConfig) => serverConfig.type));
  const ordered = [
    ...matching,
    ...LOCAL_SERVERS.filter((serverConfig) => !matchingTypes.has(serverConfig.type)),
  ];
  const firstHealthProbe = ordered.findIndex((serverConfig) => serverConfig.healthEndpoint === "/health");
  ordered.splice(firstHealthProbe === -1 ? ordered.length : firstHealthProbe, 0, LITELLM_SERVER);
  return ordered;
}

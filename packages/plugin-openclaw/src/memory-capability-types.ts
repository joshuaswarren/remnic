/**
 * Structural types for the OpenClaw memory-slot capability.
 *
 * These mirror the host SDK's memory runtime contract without importing it, so
 * the plugin keeps building against SDK versions that predate a given field.
 * Both bridge modes implement the same shapes: embedded backs them with the
 * in-process orchestrator, delegate backs them with the standalone daemon.
 */

export type RuntimeMemorySource = "memory" | "sessions";

export type RuntimeSearchOptions = {
  maxResults?: number;
  minScore?: number;
  sessionKey?: string;
  qmdSearchModeOverride?: "query" | "search" | "vsearch";
}

export type RuntimeSearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: RuntimeMemorySource;
  citation?: string;
}

export type RuntimeReadParams = {
  relPath: string;
  from?: number;
  lines?: number;
}

export type RuntimeReadResult = {
  text: string;
  path: string;
  truncated?: boolean;
  from?: number;
  lines?: number;
  nextFrom?: number;
}

export type RuntimeStatus = {
  backend: "builtin" | "qmd";
  provider: string;
  requestedProvider?: string;
  model?: string;
  dirty?: boolean;
  workspaceDir?: string;
  dbPath?: string;
  sources?: RuntimeMemorySource[];
  sourceCounts?: Array<{
    source: RuntimeMemorySource;
    files: number;
    chunks: number;
  }>;
  vector?: {
    enabled: boolean;
    available?: boolean;
  };
  fts?: {
    enabled: boolean;
    available: boolean;
  };
  custom?: Record<string, unknown>;
}

export type RuntimeManager = {
  search(query: string, opts?: RuntimeSearchOptions): Promise<RuntimeSearchResult[]>;
  readFile(params: RuntimeReadParams): Promise<RuntimeReadResult>;
  status(): RuntimeStatus;
  sync?(params?: { reason?: string; force?: boolean }): Promise<void>;
  probeEmbeddingAvailability(): Promise<{ ok: boolean; error?: string }>;
  probeVectorAvailability(): Promise<boolean>;
  close?(): Promise<void>;
}

export type RemnicCapabilityRuntime = {
  getMemorySearchManager(params: {
    cfg: unknown;
    agentId: string;
    purpose?: "default" | "status";
  }): Promise<{
    manager: RuntimeManager | null;
    error?: string;
  }>;
  resolveMemoryBackendConfig(params: {
    cfg: unknown;
    agentId: string;
  }): { backend: "builtin" } | { backend: "qmd"; qmd?: { command?: string } };
  closeAllMemorySearchManagers(): Promise<void>;
}

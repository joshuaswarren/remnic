import { resolveNamespaceCapabilities } from "./capabilities.js";
import { canReadNamespace, defaultNamespaceForPrincipal, resolvePrincipal } from "./namespaces/principal.js";
import type { MemoryFile, PluginConfig, QmdSearchResult } from "./types.js";
import { collapseWhitespace, truncateCodePointSafe } from "./whitespace.js";
import { isHandleToken } from "./recall-handles.js";
import { isSupportPassportPrivateMemory } from "./support-passport/card-projection.js";

export interface ActiveMemoryMetadata {
  type?: "fact" | "preference";
  topic?: string;
  updatedAt?: string;
  sourceUri?: string;
}

export interface ActiveMemorySearchResult {
  id: string;
  score: number;
  text: string;
  metadata?: ActiveMemoryMetadata;
}

export interface ActiveMemorySearchOutput {
  results: ActiveMemorySearchResult[];
  truncated: boolean;
}

export interface ActiveMemoryGetOutput {
  id?: string;
  text?: string;
  metadata?: ActiveMemoryMetadata;
  error?: "not_found";
}

export interface ActiveMemoryRecallParams {
  query: string;
  limit?: number;
  sessionKey: string;
  filters?: Record<string, unknown>;
  snippetMaxChars?: number;
}

interface ActiveMemoryScopedOrchestrator {
  config?: PluginConfig;
  resolvePrincipal?: (sessionKey?: string) => string | undefined;
  resolveSelfNamespace?: (sessionKey?: string) => string;
  getStorageForNamespace?: (namespace: string) => Promise<{
    readMemoryByPath?: (path: string) => Promise<MemoryFile | null>;
    getMemoryById?: (id: string) => Promise<MemoryFile | null>;
  }>;
  filterPrivateSearchResults?: (
    results: QmdSearchResult[],
    namespaces?: readonly string[],
  ) => Promise<QmdSearchResult[]>;
}

type ActiveMemorySearchCandidate = {
  id?: string;
  score?: number;
  snippet?: string;
  text?: string;
  path?: string;
  metadata?: Record<string, unknown>;
};

function isArtifactPath(value: string | undefined): boolean {
  return typeof value === "string" && /(?:^|[\\/])artifacts(?:[\\/]|$)/i.test(value);
}

async function filterVisibleActiveMemoryCandidates(
  orchestrator: ActiveMemoryScopedOrchestrator,
  namespace: string,
  storage: Awaited<ReturnType<NonNullable<ActiveMemoryScopedOrchestrator["getStorageForNamespace"]>>> | undefined,
  candidates: ActiveMemorySearchCandidate[],
): Promise<ActiveMemorySearchCandidate[]> {
  const visible = new Set<ActiveMemorySearchCandidate>();
  const pathCandidates = candidates.filter(
    (candidate) => typeof candidate.path === "string" && !isArtifactPath(candidate.path),
  );
  if (pathCandidates.length > 0 && typeof orchestrator.filterPrivateSearchResults === "function") {
    const qmdCandidates = pathCandidates.map((candidate): QmdSearchResult => ({
      docid: candidate.id ?? candidate.path!,
      path: candidate.path!,
      snippet: candidate.snippet ?? candidate.text ?? "",
      score: typeof candidate.score === "number" ? candidate.score : 0,
      namespace,
    }));
    const filtered = await orchestrator.filterPrivateSearchResults(qmdCandidates, [namespace]);
    const visibleKeys = new Set(filtered.map((candidate) => `${candidate.docid}\0${candidate.path}`));
    qmdCandidates.forEach((candidate, index) => {
      if (visibleKeys.has(`${candidate.docid}\0${candidate.path}`)) visible.add(pathCandidates[index]!);
    });
  }

  const idCandidates = candidates.filter(
    (candidate) => candidate.path === undefined && typeof candidate.id === "string",
  );
  if (storage) {
    const idVisibility = await Promise.all(
      idCandidates.map(async (candidate) => {
        const memory = await storage.getMemoryById?.(candidate.id!);
        return memory !== null && memory !== undefined && !isSupportPassportPrivateMemory(memory);
      }),
    );
    idCandidates.forEach((candidate, index) => {
      if (idVisibility[index]) visible.add(candidate);
    });
  }
  return candidates.filter((candidate) => visible.has(candidate));
}

function clampLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 8;
  return Math.max(1, Math.min(50, Math.floor(value)));
}

function truncateSnippet(value: string, maxChars: number): string {
  const compact = collapseWhitespace(value);
  return truncateCodePointSafe(compact, maxChars);
}

function pickMetadata(value: Record<string, unknown> | undefined): ActiveMemoryMetadata | undefined {
  if (!value) return undefined;
  const metadata: ActiveMemoryMetadata = {};
  if (typeof value.type === "string") metadata.type = value.type as ActiveMemoryMetadata["type"];
  if (typeof value.topic === "string") metadata.topic = value.topic;
  if (typeof value.updatedAt === "string") metadata.updatedAt = value.updatedAt;
  if (typeof value.sourceUri === "string") metadata.sourceUri = value.sourceUri;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function resolveActiveMemoryNamespace(
  orchestrator: ActiveMemoryScopedOrchestrator,
  sessionKey: string | undefined,
  requestedNamespace: string | undefined,
): string {
  const explicitNamespace =
    typeof requestedNamespace === "string" && requestedNamespace.trim().length > 0
      ? requestedNamespace.trim()
      : undefined;
  const config = orchestrator.config;

  if (config?.namespacesEnabled === false) {
    if (typeof orchestrator.resolveSelfNamespace === "function") {
      return orchestrator.resolveSelfNamespace(sessionKey);
    }
    return "default";
  }

  if (!config) {
    if (explicitNamespace) return explicitNamespace;
    if (typeof orchestrator.resolveSelfNamespace === "function") {
      return orchestrator.resolveSelfNamespace(sessionKey);
    }
    return "default";
  }

  const principal =
    typeof orchestrator.resolvePrincipal === "function"
      ? orchestrator.resolvePrincipal(sessionKey)
      : resolvePrincipal(sessionKey, config);
  if (resolveNamespaceCapabilities(config).namespaces && !principal) {
    throw new Error("authentication required: namespaces are enabled and no principal was supplied");
  }
  if (explicitNamespace) {
    if (!canReadNamespace(principal, explicitNamespace, config)) {
      throw new Error(`namespace ${explicitNamespace} is not readable for principal ${principal}`);
    }
    return explicitNamespace;
  }
  if (typeof orchestrator.resolveSelfNamespace === "function") {
    return orchestrator.resolveSelfNamespace(sessionKey);
  }
  return defaultNamespaceForPrincipal(principal, config);
}

export async function recallForActiveMemory(
  orchestrator: {
    config?: PluginConfig;
    resolvePrincipal?: (sessionKey?: string) => string | undefined;
    resolveSelfNamespace?: (sessionKey?: string) => string;
    getStorageForNamespace?: ActiveMemoryScopedOrchestrator["getStorageForNamespace"];
    filterPrivateSearchResults?: ActiveMemoryScopedOrchestrator["filterPrivateSearchResults"];
    searchAcrossNamespaces: (params: {
      query: string;
      maxResults?: number;
      namespaces?: string[];
      mode?: string;
    }) => Promise<ActiveMemorySearchCandidate[]>;
  },
  params: ActiveMemoryRecallParams,
): Promise<ActiveMemorySearchOutput> {
  const limit = clampLimit(params.limit);
  const snippetMaxChars =
    typeof params.snippetMaxChars === "number" && Number.isFinite(params.snippetMaxChars)
      ? Math.max(1, Math.min(4000, Math.floor(params.snippetMaxChars)))
      : 600;
  const namespace = resolveActiveMemoryNamespace(
    orchestrator,
    params.sessionKey,
    typeof params.filters?.namespace === "string" ? params.filters.namespace : undefined,
  );

  const storage = await orchestrator.getStorageForNamespace?.(namespace);
  const candidateCap = 25_000;
  let requestedResults = Math.min(candidateCap, limit + 20);
  let raw: ActiveMemorySearchCandidate[] = [];
  let visible: ActiveMemorySearchCandidate[] = [];
  for (;;) {
    raw = await orchestrator.searchAcrossNamespaces({
      query: params.query,
      maxResults: requestedResults,
      namespaces: [namespace],
      mode: "search",
    });
    visible = await filterVisibleActiveMemoryCandidates(orchestrator, namespace, storage, raw);
    if (visible.length > limit || raw.length < requestedResults || requestedResults >= candidateCap) break;
    requestedResults = Math.min(candidateCap, requestedResults * 2);
  }

  return {
    results: visible.slice(0, limit).map((candidate, index) => ({
      id: candidate.id ?? candidate.path ?? `memory-${index + 1}`,
      score: typeof candidate.score === "number" ? candidate.score : 0,
      text: truncateSnippet(candidate.snippet ?? candidate.text ?? "", snippetMaxChars),
      metadata: pickMetadata(candidate.metadata),
    })),
    truncated: visible.length > limit || (raw.length === requestedResults && requestedResults >= candidateCap),
  };
}

function buildActiveMemoryMetadataFromMemory(memory: MemoryFile): ActiveMemoryMetadata | undefined {
  const metadata: ActiveMemoryMetadata = {};
  if (typeof memory.frontmatter.category === "string") {
    const category = memory.frontmatter.category;
    if (category === "fact" || category === "preference") {
      metadata.type = category;
    }
  }
  if (Array.isArray(memory.frontmatter.tags) && memory.frontmatter.tags.length > 0) {
    metadata.topic = memory.frontmatter.tags[0];
  }
  if (typeof memory.frontmatter.updated === "string") metadata.updatedAt = memory.frontmatter.updated;
  if (typeof memory.frontmatter.source === "string") metadata.sourceUri = memory.frontmatter.source;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export async function getMemoryForActiveMemory(
  orchestrator: {
    config?: PluginConfig;
    resolvePrincipal?: (sessionKey?: string) => string;
    resolveSelfNamespace?: (sessionKey?: string) => string;
    getStorageForNamespace?: (namespace: string) => Promise<{
      getMemoryById?: (id: string) => Promise<MemoryFile | null>;
    }>;
    storage?: {
      getMemoryById?: (id: string) => Promise<MemoryFile | null>;
    };
    /** Issue #1582 — resolves a `[m:xxxx]` handle to a memory id (orchestrator). */
    resolveMemoryIdOrHandle?: (ref: string, sessionKey?: string) => string;
  },
  id: string,
  options: {
    namespace?: string;
    sessionKey?: string;
  } = {},
): Promise<ActiveMemoryGetOutput> {
  const namespace = resolveActiveMemoryNamespace(
    orchestrator,
    options.sessionKey,
    options.namespace,
  );

  const storage =
    typeof orchestrator.getStorageForNamespace === "function"
      ? await orchestrator.getStorageForNamespace(namespace)
      : orchestrator.storage;

  // Issue #1582 — resolve a `[m:xxxx]` handle to its memory id against the
  // caller's session before the storage read, so OpenClaw active-memory agents
  // can cite injected handles through the SAME shared path as memory_get /
  // correction (cursor review). Raw ids pass through unchanged.
  //
  // A handle that misses, collides, or has no session key becomes not_found —
  // the SAME behavior a bad raw id yields below — instead of throwing, so an
  // active-memory caller gets a uniform not-found contract (cursor review).
  let resolvedId = id;
  if (isHandleToken(id) && typeof orchestrator.resolveMemoryIdOrHandle === "function") {
    try {
      resolvedId = orchestrator.resolveMemoryIdOrHandle(id, options.sessionKey);
    } catch {
      return { error: "not_found" };
    }
  }
  const memory = await storage?.getMemoryById?.(resolvedId);
  if (!memory || isSupportPassportPrivateMemory(memory)) return { error: "not_found" };
  return {
    id: resolvedId,
    text: collapseWhitespace(memory.content),
    metadata: buildActiveMemoryMetadataFromMemory(memory),
  };
}

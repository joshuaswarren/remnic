
import { resolveNamespaceCapabilities, resolveQmdCapabilities } from "./capabilities.js";
import { planRecallMode } from "./intent.js";
import { canReadNamespace, recallNamespacesForPrincipal, resolvePrincipal } from "./namespaces/principal.js";
import { isGenericRecallExcludedPath } from "./orchestration/generic-recall-paths.js";
import type { Orchestrator } from "./orchestrator.js";
import {
  explainRecallMiss,
  RecallWhyInputError,
  type RecallWhyDeps,
  type RecallWhyMemoryRef,
  type RecallWhyReport,
} from "./recall-why.js";
import { summarizeRecallWhy } from "./recall-why-renderer.js";
import {
  describeSearchDegradations,
  fatalSearchDegradations,
  type SearchDegradation,
} from "./search/port.js";
import type { MemoryFile, MemoryStatus } from "./types.js";

export interface RecallWhyRequest {
  query: string;
  expect?: string;
  sessionKey?: string;
  namespace?: string;
  authenticatedPrincipal?: string;
  sourceConnector?: string;
  abortSignal?: AbortSignal;
}

export interface RecallWhyResponse {
  reportFound: boolean;
  report?: RecallWhyReport;
  summary?: string;
}

export interface RecallWhyServiceDeps {
  readonly orchestrator: Orchestrator;
  resolveNamespace(namespace?: string): string;
}

/**
 * Run the recall-miss diagnosis for one request.
 *
 * Throws {@link RecallWhyInputError} for caller-input faults so surfaces can
 * map them to a 400; backend faults are reported inside the report as
 * `backend_unavailable` rather than thrown, because an outage is a diagnosis
 * result, not a diagnosis failure.
 */
export async function runRecallWhy(deps: RecallWhyServiceDeps, request: RecallWhyRequest): Promise<RecallWhyResponse> {
  const query = typeof request.query === "string" ? request.query : "";
  if (query.trim().length === 0) {
    throw new RecallWhyInputError("recallWhy: query is required and must be non-empty");
  }
  const orchestrator = deps.orchestrator;
  const config = orchestrator.config;
  const namespacesEnabled = resolveNamespaceCapabilities(config).namespaces;
  const requestedNamespace = request.namespace?.trim() ? deps.resolveNamespace(request.namespace) : undefined;
  const authenticatedPrincipal = request.authenticatedPrincipal?.trim();
  const principal = authenticatedPrincipal || resolvePrincipal(request.sessionKey, config);

  if (requestedNamespace !== undefined) {
    if (!canReadNamespace(principal, requestedNamespace, config)) {
      return { reportFound: false };
    }
  } else if (namespacesEnabled && !authenticatedPrincipal && !request.sessionKey?.trim()) {
    return { reportFound: false };
  }

  const readableNamespaces =
    requestedNamespace !== undefined ? [requestedNamespace] : [...recallNamespacesForPrincipal(principal, config)];
  const recallSessionKey = request.sessionKey?.trim() || undefined;

  const whyDeps: RecallWhyDeps = {
    plannerMode: (prompt) => planRecallMode(prompt),
    scopedNamespaces: readableNamespaces,
    namespacesEnabled,
    isExcludedPath: (memoryPath) => isGenericRecallExcludedPath(memoryPath, config),
    runRecall: async (recallQuery, options) => {
      if (resolveQmdCapabilities(config).qmd && !orchestrator.qmd.isAvailable()) {
        return {
          ok: false,
          reason: "backend_unavailable",
          detail: "the search backend is enabled but reported itself unavailable",
        };
      }
      const degradations: SearchDegradation[] = [];
      try {
        const captured = await orchestrator.recallWithXrayCapture(recallQuery, options.sessionKey, {
          ...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
          ...(authenticatedPrincipal ? { principalOverride: authenticatedPrincipal } : {}),
          ...(request.sourceConnector ? { sourceConnector: request.sourceConnector } : {}),
          ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
          degradationSink: degradations,
        });
        const fatal = fatalSearchDegradations(degradations);
        if (fatal.length > 0) {
          return { ok: false, reason: "backend_unavailable", detail: describeSearchDegradations(fatal) };
        }
        return { ok: true, snapshot: captured.snapshot };
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        const observed = degradations.length > 0 ? `${describeSearchDegradations(degradations)}; ` : "";
        return {
          ok: false,
          reason: "backend_unavailable",
          detail: `${observed}${err instanceof Error ? err.message : "recall failed"}`,
        };
      }
    },
    findExpected: (expect) => findExpectedMemory(orchestrator, readableNamespaces, expect),
  };

  const report = await explainRecallMiss(query, {
    deps: whyDeps,
    ...(request.expect !== undefined ? { expect: request.expect } : {}),
    ...(recallSessionKey !== undefined ? { sessionKey: recallSessionKey } : {}),
    ...(requestedNamespace !== undefined ? { namespace: requestedNamespace } : {}),
    ...(request.abortSignal !== undefined ? { abortSignal: request.abortSignal } : {}),
  });

  return { reportFound: true, report, summary: summarizeRecallWhy(report) };
}

/**
 * Resolve `expect` to one stored memory, searching ONLY namespaces the
 * caller may read. An exact id match wins over a substring match; among
 * substring matches the lowest (memoryId, path) pair wins, so repeated runs
 * report the same memory.
 */
async function findExpectedMemory(
  orchestrator: Orchestrator,
  namespaces: readonly string[],
  expect: string
): Promise<RecallWhyMemoryRef | null> {
  const substringMatches: RecallWhyMemoryRef[] = [];
  const seenNamespaces = new Set<string>();
  for (const namespace of namespaces) {
    if (seenNamespaces.has(namespace)) continue;
    seenNamespaces.add(namespace);
    let memories: MemoryFile[];
    try {
      const storage = await orchestrator.getStorageForNamespace(namespace);
      memories = await storage.readAllMemories();
    } catch {
      continue;
    }
    for (const memory of memories) {
      const memoryId = typeof memory.frontmatter.id === "string" ? memory.frontmatter.id : "";
      if (memoryId.length === 0) continue;
      const ref: RecallWhyMemoryRef = {
        memoryId,
        path: memory.path,
        status: (memory.frontmatter.status as MemoryStatus | undefined) ?? "active",
        namespace,
      };
      if (memoryId === expect) return ref;
      if (memoryId.includes(expect) || memory.path.includes(expect)) substringMatches.push(ref);
    }
  }
  if (substringMatches.length === 0) return null;
  // Total comparator: -1 / 0 / 1, and 0 for genuinely equal rows (#12).
  substringMatches.sort((a, b) => {
    if (a.memoryId !== b.memoryId) return a.memoryId < b.memoryId ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return 0;
  });
  return substringMatches[0] ?? null;
}

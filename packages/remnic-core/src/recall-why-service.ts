/**
 * Access-surface binding for the recall-miss diagnosis (issue #3033).
 *
 * `recall-why.ts` holds the stage logic and a port; this module binds that
 * port to the live orchestrator. It lives beside `access-recall-surface.ts`
 * rather than inside it because that file is at its file-size ratchet
 * ceiling (AGENTS.md: extract the addition to a sibling module).
 *
 * Namespace scope is enforced BEFORE the recall fires and the expected-memory
 * lookup is confined to namespaces the caller may read, so the diagnosis can
 * never confirm the existence of a memory in a namespace the caller has no
 * read access to. Read path and write path resolve through the same namespace
 * layer (Review Prevention Checklist #30): the lookup consumes exactly the
 * `recallNamespacesForPrincipal` set the recall itself is scoped by.
 */

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
import type { SearchDegradation } from "./search/port.js";
import type { MemoryFile, MemoryStatus } from "./types.js";

/**
 * Degradation codes that mean the search backend could NOT answer, so an
 * empty pipeline carries no information. `vector_tier_unavailable` is
 * excluded on purpose: the lexical tier still answered, so the result set
 * is degraded but real.
 */
const FATAL_DEGRADATION_CODES: Partial<Record<SearchDegradation["code"], true>> = {
  backend_unavailable: true,
  backend_error: true,
  daemon_timeout: true,
  daemon_loading: true,
  subprocess_error: true,
  deadline_exceeded: true,
  remote_error: true,
};

function describeDegradations(degradations: readonly SearchDegradation[]): string {
  return degradations
    .map((d) => `${d.backend}:${d.code}${d.detail !== undefined ? ` (${d.detail})` : ""}`)
    .join("; ");
}

export interface RecallWhyRequest {
  query: string;
  /** Memory id or substring to trace through every stage. */
  expect?: string;
  sessionKey?: string;
  namespace?: string;
  authenticatedPrincipal?: string;
  sourceConnector?: string;
  abortSignal?: AbortSignal;
}

export interface RecallWhyResponse {
  /** False when the namespace ACL denied the diagnosis. */
  reportFound: boolean;
  report?: RecallWhyReport;
  /** One-line verdict, for agent callers that do not parse the full report. */
  summary?: string;
}

export interface RecallWhyServiceDeps {
  readonly orchestrator: Orchestrator;
  /** The surface's shared namespace resolver. */
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
export async function runRecallWhy(
  deps: RecallWhyServiceDeps,
  request: RecallWhyRequest,
): Promise<RecallWhyResponse> {
  const query = typeof request.query === "string" ? request.query : "";
  if (query.trim().length === 0) {
    throw new RecallWhyInputError("recallWhy: query is required and must be non-empty");
  }
  const orchestrator = deps.orchestrator;
  const config = orchestrator.config;
  const namespacesEnabled = resolveNamespaceCapabilities(config).namespaces;
  const requestedNamespace = request.namespace?.trim()
    ? deps.resolveNamespace(request.namespace)
    : undefined;
  const authenticatedPrincipal = request.authenticatedPrincipal?.trim();
  const principal = authenticatedPrincipal || resolvePrincipal(request.sessionKey, config);

  if (requestedNamespace !== undefined) {
    if (!canReadNamespace(principal, requestedNamespace, config)) {
      return { reportFound: false };
    }
  } else if (namespacesEnabled && !authenticatedPrincipal && !request.sessionKey?.trim()) {
    // Namespaces on but no identity supplied: refuse rather than diagnose
    // against the global namespace (least-privileged default).
    return { reportFound: false };
  }

  const readableNamespaces = requestedNamespace !== undefined
    ? [requestedNamespace]
    : [...recallNamespacesForPrincipal(principal, config)];
  const recallSessionKey = request.sessionKey?.trim() || undefined;

  const whyDeps: RecallWhyDeps = {
    plannerMode: (prompt) => planRecallMode(prompt),
    scopedNamespaces: readableNamespaces,
    namespacesEnabled,
    isExcludedPath: (memoryPath) => isGenericRecallExcludedPath(memoryPath, config),
    runRecall: async (recallQuery, options) => {
      // A configured-but-unreachable search backend is an OUTAGE, and must
      // never render as "0 candidates" (Review Prevention Checklist #22).
      // This is the same pair of expressions the pipeline emits as
      // `qmdEnabled` / `qmdAvailable` on its recall_summary trace.
      if (resolveQmdCapabilities(config).qmd && !orchestrator.qmd.isAvailable()) {
        return {
          ok: false,
          reason: "backend_unavailable",
          detail: "the search backend is enabled but reported itself unavailable",
        };
      }
      // A backend that answers the availability probe can still fail
      // mid-recall (daemon timeout, deadline exceeded, subprocess error).
      // The pipeline already collects those; `degradationSink` hands us the
      // same array it fills, so the outage is observed rather than inferred.
      const degradations: SearchDegradation[] = [];
      try {
        const captured = await orchestrator.recallWithXrayCapture(recallQuery, options.sessionKey, {
          ...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
          ...(authenticatedPrincipal ? { principalOverride: authenticatedPrincipal } : {}),
          ...(request.sourceConnector ? { sourceConnector: request.sourceConnector } : {}),
          ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
          degradationSink: degradations,
        });
        const fatal = degradations.filter((d) => FATAL_DEGRADATION_CODES[d.code] === true);
        if (fatal.length > 0) {
          return { ok: false, reason: "backend_unavailable", detail: describeDegradations(fatal) };
        }
        return { ok: true, snapshot: captured.snapshot };
      } catch (err) {
        // Cancellation is the caller's decision, not a backend outage.
        if (err instanceof Error && err.name === "AbortError") throw err;
        const observed =
          degradations.length > 0 ? `${describeDegradations(degradations)}; ` : "";
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
  expect: string,
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
      // A namespace whose storage cannot be read contributes no candidates;
      // the diagnosis still reports on the ones that could be read.
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

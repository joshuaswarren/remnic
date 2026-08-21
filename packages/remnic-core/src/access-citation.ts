import { log } from "./logger.js";

export interface CitationUsageRequest {
  sessionId?: string;
  namespace?: string;
  authenticatedPrincipal?: string;
  entries: Array<{ path: string; lineStart: number; lineEnd: number; note: string }>;
  rolloutIds: string[];
}

export interface CitationStorage {
  findExistingMemoryPaths(
    ids: string[],
    preferredPaths?: Map<string, string[]>,
  ): Promise<Map<string, string[]>>;
}

export interface CitationUsageDependencies {
  resolveNamespace: (
    namespace: string | undefined,
    sessionId: string | undefined,
    authenticatedPrincipal: string | undefined,
  ) => string;
  resolveNamespaceForPath?: (
    path: string,
    fallbackNamespace: string,
    sessionId: string | undefined,
    authenticatedPrincipal: string | undefined,
  ) => Promise<string>;
  getStorage: (namespace: string) => Promise<CitationStorage>;
  trackMemoryAccess: (
    memoryIds: string[],
    memoryPaths: string[],
    memoryNamespaces?: Array<string | undefined>,
  ) => void;
}

export interface CitationUsageResult {
  submitted: number;
  matched: number;
}

export async function recordCitationUsage(
  deps: CitationUsageDependencies,
  request: CitationUsageRequest,
): Promise<CitationUsageResult> {
  if (request.entries.length === 0) return { submitted: 0, matched: 0 };

  const fallbackNamespace = deps.resolveNamespace(
    request.namespace,
    request.sessionId,
    request.authenticatedPrincipal,
  );
  const memoryEntries = (await Promise.all(
    request.entries.map(async (entry) => {
      const basename = entry.path.split(/[\\/]/).pop() ?? entry.path;
      const id = basename.endsWith(".md") ? basename.slice(0, -3) : basename;
      if (id.length === 0) return null;
      const namespace = deps.resolveNamespaceForPath
        ? await deps.resolveNamespaceForPath(
            entry.path,
            fallbackNamespace,
            request.sessionId,
            request.authenticatedPrincipal,
          )
        : fallbackNamespace;
      // Strip the resolved namespace prefix so citedPath is storage-relative for
      // both preferred-path matching and the exact-match lookup below. Namespace
      // names may contain "/", which the storage helper cannot strip alone (#2020).
      const citedPath =
        namespace && entry.path.startsWith(`${namespace}/`)
          ? entry.path.slice(namespace.length + 1)
          : entry.path;
      return { id, citedPath, namespace };
    }),
  )).filter(
    (
      entry,
    ): entry is { id: string; citedPath: string; namespace: string } =>
      entry !== null,
  );

  if (memoryEntries.length === 0) return { submitted: 0, matched: 0 };

  const matchedEntries: Array<{
    id: string;
    path: string;
    namespace: string;
  }> = [];
  const entriesByNamespace = new Map<string, typeof memoryEntries>();
  for (const entry of memoryEntries) {
    const entries = entriesByNamespace.get(entry.namespace) ?? [];
    entries.push(entry);
    entriesByNamespace.set(entry.namespace, entries);
  }

  for (const [namespace, namespaceEntries] of entriesByNamespace) {
    const storage = await deps.getStorage(namespace);
    const ids = [...new Set(namespaceEntries.map((entry) => entry.id))];
    const preferredPaths = new Map<string, string[]>();
    for (const entry of namespaceEntries) {
      const paths = preferredPaths.get(entry.id) ?? [];
      paths.push(entry.citedPath);
      preferredPaths.set(entry.id, paths);
    }
    const pathsById = await storage.findExistingMemoryPaths(ids, preferredPaths);
    const remainingPathsById = new Map(
      Array.from(pathsById.entries()).map(([id, paths]) => [id, [...paths]]),
    );
    for (const entry of namespaceEntries) {
      const paths = remainingPathsById.get(entry.id);
      if (!paths || paths.length === 0) continue;
      const preferredIndex = paths.indexOf(entry.citedPath);
      const pathIndex = preferredIndex >= 0 ? preferredIndex : 0;
      const [memoryPath] = paths.splice(pathIndex, 1);
      if (memoryPath) {
        matchedEntries.push({
          id: entry.id,
          path: memoryPath,
          namespace,
        });
      }
    }
  }

  if (matchedEntries.length > 0) {
    try {
      deps.trackMemoryAccess(
        matchedEntries.map((entry) => entry.id),
        matchedEntries.map((entry) => entry.path),
        matchedEntries.map((entry) => entry.namespace),
      );
    } catch {
      log.debug("citation usage tracking: failed to record access for cited memories");
    }
  }

  return { submitted: memoryEntries.length, matched: matchedEntries.length };
}

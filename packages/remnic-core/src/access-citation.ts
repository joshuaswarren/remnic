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
  ): Promise<Map<string, string>>;
}

export interface CitationUsageDependencies {
  resolveNamespace: (
    namespace: string | undefined,
    sessionId: string | undefined,
    authenticatedPrincipal: string | undefined,
  ) => string;
  getStorage: (namespace: string) => Promise<CitationStorage>;
  trackMemoryAccess: (memoryIds: string[], memoryPaths: string[]) => void;
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

  const resolvedNamespace = deps.resolveNamespace(
    request.namespace,
    request.sessionId,
    request.authenticatedPrincipal,
  );
  const memoryEntries = request.entries
    .map((entry) => {
      const basename = entry.path.split("/").pop() ?? entry.path;
      const id = basename.endsWith(".md") ? basename.slice(0, -3) : basename;
      return id.length > 0 ? { id, citedPath: entry.path } : null;
    })
    .filter(
      (entry): entry is { id: string; citedPath: string } => entry !== null,
    );

  if (memoryEntries.length === 0) return { submitted: 0, matched: 0 };
  const storage = await deps.getStorage(resolvedNamespace);
  const matchedEntries = (
    await Promise.all(
      memoryEntries.map(async (entry) => {
        const pathsById = await storage.findExistingMemoryPaths(
          [entry.id],
          new Map([[entry.id, [entry.citedPath]]]),
        );
        const memoryPath = pathsById.get(entry.id);
        return memoryPath ? { id: entry.id, path: memoryPath } : null;
      }),
    )
  ).filter(
    (entry): entry is { id: string; path: string } => entry !== null,
  );

  if (matchedEntries.length > 0) {
    try {
      deps.trackMemoryAccess(
        matchedEntries.map((entry) => entry.id),
        matchedEntries.map((entry) => entry.path),
      );
    } catch {
      log.debug("citation usage tracking: failed to record access for cited memories");
    }
  }

  return { submitted: memoryEntries.length, matched: matchedEntries.length };
}

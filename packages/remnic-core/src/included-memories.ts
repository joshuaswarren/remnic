export interface IncludedMemory {
  id: string;
  path: string;
  namespace?: string;
}

type LegacyIncludedMemorySource = {
  includedMemories?: unknown;
  memoryIds?: unknown;
  resultPaths?: unknown;
  resultNamespaces?: unknown;
  budgetsApplied?: unknown;
};

function legacyBudgetView(raw: LegacyIncludedMemorySource): {
  includedMemoryIds?: unknown;
  includedMemoryPaths?: unknown;
  includedMemoryNamespaces?: unknown;
} {
  const budgets = raw.budgetsApplied;
  if (!budgets || typeof budgets !== "object") return {};
  const record = budgets as Record<string, unknown>;
  return {
    includedMemoryIds: record.includedMemoryIds,
    includedMemoryPaths: record.includedMemoryPaths,
    includedMemoryNamespaces: record.includedMemoryNamespaces,
  };
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => (typeof item === "string" ? item : "")) : [];
}

function asOptionalStringList(value: unknown): Array<string | undefined> {
  return Array.isArray(value)
    ? value.map((item) => (typeof item === "string" ? item : undefined))
    : [];
}

function normalizeIncludedMemory(value: unknown): IncludedMemory | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { id?: unknown; path?: unknown; namespace?: unknown };
  const id = typeof record.id === "string" ? record.id : "";
  const path = typeof record.path === "string" ? record.path : "";
  if (!id && !path) return undefined;
  const namespace = typeof record.namespace === "string" ? record.namespace : undefined;
  return namespace ? { id, path, namespace } : { id, path };
}

export function coerceIncludedMemories(raw: object): IncludedMemory[] {
  const source = raw as LegacyIncludedMemorySource;
  if (Array.isArray(source.includedMemories)) {
    return source.includedMemories
      .map(normalizeIncludedMemory)
      .filter((item): item is IncludedMemory => item !== undefined);
  }

  const budgets = legacyBudgetView(source);
  const ids = asStringList(source.memoryIds ?? budgets.includedMemoryIds);
  const paths = asStringList(source.resultPaths ?? budgets.includedMemoryPaths);
  const namespaces = asOptionalStringList(
    source.resultNamespaces ?? budgets.includedMemoryNamespaces,
  );
  const count = Math.max(ids.length, paths.length);
  const memories: IncludedMemory[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = ids[index] ?? "";
    const path = paths[index] ?? "";
    if (!id && !path) continue;
    const namespace = namespaces[index];
    memories.push(namespace ? { id, path, namespace } : { id, path });
  }
  return memories;
}

export function includedMemoryIds(memories: readonly IncludedMemory[]): string[] {
  return memories.map((memory) => memory.id);
}

export function includedMemoryPaths(memories: readonly IncludedMemory[]): string[] {
  return memories.map((memory) => memory.path);
}

export function includedMemoryNamespaces(
  memories: readonly IncludedMemory[],
): Array<string | undefined> {
  return memories.map((memory) => memory.namespace);
}

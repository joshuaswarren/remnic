export interface PluginEntryResolverOptions {
  candidateIds: readonly string[];
  preferredId?: string;
  getEntries(raw: Record<string, unknown>): Record<string, unknown> | undefined;
  getSlotId?: (raw: Record<string, unknown>) => string | undefined;
}

function uniqueDefined(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value === undefined || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function resolvePluginEntry(
  raw: unknown,
  options: PluginEntryResolverOptions,
): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const root = raw as Record<string, unknown>;
  const entries = options.getEntries(root);
  if (!entries) return undefined;

  const allowedIds = new Set(options.candidateIds);
  const slotId = options.getSlotId?.(root);
  if (typeof slotId === "string" && !allowedIds.has(slotId)) {
    return undefined;
  }
  const activeId =
    typeof slotId === "string" && allowedIds.has(slotId)
      ? slotId
      : undefined;
  const ownId =
    !activeId &&
    typeof options.preferredId === "string" &&
    allowedIds.has(options.preferredId)
      ? options.preferredId
      : undefined;

  for (const id of uniqueDefined([activeId, ownId, ...options.candidateIds])) {
    const entry = entries[id];
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      return entry as Record<string, unknown>;
    }
  }
  return undefined;
}

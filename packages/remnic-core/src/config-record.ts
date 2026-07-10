function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve standalone config-file shapes into the core Remnic config record.
 *
 * Legacy files store core keys at the top level. During migration, a partial
 * `remnic` or `engram` block may coexist with those keys. Flat top-level core
 * keys remain fallbacks, while the selected nested block wins on key conflicts.
 * Host-only blocks are never forwarded into core parsing.
 */
export function resolveRemnicConfigRecord(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new Error("Top-level Remnic config must be a JSON object");
  }

  const { remnic, engram, server: _server, ...flat } = raw;
  const nested = remnic ?? engram;
  if (nested !== undefined && !isRecord(nested)) {
    throw new Error("Nested remnic/engram config must be a JSON object");
  }

  return nested === undefined ? flat : { ...flat, ...nested };
}

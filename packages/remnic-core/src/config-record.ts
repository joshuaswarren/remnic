function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

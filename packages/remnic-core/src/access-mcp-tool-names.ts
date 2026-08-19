/**
 * MCP tool-name prefixes (issue #2705).
 *
 * Anthropic tool names must match `^[a-zA-Z0-9_-]{1,64}$`.
 * Advertised canonical form is `remnic_<suffix>`.
 * `remnic.` and `engram.` stay callable.
 */
export const CANONICAL_MCP_PREFIX = "remnic_";
export const LEGACY_MCP_PREFIX = "engram.";
export const DOTTED_REMNIC_PREFIX = "remnic.";

const KNOWN_PREFIXES = [CANONICAL_MCP_PREFIX, DOTTED_REMNIC_PREFIX, LEGACY_MCP_PREFIX] as const;

export function toolNameSuffix(name: string): string | null {
  for (const prefix of KNOWN_PREFIXES) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return null;
}

export function toCanonicalToolName(name: string): string {
  const suffix = toolNameSuffix(name);
  return suffix === null ? name : `${CANONICAL_MCP_PREFIX}${suffix}`;
}

export function toLegacyToolName(name: string): string {
  const suffix = toolNameSuffix(name);
  return suffix === null ? name : `${LEGACY_MCP_PREFIX}${suffix}`;
}

export function withToolAliases<T extends { name: string }>(tool: T, emitLegacyTools = true): T[] {
  const canonicalName = toCanonicalToolName(tool.name);
  const canonicalTool = canonicalName === tool.name ? tool : { ...tool, name: canonicalName };
  if (canonicalName === tool.name) return [canonicalTool];
  return emitLegacyTools ? [canonicalTool, tool] : [canonicalTool];
}

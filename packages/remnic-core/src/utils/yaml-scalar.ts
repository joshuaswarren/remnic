/**
 * Decode a YAML double-quoted scalar: strip surrounding quotes and decode
 * JSON escape sequences. Used for fields that may be quoted at serialization
 * time to prevent frontmatter injection (e.g. sourceConnector).
 * Only double-quoted (JSON-compatible) values are decoded — the serializer
 * never emits single-quoted scalars.
 */
export function decodeYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const decoded = JSON.parse(trimmed);
      if (typeof decoded === "string") return decoded;
    } catch {
      // Fall through to strip quotes if JSON.parse fails
    }
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

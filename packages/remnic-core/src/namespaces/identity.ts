export function normalizeNamespaceIdentity(namespace: string): string {
  return namespace.trim();
}

export function namespaceIdentityToken(namespace: string): string {
  const normalized = normalizeNamespaceIdentity(namespace);
  const bytes = new TextEncoder().encode(normalized);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `ns-${hex || "default"}`;
}

export function namespaceIdentityFromToken(token: string): string | null {
  if (!token.startsWith("ns-")) return null;
  const hex = token.slice(3);
  if (hex === "default") return "";
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    return null;
  }
  const decoded = Buffer.from(hex, "hex").toString("utf8");
  return namespaceIdentityToken(decoded).toLowerCase() === token.toLowerCase()
    ? decoded
    : null;
}

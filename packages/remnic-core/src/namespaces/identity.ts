export function normalizeNamespaceIdentity(namespace: string | null | undefined): string {
  return namespace?.trim().normalize("NFC") ?? "";
}

function encodeNamespaceIdentityToken(namespace: string): string {
  const bytes = new TextEncoder().encode(namespace);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `ns-${hex || "default"}`;
}

export function namespaceIdentityToken(namespace: string): string {
  return encodeNamespaceIdentityToken(normalizeNamespaceIdentity(namespace));
}

export function namespaceIdentityLegacyToken(namespace: string): string {
  return encodeNamespaceIdentityToken(namespace.trim());
}

export function namespaceIdentityFromToken(token: string): string | null {
  if (!token.startsWith("ns-")) return null;
  const hex = token.slice(3);
  if (hex === "default") return "";
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    return null;
  }
  const decoded = Buffer.from(hex, "hex").toString("utf8");
  const normalized = normalizeNamespaceIdentity(decoded);
  return namespaceIdentityToken(decoded).toLowerCase() === token.toLowerCase() ||
    namespaceIdentityLegacyToken(decoded).toLowerCase() === token.toLowerCase()
    ? normalized
    : null;
}

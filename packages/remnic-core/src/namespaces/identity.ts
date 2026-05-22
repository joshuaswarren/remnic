export function normalizeNamespaceIdentity(namespace: string): string {
  return namespace.trim();
}

export function namespaceIdentityToken(namespace: string): string {
  const normalized = normalizeNamespaceIdentity(namespace);
  const bytes = new TextEncoder().encode(normalized);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `ns-${hex || "default"}`;
}

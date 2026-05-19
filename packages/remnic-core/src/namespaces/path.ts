import path from "node:path";

export function assertNamespacePathInsideRoot(
  root: string,
  candidate: string,
  namespace: string,
  label = "namespace path",
): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(`invalid ${label}: ${namespace}`);
}

export function resolveNamespaceChildRoot(
  memoryDir: string,
  namespace: string,
  label = "namespace path",
): string {
  const namespaceRoot = path.resolve(memoryDir, "namespaces");
  const candidate = path.resolve(namespaceRoot, namespace);
  assertNamespacePathInsideRoot(namespaceRoot, candidate, namespace, label);
  return candidate;
}

import {
  type RebuildMemoryProjectionOptions,
  rebuildMemoryProjection,
} from "../maintenance/rebuild-memory-projection.js";
import type { NamespaceSearchRouter } from "../namespaces/search.js";

type ConvergenceStorage = NonNullable<RebuildMemoryProjectionOptions["storage"]>;

export async function refreshConvergedNamespaces(
  namespaces: readonly string[],
  namespaceSearchRouter: Pick<NamespaceSearchRouter, "updateNamespacesDetailed">,
  getStorage: (namespace: string) => Promise<ConvergenceStorage>
): Promise<void> {
  const targetNamespaces = Array.from(new Set(namespaces.map((namespace) => namespace.trim()).filter(Boolean)));
  if (targetNamespaces.length === 0) return;

  const update = await namespaceSearchRouter.updateNamespacesDetailed(targetNamespaces, undefined, { strict: true });
  const eligible = new Set(update.eligibleNamespaces);
  const missing = targetNamespaces.filter((namespace) => !eligible.has(namespace));
  if (update.backendCount <= 0 || missing.length > 0) {
    throw new Error(`QMD backend ineligible for convergence namespaces (${missing.length})`);
  }

  for (const namespace of targetNamespaces) {
    const storage = await getStorage(namespace);
    await rebuildMemoryProjection({
      memoryDir: storage.dir,
      storage,
      defaultNamespace: namespace,
      dryRun: false,
    });
  }
}

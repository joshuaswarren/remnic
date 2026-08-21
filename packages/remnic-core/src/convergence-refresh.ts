import {
  type RebuildMemoryProjectionOptions,
  rebuildMemoryProjection,
} from "./maintenance/rebuild-memory-projection.js";
import type { NamespaceSearchRouter } from "./namespaces/search.js";

type ConvergenceStorage = NonNullable<RebuildMemoryProjectionOptions["storage"]>;

export async function refreshConvergedNamespaces(
  namespaces: readonly string[],
  namespaceSearchRouter: Pick<NamespaceSearchRouter, "updateNamespacesDetailed">,
  getStorage: (namespace: string) => Promise<ConvergenceStorage>,
  searchEnabled: boolean,
): Promise<void> {
  const targetNamespaces = Array.from(new Set(namespaces.map((namespace) => namespace.trim()).filter(Boolean)));
  if (targetNamespaces.length === 0) return;

  const searchResult = await namespaceSearchRouter.updateNamespacesDetailed(
    targetNamespaces,
    undefined,
    { strict: true },
  );
  if (searchEnabled) {
    const eligible = new Set(searchResult.eligibleNamespaces);
    const skipped = targetNamespaces.filter((namespace) => !eligible.has(namespace));
    if (skipped.length > 0) {
      throw new Error(`search refresh skipped namespaces: ${skipped.join(", ")}`);
    }
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

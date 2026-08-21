import type { PluginConfig, StorageManager } from "@remnic/core";

type RuntimeSurfaceNamespaceConfig = Pick<
  PluginConfig,
  "namespacesEnabled" | "defaultNamespace" | "sharedNamespace" | "namespacePolicies"
>;

export function listRuntimeSurfaceNamespaces(
  config: RuntimeSurfaceNamespaceConfig,
): string[] {
  if (!config.namespacesEnabled) return [config.defaultNamespace];
  return Array.from(
    new Set(
      [
        config.defaultNamespace,
        config.sharedNamespace,
        ...config.namespacePolicies.map((policy) => policy.name),
      ]
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

export async function forEachRuntimeSurfaceStorage(params: {
  config: RuntimeSurfaceNamespaceConfig;
  storage: StorageManager;
  getStorageForNamespace?: (namespace: string) => Promise<StorageManager>;
  work: (storage: StorageManager, namespace: string) => Promise<void>;
}): Promise<void> {
  for (const namespace of listRuntimeSurfaceNamespaces(params.config)) {
    const storage =
      typeof params.getStorageForNamespace === "function"
        ? await params.getStorageForNamespace(namespace)
        : params.storage;
    await params.work(storage, namespace);
  }
}

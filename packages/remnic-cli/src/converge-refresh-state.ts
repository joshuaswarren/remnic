import { Orchestrator, type PluginConfig } from "@remnic/core";
import {
  type ConvergeRefreshTarget,
  clearConvergeRefreshPending,
  defaultConvergeCursorPath,
  markConvergeRefreshPending,
  readConvergeCursor,
} from "@remnic/core/reconcile/cursor.js";
import type { ReconcilePlan, ReconcilePlanEntry } from "@remnic/core/reconcile/plan.js";

export interface ConvergeRefreshStateOptions {
  config?: PluginConfig;
  cursorDir?: string;
  peerUrl?: string;
  peerFileBuffers?: Map<string, Map<string, Buffer>>;
  refreshLocalNamespaces?: (namespaces: readonly string[]) => Promise<void>;
}

function cursorStorageRoot(options: ConvergeRefreshStateOptions): string | undefined {
  return options.cursorDir ?? options.config?.memoryDir;
}

export async function readPendingRefreshNamespaces(
  plan: ReconcilePlan,
  options: ConvergeRefreshStateOptions,
  target: ConvergeRefreshTarget
): Promise<Set<string>> {
  const memoryDir = cursorStorageRoot(options);
  if (!memoryDir) return new Set();
  const peerUrl = options.peerUrl ?? "local";
  const pending = new Set<string>();
  for (const { namespace } of plan.byNamespace) {
    const cursor = await readConvergeCursor(defaultConvergeCursorPath(memoryDir, peerUrl, namespace));
    if (cursor?.pendingRefreshes?.includes(target)) pending.add(namespace);
  }
  return pending;
}

export async function setRefreshPending(
  options: ConvergeRefreshStateOptions,
  namespace: string,
  target: ConvergeRefreshTarget,
  pending: boolean
): Promise<void> {
  const memoryDir = cursorStorageRoot(options);
  if (!memoryDir) return;
  const peerUrl = options.peerUrl ?? "local";
  const cursorPath = defaultConvergeCursorPath(memoryDir, peerUrl, namespace);
  if (pending) {
    await markConvergeRefreshPending(cursorPath, { peerUrl, namespace, target });
  } else {
    await clearConvergeRefreshPending(cursorPath, target);
  }
}

export function plansReceiverMutation(entry: ReconcilePlanEntry, options: ConvergeRefreshStateOptions): boolean {
  if (!options.peerUrl || options.peerFileBuffers) return false;
  if (entry.action === "push") return true;
  return entry.action === "conflict" && entry.resolution === "local-wins";
}

export async function refreshLocalProjections(
  options: ConvergeRefreshStateOptions,
  config: PluginConfig | undefined,
  namespaces: readonly string[]
): Promise<void> {
  if (namespaces.length === 0) return;
  if (options.refreshLocalNamespaces) {
    await options.refreshLocalNamespaces(namespaces);
    return;
  }
  if (!config) throw new Error("local convergence refresh requires configuration");
  const orchestrator = new Orchestrator(config);
  try {
    await orchestrator.refreshNamespacesAfterConvergence(namespaces);
  } finally {
    await orchestrator.destroy();
  }
}

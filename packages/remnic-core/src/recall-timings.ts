import { resolveNamespaceCapabilities } from "./capabilities.js";
import { canReadNamespace } from "./namespaces/principal.js";
import type { PluginConfig } from "./types.js";

export interface RecallTimingRecord {
  readonly timestamp: string;
  readonly namespace: string;
  readonly total: string;
  readonly recallPlan: string;
  readonly queryPolicy: string;
  readonly [field: string]: string;
}

const RECALL_TIMING_HISTORY_LIMIT = 50;
const histories = new WeakMap<PluginConfig, RecallTimingRecord[]>();

export function recordRecallTiming(
  config: PluginConfig,
  record: RecallTimingRecord,
): void {
  const history = histories.get(config) ?? [];
  history.push({ ...record });
  if (history.length > RECALL_TIMING_HISTORY_LIMIT) history.shift();
  histories.set(config, history);
}

export function getRecallTimings(
  config: PluginConfig,
  authenticatedPrincipal?: string,
): RecallTimingRecord[] {
  const history = histories.get(config) ?? [];
  const readable = resolveNamespaceCapabilities(config).namespaces
    ? history.filter((record) =>
      canReadNamespace(authenticatedPrincipal, record.namespace, config)
    )
    : history;
  return readable.slice().reverse().map((record) => ({ ...record }));
}

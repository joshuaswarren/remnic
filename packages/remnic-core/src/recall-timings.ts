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

export interface RecallTimingStatus {
  readonly count: number;
  readonly records: RecallTimingRecord[];
}

interface RecallTimingHistoryEntry {
  readonly record: RecallTimingRecord;
  readonly searchedNamespaces: readonly string[];
  readonly aclNamespaces: readonly string[];
}

const RECALL_TIMING_HISTORY_LIMIT = 50;
const histories = new WeakMap<PluginConfig, RecallTimingHistoryEntry[]>();

export function recordRecallTiming(
  config: PluginConfig,
  record: RecallTimingRecord,
  searchedNamespaces: readonly string[] = [record.namespace],
  aclNamespaces: readonly string[] = searchedNamespaces,
): void {
  const history = histories.get(config) ?? [];
  const effectiveSearchedNamespaces =
    searchedNamespaces.length > 0 ? searchedNamespaces : [record.namespace];
  const effectiveAclNamespaces =
    aclNamespaces.length > 0 ? aclNamespaces : [record.namespace];
  // JS runs this synchronous push/shift block to completion, so concurrent
  // recalls cannot interleave ring updates and do not need a lock.
  history.push({
    record: { ...record },
    searchedNamespaces: [...effectiveSearchedNamespaces],
    aclNamespaces: [...effectiveAclNamespaces],
  });
  if (history.length > RECALL_TIMING_HISTORY_LIMIT) history.shift();
  histories.set(config, history);
}

export function getRecallTimings(
  config: PluginConfig,
  authenticatedPrincipal?: string,
): RecallTimingRecord[] {
  const history = histories.get(config) ?? [];
  const readable = resolveNamespaceCapabilities(config).namespaces
    ? history.filter((entry) =>
      entry.aclNamespaces.every((namespace) =>
        canReadNamespace(authenticatedPrincipal, namespace, config)
      )
    )
    : history;
  return readable.slice().reverse().map(({ record }) => ({ ...record }));
}

export function getRecallTimingStatus(
  config: PluginConfig,
  authenticatedPrincipal?: string,
): RecallTimingStatus {
  const records = getRecallTimings(config, authenticatedPrincipal);
  return { count: records.length, records };
}

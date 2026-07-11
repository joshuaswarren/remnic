import { resolveNamespaceCapabilities } from "./capabilities.js";
import { resolveScopeProfilePlan } from "./namespaces/scope-profiles.js";
import { canReadNamespace } from "./namespaces/principal.js";
import type { CodingContext, PluginConfig } from "./types.js";

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

export interface RecallTimingScopeContext {
  readonly codingContext: CodingContext;
  readonly codingOverlay: {
    readonly namespace: string;
    readonly readFallbacks: readonly string[];
  };
}

interface RecallTimingHistoryEntry {
  readonly record: RecallTimingRecord;
  readonly searchedNamespaces: readonly string[];
  readonly aclNamespaces: readonly string[];
  readonly scopeContext?: RecallTimingScopeContext;
}

const RECALL_TIMING_HISTORY_LIMIT = 50;
const histories = new WeakMap<PluginConfig, RecallTimingHistoryEntry[]>();

export function recordRecallTiming(
  config: PluginConfig,
  record: RecallTimingRecord,
  searchedNamespaces: readonly string[] = [record.namespace],
  aclNamespaces: readonly string[] = searchedNamespaces,
  scopeContext?: RecallTimingScopeContext,
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
    ...(scopeContext ? { scopeContext } : {}),
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
    ? history.filter((entry) => {
      const profilePlan = entry.scopeContext
        ? resolveScopeProfilePlan({
            config,
            principal: authenticatedPrincipal,
            codingContext: entry.scopeContext.codingContext,
            codingOverlay: {
              namespace: entry.scopeContext.codingOverlay.namespace,
              readFallbacks: [...entry.scopeContext.codingOverlay.readFallbacks],
            },
          })
        : null;
      const readableProfileNamespaces = new Set(
        profilePlan?.layers.flatMap((layer) =>
          layer.readable && layer.namespace ? [layer.namespace] : []
        ) ?? [],
      );
      return entry.aclNamespaces.every((namespace) =>
        canReadNamespace(authenticatedPrincipal, namespace, config)
        || readableProfileNamespaces.has(namespace)
      );
    })
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

/**
 * Per-session namespace binding store for the delegate runtime, with the
 * one-way migration of bindings written under the legacy plugin id.
 *
 * Split from `delegate-runtime.ts`: the store is a storage concern of its own
 * (merge order, per-session serialization, legacy cleanup) and the runtime
 * only consumes the resulting `SessionNamespaceBindingStore`.
 */

import path from "node:path";
import { log } from "@remnic/core/logger";
import {
  SESSION_NAMESPACE_BINDING_MAX_ENTRIES,
  SESSION_NAMESPACE_BINDING_MAX_NAMESPACES,
  type SessionNamespaceBindingStore,
  createFileSessionNamespaceBindingStore,
} from "@remnic/core/session-namespace-bindings";

import { REMNIC_OPENCLAW_LEGACY_PLUGIN_ID, REMNIC_OPENCLAW_PLUGIN_ID } from "./plugin-id.js";

const delegateNamespaceMigrationChains = new Map<string, Map<string, Promise<void>>>();
const queueDelegateNamespaceMigration = <T>(
  bindingPath: string,
  sessionKey: string,
  operation: () => Promise<T>
): Promise<T> => {
  let sessionChains = delegateNamespaceMigrationChains.get(bindingPath);
  if (sessionChains === undefined) {
    sessionChains = new Map();
    delegateNamespaceMigrationChains.set(bindingPath, sessionChains);
  }
  const prior = sessionChains.get(sessionKey) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(operation);
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  sessionChains.set(sessionKey, settled);
  void settled.then(() => {
    if (sessionChains?.get(sessionKey) !== settled) return;
    sessionChains.delete(sessionKey);
    if (sessionChains.size === 0 && delegateNamespaceMigrationChains.get(bindingPath) === sessionChains) {
      delegateNamespaceMigrationChains.delete(bindingPath);
    }
  });
  return run;
};

export function createDelegateNamespaceBindingStore(
  memoryDir: string,
  serviceId: string,
  isLegacyAdapterActive: () => boolean
): SessionNamespaceBindingStore {
  const bindingPath = (pluginId: string): string =>
    path.join(memoryDir, "state", "plugins", pluginId, "session-namespace-bindings.json");
  const primaryPath = bindingPath(serviceId);
  const primary = createFileSessionNamespaceBindingStore(primaryPath);
  if (serviceId !== REMNIC_OPENCLAW_PLUGIN_ID) return primary;

  const legacy = createFileSessionNamespaceBindingStore(bindingPath(REMNIC_OPENCLAW_LEGACY_PLUGIN_ID));
  const migratedLegacySessions = new Set<string>();
  const rememberMigratedLegacySession = (sessionKey: string): void => {
    if (migratedLegacySessions.has(sessionKey)) return;
    migratedLegacySessions.add(sessionKey);
    while (migratedLegacySessions.size > SESSION_NAMESPACE_BINDING_MAX_ENTRIES) {
      const oldest = migratedLegacySessions.values().next().value;
      if (oldest === undefined) return;
      migratedLegacySessions.delete(oldest);
    }
  };
  const queueSessionMigration = <T>(sessionKey: string, operation: () => Promise<T>): Promise<T> =>
    queueDelegateNamespaceMigration(primaryPath, sessionKey, operation);
  const readLegacyNamespaces = async (sessionKey: string, current: string[]): Promise<string[]> => {
    if (!isLegacyAdapterActive() && migratedLegacySessions.has(sessionKey)) return [];
    try {
      const previous = await legacy.namespacesFor(sessionKey);
      if (previous.length === 0) rememberMigratedLegacySession(sessionKey);
      return previous;
    } catch (err) {
      if (current.length > 0) {
        log.warn(`[${serviceId}] delegate legacy namespace read failed; using canonical bindings: ${String(err)}`);
        return [];
      }
      throw err;
    }
  };
  const mergeNamespaceHistory = (current: string[], previous: string[]): string[] => {
    const merged: string[] = [];
    for (const remembered of [...previous, ...current]) {
      const existing = merged.indexOf(remembered);
      if (existing >= 0) merged.splice(existing, 1);
      merged.push(remembered);
    }
    return merged.slice(-SESSION_NAMESPACE_BINDING_MAX_NAMESPACES);
  };
  const persistNamespaceHistory = async (
    store: SessionNamespaceBindingStore,
    sessionKey: string,
    namespaces: string[]
  ): Promise<void> => {
    if (store.replace !== undefined) {
      await store.replace(sessionKey, namespaces);
      return;
    }
    for (const namespace of namespaces) {
      await store.remember(sessionKey, namespace);
    }
  };
  const completeLegacyMigration = async (sessionKey: string): Promise<void> => {
    if (!isLegacyAdapterActive()) {
      try {
        await legacy.replace?.(sessionKey, []);
      } catch (err) {
        log.warn(`[${serviceId}] delegate legacy namespace cleanup failed: ${String(err)}`);
      }
    }
    rememberMigratedLegacySession(sessionKey);
  };
  return {
    async namespacesFor(sessionKey: string): Promise<string[]> {
      return queueSessionMigration(sessionKey, async () => {
        const current = await primary.namespacesFor(sessionKey);
        const previous = await readLegacyNamespaces(sessionKey, current);
        if (previous.length === 0) return current;
        const merged = mergeNamespaceHistory(current, previous);
        const hasMissingLegacy = previous.some((remembered) => !current.includes(remembered));
        if (!hasMissingLegacy) {
          await completeLegacyMigration(sessionKey);
          return current;
        }
        try {
          await persistNamespaceHistory(primary, sessionKey, merged);
          await completeLegacyMigration(sessionKey);
        } catch (err) {
          log.warn(`[${serviceId}] delegate namespace migration failed: ${String(err)}`);
        }
        return merged;
      });
    },
    async remember(sessionKey: string, namespace: string): Promise<void> {
      return queueSessionMigration(sessionKey, async () => {
        const current = await primary.namespacesFor(sessionKey);
        const previous = await readLegacyNamespaces(sessionKey, current);
        if (previous.length === 0) {
          await primary.remember(sessionKey, namespace);
          return;
        }
        const merged = mergeNamespaceHistory([...current, namespace], previous);
        await persistNamespaceHistory(primary, sessionKey, merged);
        await completeLegacyMigration(sessionKey);
      });
    },
  };
}

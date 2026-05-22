import path from "node:path";
import { access } from "node:fs/promises";
import { isSafeRouteNamespace } from "../routing/engine.js";
import { StorageManager } from "../storage.js";
import type { PluginConfig } from "../types.js";
import { namespaceIdentityToken, normalizeNamespaceIdentity } from "./identity.js";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const LEGACY_NAMESPACE_CHILDREN = [
  "facts",
  "corrections",
  "entities",
  "questions",
  "artifacts",
  "identity",
  "state",
  "config",
  "summaries",
  "procedures",
  "reasoning-traces",
  "profile.md",
] as const;

async function hasAnyLegacyData(rootDir: string): Promise<boolean> {
  for (const child of LEGACY_NAMESPACE_CHILDREN) {
    if (await exists(path.join(rootDir, child))) return true;
  }
  return false;
}

/**
 * Storage routing for namespaces.
 *
 * Compatibility note:
 * - When namespaces are enabled, non-default namespaces live under `memoryDir/namespaces/<ns>`.
 * - The default namespace continues to use the legacy `memoryDir` root unless the caller
 *   has created `memoryDir/namespaces/<defaultNamespace>` (in which case we use that).
 *
 * This avoids surprising "lost memories" when an install flips namespaces on without
 * migrating existing data.
 */
export class NamespaceStorageRouter {
  private readonly cache = new Map<string, StorageManager>();
  private defaultNsRootResolved: string | null = null;

  constructor(private readonly config: PluginConfig) {}

  private async defaultNamespaceRoot(): Promise<string> {
    if (!this.config.namespacesEnabled) {
      this.defaultNsRootResolved = this.config.memoryDir;
      return this.defaultNsRootResolved;
    }

    const nsDir = path.join(
      this.config.memoryDir,
      "namespaces",
      namespaceIdentityToken(this.config.defaultNamespace),
    );
    this.defaultNsRootResolved =
      (await exists(nsDir)) && !(await hasAnyLegacyData(this.config.memoryDir))
        ? nsDir
        : this.config.memoryDir;
    return this.defaultNsRootResolved;
  }

  private namespaceRootSync(namespace: string): string {
    // NOTE: only used after defaultNamespaceRoot() resolution.
    if (!this.config.namespacesEnabled) return this.config.memoryDir;
    if (namespace === this.config.defaultNamespace) {
      return this.defaultNsRootResolved ?? this.config.memoryDir;
    }
    return path.join(this.config.memoryDir, "namespaces", namespaceIdentityToken(namespace));
  }

  async storageFor(namespace: string): Promise<StorageManager> {
    const ns = normalizeNamespaceIdentity(namespace || this.config.defaultNamespace);
    if (ns !== this.config.defaultNamespace && !isSafeRouteNamespace(ns)) {
      throw new Error(`unsafe namespace: ${ns}`);
    }

    let root: string;
    if (ns === this.config.defaultNamespace) {
      root = await this.defaultNamespaceRoot();
      const cached = this.cache.get(ns);
      if (cached && cached.dir === root) {
        return cached;
      }
    } else {
      const cached = this.cache.get(ns);
      if (cached) return cached;
      root = this.namespaceRootSync(ns);
    }

    const sm = new StorageManager(root, this.config.entitySchemas);
    // Propagate the inline-attribution template so that router-created storages
    // (used by extraction and shared-promotion paths) strip citations consistently,
    // matching the behaviour of the primary this.storage instance in the orchestrator.
    sm.citationTemplate = this.config.inlineSourceAttributionFormat;
    this.cache.set(ns, sm);
    return sm;
  }
}

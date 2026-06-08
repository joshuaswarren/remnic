import path from "node:path";
import { access, lstat, readdir } from "node:fs/promises";
import { isSafeRouteNamespace } from "../routing/engine.js";
import { StorageManager } from "../storage.js";
import type { PluginConfig } from "../types.js";
import { ALL_CATEGORY_DIRS } from "../utils/category-dir.js";
import { namespaceIdentityToken, normalizeNamespaceIdentity } from "./identity.js";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function hasStoredEntries(p: string): Promise<boolean> {
  try {
    const entry = await lstat(p);
    if (entry.isSymbolicLink()) return true;
    if (!entry.isDirectory()) return true;
    const children = await readdir(p, { withFileTypes: true });
    for (const child of children) {
      const childPath = path.join(p, child.name);
      if (child.isSymbolicLink() || child.isFile()) return true;
      if (child.isDirectory() && (await hasStoredEntries(childPath))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Build a per-namespace directory under `<memoryDir>/namespaces` and assert the
// resolved path stays inside that base. Namespace identifiers can originate from
// operator config (config.defaultNamespace) and request-derived routing, so this
// containment check prevents directory traversal (CodeQL js/path-injection).
// For safe segments this returns exactly `path.join(base, segment)`, so there is
// no behavioral change for valid namespaces.
function resolveNamespaceDir(memoryDir: string, segment: string): string {
  // Mirror isSafeRouteNamespace's separator/parent-ref rejection (without its
  // 64-char cap, so identity tokens still pass). Rejecting separators and ".."
  // up front keeps the value a single contained child of <memoryDir>/namespaces.
  if (
    segment.length === 0 ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("..") ||
    path.isAbsolute(segment)
  ) {
    throw new Error(`unsafe namespace path segment: ${segment}`);
  }
  return path.join(memoryDir, "namespaces", segment);
}

const LEGACY_NAMESPACE_CONTENT_CHILDREN = [
  ...ALL_CATEGORY_DIRS,
  "entities",
  "artifacts",
  "identity",
  "config",
  "summaries",
  "profile.md",
] as const;

const LEGACY_NAMESPACE_RUNTIME_CHILDREN = ["state"] as const;

async function hasAnyLegacyData(
  rootDir: string,
  options: { includeRuntimeState?: boolean } = {},
): Promise<boolean> {
  const children = options.includeRuntimeState === true
    ? [...LEGACY_NAMESPACE_CONTENT_CHILDREN, ...LEGACY_NAMESPACE_RUNTIME_CHILDREN]
    : LEGACY_NAMESPACE_CONTENT_CHILDREN;
  for (const child of children) {
    if (await hasStoredEntries(path.join(rootDir, child))) return true;
  }
  return false;
}

async function hasAnyNamespaceStorageMarker(
  rootDir: string,
  options: { includeRuntimeState?: boolean } = {},
): Promise<boolean> {
  const children = options.includeRuntimeState === true
    ? [...LEGACY_NAMESPACE_CONTENT_CHILDREN, ...LEGACY_NAMESPACE_RUNTIME_CHILDREN]
    : LEGACY_NAMESPACE_CONTENT_CHILDREN;
  for (const child of children) {
    if (await exists(path.join(rootDir, child))) return true;
  }
  return false;
}

/**
 * Storage routing for namespaces.
 *
 * Compatibility note:
 * - When namespaces are enabled, existing raw namespace roots are preserved.
 *   New namespace roots use tokenized names under `memoryDir/namespaces/<token>`.
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

    const legacyNsDir = resolveNamespaceDir(this.config.memoryDir, this.config.defaultNamespace);
    const tokenizedNsDir = resolveNamespaceDir(
      this.config.memoryDir,
      namespaceIdentityToken(this.config.defaultNamespace),
    );
    const tokenizedHasData =
      (await exists(tokenizedNsDir)) && (await hasAnyNamespaceStorageMarker(tokenizedNsDir, { includeRuntimeState: true }));
    const nsDir = tokenizedHasData
      ? tokenizedNsDir
      : (await exists(legacyNsDir)) ? legacyNsDir : tokenizedNsDir;
    this.defaultNsRootResolved =
      (await exists(nsDir)) && !(await hasAnyLegacyData(this.config.memoryDir))
        ? nsDir
        : this.config.memoryDir;
    return this.defaultNsRootResolved;
  }

  private async namespaceRoot(namespace: string): Promise<string> {
    // NOTE: only used after defaultNamespaceRoot() resolution.
    if (!this.config.namespacesEnabled) return this.config.memoryDir;
    if (namespace === this.config.defaultNamespace) {
      return this.defaultNsRootResolved ?? this.config.memoryDir;
    }
    const legacyRoot = resolveNamespaceDir(this.config.memoryDir, namespace);
    const tokenizedRoot = resolveNamespaceDir(this.config.memoryDir, namespaceIdentityToken(namespace));
    if ((await exists(tokenizedRoot)) && (await hasAnyNamespaceStorageMarker(tokenizedRoot, { includeRuntimeState: true }))) {
      return tokenizedRoot;
    }
    return (await exists(legacyRoot)) ? legacyRoot : tokenizedRoot;
  }

  async storageFor(namespace: string): Promise<StorageManager> {
    const ns = normalizeNamespaceIdentity(namespace || this.config.defaultNamespace);
    if (ns !== this.config.defaultNamespace && !isSafeRouteNamespace(ns)) {
      throw new Error(`unsafe namespace: ${ns}`);
    }
    // Even when the default namespace is exempt from the check above, every
    // on-disk path is built through resolveNamespaceDir(), which rejects
    // traversal segments — so an unsafe configured default still cannot escape
    // <memoryDir>/namespaces (CodeQL js/path-injection).

    let root: string;
    if (ns === this.config.defaultNamespace) {
      root = await this.defaultNamespaceRoot();
      const cached = this.cache.get(ns);
      if (cached && cached.dir === root) {
        return cached;
      }
    } else {
      const cached = this.cache.get(ns);
      root = await this.namespaceRoot(ns);
      if (cached && cached.dir === root) return cached;
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

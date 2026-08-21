import path from "node:path";
import { log } from "../logger.js";
import { resolveNamespaceCapabilities } from "../capabilities.js";
import { namespaceIdentityFromToken } from "../namespaces/identity.js";
import type { PluginConfig } from "../types.js";

/**
 * Compute the semantic-dedup path scope for a target storage (issue #1526 seam:
 * extracted verbatim from Orchestrator.semanticDedupScopeFor). Reads only the
 * plugin config + target storage dir; no `this` state.
 */
export function computeSemanticDedupScope(
  targetStorage: { readonly dir: string },
  config: PluginConfig,
): {
  pathPrefix?: string;
  pathExcludePrefixes?: readonly string[];
} {
  if (!resolveNamespaceCapabilities(config).namespaces) return {};
  const memoryDir = path.resolve(config.memoryDir);
  const storageDir = path.resolve(targetStorage.dir);
  if (storageDir === memoryDir) {
    // Default namespace at legacy root. Include everything that isn't
    // under `namespaces/*` (those belong to other namespaces).
    return { pathExcludePrefixes: ["namespaces/"] };
  }
  let rel = path.relative(memoryDir, storageDir);
  if (!rel || rel.startsWith("..")) {
    // Round 12 fix (PR #399): when targetStorage.dir is outside memoryDir
    // (custom namespace routing), toMemoryRelativePath() stores the absolute
    // file path in the index rather than a memoryDir-relative path. Return the
    // absolute storageDir as the pathPrefix so the search() filter still scopes
    // the lookup to the correct tenant's files. Previously this returned {} (no
    // scoping), which let high-similarity hits from other namespaces' absolute-
    // path entries suppress writes in the target namespace — a cross-tenant
    // dedup suppression path.
    log.debug(
      `semantic dedup: target storage dir ${storageDir} is outside memoryDir ${memoryDir}; scoping lookup to absolute path prefix`,
    );
    const absPrefix = storageDir.replace(/\\/g, "/");
    return { pathPrefix: absPrefix.endsWith("/") ? absPrefix : `${absPrefix}/` };
  }
  rel = rel.replace(/\\/g, "/");
  if (!rel.endsWith("/")) rel = `${rel}/`;
  return { pathPrefix: rel };
}

/**
 * Resolve the namespace identity implied by a QMD collection prefix (issue
 * #1526 seam: extracted verbatim from Orchestrator.qmdCollectionNamespaceFromPrefix).
 * Reads only the plugin config; no `this` state.
 */
export function qmdCollectionNamespaceFromPrefix(
  collectionPrefix: string,
  config: PluginConfig,
): string | null {
  const baseCollection = config.qmdCollection;
  if (collectionPrefix === baseCollection) return config.defaultNamespace;
  const namespaceSuffix = collectionPrefix.startsWith(`${baseCollection}--`)
    ? collectionPrefix.slice(baseCollection.length + 2)
    : "";
  if (!namespaceSuffix) return null;

  const decoded = namespaceIdentityFromToken(namespaceSuffix);
  if (decoded !== null) return decoded || config.defaultNamespace;
  if (namespaceSuffix.startsWith("ns--")) {
    const legacyNamespace = namespaceSuffix.slice("ns--".length).trim();
    return legacyNamespace || null;
  }
  return null;
}

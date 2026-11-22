import path from "node:path";
import { log } from "../logger.js";
import { resolveNamespaceCapabilities } from "../capabilities.js";
import { namespaceIdentityFromToken } from "../namespaces/identity.js";
import type { PluginConfig } from "../types.js";

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
    return { pathExcludePrefixes: ["namespaces/"] };
  }
  let rel = path.relative(memoryDir, storageDir);
  if (!rel || rel.startsWith("..")) {
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

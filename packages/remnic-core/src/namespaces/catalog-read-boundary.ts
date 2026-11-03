import path from "node:path";
import type { PluginConfig } from "../types.js";
import { namespaceIdentityToken, normalizeNamespaceIdentity } from "./identity.js";
import { mergeNewerTouchFields } from "./catalog-record.js";
import type { NamespaceRecord } from "./catalog.js";
import { isSafeRouteNamespace } from "../routing/engine.js";

/**
 * Read-boundary sanitation for NamespaceCatalog (extracted in #3297): the two
 * defenses against a tampered or pre-fix `namespaces.jsonl` row, and the
 * storage-root alias collapse that picks one owner per physical root.
 */
export interface CatalogReadBoundaryPort {
  defaultNamespaceIdentity: string;
  memoryDir: string;
  isContainedStorageDir(candidate: string): Promise<boolean>;
  isStorageDirForNamespace(
    namespace: string,
    candidate: string,
  ): Promise<boolean>;
  resolveSafeStorageDir(namespace: string): Promise<string>;
}

/**
 * Sanitize a record at the enumeration boundary (round 5, cursor Medium + codex
 * P2; round 6 — NDXHe). Reads return whatever is in `namespaces.jsonl` after
 * schema checks only, so a tampered or pre-fix row could surface unsafe data to
 * maintenance/QMD until a rewrite occurs. Two distinct defenses:
 *
 *  1. UNSAFE NAMESPACE NAME (NGZqr, codex P2): an unsafe non-default namespace
 *     (e.g. `../evil`, a name with separators, or >64 chars) is REJECTED outright
 *     — return `null` so the caller drops it. The disk SCAN and the hot touch
 *     path both reject such names with the SAME default-exempt `isSafeRouteNamespace`
 *     gate, so the read boundary MUST agree, or `listNamespaces()`/`getNamespaceRecord()`
 *     would expose a namespace those paths reject (note `isStorageDirForNamespace`
 *     can still build a tokenized root even for `../evil`, so storageDir sanitation
 *     alone does not catch it). The default namespace is exempt (it may be a
 *     non-route literal), matching every other validation site.
 *
 *  2. UNSAFE storageDir: for an otherwise-valid namespace, apply the SAME contract
 *     as the write path — full containment (`isContainedStorageDir`: lexical +
 *     symlink/realpath) AND namespace ownership (`isStorageDirForNamespace`). When
 *     a record fails EITHER check we substitute the trusted resolved-and-safe root
 *     for that namespace (rule 42: read and write stay symmetric).
 */
export async function sanitizeRecordForRead(
  port: CatalogReadBoundaryPort,
  record: NamespaceRecord,
): Promise<NamespaceRecord | null> {
  // Defense 1: drop an unsafe non-default namespace name entirely. Compare
  // against the NORMALIZED default identity — record keys are trimmed, so a raw
  // whitespace-padded config default would never match the default row (NH-FH).
  if (
    record.namespace !== port.defaultNamespaceIdentity &&
    !isSafeRouteNamespace(record.namespace)
  ) {
    return null;
  }
  // Defense 2: keep the record but substitute a safe storageDir when needed.
  if (
    (await port.isContainedStorageDir(record.storageDir)) &&
    (await port.isStorageDirForNamespace(record.namespace, record.storageDir))
  ) {
    return record;
  }
  const safe = await port.resolveSafeStorageDir(record.namespace);
  return { ...record, storageDir: safe };
}

export function storageRootOwnershipRank(
  port: CatalogReadBoundaryPort,
  record: NamespaceRecord,
  resolvedStorageDir: string,
  configured: Set<string>,
): number {
  if (resolvedStorageDir === path.resolve(port.memoryDir)) {
    return record.namespace === port.defaultNamespaceIdentity ? 0 : 3;
  }

  const leaf = path.basename(resolvedStorageDir);
  const tokenOwnsRoot = namespaceIdentityToken(record.namespace) === leaf;
  if (tokenOwnsRoot && configured.has(record.namespace)) {
    return 0;
  }
  if (record.namespace === leaf) return 1;
  if (tokenOwnsRoot) return 2;
  return 3;
}

export function configuredNamespaceIdentities(
  config: PluginConfig,
): Set<string> {
  return new Set(
    [
      config.defaultNamespace,
      config.sharedNamespace,
      ...config.namespacePolicies.map((p) => p.name),
    ]
      .map((n) => normalizeNamespaceIdentity(n))
      .filter((n) => n.length > 0),
  );
}

export function preferStorageRootOwner(
  port: CatalogReadBoundaryPort,
  current: NamespaceRecord,
  candidate: NamespaceRecord,
  resolvedStorageDir: string,
  configured: Set<string>,
): NamespaceRecord {
  const currentRank = storageRootOwnershipRank(
    port,
    current,
    resolvedStorageDir,
    configured,
  );
  const candidateRank = storageRootOwnershipRank(
    port,
    candidate,
    resolvedStorageDir,
    configured,
  );
  if (candidateRank < currentRank) return candidate;
  if (candidateRank > currentRank) return current;

  const byName = candidate.namespace.localeCompare(current.namespace);
  if (byName < 0) return candidate;
  if (byName > 0) return current;
  return candidate.identityToken.localeCompare(current.identityToken) < 0
    ? candidate
    : current;
}

export function dropDuplicateStorageRootAliases(
  port: CatalogReadBoundaryPort,
  records: NamespaceRecord[],
  config: PluginConfig,
): NamespaceRecord[] {
  const byStorageDir = new Map<string, NamespaceRecord>();
  const configured = configuredNamespaceIdentities(config);
  for (const record of records) {
    const resolvedStorageDir = path.resolve(record.storageDir);
    const current = byStorageDir.get(resolvedStorageDir);
    if (!current) {
      byStorageDir.set(resolvedStorageDir, record);
      continue;
    }
    const owner = preferStorageRootOwner(
      port,
      current,
      record,
      resolvedStorageDir,
      configured,
    );
    const alias = owner === current ? record : current;
    byStorageDir.set(resolvedStorageDir, mergeNewerTouchFields(owner, alias));
  }
  return [...byStorageDir.values()];
}

import assert from "node:assert/strict";
import test from "node:test";
import type { PluginConfig } from "../types.js";
import type { NamespaceRecord } from "./catalog.js";
import { namespaceIdentityToken } from "./identity.js";
import {
  configuredNamespaceIdentities,
  dropDuplicateStorageRootAliases,
  preferStorageRootOwner,
  sanitizeRecordForRead,
  storageRootOwnershipRank,
  type CatalogReadBoundaryPort,
} from "./catalog-read-boundary.js";

/**
 * Config for the name-only boundary functions. Object.create(null) yields an untyped value, so
 * no assertion is needed: the functions read only the three namespace-name fields.
 */
function namesOnlyConfig(
  defaultNamespace: string,
  sharedNamespace: string,
  policyNames: string[],
): PluginConfig {
  return Object.assign(Object.create(null), {
    defaultNamespace,
    sharedNamespace,
    namespacePolicies: policyNames.map((name) => ({ name, readPrincipals: [], writePrincipals: [] })),
  });
}

const config = namesOnlyConfig("default", "shared", ["project-a"]);

const port: CatalogReadBoundaryPort = {
  defaultNamespaceIdentity: "default",
  memoryDir: "/mem",
  async isContainedStorageDir(candidate) {
    return candidate.startsWith("/mem/namespaces/");
  },
  async isStorageDirForNamespace() {
    return true;
  },
  async resolveSafeStorageDir(namespace) {
    return `/mem/namespaces/${namespaceIdentityToken(namespace)}`;
  },
};

function rec(namespace: string, storageDir: string): NamespaceRecord {
  // SAFETY: this literal is a complete NamespaceRecord; the cast only supplies the optional
  // timestamp fields (lastReadAt/lastWriteAt/lastMaintenanceAt) as undefined.
  return {
    namespace,
    identityToken: namespaceIdentityToken(namespace),
    kind: "project",
    createdAt: "2026-01-01T00:00:00.000Z",
    storageDir,
    discoveredBy: "write",
  };
}

test("storageRootOwnershipRank orders the ownership tiers", () => {
  const configured = configuredNamespaceIdentities(config);
  const tokenA = namespaceIdentityToken("project-a");
  // Tier 0: the catalog-owned literal for a configured namespace.
  assert.equal(storageRootOwnershipRank(port, rec("project-a", `/mem/namespaces/${tokenA}`), `/mem/namespaces/${tokenA}`, configured), 0);
  // Tier 1: the namespace name is the root's leaf.
  assert.equal(storageRootOwnershipRank(port, rec("leaf", "/mem/namespaces/leaf"), "/mem/namespaces/leaf", configured), 1);
  // Tier 2: token-shaped root for an unconfigured namespace.
  const tokenOther = namespaceIdentityToken("other");
  assert.equal(storageRootOwnershipRank(port, rec("other", `/mem/namespaces/${tokenOther}`), `/mem/namespaces/${tokenOther}`, configured), 2);
  // Tier 3: neither, and the memoryDir root is only owned by the default namespace.
  assert.equal(storageRootOwnershipRank(port, rec("other", "/mem/unrelated-root"), "/mem/unrelated-root", configured), 3);
  assert.equal(storageRootOwnershipRank(port, rec("default", "/mem"), "/mem", configured), 0, "the default namespace owns the memoryDir root");
  assert.equal(storageRootOwnershipRank(port, rec("other", "/mem"), "/mem", configured), 3);
});

test("configuredNamespaceIdentities drops empty names and keeps configured ones", () => {
  const cfg = namesOnlyConfig(" default ", "", ["  ", "project-a"]);
  assert.deepEqual([...configuredNamespaceIdentities(cfg)].sort(), ["default", "project-a"]);
  // A single-character namespace is a valid identity and must survive the empty filter.
  const shortCfg = namesOnlyConfig("x", "y", []);
  assert.deepEqual([...configuredNamespaceIdentities(shortCfg)].sort(), ["x", "y"]);
});

test("preferStorageRootOwner breaks ties by name then identityToken", () => {
  const configured = configuredNamespaceIdentities(config);
  const a = rec("beta", "/mem/x");
  const b = rec("alpha", "/mem/x");
  assert.equal(preferStorageRootOwner(port, a, b, "/mem/x", configured), b);
  assert.equal(preferStorageRootOwner(port, b, a, "/mem/x", configured), b);
  // Same name: the lower identityToken wins, whichever side it arrives on.
  const t1 = { ...rec("alpha", "/mem/x"), identityToken: "token-one" };
  const t2 = { ...rec("alpha", "/mem/x"), identityToken: "token-two" };
  assert.equal(preferStorageRootOwner(port, t2, t1, "/mem/x", configured), t1);
  assert.equal(preferStorageRootOwner(port, t1, t2, "/mem/x", configured), t1);
  // Exact identity tie: the CURRENT wins (localeCompare returns 0, and 0 < 0 is false).
  const same1 = rec("alpha", "/mem/x");
  const same2 = { ...rec("alpha", "/mem/x"), lastWriteAt: "2026-02-02T00:00:00.000Z" };
  assert.equal(preferStorageRootOwner(port, same1, same2, "/mem/x", configured), same1);
  assert.equal(preferStorageRootOwner(port, same2, same1, "/mem/x", configured), same2);
  // Candidate sorts AFTER the current name: the current wins on the name comparison alone.
  const zeta = rec("zeta", "/mem/x");
  assert.equal(preferStorageRootOwner(port, b, zeta, "/mem/x", configured), b);
  assert.equal(preferStorageRootOwner(port, zeta, b, "/mem/x", configured), b);
});

test("dropDuplicateStorageRootAliases keeps one owner per root and merges the alias's recency", () => {
  const tokenA = namespaceIdentityToken("project-a");
  const configured = rec("project-a", `/mem/namespaces/${tokenA}`);
  const alias = { ...rec("other", `/mem/namespaces/${tokenA}`), lastWriteAt: "2026-02-02T00:00:00.000Z" };
  const out = dropDuplicateStorageRootAliases(port, [alias, configured], config);
  assert.equal(out.length, 1);
  assert.equal(out[0].namespace, "project-a");
  assert.equal(out[0].lastWriteAt, "2026-02-02T00:00:00.000Z", "the dropped alias's recency survives in the owner");
});

test("sanitizeRecordForRead drops unsafe names and substitutes unsafe storage dirs", async () => {
  assert.equal(await sanitizeRecordForRead(port, rec("../evil", "/mem/x")), null);
  const safe = await sanitizeRecordForRead(port, rec("alpha", "/mem/elsewhere"));
  assert.ok(safe);
  assert.equal(safe.storageDir, `/mem/namespaces/${namespaceIdentityToken("alpha")}`);
});

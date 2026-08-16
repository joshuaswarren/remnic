import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { PluginConfig } from "../types.js";
import { NamespaceCatalog } from "./catalog.js";
import { namespaceIdentityFromToken, namespaceIdentityLegacyToken, namespaceIdentityToken } from "./identity.js";
import { resolveNamespaceStorageRoot } from "./storage.js";

function makeConfig(memoryDir: string): PluginConfig {
  return {
    memoryDir,
    namespacesEnabled: true,
    namespaceCatalogEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    entitySchemas: {},
  } as unknown as PluginConfig;
}

test("Unicode namespaces decode from disk and list in stable order", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-unicode-routing-"));
  try {
    const config = makeConfig(memoryDir);
    const catalog = new NamespaceCatalog(config);
    const cjk = "项目";
    const ascii = "alpha";

    assert.equal(namespaceIdentityFromToken(namespaceIdentityToken(cjk)), cjk);
    assert.equal(namespaceIdentityToken("Cafe\u0301"), namespaceIdentityToken("Café"));
    const nfd = "Café".normalize("NFD");
    const legacyToken = namespaceIdentityLegacyToken(nfd);
    assert.equal(namespaceIdentityFromToken(legacyToken), "Café");
    await mkdir(path.join(memoryDir, "namespaces", legacyToken, "facts"), { recursive: true });
    assert.equal(await resolveNamespaceStorageRoot(config, "Café"), path.join(memoryDir, "namespaces", legacyToken));
    await catalog.markWrite(cjk, { discoveredBy: "write" });
    await catalog.markWrite(ascii, { discoveredBy: "write" });

    const first = await catalog.listNamespaces();
    const second = await catalog.listNamespaces();
    assert.deepEqual(
      first.map((record) => record.namespace),
      second.map((record) => record.namespace)
    );
    assert.ok(first.some((record) => record.namespace === cjk));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

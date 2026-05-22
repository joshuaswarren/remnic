import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { namespaceCollectionName } from "./search.js";
import { NamespaceStorageRouter } from "./storage.js";
import type { PluginConfig } from "../types.js";

test("namespace collection names preserve case-variant namespace identity", () => {
  const upper = namespaceCollectionName("remnic", "ProjectA");
  const lower = namespaceCollectionName("remnic", "projecta");

  assert.notEqual(upper, lower);
  assert.match(upper, /^remnic--ns-[0-9a-f]+$/);
  assert.match(lower, /^remnic--ns-[0-9a-f]+$/);
});

test("namespace storage paths preserve case-variant namespace identity", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ns-"));
  try {
    const config = {
      memoryDir,
      namespacesEnabled: true,
      defaultNamespace: "default",
      entitySchemas: {},
      inlineSourceAttributionFormat: undefined,
    } as unknown as PluginConfig;
    const router = new NamespaceStorageRouter(config);

    const upper = await router.storageFor("ProjectA");
    const lower = await router.storageFor("projecta");

    assert.notEqual(upper.dir, lower.dir);
    assert.ok(upper.dir.startsWith(path.join(memoryDir, "namespaces")));
    assert.ok(lower.dir.startsWith(path.join(memoryDir, "namespaces")));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

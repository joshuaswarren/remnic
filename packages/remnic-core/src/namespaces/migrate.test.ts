import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PluginConfig } from "../types.js";
import { namespaceIdentityToken } from "./identity.js";
import { listNamespaces } from "./migrate.js";

test("listNamespaces decodes tokenized namespace directories", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ns-migrate-"));
  try {
    const namespace = "team-beta";
    await mkdir(path.join(memoryDir, "namespaces", namespaceIdentityToken(namespace), "facts"), {
      recursive: true,
    });
    const namespaces = await listNamespaces({
      config: {
        memoryDir,
        namespacesEnabled: true,
        defaultNamespace: "default",
        sharedNamespace: "shared",
        namespacePolicies: [],
        qmdCollection: "remnic",
        entitySchemas: {},
        inlineSourceAttributionFormat: undefined,
      } as unknown as PluginConfig,
    });

    assert.ok(namespaces.some((entry) => entry.namespace === namespace && entry.hasMemoryData));
    assert.ok(!namespaces.some((entry) => entry.namespace === namespaceIdentityToken(namespace)));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("listNamespaces preserves configured raw namespace names that look tokenized", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ns-migrate-"));
  try {
    const namespace = namespaceIdentityToken("team-beta");
    await mkdir(path.join(memoryDir, "namespaces", namespace, "facts"), {
      recursive: true,
    });
    const namespaces = await listNamespaces({
      config: {
        memoryDir,
        namespacesEnabled: true,
        defaultNamespace: "default",
        sharedNamespace: "shared",
        namespacePolicies: [{ name: namespace, readPrincipals: ["*"], writePrincipals: ["*"] }],
        qmdCollection: "remnic",
        entitySchemas: {},
        inlineSourceAttributionFormat: undefined,
      } as unknown as PluginConfig,
    });

    assert.ok(namespaces.some((entry) => entry.namespace === namespace && entry.hasMemoryData));
    assert.ok(!namespaces.some((entry) => entry.namespace === "team-beta"));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

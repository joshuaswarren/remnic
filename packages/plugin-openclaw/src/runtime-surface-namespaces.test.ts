import assert from "node:assert/strict";
import test from "node:test";

import {
  forEachRuntimeSurfaceStorage,
  listRuntimeSurfaceNamespaces,
} from "./runtime-surface-namespaces.js";

test("listRuntimeSurfaceNamespaces fans out to default, shared, and policy namespaces", () => {
  const namespaces = listRuntimeSurfaceNamespaces({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [
      {
        name: "team-alpha",
        readPrincipals: ["team-alpha"],
        writePrincipals: ["team-alpha"],
        includeInRecallByDefault: false,
      },
      {
        name: "team-beta",
        readPrincipals: ["team-beta"],
        writePrincipals: ["team-beta"],
        includeInRecallByDefault: false,
      },
    ],
  } as never);

  assert.deepEqual(namespaces, ["default", "shared", "team-alpha", "team-beta"]);
});

test("forEachRuntimeSurfaceStorage resolves namespace-scoped storages when namespaces are enabled", async () => {
  const visited: Array<{ namespace: string; storageId: string }> = [];
  await forEachRuntimeSurfaceStorage({
    config: {
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [
        {
          name: "team-alpha",
          readPrincipals: ["team-alpha"],
          writePrincipals: ["team-alpha"],
          includeInRecallByDefault: false,
        },
      ],
    } as never,
    storage: { id: "fallback" } as never,
    getStorageForNamespace: async (namespace: string) => ({ id: `storage:${namespace}` }) as never,
    work: async (storage, namespace) => {
      visited.push({ namespace, storageId: (storage as unknown as { id: string }).id });
    },
  });

  assert.deepEqual(visited, [
    { namespace: "default", storageId: "storage:default" },
    { namespace: "shared", storageId: "storage:shared" },
    { namespace: "team-alpha", storageId: "storage:team-alpha" },
  ]);
});

test("forEachRuntimeSurfaceStorage stays on the default storage when namespaces are disabled", async () => {
  const visited: Array<{ namespace: string; storageId: string }> = [];
  await forEachRuntimeSurfaceStorage({
    config: {
      namespacesEnabled: false,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [],
    } as never,
    storage: { id: "default-storage" } as never,
    work: async (storage, namespace) => {
      visited.push({ namespace, storageId: (storage as unknown as { id: string }).id });
    },
  });

  assert.deepEqual(visited, [
    { namespace: "default", storageId: "default-storage" },
  ]);
});

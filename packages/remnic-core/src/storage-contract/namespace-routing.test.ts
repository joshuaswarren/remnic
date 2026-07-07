/**
 * Issue #1533 — Phase A contract test: namespace routing.
 *
 * NamespaceStorageRouter must route the SAME operation through the correct
 * on-disk root for default vs named namespaces, while rejecting escaping paths
 * (the containment invariants from #1506 — a FILE at the namespaces root or at
 * a token dir is rejected via statSync().isDirectory(), not existsSync; rule 24).
 *
 * Contracts pinned:
 *  - default namespace → memoryDir (legacy root)
 *  - named namespace → memoryDir/namespaces/<token>
 *  - unsafe namespace segments (/, \, .., absolute) are rejected
 *  - writes in one namespace are invisible to another
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { makeStorage, makeNamespaceRouter } from "./harness.js";
import { resolveNamespaceStorageRoot } from "../namespaces/storage.js";
import { namespaceIdentityToken } from "../namespaces/identity.js";

test("namespace-routing: default namespace resolves to the legacy memoryDir root", async () => {
  const { router, memoryDir, config, cleanup } = await makeNamespaceRouter();
  try {
    const root = await resolveNamespaceStorageRoot(config, "default");
    assert.equal(root, memoryDir);

    const sm = await router.storageFor("default");
    assert.equal(sm.dir, memoryDir);
  } finally {
    await cleanup();
  }
});

test("namespace-routing: named namespace resolves to a tokenized subdirectory", async () => {
  const { router, memoryDir, config, cleanup } = await makeNamespaceRouter();
  try {
    const ns = "team-alpha";
    const root = await resolveNamespaceStorageRoot(config, ns);
    const token = namespaceIdentityToken(ns);
    assert.ok(
      root.includes(path.join("namespaces", token)),
      `named namespace root ${root} should include namespaces/${token}`,
    );

    const sm = await router.storageFor(ns);
    assert.ok(sm.dir.startsWith(memoryDir), "named namespace must be under memoryDir");
    assert.ok(sm.dir.includes("namespaces"), "named namespace must be under namespaces/");
  } finally {
    await cleanup();
  }
});

test("namespace-routing: two named namespaces resolve to DIFFERENT roots", async () => {
  const { router, cleanup } = await makeNamespaceRouter();
  try {
    const sm1 = await router.storageFor("team-alpha");
    const sm2 = await router.storageFor("team-beta");
    assert.notEqual(sm1.dir, sm2.dir, "different namespaces must have different roots");
  } finally {
    await cleanup();
  }
});

test("namespace-routing: writes in one namespace are invisible to another (isolation)", async () => {
  const { router, cleanup } = await makeNamespaceRouter();
  try {
    const sm1 = await router.storageFor("team-alpha");
    const { id: id } = await sm1.writeMemory("fact", "alpha-only fact");

    const sm2 = await router.storageFor("team-beta");
    const found = await sm2.getMemoryById(id);
    assert.equal(found, null, "beta namespace must not see alpha's memories");
  } finally {
    await cleanup();
  }
});

test("namespace-routing: resolveNamespaceStorageRoot rejects traversal segments", async () => {
  const { config, cleanup } = await makeNamespaceRouter();
  try {
    for (const bad of ["../escape", "a/b", "a\\b", "/abs"]) {
      await assert.rejects(
        () => resolveNamespaceStorageRoot(config, bad),
        /unsafe namespace path segment/,
        `should reject ${bad}`,
      );
    }
  } finally {
    await cleanup();
  }
});

test("namespace-routing: storageFor rejects unsafe non-default namespaces", async () => {
  const { router, cleanup } = await makeNamespaceRouter();
  try {
    for (const bad of ["../escape", "a/b"]) {
      await assert.rejects(
        () => router.storageFor(bad),
        /unsafe namespace/,
        `should reject ${bad}`,
      );
    }
  } finally {
    await cleanup();
  }
});

test("namespace-routing: namespaces disabled → all namespaces use memoryDir", async () => {
  const { router, memoryDir, cleanup } = await makeNamespaceRouter({
    namespacesEnabled: false,
  });
  try {
    const sm1 = await router.storageFor("default");
    const sm2 = await router.storageFor("anything");
    assert.equal(sm1.dir, memoryDir);
    assert.equal(sm2.dir, memoryDir);
  } finally {
    await cleanup();
  }
});

test("namespace-routing: router caches StorageManager per namespace (same instance on repeat)", async () => {
  const { router, cleanup } = await makeNamespaceRouter();
  try {
    const sm1 = await router.storageFor("team-alpha");
    const sm2 = await router.storageFor("team-alpha");
    assert.equal(sm1, sm2, "storageFor must return the cached instance for the same namespace");
  } finally {
    await cleanup();
  }
});

/**
 * #1533 Phase A — namespace routing contract (issue done-when #4):
 * the same operation through `NamespaceStorageRouter` for default vs named
 * namespace lands in the right roots, and escaping path segments are
 * rejected (the containment invariants from #1506 — a path with separators,
 * `..`, or absolute prefixes is rejected; `isSafeRouteNamespace` not bare
 * `existsSync`).
 *
 * Rule 24 (file-as-directory) gap note: `hasAnyNamespaceStorageMarker` in
 * namespaces/storage.ts uses an `access()`-based `exists` helper rather than
 * `isDirectory()`. That is recorded as a gap for the silent-failures issue —
 * Phase A does NOT change behavior. The routing-level containment check
 * (`storageFor` → `isSafeRouteNamespace` + `resolveNamespaceDir`) is the
 * load-bearing invariant and is what these tests pin.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";

import { NamespaceStorageRouter } from "../../packages/remnic-core/src/namespaces/storage.js";
import { isSafeRouteNamespace } from "../../packages/remnic-core/src/routing/engine.js";
import { makeNamespaceRouterConfig, createScratchDir, withScratchDir } from "./helpers.js";

test("namespace routing: default namespace lands at the legacy memoryDir root when no namespaced dir exists", async () => {
  await withScratchDir("ns-default-legacy", async (memoryDir) => {
    await mkdir(memoryDir, { recursive: true });
    const cfg = makeNamespaceRouterConfig(memoryDir);
    const router = new NamespaceStorageRouter(cfg);

    const storage = await router.storageFor("default");
    assert.equal(storage.dir, memoryDir, "default namespace must use the legacy memoryDir root");
  });
});

test("namespace routing: default namespace migrates to namespaced dir when it pre-exists", async () => {
  await withScratchDir("ns-default-namespaced", async (memoryDir) => {
    const nsDir = path.join(memoryDir, "namespaces", "default");
    await mkdir(nsDir, { recursive: true });

    const cfg = makeNamespaceRouterConfig(memoryDir);
    const router = new NamespaceStorageRouter(cfg);

    const storage = await router.storageFor("default");
    assert.equal(storage.dir, nsDir, "default namespace must use the pre-existing namespaced dir");
  });
});

test("namespace routing: a named (non-default) namespace lands under <memoryDir>/namespaces/<token-or-name>", async () => {
  await withScratchDir("ns-named", async (memoryDir) => {
    const cfg = makeNamespaceRouterConfig(memoryDir);
    const router = new NamespaceStorageRouter(cfg);

    const storage = await router.storageFor("project-origin-abcd1234");
    // Path-boundary check: a sibling like <memoryDir>/namespaces-evil would
    // satisfy a naive startsWith("<memoryDir>/namespaces") but is OUTSIDE the
    // namespaces/ directory. path.relative returns ".." only for paths outside
    // the root, so this catches the prefix-collision bug a startsWith misses.
    const namespacesRoot = path.join(memoryDir, "namespaces");
    assert.ok(
      !path.relative(namespacesRoot, storage.dir).startsWith(".."),
      `named namespace must resolve under <memoryDir>/namespaces/ — got ${storage.dir}`,
    );
    assert.notEqual(storage.dir, memoryDir, "named namespace must NOT collapse onto the default root");
  });
});

test("namespace routing: default vs named namespaces resolve to DIFFERENT roots (no collision)", async () => {
  await withScratchDir("ns-isolation", async (memoryDir) => {
    const cfg = makeNamespaceRouterConfig(memoryDir);
    const router = new NamespaceStorageRouter(cfg);

    const defaultStorage = await router.storageFor("default");
    const namedStorage = await router.storageFor("team-marketing");
    assert.notEqual(
      defaultStorage.dir,
      namedStorage.dir,
      "default and named namespaces must resolve to distinct roots",
    );
  });
});

test("namespace routing: containment — unsafe namespace segments are rejected at storageFor", async () => {
  await withScratchDir("ns-containment", async (memoryDir) => {
    const cfg = makeNamespaceRouterConfig(memoryDir);
    const router = new NamespaceStorageRouter(cfg);

    // Each of these would escape <memoryDir>/namespaces if not rejected.
    // `isSafeRouteNamespace` rejects: empty, ".", "..", segments with `/`/`\\`,
    // over-64-char names, and names outside [A-Za-z0-9._-].
    // Each of these would escape <memoryDir>/namespaces if not rejected.
    // `isSafeRouteNamespace` rejects: ".", "..", segments with `/`/`\\`,
    // over-64-char names, and names outside [A-Za-z0-9._-].
    // NOTE: empty string ("") is NOT in this list — storageFor routes it to
    // the configured default via `namespace || config.defaultNamespace`, which
    // is the documented fallback, not an escape.
    const unsafe: Array<[string, string]> = [
      ["..", "parent reference"],
      ["../evil", "parent reference with slash"],
      ["a/b", "slash separator"],
      ["a\\b", "backslash separator"],
      [".", "dot"],
    ];
    for (const [ns, label] of unsafe) {
      await assert.rejects(
        () => router.storageFor(ns),
        (err: unknown) => err instanceof Error && /unsafe namespace/i.test(err.message),
        `storageFor(${JSON.stringify(ns)}) must reject (${label})`,
      );
    }
  });
});

test("namespace routing: isSafeRouteNamespace is the load-bearing containment check (parity with storageFor)", () => {
  // Pin the routing-engine predicate so a refactor of storageFor cannot silently
  // widen the accepted set. The default namespace is intentionally exempt at
  // the routing layer (a configured default may be a non-route literal).
  const accepted = ["default-safe", "project-origin-abcd1234", "team_marketing", "ns.with.dots"];
  for (const ns of accepted) {
    assert.equal(isSafeRouteNamespace(ns), true, `${ns} should be a safe route namespace`);
  }
  const rejected = ["..", "a/b", "a\\b", ".", "", "spaces here", "exclaim!"];
  for (const ns of rejected) {
    assert.equal(isSafeRouteNamespace(ns), false, `${ns} should NOT be a safe route namespace`);
  }
});

test("namespace routing: router caches StorageManager per (namespace, root) — same root returns the same instance", async () => {
  await withScratchDir("ns-cache", async (memoryDir) => {
    const cfg = makeNamespaceRouterConfig(memoryDir);
    const router = new NamespaceStorageRouter(cfg);

    const a = await router.storageFor("default");
    const b = await router.storageFor("default");
    assert.equal(a, b, "storageFor must return the cached instance for the same (namespace, root)");
  });
});

test("namespace routing: whenResolveHooksSettled resolves even with no hook registered", async () => {
  await withScratchDir("ns-settle-noop", async (memoryDir) => {
    const cfg = makeNamespaceRouterConfig(memoryDir);
    const router = new NamespaceStorageRouter(cfg);
    await router.storageFor("default");
    // Must not hang — there is no onResolve hook, so the set is empty.
    await router.whenResolveHooksSettled();
    assert.ok(true, "whenResolveHooksSettled resolved with no hook");
  });
});

test("namespace routing: scratch dir helper produces the openclaw-engram-storage-contract prefix", async () => {
  const dir = await createScratchDir("prefix-check");
  try {
    const base = path.basename(dir);
    assert.ok(
      base.startsWith("openclaw-engram-storage-contract-prefix-check-"),
      `scratch prefix drifted: ${base}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

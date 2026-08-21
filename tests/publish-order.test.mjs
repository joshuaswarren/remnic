import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  discoverWorkspacePackages,
  resolvePublishOrder,
  validatePublishOrder,
} from "../scripts/publish-order.mjs";

async function createFixture(packages) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-publish-order-"));
  for (const pkg of packages) {
    const packageDir = path.join(repoRoot, pkg.dir);
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      path.join(packageDir, "package.json"),
      `${JSON.stringify(
        {
          name: pkg.name,
          version: "1.0.0",
          private: pkg.private,
          dependencies: pkg.dependencies,
          optionalDependencies: pkg.optionalDependencies,
          peerDependencies: pkg.peerDependencies,
        },
        null,
        2,
      )}\n`,
    );
  }
  return repoRoot;
}

test("publish order is generated with internal dependencies before dependents", async () => {
  const repoRoot = await createFixture([
    { dir: "packages/app", name: "@fixture/app", dependencies: { "@fixture/core": "^1.0.0" } },
    { dir: "packages/core", name: "@fixture/core" },
    { dir: "packages/plugin", name: "@fixture/plugin", peerDependencies: { "@fixture/core": "^1.0.0" } },
  ]);

  const packages = await discoverWorkspacePackages(repoRoot);
  const order = resolvePublishOrder(packages);

  assert.ok(order.indexOf("packages/core") < order.indexOf("packages/app"));
  assert.ok(order.indexOf("packages/core") < order.indexOf("packages/plugin"));
});

test("publish order validation rejects missing and duplicate public packages", async () => {
  const repoRoot = await createFixture([
    { dir: "packages/a", name: "@fixture/a" },
    { dir: "packages/b", name: "@fixture/b" },
  ]);
  const packages = (await discoverWorkspacePackages(repoRoot)).filter((pkg) => !pkg.private);

  assert.throws(() => validatePublishOrder(packages, ["packages/a"]), /missing public package/);
  assert.throws(
    () => validatePublishOrder(packages, ["packages/a", "packages/a", "packages/b"]),
    /duplicate package/,
  );
});

test("publish order validation rejects dependents before dependencies", async () => {
  const repoRoot = await createFixture([
    { dir: "packages/app", name: "@fixture/app", dependencies: { "@fixture/core": "^1.0.0" } },
    { dir: "packages/core", name: "@fixture/core" },
  ]);
  const packages = (await discoverWorkspacePackages(repoRoot)).filter((pkg) => !pkg.private);

  assert.throws(
    () => validatePublishOrder(packages, ["packages/app", "packages/core"]),
    /appears before dependency/,
  );
});

test("publish order rejects public packages that depend on private workspace packages", () => {
  assert.throws(
    () =>
      resolvePublishOrder([
        {
          dir: "packages/app",
          name: "@fixture/app",
          private: false,
          deps: new Set(["@fixture/private-core"]),
        },
        {
          dir: "packages/private-core",
          name: "@fixture/private-core",
          private: true,
          deps: new Set(),
        },
      ]),
    /depends on private workspace package/,
  );
});

test("publish order ignores optional peer edges (issue #1551)", async () => {
  // Mutual optional peers create cycles in the unfiltered graph but are
  // install-time orthogonal in practice — either peer may be installed
  // first. The resolver must ignore the edge so the order remains
  // acyclic. See packageDepNames comment in publish-order.mjs.
  const repoRoot = await createFixture([
    {
      dir: "packages/coding-graph",
      name: "@fixture/coding-graph",
      peerDependencies: { "@fixture/core": "^1.0.0" },
    },
    {
      dir: "packages/core",
      name: "@fixture/core",
      peerDependencies: { "@fixture/coding-graph": "^1.0.0" },
    },
  ]);
  // createFixture does not emit peerDependenciesMeta — patch the generated
  // package.json so both peers are declared optional. This mirrors what
  // packages/coding-graph and packages/remnic-core look like in the real
  // workspace for #1551.
  for (const name of ["@fixture/coding-graph", "@fixture/core"]) {
    await writeFile(
      path.join(repoRoot, "packages", name.replace(/^@fixture\//, ""), "package.json"),
      `${JSON.stringify(
        {
          name,
          version: "1.0.0",
          peerDependencies:
            name === "@fixture/coding-graph"
              ? { "@fixture/core": "^1.0.0" }
              : { "@fixture/coding-graph": "^1.0.0" },
          peerDependenciesMeta:
            name === "@fixture/coding-graph"
              ? { "@fixture/core": { optional: true } }
              : { "@fixture/coding-graph": { optional: true } },
        },
        null,
        2,
      )}\n`,
    );
  }
  const packages = await discoverWorkspacePackages(repoRoot);
  // Should NOT throw — the mutual optional-peer cycle is suppressed.
  const order = resolvePublishOrder(packages);
  assert.deepEqual(
    order.slice().sort(),
    ["packages/coding-graph", "packages/core"],
    "both public packages must be in the order (no cycle rejection)",
  );
});

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

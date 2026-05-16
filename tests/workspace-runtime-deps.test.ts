import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const testDir = new URL(".", import.meta.url);

const packageExpectations = [
  {
    label: "CLI",
    path: new URL("../packages/remnic-cli/package.json", testDir),
    deps: {
      "@remnic/core": "workspace:^",
      "@remnic/server": "workspace:^",
    },
  },
  {
    label: "server",
    path: new URL("../packages/remnic-server/package.json", testDir),
    deps: {
      "@remnic/core": "workspace:^",
    },
  },
  {
    label: "OpenClaw plugin",
    path: new URL("../packages/plugin-openclaw/package.json", testDir),
    deps: {
      "@remnic/core": "workspace:^",
    },
  },
] as const;

test("runtime workspace packages preserve local linking in source manifests", async () => {
  for (const pkgSpec of packageExpectations) {
    const raw = await readFile(pkgSpec.path, "utf8");
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    for (const [depName, expectedRange] of Object.entries(pkgSpec.deps)) {
      assert.equal(
        pkg.dependencies?.[depName],
        expectedRange,
        `${pkgSpec.label} should use ${expectedRange} for ${depName}`,
      );
    }

    if (pkgSpec.label === "CLI") {
      assert.equal(
        pkg.dependencies?.["@remnic/export-weclone"],
        undefined,
        "CLI should not publish a runtime dependency on @remnic/export-weclone",
      );
      assert.equal(
        pkg.devDependencies?.["@remnic/export-weclone"],
        "workspace:*",
        "CLI should keep @remnic/export-weclone as a build-time workspace dependency",
      );
    }
  }
});

test("npm package lock keeps the Remnic server dependency beside the CLI", async () => {
  const raw = await readFile(new URL("../package-lock.json", testDir), "utf8");
  const lock = JSON.parse(raw) as {
    packages?: Record<
      string,
      {
        dependencies?: Record<string, string>;
      }
    >;
  };

  assert.equal(
    lock.packages?.["packages/remnic-cli"]?.dependencies?.["@remnic/server"],
    "file:../remnic-server",
    "package-lock should install @remnic/server beside @remnic/cli",
  );
  assert.equal(
    lock.packages?.["packages/plugin-openclaw"]?.dependencies?.[
      "@remnic/server"
    ],
    undefined,
    "plugin-openclaw should not gain the CLI daemon server dependency",
  );
});

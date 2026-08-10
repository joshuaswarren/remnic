import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadOpenclawManagedUpgradeModule } from "./openclaw-managed-upgrade-loader.js";

const MANAGED_UPGRADE_SPECIFIER = "@remnic/" + "plugin-openclaw/managed-upgrade";

function missingModuleError(specifier: string): Error & { code: string } {
  return Object.assign(new Error(`Cannot find package '${specifier}' imported from test`), {
    code: "ERR_MODULE_NOT_FOUND",
  });
}

function missingSubpathError(): Error & { code: string } {
  return Object.assign(
    new Error(
      "Package subpath './managed-upgrade' is not defined by \"exports\" in " +
        "/tmp/node_modules/@remnic/plugin-openclaw/package.json"
    ),
    { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }
  );
}

function writeManagedUpgradeFixture(temporaryRoot: string): void {
  const packageRoot = path.join(temporaryRoot, "node_modules", "@remnic", "plugin-openclaw");
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@remnic/plugin-openclaw",
      type: "module",
      exports: { "./managed-upgrade": { import: "./dist/managed-upgrade.js" } },
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(packageRoot, "dist", "managed-upgrade.js"),
    'export const REMNIC_OPENCLAW_PLUGIN_ID = "openclaw-remnic";\n',
    "utf8"
  );
}

const rejectedPackageSpecs = [
  "@remnic/plugin-openclaw@npm:other-package",
  "@remnic/plugin-openclaw@file:./plugin",
  "@remnic/plugin-openclaw@https://example.com/plugin.tgz",
  "@remnic/plugin-openclaw@./plugin.tgz",
  "@remnic/plugin-openclaw@git+https://example.com/plugin.git",
];

test("managed upgrade loader rejects non-registry package selectors before loading", async () => {
  for (const packageSpec of rejectedPackageSpecs) {
    let importInvoked = false;
    let npmInvoked = false;

    await assert.rejects(
      loadOpenclawManagedUpgradeModule(packageSpec, {
        importModule: async () => {
          importInvoked = true;
          return {};
        },
        runNpmInstall: () => {
          npmInvoked = true;
        },
      }),
      /exact semantic version or npm dist-tag/
    );
    assert.equal(importInvoked, false, packageSpec);
    assert.equal(npmInvoked, false, packageSpec);
  }
});

test("managed upgrade loader uses an installed adapter without invoking npm", async () => {
  let npmInvoked = false;
  const expected = { REMNIC_OPENCLAW_PLUGIN_ID: "openclaw-remnic" };

  const actual = await loadOpenclawManagedUpgradeModule("@remnic/plugin-openclaw@9.49.1", {
    importModule: async (specifier) => {
      assert.equal(specifier, MANAGED_UPGRADE_SPECIFIER);
      return expected;
    },
    runNpmInstall: () => {
      npmInvoked = true;
    },
  });

  assert.equal(actual, expected);
  assert.equal(npmInvoked, false);
});

test("managed upgrade loader installs the target adapter in an isolated temporary project", async () => {
  let temporaryRoot: string | undefined;
  const importedSpecifiers: string[] = [];

  const actual = await loadOpenclawManagedUpgradeModule("@remnic/plugin-openclaw@9.49.1", {
    importModule: async (specifier) => {
      importedSpecifiers.push(specifier);
      if (specifier === MANAGED_UPGRADE_SPECIFIER) throw missingModuleError("@remnic/plugin-openclaw");
      return import(specifier);
    },
    runNpmInstall: (args) => {
      const prefixIndex = args.indexOf("--prefix");
      assert.notEqual(prefixIndex, -1);
      temporaryRoot = args[prefixIndex + 1];
      assert.ok(temporaryRoot);
      assert.deepEqual(args.slice(0, 2), ["install", "--ignore-scripts"]);
      assert.ok(args.includes("@remnic/plugin-openclaw@9.49.1"));

      writeManagedUpgradeFixture(temporaryRoot);
    },
  });

  assert.equal(actual.REMNIC_OPENCLAW_PLUGIN_ID, "openclaw-remnic");
  assert.equal(importedSpecifiers.length, 2);
  assert.ok(temporaryRoot);
  assert.equal(fs.existsSync(temporaryRoot), false);
});

test("managed upgrade loader replaces an installed adapter without the managed upgrade export", async () => {
  let temporaryRoot: string | undefined;

  const actual = await loadOpenclawManagedUpgradeModule("@remnic/plugin-openclaw@9.49.1", {
    importModule: async (specifier) => {
      if (specifier === MANAGED_UPGRADE_SPECIFIER) throw missingSubpathError();
      return import(specifier);
    },
    runNpmInstall: (args) => {
      const prefixIndex = args.indexOf("--prefix");
      temporaryRoot = args[prefixIndex + 1];
      assert.ok(temporaryRoot);
      assert.ok(args.includes("@remnic/plugin-openclaw@9.49.1"));
      writeManagedUpgradeFixture(temporaryRoot);
    },
  });

  assert.equal(actual.REMNIC_OPENCLAW_PLUGIN_ID, "openclaw-remnic");
  assert.ok(temporaryRoot);
  assert.equal(fs.existsSync(temporaryRoot), false);
});

test("managed upgrade loader removes its temporary project when npm fails", async () => {
  let temporaryRoot: string | undefined;

  await assert.rejects(
    loadOpenclawManagedUpgradeModule("@remnic/plugin-openclaw@9.49.1", {
      importModule: async () => {
        throw missingModuleError("@remnic/plugin-openclaw");
      },
      runNpmInstall: (args) => {
        temporaryRoot = args[args.indexOf("--prefix") + 1];
        throw new Error("npm install failed");
      },
    }),
    /npm install failed/
  );

  assert.ok(temporaryRoot);
  assert.equal(fs.existsSync(temporaryRoot), false);
});

test("managed upgrade loader removes its temporary project when resolver import fails", async () => {
  let temporaryRoot: string | undefined;

  await assert.rejects(
    loadOpenclawManagedUpgradeModule("@remnic/plugin-openclaw@9.49.1", {
      importModule: async (specifier) => {
        if (specifier === MANAGED_UPGRADE_SPECIFIER) {
          throw missingModuleError("@remnic/plugin-openclaw");
        }
        throw new Error("resolver import failed");
      },
      runNpmInstall: (args) => {
        temporaryRoot = args[args.indexOf("--prefix") + 1];
        assert.ok(temporaryRoot);
        writeManagedUpgradeFixture(temporaryRoot);
      },
    }),
    /resolver import failed/
  );

  assert.ok(temporaryRoot);
  assert.equal(fs.existsSync(temporaryRoot), false);
});

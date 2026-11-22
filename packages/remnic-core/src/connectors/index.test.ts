import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  coerceInstallExtension,
  installCodexMemoryExtension,
  installConnector,
  loadRegistry,
  locatePluginCodexExtensionSource,
  removeConnector,
  resolveCodexMemoryExtensionPaths,
} from "./index.js";
import { loadTokenStore } from "../tokens.js";

function makeSandbox(t: { after: (fn: () => void | Promise<void>) => void }): {
  root: string;
  home: string;
  xdgConfigHome: string;
  codexHome: string;
  syntheticSourceDir: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-connectors-test-"));
  const home = path.join(root, "home");
  const xdgConfigHome = path.join(home, ".config");
  const codexHome = path.join(root, "codex-home");
  const syntheticSourceDir = path.join(root, "synthetic-extension-source");

  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdgConfigHome, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(syntheticSourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(syntheticSourceDir, "instructions.md"),
    "# synthetic test extension\n",
  );

  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  return { root, home, xdgConfigHome, codexHome, syntheticSourceDir };
}

async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await fn();
  } finally {
    for (const key of Object.keys(originals)) {
      const value = originals[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("removeConnector rejects path-like connector IDs before building config paths", async (t) => {
  const sandbox = makeSandbox(t);
  const outsidePath = path.join(sandbox.root, "outside.json");
  fs.writeFileSync(outsidePath, "must survive\n");

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
    },
    () => {
      const result = removeConnector(`../../${path.basename(outsidePath, ".json")}`);

      assert.equal(result.status, "skipped");
      assert.equal(result.reason, "invalid-connector-id");
      assert.equal(fs.readFileSync(outsidePath, "utf8"), "must survive\n");
    },
  );
});

test("installConnector rejects path-like connector IDs before building config paths", async (t) => {
  const sandbox = makeSandbox(t);
  const outsidePath = path.join(sandbox.root, "outside.json");
  fs.writeFileSync(outsidePath, "must survive\n");

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
    },
    () => {
      const result = installConnector({
        connectorId: `../../${path.basename(outsidePath, ".json")}`,
      });

      assert.equal(result.status, "error");
      assert.match(result.message, /Invalid connector ID/);
      assert.equal(fs.readFileSync(outsidePath, "utf8"), "must survive\n");
    },
  );
});

test("loadRegistry does not overwrite malformed registry.json", async (t) => {
  const sandbox = makeSandbox(t);

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
    },
    () => {
      const regDir = path.join(sandbox.xdgConfigHome, "engram", ".engram-connectors");
      fs.mkdirSync(regDir, { recursive: true });
      const regPath = path.join(regDir, "registry.json");
      const malformed = "{ invalid registry json\n";
      fs.writeFileSync(regPath, malformed);

      const registry = loadRegistry();

      assert.ok(registry.connectors.some((connector) => connector.id === "codex-cli"));
      assert.equal(fs.readFileSync(regPath, "utf8"), malformed);
    },
  );
});

test("BUILTIN catalog includes the omp (oh-my-pi) connector", async (t) => {
  const sandbox = makeSandbox(t);

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
    },
    () => {
      const registry = loadRegistry();
      const omp = registry.connectors.find((connector) => connector.id === "omp");

      assert.ok(omp, "omp connector should be present in the built-in catalog");
      assert.equal(omp?.requiresToken, true);
      assert.match(omp?.homepage ?? "", /omp\.sh/);
    },
  );
});

test("BUILTIN catalog includes the prime-agent connector", async (t) => {
  const sandbox = makeSandbox(t);

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
    },
    () => {
      const registry = loadRegistry();
      const primeAgent = registry.connectors.find((connector) => connector.id === "prime-agent");

      assert.ok(primeAgent, "prime-agent connector should be present in the built-in catalog");
      assert.equal(primeAgent?.requiresToken, true);
      assert.equal(primeAgent?.capabilities?.connectionType, "http");
      assert.ok(
        (primeAgent?.tags ?? []).includes("official"),
        "prime-agent should be tagged official",
      );
    },
  );
});

test("loadRegistry filters custom connectors with invalid IDs", async (t) => {
  const sandbox = makeSandbox(t);

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
    },
    () => {
      const regDir = path.join(sandbox.xdgConfigHome, "engram", ".engram-connectors");
      fs.mkdirSync(regDir, { recursive: true });
      const regPath = path.join(regDir, "registry.json");
      fs.writeFileSync(
        regPath,
        JSON.stringify(
          {
            connectors: [
              {
                id: "custom-agent",
                name: "Custom Agent",
                version: "1.0.0",
                description: "valid custom connector",
                capabilities: {
                  observe: false,
                  recall: true,
                  store: false,
                  search: false,
                  entities: false,
                  realtimeSync: false,
                  batch: false,
                  connectionType: "http",
                },
              },
              {
                id: "../../outside",
                name: "Path Escape",
                version: "1.0.0",
                description: "invalid custom connector",
                capabilities: {
                  observe: false,
                  recall: true,
                  store: false,
                  search: false,
                  entities: false,
                  realtimeSync: false,
                  batch: false,
                  connectionType: "http",
                },
              },
            ],
          },
          null,
          2,
        ),
      );

      const registry = loadRegistry();

      assert.ok(registry.connectors.some((connector) => connector.id === "custom-agent"));
      assert.equal(
        registry.connectors.some((connector) => connector.id === "../../outside"),
        false,
      );
    },
  );
});

test("installConnector persists resolved codexHome from $CODEX_HOME", async (t) => {
  const sandbox = makeSandbox(t);

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      CODEX_HOME: sandbox.codexHome,
    },
    () => {
      const result = installConnector({
        connectorId: "codex-cli",
        config: { installExtension: false },
      });

      assert.equal(result.status, "installed");
      assert.ok(result.configPath, "configPath should be set");

      const savedRaw = fs.readFileSync(result.configPath as string, "utf8");
      const saved = JSON.parse(savedRaw) as Record<string, unknown>;
      assert.equal(
        saved.codexHome,
        sandbox.codexHome,
        "installConnector must persist the resolved $CODEX_HOME into saved config",
      );
    },
  );
});

test(
  "removeConnector targets persisted codexHome even when $CODEX_HOME is cleared",
  async (t) => {
    const sandbox = makeSandbox(t);

    await withEnv(
      {
        HOME: sandbox.home,
        USERPROFILE: sandbox.home,
        XDG_CONFIG_HOME: sandbox.xdgConfigHome,
        CODEX_HOME: sandbox.codexHome,
      },
      () => {
        const installResult = installConnector({
          connectorId: "codex-cli",
          config: {
            installExtension: true,
            extensionSourceDir: sandbox.syntheticSourceDir,
          },
        });
        assert.equal(installResult.status, "installed");

        const installedPaths = resolveCodexMemoryExtensionPaths(sandbox.codexHome);
        assert.ok(
          fs.existsSync(installedPaths.remnicExtensionDir),
          "extension should exist in sandbox codexHome after install",
        );
      },
    );

    const alternateHome = path.join(sandbox.root, "alternate-home");
    fs.mkdirSync(alternateHome, { recursive: true });

    await withEnv(
      {
        HOME: sandbox.home, // keep HOME stable so connectorsDir is found
        USERPROFILE: sandbox.home,
        XDG_CONFIG_HOME: sandbox.xdgConfigHome,
        CODEX_HOME: undefined, // cleared
      },
      () => {
        const installedPaths = resolveCodexMemoryExtensionPaths(sandbox.codexHome);
        assert.ok(
          fs.existsSync(installedPaths.remnicExtensionDir),
          "sanity: extension still present before removeConnector",
        );

        const removeResult = removeConnector("codex-cli");
        assert.match(
          removeResult.message,
          /memory extension removed/,
          "remove should report the memory extension was removed",
        );

        assert.equal(
          fs.existsSync(installedPaths.remnicExtensionDir),
          false,
          "removeConnector must remove the extension from the original codexHome even after $CODEX_HOME is cleared",
        );
      },
    );
  },
);

test(
  "installCodexMemoryExtension removes pre-existing .remnic.tmp-* directories",
  async (t) => {
    const sandbox = makeSandbox(t);

    await withEnv(
      {
        HOME: sandbox.home,
        USERPROFILE: sandbox.home,
        XDG_CONFIG_HOME: sandbox.xdgConfigHome,
        CODEX_HOME: sandbox.codexHome,
      },
      () => {
        const paths = resolveCodexMemoryExtensionPaths(sandbox.codexHome);
        fs.mkdirSync(paths.extensionsRoot, { recursive: true });

        const stale1 = path.join(paths.extensionsRoot, ".remnic.tmp-99999-1111111111111");
        const stale2 = path.join(paths.extensionsRoot, ".remnic.tmp-88888-2222222222222");
        const stale3 = path.join(paths.extensionsRoot, ".remnic.tmp-77777-3333333333333");
        const staleTime = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
        for (const staleDir of [stale1, stale2, stale3]) {
          fs.mkdirSync(staleDir, { recursive: true });
          fs.writeFileSync(path.join(staleDir, "leftover.txt"), "stale\n");
          fs.utimesSync(staleDir, staleTime, staleTime);
        }

        const unrelated = path.join(paths.extensionsRoot, "some-other-vendor");
        fs.mkdirSync(unrelated, { recursive: true });
        fs.writeFileSync(path.join(unrelated, "keep.txt"), "keep me\n");

        const result = installCodexMemoryExtension({
          codexHome: sandbox.codexHome,
          sourceDir: sandbox.syntheticSourceDir,
        });

        for (const staleDir of [stale1, stale2, stale3]) {
          assert.equal(
            fs.existsSync(staleDir),
            false,
            `stale tmp ${path.basename(staleDir)} must be removed by prefix scan`,
          );
        }

        assert.ok(
          fs.existsSync(path.join(unrelated, "keep.txt")),
          "adjacent unrelated extension must NOT be touched",
        );

        assert.ok(fs.existsSync(result.remnicExtensionDir));
        assert.ok(fs.existsSync(result.instructionsPath));
      },
    );
  },
);


test("coerceInstallExtension — boolean passthrough", () => {
  assert.equal(coerceInstallExtension(true), true);
  assert.equal(coerceInstallExtension(false), false);
});

test("coerceInstallExtension — string false variants", () => {
  for (const v of ["false", "FALSE", "False", "0", "no", "NO", "off", "OFF"]) {
    assert.equal(coerceInstallExtension(v), false, `expected false for "${v}"`);
  }
});

test("coerceInstallExtension — string true variants", () => {
  for (const v of ["true", "TRUE", "True", "1", "yes", "YES", "on", "ON"]) {
    assert.equal(coerceInstallExtension(v), true, `expected true for "${v}"`);
  }
});

test("coerceInstallExtension — unknown values return undefined", () => {
  assert.equal(coerceInstallExtension(undefined), undefined);
  assert.equal(coerceInstallExtension(null), undefined);
  assert.equal(coerceInstallExtension("maybe"), undefined);
  assert.equal(coerceInstallExtension(2), undefined);
});


test('installConnector codex-cli with installExtension="false" string skips extension', async (t) => {
  const sandbox = makeSandbox(t);

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      CODEX_HOME: sandbox.codexHome,
    },
    () => {
      const result = installConnector({
        connectorId: "codex-cli",
        config: { installExtension: "false" }, // string, not boolean
      });

      assert.equal(result.status, "installed");
      assert.ok(result.message.includes("skipped"), `message should mention skipped, got: ${result.message}`);

      const paths = resolveCodexMemoryExtensionPaths(sandbox.codexHome);
      assert.equal(
        fs.existsSync(paths.remnicExtensionDir),
        false,
        "extension dir must not exist when installExtension=false (string)",
      );

      const saved = JSON.parse(fs.readFileSync(result.configPath as string, "utf8")) as Record<string, unknown>;
      assert.equal(saved.installExtension, false, "saved installExtension must be boolean false");
    },
  );
});


test('installConnector codex-cli with installExtension="true" string installs extension', async (t) => {
  const sandbox = makeSandbox(t);

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      CODEX_HOME: sandbox.codexHome,
    },
    () => {
      const result = installConnector({
        connectorId: "codex-cli",
        config: {
          installExtension: "true", // string, not boolean
          extensionSourceDir: sandbox.syntheticSourceDir,
        },
      });

      assert.equal(result.status, "installed");

      const paths = resolveCodexMemoryExtensionPaths(sandbox.codexHome);
      assert.ok(
        fs.existsSync(paths.remnicExtensionDir),
        "extension dir must exist when installExtension=true (string)",
      );

      const saved = JSON.parse(fs.readFileSync(result.configPath as string, "utf8")) as Record<string, unknown>;
      assert.equal(saved.installExtension, true, "saved installExtension must be boolean true");
    },
  );
});


test("installConnector codex-cli with installExtension=true (boolean) installs extension", async (t) => {
  const sandbox = makeSandbox(t);

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      CODEX_HOME: sandbox.codexHome,
    },
    () => {
      const result = installConnector({
        connectorId: "codex-cli",
        config: {
          installExtension: true,
          extensionSourceDir: sandbox.syntheticSourceDir,
        },
      });

      assert.equal(result.status, "installed");
      const paths = resolveCodexMemoryExtensionPaths(sandbox.codexHome);
      assert.ok(fs.existsSync(paths.remnicExtensionDir), "extension must be installed");
    },
  );
});


test("locatePluginCodexExtensionSource finds extension via synthetic node_modules tree", async (t) => {
  const sandbox = makeSandbox(t);

  const fakePluginRoot = path.join(
    sandbox.root,
    "fake-node-modules",
    "node_modules",
    "@remnic",
    "plugin-codex",
  );
  const fakeExtDir = path.join(fakePluginRoot, "memories_extensions", "remnic");
  fs.mkdirSync(fakeExtDir, { recursive: true });
  fs.writeFileSync(path.join(fakePluginRoot, "package.json"), JSON.stringify({ name: "@remnic/plugin-codex", version: "0.0.1", main: "index.js" }));
  fs.writeFileSync(path.join(fakeExtDir, "instructions.md"), "# fake extension\n");

  const result = installCodexMemoryExtension({
    codexHome: sandbox.codexHome,
    sourceDir: fakeExtDir,
  });

  assert.ok(fs.existsSync(result.remnicExtensionDir), "extension must be installed from synthetic path");
  assert.ok(fs.existsSync(result.instructionsPath), "instructions.md must be present");
  assert.equal(result.filesCopied, 1);
});


test("removeConnector skips extension deletion when installExtension=false", async (t) => {
  const sandbox = makeSandbox(t);

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      CODEX_HOME: sandbox.codexHome,
    },
    () => {
      const installResult = installConnector({
        connectorId: "codex-cli",
        config: { installExtension: false },
      });
      assert.equal(installResult.status, "installed");

      const paths = resolveCodexMemoryExtensionPaths(sandbox.codexHome);
      fs.mkdirSync(paths.remnicExtensionDir, { recursive: true });
      fs.writeFileSync(path.join(paths.remnicExtensionDir, "instructions.md"), "user managed\n");

      const removeResult = removeConnector("codex-cli");
      assert.ok(
        removeResult.message.includes("skipped"),
        `message should mention skipped, got: ${removeResult.message}`,
      );

      assert.ok(
        fs.existsSync(paths.remnicExtensionDir),
        "extension dir must survive when installExtension=false",
      );
    },
  );
});


test("removeConnector preserves config file when extension removal throws", async (t) => {
  const sandbox = makeSandbox(t);

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      CODEX_HOME: sandbox.codexHome,
    },
    () => {
      const installResult = installConnector({
        connectorId: "codex-cli",
        config: {
          installExtension: true,
          extensionSourceDir: sandbox.syntheticSourceDir,
        },
      });
      assert.equal(installResult.status, "installed");

      const configPath = installResult.configPath as string;
      assert.ok(fs.existsSync(configPath), "config must exist after install");

      const paths = resolveCodexMemoryExtensionPaths(sandbox.codexHome);
      fs.rmSync(paths.remnicExtensionDir, { recursive: true, force: true });
      const removeResult = removeConnector("codex-cli");
      assert.ok(
        removeResult.message.includes("Removed"),
        `message should indicate Removed, got: ${removeResult.message}`,
      );
      assert.equal(
        fs.existsSync(configPath),
        false,
        "config must be deleted after successful extension removal (even if ext was already gone)",
      );
    },
  );
});


test("installConnector persists resolved $CODEX_HOME even without explicit codexHome config key", async (t) => {
  const sandbox = makeSandbox(t);

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      CODEX_HOME: sandbox.codexHome, // set via env only, NOT via config key
    },
    () => {
      const result = installConnector({
        connectorId: "codex-cli",
        config: { installExtension: false },
      });

      assert.equal(result.status, "installed");

      const saved = JSON.parse(fs.readFileSync(result.configPath as string, "utf8")) as Record<string, unknown>;
      assert.equal(
        saved.codexHome,
        sandbox.codexHome,
        "resolved $CODEX_HOME must be persisted even when not passed via config key",
      );
    },
  );

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      CODEX_HOME: undefined, // cleared
    },
    () => {
      const removeResult = removeConnector("codex-cli");
      assert.ok(
        removeResult.message.includes("Removed"),
        `remove should succeed, got: ${removeResult.message}`,
      );
    },
  );
});


test("removeConnector returns status:skipped reason:config-parse-failed when codex-cli.json is malformed", async (t) => {
  const sandbox = makeSandbox(t);

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      CODEX_HOME: sandbox.codexHome,
    },
    () => {
      const installResult = installConnector({
        connectorId: "codex-cli",
        config: { installExtension: false },
      });
      assert.equal(installResult.status, "installed");

      const configPath = installResult.configPath as string;
      assert.ok(fs.existsSync(configPath), "precondition: config file must exist after install");

      fs.writeFileSync(configPath, "{ this is not valid JSON !!!");

      const removeResult = removeConnector("codex-cli");

      assert.equal(
        removeResult.status,
        "skipped",
        "removeConnector must return status:'skipped' when codex-cli.json is malformed",
      );
      assert.equal(
        removeResult.reason,
        "config-parse-failed",
        "removeConnector must return reason:'config-parse-failed' when config cannot be parsed",
      );

      assert.ok(
        fs.existsSync(configPath),
        "malformed config file must be left in place for operator inspection",
      );
    },
  );
});


test("removeConnector with missing config does not remove a self-managed extension", async (t) => {
  const sandbox = makeSandbox(t);

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      CODEX_HOME: sandbox.codexHome,
    },
    () => {
      const paths = resolveCodexMemoryExtensionPaths(sandbox.codexHome);
      fs.mkdirSync(paths.remnicExtensionDir, { recursive: true });
      fs.writeFileSync(
        path.join(paths.remnicExtensionDir, "instructions.md"),
        "# user-managed extension\n",
      );

      const connectorsDir = path.join(sandbox.xdgConfigHome, "engram", ".engram-connectors", "connectors");
      const configPath = path.join(connectorsDir, "codex-cli.json");
      assert.equal(fs.existsSync(configPath), false, "precondition: config must be absent");

      const removeResult = removeConnector("codex-cli");
      assert.equal(removeResult.message, "Not installed", `expected 'Not installed', got: ${removeResult.message}`);

      assert.ok(
        fs.existsSync(paths.remnicExtensionDir),
        "self-managed extension must NOT be removed when config file is missing",
      );
    },
  );
});


test("installCodexMemoryExtension restores backup when final rename fails", async (t) => {
  const sandbox = makeSandbox(t);

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      CODEX_HOME: sandbox.codexHome,
    },
    () => {
      const first = installCodexMemoryExtension({
        codexHome: sandbox.codexHome,
        sourceDir: sandbox.syntheticSourceDir,
      });
      assert.ok(fs.existsSync(first.remnicExtensionDir), "first install must succeed");

      const originalContent = fs.readFileSync(
        path.join(first.remnicExtensionDir, "instructions.md"),
        "utf8",
      );

      const secondSource = path.join(sandbox.root, "second-extension-source");
      fs.mkdirSync(secondSource, { recursive: true });
      fs.writeFileSync(path.join(secondSource, "instructions.md"), "# second version\n");

      const originalRenameSync = fs.renameSync.bind(fs);
      let renameCallCount = 0;
      const mockRename = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
        renameCallCount++;
        if (renameCallCount === 2) {
          throw new Error("EACCES: permission denied (simulated)");
        }
        return originalRenameSync(...args);
      });

      assert.throws(
        () =>
          installCodexMemoryExtension({
            codexHome: sandbox.codexHome,
            sourceDir: secondSource,
          }),
        /EACCES|simulated/,
        "install must throw when final rename fails",
      );

      mockRename.mock.restore();

      assert.ok(
        fs.existsSync(first.remnicExtensionDir),
        "old extension must be restored after failed rename",
      );
      const restoredContent = fs.readFileSync(
        path.join(first.remnicExtensionDir, "instructions.md"),
        "utf8",
      );
      assert.equal(restoredContent, originalContent, "restored extension must match original content");

      const extRoot = path.dirname(first.remnicExtensionDir);
      const entries = fs.readdirSync(extRoot);
      const bakEntries = entries.filter((e) => e.includes(".bak-"));
      assert.equal(bakEntries.length, 0, `no .bak-* dirs should remain, found: ${bakEntries.join(", ")}`);
    },
  );
});


test("installConnector surfaces status:error when memory extension install throws", async (t) => {
  const sandbox = makeSandbox(t);

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      CODEX_HOME: sandbox.codexHome,
    },
    () => {
      const result = installConnector({
        connectorId: "codex-cli",
        config: {
          installExtension: true,
          extensionSourceDir: path.join(sandbox.root, "does-not-exist"),
        },
      });

      assert.equal(
        result.status,
        "error",
        `expected status "error" when extension install fails, got: ${result.status}`,
      );
      assert.ok(
        result.message.toLowerCase().includes("failed") || result.message.toLowerCase().includes("error"),
        `message should mention failure, got: ${result.message}`,
      );
      assert.equal(
        result.configPath,
        undefined,
        "configPath must not be set when install fails",
      );
    },
  );
});


test("installCodexMemoryExtension atomic replace happy path — no backup directory left behind", async (t) => {
  const sandbox = makeSandbox(t);

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      CODEX_HOME: sandbox.codexHome,
    },
    () => {
      installCodexMemoryExtension({
        codexHome: sandbox.codexHome,
        sourceDir: sandbox.syntheticSourceDir,
      });

      const secondSource = path.join(sandbox.root, "second-ext-source");
      fs.mkdirSync(secondSource, { recursive: true });
      fs.writeFileSync(path.join(secondSource, "instructions.md"), "# v2 extension\n");

      const second = installCodexMemoryExtension({
        codexHome: sandbox.codexHome,
        sourceDir: secondSource,
      });

      assert.ok(fs.existsSync(second.remnicExtensionDir), "extension dir must exist after replace");
      const content = fs.readFileSync(path.join(second.remnicExtensionDir, "instructions.md"), "utf8");
      assert.equal(content, "# v2 extension\n", "extension content must reflect second install");

      second.commit();

      const extRoot = path.dirname(second.remnicExtensionDir);
      const entries = fs.readdirSync(extRoot);
      const bakEntries = entries.filter((e) => e.includes(".bak-"));
      assert.equal(bakEntries.length, 0, `no .bak-* dirs should remain after commit(), found: ${bakEntries.join(", ")}`);
    },
  );
});


test("removeConnector with corrupt codex-cli.json does NOT remove extension", async (t) => {
  const sandbox = makeSandbox(t);

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      CODEX_HOME: sandbox.codexHome,
    },
    () => {
      const connectorsDir = path.join(sandbox.xdgConfigHome, "engram", ".engram-connectors", "connectors");
      fs.mkdirSync(connectorsDir, { recursive: true });
      const configPath = path.join(connectorsDir, "codex-cli.json");
      fs.writeFileSync(configPath, "{ this is not valid json !!! }");

      const paths = resolveCodexMemoryExtensionPaths(sandbox.codexHome);
      fs.mkdirSync(paths.remnicExtensionDir, { recursive: true });
      fs.writeFileSync(
        path.join(paths.remnicExtensionDir, "instructions.md"),
        "# user-managed extension\n",
      );

      const removeResult = removeConnector("codex-cli");

      assert.equal(
        removeResult.status,
        "skipped",
        `expected status "skipped", got: ${removeResult.status} — ${removeResult.message}`,
      );
      assert.equal(
        removeResult.reason,
        "config-parse-failed",
        `expected reason "config-parse-failed", got: ${removeResult.reason}`,
      );

      assert.ok(
        fs.existsSync(paths.remnicExtensionDir),
        "extension must survive when config parsing fails",
      );

      assert.ok(
        fs.existsSync(configPath),
        "malformed config file must NOT be deleted — operator needs it for inspection/retry",
      );
    },
  );
});


test("installCodexMemoryExtension does NOT remove fresh .remnic.tmp-* dirs (concurrent install guard)", async (t) => {
  const sandbox = makeSandbox(t);

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      CODEX_HOME: sandbox.codexHome,
    },
    () => {
      const paths = resolveCodexMemoryExtensionPaths(sandbox.codexHome);
      fs.mkdirSync(paths.extensionsRoot, { recursive: true });

      const freshTmp = path.join(paths.extensionsRoot, `.remnic.tmp-12345-${Date.now()}`);
      fs.mkdirSync(freshTmp, { recursive: true });
      fs.writeFileSync(path.join(freshTmp, "in-progress.txt"), "in-progress\n");

      installCodexMemoryExtension({
        codexHome: sandbox.codexHome,
        sourceDir: sandbox.syntheticSourceDir,
      });

      assert.ok(
        fs.existsSync(freshTmp),
        "fresh .remnic.tmp-* dir must NOT be deleted by the pre-install cleanup sweep",
      );
    },
  );
});


test("removeConnector with legacy config (no installExtension key) skips extension removal", async (t) => {
  const sandbox = makeSandbox(t);

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      CODEX_HOME: sandbox.codexHome,
    },
    () => {
      const connectorsDir = path.join(sandbox.xdgConfigHome, "engram", ".engram-connectors", "connectors");
      fs.mkdirSync(connectorsDir, { recursive: true });
      const configPath = path.join(connectorsDir, "codex-cli.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({ connectorId: "codex-cli", installedAt: "2024-01-01T00:00:00Z" }, null, 2),
      );

      const paths = resolveCodexMemoryExtensionPaths(sandbox.codexHome);
      fs.mkdirSync(paths.remnicExtensionDir, { recursive: true });
      fs.writeFileSync(
        path.join(paths.remnicExtensionDir, "instructions.md"),
        "# user-managed legacy extension\n",
      );

      const removeResult = removeConnector("codex-cli");

      assert.ok(
        removeResult.message.includes("Removed"),
        `expected Removed, got: ${removeResult.message}`,
      );
      assert.ok(
        removeResult.message.includes("provenance") || removeResult.message.includes("skipped"),
        `message should indicate removal was skipped due to missing provenance, got: ${removeResult.message}`,
      );

      assert.ok(
        fs.existsSync(paths.remnicExtensionDir),
        "user-managed extension must survive when saved config has no install provenance",
      );
    },
  );
});

//

test("coerceInstallExtension parity — all representative inputs match expected coercion", () => {
  const testCases: Array<[unknown, boolean | undefined]> = [
    ["false", false],
    ["FALSE", false],
    ["0", false],
    ["no", false],
    ["off", false],
    ["true", true],
    ["TRUE", true],
    ["1", true],
    ["yes", true],
    ["on", true],
    [false, false],
    [true, true],
    [undefined, undefined],
    [null, undefined],
    ["maybe", undefined],
    [2, undefined],
  ];

  for (const [input, expected] of testCases) {
    assert.equal(
      coerceInstallExtension(input),
      expected,
      `coerceInstallExtension(${JSON.stringify(input)}) should be ${String(expected)}`,
    );
  }
});


test("installConnector does NOT persist extensionSourceDir to saved config", async (t) => {
  const sandbox = makeSandbox(t);

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      CODEX_HOME: sandbox.codexHome,
    },
    () => {
      const result = installConnector({
        connectorId: "codex-cli",
        config: {
          installExtension: true,
          extensionSourceDir: sandbox.syntheticSourceDir, // test-only key
        },
      });

      assert.equal(result.status, "installed");
      assert.ok(result.configPath, "configPath should be set");

      const saved = JSON.parse(fs.readFileSync(result.configPath as string, "utf8")) as Record<string, unknown>;

      assert.equal(
        "extensionSourceDir" in saved,
        false,
        `extensionSourceDir must NOT appear in the persisted config, found: ${JSON.stringify(saved)}`,
      );
    },
  );
});

//

test(
  "locatePluginCodexExtensionSource finds bundled payload at dist/connectors/codex layout (PRRT_kwDORJXyws56UHNp)",
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-dist-layout-test-"));
    t.after(() => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // best effort
      }
    });

    const distDir = path.join(root, "dist");
    const distConnectorsCodexDir = path.join(distDir, "connectors", "codex");
    const distConnectorsCodexResourcesDir = path.join(distConnectorsCodexDir, "resources");
    fs.mkdirSync(distConnectorsCodexResourcesDir, { recursive: true });
    fs.writeFileSync(path.join(distConnectorsCodexDir, "instructions.md"), "# bundled codex extension\n");
    fs.writeFileSync(
      path.join(distConnectorsCodexResourcesDir, "namespace-cheatsheet.md"),
      "# cheatsheet\n",
    );

    //
    const result = locatePluginCodexExtensionSource(distConnectorsCodexDir);

    assert.equal(result, distConnectorsCodexDir, "must return the dist/connectors/codex path when passed as override");
    assert.ok(
      fs.existsSync(path.join(result, "instructions.md")),
      "instructions.md must exist in the resolved path",
    );

    const codexHome = path.join(root, "codex-home");
    fs.mkdirSync(codexHome, { recursive: true });
    const installResult = installCodexMemoryExtension({
      codexHome,
      sourceDir: distConnectorsCodexDir,
    });

    assert.ok(
      fs.existsSync(installResult.remnicExtensionDir),
      "extension must be installed from dist/connectors/codex layout",
    );
    assert.ok(
      fs.existsSync(installResult.instructionsPath),
      "instructions.md must be present after install",
    );
    assert.equal(installResult.filesCopied, 2, "both payload files must be copied");
  },
);

//

test(
  "installConnector rollback restores pre-existing extension when config write fails (PRRT_kwDORJXyws56UJlk)",
  async (t) => {
    const sandbox = makeSandbox(t);

    await withEnv(
      {
        HOME: sandbox.home,
        USERPROFILE: sandbox.home,
        XDG_CONFIG_HOME: sandbox.xdgConfigHome,
        CODEX_HOME: sandbox.codexHome,
      },
      () => {
        const paths = resolveCodexMemoryExtensionPaths(sandbox.codexHome);
        fs.mkdirSync(paths.remnicExtensionDir, { recursive: true });
        fs.writeFileSync(
          path.join(paths.remnicExtensionDir, "custom-marker.txt"),
          "user-customised extension — must survive a failed install rollback\n",
        );

        const connectorsDir = path.join(sandbox.xdgConfigHome, "engram", ".engram-connectors", "connectors");
        fs.mkdirSync(connectorsDir, { recursive: true });
        const configPath = path.join(connectorsDir, "codex-cli.json");

        const originalRenameSync = fs.renameSync.bind(fs);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mock = t.mock.method(fs, "renameSync", (...args: [any, any]) => {
          if (String(args[1]) === configPath) {
            throw new Error("ENOSPC: no space left on device (simulated)");
          }
          return originalRenameSync(...args);
        });

        const result = installConnector({
          connectorId: "codex-cli",
          config: {
            installExtension: true,
            extensionSourceDir: sandbox.syntheticSourceDir,
          },
        });

        mock.mock.restore();

        assert.equal(
          result.status,
          "error",
          `expected status "error" when config write fails, got: "${result.status}"`,
        );

        assert.ok(
          fs.existsSync(paths.remnicExtensionDir),
          "memories_extensions/remnic must still exist after failed install rollback",
        );
        assert.ok(
          fs.existsSync(path.join(paths.remnicExtensionDir, "custom-marker.txt")),
          "custom-marker.txt must survive: pre-existing extension must be restored on rollback, not deleted",
        );

        assert.equal(
          fs.existsSync(configPath),
          false,
          "codex-cli.json must NOT exist after a failed install",
        );
      },
    );
  },
);

//

test(
  "installConnector writes a remnic_cx_ token entry for codex-cli and keeps connector config token-free",
  async (t) => {
    const sandbox = makeSandbox(t);

    await withEnv(
      {
        HOME: sandbox.home,
        USERPROFILE: sandbox.home,
        XDG_CONFIG_HOME: sandbox.xdgConfigHome,
        CODEX_HOME: sandbox.codexHome,
      },
      () => {
        const result = installConnector({
          connectorId: "codex-cli",
          config: { installExtension: false },
        });

        assert.equal(result.status, "installed", `expected status "installed", got: "${result.status}"`);

        const store = loadTokenStore();
        const codexEntry = store.tokens.find((e) => e.connector === "codex-cli");
        assert.ok(
          codexEntry,
          "tokens.json must contain a token entry for codex-cli after install",
        );
        assert.ok(
          codexEntry!.token.startsWith("remnic_cx_"),
          `codex-cli token must start with \"remnic_cx_\", got: \"${codexEntry!.token.slice(0, 20)}...\"`,
        );

        assert.ok(result.configPath, "configPath should be set");
        const saved = JSON.parse(fs.readFileSync(result.configPath as string, "utf8")) as Record<string, unknown>;
        assert.equal(
          "token" in saved,
          false,
          "codex-cli connector.json must NOT contain a 'token' field",
        );
      },
    );
  },
);

test(
  "installConnector does NOT write a token entry for cursor connector (embedded, no token auth)",
  async (t) => {
    const sandbox = makeSandbox(t);

    await withEnv(
      {
        HOME: sandbox.home,
        USERPROFILE: sandbox.home,
        XDG_CONFIG_HOME: sandbox.xdgConfigHome,
        CODEX_HOME: sandbox.codexHome,
      },
      () => {
        const result = installConnector({ connectorId: "cursor" });

        assert.equal(result.status, "installed", `expected status "installed", got: "${result.status}"`);

        const store = loadTokenStore();
        const cursorEntry = store.tokens.find((e) => e.connector === "cursor");
        assert.equal(
          cursorEntry,
          undefined,
          "tokens.json must NOT contain an entry for the cursor connector (embedded transport, no token auth)",
        );

        assert.ok(result.configPath, "configPath should be set");
        const saved = JSON.parse(fs.readFileSync(result.configPath as string, "utf8")) as Record<string, unknown>;
        assert.equal(
          "token" in saved,
          false,
          "cursor connector.json must NOT contain a 'token' field",
        );
      },
    );
  },
);

//

test(
  "installConnector writes a remnic_cc_ token entry for claude-code connector (PRRT_kwDORJXyws56VJRa P1 regression)",
  async (t) => {
    const sandbox = makeSandbox(t);

    await withEnv(
      {
        HOME: sandbox.home,
        USERPROFILE: sandbox.home,
        XDG_CONFIG_HOME: sandbox.xdgConfigHome,
        CODEX_HOME: sandbox.codexHome,
      },
      () => {
        const result = installConnector({ connectorId: "claude-code" });

        assert.equal(result.status, "installed", `expected status "installed", got: "${result.status}"`);

        const store = loadTokenStore();
        const ccEntry = store.tokens.find((e) => e.connector === "claude-code");
        assert.ok(
          ccEntry !== undefined,
          "tokens.json must contain a token entry for claude-code after install",
        );

        assert.ok(
          ccEntry!.token.startsWith("remnic_cc_"),
          `claude-code token must start with "remnic_cc_", got: "${ccEntry!.token.slice(0, 20)}..."`,
        );

        assert.ok(result.configPath, "configPath should be set");
        const saved = JSON.parse(fs.readFileSync(result.configPath as string, "utf8")) as Record<string, unknown>;
        assert.equal(
          "token" in saved,
          false,
          "claude-code connector.json must NOT contain a 'token' field",
        );
      },
    );
  },
);

test("installConnector writes a remnic_pi_ token entry for Pi connector", async (t) => {
  const sandbox = makeSandbox(t);

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
    },
    () => {
      const result = installConnector({ connectorId: "pi" });

      assert.equal(result.status, "installed", `expected status "installed", got: "${result.status}"`);
      const piEntry = loadTokenStore().tokens.find((entry) => entry.connector === "pi");
      assert.ok(piEntry !== undefined, "tokens.json must contain a token entry for pi after install");
      assert.ok(
        piEntry!.token.startsWith("remnic_pi_"),
        `pi token must start with "remnic_pi_", got: "${piEntry!.token.slice(0, 20)}..."`,
      );
    },
  );
});

test("installConnector force reinstall preserves saved Pi connector config", async (t) => {
  const sandbox = makeSandbox(t);

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
    },
    () => {
      const first = installConnector({
        connectorId: "pi",
        config: {
          installExtension: "false",
          namespace: "client-work",
          remnicDaemonUrl: "http://127.0.0.1:9999",
        },
      });
      assert.equal(first.status, "installed");

      const second = installConnector({ connectorId: "pi", force: true });
      assert.equal(second.status, "installed");
      assert.ok(second.configPath, "configPath should be set");
      const saved = JSON.parse(fs.readFileSync(second.configPath as string, "utf8")) as Record<string, unknown>;

      assert.equal(saved.installExtension, "false");
      assert.equal(saved.namespace, "client-work");
      assert.equal(saved.remnicDaemonUrl, "http://127.0.0.1:9999");
      assert.equal(saved.connectorId, "pi");
    },
  );
});

test("installConnector force reinstall lets explicit blank config clear saved Pi connector keys", async (t) => {
  const sandbox = makeSandbox(t);

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
    },
    () => {
      const first = installConnector({
        connectorId: "pi",
        config: {
          installExtension: "false",
          namespace: "client-work",
          remnicDaemonUrl: "http://127.0.0.1:9999",
        },
      });
      assert.equal(first.status, "installed");

      const second = installConnector({
        connectorId: "pi",
        force: true,
        config: { namespace: "" },
      });
      assert.equal(second.status, "installed");
      assert.ok(second.configPath, "configPath should be set");
      const saved = JSON.parse(fs.readFileSync(second.configPath as string, "utf8")) as Record<string, unknown>;

      assert.equal("namespace" in saved, false);
      assert.equal(saved.installExtension, "false");
      assert.equal(saved.remnicDaemonUrl, "http://127.0.0.1:9999");
      assert.equal(saved.connectorId, "pi");
    },
  );
});

//

test(
  "loadRegistry returns built-in manifest for claude-code even when stale entry lacks requiresToken (PRRT_kwDORJXyws56VRJ4 regression)",
  async (t) => {
    const sandbox = makeSandbox(t);

    await withEnv(
      {
        HOME: sandbox.home,
        USERPROFILE: sandbox.home,
        XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      },
      () => {
        const staleRegistry = {
          connectors: [
            {
              id: "claude-code",
              name: "Claude Code",
              version: "0.9.0",
              description: "Old version without requiresToken",
              capabilities: {
                observe: true,
                recall: true,
                store: true,
                search: true,
                entities: false,
                realtimeSync: false,
                batch: false,
                maxBudgetChars: 8000,
                connectionType: "mcp",
              },
              configSchema: {},
              // requiresToken intentionally absent — simulates stale entry
            },
            {
              id: "replit",
              name: "Replit Agent",
              version: "0.9.0",
              description: "Old version without requiresToken",
              capabilities: {
                observe: true,
                recall: true,
                store: true,
                search: false,
                entities: false,
                realtimeSync: false,
                batch: false,
                maxBudgetChars: 4000,
                connectionType: "http",
              },
              configSchema: {},
              // requiresToken intentionally absent
            },
            {
              id: "my-custom-agent",
              name: "My Custom Agent",
              version: "1.0.0",
              description: "A user-added custom connector that must be preserved",
              capabilities: {
                observe: false,
                recall: true,
                store: false,
                search: false,
                entities: false,
                realtimeSync: false,
                batch: false,
                maxBudgetChars: 4000,
                connectionType: "http",
              },
              configSchema: {},
            },
          ],
        };

        const regDir = path.join(sandbox.xdgConfigHome, "engram", ".engram-connectors");
        fs.mkdirSync(regDir, { recursive: true });
        const regPath = path.join(regDir, "registry.json");
        fs.writeFileSync(regPath, JSON.stringify(staleRegistry, null, 2));

        const registry = loadRegistry();

        const ccManifest = registry.connectors.find((c) => c.id === "claude-code");
        assert.ok(ccManifest !== undefined, "claude-code must be present in loaded registry");
        assert.equal(
          ccManifest!.requiresToken,
          true,
          "claude-code manifest from loadRegistry must have requiresToken: true (not the stale entry)",
        );

        const replitManifest = registry.connectors.find((c) => c.id === "replit");
        assert.ok(replitManifest !== undefined, "replit must be present in loaded registry");
        assert.equal(
          replitManifest!.requiresToken,
          true,
          "replit manifest from loadRegistry must have requiresToken: true (not the stale entry)",
        );

        const customManifest = registry.connectors.find((c) => c.id === "my-custom-agent");
        assert.ok(
          customManifest !== undefined,
          "user-added custom connector (my-custom-agent) must be preserved by loadRegistry",
        );
        assert.equal(
          customManifest!.name,
          "My Custom Agent",
          "custom connector name must be preserved",
        );
      },
    );
  },
);

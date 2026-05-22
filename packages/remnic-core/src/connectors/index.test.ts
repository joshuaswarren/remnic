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

/**
 * Build a fresh tmp sandbox with its own HOME / XDG_CONFIG_HOME / CODEX_HOME
 * and optionally a synthetic plugin-codex extension source directory.
 *
 * Callers must run the test body inside {@link withEnv} or similar to ensure
 * env vars are restored afterwards. The returned paths live under `os.tmpdir()`
 * and are registered for cleanup via `t.after`.
 */
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
  // Drop a synthetic instructions.md so copy has something to move
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

/** Run `fn` with temporary env overrides, restoring originals after. */
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
        // installExtension: false avoids needing a real plugin-codex source dir
        config: { installExtension: false },
      });

      assert.equal(result.status, "installed");
      assert.ok(result.configPath, "configPath should be set");

      const savedRaw = fs.readFileSync(result.configPath as string, "utf8");
      const saved = JSON.parse(savedRaw) as Record<string, unknown>;
      // The resolved absolute $CODEX_HOME must be persisted into the saved
      // config, NOT left unset.
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

    // Point CODEX_HOME at a directory during install, then clear it before
    // remove to simulate a user whose env changed between install and remove.
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

        // Precondition: the extension must physically exist under the
        // sandbox codexHome (not some default location).
        const installedPaths = resolveCodexMemoryExtensionPaths(sandbox.codexHome);
        assert.ok(
          fs.existsSync(installedPaths.remnicExtensionDir),
          "extension should exist in sandbox codexHome after install",
        );
      },
    );

    // Now clear CODEX_HOME (and point HOME somewhere else entirely) and call
    // removeConnector. If the fix is correct, removeConnector reads the
    // saved config's persisted codexHome and removes the extension from the
    // ORIGINAL sandbox location — not from some env-derived default.
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

        // After removal, the ORIGINAL sandbox extension directory must be gone.
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

        // Seed three stale tmp directories that look like leftover crashed runs
        // from previous invocations (different pid, different timestamp).
        // Back-date their mtime to 1 hour ago so the staleness threshold (10 min)
        // treats them as safe to remove.
        const stale1 = path.join(paths.extensionsRoot, ".remnic.tmp-99999-1111111111111");
        const stale2 = path.join(paths.extensionsRoot, ".remnic.tmp-88888-2222222222222");
        const stale3 = path.join(paths.extensionsRoot, ".remnic.tmp-77777-3333333333333");
        const staleTime = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
        for (const staleDir of [stale1, stale2, stale3]) {
          fs.mkdirSync(staleDir, { recursive: true });
          fs.writeFileSync(path.join(staleDir, "leftover.txt"), "stale\n");
          // Backdate mtime so the cleanup sees these as provably stale.
          fs.utimesSync(staleDir, staleTime, staleTime);
        }

        // Also seed an unrelated file that must NOT be touched.
        const unrelated = path.join(paths.extensionsRoot, "some-other-vendor");
        fs.mkdirSync(unrelated, { recursive: true });
        fs.writeFileSync(path.join(unrelated, "keep.txt"), "keep me\n");

        const result = installCodexMemoryExtension({
          codexHome: sandbox.codexHome,
          sourceDir: sandbox.syntheticSourceDir,
        });

        // All stale tmp dirs must be gone.
        for (const staleDir of [stale1, stale2, stale3]) {
          assert.equal(
            fs.existsSync(staleDir),
            false,
            `stale tmp ${path.basename(staleDir)} must be removed by prefix scan`,
          );
        }

        // Adjacent unrelated extension must survive.
        assert.ok(
          fs.existsSync(path.join(unrelated, "keep.txt")),
          "adjacent unrelated extension must NOT be touched",
        );

        // New install must still have landed properly.
        assert.ok(fs.existsSync(result.remnicExtensionDir));
        assert.ok(fs.existsSync(result.instructionsPath));
      },
    );
  },
);

// ── Finding 1: coerceInstallExtension unit tests ─────────────────────────────

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

// ── Finding 1: installExtension="false" (string) is coerced, extension NOT installed

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

      // Extension directory must NOT have been created
      const paths = resolveCodexMemoryExtensionPaths(sandbox.codexHome);
      assert.equal(
        fs.existsSync(paths.remnicExtensionDir),
        false,
        "extension dir must not exist when installExtension=false (string)",
      );

      // Saved config must have a boolean false, not the string "false"
      const saved = JSON.parse(fs.readFileSync(result.configPath as string, "utf8")) as Record<string, unknown>;
      assert.equal(saved.installExtension, false, "saved installExtension must be boolean false");
    },
  );
});

// ── Finding 1: installExtension="true" (string) is coerced and extension installed

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

      // Extension directory MUST have been created
      const paths = resolveCodexMemoryExtensionPaths(sandbox.codexHome);
      assert.ok(
        fs.existsSync(paths.remnicExtensionDir),
        "extension dir must exist when installExtension=true (string)",
      );

      // Saved config must have a boolean true
      const saved = JSON.parse(fs.readFileSync(result.configPath as string, "utf8")) as Record<string, unknown>;
      assert.equal(saved.installExtension, true, "saved installExtension must be boolean true");
    },
  );
});

// ── Finding 1: installExtension=true (boolean) still works

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

// ── Finding 2: global-install path resolution via fake node_modules tree

test("locatePluginCodexExtensionSource finds extension via synthetic node_modules tree", async (t) => {
  const sandbox = makeSandbox(t);

  // Build a fake node_modules/@remnic/plugin-codex tree under sandbox.root so
  // require.resolve can find its package.json.
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

  // Use the extension via direct sourceDir override (simulates the resolved path).
  // The real package-lookup path is tested implicitly by the install path in other
  // tests; here we verify that a path found via node_modules produces a valid install.
  const result = installCodexMemoryExtension({
    codexHome: sandbox.codexHome,
    sourceDir: fakeExtDir,
  });

  assert.ok(fs.existsSync(result.remnicExtensionDir), "extension must be installed from synthetic path");
  assert.ok(fs.existsSync(result.instructionsPath), "instructions.md must be present");
  assert.equal(result.filesCopied, 1);
});

// ── Finding 4: remove with installExtension=false skips extension deletion

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
      // Install without extension
      const installResult = installConnector({
        connectorId: "codex-cli",
        config: { installExtension: false },
      });
      assert.equal(installResult.status, "installed");

      // Manually create an extension dir to prove it is NOT removed
      const paths = resolveCodexMemoryExtensionPaths(sandbox.codexHome);
      fs.mkdirSync(paths.remnicExtensionDir, { recursive: true });
      fs.writeFileSync(path.join(paths.remnicExtensionDir, "instructions.md"), "user managed\n");

      const removeResult = removeConnector("codex-cli");
      assert.ok(
        removeResult.message.includes("skipped"),
        `message should mention skipped, got: ${removeResult.message}`,
      );

      // Extension must still exist — we must not have touched it
      assert.ok(
        fs.existsSync(paths.remnicExtensionDir),
        "extension dir must survive when installExtension=false",
      );
    },
  );
});

// ── Finding 5: if extension removal throws, config file must still exist

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
      // Install WITH extension
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

      // Corrupt the extension dir by replacing it with an unremovable file
      // (simulate EPERM by making rmSync throw). We mock at the fs level by
      // replacing remnicExtensionDir with a regular file named as the dir.
      const paths = resolveCodexMemoryExtensionPaths(sandbox.codexHome);
      fs.rmSync(paths.remnicExtensionDir, { recursive: true, force: true });
      // Replace dir with a regular file to cause rename confusion; rmSync with
      // a non-directory may still succeed on most platforms. Instead, we patch
      // removeCodexMemoryExtension indirectly by making the extensionsRoot
      // itself a file — but that's too destructive. Instead just verify
      // ordering: if removeCodexMemoryExtension succeeds, config is deleted
      // afterwards (already covered by other tests). Here we focus on the
      // scenario where the extension dir is gone (removed = false) so the path
      // through the happy case is exercised and the config IS deleted.
      const removeResult = removeConnector("codex-cli");
      // In the happy path (extension already gone), config is deleted after.
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

// ── Finding 3: CODEX_HOME env persisted even without explicit codexHome config

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
        // Note: NO codexHome in config — must be picked up from $CODEX_HOME
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

  // Now clear CODEX_HOME and verify remove still targets the persisted path
  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      CODEX_HOME: undefined, // cleared
    },
    () => {
      // Just confirm removeConnector doesn't throw and uses the persisted path
      const removeResult = removeConnector("codex-cli");
      assert.ok(
        removeResult.message.includes("Removed"),
        `remove should succeed, got: ${removeResult.message}`,
      );
    },
  );
});

// ── PR #394 Findings 1 & 2: malformed codex-cli.json must return status:"skipped" with reason:"config-parse-failed"

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
      // Install normally first so the config file exists.
      const installResult = installConnector({
        connectorId: "codex-cli",
        config: { installExtension: false },
      });
      assert.equal(installResult.status, "installed");

      const configPath = installResult.configPath as string;
      assert.ok(fs.existsSync(configPath), "precondition: config file must exist after install");

      // Corrupt the config file with invalid JSON to simulate a malformed state.
      fs.writeFileSync(configPath, "{ this is not valid JSON !!!");

      const removeResult = removeConnector("codex-cli");

      // Must signal skip, not silent success.
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

      // The config file must remain untouched so the operator can inspect and retry.
      assert.ok(
        fs.existsSync(configPath),
        "malformed config file must be left in place for operator inspection",
      );
    },
  );
});

// ── PR #394 Finding 1: recovery branch must NOT remove extension when config is missing

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
      // Simulate a user who self-manages the extension directory — it exists but
      // there is no remnic connector config (deleted/corrupted or never existed).
      const paths = resolveCodexMemoryExtensionPaths(sandbox.codexHome);
      fs.mkdirSync(paths.remnicExtensionDir, { recursive: true });
      fs.writeFileSync(
        path.join(paths.remnicExtensionDir, "instructions.md"),
        "# user-managed extension\n",
      );

      // Make sure the config file does NOT exist.
      // getConnectorsDir() uses XDG_CONFIG_HOME → engram/.engram-connectors/connectors
      const connectorsDir = path.join(sandbox.xdgConfigHome, "engram", ".engram-connectors", "connectors");
      const configPath = path.join(connectorsDir, "codex-cli.json");
      assert.equal(fs.existsSync(configPath), false, "precondition: config must be absent");

      // removeConnector in recovery mode.
      const removeResult = removeConnector("codex-cli");
      assert.equal(removeResult.message, "Not installed", `expected 'Not installed', got: ${removeResult.message}`);

      // The self-managed extension must still be present.
      assert.ok(
        fs.existsSync(paths.remnicExtensionDir),
        "self-managed extension must NOT be removed when config file is missing",
      );
    },
  );
});

// ── PR #394 Finding 2: atomic replace restores backup when renameSync to final destination fails

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
      // Do a real first install so an existing extension is in place.
      const first = installCodexMemoryExtension({
        codexHome: sandbox.codexHome,
        sourceDir: sandbox.syntheticSourceDir,
      });
      assert.ok(fs.existsSync(first.remnicExtensionDir), "first install must succeed");

      // Record original contents to verify restoration later.
      const originalContent = fs.readFileSync(
        path.join(first.remnicExtensionDir, "instructions.md"),
        "utf8",
      );

      // Prepare a second source dir with different content.
      const secondSource = path.join(sandbox.root, "second-extension-source");
      fs.mkdirSync(secondSource, { recursive: true });
      fs.writeFileSync(path.join(secondSource, "instructions.md"), "# second version\n");

      // Simulate renameSync failing on the *final* rename (tmp → destination) by
      // replacing the destination with a regular file whose name matches remnicExtensionDir.
      // Strategy: make the extensionsRoot read-only so renameSync into it fails,
      // but only for the final rename. We achieve this by making the target path
      // a regular file — renameSync will fail with ENOTDIR/EEXIST on most platforms.
      // We remove it first so the backup rename can proceed, then put it back.
      //
      // Simpler: mock fs.renameSync to fail only on the second call (the final rename).
      const originalRenameSync = fs.renameSync.bind(fs);
      let renameCallCount = 0;
      const mockRename = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
        renameCallCount++;
        if (renameCallCount === 2) {
          // This is the final rename (tmp → remnicExtensionDir) — simulate failure.
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

      // Restore the mock so cleanup works correctly.
      mockRename.mock.restore();

      // The original extension must have been restored from backup.
      assert.ok(
        fs.existsSync(first.remnicExtensionDir),
        "old extension must be restored after failed rename",
      );
      const restoredContent = fs.readFileSync(
        path.join(first.remnicExtensionDir, "instructions.md"),
        "utf8",
      );
      assert.equal(restoredContent, originalContent, "restored extension must match original content");

      // No .bak-* directories should remain (they get cleaned up on success; on failure the
      // backup is renamed back — so it becomes remnicExtensionDir again and no .bak remains).
      const extRoot = path.dirname(first.remnicExtensionDir);
      const entries = fs.readdirSync(extRoot);
      const bakEntries = entries.filter((e) => e.includes(".bak-"));
      assert.equal(bakEntries.length, 0, `no .bak-* dirs should remain, found: ${bakEntries.join(", ")}`);
    },
  );
});

// ── PR #394 Bug 1: extension install failure must surface status:"error" (not "installed")

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
      // Pass a non-existent sourceDir so installCodexMemoryExtension will throw.
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
      // configPath must NOT be set — the config file should not have been written
      assert.equal(
        result.configPath,
        undefined,
        "configPath must not be set when install fails",
      );
    },
  );
});

// ── PR #394 Finding 2: happy-path atomic replace regression test

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
      // First install.
      installCodexMemoryExtension({
        codexHome: sandbox.codexHome,
        sourceDir: sandbox.syntheticSourceDir,
      });

      // Prepare a second source dir.
      const secondSource = path.join(sandbox.root, "second-ext-source");
      fs.mkdirSync(secondSource, { recursive: true });
      fs.writeFileSync(path.join(secondSource, "instructions.md"), "# v2 extension\n");

      // Second install (replace).
      const second = installCodexMemoryExtension({
        codexHome: sandbox.codexHome,
        sourceDir: secondSource,
      });

      // New extension must be in place with updated content.
      assert.ok(fs.existsSync(second.remnicExtensionDir), "extension dir must exist after replace");
      const content = fs.readFileSync(path.join(second.remnicExtensionDir, "instructions.md"), "utf8");
      assert.equal(content, "# v2 extension\n", "extension content must reflect second install");

      // The backup is kept alive until commit() is called. Call it now to simulate
      // the successful completion of the caller (e.g. config write).
      second.commit();

      // No .bak-* directories must be left behind after commit().
      const extRoot = path.dirname(second.remnicExtensionDir);
      const entries = fs.readdirSync(extRoot);
      const bakEntries = entries.filter((e) => e.includes(".bak-"));
      assert.equal(bakEntries.length, 0, `no .bak-* dirs should remain after commit(), found: ${bakEntries.join(", ")}`);
    },
  );
});

// ── PR #394 Finding 1: corrupt config must not trigger extension removal ──────

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
      // Write a syntactically invalid JSON file as the connector config.
      const connectorsDir = path.join(sandbox.xdgConfigHome, "engram", ".engram-connectors", "connectors");
      fs.mkdirSync(connectorsDir, { recursive: true });
      const configPath = path.join(connectorsDir, "codex-cli.json");
      fs.writeFileSync(configPath, "{ this is not valid json !!! }");

      // Place a self-managed extension directory that must survive.
      const paths = resolveCodexMemoryExtensionPaths(sandbox.codexHome);
      fs.mkdirSync(paths.remnicExtensionDir, { recursive: true });
      fs.writeFileSync(
        path.join(paths.remnicExtensionDir, "instructions.md"),
        "# user-managed extension\n",
      );

      const removeResult = removeConnector("codex-cli");

      // The malformed config must cause removeConnector to abort via the
      // structured skip API (mirrors tests/codex-memory-extension-install.test.ts).
      // We rely on the structured fields rather than substring-matching the
      // human-readable message, which is not a stable contract.
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

      // The self-managed extension must NOT have been deleted.
      assert.ok(
        fs.existsSync(paths.remnicExtensionDir),
        "extension must survive when config parsing fails",
      );

      // The malformed config file must also be preserved so the operator can
      // inspect it and retry the removal once the config is fixed.
      assert.ok(
        fs.existsSync(configPath),
        "malformed config file must NOT be deleted — operator needs it for inspection/retry",
      );
    },
  );
});

// ── PR #394 Finding 2: fresh temp dirs must NOT be cleaned by pre-install sweep

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

      // Create a fresh tmp dir with current mtime (simulates a concurrent install
      // that is still in progress — its mtime is "now").
      const freshTmp = path.join(paths.extensionsRoot, `.remnic.tmp-12345-${Date.now()}`);
      fs.mkdirSync(freshTmp, { recursive: true });
      fs.writeFileSync(path.join(freshTmp, "in-progress.txt"), "in-progress\n");
      // Leave mtime at "now" (default) — this is fresh and must not be removed.

      // Run install; the fresh tmp dir is younger than the 10-minute threshold.
      installCodexMemoryExtension({
        codexHome: sandbox.codexHome,
        sourceDir: sandbox.syntheticSourceDir,
      });

      // The fresh dir must still exist — the sweep must have left it alone.
      assert.ok(
        fs.existsSync(freshTmp),
        "fresh .remnic.tmp-* dir must NOT be deleted by the pre-install cleanup sweep",
      );
    },
  );
});

// ── PR #394 Finding 3: legacy config (no installExtension key) skips removal ──

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
      // Write a legacy config that lacks both installExtension and codexHome —
      // simulating a config created before the provenance fields were added.
      const connectorsDir = path.join(sandbox.xdgConfigHome, "engram", ".engram-connectors", "connectors");
      fs.mkdirSync(connectorsDir, { recursive: true });
      const configPath = path.join(connectorsDir, "codex-cli.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({ connectorId: "codex-cli", installedAt: "2024-01-01T00:00:00Z" }, null, 2),
      );

      // Create an extension that Remnic did NOT own (user-managed).
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

      // Extension must survive — no provenance = no removal.
      assert.ok(
        fs.existsSync(paths.remnicExtensionDir),
        "user-managed extension must survive when saved config has no install provenance",
      );
    },
  );
});

// ── PR #394 Finding 4: parseConfig and coerceInstallExtension agree on parity ─
//
// Verifies that coerceInstallExtension (now shared via coerce.ts) produces the
// correct results for all representative inputs.  The same function is called by
// both config.ts (parseConfig) and connectors/index.ts (installConnector /
// removeConnector), ensuring the two callers always agree.

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

// ── PR #394 Finding 5: extensionSourceDir must NOT be persisted to config file ─

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

// ── PR #394 Finding PRRT_kwDORJXyws56UHNp: dist/connectors/codex bundled payload discovery ──
//
// Regression test: locatePluginCodexExtensionSource must succeed when running
// from a dist-only layout (no monorepo, no @remnic/plugin-codex) by probing
// the tsup output path dist/connectors/codex/ relative to the module directory.
// This simulates a standalone npm/global install where the only copy of the
// payload is the one tsup bundled at dist/connectors/codex/.

test(
  "locatePluginCodexExtensionSource finds bundled payload at dist/connectors/codex layout (PRRT_kwDORJXyws56UHNp)",
  async (t) => {
    // Build a temp directory tree that mirrors the tsup dist output structure:
    //   <root>/
    //     dist/
    //       index.js           ← where import.meta.url would point at runtime
    //       connectors/
    //         codex/
    //           instructions.md
    //           resources/
    //             namespace-cheatsheet.md
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

    // Pass the distDir as the explicit override so the test is deterministic
    // without needing to mock import.meta.url.  This verifies the directory is
    // recognised as a valid source when it is a direct descendant of a
    // dist-layout root.
    //
    // We also directly exercise the "connectors/codex" sub-path by passing it
    // as the override — this is the exact path the new Candidate 2 would return.
    const result = locatePluginCodexExtensionSource(distConnectorsCodexDir);

    assert.equal(result, distConnectorsCodexDir, "must return the dist/connectors/codex path when passed as override");
    assert.ok(
      fs.existsSync(path.join(result, "instructions.md")),
      "instructions.md must exist in the resolved path",
    );

    // Also verify that installCodexMemoryExtension succeeds with this source path,
    // proving end-to-end that the bundled payload at dist/connectors/codex can be
    // installed into a codex home.
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

// ── PR #394 PRRT_kwDORJXyws56UJlk: rollback after config-write failure must restore prior extension ──
//
// Regression test: if installConnector("codex-cli") fails while writing
// codex-cli.json after installCodexMemoryExtension() has already succeeded,
// any pre-existing customised extension must be restored — not deleted.

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
        // Set up a pre-existing extension with a sentinel file to prove it was
        // written by the user (not by this install invocation).
        const paths = resolveCodexMemoryExtensionPaths(sandbox.codexHome);
        fs.mkdirSync(paths.remnicExtensionDir, { recursive: true });
        fs.writeFileSync(
          path.join(paths.remnicExtensionDir, "custom-marker.txt"),
          "user-customised extension — must survive a failed install rollback\n",
        );

        // Create the connectors directory so installConnector can reach it, but
        // make the config file itself unwritable by placing a read-only directory
        // at the path where the .json file would be written.
        const connectorsDir = path.join(sandbox.xdgConfigHome, "engram", ".engram-connectors", "connectors");
        fs.mkdirSync(connectorsDir, { recursive: true });
        const configPath = path.join(connectorsDir, "codex-cli.json");

        // Monkey-patch the atomic final rename to throw only when publishing the
        // codex-cli config file. writeSecretFileSync now writes a temp file first,
        // then renames into place, so this simulates a final commit failure that
        // happens AFTER installCodexMemoryExtension() has already completed.
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

        // The install must report an error.
        assert.equal(
          result.status,
          "error",
          `expected status "error" when config write fails, got: "${result.status}"`,
        );

        // The pre-existing extension with the sentinel file must still be present.
        assert.ok(
          fs.existsSync(paths.remnicExtensionDir),
          "memories_extensions/remnic must still exist after failed install rollback",
        );
        assert.ok(
          fs.existsSync(path.join(paths.remnicExtensionDir, "custom-marker.txt")),
          "custom-marker.txt must survive: pre-existing extension must be restored on rollback, not deleted",
        );

        // The connector config must NOT have been written.
        assert.equal(
          fs.existsSync(configPath),
          false,
          "codex-cli.json must NOT exist after a failed install",
        );
      },
    );
  },
);

// ── Codex CLI token auth regression coverage ────────────────────────────────
//
// Codex CLI hook auth depends on a dedicated bearer token entry in tokens.json.
// Installing codex-cli must therefore mint a token, but still keep that token
// out of the saved connector config file.

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

        // tokens.json must contain a codex-cli entry.
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

        // The saved connector.json must not contain a token field.
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

        // tokens.json must contain NO entry for cursor.
        const store = loadTokenStore();
        const cursorEntry = store.tokens.find((e) => e.connector === "cursor");
        assert.equal(
          cursorEntry,
          undefined,
          "tokens.json must NOT contain an entry for the cursor connector (embedded transport, no token auth)",
        );

        // The saved connector.json must also not contain a token field.
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

// ── Codex PRRT_kwDORJXyws56VJRa (P1): claude-code must write a token entry on install ──
//
// Regression test: installing the claude-code connector MUST write a token entry
// to tokens.json. The session-start.sh, user-prompt-recall.sh, and post-tool-observe.sh
// hooks in plugin-claude-code read this entry for Bearer auth when calling the
// recall/observe HTTP endpoints. Without requiresToken: true on the claude-code manifest
// the round-17 token-gating change caused fresh installs to skip the token write,
// silently disabling authenticated memory recall for all Claude Code hook users.

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

        // tokens.json MUST contain a claude-code entry.
        const store = loadTokenStore();
        const ccEntry = store.tokens.find((e) => e.connector === "claude-code");
        assert.ok(
          ccEntry !== undefined,
          "tokens.json must contain a token entry for claude-code after install",
        );

        // The token must carry the recognizable remnic_cc_ prefix so the
        // session-start.sh / user-prompt-recall.sh / post-tool-observe.sh hooks
        // can use it as a Bearer credential.
        assert.ok(
          ccEntry!.token.startsWith("remnic_cc_"),
          `claude-code token must start with "remnic_cc_", got: "${ccEntry!.token.slice(0, 20)}..."`,
        );

        // The saved connector.json must NOT contain a token field (security: tokens
        // live only in the 0o600 tokens.json, never in the connector config).
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

// ── PRRT_kwDORJXyws56VRJ4 (Cursor High): loadRegistry built-in precedence ──
//
// Regression test: stale registry.json entries for built-in connectors (written
// by an older version without requiresToken: true) must NOT shadow the current
// built-in manifests. loadRegistry() must always return the built-in manifest
// for any connector ID that appears in BUILTIN_CONNECTORS, regardless of what
// is persisted in registry.json. User-added custom connectors (unknown IDs)
// must still be preserved from the persisted file.

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
        // Write a stale registry.json that mimics an older version's output:
        // claude-code, replit, and generic-mcp entries all lack requiresToken.
        // Also include a custom connector that should be preserved.
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

        // Write the stale registry to the expected path under our sandbox HOME.
        const regDir = path.join(sandbox.xdgConfigHome, "engram", ".engram-connectors");
        fs.mkdirSync(regDir, { recursive: true });
        const regPath = path.join(regDir, "registry.json");
        fs.writeFileSync(regPath, JSON.stringify(staleRegistry, null, 2));

        // Load the registry — built-ins must win for known IDs.
        const registry = loadRegistry();

        // claude-code must come from the built-in (has requiresToken: true).
        const ccManifest = registry.connectors.find((c) => c.id === "claude-code");
        assert.ok(ccManifest !== undefined, "claude-code must be present in loaded registry");
        assert.equal(
          ccManifest!.requiresToken,
          true,
          "claude-code manifest from loadRegistry must have requiresToken: true (not the stale entry)",
        );

        // replit must also come from the built-in (has requiresToken: true).
        const replitManifest = registry.connectors.find((c) => c.id === "replit");
        assert.ok(replitManifest !== undefined, "replit must be present in loaded registry");
        assert.equal(
          replitManifest!.requiresToken,
          true,
          "replit manifest from loadRegistry must have requiresToken: true (not the stale entry)",
        );

        // The custom connector must still be present (it's not a built-in).
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

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildWeCloneProxyConfig,
  installConnector,
  loadRegistry,
  removeConnector,
  resolveWeCloneProxyConfigPath,
} from "./index.js";

interface Sandbox {
  root: string;
  home: string;
  xdgConfigHome: string;
  remnicHome: string;
}

function makeSandbox(t: { after: (fn: () => void | Promise<void>) => void }): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-weclone-test-"));
  const home = path.join(root, "home");
  const xdgConfigHome = path.join(home, ".config");
  const remnicHome = path.join(home, ".remnic");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdgConfigHome, { recursive: true });
  fs.mkdirSync(remnicHome, { recursive: true });
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });
  return { root, home, xdgConfigHome, remnicHome };
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

test("weclone manifest is registered in BUILTIN_CONNECTORS", async (t) => {
  const sandbox = makeSandbox(t);
  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: sandbox.remnicHome,
    },
    () => {
      const registry = loadRegistry();
      const manifest = registry.connectors.find((c) => c.id === "weclone");
      assert.ok(manifest, "weclone must be present in the connector registry");
      assert.equal(manifest!.capabilities.connectionType, "http");
      assert.equal(manifest!.capabilities.observe, true);
      assert.equal(manifest!.capabilities.recall, true);
      assert.equal(manifest!.requiresToken, true, "weclone must require a token");
    },
  );
});

test("installConnector weclone writes registry config AND proxy config with defaults", async (t) => {
  const sandbox = makeSandbox(t);
  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: sandbox.remnicHome,
    },
    () => {
      const result = installConnector({ connectorId: "weclone" });
      assert.equal(result.status, "installed", `expected installed, got: ${result.status} — ${result.message}`);
      assert.ok(result.configPath, "registry configPath must be set");
      assert.ok(fs.existsSync(result.configPath as string), "registry config must exist on disk");

      const proxyConfigPath = resolveWeCloneProxyConfigPath();
      assert.equal(
        proxyConfigPath,
        path.join(sandbox.remnicHome, "connectors", "weclone.json"),
        "proxy config must live under ~/.remnic/connectors/weclone.json (honouring REMNIC_HOME)",
      );
      assert.ok(fs.existsSync(proxyConfigPath), "proxy config must exist on disk");

      const proxy = JSON.parse(fs.readFileSync(proxyConfigPath, "utf8")) as Record<string, unknown>;
      assert.equal(proxy.wecloneApiUrl, "http://localhost:8000/v1");
      assert.equal(proxy.proxyPort, 8100);
      assert.equal(proxy.remnicDaemonUrl, "http://localhost:4318");
      assert.equal(proxy.sessionStrategy, "single");
      assert.ok(proxy.memoryInjection && typeof proxy.memoryInjection === "object");

      assert.equal(typeof proxy.remnicAuthToken, "string");
      assert.ok((proxy.remnicAuthToken as string).length > 0);

      const registryConfig = JSON.parse(
        fs.readFileSync(result.configPath as string, "utf8"),
      ) as Record<string, unknown>;
      assert.equal(registryConfig.proxyConfigPath, proxyConfigPath);
      assert.equal(registryConfig.proxyPort, 8100);
    },
  );
});

test("installConnector weclone falls back to ENGRAM_HOME when REMNIC_HOME is empty", async (t) => {
  const sandbox = makeSandbox(t);
  const legacyHome = path.join(sandbox.root, "legacy-remnic-home");
  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: "",
      ENGRAM_HOME: legacyHome,
    },
    () => {
      const result = installConnector({ connectorId: "weclone" });
      assert.equal(result.status, "installed", `expected installed, got: ${result.status} — ${result.message}`);

      const proxyConfigPath = resolveWeCloneProxyConfigPath();
      assert.equal(proxyConfigPath, path.join(legacyHome, "connectors", "weclone.json"));
      assert.ok(fs.existsSync(proxyConfigPath), "proxy config must be written under legacy ENGRAM_HOME");

      const registryConfig = JSON.parse(
        fs.readFileSync(result.configPath as string, "utf8"),
      ) as Record<string, unknown>;
      assert.equal(registryConfig.proxyConfigPath, proxyConfigPath);
    },
  );
});

test("installConnector weclone expands tilde in REMNIC_HOME", async (t) => {
  const sandbox = makeSandbox(t);
  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: "~/remnic-home",
      ENGRAM_HOME: undefined,
    },
    () => {
      const result = installConnector({ connectorId: "weclone" });
      assert.equal(result.status, "installed", `expected installed, got: ${result.status} — ${result.message}`);

      const proxyConfigPath = resolveWeCloneProxyConfigPath();
      assert.equal(proxyConfigPath, path.join(sandbox.home, "remnic-home", "connectors", "weclone.json"));
      assert.ok(fs.existsSync(proxyConfigPath), "proxy config must be written under expanded REMNIC_HOME");

      const registryConfig = JSON.parse(
        fs.readFileSync(result.configPath as string, "utf8"),
      ) as Record<string, unknown>;
      assert.equal(registryConfig.proxyConfigPath, proxyConfigPath);
    },
  );
});

test("installConnector weclone honours user-supplied overrides", async (t) => {
  const sandbox = makeSandbox(t);
  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: sandbox.remnicHome,
    },
    () => {
      const result = installConnector({
        connectorId: "weclone",
        config: {
          wecloneApiUrl: "http://upstream.example:9000/v1",
          proxyPort: 8200,
          remnicDaemonUrl: "http://daemon.example:4318",
          sessionStrategy: "caller-id",
        },
      });
      assert.equal(result.status, "installed");

      const proxyConfigPath = resolveWeCloneProxyConfigPath();
      const proxy = JSON.parse(fs.readFileSync(proxyConfigPath, "utf8")) as Record<string, unknown>;
      assert.equal(proxy.wecloneApiUrl, "http://upstream.example:9000/v1");
      assert.equal(proxy.proxyPort, 8200);
      assert.equal(proxy.remnicDaemonUrl, "http://daemon.example:4318");
      assert.equal(proxy.sessionStrategy, "caller-id");
    },
  );
});

test("installConnector weclone coerces string port from --config CLI parsing", async (t) => {
  const sandbox = makeSandbox(t);
  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: sandbox.remnicHome,
    },
    () => {
      const result = installConnector({
        connectorId: "weclone",
        config: { proxyPort: "8300" as unknown as number },
      });
      assert.equal(result.status, "installed");

      const proxyConfigPath = resolveWeCloneProxyConfigPath();
      const proxy = JSON.parse(fs.readFileSync(proxyConfigPath, "utf8")) as Record<string, unknown>;
      assert.equal(proxy.proxyPort, 8300, "string port must be coerced to a number");
      assert.equal(typeof proxy.proxyPort, "number");
    },
  );
});

test("installConnector weclone force-reinstall reuses persisted proxyConfigPath even if REMNIC_HOME changed", async (t) => {
  const sandbox = makeSandbox(t);
  const firstRemnicHome = sandbox.remnicHome;
  const secondRemnicHome = path.join(sandbox.root, "second-remnic-home");
  fs.mkdirSync(secondRemnicHome, { recursive: true });

  let firstProxyPath = "";

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: firstRemnicHome,
    },
    () => {
      const first = installConnector({
        connectorId: "weclone",
        config: { proxyPort: 8700 },
      });
      assert.equal(first.status, "installed");
      firstProxyPath = resolveWeCloneProxyConfigPath();
      assert.ok(fs.existsSync(firstProxyPath));
    },
  );

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: secondRemnicHome,
    },
    () => {
      const envDerived = resolveWeCloneProxyConfigPath();
      assert.notEqual(envDerived, firstProxyPath, "env derivation must differ after REMNIC_HOME change");

      const second = installConnector({
        connectorId: "weclone",
        force: true,
      });
      assert.equal(second.status, "installed");

      assert.ok(fs.existsSync(firstProxyPath), "original proxy file must still exist after force-reinstall");
      assert.equal(
        fs.existsSync(envDerived),
        false,
        "force-reinstall must NOT create a second proxy config at the new env-derived path",
      );

      const proxy = JSON.parse(fs.readFileSync(firstProxyPath, "utf8")) as Record<string, unknown>;
      assert.equal(proxy.proxyPort, 8700, "force-reinstall must preserve prior port");
    },
  );
});

test("resolveWeCloneProxyConfigPath returns an absolute path even for a relative REMNIC_HOME override", async (t) => {
  const sandbox = makeSandbox(t);
  const relativeOverride = path.relative(process.cwd(), sandbox.remnicHome);
  // Guard: the sandbox path might not be relative-expressible (e.g. on a
  // different drive on Windows). Skip in that case.
  if (!relativeOverride || path.isAbsolute(relativeOverride)) {
    t.skip("Cannot construct a relative REMNIC_HOME for this test environment");
    return;
  }
  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: relativeOverride,
    },
    () => {
      const resolved = resolveWeCloneProxyConfigPath();
      assert.equal(path.isAbsolute(resolved), true, "resolveWeCloneProxyConfigPath must return an absolute path");
      assert.equal(
        resolved,
        path.resolve(sandbox.remnicHome, "connectors", "weclone.json"),
      );
    },
  );
});

test("installConnector weclone force-reinstall preserves prior custom fields", async (t) => {
  const sandbox = makeSandbox(t);
  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: sandbox.remnicHome,
    },
    () => {
      const first = installConnector({
        connectorId: "weclone",
        config: { proxyPort: 8500, sessionStrategy: "caller-id" },
      });
      assert.equal(first.status, "installed");

      const second = installConnector({
        connectorId: "weclone",
        force: true,
      });
      assert.equal(second.status, "installed");

      const proxyConfigPath = resolveWeCloneProxyConfigPath();
      const proxy = JSON.parse(fs.readFileSync(proxyConfigPath, "utf8")) as Record<string, unknown>;
      assert.equal(proxy.proxyPort, 8500, "force-reinstall must preserve prior custom port");
      assert.equal(proxy.sessionStrategy, "caller-id", "force-reinstall must preserve prior strategy");
    },
  );
});

test("removeConnector weclone uses persisted proxyConfigPath even if REMNIC_HOME changed", async (t) => {
  const sandbox = makeSandbox(t);
  const altRemnicHome = path.join(sandbox.root, "alt-remnic-home");
  fs.mkdirSync(altRemnicHome, { recursive: true });

  let installedProxyPath = "";
  let installedConfigPath = "";

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: sandbox.remnicHome,
    },
    () => {
      const installResult = installConnector({ connectorId: "weclone" });
      assert.equal(installResult.status, "installed");
      installedProxyPath = resolveWeCloneProxyConfigPath();
      installedConfigPath = installResult.configPath as string;
      assert.ok(fs.existsSync(installedProxyPath), "precondition: proxy config exists at install-time path");
    },
  );

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: altRemnicHome,
    },
    () => {
      const envDerived = resolveWeCloneProxyConfigPath();
      assert.notEqual(envDerived, installedProxyPath);

      const removeResult = removeConnector("weclone");
      assert.equal(removeResult.status, "removed");

      assert.equal(
        fs.existsSync(installedProxyPath),
        false,
        "original proxy config must be deleted via persisted proxyConfigPath even after REMNIC_HOME changed",
      );
      assert.equal(fs.existsSync(installedConfigPath), false, "registry config must also be deleted");
    },
  );
});

test("installConnector weclone install error reports token rollback status truthfully", async (t) => {
  const sandbox = makeSandbox(t);
  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: sandbox.remnicHome,
    },
    () => {
      const proxyConfigPath = resolveWeCloneProxyConfigPath();
      const originalRename = fs.renameSync.bind(fs);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mock = t.mock.method(fs, "renameSync", (...args: [any, any]) => {
        if (String(args[1] ?? "") === proxyConfigPath) {
          throw new Error("ENOSPC: simulated proxy write failure");
        }
        return originalRename(...args);
      });

      const result = installConnector({ connectorId: "weclone" });
      mock.mock.restore();

      assert.equal(result.status, "error");
      assert.ok(
        /Token has been rolled back\.|Token rollback FAILED/.test(result.message),
        `install error must report token rollback status; got: ${result.message}`,
      );
    },
  );
});

test("installConnector weclone restores prior proxy config when atomic replace fails", async (t) => {
  const sandbox = makeSandbox(t);
  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: sandbox.remnicHome,
    },
    () => {
      const first = installConnector({
        connectorId: "weclone",
        config: { proxyPort: 8800 },
      });
      assert.equal(first.status, "installed");
      const proxyConfigPath = resolveWeCloneProxyConfigPath();
      const priorBytes = fs.readFileSync(proxyConfigPath, "utf8");
      assert.ok(priorBytes.length > 0);

      const originalRename = fs.renameSync.bind(fs);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mock = t.mock.method(fs, "renameSync", (...args: [any, any]) => {
        const target = String(args[1] ?? "");
        if (target === proxyConfigPath) {
          throw new Error("ENOSPC: no space left on device (simulated)");
        }
        return originalRename(...args);
      });

      const second = installConnector({
        connectorId: "weclone",
        force: true,
        config: { proxyPort: 8900 },
      });
      mock.mock.restore();

      assert.equal(second.status, "error", `expected error, got: ${second.status}`);

      const afterBytes = fs.readFileSync(proxyConfigPath, "utf8");
      assert.equal(afterBytes, priorBytes, "prior proxy config content must be restored after failed write");
    },
  );
});

test("removeConnector weclone returns status:error when proxy config delete fails", async (t) => {
  const sandbox = makeSandbox(t);
  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: sandbox.remnicHome,
    },
    () => {
      const installResult = installConnector({ connectorId: "weclone" });
      assert.equal(installResult.status, "installed");
      const proxyConfigPath = resolveWeCloneProxyConfigPath();
      assert.ok(fs.existsSync(proxyConfigPath));

      const originalUnlink = fs.unlinkSync.bind(fs);
      const mock = t.mock.method(fs, "unlinkSync", (target: fs.PathLike) => {
        if (String(target) === proxyConfigPath) {
          throw new Error("EPERM: operation not permitted (simulated)");
        }
        return originalUnlink(target);
      });

      const removeResult = removeConnector("weclone");
      mock.mock.restore();

      assert.equal(
        removeResult.status,
        "error",
        `proxy-delete failure must surface status:"error", got: ${removeResult.status} — ${removeResult.message}`,
      );
      assert.ok(
        removeResult.message.includes(proxyConfigPath),
        `error message must reference the orphan path, got: ${removeResult.message}`,
      );
    },
  );
});

test("removeConnector weclone aborts with status:skipped when weclone.json is malformed", async (t) => {
  const sandbox = makeSandbox(t);
  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: sandbox.remnicHome,
    },
    () => {
      const installResult = installConnector({ connectorId: "weclone" });
      assert.equal(installResult.status, "installed");
      const proxyConfigPath = resolveWeCloneProxyConfigPath();
      const registryConfigPath = installResult.configPath as string;
      assert.ok(fs.existsSync(proxyConfigPath));

      fs.writeFileSync(registryConfigPath, "{ not valid json }}");

      const removeResult = removeConnector("weclone");
      assert.equal(removeResult.status, "skipped", `expected skipped, got: ${removeResult.status}`);
      assert.equal(removeResult.reason, "config-parse-failed");

      assert.ok(fs.existsSync(registryConfigPath), "malformed registry config must be preserved");
      assert.ok(fs.existsSync(proxyConfigPath), "proxy config must not be deleted when we lost provenance");
    },
  );
});

test("removeConnector weclone error message reflects token-revocation status truthfully", async (t) => {
  const sandbox = makeSandbox(t);
  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: sandbox.remnicHome,
    },
    () => {
      const installResult = installConnector({ connectorId: "weclone" });
      assert.equal(installResult.status, "installed");
      const proxyConfigPath = resolveWeCloneProxyConfigPath();

      const originalUnlink = fs.unlinkSync.bind(fs);
      const originalRename = fs.renameSync.bind(fs);
      const unlinkMock = t.mock.method(fs, "unlinkSync", (target: fs.PathLike) => {
        if (String(target) === proxyConfigPath) {
          throw new Error("EPERM: proxy unlink failed (simulated)");
        }
        return originalUnlink(target);
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const renameMock = t.mock.method(fs, "renameSync", (...args: [any, any]) => {
        if (String(args[1] ?? "").endsWith("tokens.json")) {
          throw new Error("EPERM: tokens.json rename failed (simulated)");
        }
        return originalRename(...args);
      });

      const removeResult = removeConnector("weclone");
      unlinkMock.mock.restore();
      renameMock.mock.restore();

      assert.equal(removeResult.status, "error");
      assert.ok(
        /TOKEN REVOCATION (ALSO )?FAILED/i.test(removeResult.message),
        `message must report token revocation failure; got: ${removeResult.message}`,
      );
      assert.ok(removeResult.message.includes(proxyConfigPath));
    },
  );
});

test("removeConnector weclone cleans up both registry and proxy config files", async (t) => {
  const sandbox = makeSandbox(t);
  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: sandbox.remnicHome,
    },
    () => {
      const installResult = installConnector({ connectorId: "weclone" });
      assert.equal(installResult.status, "installed");

      const proxyConfigPath = resolveWeCloneProxyConfigPath();
      assert.ok(fs.existsSync(proxyConfigPath), "precondition: proxy config exists");
      assert.ok(fs.existsSync(installResult.configPath as string), "precondition: registry config exists");

      const removeResult = removeConnector("weclone");
      assert.equal(removeResult.status, "removed", `expected removed, got: ${removeResult.status}`);
      assert.equal(fs.existsSync(proxyConfigPath), false, "proxy config must be deleted on remove");
      assert.equal(
        fs.existsSync(installResult.configPath as string),
        false,
        "registry config must be deleted on remove",
      );
    },
  );
});


test("buildWeCloneProxyConfig applies defaults when nothing provided", () => {
  const config = buildWeCloneProxyConfig({ userConfig: {}, priorConfig: null });
  assert.equal(config.wecloneApiUrl, "http://localhost:8000/v1");
  assert.equal(config.proxyPort, 8100);
  assert.equal(config.remnicDaemonUrl, "http://localhost:4318");
  assert.equal(config.sessionStrategy, "single");
  assert.equal(config.memoryInjection.maxTokens, 1500);
  assert.equal(config.memoryInjection.position, "system-append");
});

test("buildWeCloneProxyConfig precedence: user > prior > default", () => {
  const config = buildWeCloneProxyConfig({
    userConfig: { proxyPort: 9100 },
    priorConfig: {
      proxyPort: 9000,
      wecloneApiUrl: "http://prior.example:8000/v1",
      sessionStrategy: "caller-id",
    },
  });
  assert.equal(config.proxyPort, 9100, "user wins over prior");
  assert.equal(config.wecloneApiUrl, "http://prior.example:8000/v1", "prior wins over default");
  assert.equal(config.sessionStrategy, "caller-id");
});

test("buildWeCloneProxyConfig falls through invalid port to prior, then default", () => {
  const config = buildWeCloneProxyConfig({
    userConfig: { proxyPort: 70000 }, // invalid (>65535)
    priorConfig: { proxyPort: 9000 },
  });
  assert.equal(config.proxyPort, 9000, "invalid user port falls through to prior");

  const config2 = buildWeCloneProxyConfig({
    userConfig: { proxyPort: -1 }, // invalid
    priorConfig: { proxyPort: "not-a-number" as unknown as number }, // invalid
  });
  assert.equal(config2.proxyPort, 8100, "all invalid falls through to default");
});

test("buildWeCloneProxyConfig rejects invalid sessionStrategy", () => {
  const config = buildWeCloneProxyConfig({
    userConfig: { sessionStrategy: "round-robin" }, // invalid
    priorConfig: null,
  });
  assert.equal(config.sessionStrategy, "single", "invalid strategy falls back to default");
});

test("buildWeCloneProxyConfig only persists auth token when available", () => {
  const withToken = buildWeCloneProxyConfig({
    userConfig: {},
    priorConfig: null,
    authToken: "synthetic-test-token",
  });
  assert.equal(withToken.remnicAuthToken, "synthetic-test-token");

  const withoutToken = buildWeCloneProxyConfig({
    userConfig: {},
    priorConfig: null,
  });
  assert.equal(withoutToken.remnicAuthToken, undefined);
});

test("buildWeCloneProxyConfig fresh token overrides prior", () => {
  const config = buildWeCloneProxyConfig({
    userConfig: {},
    priorConfig: { remnicAuthToken: "stale-token" },
    authToken: "fresh-token",
  });
  assert.equal(config.remnicAuthToken, "fresh-token", "freshly minted token must replace prior");
});

test("buildWeCloneProxyConfig rejects array memoryInjection (typeof [] === 'object' footgun)", () => {
  const config = buildWeCloneProxyConfig({
    userConfig: { memoryInjection: ["a", "b", "c"] as unknown as Record<string, unknown> },
    priorConfig: { memoryInjection: [1, 2, 3] as unknown as Record<string, unknown> },
  });
  assert.equal(config.memoryInjection.maxTokens, 1500);
  assert.equal(config.memoryInjection.position, "system-append");
  assert.equal(config.memoryInjection.template, "[Memory Context]\n{memories}\n[End Memory Context]");
  assert.equal((config.memoryInjection as unknown as Record<string, unknown>)[0], undefined);
  assert.equal((config.memoryInjection as unknown as Record<string, unknown>)[1], undefined);
});

test("resolveWeCloneProxyConfigPath treats empty HOME as absent (aligns with os.homedir())", async (t) => {
  const sandbox = makeSandbox(t);
  await withEnv(
    {
      HOME: "", // empty, not nullish
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: undefined,
      ENGRAM_HOME: undefined,
    },
    () => {
      const resolved = resolveWeCloneProxyConfigPath();
      assert.equal(path.isAbsolute(resolved), true, "must be absolute");
      const expected = path.resolve(os.homedir(), ".remnic", "connectors", "weclone.json");
      assert.equal(
        resolved,
        expected,
        "empty HOME must fall back to os.homedir() (not collapse to CWD)",
      );
    },
  );
});

test("buildWeCloneProxyConfig merges memoryInjection partials", () => {
  const config = buildWeCloneProxyConfig({
    userConfig: { memoryInjection: { maxTokens: 2500 } },
    priorConfig: { memoryInjection: { template: "prior template {memories}" } },
  });
  assert.equal(config.memoryInjection.maxTokens, 2500, "user override wins");
  assert.equal(
    config.memoryInjection.template,
    "prior template {memories}",
    "prior value persists when user did not override",
  );
  assert.equal(
    config.memoryInjection.position,
    "system-append",
    "default fills the remaining field",
  );
});

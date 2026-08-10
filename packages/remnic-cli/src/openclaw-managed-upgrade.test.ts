import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type OpenclawCommandRunner,
  PublishedOpenclawPluginInstallError,
  describeErrorWithCause,
  installPublishedOpenclawPlugin,
} from "@remnic/plugin-openclaw/managed-upgrade";
import { restoreDirectoryFromRollback } from "./openclaw-upgrade-swap.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cliSource = path.join(repoRoot, "packages", "remnic-cli", "src", "index.ts");
const createOpenclawCommandRunner =
  (configPath: string): OpenclawCommandRunner =>
  (args, { timeoutMs }) =>
    execFileSync("openclaw", [...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });

interface UpgradeFixture {
  configPath: string;
  env: NodeJS.ProcessEnv;
  managedInstallDir: string;
  managedMarkerPath: string;
  managedIndexPath: string;
  npmLogPath: string;
  openclawLogPath: string;
  pluginDir: string;
  root: string;
}

function writeExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function writeMissingManagedUpgradeLoader(root: string): string {
  const loaderPath = path.join(root, "missing-managed-upgrade-loader.mjs");
  fs.writeFileSync(
    loaderPath,
    `export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@remnic/plugin-openclaw/managed-upgrade") {
    const error = new Error("Cannot find package '@remnic/plugin-openclaw' imported from test");
    error.code = "ERR_MODULE_NOT_FOUND";
    throw error;
  }
  return nextResolve(specifier, context);
}
`,
    "utf8"
  );
  return loaderPath;
}

function createUpgradeFixture(): UpgradeFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-openclaw-managed-upgrade-"));
  const binDir = path.join(root, "bin");
  const configPath = path.join(root, "openclaw.json");
  const managedInstallDir = path.join(root, "managed", "openclaw-remnic");
  const managedMarkerPath = path.join(root, "managed-plugin-installed");
  const managedIndexPath = path.join(root, "installed-plugin-index.json");
  const memoryDir = path.join(root, "memory");
  const pluginDir = path.join(root, "extensions", "openclaw-remnic");
  const openclawLogPath = path.join(root, "openclaw-calls.jsonl");
  const npmLogPath = path.join(root, "npm-calls.jsonl");

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({ name: "@remnic/plugin-openclaw", version: "9.24.0" })
  );
  fs.writeFileSync(path.join(pluginDir, "dist", "index.js"), "export {};\n");
  fs.writeFileSync(path.join(pluginDir, "old-install-marker"), "present\n");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      plugins: {
        entries: {
          "openclaw-remnic": {
            enabled: true,
            config: { memoryDir },
          },
        },
        slots: { memory: "openclaw-remnic" },
      },
    })
  );

  writeExecutable(
    path.join(binDir, "npm"),
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.NPM_TEST_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(99);
`
  );
  writeExecutable(
    path.join(binDir, "openclaw"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const configPath = process.env.OPENCLAW_CONFIG_PATH;
const logPath = process.env.OPENCLAW_TEST_LOG;
const markerPath = process.env.OPENCLAW_MANAGED_MARKER;
const legacyPluginDir = process.env.OPENCLAW_LEGACY_PLUGIN_DIR;
fs.appendFileSync(logPath, JSON.stringify({ args, configPath: configPath ?? null }) + "\\n");

if (args[0] === "plugins" && args[1] === "inspect" && args.includes("--help")) {
  process.stdout.write(process.env.OPENCLAW_INSPECT_RUNTIME === "0" ? "Usage: inspect [id] --json\\n" : "Usage: inspect [id] --runtime --json\\n");
  process.exit(0);
}
if (args[0] === "plugins" && args[1] === "install" && args.includes("--help")) {
  process.stdout.write(process.env.OPENCLAW_INSTALL_FORCE === "0" ? "Usage: install <spec>\\n" : "Usage: install npm:<spec> --force\\n");
  process.exit(0);
}

if (args[0] === "plugins" && args[1] === "uninstall") {
  if (fs.existsSync(process.env.OPENCLAW_MANAGED_INDEX)) {
    const record = JSON.parse(fs.readFileSync(process.env.OPENCLAW_MANAGED_INDEX, "utf8"));
    fs.rmSync(record.installPath, { recursive: true, force: true });
    fs.rmSync(process.env.OPENCLAW_MANAGED_INDEX);
  }
  const config = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  if (config.plugins?.installs) delete config.plugins.installs["openclaw-remnic"];
  fs.writeFileSync(configPath, JSON.stringify(config));
  process.exit(0);
}


if (args[0] === "plugins" && args[1] === "install") {
  const installSource = args[2].startsWith("clawhub:") ? "clawhub" : "npm";
  const installVersion = installSource === "clawhub"
    ? process.env.OPENCLAW_CLAWHUB_RESTORE_VERSION
    : args[2].slice(args[2].lastIndexOf("@") + 1);
  const installPath = process.env.OPENCLAW_FORCE_USES_LEGACY_TARGET === "1"
    ? legacyPluginDir
    : process.env.OPENCLAW_NATIVE_DEFAULT_TARGET ||
      (args.includes("--force") ? process.env.OPENCLAW_MANAGED_INSTALL_DIR : legacyPluginDir);
  if (process.env.OPENCLAW_INSTALL_FORCE === "0" && fs.existsSync(installPath)) {
    process.stderr.write("native install target still exists\\n");
    process.exit(24);
  }
  const config = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  config.plugins = config.plugins || {};
  if (process.env.OPENCLAW_MODERN_STATE !== "1") {
    config.plugins.installs = config.plugins.installs || {};
    config.plugins.installs["openclaw-remnic"] = {
      source: installSource,
      spec: args[2],
      version: installVersion,
    };
  }
  fs.mkdirSync(require("node:path").dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config));
  if (process.env.OPENCLAW_BREAK_CONFIG_AFTER_INSTALL === "1") {
    fs.writeFileSync(configPath, "{");
  }
  fs.rmSync(installPath, { recursive: true, force: true });
  fs.mkdirSync(installPath, { recursive: true });
  fs.writeFileSync(installPath + "/new-install-marker", "installed\\n");
  fs.writeFileSync(markerPath, installPath);
  fs.writeFileSync(
    process.env.OPENCLAW_MANAGED_INDEX,
    JSON.stringify({
      installPath,
      spec: args[2],
      source: installSource,
      ...(installSource === "clawhub"
        ? { clawhubPackage: process.env.OPENCLAW_CLAWHUB_PACKAGE }
        : {}),
      version: installVersion,
    }),
  );
  if (process.env.OPENCLAW_INSTALL_FAIL_AFTER_MUTATION === "1") {
    process.stderr.write("managed install failed after mutation\\n");
    process.exit(25);
  }
  process.exit(0);
}

if (args[0] === "plugins" && args[1] === "inspect") {
  const record = fs.existsSync(process.env.OPENCLAW_MANAGED_INDEX)
    ? JSON.parse(fs.readFileSync(process.env.OPENCLAW_MANAGED_INDEX, "utf8"))
    : undefined;
  const installPath = record?.installPath ?? "";
  const loaded = installPath.length > 0 &&
    fs.existsSync(installPath + "/new-install-marker") &&
    process.env.FAIL_OPENCLAW_SMOKE !== "1";
  const inspection = {
    plugin: { id: "openclaw-remnic", status: loaded ? "loaded" : "error", version: record?.version },
    install: record ? {
      installPath,
      source: record.source,
      clawhubPackage: record.clawhubPackage,
      spec: record.spec,
      version: record.version,
    } : undefined,
    diagnostics: loaded ? [] : [{ level: "error", message: "managed plugin load failed" }],
  };
  process.stdout.write(JSON.stringify(args.includes("--all") ? [inspection] : inspection));
  process.exit(0);
}

process.exit(2);
`
  );

  return {
    configPath,
    env: {
      ...process.env,
      HOME: root,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --conditions=remnic-source`.trim(),
      OPENCLAW_MANAGED_MARKER: managedMarkerPath,
      OPENCLAW_MANAGED_INSTALL_DIR: managedInstallDir,
      OPENCLAW_LEGACY_PLUGIN_DIR: pluginDir,
      NPM_TEST_LOG: npmLogPath,
      OPENCLAW_TEST_LOG: openclawLogPath,
      OPENCLAW_MANAGED_INDEX: managedIndexPath,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    managedIndexPath,
    managedInstallDir,
    managedMarkerPath,
    openclawLogPath,
    npmLogPath,
    pluginDir,
    root,
  };
}

function runUpgradeWithFlags(
  fixture: UpgradeFixture,
  flags: string[],
  env: NodeJS.ProcessEnv = fixture.env,
  version = "9.49.0",
  includePluginDir = true
) {
  return spawnSync(
    process.execPath,
    [
      tsxCli,
      cliSource,
      "openclaw",
      "upgrade",
      ...flags,
      "--version",
      version,
      "--config",
      fixture.configPath,
      ...(includePluginDir ? ["--plugin-dir", fixture.pluginDir] : []),
    ],
    { encoding: "utf8", env, timeout: 30_000 }
  );
}

function runUpgrade(fixture: UpgradeFixture, env: NodeJS.ProcessEnv = fixture.env, version = "9.49.0") {
  return runUpgradeWithFlags(fixture, ["--yes", "--no-restart"], env, version);
}
function runUpgradeUsingDefaultPluginDir(
  fixture: UpgradeFixture,
  env: NodeJS.ProcessEnv = fixture.env,
  version = "9.49.0"
) {
  return runUpgradeWithFlags(fixture, ["--yes", "--no-restart"], env, version, false);
}

interface OpenclawCall {
  args: string[];
  configPath: string | null;
}

function readCalls(logPath: string): OpenclawCall[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split(/\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as OpenclawCall);
}

test("openclaw upgrade dry-run does not load or install a missing adapter", () => {
  const fixture = createUpgradeFixture();
  const loaderPath = writeMissingManagedUpgradeLoader(fixture.root);
  try {
    const result = runUpgradeWithFlags(fixture, ["--dry-run", "--no-restart"], {
      ...fixture.env,
      NODE_OPTIONS: `${fixture.env.NODE_OPTIONS ?? ""} --experimental-loader=${pathToFileURL(loaderPath).href}`.trim(),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DRY RUN/);
    assert.deepEqual(readCalls(fixture.npmLogPath), []);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("managed upgrade rejects non-registry package selectors before invoking OpenClaw", () => {
  const invalidSpecs = [
    "@remnic/plugin-openclaw@npm:other-package",
    "@remnic/plugin-openclaw@file:./plugin",
    "@remnic/plugin-openclaw@https://example.com/plugin.tgz",
    "@remnic/plugin-openclaw@./plugin.tgz",
    "@remnic/plugin-openclaw@git+https://example.com/plugin.git",
    "@remnic/plugin-openclaw@1.2.3-01",
    "@remnic/plugin-openclaw@1.2.3-1.01",
  ];

  for (const spec of invalidSpecs) {
    let commandInvoked = false;
    assert.throws(
      () =>
        installPublishedOpenclawPlugin(spec, "/missing/plugin", "/missing/managed", () => {
          commandInvoked = true;
          return "";
        }),
      /exact semantic version or npm dist-tag/,
      spec
    );
    assert.equal(commandInvoked, false, spec);
  }
});

test("managed upgrade rejects a loaded plugin that does not match an exact requested version", () => {
  const fixture = createUpgradeFixture();
  const inspection = JSON.stringify({
    plugin: { id: "openclaw-remnic", status: "loaded" },
    install: {
      installPath: fixture.pluginDir,
      source: "npm",
      spec: "npm:@remnic/plugin-openclaw@9.49.0",
      version: "9.49.0",
    },
  });

  try {
    assert.throws(
      () =>
        installPublishedOpenclawPlugin(
          "@remnic/plugin-openclaw@9.50.0",
          fixture.pluginDir,
          fixture.managedInstallDir,
          (args) => {
            if (args.includes("--help")) return "Usage: install npm:<spec> --force --runtime --json\n";
            if (args.includes("--all")) return `[${inspection}]`;
            if (args[1] === "inspect") return inspection;
            return "";
          }
        ),
      (error) => {
        assert.ok(error instanceof PublishedOpenclawPluginInstallError);
        assert.match(
          describeErrorWithCause(error),
          /reported plugin version "9\.49\.0".*requested exact version "9\.50\.0"/
        );
        return true;
      }
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("openclaw upgrade uses the host-managed npm project and verifies plugin load", () => {
  const fixture = createUpgradeFixture();
  try {
    const result = runUpgrade(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readCalls(fixture.openclawLogPath), [
      {
        args: ["plugins", "inspect", "--help"],
        configPath: fixture.configPath,
      },
      {
        args: ["plugins", "install", "--help"],
        configPath: fixture.configPath,
      },
      {
        args: ["plugins", "inspect", "--all", "--json"],
        configPath: fixture.configPath,
      },
      {
        args: ["plugins", "install", "npm:@remnic/plugin-openclaw@9.49.0", "--force"],
        configPath: fixture.configPath,
      },
      {
        args: ["plugins", "inspect", "openclaw-remnic", "--runtime", "--json"],
        configPath: fixture.configPath,
      },
      {
        args: ["plugins", "inspect", "openclaw-remnic", "--runtime", "--json"],
        configPath: fixture.configPath,
      },
    ]);
    assert.deepEqual(readCalls(fixture.npmLogPath), []);
    assert.equal(fs.existsSync(fixture.pluginDir), false);
    assert.equal(fs.readFileSync(fixture.managedMarkerPath, "utf8"), fixture.managedInstallDir);
    assert.equal(fs.readFileSync(path.join(fixture.managedInstallDir, "new-install-marker"), "utf8"), "installed\n");
    const config = JSON.parse(fs.readFileSync(fixture.configPath, "utf8")) as {
      plugins?: { installs?: Record<string, { source?: string; spec?: string }> };
    };
    assert.deepEqual(config.plugins?.installs?.["openclaw-remnic"], {
      source: "npm",
      version: "9.49.0",
      spec: "npm:@remnic/plugin-openclaw@9.49.0",
    });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("openclaw upgrade removes a managed install that fails after mutation", () => {
  const fixture = createUpgradeFixture();
  const originalConfig = fs.readFileSync(fixture.configPath, "utf8");
  try {
    const result = runUpgrade(fixture, {
      ...fixture.env,
      OPENCLAW_INSTALL_FAIL_AFTER_MUTATION: "1",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /managed install failed after mutation/);
    assert.equal(fs.readFileSync(fixture.configPath, "utf8"), originalConfig);
    assert.equal(fs.readFileSync(path.join(fixture.pluginDir, "old-install-marker"), "utf8"), "present\n");
    assert.equal(fs.existsSync(fixture.managedIndexPath), false);
    assert.equal(fs.existsSync(fixture.managedInstallDir), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("openclaw upgrade restores a same-target manual install when force install fails after mutation", () => {
  const fixture = createUpgradeFixture();
  const nativeTarget = path.join(fixture.root, ".openclaw", "extensions", "openclaw-remnic");
  fs.mkdirSync(path.dirname(nativeTarget), { recursive: true });
  fs.renameSync(fixture.pluginDir, nativeTarget);
  try {
    const result = runUpgrade(
      { ...fixture, pluginDir: nativeTarget },
      {
        ...fixture.env,
        OPENCLAW_INSTALL_FAIL_AFTER_MUTATION: "1",
        OPENCLAW_LEGACY_PLUGIN_DIR: nativeTarget,
        OPENCLAW_MANAGED_INSTALL_DIR: nativeTarget,
      }
    );

    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(path.join(nativeTarget, "old-install-marker"), "utf8"), "present\n");
    assert.equal(fs.existsSync(path.join(nativeTarget, "new-install-marker")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("openclaw upgrade restores an untracked native target when force install fails after mutation", () => {
  const fixture = createUpgradeFixture();
  const nativeTarget = path.join(fixture.root, ".openclaw", "extensions", "openclaw-remnic");
  fs.mkdirSync(nativeTarget, { recursive: true });
  fs.writeFileSync(path.join(nativeTarget, "old-native-marker"), "present\n", "utf8");
  try {
    const result = runUpgrade(fixture, {
      ...fixture.env,
      OPENCLAW_INSTALL_FAIL_AFTER_MUTATION: "1",
      OPENCLAW_MANAGED_INSTALL_DIR: nativeTarget,
    });

    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(path.join(nativeTarget, "old-native-marker"), "utf8"), "present\n");
    assert.equal(fs.existsSync(path.join(nativeTarget, "new-install-marker")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("openclaw upgrade restores the previous extension when managed plugin verification fails", () => {
  const fixture = createUpgradeFixture();
  const originalConfig = fs.readFileSync(fixture.configPath, "utf8");
  try {
    const result = runUpgrade(fixture, {
      ...fixture.env,
      FAIL_OPENCLAW_SMOKE: "1",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /OpenClaw reported plugin status "error"/);
    assert.equal(fs.readFileSync(fixture.configPath, "utf8"), originalConfig);
    assert.equal(fs.readFileSync(path.join(fixture.pluginDir, "old-install-marker"), "utf8"), "present\n");
    assert.equal(fs.existsSync(fixture.managedIndexPath), false);
    assert.equal(fs.existsSync(fixture.managedInstallDir), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("openclaw upgrade removes a new config when managed plugin verification fails", () => {
  const fixture = createUpgradeFixture();
  fs.rmSync(fixture.configPath);
  try {
    const result = runUpgrade(fixture, {
      ...fixture.env,
      FAIL_OPENCLAW_SMOKE: "1",
    });

    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(fixture.configPath), false);
    assert.equal(fs.existsSync(fixture.managedIndexPath), false);
    assert.equal(fs.existsSync(fixture.managedInstallDir), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
test("openclaw upgrade removes the native install when Remnic config update fails", () => {
  const fixture = createUpgradeFixture();
  const originalConfig = fs.readFileSync(fixture.configPath, "utf8");
  try {
    const result = runUpgrade(fixture, {
      ...fixture.env,
      OPENCLAW_BREAK_CONFIG_AFTER_INSTALL: "1",
    });

    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(fixture.configPath, "utf8"), originalConfig);
    assert.equal(fs.readFileSync(path.join(fixture.pluginDir, "old-install-marker"), "utf8"), "present\n");
    assert.equal(fs.existsSync(fixture.managedIndexPath), false);
    assert.equal(fs.existsSync(fixture.managedInstallDir), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("openclaw upgrade uses the legacy runtime-loading inspect contract when --runtime is unavailable", () => {
  const fixture = createUpgradeFixture();
  try {
    const result = runUpgrade(fixture, {
      ...fixture.env,
      OPENCLAW_INSPECT_RUNTIME: "0",
      OPENCLAW_INSTALL_FORCE: "0",
    });

    assert.equal(result.status, 0, result.stderr);
    const calls = readCalls(fixture.openclawLogPath);
    assert.deepEqual(calls[3], {
      args: ["plugins", "install", "@remnic/plugin-openclaw@9.49.0"],
      configPath: fixture.configPath,
    });
    assert.deepEqual(calls.at(-1), {
      args: ["plugins", "inspect", "openclaw-remnic", "--json"],
      configPath: fixture.configPath,
    });
    assert.equal(fs.readFileSync(path.join(fixture.pluginDir, "new-install-marker"), "utf8"), "installed\n");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("openclaw upgrade reinstalls a tracked plugin on a host without install force", () => {
  const fixture = createUpgradeFixture();
  const env = {
    ...fixture.env,
    OPENCLAW_INSPECT_RUNTIME: "0",
    OPENCLAW_INSTALL_FORCE: "0",
  };
  try {
    const firstResult = runUpgrade(fixture, env);
    assert.equal(firstResult.status, 0, firstResult.stderr);

    const secondResult = runUpgrade(fixture, env);
    assert.equal(secondResult.status, 0, secondResult.stderr);
    const mutationCalls = readCalls(fixture.openclawLogPath).filter(
      (call) => call.args[1] === "install" || call.args[1] === "uninstall"
    );
    assert.deepEqual(mutationCalls.slice(-2), [
      {
        args: ["plugins", "uninstall", "openclaw-remnic", "--force"],
        configPath: fixture.configPath,
      },
      {
        args: ["plugins", "install", "@remnic/plugin-openclaw@9.49.0"],
        configPath: fixture.configPath,
      },
    ]);
    assert.equal(fs.readFileSync(path.join(fixture.pluginDir, "new-install-marker"), "utf8"), "installed\n");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
test("openclaw upgrade does not treat a custom config directory as an install root", () => {
  const fixture = createUpgradeFixture();
  const nativeTarget = path.join(fixture.root, ".openclaw", "extensions", "openclaw-remnic");
  const customTarget = path.join(fixture.root, "custom-extension", "openclaw-remnic");
  fs.mkdirSync(nativeTarget, { recursive: true });
  fs.writeFileSync(path.join(nativeTarget, "old-install-marker"), "present\n");
  fs.mkdirSync(customTarget, { recursive: true });
  fs.writeFileSync(path.join(customTarget, "custom-install-marker"), "present\n");
  try {
    const result = runUpgrade(
      { ...fixture, pluginDir: customTarget },
      {
        ...fixture.env,
        OPENCLAW_INSPECT_RUNTIME: "0",
        OPENCLAW_INSTALL_FORCE: "0",
        OPENCLAW_LEGACY_PLUGIN_DIR: customTarget,
        OPENCLAW_NATIVE_DEFAULT_TARGET: nativeTarget,
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(nativeTarget, "old-install-marker")), false);
    assert.equal(fs.readFileSync(path.join(nativeTarget, "new-install-marker"), "utf8"), "installed\n");
    assert.equal(fs.existsSync(customTarget), false);
    assert.equal(fs.readFileSync(path.join(fixture.pluginDir, "old-install-marker"), "utf8"), "present\n");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("openclaw upgrade honors OPENCLAW_STATE_DIR for the native install target", () => {
  const fixture = createUpgradeFixture();
  const stateDir = path.join(fixture.root, "state");
  const nativeTarget = path.join(stateDir, "extensions", "openclaw-remnic");
  fs.mkdirSync(path.dirname(nativeTarget), { recursive: true });
  fs.renameSync(fixture.pluginDir, nativeTarget);
  try {
    const result = runUpgradeUsingDefaultPluginDir(fixture, {
      ...fixture.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_INSPECT_RUNTIME: "0",
      OPENCLAW_INSTALL_FORCE: "0",
      OPENCLAW_NATIVE_DEFAULT_TARGET: nativeTarget,
    });
    const backupRoot = path.join(fixture.root, ".openclaw", "backups");
    const backupDirs = fs.readdirSync(backupRoot);
    assert.equal(backupDirs.length, 1);
    const pluginBackupMarker = path.join(
      backupRoot,
      backupDirs[0],
      "extensions",
      "openclaw-remnic",
      "old-install-marker"
    );

    assert.equal(fs.readFileSync(pluginBackupMarker, "utf8"), "present\n");

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(nativeTarget, "old-install-marker")), false);
    assert.equal(fs.readFileSync(path.join(nativeTarget, "new-install-marker"), "utf8"), "installed\n");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("openclaw upgrade protects the compatibility-floor native target with a custom config path", () => {
  const fixture = createUpgradeFixture();
  const nativeTarget = path.join(fixture.root, ".openclaw", "extensions", "openclaw-remnic");
  fs.mkdirSync(path.dirname(nativeTarget), { recursive: true });
  fs.renameSync(fixture.pluginDir, nativeTarget);
  try {
    const result = runUpgrade(fixture, {
      ...fixture.env,
      OPENCLAW_INSPECT_RUNTIME: "0",
      OPENCLAW_INSTALL_FORCE: "0",
      OPENCLAW_NATIVE_DEFAULT_TARGET: nativeTarget,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(nativeTarget, "old-install-marker")), false);
    assert.equal(fs.readFileSync(path.join(nativeTarget, "new-install-marker"), "utf8"), "installed\n");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("managed install failures expose a native rollback that the caller can retry", () => {
  const fixture = createUpgradeFixture();
  const nativeTarget = fixture.pluginDir;
  const customTarget = path.join(fixture.root, "custom-extension", "openclaw-remnic");
  fs.mkdirSync(customTarget, { recursive: true });
  fs.writeFileSync(path.join(customTarget, "custom-install-marker"), "present\n");
  const originalRenameSync = fs.renameSync;
  const originalEnv = { ...process.env };
  let failedNativeRestore = false;
  let installError: PublishedOpenclawPluginInstallError | undefined;
  try {
    Object.assign(process.env, fixture.env, {
      FAIL_OPENCLAW_SMOKE: "1",
      OPENCLAW_INSPECT_RUNTIME: "0",
      OPENCLAW_INSTALL_FORCE: "0",
      OPENCLAW_LEGACY_PLUGIN_DIR: customTarget,
      OPENCLAW_NATIVE_DEFAULT_TARGET: nativeTarget,
    });
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (!failedNativeRestore && String(from).startsWith(`${nativeTarget}.rollback-`) && String(to) === nativeTarget) {
        failedNativeRestore = true;
        throw new Error("native restore busy");
      }
      return originalRenameSync(from, to);
    }) as typeof fs.renameSync;

    try {
      installPublishedOpenclawPlugin(
        "@remnic/plugin-openclaw@9.49.0",
        customTarget,
        nativeTarget,
        createOpenclawCommandRunner(fixture.configPath)
      );
    } catch (error) {
      assert.ok(error instanceof PublishedOpenclawPluginInstallError);
      installError = error;
    }

    const managedRollbackDir = installError?.managedRollbackDir;
    assert.ok(managedRollbackDir);
    assert.equal(fs.existsSync(managedRollbackDir), true);
    restoreDirectoryFromRollback(nativeTarget, managedRollbackDir);
    assert.equal(fs.readFileSync(path.join(nativeTarget, "old-install-marker"), "utf8"), "present\n");
  } finally {
    fs.renameSync = originalRenameSync;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("openclaw upgrade restores default and custom targets when custom-path verification fails", () => {
  const fixture = createUpgradeFixture();
  const nativeTarget = fixture.pluginDir;
  const customTarget = path.join(fixture.root, "custom-extension", "openclaw-remnic");
  fs.mkdirSync(customTarget, { recursive: true });
  fs.writeFileSync(path.join(customTarget, "custom-install-marker"), "present\n");
  try {
    const result = runUpgrade(
      { ...fixture, pluginDir: customTarget },
      {
        ...fixture.env,
        FAIL_OPENCLAW_SMOKE: "1",
        OPENCLAW_INSPECT_RUNTIME: "0",
        OPENCLAW_INSTALL_FORCE: "0",
        OPENCLAW_LEGACY_PLUGIN_DIR: customTarget,
        OPENCLAW_NATIVE_DEFAULT_TARGET: nativeTarget,
      }
    );

    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(path.join(nativeTarget, "old-install-marker"), "utf8"), "present\n");
    assert.equal(fs.existsSync(path.join(nativeTarget, "new-install-marker")), false);
    assert.equal(fs.readFileSync(path.join(customTarget, "custom-install-marker"), "utf8"), "present\n");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("openclaw upgrade discovers tracked installs from host state instead of openclaw.json", () => {
  const fixture = createUpgradeFixture();
  const env = {
    ...fixture.env,
    OPENCLAW_MODERN_STATE: "1",
  };
  try {
    const firstResult = runUpgrade(fixture, env);
    assert.equal(firstResult.status, 0, firstResult.stderr);
    const config = JSON.parse(fs.readFileSync(fixture.configPath, "utf8"));
    assert.equal(config.plugins?.installs, undefined);

    const secondResult = runUpgrade(fixture, env, "9.50.0");
    assert.equal(secondResult.status, 0, secondResult.stderr);
    const installCalls = readCalls(fixture.openclawLogPath).filter((call) => call.args[1] === "install");
    assert.deepEqual(installCalls.at(-1), {
      args: ["plugins", "install", "npm:@remnic/plugin-openclaw@9.50.0", "--force"],
      configPath: fixture.configPath,
    });
    const index = JSON.parse(fs.readFileSync(fixture.managedIndexPath, "utf8"));
    assert.equal(index.version, "9.50.0");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("openclaw upgrade restores a tracked install when Remnic config update fails", () => {
  const fixture = createUpgradeFixture();
  const originalConfig = fs.readFileSync(fixture.configPath, "utf8");
  fs.mkdirSync(fixture.managedInstallDir, { recursive: true });
  fs.writeFileSync(path.join(fixture.managedInstallDir, "new-install-marker"), "installed\n");
  fs.writeFileSync(
    fixture.managedIndexPath,
    JSON.stringify({
      installPath: fixture.managedInstallDir,
      source: "npm",
      spec: "npm:@remnic/plugin-openclaw@9.49.0",
      version: "9.49.0",
    })
  );
  try {
    const result = runUpgrade(
      fixture,
      {
        ...fixture.env,
        OPENCLAW_BREAK_CONFIG_AFTER_INSTALL: "1",
      },
      "9.50.0"
    );

    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(fixture.configPath, "utf8"), originalConfig);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.managedIndexPath, "utf8")), {
      installPath: fixture.managedInstallDir,
      source: "npm",
      spec: "npm:@remnic/plugin-openclaw@9.49.0",
      version: "9.49.0",
    });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("openclaw upgrade restores a tracked ClawHub install when replacement fails", () => {
  const fixture = createUpgradeFixture();
  const priorPackage = "@remnic/plugin-openclaw";
  const priorSpec = `clawhub:${priorPackage}@9.49.0`;
  fs.mkdirSync(fixture.managedInstallDir, { recursive: true });
  fs.writeFileSync(path.join(fixture.managedInstallDir, "new-install-marker"), "installed\n");
  fs.writeFileSync(
    fixture.managedIndexPath,
    JSON.stringify({
      installPath: fixture.managedInstallDir,
      source: "clawhub",
      spec: priorSpec,
      version: "9.49.0",
      clawhubPackage: priorPackage,
    })
  );
  try {
    const result = runUpgrade(
      fixture,
      {
        ...fixture.env,
        FAIL_OPENCLAW_SMOKE: "1",
        OPENCLAW_CLAWHUB_PACKAGE: priorPackage,
        OPENCLAW_CLAWHUB_RESTORE_VERSION: "9.49.0",
      },
      "9.50.0"
    );

    assert.notEqual(result.status, 0);
    const calls = readCalls(fixture.openclawLogPath);
    assert.ok(calls.some((call) => call.args[1] === "install" && call.args[2] === priorSpec));
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.managedIndexPath, "utf8")), {
      installPath: fixture.managedInstallDir,
      source: "clawhub",
      spec: priorSpec,
      clawhubPackage: priorPackage,
      version: "9.49.0",
    });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
test("openclaw upgrade restores a tracked install when replacement fails verification", () => {
  const fixture = createUpgradeFixture();
  const env = {
    ...fixture.env,
    OPENCLAW_INSPECT_RUNTIME: "0",
    OPENCLAW_INSTALL_FORCE: "0",
  };
  try {
    const firstResult = runUpgrade(fixture, env);
    assert.equal(firstResult.status, 0, firstResult.stderr);

    const secondResult = runUpgrade(fixture, { ...env, FAIL_OPENCLAW_SMOKE: "1" }, "9.50.0");
    assert.notEqual(secondResult.status, 0);
    const index = JSON.parse(fs.readFileSync(fixture.managedIndexPath, "utf8"));
    assert.equal(index.spec, "@remnic/plugin-openclaw@9.49.0");
    assert.equal(fs.readFileSync(path.join(fixture.pluginDir, "new-install-marker"), "utf8"), "installed\n");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
test("openclaw upgrade keeps a host-managed extension installed at the legacy target", () => {
  const fixture = createUpgradeFixture();
  try {
    const result = runUpgrade(fixture, {
      ...fixture.env,
      OPENCLAW_FORCE_USES_LEGACY_TARGET: "1",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(fixture.pluginDir, "new-install-marker"), "utf8"), "installed\n");
    assert.equal(fs.existsSync(path.join(fixture.pluginDir, "old-install-marker")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
test("openclaw upgrade refuses tracked installs with unsupported or incomplete registry metadata before mutation", () => {
  const cases = [
    {
      name: "unsupported source",
      record: {
        installPath: "",
        source: "path",
        spec: "/tmp/openclaw-remnic",
        version: "9.24.0",
      },
    },
    {
      name: "missing version",
      record: {
        installPath: "",
        source: "npm",
        spec: "npm:@remnic/plugin-openclaw",
      },
    },
    {
      name: "missing ClawHub package",
      record: {
        installPath: "",
        source: "clawhub",
        spec: "clawhub:@remnic/plugin-openclaw@9.24.0",
        version: "9.24.0",
      },
    },
  ];

  for (const testCase of cases) {
    const fixture = createUpgradeFixture();
    const originalConfig = fs.readFileSync(fixture.configPath, "utf8");
    const originalPlugin = fs.readFileSync(path.join(fixture.pluginDir, "old-install-marker"), "utf8");
    fs.writeFileSync(
      fixture.managedIndexPath,
      JSON.stringify({ ...testCase.record, installPath: fixture.managedInstallDir })
    );
    const originalIndex = fs.readFileSync(fixture.managedIndexPath, "utf8");
    try {
      const result = runUpgrade(fixture);

      assert.notEqual(result.status, 0, testCase.name);
      assert.match(result.stderr, /refusing a non-reversible update|refusing to replace/);
      assert.equal(fs.readFileSync(fixture.configPath, "utf8"), originalConfig, testCase.name);
      assert.equal(fs.readFileSync(path.join(fixture.pluginDir, "old-install-marker"), "utf8"), originalPlugin);
      assert.equal(fs.readFileSync(fixture.managedIndexPath, "utf8"), originalIndex, testCase.name);
      assert.equal(
        readCalls(fixture.openclawLogPath).some(
          (call) => (call.args[1] === "install" || call.args[1] === "uninstall") && !call.args.includes("--help")
        ),
        false,
        testCase.name
      );
      assert.equal(fs.existsSync(fixture.managedInstallDir), false, testCase.name);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("openclaw upgrade refuses symlinked plugin and managed roots before mutation", () => {
  const cases = [
    {
      name: "plugin root",
      setup: (fixture: UpgradeFixture): string => {
        const symlinkPath = path.join(fixture.root, "plugin-link");
        fs.symlinkSync(fixture.pluginDir, symlinkPath, "dir");
        return symlinkPath;
      },
    },
    {
      name: "managed root",
      setup: (fixture: UpgradeFixture): string => {
        const managedTargetDir = path.join(fixture.root, ".openclaw", "extensions", "openclaw-remnic");
        fs.mkdirSync(path.dirname(managedTargetDir), { recursive: true });
        fs.symlinkSync(fixture.pluginDir, managedTargetDir, "dir");
        return fixture.pluginDir;
      },
    },
  ];

  for (const testCase of cases) {
    const fixture = createUpgradeFixture();
    const originalConfig = fs.readFileSync(fixture.configPath, "utf8");
    try {
      const pluginDir = testCase.setup(fixture);
      const result = runUpgrade({ ...fixture, pluginDir });

      assert.notEqual(result.status, 0, testCase.name);
      assert.match(result.stderr, /must not be a symlink/);
      assert.equal(fs.readFileSync(fixture.configPath, "utf8"), originalConfig, testCase.name);
      assert.equal(fs.readFileSync(path.join(fixture.pluginDir, "old-install-marker"), "utf8"), "present\n");
      assert.equal(readCalls(fixture.openclawLogPath).length, 0, testCase.name);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("tracked rollback keeps a local copy when registry restore fails", () => {
  const fixture = createUpgradeFixture();
  const originalEnv = { ...process.env };
  fs.mkdirSync(fixture.managedInstallDir, { recursive: true });
  fs.writeFileSync(path.join(fixture.managedInstallDir, "old-managed-marker"), "present\n");
  fs.writeFileSync(
    fixture.managedIndexPath,
    JSON.stringify({
      installPath: fixture.managedInstallDir,
      source: "npm",
      spec: "npm:@remnic/plugin-openclaw@9.24.0",
      version: "9.24.0",
    })
  );
  let installError: PublishedOpenclawPluginInstallError | undefined;
  try {
    Object.assign(process.env, fixture.env, { OPENCLAW_INSTALL_FAIL_AFTER_MUTATION: "1" });
    try {
      installPublishedOpenclawPlugin(
        "@remnic/plugin-openclaw@9.49.0",
        fixture.pluginDir,
        fixture.managedInstallDir,
        createOpenclawCommandRunner(fixture.configPath)
      );
    } catch (error) {
      assert.ok(error instanceof PublishedOpenclawPluginInstallError);
      installError = error;
    }

    const managedRollbackDir = installError?.managedRollbackDir;
    assert.ok(managedRollbackDir);
    assert.equal(fs.readFileSync(path.join(managedRollbackDir, "old-managed-marker"), "utf8"), "present\n");
    restoreDirectoryFromRollback(fixture.managedInstallDir, managedRollbackDir);
    assert.equal(fs.readFileSync(path.join(fixture.managedInstallDir, "old-managed-marker"), "utf8"), "present\n");
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("openclaw upgrade restores local managed files when registry rollback fails", () => {
  const fixture = createUpgradeFixture();
  fs.mkdirSync(fixture.managedInstallDir, { recursive: true });
  fs.writeFileSync(path.join(fixture.managedInstallDir, "old-managed-marker"), "present\n");
  fs.writeFileSync(
    fixture.managedIndexPath,
    JSON.stringify({
      installPath: fixture.managedInstallDir,
      source: "npm",
      spec: "npm:@remnic/plugin-openclaw@9.24.0",
      version: "9.24.0",
    })
  );
  try {
    const result = runUpgrade(fixture, {
      ...fixture.env,
      OPENCLAW_INSTALL_FAIL_AFTER_MUTATION: "1",
    });

    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(path.join(fixture.managedInstallDir, "old-managed-marker"), "utf8"), "present\n");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

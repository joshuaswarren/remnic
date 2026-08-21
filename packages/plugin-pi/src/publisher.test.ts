import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path, { win32 } from "node:path";
import test from "node:test";

import { type PublishContext, loadTokenStore, saveTokenStore } from "@remnic/core";

import {
  OmpMemoryExtensionPublisher,
  PiMemoryExtensionPublisher,
  PrimeAgentMemoryExtensionPublisher,
  resolveBunBinary,
  resolveBunOnPath,
  resolveOmpWrapperImportSpecifier,
} from "./publisher.js";

class FailingPiPublisher extends PiMemoryExtensionPublisher {
  async renderInstructions(ctx: PublishContext): Promise<string> {
    await super.renderInstructions(ctx);
    throw new Error("readme write failed");
  }
}

class InterferedFailingPiPublisher extends PiMemoryExtensionPublisher {
  constructor(private readonly unrelatedPath: string) {
    super();
  }

  async renderInstructions(ctx: PublishContext): Promise<string> {
    await super.renderInstructions(ctx);
    fs.writeFileSync(this.unrelatedPath, "user-managed content\n");
    throw new Error("readme write failed");
  }
}

class ReplacedRootFailingPiPublisher extends PiMemoryExtensionPublisher {
  constructor(
    private readonly extensionRoot: string,
    private readonly symlinkTarget: string
  ) {
    super();
  }

  async renderInstructions(ctx: PublishContext): Promise<string> {
    await super.renderInstructions(ctx);
    fs.rmSync(this.extensionRoot, { recursive: true, force: true });
    fs.mkdirSync(this.symlinkTarget, { recursive: true });
    fs.writeFileSync(path.join(this.symlinkTarget, "remnic.config.json"), "external config\n");
    fs.writeFileSync(path.join(this.symlinkTarget, "index.ts"), "external wrapper\n");
    fs.symlinkSync(this.symlinkTarget, this.extensionRoot, "dir");
    throw new Error("readme write failed");
  }
}

class SymlinkSwapFailingPiPublisher extends PiMemoryExtensionPublisher {
  constructor(
    private readonly configPath: string,
    private readonly symlinkTarget: string,
  ) {
    super();
  }

  // Runs after config/wrapper are written (renderInstructions feeds the readme
  // write). Replace the just-written config with a symlink to an external file,
  // simulating an adversary swapping the file between snapshot and restore, then
  // fail so the rollback path runs.
  async renderInstructions(ctx: PublishContext): Promise<string> {
    await super.renderInstructions(ctx);
    fs.rmSync(this.configPath, { force: true });
    fs.symlinkSync(this.symlinkTarget, this.configPath, "file");
    throw new Error("readme write failed");
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }
  process.env[name] = value;
}

/**
 * Creates a fake `bun` binary that mimics `bun build <entry> --outdir=<dir>`
 * by writing a stub `index.js` (valid ESM default export) into the outdir.
 * Returned path is meant for `process.env.REMNIC_OMP_BUN_BIN` so tests can
 * exercise the omp pre-bundle path without a real bun on PATH.
 */
function createFakeBun(root: string): string {
  const binPath = path.join(root, "fake-bun");
  const script = [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    "const args = process.argv.slice(2);",
    'const outdirArg = args.find((a) => a.startsWith("--outdir="));',
    'if (!outdirArg) { console.error("fake-bun: --outdir missing"); process.exit(1); }',
    'const outdir = outdirArg.slice("--outdir=".length);',
    "fs.mkdirSync(outdir, { recursive: true });",
    'fs.writeFileSync(path.join(outdir, "index.js"), "export default async function remnicPiExtension() {}\\n");',
    "",
  ].join("\n");
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return binPath;
}

test("Pi publisher honors PI_CODING_AGENT_DIR for extension root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-publisher-dir-test-"));
  try {
    const publisher = new PiMemoryExtensionPublisher();
    const piDir = path.join(root, "pi-config");
    const extensionRoot = await publisher.resolveExtensionRoot({
      PI_CODING_AGENT_DIR: piDir,
      PI_AGENT_HOME: path.join(root, "wrong-agent-home"),
      PI_HOME: path.join(root, "wrong-pi-home"),
    });

    assert.equal(extensionRoot, path.join(piDir, "extensions", "remnic"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Pi publisher restores prior extension files and token-store entry when publish fails", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-publisher-test-"));
  const home = path.join(root, "home");
  const piAgentHome = path.join(root, "pi-agent");
  const extensionRoot = path.join(piAgentHome, "extensions", "remnic");
  const configPath = path.join(extensionRoot, "remnic.config.json");
  const wrapperPath = path.join(extensionRoot, "index.ts");
  const readmePath = path.join(extensionRoot, "README.md");
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ authToken: "old-token", remnicDaemonUrl: "http://old" }, null, 2)}\n`
  );
  fs.writeFileSync(wrapperPath, "old wrapper\n");
  fs.writeFileSync(readmePath, "old readme\n");

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousPiAgentHome = process.env.PI_AGENT_HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_AGENT_HOME = piAgentHome;
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_AGENT_HOME", previousPiAgentHome);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "pi", token: "new-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  const publisher = new FailingPiPublisher();
  await assert.rejects(
    () =>
      publisher.publish({
        config: { memoryDir: path.join(root, "memory") },
        skillsRoot: path.join(root, "memory", "skills"),
        rollbackTokenEntry: {
          connector: "pi",
          token: "old-token",
          createdAt: "2026-05-09T00:00:00.000Z",
        },
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      }),
    /readme write failed/
  );

  assert.equal(
    fs.readFileSync(configPath, "utf8"),
    `${JSON.stringify({ authToken: "old-token", remnicDaemonUrl: "http://old" }, null, 2)}\n`
  );
  assert.equal(fs.readFileSync(wrapperPath, "utf8"), "old wrapper\n");
  assert.equal(fs.readFileSync(readmePath, "utf8"), "old readme\n");
  const piToken = loadTokenStore().tokens.find((entry) => entry.connector === "pi");
  assert.equal(piToken?.token, "old-token");
});

test("Pi publisher rollback preserves unrelated files in a newly created extension root", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-publisher-rollback-root-test-"));
  const home = path.join(root, "home");
  const piAgentHome = path.join(root, "pi-agent");
  const extensionRoot = path.join(piAgentHome, "extensions", "remnic");
  const unrelatedPath = path.join(extensionRoot, "user-note.txt");
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousPiAgentHome = process.env.PI_AGENT_HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_AGENT_HOME = piAgentHome;
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_AGENT_HOME", previousPiAgentHome);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "pi", token: "new-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  const publisher = new InterferedFailingPiPublisher(unrelatedPath);
  await assert.rejects(
    () =>
      publisher.publish({
        config: { memoryDir: path.join(root, "memory") },
        skillsRoot: path.join(root, "memory", "skills"),
        rollbackTokenEntry: null,
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      }),
    /readme write failed/
  );

  assert.equal(fs.readFileSync(unrelatedPath, "utf8"), "user-managed content\n");
  assert.equal(fs.existsSync(path.join(extensionRoot, "remnic.config.json")), false);
  assert.equal(fs.existsSync(path.join(extensionRoot, "index.ts")), false);
  assert.equal(fs.existsSync(path.join(extensionRoot, "README.md")), false);
});

test("Pi publisher rollback refuses child cleanup when a new extension root becomes a symlink", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-publisher-rollback-symlink-test-"));
  const home = path.join(root, "home");
  const piAgentHome = path.join(root, "pi-agent");
  const extensionRoot = path.join(piAgentHome, "extensions", "remnic");
  const symlinkTarget = path.join(root, "external-remnic");
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousPiAgentHome = process.env.PI_AGENT_HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_AGENT_HOME = piAgentHome;
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_AGENT_HOME", previousPiAgentHome);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "pi", token: "new-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  const warnings: string[] = [];
  const publisher = new ReplacedRootFailingPiPublisher(extensionRoot, symlinkTarget);
  await assert.rejects(
    () =>
      publisher.publish({
        config: { memoryDir: path.join(root, "memory") },
        skillsRoot: path.join(root, "memory", "skills"),
        rollbackTokenEntry: null,
        log: {
          info: () => undefined,
          warn: (message) => warnings.push(message),
          error: () => undefined,
        },
      }),
    /readme write failed/
  );

  assert.match(warnings.join("\n"), /must not be a symlink/);
  assert.equal(fs.readFileSync(path.join(symlinkTarget, "remnic.config.json"), "utf8"), "external config\n");
  assert.equal(fs.readFileSync(path.join(symlinkTarget, "index.ts"), "utf8"), "external wrapper\n");
});

test("Pi publisher preserves user-managed extension settings on reinstall", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-publisher-preserve-test-"));
  const home = path.join(root, "home");
  const piAgentHome = path.join(root, "pi-agent");
  const extensionRoot = path.join(piAgentHome, "extensions", "remnic");
  const configPath = path.join(extensionRoot, "remnic.config.json");
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        remnicDaemonUrl: "http://old-daemon",
        authToken: "old-token",
        namespace: "old-namespace",
        recallMode: "minimal",
        recallTopK: 3,
        recallBudgetChars: 2048,
        recallEnabled: false,
        observeEnabled: false,
        observeSkipExtraction: true,
        compactionEnabled: false,
        mcpToolsEnabled: false,
        statusEnabled: false,
        requestTimeoutMs: 1234,
        startupRequestTimeoutMs: 2345,
      },
      null,
      2
    )}\n`
  );

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousPiAgentHome = process.env.PI_AGENT_HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_AGENT_HOME = piAgentHome;
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_AGENT_HOME", previousPiAgentHome);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "pi", token: "new-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  const publisher = new PiMemoryExtensionPublisher();
  await publisher.publish({
    config: {
      daemonUrl: "http://new-daemon/",
      memoryDir: path.join(root, "memory"),
      namespace: "new-namespace",
    },
    skillsRoot: path.join(root, "memory", "skills"),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

  const publishedConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  assert.equal(publishedConfig.remnicDaemonUrl, "http://new-daemon");
  assert.equal(publishedConfig.authToken, "new-token");
  assert.equal(publishedConfig.namespace, "new-namespace");
  assert.equal(publishedConfig.recallMode, "minimal");
  assert.equal(publishedConfig.recallTopK, 3);
  assert.equal(publishedConfig.recallBudgetChars, 2048);
  assert.equal(publishedConfig.recallEnabled, false);
  assert.equal(publishedConfig.observeEnabled, false);
  assert.equal(publishedConfig.observeSkipExtraction, true);
  assert.equal(publishedConfig.compactionEnabled, false);
  assert.equal(publishedConfig.mcpToolsEnabled, false);
  assert.equal(publishedConfig.statusEnabled, false);
  assert.equal(publishedConfig.requestTimeoutMs, 1234);
  assert.equal(publishedConfig.startupRequestTimeoutMs, 2345);
});

test("Pi publisher preserves existing namespace when reinstall omits namespace", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-publisher-namespace-test-"));
  const home = path.join(root, "home");
  const piAgentHome = path.join(root, "pi-agent");
  const extensionRoot = path.join(piAgentHome, "extensions", "remnic");
  const configPath = path.join(extensionRoot, "remnic.config.json");
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        remnicDaemonUrl: "http://old-daemon",
        authToken: "old-token",
        namespace: "manual-namespace",
      },
      null,
      2
    )}\n`
  );

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousPiAgentHome = process.env.PI_AGENT_HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_AGENT_HOME = piAgentHome;
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_AGENT_HOME", previousPiAgentHome);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "pi", token: "new-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  const publisher = new PiMemoryExtensionPublisher();
  await publisher.publish({
    config: {
      daemonUrl: "http://new-daemon/",
      memoryDir: path.join(root, "memory"),
    },
    skillsRoot: path.join(root, "memory", "skills"),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

  const publishedConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  assert.equal(publishedConfig.remnicDaemonUrl, "http://new-daemon");
  assert.equal(publishedConfig.authToken, "new-token");
  assert.equal(publishedConfig.namespace, "manual-namespace");
});

test("Pi publisher fails closed when existing config cannot be parsed", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-publisher-bad-config-"));
  const home = path.join(root, "home");
  const piAgentHome = path.join(root, "pi-agent");
  const extensionRoot = path.join(piAgentHome, "extensions", "remnic");
  const configPath = path.join(extensionRoot, "remnic.config.json");
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });
  fs.writeFileSync(configPath, "{bad-json");

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousPiAgentHome = process.env.PI_AGENT_HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_AGENT_HOME = piAgentHome;
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_AGENT_HOME", previousPiAgentHome);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "pi", token: "new-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  const publisher = new PiMemoryExtensionPublisher();
  await assert.rejects(
    () =>
      publisher.publish({
        config: { memoryDir: path.join(root, "memory") },
        skillsRoot: path.join(root, "memory", "skills"),
        rollbackTokenEntry: {
          connector: "pi",
          token: "old-token",
          createdAt: "2026-05-09T00:00:00.000Z",
        },
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      }),
    /Failed to load existing Remnic Pi config/
  );

  assert.equal(fs.readFileSync(configPath, "utf8"), "{bad-json");
  assert.equal(fs.existsSync(path.join(extensionRoot, "index.ts")), false);
  assert.equal(fs.existsSync(path.join(extensionRoot, "README.md")), false);
  assert.deepEqual(loadTokenStore().tokens, [
    {
      connector: "pi",
      token: "old-token",
      createdAt: "2026-05-09T00:00:00.000Z",
    },
  ]);
});

test("Pi publisher refuses a symlinked extension root", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-publisher-symlink-"));
  const home = path.join(root, "home");
  const piAgentHome = path.join(root, "pi-agent");
  const extensionsDir = path.join(piAgentHome, "extensions");
  const extensionRoot = path.join(extensionsDir, "remnic");
  const targetDir = path.join(root, "symlink-target");
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });
  fs.symlinkSync(targetDir, extensionRoot, "dir");

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousPiAgentHome = process.env.PI_AGENT_HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_AGENT_HOME = piAgentHome;
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_AGENT_HOME", previousPiAgentHome);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "pi", token: "new-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  const publisher = new PiMemoryExtensionPublisher();
  await assert.rejects(
    () =>
      publisher.publish({
        config: { memoryDir: path.join(root, "memory") },
        skillsRoot: path.join(root, "memory", "skills"),
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      }),
    /must not be a symlink/
  );

  assert.equal(fs.existsSync(path.join(targetDir, "remnic.config.json")), false);
  assert.equal(fs.existsSync(path.join(targetDir, "index.ts")), false);
});

test("Pi publisher unpublish removes only Remnic-owned files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-publisher-unpublish-preserve-"));
  const home = path.join(root, "home");
  const piAgentHome = path.join(root, "pi-agent");
  const extensionRoot = path.join(piAgentHome, "extensions", "remnic");
  const unrelatedPath = path.join(extensionRoot, "user-note.txt");
  const tempPath = path.join(extensionRoot, "remnic.config.json.tmp-123-456");
  const unrelatedTempPath = path.join(extensionRoot, "remnic.config.json.tmp-user-note");
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });
  fs.writeFileSync(path.join(extensionRoot, "remnic.config.json"), "{}\n");
  fs.writeFileSync(path.join(extensionRoot, "index.ts"), "export default {};\n");
  fs.writeFileSync(path.join(extensionRoot, "README.md"), "# Remnic\n");
  fs.writeFileSync(unrelatedPath, "user-managed content\n");
  fs.writeFileSync(tempPath, "temporary token-bearing config\n");
  fs.writeFileSync(unrelatedTempPath, "user-managed temp note\n");

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousPiAgentHome = process.env.PI_AGENT_HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_AGENT_HOME = piAgentHome;
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_AGENT_HOME", previousPiAgentHome);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const publisher = new PiMemoryExtensionPublisher();
  await publisher.unpublish();

  assert.equal(fs.existsSync(path.join(extensionRoot, "remnic.config.json")), false);
  assert.equal(fs.existsSync(path.join(extensionRoot, "index.ts")), false);
  assert.equal(fs.existsSync(path.join(extensionRoot, "README.md")), false);
  assert.equal(fs.existsSync(tempPath), false);
  assert.equal(fs.readFileSync(unrelatedPath, "utf8"), "user-managed content\n");
  assert.equal(fs.readFileSync(unrelatedTempPath, "utf8"), "user-managed temp note\n");
});

test("Pi publisher unpublish refuses owned file symlinks", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-publisher-unpublish-symlink-"));
  const home = path.join(root, "home");
  const piAgentHome = path.join(root, "pi-agent");
  const extensionRoot = path.join(piAgentHome, "extensions", "remnic");
  const targetDir = path.join(root, "symlink-target");
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });
  fs.writeFileSync(path.join(targetDir, "external-wrapper.ts"), "external wrapper\n");
  fs.writeFileSync(path.join(extensionRoot, "remnic.config.json"), "{}\n");
  fs.symlinkSync(path.join(targetDir, "external-wrapper.ts"), path.join(extensionRoot, "index.ts"));
  fs.writeFileSync(path.join(extensionRoot, "README.md"), "# Remnic\n");

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousPiAgentHome = process.env.PI_AGENT_HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_AGENT_HOME = piAgentHome;
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_AGENT_HOME", previousPiAgentHome);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const publisher = new PiMemoryExtensionPublisher();
  await assert.rejects(() => publisher.unpublish(), /must not be a symlink/);

  assert.equal(fs.readFileSync(path.join(targetDir, "external-wrapper.ts"), "utf8"), "external wrapper\n");
  assert.equal(fs.readFileSync(path.join(extensionRoot, "remnic.config.json"), "utf8"), "{}\n");
  assert.equal(fs.readFileSync(path.join(extensionRoot, "README.md"), "utf8"), "# Remnic\n");
});

// ── omp (oh-my-pi) publisher ────────────────────────────────────────────────

test("omp publisher exposes hostId omp and resolves the ~/.omp/agent extension root", async () => {
  const publisher = new OmpMemoryExtensionPublisher();
  assert.equal(publisher.hostId, "omp");
  assert.equal(
    await publisher.resolveExtensionRoot({ HOME: "/home/alice" }),
    path.join("/home/alice", ".omp", "agent", "extensions", "remnic"),
  );
});

test("omp publisher honors PI_CODING_AGENT_DIR for extension root", async () => {
  const publisher = new OmpMemoryExtensionPublisher();
  assert.equal(
    await publisher.resolveExtensionRoot({
      HOME: "/home/alice",
      PI_CODING_AGENT_DIR: "/custom/omp-agent",
    }),
    path.join("/custom/omp-agent", "extensions", "remnic"),
  );
});

test("omp publisher publishes config, wrapper, readme, pre-bundle loader, and manifest with the omp connector token", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-omp-publisher-test-"));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOmpProfile = process.env.OMP_PROFILE;
  const previousPiProfile = process.env.PI_PROFILE;
  const previousBunBin = process.env.REMNIC_OMP_BUN_BIN;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  process.env.REMNIC_OMP_BUN_BIN = createFakeBun(root);
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_CODING_AGENT_DIR", previousCodingAgentDir);
    restoreEnv("OMP_PROFILE", previousOmpProfile);
    restoreEnv("PI_PROFILE", previousPiProfile);
    restoreEnv("REMNIC_OMP_BUN_BIN", previousBunBin);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "omp", token: "omp-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  const publisher = new OmpMemoryExtensionPublisher();
  const result = await publisher.publish({
    config: {
      daemonUrl: "http://new-daemon/",
      memoryDir: path.join(root, "memory"),
      namespace: "ns-omp",
    },
    skillsRoot: path.join(root, "memory", "skills"),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

  const extensionRoot = path.join(home, ".omp", "agent", "extensions", "remnic");
  assert.equal(result.extensionRoot, extensionRoot);
  assert.equal(result.hostId, "omp");

  const cfg = JSON.parse(
    fs.readFileSync(path.join(extensionRoot, "remnic.config.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(cfg.authToken, "omp-token");
  assert.equal(cfg.namespace, "ns-omp");
  assert.equal(cfg.remnicDaemonUrl, "http://new-daemon");

  assert.ok(fs.existsSync(path.join(extensionRoot, "index.ts")));
  const readme = fs.readFileSync(path.join(extensionRoot, "README.md"), "utf8");
  assert.match(readme, /omp/i);

  // Pre-bundle infrastructure (issue #1598): loader.js + package.json + dist-bundle.
  const loaderPath = path.join(extensionRoot, "loader.js");
  const packageJsonPath = path.join(extensionRoot, "package.json");
  const bundleEntry = path.join(extensionRoot, "dist-bundle", "index.js");
  assert.ok(fs.existsSync(loaderPath), "loader.js was not written");
  assert.ok(fs.existsSync(packageJsonPath), "package.json was not written");
  assert.ok(fs.existsSync(bundleEntry), "dist-bundle/index.js was not produced");

  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
  const ompManifest = pkg.omp as { extensions?: string[] } | undefined;
  assert.deepEqual(ompManifest?.extensions, ["./loader.js"]);
  const scripts = pkg.scripts as { postinstall?: string } | undefined;
  assert.equal(scripts?.postinstall, "node postinstall-bundle.cjs", "postinstall must run the cross-platform Node helper");

  const loader = fs.readFileSync(loaderPath, "utf8");
  assert.match(loader, /bundleIsStale/, "loader must have staleness check");
  assert.match(loader, /dist-bundle/, "loader must reference dist-bundle");
});

test("omp publisher refuses a symlinked extension root", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-omp-publisher-symlink-"));
  const home = path.join(root, "home");
  const extensionsDir = path.join(home, ".omp", "agent", "extensions");
  const extensionRoot = path.join(extensionsDir, "remnic");
  const targetDir = path.join(root, "symlink-target");
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });
  fs.symlinkSync(targetDir, extensionRoot, "dir");

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOmpProfile = process.env.OMP_PROFILE;
  const previousPiProfile = process.env.PI_PROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_CODING_AGENT_DIR", previousCodingAgentDir);
    restoreEnv("OMP_PROFILE", previousOmpProfile);
    restoreEnv("PI_PROFILE", previousPiProfile);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "omp", token: "omp-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  const publisher = new OmpMemoryExtensionPublisher();
  await assert.rejects(
    () =>
      publisher.publish({
        config: { memoryDir: path.join(root, "memory") },
        skillsRoot: path.join(root, "memory", "skills"),
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      }),
    /must not be a symlink/,
  );

  assert.equal(fs.existsSync(path.join(targetDir, "remnic.config.json")), false);
  assert.equal(fs.existsSync(path.join(targetDir, "index.ts")), false);
});

test("omp publisher unpublish removes a profile-scoped install even without the profile env", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-omp-profile-remove-"));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousConfigDir = process.env.PI_CONFIG_DIR;
  const previousOmpProfile = process.env.OMP_PROFILE;
  const previousPiProfile = process.env.PI_PROFILE;
  const previousBunBin = process.env.REMNIC_OMP_BUN_BIN;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CONFIG_DIR;
  delete process.env.PI_PROFILE;
  process.env.REMNIC_OMP_BUN_BIN = createFakeBun(root);
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_CODING_AGENT_DIR", previousCodingAgentDir);
    restoreEnv("PI_CONFIG_DIR", previousConfigDir);
    restoreEnv("OMP_PROFILE", previousOmpProfile);
    restoreEnv("PI_PROFILE", previousPiProfile);
    restoreEnv("REMNIC_OMP_BUN_BIN", previousBunBin);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "omp", token: "omp-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  // Install under the "work" profile.
  process.env.OMP_PROFILE = "work";
  const profileRoot = path.join(home, ".omp", "profiles", "work", "agent", "extensions", "remnic");
  const installResult = await new OmpMemoryExtensionPublisher().publish({
    config: { memoryDir: path.join(root, "memory") },
    skillsRoot: path.join(root, "memory", "skills"),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  assert.equal(installResult.extensionRoot, profileRoot);
  assert.ok(fs.existsSync(path.join(profileRoot, "remnic.config.json")));
  assert.ok(fs.existsSync(path.join(profileRoot, "loader.js")), "loader.js was not installed");
  assert.ok(fs.existsSync(path.join(profileRoot, "dist-bundle", "index.js")), "bundle was not installed");

  // Remove WITHOUT the profile env set — must still find and remove the
  // profile-scoped install instead of no-oping on the default agent dir.
  delete process.env.OMP_PROFILE;
  await new OmpMemoryExtensionPublisher().unpublish();

  assert.equal(fs.existsSync(path.join(profileRoot, "remnic.config.json")), false);
  assert.equal(fs.existsSync(path.join(profileRoot, "index.ts")), false);
  assert.equal(fs.existsSync(path.join(profileRoot, "README.md")), false);
  assert.equal(fs.existsSync(path.join(profileRoot, "loader.js")), false, "loader.js was not removed");
  assert.equal(fs.existsSync(path.join(profileRoot, "package.json")), false, "package.json was not removed");
  assert.equal(fs.existsSync(path.join(profileRoot, "dist-bundle")), false, "dist-bundle was not removed");
});

test("omp publisher fails with a clear message when bun is absent", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-omp-no-bun-"));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOmpProfile = process.env.OMP_PROFILE;
  const previousPiProfile = process.env.PI_PROFILE;
  const previousBunBin = process.env.REMNIC_OMP_BUN_BIN;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  // Point to a nonexistent binary so resolveBunBinary returns null.
  process.env.REMNIC_OMP_BUN_BIN = path.join(root, "does-not-exist");
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_CODING_AGENT_DIR", previousCodingAgentDir);
    restoreEnv("OMP_PROFILE", previousOmpProfile);
    restoreEnv("PI_PROFILE", previousPiProfile);
    restoreEnv("REMNIC_OMP_BUN_BIN", previousBunBin);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "omp", token: "omp-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  const publisher = new OmpMemoryExtensionPublisher();
  await assert.rejects(
    () =>
      publisher.publish({
        config: { memoryDir: path.join(root, "memory") },
        skillsRoot: path.join(root, "memory", "skills"),
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      }),
    /requires `bun`.*omp/i,
  );

  // Rollback: the extension root was newly created, so it must be cleaned up.
  const extensionRoot = path.join(home, ".omp", "agent", "extensions", "remnic");
  assert.equal(fs.existsSync(extensionRoot), false, "extension root must be cleaned up on rollback");
});

test("omp publisher rolls back shared files when bun build fails", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-omp-bundle-fail-"));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });

  // Pre-populate the extension root with prior files so we can verify rollback
  // restores them rather than deleting the root.
  const extensionRoot = path.join(home, ".omp", "agent", "extensions", "remnic");
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.writeFileSync(path.join(extensionRoot, "remnic.config.json"), '{"prior":true}\n');
  fs.writeFileSync(path.join(extensionRoot, "index.ts"), "// prior wrapper\n");
  fs.writeFileSync(path.join(extensionRoot, "README.md"), "prior readme\n");

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOmpProfile = process.env.OMP_PROFILE;
  const previousPiProfile = process.env.PI_PROFILE;
  const previousBunBin = process.env.REMNIC_OMP_BUN_BIN;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  // Fake bun that always fails.
  const failingBun = path.join(root, "failing-bun");
  fs.writeFileSync(
    failingBun,
    ['#!/usr/bin/env node', 'console.error("simulated bun build failure"); process.exit(1);', ""].join("\n"),
    { mode: 0o755 },
  );
  process.env.REMNIC_OMP_BUN_BIN = failingBun;
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_CODING_AGENT_DIR", previousCodingAgentDir);
    restoreEnv("OMP_PROFILE", previousOmpProfile);
    restoreEnv("PI_PROFILE", previousPiProfile);
    restoreEnv("REMNIC_OMP_BUN_BIN", previousBunBin);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "omp", token: "omp-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  const publisher = new OmpMemoryExtensionPublisher();
  await assert.rejects(
    () =>
      publisher.publish({
        config: { memoryDir: path.join(root, "memory") },
        skillsRoot: path.join(root, "memory", "skills"),
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      }),
    /bun build failed/i,
  );

  // Prior files must be restored to their original content.
  assert.equal(fs.readFileSync(path.join(extensionRoot, "remnic.config.json"), "utf8"), '{"prior":true}\n');
  assert.equal(fs.readFileSync(path.join(extensionRoot, "index.ts"), "utf8"), "// prior wrapper\n");
  assert.equal(fs.readFileSync(path.join(extensionRoot, "README.md"), "utf8"), "prior readme\n");
  // dist-bundle must not exist (rollback cleans newly created dirs).
  assert.equal(fs.existsSync(path.join(extensionRoot, "dist-bundle")), false, "dist-bundle must be cleaned up on rollback");
});

// ── Regression (PR #1641 / #1598): a failed omp pre-bundle (bun missing or
// `bun build` failing) must NOT roll back the connector token. The CLI commits
// the new token before publishing and the loader self-heals dist-bundle on
// first load; destroying the token leaves the connector installed with no
// credential and blocks a non-`--force` reinstall (AGENTS.md #14).
test("omp publisher keeps the connector token when pre-bundling fails", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-omp-token-preserve-"));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOmpProfile = process.env.OMP_PROFILE;
  const previousPiProfile = process.env.PI_PROFILE;
  const previousBunBin = process.env.REMNIC_OMP_BUN_BIN;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  // No bun available → resolveBunBinary returns null → pre-bundle fails.
  process.env.REMNIC_OMP_BUN_BIN = path.join(root, "does-not-exist");
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_CODING_AGENT_DIR", previousCodingAgentDir);
    restoreEnv("OMP_PROFILE", previousOmpProfile);
    restoreEnv("PI_PROFILE", previousPiProfile);
    restoreEnv("REMNIC_OMP_BUN_BIN", previousBunBin);
    fs.rmSync(root, { recursive: true, force: true });
  });

  // The CLI has already committed the new omp token; there was no prior token.
  saveTokenStore({
    tokens: [{ connector: "omp", token: "omp-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  const publisher = new OmpMemoryExtensionPublisher();
  await assert.rejects(
    () =>
      publisher.publish({
        config: { memoryDir: path.join(root, "memory") },
        skillsRoot: path.join(root, "memory", "skills"),
        rollbackTokenEntry: null,
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      }),
    /requires `bun`.*omp/i,
  );

  // The committed token must survive the pre-bundle failure.
  const ompToken = loadTokenStore().tokens.find((entry) => entry.connector === "omp");
  assert.equal(ompToken?.token, "omp-token", "omp token must be preserved when pre-bundling fails");
});

test("omp publisher loader.js embeds the plugin-pi dist path for mtime self-healing", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-omp-loader-path-"));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOmpProfile = process.env.OMP_PROFILE;
  const previousPiProfile = process.env.PI_PROFILE;
  const previousBunBin = process.env.REMNIC_OMP_BUN_BIN;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  process.env.REMNIC_OMP_BUN_BIN = createFakeBun(root);
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_CODING_AGENT_DIR", previousCodingAgentDir);
    restoreEnv("OMP_PROFILE", previousOmpProfile);
    restoreEnv("PI_PROFILE", previousPiProfile);
    restoreEnv("REMNIC_OMP_BUN_BIN", previousBunBin);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "omp", token: "omp-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  await new OmpMemoryExtensionPublisher().publish({
    config: { memoryDir: path.join(root, "memory") },
    skillsRoot: path.join(root, "memory", "skills"),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

  const extensionRoot = path.join(home, ".omp", "agent", "extensions", "remnic");
  const loader = fs.readFileSync(path.join(extensionRoot, "loader.js"), "utf8");
  const wrapper = fs.readFileSync(path.join(extensionRoot, "index.ts"), "utf8");

  // omp pre-bundles the wrapper with `bun build`, whose bundler cannot resolve
  // file:// specifiers (verified Bun 1.2–1.3: "Could not resolve: file://...").
  // The wrapper must therefore use a relative import specifier; the loader
  // still embeds the absolute plugin-pi dist path for mtime self-healing.
  assert.doesNotMatch(
    wrapper,
    /from\s+"file:\/\//,
    "omp wrapper must not use a file:// import (bun build cannot resolve it)",
  );
  const relMatch = wrapper.match(/from\s+"(\.\.?\/[^"]+)"/);
  assert.ok(relMatch, "omp wrapper must use a relative import specifier for bun build");
  const resolvedPluginPiEntry = path.resolve(extensionRoot, relMatch[1]);
  assert.ok(
    loader.includes(JSON.stringify(resolvedPluginPiEntry)),
    `loader must embed the plugin-pi dist path (${resolvedPluginPiEntry}) for mtime comparison`,
  );
});

// ── Regression (PR #1641 / #1598): the pre-existing dist-bundle must survive a
// failed final swap. runBundleBuild renames the old bundle aside, moves the new
// one in, and restores the backup if the final rename fails — it never removes
// the working bundle before the new one is in place.
test("omp publisher preserves the existing dist-bundle when the final bundle swap fails", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-omp-bundle-swap-fail-"));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });

  // Stand up an extension root whose existing dist-bundle holds a working bundle.
  const extensionRoot = path.join(home, ".omp", "agent", "extensions", "remnic");
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.mkdirSync(path.join(extensionRoot, "dist-bundle"), { recursive: true });
  fs.writeFileSync(
    path.join(extensionRoot, "dist-bundle", "index.js"),
    "export default async function prior() { return \"prior-bundle\"; }\n",
  );

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOmpProfile = process.env.OMP_PROFILE;
  const previousPiProfile = process.env.PI_PROFILE;
  const previousBunBin = process.env.REMNIC_OMP_BUN_BIN;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  process.env.REMNIC_OMP_BUN_BIN = createFakeBun(root);
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_CODING_AGENT_DIR", previousCodingAgentDir);
    restoreEnv("OMP_PROFILE", previousOmpProfile);
    restoreEnv("PI_PROFILE", previousPiProfile);
    restoreEnv("REMNIC_OMP_BUN_BIN", previousBunBin);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "omp", token: "omp-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  // Sabotage only the final tmp->dist-bundle rename so the new build succeeds
  // but the swap fails. The backup rename (dist-bundle -> .bak-*) still works.
  const realRenameSync = fs.renameSync;
  let swapFailed = false;
  fs.renameSync = function sabotagedRenameSync(from, to) {
    if (typeof to === "string" && to.endsWith(path.join(extensionRoot, "dist-bundle")) &&
        typeof from === "string" && from.includes(".dist-bundle.tmp-")) {
      swapFailed = true;
      throw Object.assign(new Error("simulated swap failure"), { code: "EUNKNOWN" });
    }
    return realRenameSync.call(fs, from, to);
  };
  t.after(() => { fs.renameSync = realRenameSync; });

  const publisher = new OmpMemoryExtensionPublisher();
  await assert.rejects(
    () =>
      publisher.publish({
        config: { memoryDir: path.join(root, "memory") },
        skillsRoot: path.join(root, "memory", "skills"),
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      }),
    /failed to finalize bundle output/i,
  );

  assert.ok(swapFailed, "the final swap must have been attempted and failed");
  // The working bundle must still be in place — the install is never left bundle-less.
  assert.equal(
    fs.readFileSync(path.join(extensionRoot, "dist-bundle", "index.js"), "utf8"),
    'export default async function prior() { return "prior-bundle"; }\n',
    "pre-existing dist-bundle must be restored after a failed swap",
  );
  // No leftover tmp or backup dirs.
  for (const entry of fs.readdirSync(extensionRoot)) {
    assert.ok(
      !entry.startsWith(".dist-bundle.tmp-") && !entry.startsWith(".dist-bundle.bak-"),
      `leftover bundle temp/backup dir not cleaned: ${entry}`,
    );
  }
});

// ── Regression (PR #1641 / #1598): the generated loader.js must reuse the bun
// path resolved at install time so self-healing works when bun is reachable
// only via REMNIC_OMP_BUN_BIN or a common absolute path that is not on omp's
// runtime PATH.
test("omp publisher loader.js embeds the resolved bun path for self-healing rebuilds", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-omp-loader-bun-path-"));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOmpProfile = process.env.OMP_PROFILE;
  const previousPiProfile = process.env.PI_PROFILE;
  const previousBunBin = process.env.REMNIC_OMP_BUN_BIN;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  const resolvedBun = createFakeBun(root);
  process.env.REMNIC_OMP_BUN_BIN = resolvedBun;
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_CODING_AGENT_DIR", previousCodingAgentDir);
    restoreEnv("OMP_PROFILE", previousOmpProfile);
    restoreEnv("PI_PROFILE", previousPiProfile);
    restoreEnv("REMNIC_OMP_BUN_BIN", previousBunBin);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "omp", token: "omp-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  await new OmpMemoryExtensionPublisher().publish({
    config: { memoryDir: path.join(root, "memory") },
    skillsRoot: path.join(root, "memory", "skills"),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

  const extensionRoot = path.join(home, ".omp", "agent", "extensions", "remnic");
  const loader = fs.readFileSync(path.join(extensionRoot, "loader.js"), "utf8");

  // The resolved absolute bun path must be embedded and used by the rebuild.
  assert.ok(
    loader.includes(JSON.stringify(resolvedBun)),
    `loader must embed the resolved bun path (${resolvedBun}) for self-healing`,
  );
  assert.match(loader, /resolvedBunBin/, "loader must declare resolvedBunBin");
  assert.match(
    loader,
    /spawnSync\(bunForRebuild/,
    "loader's rebuildBundle must spawn bunForRebuild, not a hardcoded \"bun\"",
  );
  assert.doesNotMatch(
    loader,
    /spawnSync\(\"bun\"/,
    "loader must not hardcode spawnSync(\"bun\", ...) for rebuilds",
  );
});

// ── Regression (PR #1641 / #1598): resolveBunBinary must honour USERPROFILE
// (matching omp's path helpers) so the ~/.bun/bin/bun fallback resolves on
// Windows installs where HOME is unset.
test("omp publisher resolveBunBinary falls back to USERPROFILE/.bun when HOME is unset", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-omp-bun-userprofile-"));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });
  // Plant a bun binary under the USERPROFILE home so the candidate lookup finds it.
  fs.mkdirSync(path.join(home, ".bun", "bin"), { recursive: true });
  const userprofileBun = path.join(home, ".bun", "bin", "bun");
  fs.writeFileSync(
    userprofileBun,
    createFakeBunScript(),
    { mode: 0o755 },
  );

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOmpProfile = process.env.OMP_PROFILE;
  const previousPiProfile = process.env.PI_PROFILE;
  const previousBunBin = process.env.REMNIC_OMP_BUN_BIN;
  const previousPath = process.env.PATH;
  // Force the PATH probe to fail so resolveBunBinary must use the USERPROFILE
  // candidate. Empty PATH only affects spawnSync("bun") (ENOENT); the candidate
  // is invoked as an absolute path and needs no PATH.
  delete process.env.HOME;
  process.env.USERPROFILE = home;
  delete process.env.REMNIC_OMP_BUN_BIN;
  process.env.PATH = "/usr/bin";
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_CODING_AGENT_DIR", previousCodingAgentDir);
    restoreEnv("OMP_PROFILE", previousOmpProfile);
    restoreEnv("PI_PROFILE", previousPiProfile);
    restoreEnv("REMNIC_OMP_BUN_BIN", previousBunBin);
    restoreEnv("PATH", previousPath);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "omp", token: "omp-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  // Publish must succeed: resolveBunBinary found the USERPROFILE-relative bun,
  // pre-bundled, and wrote loader.js + dist-bundle.
  const result = await new OmpMemoryExtensionPublisher().publish({
    config: { memoryDir: path.join(root, "memory") },
    skillsRoot: path.join(root, "memory", "skills"),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

  const extensionRoot = result.extensionRoot;
  assert.ok(fs.existsSync(path.join(extensionRoot, "dist-bundle", "index.js")), "dist-bundle produced via USERPROFILE-resolved bun");
  const loader = fs.readFileSync(path.join(extensionRoot, "loader.js"), "utf8");
  assert.ok(
    loader.includes(JSON.stringify(userprofileBun)),
    "loader must embed the USERPROFILE-resolved bun path",
  );
});

/**
 * Returns the fake-bun script body (writes a stub index.js into --outdir),
 * matching createFakeBun but without writing to disk. Used by tests that need
 * to plant the binary at a specific absolute path (e.g. ~/.bun/bin/bun).
 */
function createFakeBunScript(): string {
  return [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    "const args = process.argv.slice(2);",
    'const outdirArg = args.find((a) => a.startsWith("--outdir="));',
    'if (!outdirArg) { console.error("fake-bun: --outdir missing"); process.exit(1); }',
    'const outdir = outdirArg.slice("--outdir=".length);',
    "fs.mkdirSync(outdir, { recursive: true });",
    'fs.writeFileSync(path.join(outdir, "index.js"), "export default async function remnicPiExtension() {}\\n");',
    "",
  ].join("\n");
}

// ── Regression (PR #1641 / #1598, P1): omp pre-bundles index.ts with
// `bun build`, whose bundler cannot resolve file:// import specifiers. The
// generated wrapper must use a relative specifier so a real bun build produces
// dist-bundle (the fake-bun tests never parse the entry, so this is the only
// guard against the file:// regression).
test("omp publisher wrapper is bun-buildable (relative import, not file://)", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-omp-wrapper-bunbuild-"));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOmpProfile = process.env.OMP_PROFILE;
  const previousPiProfile = process.env.PI_PROFILE;
  const previousBunBin = process.env.REMNIC_OMP_BUN_BIN;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  process.env.REMNIC_OMP_BUN_BIN = createFakeBun(root);
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_CODING_AGENT_DIR", previousCodingAgentDir);
    restoreEnv("OMP_PROFILE", previousOmpProfile);
    restoreEnv("PI_PROFILE", previousPiProfile);
    restoreEnv("REMNIC_OMP_BUN_BIN", previousBunBin);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "omp", token: "omp-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  await new OmpMemoryExtensionPublisher().publish({
    config: { memoryDir: path.join(root, "memory") },
    skillsRoot: path.join(root, "memory", "skills"),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

  const extensionRoot = path.join(home, ".omp", "agent", "extensions", "remnic");
  const wrapperPath = path.join(extensionRoot, "index.ts");
  const wrapper = fs.readFileSync(wrapperPath, "utf8");
  assert.doesNotMatch(
    wrapper,
    /from\s+"file:\/\//,
    "omp wrapper must not use a file:// import (bun build cannot resolve it)",
  );
  assert.match(wrapper, /from\s+"\.\.?\//, "omp wrapper must use a relative import specifier");

  // Live `bun build` of the generated wrapper is not feasible in this
  // isolated test: plugin-pi's transitive bare-specifier imports (e.g.
  // `@remnic/core`) need the real omp node_modules layout to resolve. The
  // specifier fix itself was verified during development with a self-contained
  // target — `file://` fails with "Could not resolve" on Bun 1.2–1.3 while a
  // relative specifier produces the bundle — so here we guard the mechanism
  // (relative, not file://) that makes a real install buildable.
});

// ── Regression (PR #1641 / #1598): package.json postinstall must reuse the
// resolved bun path so `npm install` re-bundles on systems where bun is not on
// the PATH npm inherits.
test("omp publisher writes a cross-platform postinstall-bundle.cjs that embeds the resolved bun path", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-omp-postinstall-cjs-"));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOmpProfile = process.env.OMP_PROFILE;
  const previousPiProfile = process.env.PI_PROFILE;
  const previousBunBin = process.env.REMNIC_OMP_BUN_BIN;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  const resolvedBun = createFakeBun(root);
  process.env.REMNIC_OMP_BUN_BIN = resolvedBun;
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_CODING_AGENT_DIR", previousCodingAgentDir);
    restoreEnv("OMP_PROFILE", previousOmpProfile);
    restoreEnv("PI_PROFILE", previousPiProfile);
    restoreEnv("REMNIC_OMP_BUN_BIN", previousBunBin);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "omp", token: "omp-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  await new OmpMemoryExtensionPublisher().publish({
    config: { memoryDir: path.join(root, "memory") },
    skillsRoot: path.join(root, "memory", "skills"),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

  const extensionRoot = path.join(home, ".omp", "agent", "extensions", "remnic");
  const pkg = JSON.parse(fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8")) as {
    scripts: { postinstall: string };
  };
  // npm runs scripts via cmd.exe on Windows by default; a Node-only helper is
  // the only cross-platform shape, so package.json just invokes it.
  assert.equal(pkg.scripts.postinstall, "node postinstall-bundle.cjs");

  const helperPath = path.join(extensionRoot, "postinstall-bundle.cjs");
  assert.ok(fs.existsSync(helperPath), "postinstall-bundle.cjs must be written");
  const helper = fs.readFileSync(helperPath, "utf8");
  assert.ok(
    helper.includes(resolvedBun),
    `postinstall helper must embed the resolved bun path (${resolvedBun})`,
  );
  assert.match(helper, /function pickBun/, "helper must resolve bun with a PATH fallback");
  assert.match(helper, /\.dist-bundle\.bak-/, "helper must swap bundles atomically (backup dir)");

  // The helper must be syntactically valid Node (no shell-specific syntax).
  const syntaxCheck = spawnSync(process.execPath, ["--check", helperPath], { encoding: "utf-8" });
  assert.equal(syntaxCheck.status, 0, `postinstall-bundle.cjs fails node --check: ${syntaxCheck.stderr}`);

  // Running the helper must rebuild dist-bundle via the embedded bun path.
  fs.rmSync(path.join(extensionRoot, "dist-bundle"), { recursive: true, force: true });
  const run = spawnSync(process.execPath, [helperPath], {
    cwd: extensionRoot,
    encoding: "utf-8",
  });
  assert.equal(run.status, 0, `postinstall helper failed to rebuild: ${run.stderr ?? run.stdout}`);
  assert.ok(
    fs.existsSync(path.join(extensionRoot, "dist-bundle", "index.js")),
    "postinstall helper must regenerate dist-bundle/index.js",
  );
});

// ── Regression (PR #1641 / #1598): the official Bun Windows installer ships
// bun.exe; resolveBunBinary must probe it (fs.existsSync does not apply PATHEXT).
test("omp publisher resolveBunBinary finds ~/.bun/bin/bun.exe (Windows installer layout)", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-omp-bun-exe-"));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });
  // Plant ONLY bun.exe (no bun) under the home, mirroring the Windows installer.
  fs.mkdirSync(path.join(home, ".bun", "bin"), { recursive: true });
  const bunExe = path.join(home, ".bun", "bin", "bun.exe");
  fs.writeFileSync(bunExe, createFakeBunScript(), { mode: 0o755 });

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOmpProfile = process.env.OMP_PROFILE;
  const previousPiProfile = process.env.PI_PROFILE;
  const previousBunBin = process.env.REMNIC_OMP_BUN_BIN;
  const previousPath = process.env.PATH;
  delete process.env.HOME;
  process.env.USERPROFILE = home;
  delete process.env.REMNIC_OMP_BUN_BIN;
  process.env.PATH = "/usr/bin"; // force the PATH probe to fail → candidate lookup
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_CODING_AGENT_DIR", previousCodingAgentDir);
    restoreEnv("OMP_PROFILE", previousOmpProfile);
    restoreEnv("PI_PROFILE", previousPiProfile);
    restoreEnv("REMNIC_OMP_BUN_BIN", previousBunBin);
    restoreEnv("PATH", previousPath);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "omp", token: "omp-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  const result = await new OmpMemoryExtensionPublisher().publish({
    config: { memoryDir: path.join(root, "memory") },
    skillsRoot: path.join(root, "memory", "skills"),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  assert.ok(
    fs.existsSync(path.join(result.extensionRoot, "dist-bundle", "index.js")),
    "publish must succeed via the ~/.bun/bin/bun.exe candidate",
  );
});

// ── Regression (PR #1641 / #1598): the loader's self-heal rebuild must build to
// a temp dir and swap (mirroring runBundleBuild), never writing --outdir
// straight into dist-bundle where a failure could corrupt the working bundle.
test("omp publisher loader rebuilds via a temp dir swap, not an in-place build", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-omp-loader-swap-"));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOmpProfile = process.env.OMP_PROFILE;
  const previousPiProfile = process.env.PI_PROFILE;
  const previousBunBin = process.env.REMNIC_OMP_BUN_BIN;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  process.env.REMNIC_OMP_BUN_BIN = createFakeBun(root);
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_CODING_AGENT_DIR", previousCodingAgentDir);
    restoreEnv("OMP_PROFILE", previousOmpProfile);
    restoreEnv("PI_PROFILE", previousPiProfile);
    restoreEnv("REMNIC_OMP_BUN_BIN", previousBunBin);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "omp", token: "omp-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  await new OmpMemoryExtensionPublisher().publish({
    config: { memoryDir: path.join(root, "memory") },
    skillsRoot: path.join(root, "memory", "skills"),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

  const loader = fs.readFileSync(
    path.join(home, ".omp", "agent", "extensions", "remnic", "loader.js"),
    "utf8",
  );
  assert.match(loader, /\.dist-bundle\.tmp-/, "loader rebuild must build to a temp dir");
  assert.match(loader, /\.dist-bundle\.bak-/, "loader rebuild must rename the old bundle aside");
  assert.match(loader, /renameSync\(tmp, bundleDir\)/, "loader rebuild must swap the temp into place");
  // The spawn call must target the temp dir, not dist-bundle directly
  // (the literal "--outdir=dist-bundle" still appears in error-guidance text,
  // so assert the call site specifically).
  assert.doesNotMatch(
    loader,
    /spawnSync\(bunForRebuild.*--outdir=dist-bundle/,
    "loader rebuild spawn must not target dist-bundle directly",
  );
  // Must still be valid JS.
  const syntaxCheck = spawnSync(
    process.execPath,
    ["--check", path.join(home, ".omp", "agent", "extensions", "remnic", "loader.js")],
    { encoding: "utf-8" },
  );
  assert.equal(syntaxCheck.status, 0, `loader.js fails node --check: ${syntaxCheck.stderr}`);
});

// ── Regression (PR #1641 / #1598): the omp pre-bundle must not pull all of
// @remnic/core (and the LanceDB native asset) into the extension bundle.
// The omp wrapper is `bun build`-ed from the generated index.ts, which imports
// `createRemnicPiExtension`. Every file transitively reachable from that entry
// must reach core through leaf submodules (`@remnic/core/<submodule>`), never
// the `@remnic/core` barrel — the barrel eagerly imports the search backends
// (LanceDB/Orama/Meilisearch), and since the package has no `sideEffects`
// field, bundlers cannot tree-shake them out. Measured before this fix: a real
// `bun build` emitted 917 modules + the ~100 MB lancedb .node asset; after, 209
// modules / ~0.16 MB with zero native refs.
test("omp extension runtime closure imports core only via leaf submodules, not the barrel", () => {
  const srcDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src");
  // publisher.ts is build/install-time only — it is never in the omp-bundled
  // runtime graph (the wrapper imports createRemnicPiExtension from index.ts),
  // so its barrel import is exempt.
  const exempt: Record<string, true> = { "publisher.ts": true };
  const barrelRe = /from\s+["@']@remnic\/core["@']/;
  const offenders: string[] = [];
  for (const file of fs.readdirSync(srcDir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts") || exempt[file]) continue;
    const text = fs.readFileSync(path.join(srcDir, file), "utf8");
    if (barrelRe.test(text)) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    "omp-bundled runtime files must import @remnic/core helpers from leaf " +
      "submodules (e.g. @remnic/core/utils/path, @remnic/core/message-parts), " +
      "not the @remnic/core barrel — the barrel pulls the search backends " +
      "(LanceDB native asset) into the omp extension bundle. Offenders: " +
      offenders.join(", "),
  );
});

// ── Regression (PR #1641 / #1598): the omp wrapper import specifier must stay
// a valid relative module specifier even on Windows cross-drive layouts. When
// the extension dir and the plugin-pi install are on different drives,
// path.relative returns an absolute drive path; prefixing "./" then yields an
// invalid specifier that fails `bun build` cryptically. `bun build` also
// cannot resolve a `file://` specifier (verified on Bun 1.3), so the only safe
// response is to fail fast with an actionable error.
test("resolveOmpWrapperImportSpecifier emits a ./ relative specifier for same-drive paths", () => {
  const specifier = resolveOmpWrapperImportSpecifier(
    path.join(path.sep, "opt", "remnic", "plugin-pi", "dist", "index.js"),
    path.join(path.sep, "home", "me", ".omp", "agent", "extensions", "remnic"),
  );
  assert.ok(
    specifier.startsWith("./") || specifier.startsWith("../"),
    `expected a relative (./ or ../) specifier, got ${specifier}`,
  );
  assert.doesNotMatch(specifier, /^[A-Za-z]:[\\/]/, "specifier must not be a bare absolute drive path");
  assert.doesNotMatch(specifier, /^\/[^/]/, "specifier must not be a bare absolute posix path");
});
test("resolveOmpWrapperImportSpecifier fails fast with an actionable error for cross-drive Windows layouts", () => {
  const wrapperDir = "C:\\Users\\me\\.omp\\agent\\extensions\\remnic";
  const modulePath = "D:\\remnic\\plugin-pi\\dist\\index.js";
  // Sanity-check the cross-drive premise: different roots under win32 semantics.
  assert.notEqual(win32.parse(wrapperDir).root, win32.parse(modulePath).root);
  assert.throws(
    () => resolveOmpWrapperImportSpecifier(modulePath, wrapperDir, win32),
    /different drives/i,
    "cross-drive omp layout must fail fast instead of emitting an invalid ./D:\\… specifier",
  );
});
test("resolveOmpWrapperImportSpecifier treats Windows drive-letter casing as the same drive", () => {
  // Windows drive roots are case-insensitive: the omp agent home and the
  // plugin-pi install may report the drive letter in different casing (e.g.
  // C:\ from the home env var, c:\ from fileURLToPath(import.meta.url)). Such a
  // layout is same-drive and path.win32.relative yields a valid specifier, so
  // the guard must NOT reject it.
  const wrapperDir = "C:\\Users\\me\\.omp\\agent\\extensions\\remnic";
  const modulePath = "c:\\remnic\\plugin-pi\\dist\\index.js";
  // Sanity-check: raw roots differ in casing but the drive is the same.
  assert.notEqual(win32.parse(wrapperDir).root, win32.parse(modulePath).root);
  assert.equal(
    win32.parse(wrapperDir).root.toLowerCase(),
    win32.parse(modulePath).root.toLowerCase(),
  );
  const specifier = resolveOmpWrapperImportSpecifier(modulePath, wrapperDir, win32);
  assert.ok(
    specifier.startsWith("./") || specifier.startsWith("../"),
    `expected a relative specifier for same-drive different-casing roots, got ${specifier}`,
  );
  assert.doesNotMatch(specifier, /^[A-Za-z]:[\\/]/, "specifier must not be a bare absolute drive path");
});

// ── Regression (PR #1641 / #1598): when bun is found via the PATH probe,
// resolveBunBinary must resolve it to an absolute executable path so the
// embedded loader/postinstall don't depend on omp's runtime PATH (GUI/service
// launches often strip PATH, which would make a bare "bun" self-heal spawn
// fail even though install found a working binary).
test("omp publisher resolveBunBinary resolves the PATH-found bun to an absolute path", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-omp-bun-path-resolve-"));
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  // Fake bun that satisfies BOTH the `--version` PATH probe (exit 0) and the
  // `build --outdir` bundle step (writes a stub index.js).
  const fakeBun = path.join(binDir, "bun");
  fs.writeFileSync(
    fakeBun,
    [
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "const args = process.argv.slice(2);",
      'if (args[0] === "--version") process.exit(0);',
      'const outdirArg = args.find((a) => a.startsWith("--outdir="));',
      'if (!outdirArg) { console.error("fake-bun: --outdir missing"); process.exit(1); }',
      'const outdir = outdirArg.slice("--outdir=".length);',
      "fs.mkdirSync(outdir, { recursive: true });",
      'fs.writeFileSync(path.join(outdir, "index.js"), "export default async function remnicPiExtension() {}\\n");',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOmpProfile = process.env.OMP_PROFILE;
  const previousPiProfile = process.env.PI_PROFILE;
  const previousBunBin = process.env.REMNIC_OMP_BUN_BIN;
  const previousPath = process.env.PATH;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  delete process.env.REMNIC_OMP_BUN_BIN;
  // Only the fake bun is on PATH, so the PATH probe resolves to it.
  process.env.PATH = binDir;
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_CODING_AGENT_DIR", previousCodingAgentDir);
    restoreEnv("OMP_PROFILE", previousOmpProfile);
    restoreEnv("PI_PROFILE", previousPiProfile);
    restoreEnv("REMNIC_OMP_BUN_BIN", previousBunBin);
    restoreEnv("PATH", previousPath);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "omp", token: "omp-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  const result = await new OmpMemoryExtensionPublisher().publish({
    config: { memoryDir: path.join(root, "memory") },
    skillsRoot: path.join(root, "memory", "skills"),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

  const loader = fs.readFileSync(path.join(result.extensionRoot, "loader.js"), "utf8");
  const resolvedFakeBun = fs.realpathSync(fakeBun);
  assert.ok(
    loader.includes(JSON.stringify(resolvedFakeBun)),
    `loader must embed the absolute PATH-resolved bun path (${resolvedFakeBun}), not the bare string "bun"`,
  );
  assert.doesNotMatch(
    loader,
    /var bunForRebuild\s*=\s*"bun"\s*;/,
    "loader must not fall back to the bare 'bun' string when an absolute binary was available on PATH",
  );
});

// ── Regression (PR #1641 / #1598): resolveBunOnPath must skip non-executable
// PATH candidates so it matches `which(1)` and the spawnSync("bun", …) version
// probe. When a stale, non-executable `bun` file appears earlier on PATH than
// the real executable, the OS exec lookup in the version probe skips it and
// succeeds against the later binary; returning the non-executable file here
// would diverge and embed a path that fails with EACCES at bundle time.
test("resolveBunOnPath skips a non-executable bun earlier on PATH and resolves the later executable one", (t) => {
  if (process.platform === "win32") {
    // The POSIX executable-bit check that this regression guards against is
    // not meaningful on Windows (PATHEXT/.exe semantics differ); skip there.
    t.skip();
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-omp-bun-nonexec-"));
  const staleDir = path.join(root, "stale");
  const goodDir = path.join(root, "good");
  fs.mkdirSync(staleDir, { recursive: true });
  fs.mkdirSync(goodDir, { recursive: true });
  const staleBun = path.join(staleDir, "bun");
  const goodBun = path.join(goodDir, "bun");
  // Stale: a regular, non-executable file named `bun` earlier on PATH.
  fs.writeFileSync(staleBun, "#!/bin/sh\nold broken bun\n", { mode: 0o644 });
  // Good: an executable `bun` later on PATH.
  fs.writeFileSync(goodBun, "#!/bin/sh\necho bun\n", { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${staleDir}:${goodDir}`;
  t.after(() => {
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const resolved = resolveBunOnPath();
  assert.equal(resolved, fs.realpathSync(goodBun));
});

// ── Regression (PR #1641 / #1598): when the PATH `bun --version` probe fails,
// resolveBunBinary's filesystem fallback must also skip a stale,
// non-executable ~/.bun/bin/bun instead of returning it over a later working
// binary. Same executable-file check as the PATH walk (isExecutableFile),
// centralised so both candidate-selection sites stay in lockstep.
test("resolveBunBinary fallback skips a stale non-executable ~/.bun/bin/bun", (t) => {
  if (process.platform === "win32") {
    // POSIX executable-bit semantics; skip on Windows (PATHEXT/.exe differ).
    t.skip();
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-omp-bun-fallback-"));
  const home = path.join(root, "home");
  const bunBinDir = path.join(home, ".bun", "bin");
  fs.mkdirSync(bunBinDir, { recursive: true });
  // Stale, non-executable regular file at the first fallback candidate.
  fs.writeFileSync(path.join(bunBinDir, "bun"), "broken\n", { mode: 0o644 });

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousBunBin = process.env.REMNIC_OMP_BUN_BIN;
  const previousPath = process.env.PATH;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.REMNIC_OMP_BUN_BIN;
  // Empty PATH so the spawnSync("bun", ["--version"]) probe fails and the
  // filesystem fallback candidate list is exercised.
  process.env.PATH = "";
  t.after(() => {
    process.env.HOME = previousHome;
    process.env.USERPROFILE = previousUserProfile;
    process.env.PATH = previousPath;
    if (previousBunBin === undefined) delete process.env.REMNIC_OMP_BUN_BIN;
    else process.env.REMNIC_OMP_BUN_BIN = previousBunBin;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const resolved = resolveBunBinary();
  // The stale non-executable ~/.bun/bin/bun must NOT be returned. If the host
  // has a real bun at a later candidate (/usr/local/bin/bun, /opt/homebrew/bin/
  // bun) the resolver returns that working binary instead — either way the
  // non-executable file is skipped, which is the bug fix's intent. When a
  // binary is returned it must itself be executable (a working bun, not just a
  // file that exists).
  assert.notEqual(resolved, path.join(bunBinDir, "bun"));
  if (resolved !== null) {
    fs.accessSync(resolved, fs.constants.X_OK);
  }
});

// ── Regression (#1662): a first-time `remnic connectors install omp` without
// Bun must be fully retryable. The OmpPreBundleError catch restores every
// extension file/dir snapshot (so the root is wiped clean) while SKIPPING only
// the token rollback (the CLI already committed the token; the loader
// self-heals dist-bundle on first load). After the user installs Bun, a second
// `connectors install omp` must succeed as if the first never happened — no
// half-written files, no leftover temp artefacts, no stale dirs.
test("omp first-time publish without bun is fully retryable after installing bun", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-omp-retry-"));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });
  const extensionRoot = path.join(home, ".omp", "agent", "extensions", "remnic");

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOmpProfile = process.env.OMP_PROFILE;
  const previousPiProfile = process.env.PI_PROFILE;
  const previousBunBin = process.env.REMNIC_OMP_BUN_BIN;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  // No bun available → resolveBunBinary returns null → pre-bundle fails.
  process.env.REMNIC_OMP_BUN_BIN = path.join(root, "does-not-exist");
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_CODING_AGENT_DIR", previousCodingAgentDir);
    restoreEnv("OMP_PROFILE", previousOmpProfile);
    restoreEnv("PI_PROFILE", previousPiProfile);
    restoreEnv("REMNIC_OMP_BUN_BIN", previousBunBin);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "omp", token: "omp-token", createdAt: "2026-07-06T00:00:00.000Z" }],
  });

  const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const publishCtx = {
    config: { memoryDir: path.join(root, "memory") },
    skillsRoot: path.join(root, "memory", "skills"),
    log,
  };

  // ── First attempt: no Bun → OmpPreBundleError.
  await assert.rejects(
    () => new OmpMemoryExtensionPublisher().publish(publishCtx),
    /requires `bun`.*omp/i,
  );

  // The extension root was newly created on this first attempt, so rollback
  // must wipe it entirely — no half-written config/wrapper/readme/loader left
  // behind to confuse the retry.
  assert.equal(fs.existsSync(extensionRoot), false, "extension root must be wiped after first-time pre-bundle failure");
  // The connector token must survive (OmpPreBundleError skips token rollback)
  // so a non-`--force` retry is not blocked.
  const tokenAfterFailure = loadTokenStore().tokens.find((entry) => entry.connector === "omp");
  assert.equal(tokenAfterFailure?.token, "omp-token", "omp token must be preserved for retry");

  // ── Retry: install Bun (fake), re-run the same install.
  process.env.REMNIC_OMP_BUN_BIN = createFakeBun(root);

  const result = await new OmpMemoryExtensionPublisher().publish(publishCtx);
  assert.equal(result.hostId, "omp");
  assert.equal(result.extensionRoot, extensionRoot);

  // Every owned file must be present and complete — the retry wrote them as if
  // the failed first attempt never happened.
  const expectedFiles = [
    "remnic.config.json",
    "index.ts",
    "README.md",
    "loader.js",
    "package.json",
    "postinstall-bundle.cjs",
  ];
  for (const fileName of expectedFiles) {
    const filePath = path.join(extensionRoot, fileName);
    assert.ok(fs.existsSync(filePath), `retry must write ${fileName}`);
    assert.ok(fs.statSync(filePath).size > 0, `retry must write non-empty ${fileName}`);
  }
  // dist-bundle must exist (the retry pre-bundled successfully).
  assert.ok(
    fs.existsSync(path.join(extensionRoot, "dist-bundle", "index.js")),
    "retry must produce dist-bundle/index.js",
  );
  // No leftover temp/backup artefacts from either attempt.
  for (const entry of fs.readdirSync(extensionRoot)) {
    assert.ok(
      !/\.tmp-\d+-\d+$/.test(entry) && !entry.startsWith(".dist-bundle."),
      `retry must not leave temp/backup artefacts: ${entry}`,
    );
  }
});

// ── Regression (#1662): restoring a pre-existing file must use
// "write-new-before-delete-old" (rules 42/54). The prior content is written to
// a temp path and renamed into place, so the live file is never truncated. If
// the restore write itself fails (disk full, EACCES, …), the file keeps its
// current on-disk content intact rather than being left half-written. We force
// the restore temp-write to fail and assert the publish-written content
// survives uncorrupted. (Forward writes pass string data + encoding; restore
// passes Buffer data — the mock distinguishes the two so only the restore
// fails.)
test("restore uses write-new-before-delete-old: a failed restore leaves the file intact", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-restore-atomic-"));
  const home = path.join(root, "home");
  const piAgentHome = path.join(root, "pi-agent");
  const extensionRoot = path.join(piAgentHome, "extensions", "remnic");
  const configPath = path.join(extensionRoot, "remnic.config.json");
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });
  // Pre-existing prior config — what the snapshot will capture and would
  // restore if the restore succeeded. Publish merges prior fields, so the
  // raw prior content is captured for a byte-for-byte "not restored" check.
  const priorRaw = `${JSON.stringify({ priorConfig: true }, null, 2)}\n`;
  fs.writeFileSync(configPath, priorRaw);

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousPiAgentHome = process.env.PI_AGENT_HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_AGENT_HOME = piAgentHome;
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_AGENT_HOME", previousPiAgentHome);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "pi", token: "pi-token", createdAt: "2026-07-06T00:00:00.000Z" }],
  });

  // Sabotage only the restore temp-write: Buffer data written to a `.tmp-`
  // path. Forward atomicWriteFile passes a string (with encoding), so publish
  // writes succeed; only the rollback restore (Buffer snapshot content) fails.
  const realWriteFileSync = fs.writeFileSync;
  let restoreAttempted = false;
  fs.writeFileSync = function sabotagedWriteFileSync(
    file: fs.PathOrFileDescriptor,
    data: string | NodeJS.ArrayBufferView,
    options?: fs.WriteFileOptions,
  ): void {
    if (
      typeof file === "string" &&
      Buffer.isBuffer(data) &&
      /\.tmp-\d+-\d+$/u.test(file)
    ) {
      restoreAttempted = true;
      const err = Object.assign(new Error("simulated restore write failure (ENOSPC)"), { code: "ENOSPC" });
      throw err;
    }
    return realWriteFileSync.call(fs, file, data, options);
  } as typeof fs.writeFileSync;
  t.after(() => {
    fs.writeFileSync = realWriteFileSync;
  });

  const warnings: string[] = [];
  await assert.rejects(
    () =>
      new FailingPiPublisher().publish({
        config: { memoryDir: path.join(root, "memory") },
        skillsRoot: path.join(root, "memory", "skills"),
        rollbackTokenEntry: {
          connector: "pi",
          token: "pi-token",
          createdAt: "2026-07-06T00:00:00.000Z",
        },
        log: {
          info: () => undefined,
          warn: (message: string) => warnings.push(message),
          error: () => undefined,
        },
      }),
    /readme write failed/,
  );

  assert.ok(restoreAttempted, "the restore must have attempted a temp write");
  // The restore failure must surface as a rollback warning.
  assert.match(warnings.join("\n"), /rollback failed/i);
  // CRITICAL — write-new-before-delete-old: the config file is NOT truncated
  // or half-written. It still holds the complete content publish wrote
  // (merge of defaults + prior fields + the auth token), because the restore
  // temp-write failed BEFORE the live file was touched. The surviving file is
  // the publish-written version (has authToken + recallMode), NOT the raw
  // prior content (which had neither) — proving the restore did not land.
  const survivingRaw = fs.readFileSync(configPath, "utf8");
  assert.notEqual(survivingRaw, priorRaw, "config must NOT be the raw prior content (restore did not run)");
  assert.ok(survivingRaw.length > priorRaw.length, "config must be the larger publish-written content, not the truncated/raw prior");
  const survivingConfig = JSON.parse(survivingRaw) as Record<string, unknown>;
  assert.equal(
    survivingConfig.authToken,
    "pi-token",
    "config must retain publish-written auth token after a failed restore (write-new-before-delete-old)",
  );
  assert.equal(
    survivingConfig.recallMode,
    "auto",
    "config must retain publish-written recallMode after a failed restore",
  );
  // No lingering temp artefact.
  for (const entry of fs.readdirSync(extensionRoot)) {
    assert.ok(!/\.tmp-\d+-\d+$/u.test(entry), `leftover restore temp file: ${entry}`);
  }
});

// ── Regression (#1662): rollback-symlink TOCTOU defense-in-depth. If a file
// is swapped for a symlink AFTER the snapshot but BEFORE the restore, the
// restore must NOT write the prior content through the symlink to an arbitrary
// target. The atomic temp+rename restore detects the symlink and aborts (the
// final rename replaces a symlink rather than following it, and we re-check
// immediately before the rename to surface tampering). The pre-symlink
// behaviour was `fs.writeFileSync(path, snapshot)` which writes THROUGH a
// symlink — corrupting the symlink's target.
test("restore does not write through a symlink swapped in after the snapshot (TOCTOU defense)", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-restore-symlink-toctou-"));
  const home = path.join(root, "home");
  const piAgentHome = path.join(root, "pi-agent");
  const extensionRoot = path.join(piAgentHome, "extensions", "remnic");
  const configPath = path.join(extensionRoot, "remnic.config.json");
  // External file the adversary swaps the config symlink to point at.
  const externalTarget = path.join(root, "external-target.json");
  const externalOriginal = `${JSON.stringify({ externalOriginal: true }, null, 2)}\n`;
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });
  // Pre-existing prior config — what the snapshot captures and would restore.
  fs.writeFileSync(configPath, `${JSON.stringify({ priorConfig: true }, null, 2)}\n`);
  fs.writeFileSync(externalTarget, externalOriginal);

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousPiAgentHome = process.env.PI_AGENT_HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_AGENT_HOME = piAgentHome;
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PI_AGENT_HOME", previousPiAgentHome);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "pi", token: "pi-token", createdAt: "2026-07-06T00:00:00.000Z" }],
  });

  const warnings: string[] = [];
  await assert.rejects(
    () =>
      new SymlinkSwapFailingPiPublisher(configPath, externalTarget).publish({
        config: { memoryDir: path.join(root, "memory") },
        skillsRoot: path.join(root, "memory", "skills"),
        rollbackTokenEntry: {
          connector: "pi",
          token: "pi-token",
          createdAt: "2026-07-06T00:00:00.000Z",
        },
        log: {
          info: () => undefined,
          warn: (message: string) => warnings.push(message),
          error: () => undefined,
        },
      }),
    /readme write failed/,
  );

  // The restore must have refused the symlink (logged as a rollback warning).
  assert.match(warnings.join("\n"), /must not be a symlink/);
  // CRITICAL — the symlink's target is untouched: the prior config content was
  // never written through the symlink. Under the old `fs.writeFileSync(path,
  // snapshot)` restore, this file would have been overwritten with the prior
  // config content.
  assert.equal(
    fs.readFileSync(externalTarget, "utf8"),
    externalOriginal,
    "symlink target must not be written through during restore (TOCTOU defense)",
  );
});

// ── prime-agent publisher ────────────────────────────────────────────────────

test("prime-agent publisher exposes hostId prime-agent and resolves the ~/.prime/agent extension root", async () => {
  const publisher = new PrimeAgentMemoryExtensionPublisher();
  assert.equal(publisher.hostId, "prime-agent");
  assert.equal(
    await publisher.resolveExtensionRoot({ HOME: "/home/alice" }),
    path.join("/home/alice", ".prime", "agent", "extensions", "remnic"),
  );
});

test("prime-agent publisher honors PRIME_AGENT_CODING_AGENT_DIR and ignores Pi-family env vars", async () => {
  const publisher = new PrimeAgentMemoryExtensionPublisher();
  assert.equal(
    await publisher.resolveExtensionRoot({
      HOME: "/home/alice",
      PRIME_AGENT_CODING_AGENT_DIR: "/custom/prime-agent",
    }),
    path.join("/custom/prime-agent", "extensions", "remnic"),
  );
  // Prime Agent is a separate install tree: the Pi-family overrides must NOT
  // relocate it (unlike omp, which inherits PI_CODING_AGENT_DIR).
  assert.equal(
    await publisher.resolveExtensionRoot({
      HOME: "/home/alice",
      PI_CODING_AGENT_DIR: "/wrong/pi-agent",
      PI_CONFIG_DIR: ".wrong-omp",
    }),
    path.join("/home/alice", ".prime", "agent", "extensions", "remnic"),
  );
});

test("prime-agent publisher writes config, wrapper, and package.json; unpublish removes them", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-prime-agent-publisher-test-"));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousPrimeDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
  t.after(() => {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("PRIME_AGENT_CODING_AGENT_DIR", previousPrimeDir);
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "prime-agent", token: "prime-token", createdAt: "2026-08-17T00:00:00.000Z" }],
  });

  const publisher = new PrimeAgentMemoryExtensionPublisher();
  const result = await publisher.publish({
    config: {
      daemonUrl: "http://new-daemon/",
      memoryDir: path.join(root, "memory"),
      namespace: "ns-prime",
    },
    skillsRoot: path.join(root, "memory", "skills"),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

  const extensionRoot = path.join(home, ".prime", "agent", "extensions", "remnic");
  assert.equal(result.extensionRoot, extensionRoot);
  assert.equal(result.hostId, "prime-agent");

  const cfg = JSON.parse(
    fs.readFileSync(path.join(extensionRoot, "remnic.config.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(cfg.authToken, "prime-token");
  assert.equal(cfg.namespace, "ns-prime");
  assert.equal(cfg.remnicDaemonUrl, "http://new-daemon");

  assert.ok(fs.existsSync(path.join(extensionRoot, "index.ts")), "index.ts was not written");
  const readme = fs.readFileSync(path.join(extensionRoot, "README.md"), "utf8");
  assert.match(readme, /Prime Agent/);

  // Prime Agent reads the extension through a package manifest: the install
  // must ship a package.json whose only dependency is @remnic/plugin-pi.
  const pkg = JSON.parse(
    fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const dependencyRange = pkg.dependencies?.["@remnic/plugin-pi"];
  assert.ok(dependencyRange, "package.json must depend on @remnic/plugin-pi");
  assert.match(dependencyRange, /^\^\d+\.\d+\.\d+/u, "dependency must be a caret range on a concrete version");

  await publisher.unpublish();
  assert.equal(
    fs.existsSync(path.join(extensionRoot, "remnic.config.json")),
    false,
    "unpublish must remove remnic.config.json",
  );
  assert.equal(fs.existsSync(path.join(extensionRoot, "index.ts")), false, "unpublish must remove index.ts");
  assert.equal(fs.existsSync(path.join(extensionRoot, "package.json")), false, "unpublish must remove package.json");
});

test("prime-agent publisher unpublish sweeps the PRIME_AGENT_CODING_AGENT_DIR install", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-prime-agent-remove-test-"));
  const agentHome = path.join(root, "prime-agent");
  const extensionRoot = path.join(agentHome, "extensions", "remnic");
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.writeFileSync(path.join(extensionRoot, "remnic.config.json"), "{}\n");
  fs.writeFileSync(path.join(extensionRoot, "index.ts"), "export default {};\n");
  fs.writeFileSync(path.join(extensionRoot, "package.json"), "{}\n");
  fs.writeFileSync(path.join(extensionRoot, "README.md"), "notes\n");

  const previousPrimeDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
  process.env.PRIME_AGENT_CODING_AGENT_DIR = agentHome;
  t.after(() => {
    restoreEnv("PRIME_AGENT_CODING_AGENT_DIR", previousPrimeDir);
    fs.rmSync(root, { recursive: true, force: true });
  });

  await new PrimeAgentMemoryExtensionPublisher().unpublish();
  assert.equal(fs.existsSync(path.join(extensionRoot, "remnic.config.json")), false);
  assert.equal(fs.existsSync(path.join(extensionRoot, "index.ts")), false);
  assert.equal(fs.existsSync(path.join(extensionRoot, "package.json")), false);
  assert.equal(fs.existsSync(extensionRoot), false, "empty extension root must be removed");
});

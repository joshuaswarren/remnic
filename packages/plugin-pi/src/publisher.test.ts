import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { type PublishContext, loadTokenStore, saveTokenStore } from "@remnic/core";

import { OmpMemoryExtensionPublisher, PiMemoryExtensionPublisher } from "./publisher.js";

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
  assert.ok(scripts?.postinstall?.includes("build index.ts"), "postinstall must run bun build");

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
test("omp publisher package.json postinstall uses the resolved bun path", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-omp-postinstall-bun-"));
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
  const postinstall = pkg.scripts.postinstall;
  assert.ok(
    postinstall.includes(resolvedBun),
    `postinstall must reference the resolved bun path (${resolvedBun})`,
  );
  assert.ok(postinstall.includes("build index.ts"), "postinstall must run bun build");
  assert.match(
    postinstall,
    /\|\|\s*BUN=bun/,
    "postinstall must fall back to PATH bun when the resolved binary is missing",
  );
  assert.doesNotMatch(
    postinstall,
    /^bun build\s/,
    "postinstall must not invoke a bare bun (would fail when bun is not on PATH)",
  );
});

import assert from "node:assert/strict";
import fs from "node:fs";
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
    "#!/usr/bin/env node",
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
  assert.ok(scripts?.postinstall?.includes("bun build"), "postinstall must run bun build");

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

  // The loader must reference the same plugin-pi dist path that the wrapper imports from,
  // so mtime self-healing detects npm updates of @remnic/plugin-pi.
  const wrapperImportMatch = wrapper.match(/from\s+"(file:\/\/.+plugin-pi\/(?:src|dist)\/index\.(?:ts|js))"/);
  assert.ok(wrapperImportMatch, "wrapper must import from plugin-pi dist");
  const wrapperPath = wrapperImportMatch[1].replace(/^file:\/\//, "");
  assert.ok(
    loader.includes(JSON.stringify(wrapperPath)),
    `loader must embed the plugin-pi dist path (${wrapperPath}) for mtime comparison`,
  );
});

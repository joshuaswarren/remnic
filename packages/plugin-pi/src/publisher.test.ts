import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTokenStore, saveTokenStore, type PublishContext } from "@remnic/core";

import { PiMemoryExtensionPublisher } from "./publisher.js";

class FailingPiPublisher extends PiMemoryExtensionPublisher {
  async renderInstructions(ctx: PublishContext): Promise<string> {
    await super.renderInstructions(ctx);
    throw new Error("readme write failed");
  }
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
  fs.writeFileSync(configPath, `${JSON.stringify({ authToken: "old-token", remnicDaemonUrl: "http://old" }, null, 2)}\n`);
  fs.writeFileSync(wrapperPath, "old wrapper\n");
  fs.writeFileSync(readmePath, "old readme\n");

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousPiAgentHome = process.env.PI_AGENT_HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_AGENT_HOME = piAgentHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousPiAgentHome === undefined) delete process.env.PI_AGENT_HOME;
    else process.env.PI_AGENT_HOME = previousPiAgentHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "pi", token: "new-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  const publisher = new FailingPiPublisher();
  await assert.rejects(
    () => publisher.publish({
      config: { memoryDir: path.join(root, "memory") },
      skillsRoot: path.join(root, "memory", "skills"),
      rollbackTokenEntry: {
        connector: "pi",
        token: "old-token",
        createdAt: "2026-05-09T00:00:00.000Z",
      },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    }),
    /readme write failed/,
  );

  assert.equal(fs.readFileSync(configPath, "utf8"), `${JSON.stringify({ authToken: "old-token", remnicDaemonUrl: "http://old" }, null, 2)}\n`);
  assert.equal(fs.readFileSync(wrapperPath, "utf8"), "old wrapper\n");
  assert.equal(fs.readFileSync(readmePath, "utf8"), "old readme\n");
  const piToken = loadTokenStore().tokens.find((entry) => entry.connector === "pi");
  assert.equal(piToken?.token, "old-token");
});

test("Pi publisher preserves user-managed extension settings on reinstall", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-publisher-preserve-test-"));
  const home = path.join(root, "home");
  const piAgentHome = path.join(root, "pi-agent");
  const extensionRoot = path.join(piAgentHome, "extensions", "remnic");
  const configPath = path.join(extensionRoot, "remnic.config.json");
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
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
  }, null, 2)}\n`);

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousPiAgentHome = process.env.PI_AGENT_HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_AGENT_HOME = piAgentHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousPiAgentHome === undefined) delete process.env.PI_AGENT_HOME;
    else process.env.PI_AGENT_HOME = previousPiAgentHome;
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
});

test("Pi publisher preserves existing namespace when reinstall omits namespace", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-publisher-namespace-test-"));
  const home = path.join(root, "home");
  const piAgentHome = path.join(root, "pi-agent");
  const extensionRoot = path.join(piAgentHome, "extensions", "remnic");
  const configPath = path.join(extensionRoot, "remnic.config.json");
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    remnicDaemonUrl: "http://old-daemon",
    authToken: "old-token",
    namespace: "manual-namespace",
  }, null, 2)}\n`);

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousPiAgentHome = process.env.PI_AGENT_HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_AGENT_HOME = piAgentHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousPiAgentHome === undefined) delete process.env.PI_AGENT_HOME;
    else process.env.PI_AGENT_HOME = previousPiAgentHome;
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
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousPiAgentHome === undefined) delete process.env.PI_AGENT_HOME;
    else process.env.PI_AGENT_HOME = previousPiAgentHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "pi", token: "new-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  const publisher = new PiMemoryExtensionPublisher();
  await assert.rejects(
    () => publisher.publish({
      config: { memoryDir: path.join(root, "memory") },
      skillsRoot: path.join(root, "memory", "skills"),
      rollbackTokenEntry: {
        connector: "pi",
        token: "old-token",
        createdAt: "2026-05-09T00:00:00.000Z",
      },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    }),
    /Failed to load existing Remnic Pi config/,
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
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousPiAgentHome === undefined) delete process.env.PI_AGENT_HOME;
    else process.env.PI_AGENT_HOME = previousPiAgentHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "pi", token: "new-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  const publisher = new PiMemoryExtensionPublisher();
  await assert.rejects(
    () => publisher.publish({
      config: { memoryDir: path.join(root, "memory") },
      skillsRoot: path.join(root, "memory", "skills"),
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    }),
    /must not be a symlink/,
  );

  assert.equal(fs.existsSync(path.join(targetDir, "remnic.config.json")), false);
  assert.equal(fs.existsSync(path.join(targetDir, "index.ts")), false);
});

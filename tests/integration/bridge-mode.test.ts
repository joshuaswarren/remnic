import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Worker } from "node:worker_threads";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const HEALTH_SERVER_WORKER_SOURCE = `
import { createServer } from "node:http";
import { workerData } from "node:worker_threads";

const view = new Int32Array(workerData.state);
const server = createServer((_req, res) => {
  res.writeHead(200);
  res.end();
});

server.listen(0, "127.0.0.1", () => {
  Atomics.store(view, 1, server.address().port);
  Atomics.store(view, 0, 1);
  Atomics.notify(view, 0);
});

setInterval(() => {}, 1000);
`;

// ---------------------------------------------------------------------------
// Bridge mode detection — packages/plugin-openclaw/src/bridge.ts
// ---------------------------------------------------------------------------

test("detectBridgeMode defaults to embedded when no daemon running", async (t) => {
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  const previousPort = process.env.REMNIC_PORT;
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "bridge-mode-default-"));

  process.env.HOME = tempHome;
  process.env.PATH = "/definitely-missing-bridge-tools";
  process.env.REMNIC_PORT = "49999";
  delete process.env.REMNIC_BRIDGE_MODE;
  delete process.env.ENGRAM_BRIDGE_MODE;

  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousPort === undefined) delete process.env.REMNIC_PORT;
    else process.env.REMNIC_PORT = previousPort;
  });

  const { detectBridgeMode } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
  const config = detectBridgeMode();
  // Without a daemon running, should default to embedded
  assert.equal(config.mode, "embedded");
  assert.equal(config.daemonHost, "127.0.0.1");
  assert.ok(config.daemonPort > 0);
});

test("detectBridgeMode respects ENGRAM_BRIDGE_MODE=delegate", async () => {
  process.env.ENGRAM_BRIDGE_MODE = "delegate";
  // Re-import to pick up env change
  const bridgeMod = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
  const config = bridgeMod.detectBridgeMode();
  assert.equal(config.mode, "delegate");
  delete process.env.ENGRAM_BRIDGE_MODE;
});

test("detectBridgeMode respects ENGRAM_BRIDGE_MODE=embedded", async () => {
  process.env.ENGRAM_BRIDGE_MODE = "embedded";
  const bridgeMod = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
  const config = bridgeMod.detectBridgeMode();
  assert.equal(config.mode, "embedded");
  delete process.env.ENGRAM_BRIDGE_MODE;
});

test("checkDaemonHealth returns false when nothing is listening", async () => {
  const { checkDaemonHealth } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
  const healthy = await checkDaemonHealth("127.0.0.1", 49999);
  assert.equal(healthy, false);
});

test("checkDaemonHealth falls back to legacy token file when remnic tokens are malformed", async () => {
  const previousHome = process.env.HOME;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "bridge-token-fallback-"));
  const remnicDir = path.join(homeDir, ".remnic");
  const legacyDir = path.join(homeDir, ".engram");

  await mkdir(remnicDir, { recursive: true });
  await mkdir(legacyDir, { recursive: true });
  await writeFile(path.join(remnicDir, "tokens.json"), "{not-json", "utf8");
  await writeFile(
    path.join(legacyDir, "tokens.json"),
    JSON.stringify({
      tokens: [{ connector: "openclaw", token: "engram_legacy_token", createdAt: "2026-04-09T00:00:00.000Z" }],
    }),
    "utf8",
  );

  const server = createServer((req, res) => {
    if (req.headers.authorization === "Bearer engram_legacy_token") {
      res.writeHead(200);
    } else {
      res.writeHead(401);
    }
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;

  try {
    process.env.HOME = homeDir;
    const { checkDaemonHealth } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
    const healthy = await checkDaemonHealth("127.0.0.1", port);
    assert.equal(healthy, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("detectBridgeMode reads legacy config port when remnic config is malformed", async () => {
  const previousHome = process.env.HOME;
  const previousMode = process.env.REMNIC_BRIDGE_MODE;
  const previousLegacyMode = process.env.ENGRAM_BRIDGE_MODE;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "bridge-port-fallback-"));
  const remnicConfigDir = path.join(homeDir, ".config", "remnic");
  const legacyConfigDir = path.join(homeDir, ".config", "engram");

  await mkdir(remnicConfigDir, { recursive: true });
  await mkdir(legacyConfigDir, { recursive: true });
  await writeFile(path.join(remnicConfigDir, "config.json"), "{not-json", "utf8");
  await writeFile(
    path.join(legacyConfigDir, "config.json"),
    JSON.stringify({ server: { port: 4815 } }),
    "utf8",
  );

  try {
    process.env.HOME = homeDir;
    process.env.REMNIC_BRIDGE_MODE = "delegate";
    delete process.env.ENGRAM_BRIDGE_MODE;

    const { detectBridgeMode } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
    const config = detectBridgeMode();
    assert.equal(config.daemonPort, 4815);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousMode === undefined) delete process.env.REMNIC_BRIDGE_MODE;
    else process.env.REMNIC_BRIDGE_MODE = previousMode;
    if (previousLegacyMode === undefined) delete process.env.ENGRAM_BRIDGE_MODE;
    else process.env.ENGRAM_BRIDGE_MODE = previousLegacyMode;
  }
});

test("detectBridgeMode expands tilde-prefixed REMNIC_CONFIG_PATH", async () => {
  const previousHome = process.env.HOME;
  const previousMode = process.env.REMNIC_BRIDGE_MODE;
  const previousLegacyMode = process.env.ENGRAM_BRIDGE_MODE;
  const previousPort = process.env.REMNIC_PORT;
  const previousLegacyPort = process.env.ENGRAM_PORT;
  const previousConfigPath = process.env.REMNIC_CONFIG_PATH;
  const previousLegacyConfigPath = process.env.ENGRAM_CONFIG_PATH;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "bridge-tilde-config-"));
  const remnicConfigDir = path.join(homeDir, ".config", "remnic");

  await mkdir(remnicConfigDir, { recursive: true });
  await writeFile(
    path.join(remnicConfigDir, "config.json"),
    JSON.stringify({ server: { port: 4815 } }),
    "utf8",
  );

  try {
    process.env.HOME = homeDir;
    process.env.REMNIC_BRIDGE_MODE = "delegate";
    process.env.REMNIC_CONFIG_PATH = "~/.config/remnic/config.json";
    delete process.env.ENGRAM_BRIDGE_MODE;
    delete process.env.REMNIC_PORT;
    delete process.env.ENGRAM_PORT;
    delete process.env.ENGRAM_CONFIG_PATH;

    const { detectBridgeMode } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
    const config = detectBridgeMode();
    assert.equal(config.daemonPort, 4815);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousMode === undefined) delete process.env.REMNIC_BRIDGE_MODE;
    else process.env.REMNIC_BRIDGE_MODE = previousMode;
    if (previousLegacyMode === undefined) delete process.env.ENGRAM_BRIDGE_MODE;
    else process.env.ENGRAM_BRIDGE_MODE = previousLegacyMode;
    if (previousPort === undefined) delete process.env.REMNIC_PORT;
    else process.env.REMNIC_PORT = previousPort;
    if (previousLegacyPort === undefined) delete process.env.ENGRAM_PORT;
    else process.env.ENGRAM_PORT = previousLegacyPort;
    if (previousConfigPath === undefined) delete process.env.REMNIC_CONFIG_PATH;
    else process.env.REMNIC_CONFIG_PATH = previousConfigPath;
    if (previousLegacyConfigPath === undefined) delete process.env.ENGRAM_CONFIG_PATH;
    else process.env.ENGRAM_CONFIG_PATH = previousLegacyConfigPath;
  }
});

test("detectBridgeMode does not delegate solely because a Remnic daemon pid file is live", async () => {
  const previousHome = process.env.HOME, previousPort = process.env.REMNIC_PORT;
  const previousMode = process.env.REMNIC_BRIDGE_MODE;
  const previousLegacyMode = process.env.ENGRAM_BRIDGE_MODE;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "bridge-live-pid-"));
  const remnicDir = path.join(homeDir, ".remnic");

  await mkdir(remnicDir, { recursive: true });
  await writeFile(path.join(remnicDir, "server.pid"), `${process.pid}\n`, "utf8");

  try {
    process.env.HOME = homeDir; process.env.REMNIC_PORT = "49999";
    delete process.env.REMNIC_BRIDGE_MODE;
    delete process.env.ENGRAM_BRIDGE_MODE;

    const { detectBridgeMode } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
    const config = detectBridgeMode();
    assert.equal(config.mode, "embedded");
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousPort === undefined) delete process.env.REMNIC_PORT; else process.env.REMNIC_PORT = previousPort;
    if (previousMode === undefined) delete process.env.REMNIC_BRIDGE_MODE;
    else process.env.REMNIC_BRIDGE_MODE = previousMode;
    if (previousLegacyMode === undefined) delete process.env.ENGRAM_BRIDGE_MODE;
    else process.env.ENGRAM_BRIDGE_MODE = previousLegacyMode;
  }
});

test("detectBridgeMode delegates when daemon service is installed and healthy without a pid file", async () => {
  const previousHome = process.env.HOME;
  const previousPort = process.env.REMNIC_PORT;
  const previousMode = process.env.REMNIC_BRIDGE_MODE;
  const previousLegacyMode = process.env.ENGRAM_BRIDGE_MODE;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "bridge-service-configured-"));
  const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");

  await mkdir(launchAgentsDir, { recursive: true });
  await writeFile(path.join(launchAgentsDir, "ai.remnic.daemon.plist"), "<plist />\n", "utf8");

  const state = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const view = new Int32Array(state);
  const serverWorker = new Worker(
    new URL(`data:text/javascript,${encodeURIComponent(HEALTH_SERVER_WORKER_SOURCE)}`),
    { type: "module", workerData: { state } },
  );
  Atomics.wait(view, 0, 0, 1000);
  const port = Atomics.load(view, 1);
  assert.ok(port > 0);

  try {
    process.env.HOME = homeDir;
    process.env.REMNIC_PORT = String(port);
    delete process.env.REMNIC_BRIDGE_MODE;
    delete process.env.ENGRAM_BRIDGE_MODE;

    const { detectBridgeMode } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
    const config = detectBridgeMode();
    assert.equal(config.mode, "delegate");
  } finally {
    await serverWorker.terminate();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPort === undefined) delete process.env.REMNIC_PORT;
    else process.env.REMNIC_PORT = previousPort;
    if (previousMode === undefined) delete process.env.REMNIC_BRIDGE_MODE;
    else process.env.REMNIC_BRIDGE_MODE = previousMode;
    if (previousLegacyMode === undefined) delete process.env.ENGRAM_BRIDGE_MODE;
    else process.env.ENGRAM_BRIDGE_MODE = previousLegacyMode;
  }
});

test("detectBridgeMode delegates when legacy ai.remnic.server launchd service is healthy", async () => {
  const previousHome = process.env.HOME;
  const previousPort = process.env.REMNIC_PORT;
  const previousMode = process.env.REMNIC_BRIDGE_MODE;
  const previousLegacyMode = process.env.ENGRAM_BRIDGE_MODE;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "bridge-legacy-server-service-"));
  const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");

  await mkdir(launchAgentsDir, { recursive: true });
  await writeFile(path.join(launchAgentsDir, "ai.remnic.server.plist"), "<plist />\n", "utf8");

  const state = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const view = new Int32Array(state);
  const serverWorker = new Worker(
    new URL(`data:text/javascript,${encodeURIComponent(HEALTH_SERVER_WORKER_SOURCE)}`),
    { type: "module", workerData: { state } },
  );
  Atomics.wait(view, 0, 0, 1000);
  const port = Atomics.load(view, 1);
  assert.ok(port > 0);

  try {
    process.env.HOME = homeDir;
    process.env.REMNIC_PORT = String(port);
    delete process.env.REMNIC_BRIDGE_MODE;
    delete process.env.ENGRAM_BRIDGE_MODE;

    const { detectBridgeMode } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
    const config = detectBridgeMode();
    assert.equal(config.mode, "delegate");
  } finally {
    await serverWorker.terminate();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPort === undefined) delete process.env.REMNIC_PORT;
    else process.env.REMNIC_PORT = previousPort;
    if (previousMode === undefined) delete process.env.REMNIC_BRIDGE_MODE;
    else process.env.REMNIC_BRIDGE_MODE = previousMode;
    if (previousLegacyMode === undefined) delete process.env.ENGRAM_BRIDGE_MODE;
    else process.env.ENGRAM_BRIDGE_MODE = previousLegacyMode;
  }
});

test("detectBridgeMode delegates to a reachable local daemon without service metadata", async () => {
  const previousHome = process.env.HOME;
  const previousPort = process.env.REMNIC_PORT;
  const previousMode = process.env.REMNIC_BRIDGE_MODE;
  const previousLegacyMode = process.env.ENGRAM_BRIDGE_MODE;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "bridge-local-health-probe-"));

  const state = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const view = new Int32Array(state);
  const serverWorker = new Worker(
    new URL(`data:text/javascript,${encodeURIComponent(HEALTH_SERVER_WORKER_SOURCE)}`),
    { type: "module", workerData: { state } },
  );
  Atomics.wait(view, 0, 0, 1000);
  const port = Atomics.load(view, 1);
  assert.ok(port > 0);

  try {
    process.env.HOME = homeDir;
    process.env.REMNIC_PORT = String(port);
    delete process.env.REMNIC_BRIDGE_MODE;
    delete process.env.ENGRAM_BRIDGE_MODE;

    const { detectBridgeMode } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
    const config = detectBridgeMode();
    assert.equal(config.mode, "delegate");
  } finally {
    await serverWorker.terminate();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPort === undefined) delete process.env.REMNIC_PORT;
    else process.env.REMNIC_PORT = previousPort;
    if (previousMode === undefined) delete process.env.REMNIC_BRIDGE_MODE;
    else process.env.REMNIC_BRIDGE_MODE = previousMode;
    if (previousLegacyMode === undefined) delete process.env.ENGRAM_BRIDGE_MODE;
    else process.env.ENGRAM_BRIDGE_MODE = previousLegacyMode;
  }
});

test("detectBridgeMode coerces string config port before service health probing", async () => {
  const previousHome = process.env.HOME;
  const previousPort = process.env.REMNIC_PORT;
  const previousMode = process.env.REMNIC_BRIDGE_MODE;
  const previousLegacyMode = process.env.ENGRAM_BRIDGE_MODE;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "bridge-service-string-port-"));
  const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");
  const remnicConfigDir = path.join(homeDir, ".config", "remnic");

  await mkdir(launchAgentsDir, { recursive: true });
  await mkdir(remnicConfigDir, { recursive: true });
  await writeFile(path.join(launchAgentsDir, "ai.remnic.daemon.plist"), "<plist />\n", "utf8");

  const state = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const view = new Int32Array(state);
  const serverWorker = new Worker(
    new URL(`data:text/javascript,${encodeURIComponent(HEALTH_SERVER_WORKER_SOURCE)}`),
    { type: "module", workerData: { state } },
  );
  Atomics.wait(view, 0, 0, 1000);
  const port = Atomics.load(view, 1);
  assert.ok(port > 0);

  await writeFile(
    path.join(remnicConfigDir, "config.json"),
    JSON.stringify({ server: { port: String(port) } }),
    "utf8",
  );

  try {
    process.env.HOME = homeDir;
    delete process.env.REMNIC_PORT;
    delete process.env.REMNIC_BRIDGE_MODE;
    delete process.env.ENGRAM_BRIDGE_MODE;

    const { detectBridgeMode } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
    const config = detectBridgeMode();
    assert.equal(config.mode, "delegate");
    assert.equal(config.daemonPort, port);
  } finally {
    await serverWorker.terminate();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPort === undefined) delete process.env.REMNIC_PORT;
    else process.env.REMNIC_PORT = previousPort;
    if (previousMode === undefined) delete process.env.REMNIC_BRIDGE_MODE;
    else process.env.REMNIC_BRIDGE_MODE = previousMode;
    if (previousLegacyMode === undefined) delete process.env.ENGRAM_BRIDGE_MODE;
    else process.env.ENGRAM_BRIDGE_MODE = previousLegacyMode;
  }
});

test("detectBridgeMode does not delegate for an installed but stopped daemon service", async () => {
  const previousHome = process.env.HOME;
  const previousPort = process.env.REMNIC_PORT;
  const previousMode = process.env.REMNIC_BRIDGE_MODE;
  const previousLegacyMode = process.env.ENGRAM_BRIDGE_MODE;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "bridge-service-stopped-"));
  const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");

  await mkdir(launchAgentsDir, { recursive: true });
  await writeFile(path.join(launchAgentsDir, "ai.remnic.daemon.plist"), "<plist />\n", "utf8");

  try {
    process.env.HOME = homeDir;
    process.env.REMNIC_PORT = "49999";
    delete process.env.REMNIC_BRIDGE_MODE;
    delete process.env.ENGRAM_BRIDGE_MODE;

    const { detectBridgeMode } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
    const config = detectBridgeMode();
    assert.equal(config.mode, "embedded");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPort === undefined) delete process.env.REMNIC_PORT;
    else process.env.REMNIC_PORT = previousPort;
    if (previousMode === undefined) delete process.env.REMNIC_BRIDGE_MODE;
    else process.env.REMNIC_BRIDGE_MODE = previousMode;
    if (previousLegacyMode === undefined) delete process.env.ENGRAM_BRIDGE_MODE;
    else process.env.ENGRAM_BRIDGE_MODE = previousLegacyMode;
  }
});

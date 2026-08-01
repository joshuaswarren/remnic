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
// Liveness-probe timings, shared by every checkDaemonHealth/checkDaemonHealthSync
// test below so the sync and async pairs cannot drift apart.
//
// bridge.ts derives every request timeout from ONE deadline
// (`deadline = Date.now() + timeoutMs`, then `remainingMs = deadline - now()`),
// so the budget is the TOTAL for a liveness probe plus its detailed-health
// fallback — not a per-request allowance.
//
// STALLED_DETAILED_HEALTH_MS must stay above PROBE_BUDGET_MS: that gap is what
// makes "returns true" prove the liveness path short-circuited. A probe that
// regressed into waiting on detailed health would exhaust the budget and
// return false, failing the test. The async tests previously budgeted 100 ms,
// which is not a reliable margin for one loopback round-trip on a loaded CI
// runner — let alone two (issue #2287).
//
// The stall is a real timer on purpose: it lives inside a worker-thread HTTP
// server (a separate JS realm), and the sync variant under test blocks the main
// thread with Atomics.wait. Fake timers can drive neither side, so the only
// lever available is a wide margin between the two constants below.
const PROBE_BUDGET_MS = 2_500;
const STALLED_DETAILED_HEALTH_MS = 3_000;
// The auto detector requires the daemon to report the SAME memoryDir, so the
// stubs below and every detect call agree on one corpus path.
const DETECT_MEMORY_DIR = path.join(os.tmpdir(), "bridge-detect-corpus");
const HEALTH_SERVER_WORKER_SOURCE = `
import { createServer } from "node:http";
import { workerData } from "node:worker_threads";

const view = new Int32Array(workerData.state);
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, memoryDir: workerData.memoryDir }));
});

server.listen(0, "127.0.0.1", () => {
  Atomics.store(view, 1, server.address().port);
  Atomics.store(view, 0, 1);
  Atomics.notify(view, 0);
});

setInterval(() => {}, 1000);
`;
const LIVENESS_SERVER_WORKER_SOURCE = `
import { createServer } from "node:http";
import { workerData } from "node:worker_threads";

const view = new Int32Array(workerData.state);
const server = createServer((req, res) => {
  Atomics.store(view, 2, req.url === "/engram/v1/live" ? 1 : 2);
  if (workerData.legacy) {
    res.writeHead(req.url === "/engram/v1/health" ? 200 : 404);
    res.end();
    return;
  }
  if (req.url === "/engram/v1/live") {
    res.writeHead(200);
    res.end();
    return;
  }
  setTimeout(() => {
    res.writeHead(200);
    res.end();
  }, ${STALLED_DETAILED_HEALTH_MS});
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

test("detectDaemonBridgeMode defaults to embedded when no daemon running", async (t) => {
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

  const { detectDaemonBridgeMode } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
  const config = detectDaemonBridgeMode({ memoryDir: DETECT_MEMORY_DIR });
  // Without a daemon running, should default to embedded
  assert.equal(config.mode, "embedded");
  assert.equal(config.daemonHost, "127.0.0.1");
  assert.ok(config.daemonPort > 0);
});

test("checkDaemonHealth returns false when nothing is listening", async () => {
  const { checkDaemonHealth } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
  const healthy = await checkDaemonHealth("127.0.0.1", 49999);
  assert.equal(healthy, false);
});

test("daemon health timeout default exceeds the server diagnostic deadline", async () => {
  const { DEFAULT_DAEMON_HEALTH_TIMEOUT_MS } = await import(
    path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts")
  );
  assert.ok(DEFAULT_DAEMON_HEALTH_TIMEOUT_MS > 2_000);
});

test("plugin parser owns the delegate health timeout contract", async () => {
  const bridge = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
  assert.equal(typeof bridge.parseOpenClawBridgeConfig, "function");
  assert.equal(bridge.parseOpenClawBridgeConfig({}).healthTimeoutMs, 10_000);
  assert.equal(
    bridge.parseOpenClawBridgeConfig({ bridgeHealthTimeoutMs: "7500" }).healthTimeoutMs,
    7_500,
  );
  assert.throws(
    () => bridge.parseOpenClawBridgeConfig({ bridgeHealthTimeoutMs: 0 }),
    /bridgeHealthTimeoutMs must be an integer in \[1, 120000\]/,
  );
  assert.throws(
    () => bridge.parseOpenClawBridgeConfig({ bridgeHealthTimeoutMs: 300_000 }),
    /bridgeHealthTimeoutMs must be an integer in \[1, 120000\]/,
  );
  assert.throws(
    () => bridge.parseOpenClawBridgeConfig({ bridgeHealthTimeoutMs: 3.7 }),
    /bridgeHealthTimeoutMs must be an integer in \[1, 120000\]/,
  );
});

test("sync probe ignores request timeout after a response starts the legacy fallback", async () => {
  const bridge = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
  const state = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const requests: Array<{
    respond(statusCode: number): void;
    emit(event: "error" | "timeout"): void;
  }> = [];
  const request = (
    _options: unknown,
    onResponse: (response: { statusCode?: number; resume(): void }) => void,
  ) => {
    const handlers = new Map<"error" | "timeout", () => void>();
    const handle = {
      on(event: "error" | "timeout", handler: () => void) {
        handlers.set(event, handler);
        return handle;
      },
      destroy() {},
      end() {},
    };
    requests.push({
      respond(statusCode) {
        onResponse({ statusCode, resume() {} });
      },
      emit(event) {
        handlers.get(event)?.();
      },
    });
    return handle;
  };

  bridge.runHealthWorker(request, {
    state,
    deadline: Date.now() + 1_000,
    host: "127.0.0.1",
    port: 4318,
    path: "/engram/v1/live",
    fallbackPath: "/engram/v1/health",
    token: "",
  });
  assert.equal(requests.length, 1);
  requests[0]?.respond(404);
  assert.equal(requests.length, 2);
  requests[0]?.emit("timeout");
  requests[1]?.respond(200);
  assert.equal(Atomics.load(new Int32Array(state), 0), 1);
});

test("checkDaemonHealth uses liveness without waiting for detailed health", async () => {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url ?? "");
    if (req.url === "/engram/v1/live") {
      res.writeHead(200);
      res.end();
      return;
    }
    setTimeout(() => {
      res.writeHead(200);
      res.end();
    }, STALLED_DETAILED_HEALTH_MS);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const { checkDaemonHealth } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
    assert.equal(await checkDaemonHealth("127.0.0.1", port, PROBE_BUDGET_MS), true);
    assert.deepEqual(paths, ["/engram/v1/live"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("checkDaemonHealthSync uses liveness without waiting for detailed health", async () => {
  const state = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
  const view = new Int32Array(state);
  const serverWorker = new Worker(
    new URL(`data:text/javascript,${encodeURIComponent(LIVENESS_SERVER_WORKER_SOURCE)}`),
    { workerData: { state } },
  );
  Atomics.wait(view, 0, 0, 1_000);
  const port = Atomics.load(view, 1);
  assert.ok(port > 0);

  try {
    const { checkDaemonHealthSync } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
    assert.equal(checkDaemonHealthSync("127.0.0.1", port, PROBE_BUDGET_MS), true);
    assert.equal(Atomics.load(view, 2), 1);
  } finally {
    await serverWorker.terminate();
  }
});

test("checkDaemonHealthSync falls back to detailed health for older daemons", async () => {
  const state = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
  const view = new Int32Array(state);
  const serverWorker = new Worker(
    new URL(`data:text/javascript,${encodeURIComponent(LIVENESS_SERVER_WORKER_SOURCE)}`),
    { workerData: { state, legacy: true } },
  );
  Atomics.wait(view, 0, 0, 1_000);
  const port = Atomics.load(view, 1);
  assert.ok(port > 0);

  try {
    const { checkDaemonHealthSync } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
    assert.equal(checkDaemonHealthSync("127.0.0.1", port, PROBE_BUDGET_MS), true);
    assert.equal(Atomics.load(view, 2), 2);
  } finally {
    await serverWorker.terminate();
  }
});

test("checkDaemonHealth falls back to detailed health for older daemons", async () => {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url ?? "");
    res.writeHead(req.url === "/engram/v1/health" ? 200 : 404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const { checkDaemonHealth } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
    assert.equal(await checkDaemonHealth("127.0.0.1", port, PROBE_BUDGET_MS), true);
    assert.deepEqual(paths, ["/engram/v1/live", "/engram/v1/health"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("liveness probe budget stays under the stalled detailed-health delay", () => {
  // Guards the four tests above. Raising PROBE_BUDGET_MS past the stall would
  // leave them passing while proving nothing: a probe that wrongly waited on
  // detailed health would then finish inside the budget and still return true.
  assert.ok(
    PROBE_BUDGET_MS < STALLED_DETAILED_HEALTH_MS,
    `PROBE_BUDGET_MS (${PROBE_BUDGET_MS}) must stay below STALLED_DETAILED_HEALTH_MS (${STALLED_DETAILED_HEALTH_MS})`,
  );
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

test("detectDaemonBridgeMode reads legacy config port when remnic config is malformed", async () => {
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

    const { detectDaemonBridgeMode } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
    const config = detectDaemonBridgeMode({ memoryDir: DETECT_MEMORY_DIR });
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

test("detectDaemonBridgeMode expands tilde-prefixed REMNIC_CONFIG_PATH", async () => {
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

    const { detectDaemonBridgeMode } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
    const config = detectDaemonBridgeMode({ memoryDir: DETECT_MEMORY_DIR });
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

test("detectDaemonBridgeMode does not delegate solely because a Remnic daemon pid file is live", async () => {
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

    const { detectDaemonBridgeMode } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
    const config = detectDaemonBridgeMode({ memoryDir: DETECT_MEMORY_DIR });
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

test("detectDaemonBridgeMode delegates when daemon service is installed and healthy without a pid file", async () => {
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
    { workerData: { state, memoryDir: DETECT_MEMORY_DIR } },
  );
  Atomics.wait(view, 0, 0, 1000);
  const port = Atomics.load(view, 1);
  assert.ok(port > 0);

  try {
    process.env.HOME = homeDir;
    process.env.REMNIC_PORT = String(port);
    delete process.env.REMNIC_BRIDGE_MODE;
    delete process.env.ENGRAM_BRIDGE_MODE;

    const { detectDaemonBridgeMode } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
    const config = detectDaemonBridgeMode({ memoryDir: DETECT_MEMORY_DIR });
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

test("detectDaemonBridgeMode delegates when legacy ai.remnic.server launchd service is healthy", async () => {
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
    { workerData: { state, memoryDir: DETECT_MEMORY_DIR } },
  );
  Atomics.wait(view, 0, 0, 1000);
  const port = Atomics.load(view, 1);
  assert.ok(port > 0);

  try {
    process.env.HOME = homeDir;
    process.env.REMNIC_PORT = String(port);
    delete process.env.REMNIC_BRIDGE_MODE;
    delete process.env.ENGRAM_BRIDGE_MODE;

    const { detectDaemonBridgeMode } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
    const config = detectDaemonBridgeMode({ memoryDir: DETECT_MEMORY_DIR });
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

test("detectDaemonBridgeMode delegates to a reachable local daemon without service metadata", async () => {
  const previousHome = process.env.HOME;
  const previousPort = process.env.REMNIC_PORT;
  const previousMode = process.env.REMNIC_BRIDGE_MODE;
  const previousLegacyMode = process.env.ENGRAM_BRIDGE_MODE;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "bridge-local-health-probe-"));

  const state = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const view = new Int32Array(state);
  const serverWorker = new Worker(
    new URL(`data:text/javascript,${encodeURIComponent(HEALTH_SERVER_WORKER_SOURCE)}`),
    { workerData: { state, memoryDir: DETECT_MEMORY_DIR } },
  );
  Atomics.wait(view, 0, 0, 1000);
  const port = Atomics.load(view, 1);
  assert.ok(port > 0);

  try {
    process.env.HOME = homeDir;
    process.env.REMNIC_PORT = String(port);
    delete process.env.REMNIC_BRIDGE_MODE;
    delete process.env.ENGRAM_BRIDGE_MODE;

    const { detectDaemonBridgeMode } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
    const config = detectDaemonBridgeMode({ memoryDir: DETECT_MEMORY_DIR });
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

test("detectDaemonBridgeMode coerces string config port before service health probing", async () => {
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
    { workerData: { state, memoryDir: DETECT_MEMORY_DIR } },
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

    const { detectDaemonBridgeMode } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
    const config = detectDaemonBridgeMode({ memoryDir: DETECT_MEMORY_DIR });
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

test("detectDaemonBridgeMode does not delegate for an installed but stopped daemon service", async () => {
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

    const { detectDaemonBridgeMode } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
    const config = detectDaemonBridgeMode({ memoryDir: DETECT_MEMORY_DIR });
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

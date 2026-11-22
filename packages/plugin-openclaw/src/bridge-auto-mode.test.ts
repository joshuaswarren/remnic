
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import {
  checkDaemonHealthSync,
  detectDaemonBridgeMode,
  isLoopbackDaemonHost,
  loadDaemonAuth,
  loopbackForSameHost,
  readDaemonConfigAuthToken,
  readDaemonMemoryDirSync,
  resolveBridgeMode,
  resolveUnitConfigPath,
  readUnitAuthToken,
  resolveSystemUnitSources,
  SYSTEMD_SYSTEM_UNIT_DIRS,
  systemdUserUnitDirs,
  resolveUnitEndpoint,
} from "./bridge.js";
import { daemonTargetFor } from "./delegate-daemon-target.js";

type HealthStub = {
  port: number;
  close: () => Promise<void>;
};

const STUB_SOURCE = `
import http from "node:http";
import { parentPort, workerData } from "node:worker_threads";
let served = 0;
const server = http.createServer((req, res) => {
  // \`hang\`: accept the connection and never answer, so the probe must burn its
  // whole timeout - the only way to observe a shared preflight deadline.
  if (workerData.hang) return;
  if (workerData.requireToken) {
    const auth = req.headers.authorization;
    if (auth !== \`Bearer \${workerData.requireToken}\`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
  }
  if (workerData.rejectBearer && req.headers.authorization) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  served += 1;
  // \`stallBody\`: send the headers and a partial body, then drop the socket.
  // Completion is decided AFTER the headers, so a probe that only watches for
  // a pre-header failure never signals and burns its whole budget.
  if (workerData.stallBody) {
    res.writeHead(workerData.status, { "content-type": "application/json" });
    res.write("{");
    setTimeout(() => res.socket?.destroy(), 50);
    return;
  }
  // \`warmupResponses\`: answer 503 (readiness gate closed) that many times
  // before switching to the real body, the way a daemon that is listening but
  // still warming up behaves.
  const warming = served <= (workerData.warmupResponses ?? 0);
  // \`delayMs\`: answer successfully, but slowly - a daemon that needs more
  // than a half-share of the preflight budget yet less than the whole.
  setTimeout(() => {
    res.writeHead(warming ? 503 : workerData.status, { "content-type": "application/json" });
    res.end(warming ? JSON.stringify({ ok: false, ready: false }) : workerData.body);
  }, workerData.delayMs ?? 0);
});
server.listen(0, workerData.listenHost ?? "127.0.0.1", () => {
  parentPort.postMessage({ port: server.address().port });
});
parentPort.on("message", (message) => {
  if (message === "close") server.close(() => process.exit(0));
});
`;

async function startHealthStub(
  body: unknown,
  status = 200,
  warmupResponses = 0,
  hang = false,
  requireToken?: string,
  stallBody = false,
  listenHost?: string,
  delayMs = 0,
  rejectBearer = false,
): Promise<HealthStub> {
  const worker = new Worker(
    new URL(`data:text/javascript,${encodeURIComponent(STUB_SOURCE)}`),
    {
      type: "module",
      workerData: {
        status,
        warmupResponses,
        hang,
        requireToken,
        stallBody,
        listenHost,
        delayMs,
        rejectBearer,
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
    } as ConstructorParameters<typeof Worker>[1] & { type: "module" },
  );
  const ready = Promise.withResolvers<number>();
  worker.on("message", (message: { port: number }) => ready.resolve(message.port));
  worker.on("error", ready.reject);
  const port = await ready.promise;
  return {
    port,
    close: async () => {
      worker.postMessage("close");
      await worker.terminate();
    },
  };
}

const ENV_KEYS = ["REMNIC_BRIDGE_MODE", "ENGRAM_BRIDGE_MODE", "REMNIC_HOST", "REMNIC_PORT"] as const;

function withDaemonEnv<T>(port: number | undefined, run: () => T): T {
  const prior = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) prior.set(key, process.env[key]);
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
  process.env.REMNIC_HOST = "127.0.0.1";
  if (port !== undefined) process.env.REMNIC_PORT = String(port);
  try {
    return run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = prior.get(key);
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}

const MEMORY_DIR = await realpath(await mkdtemp(path.join(os.tmpdir(), "remnic-auto-mode-")));

test("readDaemonMemoryDirSync captures the daemon's memoryDir from health", async () => {
  const stub = await startHealthStub({ ok: true, memoryDir: MEMORY_DIR, searchBackend: "qmd" });
  try {
    const health = withDaemonEnv(stub.port, () =>
      readDaemonMemoryDirSync("127.0.0.1", stub.port, 5_000),
    );
    assert.deepEqual(health, { healthy: true, memoryDir: MEMORY_DIR });
  } finally {
    await stub.close();
  }
});

test("readDaemonMemoryDirSync reports healthy-but-unknown when memoryDir is absent", async () => {
  const stub = await startHealthStub({ ok: true });
  try {
    const health = readDaemonMemoryDirSync("127.0.0.1", stub.port, 5_000);
    assert.deepEqual(health, { healthy: true, memoryDir: undefined });
  } finally {
    await stub.close();
  }
});

test("readDaemonMemoryDirSync survives a malformed health body", async () => {
  const stub = await startHealthStub("{not json");
  try {
    const health = readDaemonMemoryDirSync("127.0.0.1", stub.port, 5_000);
    assert.deepEqual(health, { healthy: true, memoryDir: undefined });
  } finally {
    await stub.close();
  }
});

test("readDaemonMemoryDirSync reports unhealthy for a non-200 daemon", async () => {
  const rejecting = await startHealthStub({ error: "unauthorized" }, 401);
  try {
    const health = readDaemonMemoryDirSync("127.0.0.1", rejecting.port, 5_000);
    assert.equal(health.healthy, false);
    assert.equal(health.failure, "auth");
    assert.equal(health.rejectedAuth, true);
    assert.equal(typeof health.authSource, "string");
  } finally {
    await rejecting.close();
  }
  const broken = await startHealthStub({ error: "boom" }, 500);
  try {
    assert.deepEqual(readDaemonMemoryDirSync("127.0.0.1", broken.port, 5_000), {
      healthy: false,
      memoryDir: undefined,
      failure: "http",
    });
  } finally {
    await broken.close();
  }
});

test("auto detection classifies HTTP 401 as an authentication failure", async () => {
  const rejecting = await startHealthStub({ error: "unauthorized" }, 401);
  try {
    const skipped: string[] = [];
    const result = withDaemonEnv(rejecting.port, () =>
      detectDaemonBridgeMode({ memoryDir: MEMORY_DIR, onSkip: (reason) => skipped.push(reason) }),
    );
    assert.equal(result.mode, "embedded");
    assert.match(skipped.join("\n"), /authentication/i);
    assert.doesNotMatch(skipped.join("\n"), /unreachable/i);
  } finally {
    await rejecting.close();
  }
});

test("readDaemonMemoryDirSync rejects an unroutable port without probing", () => {
  assert.deepEqual(readDaemonMemoryDirSync("127.0.0.1", 0, 500), {
    healthy: false,
    memoryDir: undefined,
    failure: "network",
  });
  assert.deepEqual(readDaemonMemoryDirSync("", 4318, 500), {
    healthy: false,
    memoryDir: undefined,
    failure: "network",
  });
});

test("auto delegates when the daemon serves the same corpus", async () => {
  const stub = await startHealthStub({ ok: true, memoryDir: MEMORY_DIR });
  try {
    const resolved = withDaemonEnv(stub.port, () =>
      resolveBridgeMode("auto", { memoryDir: MEMORY_DIR, timeoutMs: 5_000 }),
    );
    assert.equal(resolved.mode, "delegate");
    assert.equal(resolved.daemonPort, stub.port);
  } finally {
    await stub.close();
  }
});

test("auto tolerates trailing-slash and relative-segment spelling of one corpus", async () => {
  const stub = await startHealthStub({ ok: true, memoryDir: `${MEMORY_DIR}/` });
  try {
    const resolved = withDaemonEnv(stub.port, () =>
      resolveBridgeMode("auto", {
        memoryDir: path.join(MEMORY_DIR, "..", path.basename(MEMORY_DIR)),
        timeoutMs: 5_000,
      }),
    );
    assert.equal(resolved.mode, "delegate");
  } finally {
    await stub.close();
  }
});

test("auto stays embedded when the daemon serves a different corpus", async () => {
  const stub = await startHealthStub({ ok: true, memoryDir: path.join(os.tmpdir(), "other-corpus") });
  const reasons: string[] = [];
  try {
    const resolved = withDaemonEnv(stub.port, () =>
      resolveBridgeMode("auto", {
        memoryDir: MEMORY_DIR,
        timeoutMs: 5_000,
        onSkip: (reason) => reasons.push(reason),
      }),
    );
    assert.equal(resolved.mode, "embedded");
    assert.match(reasons.join("\n"), /different memoryDir/);
  } finally {
    await stub.close();
  }
});

test("auto stays embedded when the daemon does not report a memoryDir", async () => {
  const stub = await startHealthStub({ ok: true });
  const reasons: string[] = [];
  try {
    const resolved = withDaemonEnv(stub.port, () =>
      resolveBridgeMode("auto", {
        memoryDir: MEMORY_DIR,
        timeoutMs: 5_000,
        onSkip: (reason) => reasons.push(reason),
      }),
    );
    assert.equal(
      resolved.mode,
      "embedded",
      "an unconfirmable corpus must fail closed, never assume a match",
    );
    assert.match(reasons.join("\n"), /did not report a memoryDir/);
  } finally {
    await stub.close();
  }
});

test("auto stays embedded when no daemon answers", () => {
  const reasons: string[] = [];
  const resolved = withDaemonEnv(1, () =>
    resolveBridgeMode("auto", {
      memoryDir: MEMORY_DIR,
      timeoutMs: 1_500,
      onSkip: (reason) => reasons.push(reason),
    }),
  );
  assert.equal(resolved.mode, "embedded");
  assert.match(reasons.join("\n"), /no healthy daemon/);
});

test("an explicit env override outranks auto in both directions", async () => {
  const stub = await startHealthStub({ ok: true, memoryDir: MEMORY_DIR });
  try {
    withDaemonEnv(stub.port, () => {
      process.env.REMNIC_BRIDGE_MODE = "embedded";
      assert.equal(
        resolveBridgeMode("auto", { memoryDir: MEMORY_DIR, timeoutMs: 5_000 }).mode,
        "embedded",
        "env embedded wins even though the daemon would qualify",
      );
      process.env.REMNIC_BRIDGE_MODE = "auto";
      assert.equal(
        resolveBridgeMode("embedded", { memoryDir: MEMORY_DIR, timeoutMs: 5_000 }).mode,
        "delegate",
        "env auto detects even though config says embedded",
      );
    });
  } finally {
    await stub.close();
  }
});

test("auto requires a memoryDir to verify against", () => {
  withDaemonEnv(undefined, () => {
    assert.throws(
      () => resolveBridgeMode("auto", { timeoutMs: 500 }),
      /requires a configured memoryDir/,
    );
    assert.throws(
      () => resolveBridgeMode("auto", { memoryDir: "   ", timeoutMs: 500 }),
      /requires a configured memoryDir/,
    );
  });
});

test("resolveBridgeMode rejects unknown values and names auto in the error", () => {
  withDaemonEnv(undefined, () => {
    assert.throws(() => resolveBridgeMode("daemon"), /expected "embedded", "delegate", or "auto"/);
    assert.throws(() => resolveBridgeMode("AUTO"), /Invalid bridgeMode/);
    process.env.REMNIC_BRIDGE_MODE = "daemon";
    assert.throws(
      () => resolveBridgeMode("embedded"),
      /Invalid REMNIC_BRIDGE_MODE env override/,
    );
  });
});

test("auto gives the loopback and interface aliases of one daemon a shared probe budget", async () => {
  const local = Object.values(os.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .find((entry) => entry.family === "IPv4" && !entry.internal);
  if (local === undefined) return;
  const stub = await startHealthStub(
    { ok: true, memoryDir: MEMORY_DIR },
    200,
    0,
    false,
    undefined,
    false,
    "0.0.0.0",
    900,
  );
  try {
    const resolved = withDaemonEnv(stub.port, () => {
      process.env.REMNIC_HOST = local.address;
      return resolveBridgeMode("auto", { memoryDir: MEMORY_DIR, timeoutMs: 1_500 });
    });
    assert.equal(resolved.mode, "delegate");
    assert.equal(resolved.daemonPort, stub.port);
  } finally {
    await stub.close();
  }
});

test("auto refuses a non-loopback daemon endpoint", async () => {
  const stub = await startHealthStub({ ok: true, memoryDir: MEMORY_DIR });
  const reasons: string[] = [];
  try {
    const prior = process.env.REMNIC_HOST;
    withDaemonEnv(stub.port, () => {
      process.env.REMNIC_HOST = "10.0.0.9";
      const resolved = resolveBridgeMode("auto", {
        memoryDir: MEMORY_DIR,
        timeoutMs: 1_500,
        onSkip: (reason) => reasons.push(reason),
      });
      assert.equal(resolved.mode, "embedded");
      assert.match(reasons.join("\n"), /not loopback/);
    });
    assert.equal(process.env.REMNIC_HOST, prior);
  } finally {
    await stub.close();
  }
});

test("auto matches an aliased parent but refuses a symlinked corpus root", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "remnic-auto-link-")));
  const holder = path.join(root, "holder");
  const real = path.join(holder, "real-memory");
  await mkdir(real, { recursive: true });
  const aliasedHolder = path.join(root, "aliased-holder");
  await symlink(holder, aliasedHolder);
  const stub = await startHealthStub({ ok: true, memoryDir: real });
  try {
    const reasons: string[] = [];
    assert.equal(
      withDaemonEnv(stub.port, () =>
        resolveBridgeMode("auto", {
          memoryDir: path.join(aliasedHolder, "real-memory"),
          timeoutMs: 5_000,
          onSkip: (reason) => reasons.push(reason),
        }),
      ).mode,
      "delegate",
      "two spellings of one directory must not start a second orchestrator beside the daemon",
    );
    assert.deepEqual(reasons, []);

    const linkedRoot = path.join(root, "linked-memory");
    await symlink(real, linkedRoot);
    assert.equal(
      withDaemonEnv(stub.port, () =>
        resolveBridgeMode("auto", { memoryDir: linkedRoot, timeoutMs: 5_000 }),
      ).mode,
      "embedded",
    );
  } finally {
    await stub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("detectDaemonBridgeMode is the auto probe and ignores explicit env modes", async () => {
  const stub = await startHealthStub({ ok: true, memoryDir: MEMORY_DIR });
  try {
    withDaemonEnv(stub.port, () => {
      process.env.REMNIC_BRIDGE_MODE = "embedded";
      assert.equal(
        detectDaemonBridgeMode({ memoryDir: MEMORY_DIR, timeoutMs: 5_000 }).mode,
        "delegate",
      );
    });
  } finally {
    await stub.close();
  }
});

test("auto delegates to a daemon serving a namespace under the corpus root", async () => {
  const namespaceDir = path.join(MEMORY_DIR, "namespaces", "generalist");
  await mkdir(namespaceDir, { recursive: true });
  const stub = await startHealthStub({ ok: true, memoryDir: namespaceDir });
  try {
    const resolved = withDaemonEnv(stub.port, () =>
      resolveBridgeMode("auto", { memoryDir: MEMORY_DIR, timeoutMs: 5_000 }),
    );
    assert.equal(resolved.mode, "delegate");
  } finally {
    await stub.close();
  }
});

test("auto stays embedded when either corpus identity is relative", async () => {
  const stub = await startHealthStub({ ok: true, memoryDir: "./memory" });
  const reasons: string[] = [];
  try {
    const resolved = withDaemonEnv(stub.port, () =>
      resolveBridgeMode("auto", {
        memoryDir: MEMORY_DIR,
        timeoutMs: 5_000,
        onSkip: (reason) => reasons.push(reason),
      }),
    );
    assert.equal(
      resolved.mode,
      "embedded",
      "a relative daemon path resolves against a different cwd, so it proves nothing",
    );
    assert.match(reasons.join("\n"), /different memoryDir/);
  } finally {
    await stub.close();
  }
});

test("auto rejects a DNS name that merely looks loopback", async () => {
  const reasons: string[] = [];
  const resolved = withDaemonEnv(4318, () => {
    process.env.REMNIC_HOST = "127.daemon.example";
    return resolveBridgeMode("auto", {
      memoryDir: MEMORY_DIR,
      timeoutMs: 1_500,
      onSkip: (reason) => reasons.push(reason),
    });
  });
  assert.equal(resolved.mode, "embedded");
  assert.match(reasons.join("\n"), /not loopback/);
});

test("auto accepts every literal loopback spelling", async () => {
  const stub = await startHealthStub({ ok: true, memoryDir: MEMORY_DIR });
  try {
    for (const host of ["127.0.0.1", "localhost"]) {
      const resolved = withDaemonEnv(stub.port, () => {
        process.env.REMNIC_HOST = host;
        return resolveBridgeMode("auto", { memoryDir: MEMORY_DIR, timeoutMs: 5_000 });
      });
      assert.equal(resolved.mode, "delegate", host);
    }
    for (const host of ["127.1.2.3", "[::1]", "::1"]) {
      const reasons: string[] = [];
      const resolved = withDaemonEnv(stub.port, () => {
        process.env.REMNIC_HOST = host;
        return resolveBridgeMode("auto", {
          memoryDir: MEMORY_DIR,
          timeoutMs: 1_500,
          onSkip: (reason) => reasons.push(reason),
        });
      });
      assert.equal(resolved.mode, "embedded", host);
      assert.doesNotMatch(reasons.join("\n"), /not loopback/, host);
    }
  } finally {
    await stub.close();
  }
});

test("auto reports an oversized daemon memoryDir as unknown, never truncated", async () => {
  const huge = `/${"x".repeat(2_000)}`;
  const stub = await startHealthStub({ ok: true, memoryDir: huge });
  const reasons: string[] = [];
  try {
    const health = withDaemonEnv(stub.port, () =>
      readDaemonMemoryDirSync("127.0.0.1", stub.port, 5_000),
    );
    assert.deepEqual(health, { healthy: true, memoryDir: undefined });
    const resolved = withDaemonEnv(stub.port, () =>
      resolveBridgeMode("auto", {
        memoryDir: huge,
        timeoutMs: 5_000,
        onSkip: (reason) => reasons.push(reason),
      }),
    );
    assert.equal(resolved.mode, "embedded");
    assert.match(reasons.join("\n"), /did not report a memoryDir/);
  } finally {
    await stub.close();
  }
});

test("auto marks its resolution health-verified so the caller skips a second probe", async () => {
  const stub = await startHealthStub({ ok: true, memoryDir: MEMORY_DIR });
  try {
    const auto = withDaemonEnv(stub.port, () =>
      resolveBridgeMode("auto", { memoryDir: MEMORY_DIR, timeoutMs: 5_000 }),
    );
    assert.equal(auto.mode, "delegate");
    assert.equal(auto.healthVerified, true);
    const explicit = withDaemonEnv(stub.port, () => resolveBridgeMode("delegate"));
    assert.equal(explicit.mode, "delegate");
    assert.equal(
      explicit.healthVerified,
      undefined,
      "explicit delegate has probed nothing, so the caller must still preflight",
    );
  } finally {
    await stub.close();
  }
});

test("auto treats a wildcard daemon bind as same-host", async () => {
  const stub = await startHealthStub({ ok: true, memoryDir: MEMORY_DIR });
  try {
    for (const bind of ["0.0.0.0", "::"]) {
      const reasons: string[] = [];
      const resolved = withDaemonEnv(stub.port, () => {
        process.env.REMNIC_HOST = bind;
        return resolveBridgeMode("auto", {
          memoryDir: MEMORY_DIR,
          timeoutMs: 5_000,
          onSkip: (reason) => reasons.push(reason),
        });
      });
      assert.doesNotMatch(reasons.join("\n"), /not loopback/, bind);
      if (bind === "0.0.0.0") {
        assert.equal(resolved.mode, "delegate", bind);
        assert.equal(resolved.daemonHost, "127.0.0.1", "dialed through loopback, not the wildcard");
      }
    }
  } finally {
    await stub.close();
  }
});

test("a daemon still warming up is waited out, not classified as absent", async () => {
  const stub = await startHealthStub(
    { ok: true, memoryDir: MEMORY_DIR, searchBackend: "qmd" },
    200,
    3,
  );
  try {
    const health = withDaemonEnv(stub.port, () =>
      readDaemonMemoryDirSync("127.0.0.1", stub.port, 5_000),
    );
    assert.deepEqual(health, { healthy: true, memoryDir: MEMORY_DIR });
  } finally {
    await stub.close();
  }
});

test("a daemon that never opens its readiness gate stays unhealthy", async () => {
  const stub = await startHealthStub({ ok: true, memoryDir: MEMORY_DIR }, 200, 1_000);
  const started = Date.now();
  try {
    const healthy = withDaemonEnv(stub.port, () =>
      checkDaemonHealthSync("127.0.0.1", stub.port, 1_200),
    );
    assert.equal(healthy, false);
    assert.ok(Date.now() - started < 4_000, "gives up inside the deadline");
  } finally {
    await stub.close();
  }
});

test("#3077 liveness probe does not send a bearer token", async () => {
  const stub = await startHealthStub({ ok: true }, 200, 0, false, undefined, false, undefined, 0, true);
  const prior = process.env.REMNIC_AUTH_TOKEN;
  process.env.REMNIC_AUTH_TOKEN = "should-not-be-sent";
  try {
    assert.equal(
      withDaemonEnv(stub.port, () => checkDaemonHealthSync("127.0.0.1", stub.port, 2_000)),
      true,
    );
  } finally {
    if (prior === undefined) Reflect.deleteProperty(process.env, "REMNIC_AUTH_TOKEN");
    else process.env.REMNIC_AUTH_TOKEN = prior;
    await stub.close();
  }
});

test("#3077 liveness treats an anonymous 401 as a live daemon", async () => {
  const stub = await startHealthStub({ ok: true }, 200, 0, false, "daemon-token");
  try {
    assert.equal(
      withDaemonEnv(stub.port, () => checkDaemonHealthSync("127.0.0.1", stub.port, 2_000)),
      true,
    );
  } finally {
    await stub.close();
  }
});



test("host and port come from ONE config file, never spliced across two", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-split-config-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "remnic-split-cwd-"));
  await mkdir(path.join(home, ".config", "remnic"), { recursive: true });
  await writeFile(
    path.join(cwd, "remnic.config.json"),
    JSON.stringify({ server: { host: "127.0.0.9" } }),
    "utf8",
  );
  await writeFile(
    path.join(home, ".config", "remnic", "config.json"),
    JSON.stringify({ server: { host: "127.0.0.5", port: 4999 } }),
    "utf8",
  );
  const priorHome = process.env.HOME;
  const priorCwd = process.cwd();
  try {
    process.env.HOME = home;
    process.chdir(cwd);
    const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
    let bridge;
    try {
      bridge = detectDaemonBridgeMode({ memoryDir: MEMORY_DIR });
    } finally {
      for (const [key, value] of priorEnv) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
    assert.equal(bridge.daemonHost, "127.0.0.9", "the selected file's host");
    assert.equal(bridge.daemonPort, 4318, "and its DEFAULT port, not the other file's");
  } finally {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the installed service's pinned config path outranks the gateway's cwd", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-unit-config-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "remnic-unit-cwd-"));
  await mkdir(path.join(home, ".config", "remnic"), { recursive: true });
  await mkdir(path.join(home, ".config", "systemd", "user"), { recursive: true });
  await writeFile(
    path.join(home, ".config", "systemd", "user", "remnic.service"),
    "[Service]\nEnvironment=REMNIC_CONFIG_PATH=%h/.config/remnic/config.json\n",
    "utf8",
  );
  await writeFile(
    path.join(home, ".config", "remnic", "config.json"),
    JSON.stringify({ server: { host: "127.0.0.1", port: 4600 } }),
    "utf8",
  );
  await writeFile(
    path.join(cwd, "remnic.config.json"),
    JSON.stringify({ server: { host: "127.0.0.1", port: 4700 } }),
    "utf8",
  );
  const priorHome = process.env.HOME;
  const priorCwd = process.cwd();
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
  try {
    process.env.HOME = home;
    process.chdir(cwd);
    assert.equal(detectDaemonBridgeMode({ memoryDir: MEMORY_DIR }).daemonPort, 4600);
    process.env.REMNIC_CONFIG_PATH = path.join(cwd, "remnic.config.json");
    assert.equal(detectDaemonBridgeMode({ memoryDir: MEMORY_DIR }).daemonPort, 4700);
  } finally {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("env config path home references expand exactly like the server and CLI", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-env-homeform-"));
  await mkdir(path.join(home, "opt"), { recursive: true });
  const configPath = path.join(home, "opt", "remnic.json");
  await writeFile(configPath, JSON.stringify({ server: { host: "127.0.0.1", port: 4711 } }), "utf8");
  const priorHome = process.env.HOME;
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
  delete process.env.REMNIC_CONFIG_PATH;
  delete process.env.ENGRAM_CONFIG_PATH;
  try {
    process.env.HOME = home;
    for (const form of ["$HOME/opt/remnic.json", "${HOME}/opt/remnic.json", "~/opt/remnic.json"]) {
      process.env.REMNIC_CONFIG_PATH = form;
      const detected = detectDaemonBridgeMode({ memoryDir: MEMORY_DIR, unitExists: () => false });
      assert.equal(detected.daemonConfigPath, configPath, `config path for ${form}`);
      assert.equal(detected.daemonPort, 4711, `port for ${form}`);
    }
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    delete process.env.REMNIC_CONFIG_PATH;
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("a config whose server block is not an object is skipped, not adopted", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-bad-server-"));
  await mkdir(path.join(home, ".config", "remnic"), { recursive: true });
  await mkdir(path.join(home, ".config", "engram"), { recursive: true });
  await writeFile(
    path.join(home, ".config", "remnic", "config.json"),
    JSON.stringify({ server: [1, 2, 3] }),
    "utf8",
  );
  await writeFile(
    path.join(home, ".config", "engram", "config.json"),
    JSON.stringify({ server: { port: 4700 } }),
    "utf8",
  );
  const priorHome = process.env.HOME;
  const priorCwd = process.cwd();
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
  try {
    process.env.HOME = home;
    process.chdir(home);
    assert.equal(detectDaemonBridgeMode({ memoryDir: MEMORY_DIR }).daemonPort, 4700);
  } finally {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("auto probes past a stale unit config to the daemon that is actually up", async () => {
  const stub = await startHealthStub({ ok: true, memoryDir: MEMORY_DIR, searchBackend: "qmd" });
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-stale-unit-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "remnic-stale-cwd-"));
  await mkdir(path.join(home, ".config", "remnic"), { recursive: true });
  await mkdir(path.join(home, ".config", "systemd", "user"), { recursive: true });
  await writeFile(
    path.join(home, ".config", "systemd", "user", "remnic.service"),
    "[Service]\nEnvironment=REMNIC_CONFIG_PATH=%h/.config/remnic/config.json\n",
    "utf8",
  );
  await writeFile(
    path.join(home, ".config", "remnic", "config.json"),
    JSON.stringify({ server: { host: "127.0.0.1", port: 4601 } }),
    "utf8",
  );
  await writeFile(
    path.join(cwd, "remnic.config.json"),
    JSON.stringify({ server: { host: "127.0.0.1", port: stub.port } }),
    "utf8",
  );
  const priorHome = process.env.HOME;
  const priorCwd = process.cwd();
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
  try {
    process.env.HOME = home;
    process.chdir(cwd);
    const bridge = detectDaemonBridgeMode({ memoryDir: MEMORY_DIR, timeoutMs: 3_000 });
    assert.equal(bridge.mode, "delegate");
    assert.equal(bridge.daemonPort, stub.port, "found the daemon that is actually listening");
  } finally {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await stub.close();
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a system unit's %h is not expanded with the gateway's home", () => {
  // systemd expands %h in the SERVICE MANAGER's account. A system unit may run
  // as another user, so substituting our home would name a file the daemon
  // never read - and send auto at the wrong endpoint.
  const unit = "[Service]\nEnvironment=REMNIC_CONFIG_PATH=%h/.config/remnic/config.json\n";
  assert.equal(
    resolveUnitConfigPath(unit, { userScoped: false, homeDir: "/home/gateway" }),
    undefined,
    "a system unit must carry a literal absolute path",
  );
  assert.equal(
    resolveUnitConfigPath(unit, { userScoped: true, homeDir: "/home/gateway" }),
    "/home/gateway/.config/remnic/config.json",
    "a user unit runs in OUR account, so %h is ours",
  );
  assert.equal(
    resolveUnitConfigPath(
      "[Service]\nEnvironment=REMNIC_CONFIG_PATH=/etc/remnic/config.json\n",
      { userScoped: false, homeDir: "/home/gateway" },
    ),
    "/etc/remnic/config.json",
    "a literal system path is honored",
  );
  assert.equal(
    resolveUnitConfigPath(
      "<key>REMNIC_CONFIG_PATH</key>\n<string>/Users/x/.config/remnic/config.json</string>",
      { userScoped: true, homeDir: "/Users/x" },
    ),
    "/Users/x/.config/remnic/config.json",
    "launchd plists carry literal paths",
  );
});

test("auto still probes the documented default when no config file exists", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-no-config-"));
  const priorHome = process.env.HOME;
  const priorCwd = process.cwd();
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
  const probed: string[] = [];
  try {
    process.env.HOME = home;
    process.chdir(home);
    const bridge = detectDaemonBridgeMode({
      memoryDir: MEMORY_DIR,
      timeoutMs: 1_000,
      onSkip: (reason) => probed.push(reason),
    });
    assert.equal(bridge.daemonHost, "127.0.0.1");
    assert.equal(bridge.daemonPort, 4318);
    assert.ok(
      probed.some((reason) => reason.includes("127.0.0.1:4318")),
      `the default endpoint was actually probed: ${JSON.stringify(probed)}`,
    );
  } finally {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("auto spends ONE preflight budget across every candidate endpoint", async () => {
  const stubs = await Promise.all([
    startHealthStub({}, 200, 0, true),
    startHealthStub({}, 200, 0, true),
    startHealthStub({}, 200, 0, true),
  ]);
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-budget-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "remnic-budget-cwd-"));
  await mkdir(path.join(home, ".config", "remnic"), { recursive: true });
  await mkdir(path.join(home, ".config", "engram"), { recursive: true });
  await writeFile(
    path.join(cwd, "remnic.config.json"),
    JSON.stringify({ server: { host: "127.0.0.1", port: stubs[0]?.port } }),
    "utf8",
  );
  await writeFile(
    path.join(home, ".config", "remnic", "config.json"),
    JSON.stringify({ server: { host: "127.0.0.1", port: stubs[1]?.port } }),
    "utf8",
  );
  await writeFile(
    path.join(home, ".config", "engram", "config.json"),
    JSON.stringify({ server: { host: "127.0.0.1", port: stubs[2]?.port } }),
    "utf8",
  );
  const priorHome = process.env.HOME;
  const priorCwd = process.cwd();
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
  const started = Date.now();
  try {
    process.env.HOME = home;
    process.chdir(cwd);
    const bridge = detectDaemonBridgeMode({ memoryDir: MEMORY_DIR, timeoutMs: 1_200 });
    assert.equal(bridge.mode, "embedded");
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < 1_200 * 2,
      `three hanging candidates must share one 1200ms budget, took ${elapsed}ms`,
    );
  } finally {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await Promise.all(stubs.map((stub) => stub.close()));
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("equivalent IPv6 loopback and wildcard spellings are recognized", () => {
  for (const spelling of [
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
    "0000:0000:0000:0000:0000:0000:0000:0001",
    "::ffff:127.0.0.1",
    "::FFFF:127.0.0.1",
    // Loopback classification is core's shared helper (issue #3012), so RFC
    // 6761 loopback subdomains resolve here exactly as everywhere else.
    "daemon.localhost",
  ]) {
    assert.equal(isLoopbackDaemonHost(spelling), true, `${spelling} is loopback`);
  }
  for (const spelling of ["::", "[::]", "0:0:0:0:0:0:0:0", "0.0.0.0"]) {
    assert.equal(isLoopbackDaemonHost(spelling), true, `${spelling} is a wildcard bind`);
    assert.ok(loopbackForSameHost(spelling) !== undefined, `${spelling} dials through loopback`);
  }
  for (const spelling of ["2001:db8::1", "::ffff:10.0.0.1", "127.daemon.example"]) {
    assert.equal(isLoopbackDaemonHost(spelling), false, `${spelling} is not loopback`);
  }
});

test("an address assigned to one of this host's interfaces is dialed through loopback", () => {
  const local = Object.values(os.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .find((entry) => entry.family === "IPv4" && !entry.internal);
  if (local === undefined) return;
  assert.equal(loopbackForSameHost(local.address), "127.0.0.1", `${local.address} is this host`);
  assert.equal(isLoopbackDaemonHost(local.address), true);
  assert.equal(loopbackForSameHost(`::ffff:${local.address}`), "127.0.0.1");
  assert.equal(isLoopbackDaemonHost(`[::ffff:${local.address}]`), true);
  const resolved = withDaemonEnv(undefined, () => {
    process.env.REMNIC_HOST = local.address;
    return resolveBridgeMode("delegate");
  });
  assert.equal(resolved.daemonHost, "127.0.0.1", "explicit delegate dials loopback, not the NIC");
  // A routable address that is NOT on this host stays remote (RFC 5737 TEST-NET-1).
  assert.equal(loopbackForSameHost("192.0.2.1"), undefined);
  assert.equal(isLoopbackDaemonHost("192.0.2.1"), false);
});

test("a daemon bound to one interface address only is reached through the configured address", async () => {
  const local = Object.values(os.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .find((entry) => entry.family === "IPv4" && !entry.internal);
  if (local === undefined) return;
  const stub = await startHealthStub(
    { ok: true, memoryDir: MEMORY_DIR },
    200,
    0,
    false,
    undefined,
    false,
    local.address,
  );
  try {
    const explicit = withDaemonEnv(stub.port, () => {
      process.env.REMNIC_HOST = local.address;
      return resolveBridgeMode("delegate");
    });
    assert.equal(explicit.daemonHost, "127.0.0.1");
    assert.equal(explicit.daemonHostFallback, local.address);
    assert.equal(checkDaemonHealthSync("127.0.0.1", stub.port, 2_000), false, "loopback refuses");
    assert.equal(checkDaemonHealthSync(local.address, stub.port, 2_000), true, "the NIC answers");

    const auto = withDaemonEnv(stub.port, () => {
      process.env.REMNIC_HOST = local.address;
      return resolveBridgeMode("auto", { memoryDir: MEMORY_DIR, timeoutMs: 5_000 });
    });
    assert.equal(auto.mode, "delegate", "auto falls through to the configured address");
    assert.equal(auto.daemonHost, local.address);
  } finally {
    await stub.close();
  }
});

test("each probed endpoint carries its own config's token", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-token-bind-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "remnic-token-bind-cwd-"));
  await mkdir(path.join(home, ".config", "remnic"), { recursive: true });
  const cwdConfig = path.join(cwd, "remnic.config.json");
  const homeConfig = path.join(home, ".config", "remnic", "config.json");
  await writeFile(
    cwdConfig,
    JSON.stringify({ server: { host: "127.0.0.1", port: 4941, authToken: "cwd-token" } }),
    "utf8",
  );
  await writeFile(
    homeConfig,
    JSON.stringify({ server: { host: "127.0.0.1", port: 4942, authToken: "home-token" } }),
    "utf8",
  );
  const priorHome = process.env.HOME;
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
  try {
    process.env.HOME = home;
    assert.deepEqual(loadDaemonAuth(cwdConfig), {
      token: "cwd-token",
      source: "daemon configuration",
    });
    assert.deepEqual(loadDaemonAuth(homeConfig), {
      token: "home-token",
      source: "daemon configuration",
    });
    const openConfig = path.join(home, "open.config.json");
    await writeFile(openConfig, JSON.stringify({ server: { port: 4943 } }), "utf8");
    assert.deepEqual(loadDaemonAuth(openConfig), { token: "", source: "no configured token" });
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("auto probes every installed unit, not just the first", async () => {
  const stub = await startHealthStub({ ok: true, memoryDir: MEMORY_DIR, searchBackend: "qmd" });
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-two-units-"));
  await mkdir(path.join(home, ".config", "remnic"), { recursive: true });
  await mkdir(path.join(home, ".config", "systemd", "user"), { recursive: true });
  await mkdir(path.join(home, "opt"), { recursive: true });
  await writeFile(
    path.join(home, ".config", "systemd", "user", "remnic.service"),
    "[Service]\nEnvironment=REMNIC_CONFIG_PATH=%h/.config/remnic/config.json\n",
    "utf8",
  );
  await writeFile(
    path.join(home, ".config", "systemd", "user", "engram.service"),
    `[Service]\nEnvironment=REMNIC_CONFIG_PATH=${path.join(home, "opt", "legacy.json")}\n`,
    "utf8",
  );
  await writeFile(
    path.join(home, ".config", "remnic", "config.json"),
    JSON.stringify({ server: { host: "127.0.0.1", port: 4951 } }),
    "utf8",
  );
  await writeFile(
    path.join(home, "opt", "legacy.json"),
    JSON.stringify({ server: { host: "127.0.0.1", port: stub.port } }),
    "utf8",
  );
  const priorHome = process.env.HOME;
  const priorCwd = process.cwd();
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
  try {
    process.env.HOME = home;
    process.chdir(home);
    const bridge = detectDaemonBridgeMode({ memoryDir: MEMORY_DIR, timeoutMs: 5_000 });
    assert.equal(bridge.mode, "delegate");
    assert.equal(bridge.daemonPort, stub.port, "the second unit's daemon was found");
  } finally {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await stub.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("two configs on one endpoint with different tokens are both probed", async () => {
  const stub = await startHealthStub(
    { ok: true, memoryDir: MEMORY_DIR, searchBackend: "qmd" },
    200,
    0,
    false,
    "live-token",
  );
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-dupe-endpoint-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "remnic-dupe-cwd-"));
  await mkdir(path.join(home, ".config", "remnic"), { recursive: true });
  await mkdir(path.join(home, ".config", "systemd", "user"), { recursive: true });
  await writeFile(
    path.join(home, ".config", "systemd", "user", "remnic.service"),
    "[Service]\nEnvironment=REMNIC_CONFIG_PATH=%h/.config/remnic/config.json\n",
    "utf8",
  );
  const endpoint = { host: "127.0.0.1", port: stub.port };
  await writeFile(
    path.join(home, ".config", "remnic", "config.json"),
    JSON.stringify({ server: { ...endpoint, authToken: "stale-token" } }),
    "utf8",
  );
  await writeFile(
    path.join(cwd, "remnic.config.json"),
    JSON.stringify({ server: { ...endpoint, authToken: "live-token" } }),
    "utf8",
  );
  const priorHome = process.env.HOME;
  const priorCwd = process.cwd();
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
  try {
    process.env.HOME = home;
    process.chdir(cwd);
    const bridge = detectDaemonBridgeMode({ memoryDir: MEMORY_DIR, timeoutMs: 5_000 });
    assert.equal(bridge.mode, "delegate", "the live credential was retried on the same endpoint");
    assert.equal(
      bridge.daemonConfigPath,
      path.join(cwd, "remnic.config.json"),
      "and delegate requests bind to the config that actually authenticated",
    );
  } finally {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await stub.close();
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("explicit delegate keeps the daemon's own config order, ignoring a stale unit", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-explicit-order-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "remnic-explicit-cwd-"));
  await mkdir(path.join(home, ".config", "remnic"), { recursive: true });
  await mkdir(path.join(home, ".config", "systemd", "user"), { recursive: true });
  await writeFile(
    path.join(home, ".config", "systemd", "user", "remnic.service"),
    "[Service]\nEnvironment=REMNIC_CONFIG_PATH=%h/.config/remnic/config.json\n",
    "utf8",
  );
  await writeFile(
    path.join(home, ".config", "remnic", "config.json"),
    JSON.stringify({ server: { host: "127.0.0.1", port: 4801 } }),
    "utf8",
  );
  await writeFile(
    path.join(cwd, "remnic.config.json"),
    JSON.stringify({ server: { host: "127.0.0.1", port: 4802 } }),
    "utf8",
  );
  const priorHome = process.env.HOME;
  const priorCwd = process.cwd();
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
  try {
    process.env.HOME = home;
    process.chdir(cwd);
    process.env.REMNIC_BRIDGE_MODE = "delegate";
    const bridge = resolveBridgeMode("", { memoryDir: MEMORY_DIR });
    assert.equal(bridge.mode, "delegate");
    assert.equal(bridge.daemonPort, 4802, "the cwd config wins, as it does for the server");
  } finally {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a unit's REMNIC_HOST/PORT override its config file when probing", async () => {
  const stub = await startHealthStub({ ok: true, memoryDir: MEMORY_DIR, searchBackend: "qmd" });
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-unit-env-"));
  await mkdir(path.join(home, ".config", "remnic"), { recursive: true });
  await mkdir(path.join(home, ".config", "systemd", "user"), { recursive: true });
  await writeFile(
    path.join(home, ".config", "systemd", "user", "remnic.service"),
    [
      "[Service]",
      "Environment=REMNIC_CONFIG_PATH=%h/.config/remnic/config.json",
      "Environment=REMNIC_HOST=127.0.0.1",
      `Environment=REMNIC_PORT=${stub.port}`,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(home, ".config", "remnic", "config.json"),
    JSON.stringify({ server: { host: "127.0.0.1", port: 4803 } }),
    "utf8",
  );
  const priorHome = process.env.HOME;
  const priorCwd = process.cwd();
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
  try {
    process.env.HOME = home;
    process.chdir(home);
    const bridge = detectDaemonBridgeMode({ memoryDir: MEMORY_DIR, timeoutMs: 5_000 });
    assert.equal(bridge.mode, "delegate");
    assert.equal(bridge.daemonPort, stub.port, "the unit's env beat its config file");
  } finally {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await stub.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("resolveUnitEndpoint reads host and port, honoring account scope", () => {
  const unit = [
    "[Service]",
    "Environment=REMNIC_CONFIG_PATH=/etc/remnic/config.json",
    "Environment=REMNIC_HOST=127.0.0.5",
    "Environment=REMNIC_PORT=4804",
    "",
  ].join("\n");
  assert.deepEqual(resolveUnitEndpoint(unit, { userScoped: false, homeDir: "/home/gw" }), {
    configPath: "/etc/remnic/config.json",
    host: "127.0.0.5",
    port: 4804,
  });
  assert.equal(
    resolveUnitEndpoint("[Service]\nEnvironment=REMNIC_PORT=abc\n", {
      userScoped: true,
      homeDir: "/home/gw",
    }).port,
    undefined,
  );
  // A system unit's %h is unknowable, so nothing is taken from it.
  assert.deepEqual(
    resolveUnitEndpoint("[Service]\nEnvironment=REMNIC_CONFIG_PATH=%h/c.json\n", {
      userScoped: false,
      homeDir: "/home/gw",
    }),
    {},
  );
});

test("a unit's REMNIC_AUTH_TOKEN is used to probe and to delegate", async () => {
  const stub = await startHealthStub(
    { ok: true, memoryDir: MEMORY_DIR, searchBackend: "qmd" },
    200,
    0,
    false,
    "unit-token",
  );
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-unit-auth-"));
  await mkdir(path.join(home, ".config", "remnic"), { recursive: true });
  await mkdir(path.join(home, ".config", "systemd", "user"), { recursive: true });
  await writeFile(
    path.join(home, ".config", "systemd", "user", "remnic.service"),
    [
      "[Service]",
      "Environment=REMNIC_CONFIG_PATH=%h/.config/remnic/config.json",
      "Environment=REMNIC_AUTH_TOKEN=unit-token",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(home, ".config", "remnic", "config.json"),
    JSON.stringify({
      server: { host: "127.0.0.1", port: stub.port, authToken: "stale-token" },
    }),
    "utf8",
  );
  const priorHome = process.env.HOME;
  const priorCwd = process.cwd();
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
  try {
    process.env.HOME = home;
    process.chdir(home);
    const bridge = detectDaemonBridgeMode({ memoryDir: MEMORY_DIR, timeoutMs: 5_000 });
    assert.equal(bridge.mode, "delegate", "the unit's credential authenticated the probe");
    assert.equal(
      bridge.daemonAuthTokenOverride,
      "unit-token",
      "and rides along so delegate requests use the same one",
    );
  } finally {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await stub.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("resolveUnitEndpoint reads the auth override under the same account scope", () => {
  const unit = "[Service]\nEnvironment=REMNIC_AUTH_TOKEN=abc123\n";
  assert.equal(
    resolveUnitEndpoint(unit, { userScoped: true, homeDir: "/home/gw" }).authToken,
    "abc123",
  );
  assert.equal(
    resolveUnitEndpoint("[Service]\nEnvironment=ENGRAM_AUTH_TOKEN=legacy\n", {
      userScoped: true,
      homeDir: "/home/gw",
    }).authToken,
    "legacy",
    "the legacy spelling still resolves",
  );
});

test("resolveUnitEndpoint reads endpoint flags off the launch command line", () => {
  assert.deepEqual(
    resolveUnitEndpoint(
      "[Service]\nExecStart=/usr/bin/node /opt/remnic-server --host 127.0.0.7 --port=4810 --auth-token cli-token --config /etc/remnic/c.json\n",
      { userScoped: false, homeDir: "/home/gw" },
    ),
    { configPath: "/etc/remnic/c.json", host: "127.0.0.7", port: 4810, authToken: "cli-token" },
  );
  assert.deepEqual(
    resolveUnitEndpoint(
      [
        "<key>ProgramArguments</key>",
        "<array>",
        "  <string>/usr/bin/node</string>",
        "  <string>/opt/remnic-server</string>",
        "  <string>--port</string>",
        "  <string>4811</string>",
        "</array>",
      ].join("\n"),
      { userScoped: true, homeDir: "/home/gw" },
    ),
    { port: 4811 },
  );
  assert.equal(
    resolveUnitEndpoint(
      "[Service]\nEnvironment=REMNIC_PORT=4812\nExecStart=/opt/remnic-server --port 4813\n",
      { userScoped: true, homeDir: "/home/gw" },
    ).port,
    4813,
  );
  assert.equal(
    resolveUnitEndpoint("[Service]\nExecStart=/opt/remnic-server --host --port 4814\n", {
      userScoped: true,
      homeDir: "/home/gw",
    }).host,
    undefined,
  );
  // Quoted values unwrap; a system unit's %h is still refused.
  assert.equal(
    resolveUnitEndpoint('[Service]\nExecStart=/opt/remnic-server --host "127.0.0.8"\n', {
      userScoped: true,
      homeDir: "/home/gw",
    }).host,
    "127.0.0.8",
  );
  assert.equal(
    resolveUnitEndpoint("[Service]\nExecStart=/opt/remnic-server --config %h/c.json\n", {
      userScoped: false,
      homeDir: "/home/gw",
    }).configPath,
    undefined,
  );
});

test("auto dials the endpoint a unit passes on the command line", async () => {
  const stub = await startHealthStub({ ok: true, memoryDir: MEMORY_DIR, searchBackend: "qmd" });
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-unit-cli-"));
  await mkdir(path.join(home, ".config", "remnic"), { recursive: true });
  await mkdir(path.join(home, ".config", "systemd", "user"), { recursive: true });
  await writeFile(
    path.join(home, ".config", "systemd", "user", "remnic.service"),
    `[Service]\nExecStart=/usr/bin/node /opt/remnic-server --host 127.0.0.1 --port ${stub.port}\n`,
    "utf8",
  );
  await writeFile(
    path.join(home, ".config", "remnic", "config.json"),
    JSON.stringify({ server: { host: "127.0.0.1", port: 4815 } }),
    "utf8",
  );
  const priorHome = process.env.HOME;
  const priorCwd = process.cwd();
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
  try {
    process.env.HOME = home;
    process.chdir(home);
    const bridge = detectDaemonBridgeMode({ memoryDir: MEMORY_DIR, timeoutMs: 5_000 });
    assert.equal(bridge.mode, "delegate");
    assert.equal(bridge.daemonPort, stub.port);
  } finally {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await stub.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("resolveUnitEndpoint reads every assignment on a grouped Environment line", () => {
  // systemd allows several assignments per directive, quoted or bare. A
  // whole-line match recognized neither, so the daemon got both overrides
  // while auto probed the config default.
  assert.deepEqual(
    resolveUnitEndpoint(
      '[Service]\nEnvironment="REMNIC_HOST=127.0.0.4" "REMNIC_PORT=4820"\n',
      { userScoped: true, homeDir: "/home/gw" },
    ),
    { host: "127.0.0.4", port: 4820 },
  );
  assert.deepEqual(
    resolveUnitEndpoint(
      "[Service]\nEnvironment=REMNIC_HOST=127.0.0.5 REMNIC_PORT=4821\nEnvironment=REMNIC_PORT=4822\n",
      { userScoped: true, homeDir: "/home/gw" },
    ),
    { host: "127.0.0.5", port: 4822 },
  );
  assert.equal(
    resolveUnitEndpoint('[Service]\nEnvironment="REMNIC_PORT=4823"\n', {
      userScoped: true,
      homeDir: "/home/gw",
    }).port,
    4823,
  );
});

test("resolveUnitEndpoint resolves a relative --config against WorkingDirectory", () => {
  assert.equal(
    resolveUnitEndpoint(
      "[Service]\nWorkingDirectory=/srv/remnic\nExecStart=/opt/remnic-server --config remnic.config.json\n",
      { userScoped: true, homeDir: "/home/gw" },
    ).configPath,
    "/srv/remnic/remnic.config.json",
  );
  assert.equal(
    resolveUnitEndpoint(
      [
        "<key>WorkingDirectory</key>",
        "<string>/srv/remnic</string>",
        "<key>ProgramArguments</key>",
        "<array><string>/opt/remnic-server</string><string>--config</string><string>c.json</string></array>",
      ].join("\n"),
      { userScoped: true, homeDir: "/home/gw" },
    ).configPath,
    "/srv/remnic/c.json",
  );
  assert.equal(
    resolveUnitEndpoint("[Service]\nExecStart=/opt/remnic-server --config c.json\n", {
      userScoped: true,
      homeDir: "/home/gw",
    }).configPath,
    undefined,
  );
  assert.equal(
    resolveUnitEndpoint(
      "[Service]\nWorkingDirectory=/srv/remnic\nExecStart=/opt/remnic-server --config /etc/remnic/c.json\n",
      { userScoped: true, homeDir: "/home/gw" },
    ).configPath,
    "/etc/remnic/c.json",
  );
});

test("a repeated CLI flag takes the LAST value, like the daemon's parser", () => {
  assert.equal(
    resolveUnitEndpoint("[Service]\nExecStart=/opt/remnic-server --port 4318 --port 4813\n", {
      userScoped: true,
      homeDir: "/home/gw",
    }).port,
    4813,
  );
  assert.equal(
    resolveUnitEndpoint(
      "[Service]\nExecStart=/opt/remnic-server --host 127.0.0.2 --host=127.0.0.3\n",
      { userScoped: true, homeDir: "/home/gw" },
    ).host,
    "127.0.0.3",
  );
});

test("one stalling candidate cannot consume the whole preflight budget", async () => {
  const dead = await startHealthStub({}, 200, 0, true);
  const live = await startHealthStub({ ok: true, memoryDir: MEMORY_DIR, searchBackend: "qmd" });
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-budget-share-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "remnic-budget-share-cwd-"));
  await mkdir(path.join(home, ".config", "remnic"), { recursive: true });
  await mkdir(path.join(home, ".config", "systemd", "user"), { recursive: true });
  await writeFile(
    path.join(home, ".config", "systemd", "user", "remnic.service"),
    `[Service]\nExecStart=/opt/remnic-server --host 127.0.0.1 --port ${dead.port}\n`,
    "utf8",
  );
  await writeFile(
    path.join(cwd, "remnic.config.json"),
    JSON.stringify({ server: { host: "127.0.0.1", port: live.port } }),
    "utf8",
  );
  const priorHome = process.env.HOME;
  const priorCwd = process.cwd();
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
  try {
    process.env.HOME = home;
    process.chdir(cwd);
    const bridge = detectDaemonBridgeMode({ memoryDir: MEMORY_DIR, timeoutMs: 4_000 });
    assert.equal(bridge.mode, "delegate", "the live daemon behind the staller was still dialed");
    assert.equal(bridge.daemonPort, live.port);
  } finally {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await dead.close();
    await live.close();
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("explicit delegate binds its credential to the config it took the endpoint from", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-explicit-auth-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "remnic-explicit-auth-cwd-"));
  await mkdir(path.join(home, ".config", "remnic"), { recursive: true });
  await writeFile(
    path.join(cwd, "remnic.config.json"),
    JSON.stringify({ server: { host: "127.0.0.1", port: 4830, authToken: "cwd-token" } }),
    "utf8",
  );
  await writeFile(
    path.join(home, ".config", "remnic", "config.json"),
    JSON.stringify({ server: { host: "127.0.0.1", port: 4831, authToken: "home-token" } }),
    "utf8",
  );
  const priorHome = process.env.HOME;
  const priorCwd = process.cwd();
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
  try {
    process.env.HOME = home;
    process.chdir(cwd);
    process.env.REMNIC_BRIDGE_MODE = "delegate";
    const bridge = resolveBridgeMode("", { memoryDir: MEMORY_DIR });
    assert.equal(bridge.daemonPort, 4830, "the cwd config supplied the endpoint");
    assert.equal(
      bridge.daemonConfigPath,
      path.join(cwd, "remnic.config.json"),
      "so its token is the one delegate requests will use",
    );
    assert.equal(loadDaemonAuth(bridge.daemonConfigPath).token, "cwd-token");
  } finally {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a blank primary assignment shadows its legacy spelling", () => {
  assert.equal(
    resolveUnitEndpoint("[Service]\nEnvironment=REMNIC_PORT=\nEnvironment=ENGRAM_PORT=4840\n", {
      userScoped: true,
      homeDir: "/home/gw",
    }).port,
    undefined,
  );
  assert.equal(
    resolveUnitEndpoint("[Service]\nEnvironment=ENGRAM_PORT=4840\n", {
      userScoped: true,
      homeDir: "/home/gw",
    }).port,
    4840,
  );
});

test("a skipped remote candidate does not shrink the live daemon's probe budget", async () => {
  const warming = await startHealthStub(
    { ok: true, memoryDir: MEMORY_DIR, searchBackend: "qmd" },
    200,
    16,
  );
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-skip-divisor-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "remnic-skip-divisor-cwd-"));
  await mkdir(path.join(home, ".config", "systemd", "user"), { recursive: true });
  await writeFile(
    path.join(home, ".config", "systemd", "user", "remnic.service"),
    "[Service]\nExecStart=/opt/remnic-server --host 10.0.0.9 --port 4841\n",
    "utf8",
  );
  await writeFile(
    path.join(cwd, "remnic.config.json"),
    JSON.stringify({ server: { host: "127.0.0.1", port: warming.port } }),
    "utf8",
  );
  const priorHome = process.env.HOME;
  const priorCwd = process.cwd();
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
  try {
    process.env.HOME = home;
    process.chdir(cwd);
    const bridge = detectDaemonBridgeMode({ memoryDir: MEMORY_DIR, timeoutMs: 20_000 });
    assert.equal(bridge.mode, "delegate", "the warming daemon was waited out");
    assert.equal(bridge.daemonPort, warming.port);
  } finally {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await warming.close();
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a rejected gateway token falls back to the endpoint's own config token", async () => {
  const stub = await startHealthStub(
    { ok: true, memoryDir: MEMORY_DIR, searchBackend: "qmd" },
    200,
    0,
    false,
    "config-token",
  );
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-token-fallback-"));
  await mkdir(path.join(home, ".config", "remnic"), { recursive: true });
  await mkdir(path.join(home, ".remnic"), { recursive: true });
  await writeFile(
    path.join(home, ".remnic", "tokens.json"),
    JSON.stringify({ tokens: [{ connector: "openclaw", token: "remnic_gateway_token" }] }),
    "utf8",
  );
  await writeFile(
    path.join(home, ".config", "remnic", "config.json"),
    JSON.stringify({
      server: { host: "127.0.0.1", port: stub.port, authToken: "config-token" },
    }),
    "utf8",
  );
  const priorHome = process.env.HOME;
  const priorCwd = process.cwd();
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
  try {
    process.env.HOME = home;
    process.chdir(home);
    const bridge = detectDaemonBridgeMode({ memoryDir: MEMORY_DIR, timeoutMs: 6_000 });
    assert.equal(bridge.mode, "delegate", "the bound config credential was retried");
    assert.equal(bridge.daemonAuthPrefersConfig, true);
    assert.equal(bridge.daemonAuthTokenOverride, undefined, "the value is not baked in");
    assert.equal(
      readDaemonConfigAuthToken(path.join(home, ".config", "remnic", "config.json")),
      "config-token",
    );
    await writeFile(
      path.join(home, ".config", "remnic", "config.json"),
      JSON.stringify({
        server: { host: "127.0.0.1", port: stub.port, authToken: "rotated-token" },
      }),
      "utf8",
    );
    assert.equal(
      readDaemonConfigAuthToken(path.join(home, ".config", "remnic", "config.json")),
      "rotated-token",
    );
  } finally {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await stub.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a relative REMNIC_CONFIG_PATH resolves against WorkingDirectory too", () => {
  assert.equal(
    resolveUnitEndpoint(
      "[Service]\nWorkingDirectory=/srv/remnic\nEnvironment=REMNIC_CONFIG_PATH=remnic.config.json\n",
      { userScoped: true, homeDir: "/home/gw" },
    ).configPath,
    "/srv/remnic/remnic.config.json",
  );
  assert.equal(
    resolveUnitEndpoint("[Service]\nEnvironment=REMNIC_CONFIG_PATH=c.json\n", {
      userScoped: true,
      homeDir: "/home/gw",
    }).configPath,
    undefined,
  );
  assert.equal(
    resolveUnitEndpoint(
      "[Service]\nWorkingDirectory=%h/srv\nEnvironment=REMNIC_CONFIG_PATH=c.json\n",
      { userScoped: false, homeDir: "/home/gw" },
    ).configPath,
    undefined,
  );
  assert.equal(
    resolveUnitEndpoint(
      "[Service]\nWorkingDirectory=/srv/remnic\nEnvironment=REMNIC_CONFIG_PATH=/etc/remnic/c.json\n",
      { userScoped: true, homeDir: "/home/gw" },
    ).configPath,
    "/etc/remnic/c.json",
  );
});

test("detectBridgeMode stays exported and maps onto current resolution", async () => {
  // Imported from the PACKAGE ROOT: the finding is that consumers importing
  // `detectBridgeMode` from @remnic/plugin-openclaw must keep resolving.
  const pkg = (await import("./index.js")) as {
    detectBridgeMode?: (options?: { memoryDir?: string }) => { mode: string };
  };
  assert.equal(
    typeof pkg.detectBridgeMode,
    "function",
    "the deprecated export must remain on the package surface",
  );
  const detectBridgeMode = pkg.detectBridgeMode;
  assert.ok(detectBridgeMode);
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
  try {
    assert.equal(detectBridgeMode().mode, "embedded");
    process.env.REMNIC_BRIDGE_MODE = "delegate";
    assert.equal(detectBridgeMode().mode, "delegate");
    process.env.REMNIC_BRIDGE_MODE = "auto";
    assert.equal(detectBridgeMode().mode, "embedded");
  } finally {
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
});

test("a credential retry shares its candidate's slice, not a second one", async () => {
  const stallerA = await startHealthStub({}, 200, 0, true);
  const stallerB = await startHealthStub({}, 200, 0, true);
  const live = await startHealthStub({ ok: true, memoryDir: MEMORY_DIR, searchBackend: "qmd" });
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-retry-budget-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "remnic-retry-budget-cwd-"));
  await mkdir(path.join(home, ".config", "remnic"), { recursive: true });
  await mkdir(path.join(home, ".config", "engram"), { recursive: true });
  await mkdir(path.join(home, ".config", "systemd", "user"), { recursive: true });
  await mkdir(path.join(home, ".remnic"), { recursive: true });
  await writeFile(
    path.join(home, ".remnic", "tokens.json"),
    JSON.stringify({ tokens: [{ connector: "openclaw", token: "remnic_gateway_token" }] }),
    "utf8",
  );
  await writeFile(
    path.join(home, ".config", "systemd", "user", "remnic.service"),
    "[Service]\nEnvironment=REMNIC_CONFIG_PATH=%h/.config/remnic/config.json\n",
    "utf8",
  );
  await writeFile(
    path.join(home, ".config", "systemd", "user", "engram.service"),
    "[Service]\nEnvironment=REMNIC_CONFIG_PATH=%h/.config/engram/config.json\n",
    "utf8",
  );
  await writeFile(
    path.join(home, ".config", "remnic", "config.json"),
    JSON.stringify({
      server: { host: "127.0.0.1", port: stallerA.port, authToken: "staller-a-token" },
    }),
    "utf8",
  );
  await writeFile(
    path.join(home, ".config", "engram", "config.json"),
    JSON.stringify({
      server: { host: "127.0.0.1", port: stallerB.port, authToken: "staller-b-token" },
    }),
    "utf8",
  );
  await writeFile(
    path.join(cwd, "remnic.config.json"),
    JSON.stringify({ server: { host: "127.0.0.1", port: live.port } }),
    "utf8",
  );
  const priorHome = process.env.HOME;
  const priorCwd = process.cwd();
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
  try {
    process.env.HOME = home;
    process.chdir(cwd);
    const bridge = detectDaemonBridgeMode({ memoryDir: MEMORY_DIR, timeoutMs: 9_000 });
    assert.equal(bridge.mode, "delegate", "the live daemon was still reached");
    assert.equal(bridge.daemonPort, live.port);
  } finally {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await stallerA.close();
    await stallerB.close();
    await live.close();
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("two configs on one endpoint with different tokens both survive dedupe", async () => {
  const stub = await startHealthStub(
    { ok: true, memoryDir: MEMORY_DIR, searchBackend: "qmd" },
    200,
    0,
    false,
    "second-config-token",
  );
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-dupe-fallback-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "remnic-dupe-fallback-cwd-"));
  await mkdir(path.join(home, ".config", "remnic"), { recursive: true });
  await mkdir(path.join(home, ".config", "systemd", "user"), { recursive: true });
  await mkdir(path.join(home, ".remnic"), { recursive: true });
  await writeFile(
    path.join(home, ".remnic", "tokens.json"),
    JSON.stringify({ tokens: [{ connector: "openclaw", token: "remnic_gateway_token" }] }),
    "utf8",
  );
  await writeFile(
    path.join(home, ".config", "systemd", "user", "remnic.service"),
    "[Service]\nEnvironment=REMNIC_CONFIG_PATH=%h/.config/remnic/config.json\n",
    "utf8",
  );
  const endpoint = { host: "127.0.0.1", port: stub.port };
  await writeFile(
    path.join(home, ".config", "remnic", "config.json"),
    JSON.stringify({ server: { ...endpoint, authToken: "first-config-token" } }),
    "utf8",
  );
  await writeFile(
    path.join(cwd, "remnic.config.json"),
    JSON.stringify({ server: { ...endpoint, authToken: "second-config-token" } }),
    "utf8",
  );
  const priorHome = process.env.HOME;
  const priorCwd = process.cwd();
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
  try {
    process.env.HOME = home;
    process.chdir(cwd);
    const bridge = detectDaemonBridgeMode({ memoryDir: MEMORY_DIR, timeoutMs: 6_000 });
    assert.equal(bridge.mode, "delegate", "the second config's candidate survived dedupe");
    assert.equal(bridge.daemonConfigPath, path.join(cwd, "remnic.config.json"));
    assert.equal(bridge.daemonAuthPrefersConfig, true);
  } finally {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await stub.close();
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("auto reads systemd drop-ins, not just the base unit", async () => {
  const stub = await startHealthStub({ ok: true, memoryDir: MEMORY_DIR, searchBackend: "qmd" });
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-dropin-"));
  const unitDir = path.join(home, ".config", "systemd", "user");
  await mkdir(path.join(unitDir, "remnic.service.d"), { recursive: true });
  await writeFile(
    path.join(unitDir, "remnic.service"),
    "[Service]\nEnvironment=REMNIC_HOST=127.0.0.1\nEnvironment=REMNIC_PORT=4860\n",
    "utf8",
  );
  // A LATER drop-in (lexical order) supplies the live one.
  await writeFile(
    path.join(unitDir, "remnic.service.d", "10-first.conf"),
    "[Service]\nEnvironment=REMNIC_PORT=4861\n",
    "utf8",
  );
  await writeFile(
    path.join(unitDir, "remnic.service.d", "20-override.conf"),
    `[Service]\nEnvironment=REMNIC_PORT=${stub.port}\n`,
    "utf8",
  );
  const priorHome = process.env.HOME;
  const priorCwd = process.cwd();
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
  try {
    process.env.HOME = home;
    process.chdir(home);
    const bridge = detectDaemonBridgeMode({ memoryDir: MEMORY_DIR, timeoutMs: 5_000 });
    assert.equal(bridge.mode, "delegate");
    assert.equal(bridge.daemonPort, stub.port, "the last drop-in wins, as systemd applies them");
  } finally {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await stub.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a system unit's tilde is account-relative, like %h", () => {
  // The daemon expands `~` in ITS account. Expanding it against the gateway's
  // home would read a different user's config than the daemon did.
  assert.equal(
    resolveUnitEndpoint("[Service]\nExecStart=/opt/remnic-server --config ~/c.json\n", {
      userScoped: false,
      homeDir: "/home/gw",
    }).configPath,
    undefined,
  );
  assert.equal(
    resolveUnitEndpoint("[Service]\nEnvironment=REMNIC_CONFIG_PATH=~/c.json\n", {
      userScoped: false,
      homeDir: "/home/gw",
    }).configPath,
    undefined,
  );
  // A USER unit runs in our account, so `~` is ours.
  assert.equal(
    resolveUnitEndpoint("[Service]\nEnvironment=REMNIC_CONFIG_PATH=~/c.json\n", {
      userScoped: true,
      homeDir: "/home/gw",
    }).configPath,
    "/home/gw/c.json",
  );
});

test("launchd plist values are XML-decoded before use", () => {
  // launchd hands the daemon the DECODED value, so reading the encoded text
  // would compare a different path or credential than the one in use.
  assert.deepEqual(
    resolveUnitEndpoint(
      [
        "<key>EnvironmentVariables</key>",
        "<dict>",
        "<key>REMNIC_CONFIG_PATH</key>",
        "<string>/srv/a&amp;b/config.json</string>",
        "<key>REMNIC_AUTH_TOKEN</key>",
        "<string>tok&amp;en&lt;1&gt;</string>",
        "</dict>",
      ].join("\n"),
      { userScoped: true, homeDir: "/home/gw" },
    ),
    { configPath: "/srv/a&b/config.json", authToken: "tok&en<1>" },
  );
  // ProgramArguments are decoded too.
  assert.equal(
    resolveUnitEndpoint(
      [
        "<key>ProgramArguments</key>",
        "<array>",
        "<string>/opt/remnic-server</string>",
        "<string>--config</string>",
        "<string>/srv/x&amp;y/c.json</string>",
        "</array>",
      ].join("\n"),
      { userScoped: true, homeDir: "/home/gw" },
    ).configPath,
    "/srv/x&y/c.json",
  );
});

test("an armed fallback credential does not cut a warming daemon's probe short", async () => {
  const warming = await startHealthStub(
    { ok: true, memoryDir: MEMORY_DIR, searchBackend: "qmd" },
    200,
    8,
    false,
    "unit-token",
  );
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-warm-fallback-"));
  await mkdir(path.join(home, ".config", "remnic"), { recursive: true });
  await mkdir(path.join(home, ".config", "systemd", "user"), { recursive: true });
  await writeFile(
    path.join(home, ".config", "systemd", "user", "remnic.service"),
    [
      "[Service]",
      "Environment=REMNIC_CONFIG_PATH=%h/.config/remnic/config.json",
      "Environment=REMNIC_AUTH_TOKEN=unit-token",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(home, ".config", "remnic", "config.json"),
    JSON.stringify({
      server: { host: "127.0.0.1", port: warming.port, authToken: "stale-config-token" },
    }),
    "utf8",
  );
  const priorHome = process.env.HOME;
  const priorCwd = process.cwd();
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
  try {
    process.env.HOME = home;
    process.chdir(home);
    const skips: string[] = [];
    const bridge = detectDaemonBridgeMode({
      memoryDir: MEMORY_DIR,
      timeoutMs: 9_000,
      onSkip: (reason) => skips.push(reason),
    });
    assert.equal(bridge.mode, "delegate", `skips=${skips.join(" | ")}`);
    assert.equal(bridge.daemonAuthTokenOverride, "unit-token");
  } finally {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await warming.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a drop-in ExecStart reset replaces the base unit's command", () => {
  // `systemctl edit` writes `ExecStart=` followed by the replacement, and the
  // drop-in is appended after the base. Reading only the first `ExecStart=`
  // returns the endpoint the administrator overrode.
  assert.equal(
    resolveUnitEndpoint(
      [
        "[Service]",
        "ExecStart=/opt/remnic-server --port 4318 --config /base/c.json",
        "[Service]",
        "ExecStart=",
        "ExecStart=/opt/remnic-server --port 4813 --config /override/c.json",
      ].join("\n"),
      { userScoped: false, homeDir: "/home/gw" },
    ).port,
    4813,
  );
  assert.equal(
    resolveUnitEndpoint(
      [
        "[Service]",
        "ExecStart=/opt/remnic-server --config /base/c.json",
        "[Service]",
        "ExecStart=",
        "ExecStart=/opt/remnic-server --config /override/c.json",
      ].join("\n"),
      { userScoped: false, homeDir: "/home/gw" },
    ).configPath,
    "/override/c.json",
  );
});

test("a drop-in WorkingDirectory and Environment reset supersede the base", () => {
  // A later `WorkingDirectory=` wins and a bare `Environment=` clears the
  // whole block, exactly as systemd applies them.
  assert.equal(
    resolveUnitEndpoint(
      [
        "[Service]",
        "WorkingDirectory=/srv/base",
        "ExecStart=/opt/remnic-server --config ./c.json",
        "[Service]",
        "WorkingDirectory=/srv/override",
      ].join("\n"),
      { userScoped: false, homeDir: "/home/gw" },
    ).configPath,
    "/srv/override/c.json",
  );
  assert.deepEqual(
    resolveUnitEndpoint(
      [
        "[Service]",
        "Environment=REMNIC_HOST=127.0.0.1",
        "Environment=REMNIC_PORT=4318",
        "[Service]",
        "Environment=",
        "Environment=REMNIC_PORT=4813",
      ].join("\n"),
      { userScoped: false, homeDir: "/home/gw" },
    ),
    { port: 4813 },
    "the reset dropped the host, and the replacement port applies",
  );
});

test("a vendor unit picks up the administrator's /etc drop-in", async () => {
  // The packaged unit ships under `/usr/lib` and `systemctl edit` writes the
  // override under `/etc/.../<unit>.d`. Deriving the drop-in directory from
  // the base unit's own location would search `/usr/lib/.../<unit>.d` and
  // probe the vendor endpoint the administrator replaced.
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-loadpath-"));
  const vendor = path.join(root, "usr", "lib", "systemd", "system");
  const admin = path.join(root, "etc", "systemd", "system");
  const local = path.join(root, "usr", "local", "lib", "systemd", "system");
  const dirs = [vendor, local, path.join(root, "run", "systemd", "system"), admin];
  try {
    await mkdir(path.join(admin, "remnic.service.d"), { recursive: true });
    await mkdir(vendor, { recursive: true });
    await writeFile(path.join(vendor, "remnic.service"), "[Service]\n", "utf8");
    await writeFile(
      path.join(admin, "remnic.service.d", "override.conf"),
      "[Service]\nEnvironment=REMNIC_PORT=4813\n",
      "utf8",
    );

    const sources = resolveSystemUnitSources(dirs, ["remnic.service", "engram.service"]);
    assert.equal(sources.length, 1, "only the installed unit is a source");
    assert.equal(sources[0]?.unitPath, path.join(vendor, "remnic.service"));
    assert.deepEqual(
      sources[0]?.dropInDirs,
      dirs.map((dir) => path.join(dir, "remnic.service.d")),
      "every load path is searched for drop-ins, not just the base unit's own",
    );

    // A locally built daemon installs under `/usr/local/lib`, which outranks
    // the vendor copy — skipping that directory hid the running service.
    await mkdir(local, { recursive: true });
    await writeFile(path.join(local, "remnic.service"), "[Service]\n", "utf8");
    assert.equal(
      resolveSystemUnitSources(dirs, ["remnic.service"])[0]?.unitPath,
      path.join(local, "remnic.service"),
    );

    // `/etc` masks everything below it when BOTH carry the unit.
    await writeFile(path.join(admin, "remnic.service"), "[Service]\n", "utf8");
    assert.equal(
      resolveSystemUnitSources(dirs, ["remnic.service"])[0]?.unitPath,
      path.join(admin, "remnic.service"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a health body that dies after the headers fails fast, not at the deadline", async () => {
  const stub = await startHealthStub(
    { ok: true, memoryDir: MEMORY_DIR },
    200,
    0,
    false,
    undefined,
    true,
  );
  try {
    const budgetMs = 4_000;
    const started = Date.now();
    const health = readDaemonMemoryDirSync("127.0.0.1", stub.port, budgetMs);
    const elapsed = Date.now() - started;
    assert.deepEqual(health, { healthy: false, memoryDir: undefined, failure: "network" });
    assert.ok(
      elapsed < budgetMs / 2,
      `probe returned in ${elapsed}ms, well inside its ${budgetMs}ms budget`,
    );
  } finally {
    await stub.close();
  }
});

test("an invalid probe budget is rejected, never silently skipped", async () => {
  const stub = await startHealthStub({ ok: true, memoryDir: MEMORY_DIR });
  try {
    withDaemonEnv(stub.port, () => {
      for (const timeoutMs of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, 120_001]) {
        assert.throws(
          () => detectDaemonBridgeMode({ memoryDir: MEMORY_DIR, timeoutMs }),
          /timeoutMs must be an integer in \[1, 120000\]/,
          `detect: ${String(timeoutMs)}`,
        );
        for (const mode of ["auto", "delegate", "embedded"]) {
          assert.throws(
            () => resolveBridgeMode(mode, { memoryDir: MEMORY_DIR, timeoutMs }),
            /timeoutMs must be an integer/,
            `${mode}: ${String(timeoutMs)}`,
          );
        }
      }
      assert.equal(detectDaemonBridgeMode({ memoryDir: MEMORY_DIR }).mode, "delegate");
    });
  } finally {
    await stub.close();
  }
});

test("EnvironmentFile assignments reach the endpoint, overriding inline ones", () => {
  const files = new Map([
    ["/etc/remnic/env", "# comment\nREMNIC_AUTH_TOKEN=\"file-token\"\nREMNIC_PORT=4813\n"],
    ["/etc/remnic/late.env", "REMNIC_PORT=4900\n"],
    ["/home/gw/env", "REMNIC_AUTH_TOKEN=another-accounts-token\n"],
  ]);
  const read = (candidate: string): string | undefined => files.get(candidate);
  const scope = { userScoped: false, homeDir: "/home/gw" };

  // systemd.exec: file settings override `Environment=`, whatever the order.
  assert.deepEqual(
    resolveUnitEndpoint(
      [
        "[Service]",
        "EnvironmentFile=/etc/remnic/env",
        "Environment=REMNIC_HOST=127.0.0.1",
        "Environment=REMNIC_AUTH_TOKEN=inline-token",
      ].join("\n"),
      scope,
      read,
    ),
    { host: "127.0.0.1", port: 4813, authToken: "file-token" },
  );

  // A later file overrides an earlier one, and `-` marks one optional.
  assert.equal(
    resolveUnitEndpoint(
      ["[Service]", "EnvironmentFile=/etc/remnic/env", "EnvironmentFile=-/etc/remnic/late.env"].join(
        "\n",
      ),
      scope,
      read,
    ).port,
    4900,
  );

  // A missing file contributes nothing rather than throwing.
  assert.deepEqual(
    resolveUnitEndpoint("[Service]\nEnvironmentFile=/etc/remnic/absent.env\n", scope, read),
    {},
  );

  // An empty assignment resets the file LIST, like every other list setting.
  assert.deepEqual(
    resolveUnitEndpoint(
      ["[Service]", "EnvironmentFile=/etc/remnic/env", "EnvironmentFile=", ""].join("\n"),
      scope,
      read,
    ),
    {},
  );

  // Account-relative paths are refused for a system unit, same as everywhere.
  assert.deepEqual(
    resolveUnitEndpoint("[Service]\nEnvironmentFile=%h/env\n", scope, read),
    {},
  );
});

test("a wrapped directive is folded before parsing, as systemd folds it", () => {
  // systemd.syntax: a trailing backslash continues the directive and the
  // backslash-newline becomes a space. Parsing physical lines drops the
  // wrapped flags — values the daemon receives but detection would not see.
  assert.deepEqual(
    resolveUnitEndpoint(
      [
        "[Service]",
        "ExecStart=/opt/remnic-server \\",
        "  --host 127.0.0.1 \\",
        "  --port 4813 \\",
        "  --auth-token wrapped-token",
      ].join("\n"),
      { userScoped: false, homeDir: "/home/gw" },
    ),
    { host: "127.0.0.1", port: 4813, authToken: "wrapped-token" },
  );
  assert.deepEqual(
    resolveUnitEndpoint(
      ["[Service]", 'Environment="REMNIC_HOST=127.0.0.1" \\', '  "REMNIC_PORT=4900"'].join("\n"),
      { userScoped: false, homeDir: "/home/gw" },
    ),
    { host: "127.0.0.1", port: 4900 },
  );
  // An EVEN run of trailing backslashes is an escaped backslash, not a
  // continuation, so the next line stays its own directive.
  assert.equal(
    resolveUnitEndpoint(
      ["[Service]", "Environment=REMNIC_HOST=127.0.0.1\\\\", "Environment=REMNIC_PORT=4813"].join(
        "\n",
      ),
      { userScoped: false, homeDir: "/home/gw" },
    ).port,
    4813,
  );
});

test("the system unit search path is the one systemd documents", () => {
  // systemd.unit(5) "System Unit Search Path", ascending precedence. A
  // missing directory means a daemon installed there is invisible to auto,
  // which then starts an embedded orchestrator on its corpus. `/usr/local` is
  // where a locally built daemon lands.
  assert.deepEqual(
    [...SYSTEMD_SYSTEM_UNIT_DIRS],
    [
      "/usr/lib/systemd/system",
      "/lib/systemd/system",
      "/usr/local/lib/systemd/system",
      "/run/systemd/system",
      "/etc/systemd/system",
    ],
  );
});

test("a unit credential is re-read after a rotation, like a config one", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-unit-rotate-"));
  const unitDir = path.join(home, ".config", "systemd", "user");
  await mkdir(unitDir, { recursive: true });
  const unitPath = path.join(unitDir, "remnic.service");
  const writeToken = async (token: string): Promise<void> => {
    await writeFile(
      unitPath,
      ["[Service]", "Environment=REMNIC_HOST=127.0.0.1", `Environment=REMNIC_AUTH_TOKEN=${token}`, ""].join(
        "\n",
      ),
      "utf8",
    );
  };
  await writeToken("first-token");
  const source = { unitPath, dropInDirs: [`${unitPath}.d`], userScoped: true };
  const priorHome = process.env.HOME;
  try {
    process.env.HOME = home;
    assert.deepEqual(readUnitAuthToken(source), { readable: true, token: "first-token" });
    await writeToken("rotated-token");
    assert.deepEqual(
      readUnitAuthToken(source),
      { readable: true, token: "rotated-token" },
      "the rotation is picked up",
    );

    await mkdir(`${unitPath}.d`, { recursive: true });
    await writeFile(
      path.join(`${unitPath}.d`, "override.conf"),
      "[Service]\nEnvironment=REMNIC_AUTH_TOKEN=dropin-token\n",
      "utf8",
    );
    assert.deepEqual(readUnitAuthToken(source), { readable: true, token: "dropin-token" });

    await rm(`${unitPath}.d`, { recursive: true, force: true });
    await writeFile(unitPath, "[Service]\nEnvironment=REMNIC_HOST=127.0.0.1\n", "utf8");
    assert.deepEqual(readUnitAuthToken(source), { readable: true, token: undefined });

    await rm(unitPath, { force: true });
    assert.deepEqual(readUnitAuthToken(source), { readable: false });
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("UnsetEnvironment removes an assignment from every tier", () => {
  // systemd.exec applies `UnsetEnvironment=` as the FINAL environment step, so
  // a drop-in that removes an endpoint or credential leaves the daemon on its
  // config's value. Keeping the stale assignment probes the wrong endpoint.
  const files = new Map([["/etc/remnic/env", "REMNIC_AUTH_TOKEN=file-token\n"]]);
  const read = (candidate: string): string | undefined => files.get(candidate);
  const scope = { userScoped: false, homeDir: "/home/gw" };

  assert.deepEqual(
    resolveUnitEndpoint(
      [
        "[Service]",
        "Environment=REMNIC_HOST=127.0.0.1",
        "Environment=REMNIC_PORT=4318",
        "EnvironmentFile=/etc/remnic/env",
        "[Service]",
        "UnsetEnvironment=REMNIC_PORT REMNIC_AUTH_TOKEN",
      ].join("\n"),
      scope,
      read,
    ),
    { host: "127.0.0.1" },
    "the removals win over BOTH the inline assignment and the file",
  );

  // The `NAME=value` spelling removes only that exact assignment.
  assert.equal(
    resolveUnitEndpoint(
      ["[Service]", "Environment=REMNIC_PORT=4318", "UnsetEnvironment=REMNIC_PORT=4813"].join("\n"),
      scope,
      read,
    ).port,
    4318,
  );
  // An empty assignment resets the removal list.
  assert.equal(
    resolveUnitEndpoint(
      [
        "[Service]",
        "Environment=REMNIC_PORT=4318",
        "UnsetEnvironment=REMNIC_PORT",
        "UnsetEnvironment=",
      ].join("\n"),
      scope,
      read,
    ).port,
    4318,
  );
});

test("an EnvironmentFile wildcard loads the files systemd would", () => {
  // systemd.exec permits an absolute filename OR a wildcard expression.
  // Passing the literal pattern to a file read loads nothing, so the endpoint
  // and credential the daemon actually has go unseen.
  const files = new Map([
    ["/etc/remnic/10-base.env", "REMNIC_HOST=127.0.0.1\nREMNIC_PORT=4318\n"],
    ["/etc/remnic/20-override.env", "REMNIC_PORT=4813\n"],
    ["/etc/remnic/notes.txt", "REMNIC_PORT=9999\n"],
  ]);
  const read = (candidate: string): string | undefined => files.get(candidate);
  const listDir = (directory: string): string[] =>
    [...files.keys()]
      .filter((file) => file.startsWith(`${directory}/`))
      .map((file) => file.slice(directory.length + 1));

  assert.deepEqual(
    resolveUnitEndpoint(
      "[Service]\nEnvironmentFile=/etc/remnic/*.env\n",
      { userScoped: false, homeDir: "/home/gw" },
      read,
      listDir,
    ),
    { host: "127.0.0.1", port: 4813 },
    "matches apply in sorted order, and a non-matching file is left out",
  );
});

test("a removed unit token falls through instead of replaying a dead credential", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-token-removed-"));
  const unitDir = path.join(home, ".config", "systemd", "user");
  await mkdir(unitDir, { recursive: true });
  const unitPath = path.join(unitDir, "remnic.service");
  const source = { unitPath, dropInDirs: [`${unitPath}.d`], userScoped: true };
  const bridge = {
    mode: "delegate" as const,
    daemonHost: "127.0.0.1",
    daemonPort: 4318,
    daemonAuthTokenOverride: "unit-token",
    daemonAuthUnit: source,
  };
  const priorHome = process.env.HOME;
  const priorToken = process.env.REMNIC_AUTH_TOKEN;
  try {
    process.env.HOME = home;
    process.env.REMNIC_AUTH_TOKEN = "store-token";
    await writeFile(
      unitPath,
      "[Service]\nEnvironment=REMNIC_AUTH_TOKEN=unit-token\n",
      "utf8",
    );
    assert.equal(daemonTargetFor(bridge).resolveAuthToken().token, "unit-token");

    await writeFile(unitPath, "[Service]\nEnvironment=REMNIC_HOST=127.0.0.1\n", "utf8");
    assert.equal(daemonTargetFor(bridge).resolveAuthToken().token, "store-token");

    await rm(unitPath, { force: true });
    assert.equal(daemonTargetFor(bridge).resolveAuthToken().token, "unit-token");
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorToken === undefined) delete process.env.REMNIC_AUTH_TOKEN;
    else process.env.REMNIC_AUTH_TOKEN = priorToken;
    await rm(home, { recursive: true, force: true });
  }
});
test("a rejected legacy environment token falls back to the daemon config", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-token-rotation-"));
  const configPath = path.join(home, ".config", "remnic", "config.json");
  const authNames = [
    "OPENCLAW_REMNIC_ACCESS_TOKEN",
    "REMNIC_AUTH_TOKEN",
    "OPENCLAW_ENGRAM_ACCESS_TOKEN",
    "ENGRAM_AUTH_TOKEN",
  ] as const;
  const previous = new Map(authNames.map((name) => [name, process.env[name]]));
  try {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ server: { authToken: "rotated-config-token" } }),
      "utf8",
    );
    for (const name of authNames) delete process.env[name];
    process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN = "stale-exported-token";
    const target = daemonTargetFor({
      mode: "delegate",
      daemonHost: "127.0.0.1",
      daemonAuthPrefersConfig: false,
      daemonPort: 4318,
      daemonConfigPath: configPath,
    });
    const stale = target.resolveAuthToken();
    assert.deepEqual(stale, {
      token: "stale-exported-token",
      source: "OPENCLAW_ENGRAM_ACCESS_TOKEN",
    });
    target.invalidateAuthToken?.(stale);
    assert.deepEqual(target.resolveAuthToken(), {
      token: "rotated-config-token",
      source: "daemon configuration",
    });
  } finally {
    for (const name of authNames) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("resolvable unit specifiers expand, unknowable ones still refuse", () => {
  // `EnvironmentFile=` permits specifier expansion. The DIRECTORY specifiers
  // are account-independent for a system unit, so they resolve there too —
  // only `%h` and `~` name the account `User=` selects, which is unknowable.
  const files = new Map([
    ["/etc/remnic.env", "REMNIC_PORT=4813\n"],
    ["/var/lib/remnic.env", "REMNIC_HOST=127.0.0.1\n"],
  ]);
  const read = (candidate: string): string | undefined => files.get(candidate);
  const system = { userScoped: false, homeDir: "/home/gw" };

  assert.equal(
    resolveUnitEndpoint("[Service]\nEnvironmentFile=%E/remnic.env\n", system, read).port,
    4813,
    "%E is /etc for a system unit",
  );
  assert.equal(
    resolveUnitEndpoint("[Service]\nEnvironmentFile=%S/remnic.env\n", system, read).host,
    "127.0.0.1",
    "%S is /var/lib for a system unit",
  );
  // `%h` stays unknowable, and `%%` is an escaped percent, not a specifier.
  assert.deepEqual(
    resolveUnitEndpoint("[Service]\nEnvironment=REMNIC_CONFIG_PATH=%h/c.json\n", system, read),
    {},
  );
  assert.equal(
    resolveUnitEndpoint(
      "[Service]\nEnvironment=REMNIC_AUTH_TOKEN=100%%sure\n",
      system,
      read,
    ).authToken,
    "100%sure",
  );
});

test("a user unit installed system-wide is discovered", async () => {
  // `systemd-analyze unit-paths --user` lists `/usr/lib/systemd/user` and
  // friends: systemd runs a unit installed there exactly like a per-user one,
  // so omitting those directories hid the daemon's endpoint entirely.
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-userpath-"));
  const vendor = path.join(root, "usr", "lib", "systemd", "user");
  const perUser = path.join(root, ".config", "systemd", "user");
  const dirs = [vendor, path.join(root, "etc", "systemd", "user"), perUser];
  try {
    await mkdir(vendor, { recursive: true });
    await writeFile(path.join(vendor, "remnic.service"), "[Service]\n", "utf8");
    assert.equal(
      resolveSystemUnitSources(dirs, ["remnic.service"])[0]?.unitPath,
      path.join(vendor, "remnic.service"),
      "a system-wide user unit is a source",
    );
    // The per-user directory still outranks it.
    await mkdir(perUser, { recursive: true });
    await writeFile(path.join(perUser, "remnic.service"), "[Service]\n", "utf8");
    assert.equal(
      resolveSystemUnitSources(dirs, ["remnic.service"])[0]?.unitPath,
      path.join(perUser, "remnic.service"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the public detector rejects a blank corpus and a hostile probe budget", () => {
  for (const memoryDir of ["", "   "]) {
    assert.throws(
      () => detectDaemonBridgeMode({ memoryDir, timeoutMs: 1_000 }),
      /requires a non-empty memoryDir/,
      JSON.stringify(memoryDir),
    );
  }
  for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    assert.throws(
      () => readDaemonMemoryDirSync("127.0.0.1", 4318, timeoutMs),
      /timeoutMs must be an integer/,
      `capture: ${String(timeoutMs)}`,
    );
    assert.throws(
      () => checkDaemonHealthSync("127.0.0.1", 4318, timeoutMs),
      /timeoutMs must be an integer/,
      `liveness: ${String(timeoutMs)}`,
    );
  }
});

test("the delegate config is the one the daemon itself would select", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-config-bind-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "remnic-config-cwd-"));
  const priorHome = process.env.HOME;
  const priorCwd = process.cwd();
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
    process.env.HOME = home;
    process.chdir(cwd);
    await writeFile(path.join(cwd, "remnic.config.json"), JSON.stringify({ remnic: {} }), "utf8");
    await mkdir(path.join(home, ".config", "remnic"), { recursive: true });
    await writeFile(
      path.join(home, ".config", "remnic", "config.json"),
      JSON.stringify({ server: { host: "127.0.0.1", port: 4899, authToken: "home-token" } }),
      "utf8",
    );
    const bridge = resolveBridgeMode("delegate", { timeoutMs: 1_000 });
    assert.equal(bridge.daemonPort, 4318, "the cwd config wins and defaults its port");
    assert.match(
      String(bridge.daemonConfigPath),
      /remnic\.config\.json$/,
      "and the credential binds to that same file, not the later one",
    );
  } finally {
    process.chdir(priorCwd);
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ExecStart substitutes the unit's own environment variables", () => {
  // systemd's Command Lines contract distinguishes the two syntaxes: `${VAR}`
  // expands to exactly ONE argument, while a bare `$VAR` is split on
  // whitespace into separate arguments.
  const scope = { userScoped: false, homeDir: "/home/gw" };
  assert.deepEqual(
    resolveUnitEndpoint(
      [
        "[Service]",
        // Braced, and the value carries WHITESPACE: it must stay one argument
        // or the credential is truncated to its first word.
        'Environment=PORT=4813 "TOKEN=alpha beta"',
        "ExecStart=/opt/remnic-server --port ${PORT} --auth-token ${TOKEN}",
      ].join("\n"),
      scope,
    ),
    { port: 4813, authToken: "alpha beta" },
  );
  // Bare, and the value carries SEVERAL arguments: it must split, or neither
  // flag is discovered.
  assert.deepEqual(
    resolveUnitEndpoint(
      [
        "[Service]",
        'Environment="ARGS=--port 4813 --auth-token secret"',
        "ExecStart=/opt/remnic-server $ARGS",
      ].join("\n"),
      scope,
    ),
    { port: 4813, authToken: "secret" },
  );
  assert.deepEqual(
    resolveUnitEndpoint("[Service]\nExecStart=/opt/remnic-server --port ${MISSING}\n", scope),
    {},
  );
});

test("%t names the account's own runtime directory", () => {
  // systemd expands `%t` to `/run/user/<uid>` for a user manager, not the
  // shared parent — a `%t`-based path read from the wrong place finds nothing.
  const uid = process.getuid?.();
  if (uid === undefined) return;
  const files = new Map([[`/run/user/${uid}/remnic.env`, "REMNIC_PORT=4813\n"]]);
  assert.equal(
    resolveUnitEndpoint(
      "[Service]\nEnvironmentFile=%t/remnic.env\n",
      { userScoped: true, homeDir: "/home/gw" },
      (candidate) => files.get(candidate),
    ).port,
    4813,
  );
});

test("an /etc user unit outranks one in the data directory", async () => {
  // systemd's user search path puts `$XDG_DATA_HOME/systemd/user` BELOW
  // `/run` and `/etc`: an administrator override wins over whatever a package
  // dropped in the data directory.
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-user-prec-"));
  const data = path.join(root, "data", "systemd", "user");
  const etc = path.join(root, "etc", "systemd", "user");
  const config = path.join(root, "config", "systemd", "user");
  const dirs = [path.join(root, "usr", "lib", "systemd", "user"), data, etc, config];
  try {
    for (const dir of [data, etc]) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "remnic.service"), "[Service]\n", "utf8");
    }
    assert.equal(
      resolveSystemUnitSources(dirs, ["remnic.service"])[0]?.unitPath,
      path.join(etc, "remnic.service"),
      "/etc outranks the data directory",
    );
    // The user's own config directory still outranks /etc.
    await mkdir(config, { recursive: true });
    await writeFile(path.join(config, "remnic.service"), "[Service]\n", "utf8");
    assert.equal(
      resolveSystemUnitSources(dirs, ["remnic.service"])[0]?.unitPath,
      path.join(config, "remnic.service"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an exhausted budget skips a candidate instead of throwing", async () => {
  const stub = await startHealthStub({ ok: true, memoryDir: MEMORY_DIR });
  const reasons: string[] = [];
  try {
    const resolved = withDaemonEnv(stub.port, () =>
      resolveBridgeMode("auto", {
        memoryDir: MEMORY_DIR,
        timeoutMs: 1,
        onSkip: (reason) => reasons.push(reason),
      }),
    );
    assert.equal(resolved.mode, "embedded", "a spent budget stays embedded, it does not throw");
    assert.match(reasons.join("\n"), /budget of 1ms is spent|no healthy daemon/);
  } finally {
    await stub.close();
  }
});

test("the user unit search path is ordered the way systemd orders it", () => {
  // Ascending precedence, per systemd.unit's user search path. The data
  // directory sits BELOW `/run` and `/etc` — an administrator override wins
  // over whatever a package dropped in `~/.local/share`.
  const priorEnv = new Map(
    ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CONFIG_DIRS"].map((key) => [key, process.env[key]]),
  );
  try {
    for (const key of priorEnv.keys()) Reflect.deleteProperty(process.env, key);
    assert.deepEqual(systemdUserUnitDirs("/home/gw"), [
      "/usr/share/systemd/user",
      "/usr/lib/systemd/user",
      "/usr/local/share/systemd/user",
      "/usr/local/lib/systemd/user",
      "/home/gw/.local/share/systemd/user",
      "/run/systemd/user",
      "/etc/systemd/user",
      "/etc/xdg/systemd/user",
      "/home/gw/.config/systemd/user",
    ]);
    process.env.XDG_DATA_HOME = "/xdg/data";
    process.env.XDG_CONFIG_HOME = "/xdg/config";
    const overridden = systemdUserUnitDirs("/home/gw");
    assert.deepEqual(overridden.slice(4, 6), [
      "/home/gw/.local/share/systemd/user",
      "/xdg/data/systemd/user",
    ]);
    assert.deepEqual(overridden.slice(-2), [
      "/home/gw/.config/systemd/user",
      "/xdg/config/systemd/user",
    ]);
    process.env.XDG_CONFIG_HOME = "/home/gw/.config";
    assert.deepEqual(
      systemdUserUnitDirs("/home/gw").filter((dir) => dir.endsWith(".config/systemd/user")),
      ["/home/gw/.config/systemd/user"],
    );
    // `XDG_CONFIG_DIRS` is read highest-first, so it is reversed into this
    // ascending list: the FIRST entry of the colon list outranks the second.
    process.env.XDG_CONFIG_DIRS = "/first/xdg:/second/xdg";
    assert.deepEqual(systemdUserUnitDirs("/home/gw").slice(-3, -1), [
      "/second/xdg/systemd/user",
      "/first/xdg/systemd/user",
    ]);
  } finally {
    for (const [key, value] of priorEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
});

test("an environment file's wrapped value is joined, not truncated", () => {
  // systemd drops the backslash-newline pair and hands the daemon one value.
  // Reading physical lines kept the first fragment WITH its trailing `\` and
  // discarded the rest of a long path or credential.
  const files = new Map([
    ["/etc/remnic/env", "REMNIC_AUTH_TOKEN=first-half\\\nsecond-half\nREMNIC_PORT=4813\n"],
  ]);
  assert.deepEqual(
    resolveUnitEndpoint(
      "[Service]\nEnvironmentFile=/etc/remnic/env\n",
      { userScoped: false, homeDir: "/home/gw" },
      (candidate) => files.get(candidate),
    ),
    // Joined with NO separator: the environment-file grammar removes the
    // backslash-newline pair without replacement.
    { port: 4813, authToken: "first-halfsecond-half" },
  );
});

test("a unit's WorkingDirectory config is discovered like the server does", () => {
  const files = new Map([["/srv/remnic/remnic.config.json", "{}"]]);
  const read = (candidate: string): string | undefined => files.get(candidate);
  assert.equal(
    resolveUnitConfigPath(
      "[Service]\nWorkingDirectory=/srv/remnic\nExecStart=/opt/remnic-server\n",
      { userScoped: false, homeDir: "/home/gw" },
      read,
    ),
    "/srv/remnic/remnic.config.json",
  );
  assert.equal(
    resolveUnitConfigPath(
      "[Service]\nWorkingDirectory=/srv/empty\nExecStart=/opt/remnic-server\n",
      { userScoped: false, homeDir: "/home/gw" },
      read,
    ),
    undefined,
  );
});

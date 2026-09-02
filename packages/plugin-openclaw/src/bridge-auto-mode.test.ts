/**
 * `bridgeMode: "auto"` — same-host daemon detection (issue #2120).
 *
 * These tests drive the REAL worker-backed sync probe against a local stub, so
 * they cover the whole path `resolveBridgeMode("auto")` takes at gateway
 * registration: env/config precedence, liveness, and the corpus-identity gate.
 */

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

// The sync probe blocks the calling thread on Atomics.wait, so a stub on the
// main event loop could never accept its connection. The stub therefore runs
// on its own worker thread, whose loop keeps turning while we block.
const STUB_SOURCE = `
import http from "node:http";
import { parentPort, workerData } from "node:worker_threads";
let served = 0;
const server = http.createServer((req, res) => {
  // \`hang\`: accept the connection and never answer, so the probe must burn its
  // whole timeout - the only way to observe a shared preflight deadline.
  if (workerData.hang) return;
  // \`requireToken\`: answer 401 for anything else, the way a daemon rejects a
  // stale credential.
  if (workerData.requireToken) {
    const auth = req.headers.authorization;
    if (auth !== \`Bearer \${workerData.requireToken}\`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
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
  res.writeHead(warming ? 503 : workerData.status, { "content-type": "application/json" });
  res.end(warming ? JSON.stringify({ ok: false, ready: false }) : workerData.body);
});
server.listen(0, "127.0.0.1", () => {
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

// A REAL directory: the corpus gate canonicalizes both sides, so a path that
// does not exist can never match (fail closed on symlink escapes).
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
  // Port 1 is reserved and never listening on a normal host.
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

test("auto refuses a non-loopback daemon endpoint", async () => {
  const stub = await startHealthStub({ ok: true, memoryDir: MEMORY_DIR });
  const reasons: string[] = [];
  try {
    const prior = process.env.REMNIC_HOST;
    withDaemonEnv(stub.port, () => {
      // A matching absolute memoryDir proves nothing across machines, and the
      // capability's local corpus reads only hold on one host.
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

    // A corpus root that is ITSELF a link is a mutable trust anchor.
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
      // The caller owns explicit overrides; the detector answers only
      // "is a healthy same-corpus daemon here?".
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
  // Health reports the namespace-RESOLVED storage dir, so a migrated default
  // namespace must not read as a foreign corpus.
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
    // `127.daemon.example` passes a naive prefix test but can resolve anywhere.
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
    // The stub binds 127.0.0.1 only, so these two actually connect.
    for (const host of ["127.0.0.1", "localhost"]) {
      const resolved = withDaemonEnv(stub.port, () => {
        process.env.REMNIC_HOST = host;
        return resolveBridgeMode("auto", { memoryDir: MEMORY_DIR, timeoutMs: 5_000 });
      });
      assert.equal(resolved.mode, "delegate", host);
    }
    // The rest must clear the loopback GATE — they then fail liveness because
    // nothing is listening there, which is a different (and correct) reason.
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
  // The sync capture buffer is bounded; a value that does not fit must read as
  // unknown, because a shortened path would look like a different corpus.
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
  // `server.host: "0.0.0.0"` is the documented daemon bind; classifying it as
  // remote would leave auto embedded beside a same-host daemon on one corpus.
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
  // Listening, but the readiness gate is closed for the first few probes -
  // exactly what OpenClaw sees when the gateway and the service start
  // together. Giving up here would boot a second orchestrator on its corpus.
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
  // The retry is bounded by the SAME preflight deadline: a permanently
  // unready daemon must not hold registration open past its budget.
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

test("host and port come from ONE config file, never spliced across two", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-split-config-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "remnic-split-cwd-"));
  await mkdir(path.join(home, ".config", "remnic"), { recursive: true });
  // The cwd file wins as a WHOLE, the way the standalone server selects it.
  // Splicing would produce 127.0.0.9:4999 - an endpoint in no file at all.
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
    // No REMNIC_HOST/PORT: the config files are the only endpoint source here.
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
  // The unit pins the daemon to the home config; the gateway happens to start
  // in a directory holding a different one. Trusting cwd would probe 4700 and
  // stay embedded beside a daemon listening on 4600.
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
    // This process's own REMNIC_CONFIG_PATH is a deliberate instruction and
    // still outranks the unit.
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
    // Every home-reference form the server and CLI accept must discover the
    // same file here: a literal `$HOME` used to pass through unexpanded and
    // hide the daemon's config from the bridge (issue #2796).
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
  // The daemon's own loader rejects this file, so it is not the one it booted
  // from; adopting its defaults would probe 4318 instead of the live 4700.
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
  // The unit is installed but inactive; the daemon was launched by hand from
  // the cwd config. Trusting the unit's endpoint alone would leave auto
  // embedded beside it and start a second orchestrator on its corpus.
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
  // Nothing listens here.
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
  // No env override and no config file anywhere: explicit `delegate` dials
  // 127.0.0.1:4318, so auto must too rather than probing nothing and staying
  // embedded beside a same-corpus daemon on defaults.
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
  // Three endpoints that ACCEPT and never answer: without a shared deadline
  // each burns the full timeout and synchronous registration stalls for a
  // multiple of the documented budget.
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
  // Raw string comparison would classify these as remote and leave auto
  // embedded beside a reachable same-host daemon.
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
  // Still literal-only: a routable v6 address and a loopback-shaped DNS name
  // must not pass.
  for (const spelling of ["2001:db8::1", "::ffff:10.0.0.1", "127.daemon.example"]) {
    assert.equal(isLoopbackDaemonHost(spelling), false, `${spelling} is not loopback`);
  }
});

test("an address assigned to one of this host's interfaces is dialed through loopback", () => {
  // An operator exports REMNIC_HOST as the machine's own NIC or VIP address.
  // That names the same daemon loopback reaches, and a gateway fetch to such
  // an address has been observed to hang, so it is classified as same-host
  // and dialed through loopback — like a wildcard bind.
  const local = Object.values(os.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .find((entry) => entry.family === "IPv4" && !entry.internal);
  if (local === undefined) return;
  assert.equal(loopbackForSameHost(local.address), "127.0.0.1", `${local.address} is this host`);
  assert.equal(isLoopbackDaemonHost(local.address), true);
  const resolved = withDaemonEnv(undefined, () => {
    process.env.REMNIC_HOST = local.address;
    return resolveBridgeMode("delegate");
  });
  assert.equal(resolved.daemonHost, "127.0.0.1", "explicit delegate dials loopback, not the NIC");
  // A routable address that is NOT on this host stays remote (RFC 5737 TEST-NET-1).
  assert.equal(loopbackForSameHost("192.0.2.1"), undefined);
  assert.equal(isLoopbackDaemonHost("192.0.2.1"), false);
});

test("each probed endpoint carries its own config's token", async () => {
  // Two configs with different server.authToken values. Resolving credentials
  // globally would send the FIRST config's token to the second daemon, which
  // 401s and leaves auto embedded beside it.
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
    // A bound config with no token means that daemon runs unauthenticated -
    // it must NOT fall through to another config's credential.
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
  // Canonical and legacy units coexist during migration. The canonical one is
  // inactive; the legacy one runs, and its config lives OUTSIDE the ordinary
  // cwd/home discovery list - so only reading both units can find it.
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
  // Nothing listens on the canonical unit's endpoint.
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
  // A stale service config and a manually launched daemon can share host:port
  // and differ only in server.authToken. Endpoint-only dedupe would send the
  // stale token, take a 401, and never retry with the live credential.
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
  // The unit config sorts FIRST and carries the stale credential.
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
  // The standalone server resolves cwd BEFORE home and never reads unit files.
  // Explicit delegate resolves ONE endpoint, so it must match that order or
  // the preflight checks the wrong daemon and falls back to embedded.
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
  // The server merges its own environment OVER its config file, and the
  // gateway does not inherit that environment - so the unit's values are the
  // only way auto can learn the real endpoint.
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
  // The file says a port nothing listens on; the unit's env is the truth.
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
  // A non-integer port is not an endpoint.
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
  // The server merges REMNIC_AUTH_TOKEN over server.authToken, and the gateway
  // does not inherit the service environment - so probing with the config's
  // stale credential 401s and auto falls back beside the live daemon.
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
  // The file carries the STALE credential the daemon no longer accepts.
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
  // systemd ExecStart, both `--flag value` and `--flag=value`.
  assert.deepEqual(
    resolveUnitEndpoint(
      "[Service]\nExecStart=/usr/bin/node /opt/remnic-server --host 127.0.0.7 --port=4810 --auth-token cli-token --config /etc/remnic/c.json\n",
      { userScoped: false, homeDir: "/home/gw" },
    ),
    { configPath: "/etc/remnic/c.json", host: "127.0.0.7", port: 4810, authToken: "cli-token" },
  );
  // launchd ProgramArguments.
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
  // A CLI flag outranks the unit's own environment, matching the server.
  assert.equal(
    resolveUnitEndpoint(
      "[Service]\nEnvironment=REMNIC_PORT=4812\nExecStart=/opt/remnic-server --port 4813\n",
      { userScoped: true, homeDir: "/home/gw" },
    ).port,
    4813,
  );
  // A flag given no value is not an endpoint.
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
  // The home config names a dead port; only the command line is right.
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
  // Bare (unquoted) grouping, and a later directive overriding an earlier one.
  assert.deepEqual(
    resolveUnitEndpoint(
      "[Service]\nEnvironment=REMNIC_HOST=127.0.0.5 REMNIC_PORT=4821\nEnvironment=REMNIC_PORT=4822\n",
      { userScoped: true, homeDir: "/home/gw" },
    ),
    { host: "127.0.0.5", port: 4822 },
  );
  // A single assignment still works, quoted or not.
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
  // launchd spells it the same way in its plist.
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
  // No working directory: a relative path names nothing this process can read.
  assert.equal(
    resolveUnitEndpoint("[Service]\nExecStart=/opt/remnic-server --config c.json\n", {
      userScoped: true,
      homeDir: "/home/gw",
    }).configPath,
    undefined,
  );
  // An absolute flag is unaffected by a working directory.
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
  // A stale unit endpoint that accepts and never answers sorts FIRST. Handing
  // it the entire deadline would leave the live daemon behind it undialed.
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
  // Without the binding, loadDaemonAuth rescans and can pair this endpoint
  // with a different file's token - a 401 the plugin reads as "no daemon".
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
  // The server reads `REMNIC_PORT=` as SET, so it overrides nothing but also
  // stops a stale ENGRAM_PORT from applying. Treating blank as absent would
  // make auto probe the legacy endpoint the daemon is not using.
  assert.equal(
    resolveUnitEndpoint("[Service]\nEnvironment=REMNIC_PORT=\nEnvironment=ENGRAM_PORT=4840\n", {
      userScoped: true,
      homeDir: "/home/gw",
    }).port,
    undefined,
  );
  // Absent primary still falls through to the legacy spelling.
  assert.equal(
    resolveUnitEndpoint("[Service]\nEnvironment=ENGRAM_PORT=4840\n", {
      userScoped: true,
      homeDir: "/home/gw",
    }).port,
    4840,
  );
});

test("a skipped remote candidate does not shrink the live daemon's probe budget", async () => {
  // A non-loopback unit endpoint costs no time, so it must not sit in the
  // divisor: a warming daemon behind it would otherwise get a fraction of the
  // budget and be misread as absent.
  // 16 x 250ms of readiness retries. The live candidate must be waited out,
  // which it only can be if the skipped remote endpoint stayed OUT of the
  // budget divisor — a share would not cover the retries. The budget is wide
  // enough that a loaded suite cannot turn a pass into a failure.
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
  // A system daemon under another account accepts only its config's static
  // token; the gateway's token store holds an unrelated one that 401s.
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
  // The gateway-global store outranks the config inside loadDaemonAuth.
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
    // Signalled, not frozen: delegate requests re-read the file so a rotated
    // token does not 401 every route until the gateway restarts.
    assert.equal(bridge.daemonAuthPrefersConfig, true);
    assert.equal(bridge.daemonAuthTokenOverride, undefined, "the value is not baked in");
    assert.equal(
      readDaemonConfigAuthToken(path.join(home, ".config", "remnic", "config.json")),
      "config-token",
    );
    // Rotate it on disk; the next read picks up the new value.
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
  // The daemon resolves the environment form against its cwd exactly as it
  // does `--config`; discarding it loses that config's endpoint AND token.
  assert.equal(
    resolveUnitEndpoint(
      "[Service]\nWorkingDirectory=/srv/remnic\nEnvironment=REMNIC_CONFIG_PATH=remnic.config.json\n",
      { userScoped: true, homeDir: "/home/gw" },
    ).configPath,
    "/srv/remnic/remnic.config.json",
  );
  // No working directory: the frame is unknowable, so it is dropped.
  assert.equal(
    resolveUnitEndpoint("[Service]\nEnvironment=REMNIC_CONFIG_PATH=c.json\n", {
      userScoped: true,
      homeDir: "/home/gw",
    }).configPath,
    undefined,
  );
  // A system unit's %h working directory is unknowable as well.
  assert.equal(
    resolveUnitEndpoint(
      "[Service]\nWorkingDirectory=%h/srv\nEnvironment=REMNIC_CONFIG_PATH=c.json\n",
      { userScoped: false, homeDir: "/home/gw" },
    ).configPath,
    undefined,
  );
  // Absolute is unaffected.
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
    // Default deployment: embedded, same as resolveBridgeMode("").
    assert.equal(detectBridgeMode().mode, "embedded");
    // An explicit env override is honored through the same resolver.
    process.env.REMNIC_BRIDGE_MODE = "delegate";
    assert.equal(detectBridgeMode().mode, "delegate");
    // `auto` without a corpus to verify against cannot probe, so it stays
    // embedded rather than guessing.
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
  // TWO stalling endpoints, each armed with a fallback credential, sort ahead
  // of the live daemon. One share each leaves room for it; two shares each
  // (probe + retry billed separately) exhausts the deadline first.
  const stallerA = await startHealthStub({}, 200, 0, true);
  const stallerB = await startHealthStub({}, 200, 0, true);
  const live = await startHealthStub({ ok: true, memoryDir: MEMORY_DIR, searchBackend: "qmd" });
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-retry-budget-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "remnic-retry-budget-cwd-"));
  await mkdir(path.join(home, ".config", "remnic"), { recursive: true });
  await mkdir(path.join(home, ".config", "engram"), { recursive: true });
  await mkdir(path.join(home, ".config", "systemd", "user"), { recursive: true });
  await mkdir(path.join(home, ".remnic"), { recursive: true });
  // A gateway-store token so each staller's config token differs from what
  // `loadDaemonAuth` resolves, arming the retry on both.
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
    // Two stalling candidates each burn one share; the live one must still be
    // reached inside its own. A wide budget keeps that true under load.
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
  // A gateway-store token wins for BOTH, so their primary tokens match and an
  // endpoint+token dedupe would drop the second - leaving the daemon's real
  // credential untried.
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
  // Unit config sorts first and names the WRONG credential.
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
  // `systemctl edit` puts overrides in <unit>.d/*.conf. Reading only the base
  // unit probes the stale endpoint the administrator overrode.
  const stub = await startHealthStub({ ok: true, memoryDir: MEMORY_DIR, searchBackend: "qmd" });
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-dropin-"));
  const unitDir = path.join(home, ".config", "systemd", "user");
  await mkdir(path.join(unitDir, "remnic.service.d"), { recursive: true });
  // Base unit names a port nothing listens on.
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
  // The daemon needs ~2s of readiness retries (8 x 250ms) and its unit token
  // is the ONLY valid credential. The candidate's slice is ~3s, so the full
  // slice waits it out while a half-slice reservation for a fallback retry
  // would stop the valid attempt early and then 401 with the config token.
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
  // A DIFFERENT config token, so a fallback retry is armed but would fail.
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
        // ---- drop-in ----
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
  // The capture probe reads the body, so completion is decided AFTER the
  // headers arrive. A probe that only watches for a PRE-header failure never
  // signals, and the caller blocks on `Atomics.wait` for its whole slice.
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
  // A library consumer reaches these exports directly, bypassing the config
  // parser. Zero or a negative would skip every probe and select embedded
  // beside a running same-corpus daemon — the exact failure auto prevents.
  const stub = await startHealthStub({ ok: true, memoryDir: MEMORY_DIR });
  try {
    withDaemonEnv(stub.port, () => {
      for (const timeoutMs of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, 120_001]) {
        assert.throws(
          () => detectDaemonBridgeMode({ memoryDir: MEMORY_DIR, timeoutMs }),
          /timeoutMs must be an integer in \[1, 120000\]/,
          `detect: ${String(timeoutMs)}`,
        );
        // Rejected for every mode, so flipping to `auto` cannot turn an
        // accepted value into an error later.
        for (const mode of ["auto", "delegate", "embedded"]) {
          assert.throws(
            () => resolveBridgeMode(mode, { memoryDir: MEMORY_DIR, timeoutMs }),
            /timeoutMs must be an integer/,
            `${mode}: ${String(timeoutMs)}`,
          );
        }
      }
      // An omitted budget still takes the documented default.
      assert.equal(detectDaemonBridgeMode({ memoryDir: MEMORY_DIR }).mode, "delegate");
    });
  } finally {
    await stub.close();
  }
});

test("EnvironmentFile assignments reach the endpoint, overriding inline ones", () => {
  // A daemon running under another account commonly keeps its credential in
  // an environment file. Reading only inline `Environment=` probes with the
  // wrong token, reads a failure, and starts an orchestrator beside it.
  const files = new Map([
    ["/etc/remnic/env", "# comment\nREMNIC_AUTH_TOKEN=\"file-token\"\nREMNIC_PORT=4813\n"],
    ["/etc/remnic/late.env", "REMNIC_PORT=4900\n"],
    // Readable HERE, so refusing it must come from the account-scope rule and
    // not merely from a missing file.
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
  // A wrapped `Environment=` carries its assignments too.
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
  // An administrator who rotates the token in the unit and restarts the
  // daemon would otherwise 401 every delegated route until the GATEWAY also
  // restarted, because the value detection succeeded with was frozen.
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

    // A drop-in rotation counts too, and outranks the base unit.
    await mkdir(`${unitPath}.d`, { recursive: true });
    await writeFile(
      path.join(`${unitPath}.d`, "override.conf"),
      "[Service]\nEnvironment=REMNIC_AUTH_TOKEN=dropin-token\n",
      "utf8",
    );
    assert.deepEqual(readUnitAuthToken(source), { readable: true, token: "dropin-token" });

    // A readable unit that no longer names a token is a DELIBERATE removal:
    // the daemon has fallen back to its config or token store, and the caller
    // must too rather than replaying a credential nobody serves.
    await rm(`${unitPath}.d`, { recursive: true, force: true });
    await writeFile(unitPath, "[Service]\nEnvironment=REMNIC_HOST=127.0.0.1\n", "utf8");
    assert.deepEqual(readUnitAuthToken(source), { readable: true, token: undefined });

    // An UNREADABLE unit proves nothing, so the caller keeps the last value
    // that actually authenticated instead of sending none.
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
        // ---- drop-in ----
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
  // An administrator who deletes `REMNIC_AUTH_TOKEN` from a still-readable
  // unit has moved the daemon onto its config or token store. Replaying the
  // credential the probe authenticated with would 401 every route until the
  // gateway restarted.
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

    // Token removed, unit still readable: fall through to normal resolution.
    await writeFile(unitPath, "[Service]\nEnvironment=REMNIC_HOST=127.0.0.1\n", "utf8");
    assert.equal(daemonTargetFor(bridge).resolveAuthToken().token, "store-token");

    // Unit unreadable: nothing is proven, so the last working value stands.
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
  // Both are required arguments a library consumer can get wrong. A blank
  // corpus can never match, so the walk would answer `embedded` — an invalid
  // argument dressed up as a mode decision. A non-finite budget survives to
  // `Atomics.wait` as an UNBOUNDED wait on the caller's main thread.
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
  // `remnic-server`'s `resolveConfigPath` takes the FIRST EXISTING candidate
  // and `parseServerConfig` defaults its missing fields to 127.0.0.1:4318. A
  // later file that declares an endpoint is not the daemon's config, so
  // preferring it would dial a server nobody is running — and bind the
  // credential to the wrong file.
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-config-bind-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "remnic-config-cwd-"));
  const priorHome = process.env.HOME;
  const priorCwd = process.cwd();
  const priorEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
    process.env.HOME = home;
    process.chdir(cwd);
    // cwd config: valid JSON, no `server` block at all.
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
  // An undefined variable stays literal, and is then discarded as a bad port
  // rather than being guessed at.
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
  // The public probe rejects a non-positive budget — correctly — so the walk
  // must notice an elapsed slice itself rather than turning a spent budget
  // into a thrown configuration error. `bridgeHealthTimeoutMs: 1` is the
  // supported minimum and crosses that line immediately.
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
    // An XDG override is scanned ALONGSIDE its default, not instead of it: the
    // variables come from the gateway's environment, and the daemon's user
    // manager may have been started with different ones — or none.
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
    // A variable that merely restates the default adds no duplicate entry.
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
  // With no `--config` and no `REMNIC_CONFIG_PATH`, the server auto-selects
  // `<cwd>/remnic.config.json`, and the unit sets that cwd. Reporting no
  // config path skipped the unit entirely, hiding its endpoint.
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
  // An explicit path still wins, and a cwd with no config reports none.
  assert.equal(
    resolveUnitConfigPath(
      "[Service]\nWorkingDirectory=/srv/empty\nExecStart=/opt/remnic-server\n",
      { userScoped: false, homeDir: "/home/gw" },
      read,
    ),
    undefined,
  );
});

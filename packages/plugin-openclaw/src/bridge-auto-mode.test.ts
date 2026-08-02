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
  loopbackForWildcardBind,
  readDaemonMemoryDirSync,
  resolveBridgeMode,
  resolveUnitConfigPath,
} from "./bridge.js";

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
  const stub = await startHealthStub({ error: "unauthorized" }, 401);
  try {
    assert.deepEqual(readDaemonMemoryDirSync("127.0.0.1", stub.port, 5_000), {
      healthy: false,
      memoryDir: undefined,
    });
  } finally {
    await stub.close();
  }
});

test("readDaemonMemoryDirSync rejects an unroutable port without probing", () => {
  assert.deepEqual(readDaemonMemoryDirSync("127.0.0.1", 0, 500), {
    healthy: false,
    memoryDir: undefined,
  });
  assert.deepEqual(readDaemonMemoryDirSync("", 4318, 500), {
    healthy: false,
    memoryDir: undefined,
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
  ]) {
    assert.equal(isLoopbackDaemonHost(spelling), true, `${spelling} is loopback`);
  }
  for (const spelling of ["::", "[::]", "0:0:0:0:0:0:0:0", "0.0.0.0"]) {
    assert.equal(isLoopbackDaemonHost(spelling), true, `${spelling} is a wildcard bind`);
    assert.ok(loopbackForWildcardBind(spelling) !== undefined, `${spelling} dials through loopback`);
  }
  // Still literal-only: a routable v6 address and a loopback-shaped DNS name
  // must not pass.
  for (const spelling of ["2001:db8::1", "::ffff:10.0.0.1", "127.daemon.example"]) {
    assert.equal(isLoopbackDaemonHost(spelling), false, `${spelling} is not loopback`);
  }
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

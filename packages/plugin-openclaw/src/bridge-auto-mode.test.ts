/**
 * `bridgeMode: "auto"` — same-host daemon detection (issue #2120).
 *
 * These tests drive the REAL worker-backed sync probe against a local stub, so
 * they cover the whole path `resolveBridgeMode("auto")` takes at gateway
 * registration: env/config precedence, liveness, and the corpus-identity gate.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { detectDaemonBridgeMode, readDaemonMemoryDirSync, resolveBridgeMode } from "./bridge.js";

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
const server = http.createServer((req, res) => {
  res.writeHead(workerData.status, { "content-type": "application/json" });
  res.end(workerData.body);
});
server.listen(0, "127.0.0.1", () => {
  parentPort.postMessage({ port: server.address().port });
});
parentPort.on("message", (message) => {
  if (message === "close") server.close(() => process.exit(0));
});
`;

async function startHealthStub(body: unknown, status = 200): Promise<HealthStub> {
  const worker = new Worker(
    new URL(`data:text/javascript,${encodeURIComponent(STUB_SOURCE)}`),
    {
      type: "module",
      workerData: { status, body: typeof body === "string" ? body : JSON.stringify(body) },
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

test("auto matches a symlinked spelling of one corpus", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "remnic-auto-link-")));
  const real = path.join(root, "real-memory");
  const link = path.join(root, "linked-memory");
  await mkdir(real, { recursive: true });
  await symlink(real, link);
  const stub = await startHealthStub({ ok: true, memoryDir: real });
  const reasons: string[] = [];
  try {
    const resolved = withDaemonEnv(stub.port, () =>
      resolveBridgeMode("auto", {
        memoryDir: link,
        timeoutMs: 5_000,
        onSkip: (reason) => reasons.push(reason),
      }),
    );
    assert.equal(
      resolved.mode,
      "delegate",
      "two spellings of one directory must not start a second orchestrator beside the daemon",
    );
    assert.deepEqual(reasons, []);
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

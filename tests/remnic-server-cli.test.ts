import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { cliMain, startServer } from "../packages/remnic-server/src/index.js";
import { runServerBin } from "../packages/remnic-server/bin/server-bin.js";

function restoreEnv(t: TestContext, keys: string[]): void {
  const snapshot = new Map(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of snapshot) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        if (!address || typeof address === "string") {
          reject(new Error("Failed to allocate a free TCP port"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

test("remnic-server CLI rejects documented value options without values", async () => {
  for (const option of ["--config", "--host", "--port", "--auth-token"]) {
    await assert.rejects(
      () => cliMain([option]),
      new RegExp(`Missing value for ${option}`),
      `${option} should require a following value`,
    );

    await assert.rejects(
      () => cliMain([option, "--help"]),
      new RegExp(`Missing value for ${option}`),
      `${option} should not consume the next option as its value`,
    );
  }
});

test("remnic-server CLI rejects empty inline values", async () => {
  await assert.rejects(
    () => cliMain(["--auth-token="]),
    /Missing value for --auth-token/,
  );
});

test("remnic-server CLI accepts inline values that look like options", async () => {
  await assert.rejects(
    () => cliMain(["--auth-token=--some-secret", "--port", "0"]),
    /Invalid --port: expected an integer port from 1 to 65535/,
  );
});

test("remnic-server CLI rejects invalid port values before startup", async () => {
  for (const port of ["0", "65536", "3.7", "abc"]) {
    await assert.rejects(
      () => cliMain(["--port", port]),
      /Invalid --port: expected an integer port from 1 to 65535/,
      `port ${port} should be rejected`,
    );
  }
});

test("remnic-server CLI rejects unknown long options", async () => {
  await assert.rejects(
    () => cliMain(["--auth-tokn", "secret"]),
    /Unknown option --auth-tokn/,
  );
});

test("remnic-server bin wrapper delegates help-mixed value flags to CLI validation", async () => {
  let stderr = "";
  let exitCode: number | undefined;
  let receivedArgv: string[] | undefined;

  await assert.rejects(
    () =>
      runServerBin("remnic-server", {
        argv: ["--auth-token", "--help"],
        loadCliMain: async () => ({
          cliMain: async (argv: string[]) => {
            receivedArgv = argv;
            throw new Error("Missing value for --auth-token");
          },
        }),
        stderr: (value: string) => {
          stderr += value;
        },
        exit: (code: number) => {
          exitCode = code;
          throw new Error(`exit ${code}`);
        },
      }),
    /exit 1/,
  );

  assert.deepEqual(receivedArgv, ["--auth-token", "--help"]);
  assert.equal(exitCode, 1);
  assert.match(stderr, /Missing value for --auth-token/);
});

test("startServer rejects invalid direct option ports before initializing", async (t) => {
  restoreEnv(t, ["REMNIC_PORT", "ENGRAM_PORT"]);
  delete process.env.REMNIC_PORT;
  delete process.env.ENGRAM_PORT;

  await assert.rejects(
    () =>
      startServer({
        port: 0,
      }),
    /Invalid options\.port: expected an integer port from 1 to 65535/,
  );
});

test("startServer lets direct option port override invalid environment ports", async (t) => {
  restoreEnv(t, [
    "REMNIC_PORT",
    "ENGRAM_PORT",
    "REMNIC_MEMORY_DIR",
    "ENGRAM_MEMORY_DIR",
    "REMNIC_AUTH_TOKEN",
    "ENGRAM_AUTH_TOKEN",
  ]);
  process.env.REMNIC_PORT = "abc";
  delete process.env.ENGRAM_PORT;
  delete process.env.ENGRAM_MEMORY_DIR;
  process.env.REMNIC_AUTH_TOKEN = "test-token";
  delete process.env.ENGRAM_AUTH_TOKEN;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-env-port-"));
  process.env.REMNIC_MEMORY_DIR = tempDir;
  const configPath = path.join(tempDir, "remnic.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      remnic: { memoryDir: tempDir, qmdEnabled: false, qmdDaemonEnabled: false, searchBackend: "noop" },
    }),
    "utf8",
  );
  const port = await getFreePort();
  const result = await startServer({
    configPath,
    port,
  });

  try {
    assert.equal(result.port, port);
  } finally {
    result.cancelStartupSync();
    result.abortDeferredInit();
    await result.httpServer.stop();
  }
});

test("startServer rejects invalid environment ports before initializing", async (t) => {
  restoreEnv(t, ["REMNIC_PORT", "ENGRAM_PORT"]);
  process.env.REMNIC_PORT = "abc";
  delete process.env.ENGRAM_PORT;

  await assert.rejects(
    () => startServer(),
    /Invalid REMNIC_PORT\/ENGRAM_PORT: expected an integer port from 1 to 65535/,
  );
});

test("startServer expands tilde in explicit config paths", async (t) => {
  restoreEnv(t, [
    "HOME",
    "REMNIC_CONFIG_PATH",
    "ENGRAM_CONFIG_PATH",
    "REMNIC_PORT",
    "ENGRAM_PORT",
    "REMNIC_MEMORY_DIR",
    "ENGRAM_MEMORY_DIR",
    "REMNIC_AUTH_TOKEN",
    "ENGRAM_AUTH_TOKEN",
  ]);

  const tempHome = await mkdtemp(path.join(os.tmpdir(), "remnic-server-home-"));
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-memory-"));
  const configDir = path.join(tempHome, ".config", "remnic");
  const configPath = path.join(configDir, "config.json");
  const port = await getFreePort();

  process.env.HOME = tempHome;
  delete process.env.REMNIC_CONFIG_PATH;
  delete process.env.ENGRAM_CONFIG_PATH;
  delete process.env.REMNIC_PORT;
  delete process.env.ENGRAM_PORT;
  delete process.env.REMNIC_MEMORY_DIR;
  delete process.env.ENGRAM_MEMORY_DIR;
  delete process.env.REMNIC_AUTH_TOKEN;
  delete process.env.ENGRAM_AUTH_TOKEN;

  await mkdir(configDir, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      remnic: { memoryDir, qmdEnabled: false, qmdDaemonEnabled: false, searchBackend: "noop" },
      server: { port, authToken: "test-token" },
    }),
    "utf8",
  );

  const result = await startServer({ configPath: "~/.config/remnic/config.json" });

  try {
    assert.equal(result.port, port);
    assert.equal(result.config.memoryDir, memoryDir);
  } finally {
    result.cancelStartupSync();
    result.abortDeferredInit();
    await result.httpServer.stop();
  }
});

test("startServer rejects missing explicit config paths", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-missing-config-"));

  await assert.rejects(
    () => startServer({ configPath: path.join(tempDir, "missing-config.json") }),
    /Config file from --config not found:/,
  );
});

test("startServer rejects missing explicit env config paths", async (t) => {
  restoreEnv(t, ["REMNIC_CONFIG_PATH", "ENGRAM_CONFIG_PATH"]);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-missing-env-config-"));
  process.env.REMNIC_CONFIG_PATH = path.join(tempDir, "missing-config.json");
  delete process.env.ENGRAM_CONFIG_PATH;

  await assert.rejects(
    () => startServer(),
    /Config file from REMNIC_CONFIG_PATH\/ENGRAM_CONFIG_PATH not found:/,
  );
});

test("startServer skips non-file auto-discovered config candidates", async (t) => {
  restoreEnv(t, [
    "REMNIC_CONFIG_PATH",
    "ENGRAM_CONFIG_PATH",
    "REMNIC_PORT",
    "ENGRAM_PORT",
    "REMNIC_MEMORY_DIR",
    "ENGRAM_MEMORY_DIR",
    "REMNIC_AUTH_TOKEN",
    "ENGRAM_AUTH_TOKEN",
  ]);

  const previousCwd = process.cwd();
  t.after(() => {
    process.chdir(previousCwd);
  });

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-autodiscovery-"));
  const memoryDir = path.join(tempDir, "memory");
  const port = await getFreePort();

  delete process.env.REMNIC_CONFIG_PATH;
  delete process.env.ENGRAM_CONFIG_PATH;
  delete process.env.REMNIC_PORT;
  delete process.env.ENGRAM_PORT;
  delete process.env.REMNIC_MEMORY_DIR;
  delete process.env.ENGRAM_MEMORY_DIR;
  delete process.env.REMNIC_AUTH_TOKEN;
  delete process.env.ENGRAM_AUTH_TOKEN;

  await mkdir(path.join(tempDir, "remnic.config.json"), { recursive: true });
  await writeFile(
    path.join(tempDir, "engram.config.json"),
    JSON.stringify({
      remnic: { memoryDir, qmdEnabled: false, qmdDaemonEnabled: false, searchBackend: "noop" },
      server: { port, authToken: "test-token" },
    }),
    "utf8",
  );

  process.chdir(tempDir);
  const result = await startServer();

  try {
    assert.equal(result.port, port);
    assert.equal(result.config.memoryDir, memoryDir);
  } finally {
    result.cancelStartupSync();
    result.abortDeferredInit();
    await result.httpServer.stop();
  }
});

test("startServer rejects invalid config file ports before initializing", async (t) => {
  restoreEnv(t, ["REMNIC_PORT", "ENGRAM_PORT"]);
  delete process.env.REMNIC_PORT;
  delete process.env.ENGRAM_PORT;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-config-port-"));
  const configPath = path.join(tempDir, "remnic.config.json");
  await writeFile(configPath, JSON.stringify({ server: { port: "abc" } }), "utf8");

  await assert.rejects(
    () => startServer({ configPath }),
    /Invalid server\.port: expected an integer port from 1 to 65535/,
  );
});
